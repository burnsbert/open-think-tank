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

function createPersistence({ budgets = {} } = {}) {
	return {
		ensureSessionDir: vi.fn(async () => {}),
		writeTurnState: vi.fn(async () => {}),
		writePersonaStatus: vi.fn(async () => {}),
		appendMonologue: vi.fn(async () => {}),
		writeSessionChat: vi.fn(async () => {}),
		// null = uninitialized (first turn); explicit values = already persisted
		readOverageBudget: vi.fn(async (sessionId, personaId) => budgets[personaId] ?? null),
		writeOverageBudget: vi.fn(async () => {}),
		readSummary: vi.fn(async () => ({ content: '', updatedAt: null })),
		writeSummary: vi.fn(async () => {}),
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
			initialBudgetFn: () => 25,
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

describe('runSupervisorTurn — initial budget', () => {
	it('initializes budget with random 10-50 value on first turn', async () => {
		const persistence = createPersistence(); // budgets = null (uninitialized)
		const execCommand = vi.fn((cmd, args, opts, cb) => {
			const plan = {
				personaActions: [{ personaId: 'blake', actionType: 'pass', action: 'pass' }],
			};
			process.nextTick(() => cb(null, JSON.stringify({ is_error: false, result: JSON.stringify(plan) }), ''));
		});
		let capturedInitial = null;
		await runSupervisorTurn({
			sessionId: 'init-01',
			personas: [{ id: 'blake', name: 'Blake', role: 'ai-persona' }],
			messages: [],
			persistence,
			execCommand,
			basePath: '/tmp/ott-test',
			initialBudgetFn: () => { capturedInitial = 30; return 30; },
		});
		// Should have written the initial budget (30) then added +100 for pass
		const writes = persistence.writeOverageBudget.mock.calls;
		expect(writes[0]).toEqual(['init-01', 'blake', 30, '/tmp/ott-test']); // initial
		expect(writes[1]).toEqual(['init-01', 'blake', 130, '/tmp/ott-test']); // 30 + 100 pass
	});

	it('does not re-initialize when budget file already exists', async () => {
		const persistence = createPersistence({ budgets: { blake: 75 } });
		const execCommand = vi.fn((cmd, args, opts, cb) => {
			const plan = { personaActions: [{ personaId: 'blake', actionType: 'pass', action: 'pass' }] };
			process.nextTick(() => cb(null, JSON.stringify({ is_error: false, result: JSON.stringify(plan) }), ''));
		});
		const initFn = vi.fn(() => 999);
		await runSupervisorTurn({
			sessionId: 'init-02',
			personas: [{ id: 'blake', name: 'Blake', role: 'ai-persona' }],
			messages: [],
			persistence,
			execCommand,
			basePath: '/tmp/ott-test',
			initialBudgetFn: initFn,
		});
		expect(initFn).not.toHaveBeenCalled();
		// first writeOverageBudget should be the post-pass update (75 + 100 = 175)
		expect(persistence.writeOverageBudget.mock.calls[0]).toEqual(['init-02', 'blake', 175, '/tmp/ott-test']);
	});
});

describe('runSupervisorTurn — turn gating', () => {
	const FOUR_PERSONAS = [
		{ id: 'blake', name: 'Blake', displayName: 'Blake', role: 'ai-persona' },
		{ id: 'yui',   name: 'Yui',   displayName: 'Yui',   role: 'ai-persona' },
		{ id: 'grant', name: 'Grant', displayName: 'Grant', role: 'ai-persona' },
		{ id: 'julia', name: 'Julia', displayName: 'Julia', role: 'ai-persona' },
	];

	function execWithPlan(actions) {
		return vi.fn((cmd, args, opts, cb) => {
			const plan = { personaActions: actions };
			process.nextTick(() => cb(null, JSON.stringify({ is_error: false, result: JSON.stringify(plan) }), ''));
		});
	}

	it('only the top-2 budget personas act each round', async () => {
		// blake=100, yui=80 are top-2; grant=20, julia=5 are excluded
		const persistence = createPersistence({ budgets: { blake: 100, yui: 80, grant: 20, julia: 5 } });
		const execCommand = execWithPlan([
			{ personaId: 'blake', actionType: 'quick_response', action: 'speak', text: 'Hi.' },
			{ personaId: 'yui',   actionType: 'quick_response', action: 'speak', text: 'Hey.' },
		]);
		await runSupervisorTurn({
			sessionId: 'gate-01',
			personas: FOUR_PERSONAS,
			messages: [{ id: 'm1', speakerId: 'user', text: 'Hello everyone.' }],
			persistence,
			execCommand,
			basePath: '/tmp/ott-test',
			secondPassRollFn: () => 1, // disable forced-pass roll
		});
		// Only blake and yui should have status writes (skipped personas have no status)
		const statusPersonaIds = new Set(persistence.writePersonaStatus.mock.calls.map((c) => c[1]));
		expect(statusPersonaIds).toContain('blake');
		expect(statusPersonaIds).toContain('yui');
		expect(statusPersonaIds).not.toContain('grant');
		expect(statusPersonaIds).not.toContain('julia');
		// All personas get budget writes (allowed: speak cost, skipped: +50 skip bonus)
		const budgetPersonaIds = new Set(persistence.writeOverageBudget.mock.calls.map((c) => c[1]));
		expect(budgetPersonaIds).toContain('grant');
		expect(budgetPersonaIds).toContain('julia');
	});

	it('name-mentioned persona is included even with lower budget', async () => {
		// blake=100, yui=80 are top-2, but julia is mentioned by name
		const persistence = createPersistence({ budgets: { blake: 100, yui: 80, grant: 20, julia: 5 } });
		const execCommand = execWithPlan([
			{ personaId: 'blake', actionType: 'quick_response', action: 'speak', text: 'Hi.' },
			{ personaId: 'yui',   actionType: 'quick_response', action: 'speak', text: 'Hey.' },
			{ personaId: 'julia', actionType: 'quick_response', action: 'speak', text: 'Yes?' },
		]);
		const humanPersona = { id: 'user', name: 'User', displayName: 'You', role: 'human' };
		await runSupervisorTurn({
			sessionId: 'gate-02',
			personas: [...FOUR_PERSONAS, humanPersona],
			messages: [{ id: 'm1', speakerId: 'user', text: 'Julia what do you think?' }],
			persistence,
			execCommand,
			basePath: '/tmp/ott-test',
			secondPassRollFn: () => 1, // disable forced-pass roll
		});
		// julia acted (has status); grant was skipped (no status)
		const statusPersonaIds = new Set(persistence.writePersonaStatus.mock.calls.map((c) => c[1]));
		expect(statusPersonaIds).toContain('julia');
		expect(statusPersonaIds).not.toContain('grant');
	});

	it('35% roll forces second-highest-budget persona to pass', async () => {
		// blake=100 (1st), yui=80 (2nd) — yui should be forced to pass
		const persistence = createPersistence({ budgets: { blake: 100, yui: 80, grant: 20, julia: 5 } });
		const execCommand = execWithPlan([
			{ personaId: 'blake', actionType: 'quick_response', action: 'speak', text: 'Hi.' },
			{ personaId: 'yui',   actionType: 'quick_response', action: 'speak', text: 'Hey.' },
		]);
		await runSupervisorTurn({
			sessionId: 'gate-forced',
			personas: FOUR_PERSONAS,
			messages: [{ id: 'm1', speakerId: 'user', text: 'Hello.' }],
			persistence,
			execCommand,
			basePath: '/tmp/ott-test',
			secondPassRollFn: () => 0, // always force
		});
		// yui's final status should be 'pass', not 'speak'
		const yuiStatusCalls = persistence.writePersonaStatus.mock.calls.filter((c) => c[1] === 'yui');
		const lastYuiStatus = yuiStatusCalls.at(-1)[2];
		expect(lastYuiStatus.action).toBe('pass');
		// yui's budget should increase by 100 (pass gain), not decrease
		const yuiBudgetCalls = persistence.writeOverageBudget.mock.calls.filter((c) => c[1] === 'yui');
		const finalYuiBudget = yuiBudgetCalls.at(-1)[2];
		expect(finalYuiBudget).toBe(80 + 100); // 80 initial + 100 pass gain
	});

	it('name match is case-insensitive', async () => {
		const persistence = createPersistence({ budgets: { blake: 100, yui: 80, grant: 20, julia: 5 } });
		const execCommand = execWithPlan([
			{ personaId: 'blake', actionType: 'quick_response', action: 'speak', text: 'Hi.' },
			{ personaId: 'yui',   actionType: 'quick_response', action: 'speak', text: 'Hey.' },
			{ personaId: 'grant', actionType: 'quick_response', action: 'speak', text: 'Yo.' },
		]);
		const humanPersona = { id: 'user', name: 'User', displayName: 'You', role: 'human' };
		await runSupervisorTurn({
			sessionId: 'gate-03',
			personas: [...FOUR_PERSONAS, humanPersona],
			messages: [{ id: 'm1', speakerId: 'user', text: 'what does GRANT think?' }],
			persistence,
			execCommand,
			basePath: '/tmp/ott-test',
			secondPassRollFn: () => 1, // disable forced-pass roll
		});
		const budgetWrites = persistence.writeOverageBudget.mock.calls.map((c) => c[1]);
		expect(budgetWrites).toContain('grant');
	});
});

describe('runSupervisorTurn — overage budget', () => {
	function createExecWithPlan(plan) {
		return vi.fn((cmd, args, opts, cb) => {
			const envelope = {
				type: 'result',
				subtype: 'success',
				is_error: false,
				result: JSON.stringify(plan),
			};
			process.nextTick(() => cb(null, JSON.stringify(envelope), ''));
		});
	}

	it('reads budget for each persona before the turn', async () => {
		const persistence = createPersistence({ budgets: { blake: 50 } });
		const execCommand = createExecWithPlan({
			personaActions: [{ personaId: 'blake', actionType: 'quick_response', action: 'speak', text: 'Hello.' }],
		});
		await runSupervisorTurn({
			sessionId: 's1',
			personas: [{ id: 'blake', name: 'Blake', role: 'ai-persona' }],
			messages: [],
			persistence,
			execCommand,
			basePath: '/tmp/ott-test',
		});
		expect(persistence.readOverageBudget).toHaveBeenCalledWith('s1', 'blake', '/tmp/ott-test');
	});

	it('pass action increases budget by 100', async () => {
		const persistence = createPersistence({ budgets: { blake: 0 } });
		const execCommand = createExecWithPlan({
			personaActions: [{ personaId: 'blake', actionType: 'pass', action: 'pass' }],
		});
		await runSupervisorTurn({
			sessionId: 's2',
			personas: [{ id: 'blake', name: 'Blake', role: 'ai-persona' }],
			messages: [],
			persistence,
			execCommand,
			basePath: '/tmp/ott-test',
		});
		expect(persistence.writeOverageBudget).toHaveBeenCalledWith('s2', 'blake', 100, '/tmp/ott-test');
	});

	it('think action increases budget by a random 10-60', async () => {
		const persistence = createPersistence({ budgets: { blake: 0 } });
		const execCommand = createExecWithPlan({
			personaActions: [{ personaId: 'blake', actionType: 'think_hard', action: 'think', text: 'Thinking...' }],
		});
		await runSupervisorTurn({
			sessionId: 's3',
			personas: [{ id: 'blake', name: 'Blake', role: 'ai-persona' }],
			messages: [],
			persistence,
			execCommand,
			basePath: '/tmp/ott-test',
		});
		const [, , newBudget] = persistence.writeOverageBudget.mock.calls[0];
		expect(newBudget).toBeGreaterThanOrEqual(10);
		expect(newBudget).toBeLessThanOrEqual(60);
	});

	it('short speak text (< 50 chars) nets 0 budget change', async () => {
		const persistence = createPersistence({ budgets: { blake: 75 } });
		const shortText = 'Use Postgres.'; // < 50 chars — brevity bonus cancels flat cost
		const execCommand = createExecWithPlan({
			personaActions: [{ personaId: 'blake', actionType: 'quick_response', action: 'speak', text: shortText }],
		});
		await runSupervisorTurn({
			sessionId: 's4',
			personas: [{ id: 'blake', name: 'Blake', role: 'ai-persona' }],
			messages: [],
			persistence,
			execCommand,
			basePath: '/tmp/ott-test',
		});
		expect(persistence.writeOverageBudget).toHaveBeenCalledWith('s4', 'blake', 75, '/tmp/ott-test');
	});

	it('speak text within 150 chars costs flat 25', async () => {
		const persistence = createPersistence({ budgets: { blake: 100 } });
		const text = 'A'.repeat(100); // 100 chars, > 50 so no brevity, ≤ 150 so no overage
		const execCommand = createExecWithPlan({
			personaActions: [{ personaId: 'blake', actionType: 'quick_response', action: 'speak', text }],
		});
		await runSupervisorTurn({
			sessionId: 's5',
			personas: [{ id: 'blake', name: 'Blake', role: 'ai-persona' }],
			messages: [],
			persistence,
			execCommand,
			basePath: '/tmp/ott-test',
		});
		// Budget should decrease by 25 (flat cost only)
		expect(persistence.writeOverageBudget).toHaveBeenCalledWith('s5', 'blake', 75, '/tmp/ott-test');
	});

	it('speak text over 150 chars, budget covers total cost: budget decremented', async () => {
		const persistence = createPersistence({ budgets: { blake: 200 } });
		const text = 'A'.repeat(200); // 50 chars over base limit; totalCost = 25+50 = 75
		const execCommand = createExecWithPlan({
			personaActions: [{ personaId: 'blake', actionType: 'quick_response', action: 'speak', text }],
		});
		await runSupervisorTurn({
			sessionId: 's6',
			personas: [{ id: 'blake', name: 'Blake', role: 'ai-persona' }],
			messages: [],
			persistence,
			execCommand,
			basePath: '/tmp/ott-test',
		});
		expect(persistence.writeOverageBudget).toHaveBeenCalledWith('s6', 'blake', 125, '/tmp/ott-test');
	});

	it('speak text over budget: message truncated and budget set to 0', async () => {
		const persistence = createPersistence({ budgets: { blake: 0 } });
		// Text well over 150 with a word boundary
		const text = ('word ').repeat(40).trim(); // ~199 chars
		const execCommand = createExecWithPlan({
			personaActions: [{ personaId: 'blake', actionType: 'quick_response', action: 'speak', text }],
		});
		await runSupervisorTurn({
			sessionId: 's7',
			personas: [{ id: 'blake', name: 'Blake', role: 'ai-persona' }],
			messages: [],
			persistence,
			execCommand,
			basePath: '/tmp/ott-test',
		});
		expect(persistence.writeOverageBudget).toHaveBeenCalledWith('s7', 'blake', 0, '/tmp/ott-test');
		// The saved message text should be truncated to ≤ 150
		const savedChat = persistence.writeSessionChat.mock.calls.at(-1)[1];
		const blakeMsg = savedChat.messages.find((m) => m.speakerId === 'blake');
		expect(blakeMsg.text.length).toBeLessThanOrEqual(150);
	});
});
