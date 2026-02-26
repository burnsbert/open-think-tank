import express from 'express';
import cors from 'cors';
import { runTurn } from './lib/turn-orchestrator.js';
import { readMonologue } from './lib/persistence.js';

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

// Health-check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// POST /api/turn — run a full turn (round) of persona responses via SSE
app.post('/api/turn', async (req, res) => {
  const { sessionId, messages, notes, attachedFiles, model, personas } = req.body || {};

  // Validate required fields
  if (!sessionId || typeof sessionId !== 'string' || sessionId.trim() === '') {
    return res.status(400).json({ error: 'sessionId is required' });
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
    await runTurn({
      sessionId,
      messages: [...messages], // shallow copy to avoid mutating caller's array
      notes: notes || '',
      attachedFiles: attachedFiles || [],
      personas: personas || [],
      model: model || 'sonnet',
      onEvent,
    });
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
