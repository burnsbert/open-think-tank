import { describe, it, expect, vi } from 'vitest';
import { runSupervisorTurn } from '../lib/supervisor-orchestrator.js';

function createExecSuccess() {
	return vi.fn((cmd, args, opts, cb) => {
		const plan = {
			personaActions: [
				{
					personaId: 'blake',
					actionType: 'quick_response',
					action: 'speak',
					text: 'hello',
				},
			],
		};
		const envelope = {
			type: 'result',
			subtype: 'success',
			is_error: false,
			result: JSON.stringify(plan),
		};
		process.nextTick(() => cb(null, JSON.stringify(envelope), ''));
	});
}

function createPersistence() {
	return {
		ensureSessionDir: vi.fn(async () => {}),
		writeTurnState: vi.fn(async () => {}),
		writePersonaStatus: vi.fn(async () => {}),
		appendMonologue: vi.fn(async () => {}),
		writeSessionChat: vi.fn(async () => {}),
	};
}

describe('runSupervisorTurn', () => {
	it('writes running and completed turn states', async () => {
		const persistence = createPersistence();
		const execCommand = createExecSuccess();
		await runSupervisorTurn({
			sessionId: 'session-001',
			personas: [{ id: 'blake', name: 'Blake', role: 'ai-persona' }],
			messages: [],
			persistence,
			execCommand,
			basePath: '/tmp/open-think-tank-test',
		});

		expect(persistence.writeTurnState).toHaveBeenCalledTimes(2);
		expect(persistence.writeTurnState.mock.calls[0][1].state).toBe('running');
		expect(persistence.writeTurnState.mock.calls[1][1].state).toBe('completed');
		expect(execCommand).toHaveBeenCalledTimes(1);
	});

	it('writes failed turn state when supervisor command errors', async () => {
		const persistence = createPersistence();
		const execCommand = vi.fn((cmd, args, opts, cb) => {
			process.nextTick(() => cb(new Error('boom'), '', ''));
		});

		await expect(
			runSupervisorTurn({
				sessionId: 'session-002',
				personas: [],
				messages: [],
				persistence,
				execCommand,
				basePath: '/tmp/open-think-tank-test',
			})
		).rejects.toThrow('boom');

		expect(persistence.writeTurnState.mock.calls.at(-1)[1].state).toBe('failed');
	});
});
