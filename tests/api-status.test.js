import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../lib/persistence.js', () => ({
	readMonologue: vi.fn(),
	readSessionStatuses: vi.fn(),
	readSessionChat: vi.fn(),
	readTurnState: vi.fn(),
}));

import app from '../server.js';
import { readSessionStatuses } from '../lib/persistence.js';

beforeEach(() => {
	vi.clearAllMocks();
});

describe('GET /api/status/:sessionId', () => {
	it('returns 200 with status array', async () => {
		readSessionStatuses.mockResolvedValue([
			{
				personaId: 'blake',
				personaName: 'Blake',
				phase: 'executing_action',
				action: 'speak',
				actionType: 'raise_risk',
				updatedAt: '2026-02-26T00:00:00.000Z',
			},
		]);

		const res = await request(app).get('/api/status/session-001');
		expect(res.status).toBe(200);
		expect(Array.isArray(res.body)).toBe(true);
		expect(res.body[0].personaId).toBe('blake');
		expect(res.body[0].actionType).toBe('raise_risk');
	});

	it('returns 400 for invalid session id', async () => {
		const res = await request(app).get('/api/status/..%2Fetc');
		expect(res.status).toBe(400);
		expect(readSessionStatuses).not.toHaveBeenCalled();
	});

	it('returns 500 when persistence fails', async () => {
		readSessionStatuses.mockRejectedValue(new Error('Disk issue'));
		const res = await request(app).get('/api/status/session-001');
		expect(res.status).toBe(500);
		expect(typeof res.body.error).toBe('string');
	});
});
