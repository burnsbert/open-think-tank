/**
 * Tests for POST /api/turn endpoint with SSE streaming
 * TDD: tests written FIRST, verified failing, then implementation added.
 *
 * Endpoint: POST /api/turn
 * Request body: { sessionId, messages, notes, attachedFiles, model, personas }
 * Response: SSE stream (Content-Type: text/event-stream)
 *
 * SSE events:
 *   - thinking: { personaId, personaName } — persona's turn starting
 *   - message: { personaId, message, action } — persona finished
 *   - notes: { content } — notes updated
 *   - done: {} — round complete
 *   - error: { personaId, error } — persona failure
 *
 * Concurrent session handling:
 *   - in-memory Set of active session IDs
 *   - HTTP 409 if session already in progress
 *
 * All tests use a mocked runTurn to avoid real claude calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Mock lib/turn-orchestrator.js BEFORE importing server.js
// vi.mock is hoisted to the top of the module by Vitest automatically
// ---------------------------------------------------------------------------

vi.mock('../lib/turn-orchestrator.js', () => ({
  runTurn: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import app and the mocked module
// ---------------------------------------------------------------------------

import app from '../server.js';
import { runTurn } from '../lib/turn-orchestrator.js';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const PERSONAS = [
  { id: 'blake', name: 'Blake', displayName: 'Blake', role: 'ai-persona', prioritizes: ['quality'] },
  { id: 'yui', name: 'Yui', displayName: 'Yui', role: 'ai-persona', prioritizes: ['ux'] },
  { id: 'grant', name: 'Grant', displayName: 'Grant', role: 'ai-persona', prioritizes: ['innovation'] },
  { id: 'julia', name: 'Julia', displayName: 'Julia', role: 'ai-persona', prioritizes: ['strategy'] },
  { id: 'user', name: 'User', displayName: 'User', role: 'human' },
];

const BASE_REQUEST = {
  sessionId: 'test-session-001',
  messages: [
    { id: 'msg-1', speakerId: 'user', timestamp: '2026-02-25T10:00:00Z', text: 'Hello everyone' },
  ],
  notes: 'Some session notes',
  attachedFiles: [],
  model: 'sonnet',
  personas: PERSONAS,
};

// Use unique session IDs per test to avoid cross-test Set state pollution
let testSessionCounter = 0;
function uniqueSession() {
  return `test-session-${Date.now()}-${++testSessionCounter}`;
}

// ---------------------------------------------------------------------------
// Helper: parse an SSE response body into an array of event objects
// Each event object: { event: string, data: object|null }
// ---------------------------------------------------------------------------

function parseSseBody(text) {
  const events = [];
  // SSE events are separated by double-newline
  const rawEvents = text.split('\n\n').filter(chunk => chunk.trim() !== '');

  for (const rawEvent of rawEvents) {
    const lines = rawEvent.split('\n');
    let eventType = null;
    let dataStr = null;

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice('event: '.length).trim();
      } else if (line.startsWith('data: ')) {
        dataStr = line.slice('data: '.length).trim();
      }
    }

    if (eventType !== null) {
      events.push({
        event: eventType,
        data: dataStr !== null ? JSON.parse(dataStr) : null,
      });
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Clear mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Describe: Request validation
// ---------------------------------------------------------------------------

describe('POST /api/turn — request validation', () => {
  it('returns 400 when sessionId is missing', async () => {
    const { sessionId: _omit, ...body } = BASE_REQUEST;
    const res = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error).toMatch(/sessionId/i);
  });

  it('returns 400 when messages is missing', async () => {
    const { messages: _omit, ...body } = { ...BASE_REQUEST, sessionId: uniqueSession() };
    const res = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error).toMatch(/messages/i);
  });

  it('returns 400 when messages is not an array', async () => {
    const res = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId: uniqueSession(), messages: 'not an array' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error).toMatch(/messages/i);
  });

  it('returns 400 when sessionId is empty string', async () => {
    const res = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId: '' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 when sessionId contains path traversal (..)', async () => {
    const res = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId: '../../etc' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it('returns 400 when sessionId contains forward slash', async () => {
    const res = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId: 'sessions/secret' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it('returns 400 when sessionId contains backslash', async () => {
    const res = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId: 'sessions\\secret' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it('returns 400 when sessionId contains encoded path traversal', async () => {
    const res = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId: '..%2F..%2Fetc' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });
});

// ---------------------------------------------------------------------------
// Describe: SSE response headers
// ---------------------------------------------------------------------------

describe('POST /api/turn — SSE response headers', () => {
  it('sets Content-Type to text/event-stream', async () => {
    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'done' });
      return { personasProcessed: 0, personasSucceeded: 0, personasFailed: 0 };
    });

    const res = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId: uniqueSession() });

    expect(res.headers['content-type']).toContain('text/event-stream');
  });

  it('sets Cache-Control to no-cache', async () => {
    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'done' });
      return { personasProcessed: 0, personasSucceeded: 0, personasFailed: 0 };
    });

    const res = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId: uniqueSession() });

    expect(res.headers['cache-control']).toContain('no-cache');
  });

  it('sets Connection to keep-alive', async () => {
    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'done' });
      return { personasProcessed: 0, personasSucceeded: 0, personasFailed: 0 };
    });

    const res = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId: uniqueSession() });

    expect(res.headers['connection']).toContain('keep-alive');
  });
});

// ---------------------------------------------------------------------------
// Describe: SSE event format
// ---------------------------------------------------------------------------

describe('POST /api/turn — SSE event format', () => {
  it('emits done event at end of a turn', async () => {
    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'done' });
      return { personasProcessed: 0, personasSucceeded: 0, personasFailed: 0 };
    });

    const res = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId: uniqueSession() });

    const events = parseSseBody(res.text);
    const doneEvent = events.find(e => e.event === 'done');
    expect(doneEvent).toBeDefined();
  });

  it('emits thinking event with personaId and personaName', async () => {
    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'thinking', personaId: 'blake', personaName: 'Blake' });
      onEvent({ type: 'done' });
      return { personasProcessed: 1, personasSucceeded: 1, personasFailed: 0 };
    });

    const res = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId: uniqueSession() });

    const events = parseSseBody(res.text);
    const thinkingEvent = events.find(e => e.event === 'thinking');
    expect(thinkingEvent).toBeDefined();
    expect(thinkingEvent.data.personaId).toBe('blake');
    expect(thinkingEvent.data.personaName).toBe('Blake');
  });

  it('emits message event with personaId, message, and action for speak', async () => {
    const mockMessage = {
      id: 'msg-123',
      speakerId: 'blake',
      timestamp: '2026-02-25T10:00:00Z',
      text: 'Hello from Blake',
    };

    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'thinking', personaId: 'blake', personaName: 'Blake' });
      onEvent({ type: 'message', personaId: 'blake', message: mockMessage, action: 'speak' });
      onEvent({ type: 'done' });
      return { personasProcessed: 1, personasSucceeded: 1, personasFailed: 0 };
    });

    const res = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId: uniqueSession() });

    const events = parseSseBody(res.text);
    const msgEvent = events.find(e => e.event === 'message');
    expect(msgEvent).toBeDefined();
    expect(msgEvent.data.personaId).toBe('blake');
    expect(msgEvent.data.action).toBe('speak');
    expect(msgEvent.data.message).toEqual(mockMessage);
  });

  it('emits message event with action=think for think actions', async () => {
    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'message', personaId: 'yui', message: { text: 'Thinking silently' }, action: 'think' });
      onEvent({ type: 'done' });
      return { personasProcessed: 1, personasSucceeded: 1, personasFailed: 0 };
    });

    const res = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId: uniqueSession() });

    const events = parseSseBody(res.text);
    const msgEvent = events.find(e => e.event === 'message');
    expect(msgEvent).toBeDefined();
    expect(msgEvent.data.action).toBe('think');
    expect(msgEvent.data.personaId).toBe('yui');
  });

  it('emits notes event with content when notes are updated', async () => {
    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'notes', content: 'Updated notes content' });
      onEvent({ type: 'done' });
      return { personasProcessed: 1, personasSucceeded: 1, personasFailed: 0 };
    });

    const res = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId: uniqueSession() });

    const events = parseSseBody(res.text);
    const notesEvent = events.find(e => e.event === 'notes');
    expect(notesEvent).toBeDefined();
    expect(notesEvent.data.content).toBe('Updated notes content');
  });

  it('emits error event with personaId and error message on persona failure', async () => {
    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'thinking', personaId: 'yui', personaName: 'Yui' });
      onEvent({ type: 'error', personaId: 'yui', error: 'Claude CLI failed' });
      onEvent({ type: 'done' });
      return { personasProcessed: 1, personasSucceeded: 0, personasFailed: 1 };
    });

    const res = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId: uniqueSession() });

    const events = parseSseBody(res.text);
    const errorEvent = events.find(e => e.event === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent.data.personaId).toBe('yui');
    expect(errorEvent.data.error).toBe('Claude CLI failed');
  });

  it('uses correct SSE wire format: event line + data line + double-newline', async () => {
    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'done' });
      return { personasProcessed: 0, personasSucceeded: 0, personasFailed: 0 };
    });

    const res = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId: uniqueSession() });

    // Should contain at least one properly formatted SSE event
    expect(res.text).toMatch(/^event: \w+\ndata: /m);
    // Each event chunk ends with double-newline
    expect(res.text).toContain('\n\n');
  });

  it('emits events in sequence: thinking, message, done for a full persona turn', async () => {
    const mockMessage = {
      id: 'msg-456',
      speakerId: 'grant',
      timestamp: '2026-02-25T10:01:00Z',
      text: 'Grant is speaking',
    };

    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'thinking', personaId: 'grant', personaName: 'Grant' });
      onEvent({ type: 'message', personaId: 'grant', message: mockMessage, action: 'speak' });
      onEvent({ type: 'done' });
      return { personasProcessed: 1, personasSucceeded: 1, personasFailed: 0 };
    });

    const res = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId: uniqueSession() });

    const events = parseSseBody(res.text);
    expect(events.length).toBe(3);
    expect(events[0].event).toBe('thinking');
    expect(events[1].event).toBe('message');
    expect(events[2].event).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// Describe: runTurn called with correct parameters
// ---------------------------------------------------------------------------

describe('POST /api/turn — orchestrator integration', () => {
  it('calls runTurn with sessionId from request body', async () => {
    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'done' });
      return { personasProcessed: 0, personasSucceeded: 0, personasFailed: 0 };
    });

    const sessionId = uniqueSession();
    await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId });

    expect(runTurn).toHaveBeenCalledOnce();
    const callArgs = runTurn.mock.calls[0][0];
    expect(callArgs.sessionId).toBe(sessionId);
  });

  it('calls runTurn with messages from request body', async () => {
    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'done' });
      return { personasProcessed: 0, personasSucceeded: 0, personasFailed: 0 };
    });

    await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId: uniqueSession() });

    const callArgs = runTurn.mock.calls[0][0];
    expect(callArgs.messages).toEqual(BASE_REQUEST.messages);
  });

  it('calls runTurn with model from request body', async () => {
    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'done' });
      return { personasProcessed: 0, personasSucceeded: 0, personasFailed: 0 };
    });

    await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId: uniqueSession(), model: 'opus' });

    const callArgs = runTurn.mock.calls[0][0];
    expect(callArgs.model).toBe('opus');
  });

  it('calls runTurn with personas from request body', async () => {
    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'done' });
      return { personasProcessed: 0, personasSucceeded: 0, personasFailed: 0 };
    });

    await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId: uniqueSession() });

    const callArgs = runTurn.mock.calls[0][0];
    expect(callArgs.personas).toEqual(PERSONAS);
  });

  it('calls runTurn with notes from request body', async () => {
    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'done' });
      return { personasProcessed: 0, personasSucceeded: 0, personasFailed: 0 };
    });

    await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId: uniqueSession() });

    const callArgs = runTurn.mock.calls[0][0];
    expect(callArgs.notes).toBe('Some session notes');
  });

  it('calls runTurn with attachedFiles from request body', async () => {
    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'done' });
      return { personasProcessed: 0, personasSucceeded: 0, personasFailed: 0 };
    });

    const reqWithFiles = { ...BASE_REQUEST, sessionId: uniqueSession(), attachedFiles: ['doc.pdf', 'notes.txt'] };
    await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send(reqWithFiles);

    const callArgs = runTurn.mock.calls[0][0];
    expect(callArgs.attachedFiles).toEqual(['doc.pdf', 'notes.txt']);
  });

  it('calls runTurn with an onEvent callback function', async () => {
    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'done' });
      return { personasProcessed: 0, personasSucceeded: 0, personasFailed: 0 };
    });

    await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId: uniqueSession() });

    const callArgs = runTurn.mock.calls[0][0];
    expect(typeof callArgs.onEvent).toBe('function');
  });

  it('calls runTurn with session metadata from request body', async () => {
    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'done' });
      return { personasProcessed: 0, personasSucceeded: 0, personasFailed: 0 };
    });

    const session = { id: 'test-001', title: 'My Chat', startedAt: '2026-01-01T00:00:00Z', topic: 'Test' };
    await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId: uniqueSession(), session });

    const callArgs = runTurn.mock.calls[0][0];
    expect(callArgs.session).toEqual(session);
  });

  it('defaults session to empty object when not provided', async () => {
    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'done' });
      return { personasProcessed: 0, personasSucceeded: 0, personasFailed: 0 };
    });

    const { session: _omit, ...body } = { ...BASE_REQUEST, sessionId: uniqueSession() };
    await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send(body);

    const callArgs = runTurn.mock.calls[0][0];
    expect(callArgs.session).toEqual({});
  });

  it('uses default model "sonnet" when model is not provided', async () => {
    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'done' });
      return { personasProcessed: 0, personasSucceeded: 0, personasFailed: 0 };
    });

    const { model: _omit, ...bodyWithoutModel } = { ...BASE_REQUEST, sessionId: uniqueSession() };
    await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send(bodyWithoutModel);

    const callArgs = runTurn.mock.calls[0][0];
    expect(callArgs.model).toBe('sonnet');
  });
});

// ---------------------------------------------------------------------------
// Describe: Concurrent turn protection (in-memory Set of active session IDs)
// ---------------------------------------------------------------------------

describe('POST /api/turn — concurrent turn protection', () => {
  it('returns 409 when a turn is already in progress for the same session', async () => {
    // Use a unique session so it doesn't conflict with other tests
    const sessionId = uniqueSession();

    // First request: holds the turn open until we resolve it
    let releaseTurn;
    const turnLatch = new Promise(resolve => { releaseTurn = resolve; });

    // Track when the first request completes
    let firstRequestDone;
    const firstRequestPromise = new Promise(resolve => { firstRequestDone = resolve; });

    runTurn.mockImplementationOnce(async ({ onEvent }) => {
      await turnLatch;
      onEvent({ type: 'done' });
      return { personasProcessed: 0, personasSucceeded: 0, personasFailed: 0 };
    });

    // Start first turn using .end() callback so it fires immediately (non-blocking)
    request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId })
      .end((err, res) => {
        firstRequestDone({ err, res });
      });

    // Give first request a moment to register the session as active
    await new Promise(resolve => setTimeout(resolve, 50));

    // Second request for same session should get 409
    const secondRes = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId });

    expect(secondRes.status).toBe(409);
    expect(secondRes.body.error).toMatch(/turn already in progress/i);

    // Release the first turn to clean up
    releaseTurn();
    const { res: firstRes } = await firstRequestPromise;
    expect(firstRes.status).toBe(200);
  }, 10000);

  it('allows a new turn after the previous one completes', async () => {
    const sessionId = uniqueSession();

    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'done' });
      return { personasProcessed: 0, personasSucceeded: 0, personasFailed: 0 };
    });

    // First turn completes normally
    const firstRes = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId });

    expect(firstRes.status).toBe(200);

    // Second turn for the same session should now succeed
    const secondRes = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId });

    expect(secondRes.status).toBe(200);
  });

  it('allows concurrent turns for different session IDs', async () => {
    const sessionId1 = uniqueSession();
    const sessionId2 = uniqueSession();

    let releaseFirst;
    const firstLatch = new Promise(resolve => { releaseFirst = resolve; });

    // Track when the first request completes
    let firstRequestDone;
    const firstRequestPromise = new Promise(resolve => { firstRequestDone = resolve; });

    runTurn
      .mockImplementationOnce(async ({ onEvent }) => {
        await firstLatch;
        onEvent({ type: 'done' });
        return { personasProcessed: 0, personasSucceeded: 0, personasFailed: 0 };
      })
      .mockImplementationOnce(async ({ onEvent }) => {
        onEvent({ type: 'done' });
        return { personasProcessed: 0, personasSucceeded: 0, personasFailed: 0 };
      });

    // Start first turn for sessionId1 using .end() callback (non-blocking)
    request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId: sessionId1 })
      .end((err, res) => {
        firstRequestDone({ err, res });
      });

    // Give first request a moment to register
    await new Promise(resolve => setTimeout(resolve, 50));

    // Second turn for a DIFFERENT session should succeed immediately
    const secondRes = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId: sessionId2 });

    expect(secondRes.status).toBe(200);

    // Release first and verify it also succeeded
    releaseFirst();
    const { res: firstRes } = await firstRequestPromise;
    expect(firstRes.status).toBe(200);
  }, 10000);

  it('removes session from active set on runTurn error so a retry is allowed', async () => {
    const sessionId = uniqueSession();

    // First request: orchestrator throws unexpectedly
    runTurn.mockRejectedValueOnce(new Error('Orchestrator internal error'));

    const firstRes = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId });

    // Gets 200 with an SSE error event (headers already sent before the throw)
    // OR 500 if it throws before headers are sent — both are acceptable
    expect([200, 500]).toContain(firstRes.status);

    // Session should be removed from active set — second request should succeed
    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'done' });
      return { personasProcessed: 0, personasSucceeded: 0, personasFailed: 0 };
    });

    const secondRes = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send({ ...BASE_REQUEST, sessionId });

    expect(secondRes.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Describe: Optional field defaults
// ---------------------------------------------------------------------------

describe('POST /api/turn — optional field defaults', () => {
  it('defaults notes to empty string when not provided', async () => {
    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'done' });
      return { personasProcessed: 0, personasSucceeded: 0, personasFailed: 0 };
    });

    const { notes: _omit, ...body } = { ...BASE_REQUEST, sessionId: uniqueSession() };
    const res = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(200);
    const callArgs = runTurn.mock.calls[0][0];
    expect(callArgs.notes).toBe('');
  });

  it('defaults attachedFiles to empty array when not provided', async () => {
    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'done' });
      return { personasProcessed: 0, personasSucceeded: 0, personasFailed: 0 };
    });

    const { attachedFiles: _omit, ...body } = { ...BASE_REQUEST, sessionId: uniqueSession() };
    const res = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(200);
    const callArgs = runTurn.mock.calls[0][0];
    expect(callArgs.attachedFiles).toEqual([]);
  });

  it('defaults personas to empty array when not provided', async () => {
    runTurn.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'done' });
      return { personasProcessed: 0, personasSucceeded: 0, personasFailed: 0 };
    });

    const { personas: _omit, ...body } = { ...BASE_REQUEST, sessionId: uniqueSession() };
    const res = await request(app)
      .post('/api/turn')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(200);
    const callArgs = runTurn.mock.calls[0][0];
    expect(callArgs.personas).toEqual([]);
  });
});
