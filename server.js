import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_VERSION = (() => {
	try {
		const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));
		return pkg?.version || 'unknown';
	} catch {
		return 'unknown';
	}
})();
const APP_BOOT_ID = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const APP_DISPLAY_VERSION = `${APP_VERSION}-dev.${APP_BOOT_ID}`;
const OTT_DEBUG = String(process.env.OTT_DEBUG || 'true').toLowerCase() === 'true';

function debugLog(message, extra = null) {
	if (!OTT_DEBUG) return;
	if (extra == null) {
		console.log(`-=-= [server] ${message}`);
		return;
	}
	console.log(`-=-= [server] ${message}`, extra);
}

(function loadDotEnv() {
	try {
		const lines = readFileSync(join(__dirname, '.env'), 'utf8').split('\n');
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const eqIdx = trimmed.indexOf('=');
			if (eqIdx < 1) continue;
			const key = trimmed.slice(0, eqIdx).trim();
			const value = trimmed.slice(eqIdx + 1).trim();
			if (!(key in process.env)) {
				process.env[key] = value;
			}
		}
	} catch {
		// .env file missing or unreadable — continue with existing env
	}
})();

import express from 'express';
import cors from 'cors';
import { runSupervisorTurn } from './lib/supervisor-orchestrator.js';
import {
	readMonologue,
	readSessionStatuses,
	readSessionChat,
	readTurnState,
} from './lib/persistence.js';

const app = express();
const port = process.env.PORT || 3001;

// CORS middleware - allow localhost:8080 only
app.use(cors({
  origin: 'http://localhost:8080',
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

// JSON body parser middleware
app.use(express.json());

// In-memory Set of active session IDs for concurrent turn protection
const activeSessions = new Set();

/**
 * Validate that a value is safe to use as a path segment (e.g., sessionId, personaId).
 * Rejects values containing path separators or directory traversal sequences to prevent
 * path traversal attacks where user input flows into path.join() calls.
 *
 * @param {string} value - The value to validate
 * @returns {boolean} True if safe to use in file paths
 */
export function isValidPathSegment(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('..');
}

// Health-check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/version', (req, res) => {
	res.setHeader('Cache-Control', 'no-store');
	res.json({
		version: APP_VERSION,
		displayVersion: APP_DISPLAY_VERSION,
		bootId: APP_BOOT_ID,
	});
});

// POST /api/turn — run a full turn (round) of persona responses via SSE
app.post('/api/turn', async (req, res) => {
	const { sessionId, session, messages, notes, attachedFiles, model, personas } = req.body || {};
	const requestStartedMs = Date.now();

	if (!sessionId || typeof sessionId !== 'string' || sessionId.trim() === '') {
		return res.status(400).json({ error: 'sessionId is required' });
	}
	if (!isValidPathSegment(sessionId)) {
		return res.status(400).json({ error: 'sessionId contains invalid characters' });
	}
	if (!messages || !Array.isArray(messages)) {
		return res.status(400).json({ error: 'messages must be an array' });
	}
	if (activeSessions.has(sessionId)) {
		debugLog(`reject concurrent turn sessionId=${sessionId}`);
		return res.status(409).json({ error: 'Turn already in progress' });
	}

	activeSessions.add(sessionId);
	debugLog(`accepted turn sessionId=${sessionId} personas=${Array.isArray(personas) ? personas.length : 0}`);
	const payload = {
		sessionId,
		session: session || {},
		messages: [...messages],
		notes: notes || '',
		attachedFiles: attachedFiles || [],
		model: model || 'haiku',
		personas: personas || [],
	};

	(async () => {
		try {
			await runSupervisorTurn(payload);
			debugLog(`background turn done sessionId=${sessionId}`);
		} catch (err) {
			console.error(`[server] supervisor turn failed for ${sessionId}: ${err.message}`);
		} finally {
			activeSessions.delete(sessionId);
			debugLog(`session released sessionId=${sessionId}`);
		}
	})();

	debugLog(`responding accepted sessionId=${sessionId} latencyMs=${Date.now() - requestStartedMs}`);
	return res.status(202).json({
		status: 'accepted',
		sessionId,
	});
});

// GET /api/monologue/:sessionId/:personaId — fetch a persona's monologue entries
app.get('/api/monologue/:sessionId/:personaId', async (req, res) => {
  const { sessionId, personaId } = req.params;

  // Validate path segments to prevent path traversal
  if (!isValidPathSegment(sessionId) || !isValidPathSegment(personaId)) {
    return res.status(400).json({ error: 'Invalid sessionId or personaId' });
  }

  try {
    const entries = await readMonologue(sessionId, personaId);
    res.json(entries);
  } catch (err) {
    console.error(`[server] GET /api/monologue error for ${sessionId}/${personaId}: ${err.message}`);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// GET /api/status/:sessionId — fetch all persona status files for session
app.get('/api/status/:sessionId', async (req, res) => {
  const { sessionId } = req.params;

  if (!isValidPathSegment(sessionId)) {
    return res.status(400).json({ error: 'Invalid sessionId' });
  }

  try {
    const statuses = await readSessionStatuses(sessionId);
    res.json(statuses);
  } catch (err) {
    console.error(`[server] GET /api/status error for ${sessionId}: ${err.message}`);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.get('/api/session/:sessionId', async (req, res) => {
	const { sessionId } = req.params;
	if (!isValidPathSegment(sessionId)) {
		return res.status(400).json({ error: 'Invalid sessionId' });
	}

	try {
		const sessionData = await readSessionChat(sessionId);
		if (!sessionData) {
			return res.status(404).json({ error: 'Session not found' });
		}
		return res.json(sessionData);
	} catch (err) {
		console.error(`[server] GET /api/session error for ${sessionId}: ${err.message}`);
		return res.status(500).json({ error: err.message || 'Internal server error' });
	}
});

app.get('/api/turn-state/:sessionId', async (req, res) => {
	const { sessionId } = req.params;
	if (!isValidPathSegment(sessionId)) {
		return res.status(400).json({ error: 'Invalid sessionId' });
	}

	try {
		const turnState = await readTurnState(sessionId);
		return res.json(turnState);
	} catch (err) {
		console.error(`[server] GET /api/turn-state error for ${sessionId}: ${err.message}`);
		return res.status(500).json({ error: err.message || 'Internal server error' });
	}
});

// Start server — only when this file is run directly (not imported by tests)
// Check if this module is the entry point by looking for a non-test environment.
// Supertest imports the app without starting a server itself, so we guard the
// listen() call to prevent EADDRINUSE when tests import server.js multiple times.
if (process.env.NODE_ENV !== 'test') {
	app.listen(port, '127.0.0.1', () => {
		console.log(`Express server running on http://localhost:${port}`);
	});
}

export default app;
