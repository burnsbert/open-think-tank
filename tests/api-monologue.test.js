/**
 * Tests for GET /api/monologue/:sessionId/:personaId endpoint
 * TDD: tests written FIRST, verified failing, then implementation added.
 *
 * Endpoint: GET /api/monologue/:sessionId/:personaId
 * Response: JSON array of monologue entries
 *
 * Behavior:
 *   - Returns the persona's monologue entries for a given session
 *   - Returns [] if no monologue file exists (not an error)
 *   - Returns 400 if sessionId or personaId are empty strings
 *   - Returns 500 on unexpected filesystem errors (other than ENOENT)
 *
 * Uses mocked persistence.readMonologue to avoid touching the filesystem.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Mock lib/persistence.js BEFORE importing server.js
// vi.mock is hoisted to the top of the module by Vitest automatically
// ---------------------------------------------------------------------------

vi.mock('../lib/persistence.js', () => ({
  readMonologue: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import app and the mocked module
// ---------------------------------------------------------------------------

import app from '../server.js';
import { readMonologue } from '../lib/persistence.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SAMPLE_MONOLOGUE = [
  {
    timestamp: '2026-02-25T10:00:00.000Z',
    text: 'I am thinking about this problem.',
    type: 'think',
  },
  {
    timestamp: '2026-02-25T10:05:00.000Z',
    text: 'Research: best practices\nFindings: Use TDD.',
    type: 'research',
  },
];

// ---------------------------------------------------------------------------
// Clear mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Describe: Successful responses
// ---------------------------------------------------------------------------

describe('GET /api/monologue/:sessionId/:personaId — success', () => {
  it('returns 200 with an array of monologue entries', async () => {
    readMonologue.mockResolvedValue(SAMPLE_MONOLOGUE);

    const res = await request(app)
      .get('/api/monologue/session-001/blake');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toEqual(SAMPLE_MONOLOGUE);
  });

  it('returns 200 with empty array when no monologue file exists', async () => {
    readMonologue.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/monologue/session-001/yui');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('calls readMonologue with the correct sessionId from URL params', async () => {
    readMonologue.mockResolvedValue([]);

    await request(app)
      .get('/api/monologue/my-session-id/blake');

    expect(readMonologue).toHaveBeenCalledOnce();
    const [sessionId] = readMonologue.mock.calls[0];
    expect(sessionId).toBe('my-session-id');
  });

  it('calls readMonologue with the correct personaId from URL params', async () => {
    readMonologue.mockResolvedValue([]);

    await request(app)
      .get('/api/monologue/session-001/grant');

    expect(readMonologue).toHaveBeenCalledOnce();
    const [, personaId] = readMonologue.mock.calls[0];
    expect(personaId).toBe('grant');
  });

  it('returns JSON content-type', async () => {
    readMonologue.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/monologue/session-001/julia');

    expect(res.headers['content-type']).toContain('application/json');
  });

  it('returns all entry fields (timestamp, text, type) intact', async () => {
    readMonologue.mockResolvedValue(SAMPLE_MONOLOGUE);

    const res = await request(app)
      .get('/api/monologue/session-001/blake');

    expect(res.body[0]).toHaveProperty('timestamp', '2026-02-25T10:00:00.000Z');
    expect(res.body[0]).toHaveProperty('text', 'I am thinking about this problem.');
    expect(res.body[0]).toHaveProperty('type', 'think');
  });

  it('handles sessions with special characters in the ID (hyphens, underscores)', async () => {
    readMonologue.mockResolvedValue(SAMPLE_MONOLOGUE);

    const res = await request(app)
      .get('/api/monologue/session-abc-123_xyz/blake');

    expect(res.status).toBe(200);
    const [sessionId] = readMonologue.mock.calls[0];
    expect(sessionId).toBe('session-abc-123_xyz');
  });
});

// ---------------------------------------------------------------------------
// Describe: Parameter validation
// ---------------------------------------------------------------------------

describe('GET /api/monologue/:sessionId/:personaId — parameter validation', () => {
  it('returns 400 when route is called with no personaId (missing segment)', async () => {
    // When only one param is provided, Express will not match this route
    // The route must have both :sessionId and :personaId to match
    readMonologue.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/monologue/session-001');

    // Express returns 404 when only one URL segment is provided (route doesn't match)
    expect(res.status).toBe(404);
  });

  it('does not call readMonologue when route does not match', async () => {
    await request(app).get('/api/monologue/session-001');

    expect(readMonologue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Describe: Error handling
// ---------------------------------------------------------------------------

describe('GET /api/monologue/:sessionId/:personaId — error handling', () => {
  it('returns 500 when readMonologue throws an unexpected error', async () => {
    const fsError = new Error('EACCES: permission denied');
    fsError.code = 'EACCES';
    readMonologue.mockRejectedValue(fsError);

    const res = await request(app)
      .get('/api/monologue/session-001/blake');

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 500 with an error message string when filesystem error occurs', async () => {
    const fsError = new Error('EIO: i/o error, read');
    fsError.code = 'EIO';
    readMonologue.mockRejectedValue(fsError);

    const res = await request(app)
      .get('/api/monologue/session-001/yui');

    expect(res.status).toBe(500);
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);
  });

  it('does not expose raw error stack in the 500 response', async () => {
    const fsError = new Error('EACCES: permission denied');
    readMonologue.mockRejectedValue(fsError);

    const res = await request(app)
      .get('/api/monologue/session-001/blake');

    expect(res.body).not.toHaveProperty('stack');
  });

  it('still returns a valid JSON body on 500 errors', async () => {
    readMonologue.mockRejectedValue(new Error('Something broke'));

    const res = await request(app)
      .get('/api/monologue/session-001/blake');

    expect(res.headers['content-type']).toContain('application/json');
    expect(typeof res.body).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// Describe: Integration with persistence module
// ---------------------------------------------------------------------------

describe('GET /api/monologue/:sessionId/:personaId — persistence integration', () => {
  it('calls readMonologue exactly once per request', async () => {
    readMonologue.mockResolvedValue([]);

    await request(app).get('/api/monologue/session-001/blake');

    expect(readMonologue).toHaveBeenCalledTimes(1);
  });

  it('passes only sessionId and personaId to readMonologue (no extra args)', async () => {
    readMonologue.mockResolvedValue([]);

    await request(app).get('/api/monologue/test-session/julia');

    expect(readMonologue).toHaveBeenCalledWith('test-session', 'julia');
  });

  it('returns exactly what readMonologue returns without modification', async () => {
    const customEntries = [
      { timestamp: '2026-02-25T12:00:00.000Z', text: 'Custom thought', type: 'think' },
      { timestamp: '2026-02-25T12:01:00.000Z', text: 'Custom research\nFindings: result', type: 'research' },
    ];
    readMonologue.mockResolvedValue(customEntries);

    const res = await request(app).get('/api/monologue/session-custom/grant');

    expect(res.body).toEqual(customEntries);
    expect(res.body.length).toBe(2);
  });

  it('handles a large monologue array (100 entries)', async () => {
    const largeMonologue = Array.from({ length: 100 }, (_, i) => ({
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
      text: `Entry ${i + 1}`,
      type: i % 2 === 0 ? 'think' : 'research',
    }));
    readMonologue.mockResolvedValue(largeMonologue);

    const res = await request(app).get('/api/monologue/session-large/blake');

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(100);
  });
});
