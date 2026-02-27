import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import path from 'path';
import os from 'os';
import * as persistence from '../lib/persistence.js';
import { runSupervisorTurn } from '../lib/supervisor-orchestrator.js';

function createPlanExecCommand() {
	return (command, args, options, callback) => {
		const plan = {
			personaActions: [
				{
					personaId: 'blake',
					actionType: 'quick_response',
					action: 'speak',
					text: 'I am Blake, the pragmatist.',
				},
				{
					personaId: 'yui',
					actionType: 'quick_response',
					action: 'speak',
					text: 'I am Yui, focused on users.',
				},
				{
					personaId: 'grant',
					actionType: 'quick_response',
					action: 'speak',
					text: 'I am Grant, focused on innovation.',
				},
				{
					personaId: 'julia',
					actionType: 'quick_response',
					action: 'speak',
					text: 'I am Julia, focused on strategy.',
				},
			],
		};
		const envelope = {
			type: 'result',
			subtype: 'success',
			is_error: false,
			result: JSON.stringify(plan),
		};
		process.nextTick(() => {
			callback(null, JSON.stringify(envelope), '');
		});
	};
}

describe('runSupervisorTurn integration', () => {
	it('persists four persona responses for greeting turn', async () => {
		const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'ott-supervisor-int-'));
		const sessionId = 'integration-greeting';

		try {
			const personas = [
				{ id: 'blake', name: 'Blake', displayName: 'Blake', role: 'ai-persona' },
				{ id: 'yui', name: 'Yui', displayName: 'Yui', role: 'ai-persona' },
				{ id: 'grant', name: 'Grant', displayName: 'Grant', role: 'ai-persona' },
				{ id: 'julia', name: 'Julia', displayName: 'Julia', role: 'ai-persona' },
				{ id: 'user', name: 'You', displayName: 'You', role: 'human' },
			];
			const initialMessages = [
				{
					id: 'msg-user-1',
					speakerId: 'user',
					timestamp: '2026-02-26T00:00:00.000Z',
					text: 'hi, who do we have in the chat today?',
				},
			];

			await runSupervisorTurn({
				sessionId,
				session: { id: sessionId, title: 'Integration Turn' },
				messages: initialMessages,
				notes: '',
				attachedFiles: [],
				personas,
				model: 'haiku',
				basePath: tmpBase,
				execCommand: createPlanExecCommand(),
				persistence,
			});

			const turnState = await persistence.readTurnState(sessionId, tmpBase);
			expect(turnState.state).toBe('completed');

			const statuses = await persistence.readSessionStatuses(sessionId, tmpBase);
			expect(statuses).toHaveLength(4);
			for (const status of statuses) {
				expect(status.phase).toBe('completed');
				expect(status.action).toBe('speak');
				expect(status.actionType).toBe('quick_response');
			}

			const sessionChat = await persistence.readSessionChat(sessionId, tmpBase);
			expect(sessionChat).toBeTruthy();
			expect(Array.isArray(sessionChat.messages)).toBe(true);
			expect(sessionChat.messages.length).toBe(5);

			const aiMessages = sessionChat.messages.filter((m) => m.speakerId !== 'user');
			expect(aiMessages).toHaveLength(4);
			const aiIds = aiMessages.map((m) => m.speakerId).sort();
			expect(aiIds).toEqual(['blake', 'grant', 'julia', 'yui']);
		} finally {
			await rm(tmpBase, { recursive: true, force: true });
		}
	}, 10000);
});
