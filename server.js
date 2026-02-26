import express from 'express';
import cors from 'cors';
import { runTurn } from './lib/turn-orchestrator.js';
import { readMonologue } from './lib/persistence.js';

const app = express();
const port = process.env.PORT || 3001;
const MAX_ROUND2_PERSONAS = 2;

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

// POST /api/turn — run a full turn (round) of persona responses via SSE
app.post('/api/turn', async (req, res) => {
  const { sessionId, session, messages, notes, attachedFiles, model, personas } = req.body || {};

  // Validate required fields
  if (!sessionId || typeof sessionId !== 'string' || sessionId.trim() === '') {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  if (!isValidPathSegment(sessionId)) {
    return res.status(400).json({ error: 'sessionId contains invalid characters' });
  }
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages must be an array' });
  }

  // Check for concurrent turn on the same session
  if (activeSessions.has(sessionId)) {
    return res.status(409).json({ error: 'Turn already in progress' });
  }

  // Register session as active
  activeSessions.add(sessionId);

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  /**
   * Write a single SSE event to the response.
   * Format: "event: <type>\ndata: <json>\n\n"
   *
   * @param {string} eventType - SSE event name
   * @param {*} data - Payload (will be JSON-serialized)
   */
  function writeSseEvent(eventType, data) {
    res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /**
   * Map turn-orchestrator event objects to SSE events.
   * Event types from orchestrator: thinking, message, notes, done, error
   */
  function onEvent(event) {
    switch (event.type) {
      case 'thinking':
        writeSseEvent('thinking', {
          personaId: event.personaId,
          personaName: event.personaName,
        });
        break;

      case 'message':
        writeSseEvent('message', {
          personaId: event.personaId,
          message: event.message,
          action: event.action,
        });
        break;

      case 'notes':
        writeSseEvent('notes', {
          content: event.content,
        });
        break;

      case 'done':
        writeSseEvent('done', {});
        break;

      case 'error':
        writeSseEvent('error', {
          personaId: event.personaId,
          error: event.error,
        });
        break;

      default:
        // Unknown event type — ignore
        break;
    }
  }

  try {
    const workingMessages = [...messages]; // mutable round state
    let workingNotes = notes || '';
    let workingSummary = null;

    const round1Result = await runTurn({
      sessionId,
      session: session || {},
      messages: workingMessages,
      notes: workingNotes,
      attachedFiles: attachedFiles || [],
      personas: personas || [],
      contextSummary: workingSummary,
      roundNumber: 1,
      totalRounds: 2,
      model: model || 'haiku',
      onEvent: (event) => {
        if (event.type === 'done') return;
        onEvent(event);
      },
    });

    if (round1Result?.updatedNotes != null) {
      workingNotes = round1Result.updatedNotes;
    }
    if (round1Result?.contextSummary) {
      workingSummary = round1Result.contextSummary;
    }

    const requestedRound2 = (round1Result?.round2RequestedPersonaIds || []).slice(0, MAX_ROUND2_PERSONAS);

    if (requestedRound2.length > 0) {
      const turnResult = await runTurn({
        sessionId,
        session: session || {},
        messages: workingMessages,
        notes: workingNotes,
        attachedFiles: attachedFiles || [],
        personas: personas || [],
        contextSummary: workingSummary,
        runPersonaIds: requestedRound2,
        roundNumber: 2,
        totalRounds: 2,
        model: model || 'haiku',
        onEvent: (event) => {
          // Collapse internal per-round done events into one final done event.
          if (event.type === 'done') return;
          onEvent(event);
        },
      });

      if (turnResult?.updatedNotes != null) {
        workingNotes = turnResult.updatedNotes;
      }
      if (turnResult?.contextSummary) {
        workingSummary = turnResult.contextSummary;
      }
    }

    // Ensure exactly one final done event for the full user-triggered turn.
    writeSseEvent('done', {});
  } catch (err) {
    console.error(`[server] POST /api/turn error for session ${sessionId}: ${err.message}`);
    // If response not yet ended, write error and end
    if (!res.writableEnded) {
      writeSseEvent('error', { personaId: null, error: err.message || 'Internal server error' });
      res.end();
    }
  } finally {
    // Always remove session from active set, whether success or error
    activeSessions.delete(sessionId);
  }

  // End the SSE stream (if not already ended in catch)
  if (!res.writableEnded) {
    res.end();
  }
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
