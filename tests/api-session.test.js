import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../lib/persistence.js', () => ({
	readMonologue: vi.fn(),
	readSessionStatuses: vi.fn(),
	readSessionChat: vi.fn(),
	readTurnState: vi.fn(),
}));

import app from '../server.js';
import { readSessionChat, readTurnState } from '../lib/persistence.js';

beforeEach(() => {
	vi.clearAllMocks();
});

describe('GET /api/session/:sessionId', () => {
	it('returns 200 with session payload', async () => {
		readSessionChat.mockResolvedValue({ session: { id: 'session-001' }, messages: [] });
		const res = await request(app).get('/api/session/session-001');
		expect(res.status).toBe(200);
		expect(res.body.session.id).toBe('session-001');
	});

	it('returns 404 when session is missing', async () => {
		readSessionChat.mockResolvedValue(null);
		const res = await request(app).get('/api/session/session-404');
		expect(res.status).toBe(404);
	});
});

describe('GET /api/turn-state/:sessionId', () => {
	it('returns 200 with turn state payload', async () => {
		readTurnState.mockResolvedValue({ state: 'running' });
		const res = await request(app).get('/api/turn-state/session-001');
		expect(res.status).toBe(200);
		expect(res.body.state).toBe('running');
	});
});
