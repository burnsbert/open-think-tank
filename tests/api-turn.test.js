import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../lib/supervisor-orchestrator.js', () => ({
	runSupervisorTurn: vi.fn(),
}));

import app from '../server.js';
import { runSupervisorTurn } from '../lib/supervisor-orchestrator.js';

const PERSONAS = [
	{ id: 'blake', name: 'Blake', displayName: 'Blake', role: 'ai-persona' },
	{ id: 'yui', name: 'Yui', displayName: 'Yui', role: 'ai-persona' },
	{ id: 'grant', name: 'Grant', displayName: 'Grant', role: 'ai-persona' },
	{ id: 'julia', name: 'Julia', displayName: 'Julia', role: 'ai-persona' },
	{ id: 'user', name: 'User', displayName: 'User', role: 'human' },
];

const BASE_REQUEST = {
	sessionId: 'test-session-001',
	messages: [
		{ id: 'msg-1', speakerId: 'user', timestamp: '2026-02-25T10:00:00Z', text: 'Hello everyone' },
	],
	notes: 'Some session notes',
	attachedFiles: [],
	model: 'haiku',
	personas: PERSONAS,
};

let testSessionCounter = 0;
function uniqueSession() {
	return `test-session-${Date.now()}-${++testSessionCounter}`;
}

beforeEach(() => {
	vi.clearAllMocks();
	runSupervisorTurn.mockResolvedValue({ ok: true });
});

describe('POST /api/turn', () => {
	it('returns 400 when sessionId is missing', async () => {
		const { sessionId: _omit, ...body } = BASE_REQUEST;
		const res = await request(app).post('/api/turn').send(body);
		expect(res.status).toBe(400);
		expect(String(res.body.error || '')).toMatch(/sessionId/i);
	});

	it('returns 400 when messages is not an array', async () => {
		const res = await request(app)
			.post('/api/turn')
			.send({ ...BASE_REQUEST, sessionId: uniqueSession(), messages: 'bad' });
		expect(res.status).toBe(400);
		expect(String(res.body.error || '')).toMatch(/messages/i);
	});

	it('returns 202 with accepted status for valid request', async () => {
		const sessionId = uniqueSession();
		const res = await request(app)
			.post('/api/turn')
			.send({ ...BASE_REQUEST, sessionId });
		expect(res.status).toBe(202);
		expect(res.body.status).toBe('accepted');
		expect(res.body.sessionId).toBe(sessionId);
	});

	it('starts supervisor orchestration in background', async () => {
		const sessionId = uniqueSession();
		const res = await request(app)
			.post('/api/turn')
			.send({ ...BASE_REQUEST, sessionId, model: 'opus' });

		expect(res.status).toBe(202);
		expect(runSupervisorTurn).toHaveBeenCalledTimes(1);
		expect(runSupervisorTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId,
				model: 'opus',
				messages: BASE_REQUEST.messages,
				personas: PERSONAS,
			})
		);
	});

	it('returns 409 when same session already running', async () => {
		let release;
		runSupervisorTurn.mockImplementationOnce(
			() => new Promise((resolve) => { release = resolve; })
		);

		const sessionId = uniqueSession();
		request(app)
			.post('/api/turn')
			.send({ ...BASE_REQUEST, sessionId })
			.end(() => {});
		await new Promise((resolve) => setTimeout(resolve, 40));

		const secondRes = await request(app)
			.post('/api/turn')
			.send({ ...BASE_REQUEST, sessionId });
		expect(secondRes.status).toBe(409);

		release({ ok: true });
	});
});
