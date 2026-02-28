import { execFile as realExecFile, spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import * as realPersistence from './persistence.js';

// Number of most-recent posts to include verbatim in the supervisor prompt.
// Older messages are covered by the conversation summary.
const SUMMARY_CONTEXT_POSTS = parseInt(process.env.SUMMARY_CONTEXT_POSTS || '5', 10);
import { parseResponse } from './response-parser.js';
import { applyBudget, silentActionBudgetGain, randomBudgetGain } from './budget-manager.js';
import { generateSummary, getSummaryOllamaConfig } from './summarizer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const SUPERVISOR_TIMEOUT_MS = 90 * 1000;
const DEFAULT_MODEL = 'haiku';
const SUPERVISOR_DECISION_PACING_MS = 650;
const SUPERVISOR_EMIT_PACING_MS = 700;
const OTT_DEBUG = String(process.env.OTT_DEBUG || 'true').toLowerCase() === 'true';

function debugLog(message, extra = null) {
	if (!OTT_DEBUG) return;
	if (extra == null) {
		console.log(`-=-= [supervisor-orchestrator] ${message}`);
		return;
	}
	console.log(`-=-= [supervisor-orchestrator] ${message}`, extra);
}

function generateMessageId() {
	return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function stripCodeFences(text) {
	const match = String(text || '').match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
	return match ? match[1] : String(text || '');
}

function extractEnvelopeResultText(stdout) {
	try {
		const parsed = JSON.parse(String(stdout || '').trim());
		if (!parsed || typeof parsed !== 'object') return null;
		if (parsed.is_error === true) return null;
		if (typeof parsed.result !== 'string') return null;
		return stripCodeFences(parsed.result.trim());
	} catch {
		return null;
	}
}

function extractFirstJsonObject(text) {
	const source = String(text || '');
	const start = source.indexOf('{');
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < source.length; i++) {
		const ch = source[i];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === '\\') {
				escaped = true;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === '{') depth++;
		if (ch === '}') {
			depth--;
			if (depth === 0) return source.slice(start, i + 1);
		}
	}
	return null;
}

function buildSupervisorSystemPrompt() {
	return [
		'You are Open Think Tank turn planner.',
		'Return exactly one JSON object and nothing else.',
		'Do not write files. Do not mention analysis. No markdown.',
		'',
		'Output shape:',
		'{',
		'  "personaActions": [',
		'    {',
		'      "personaId": "blake|yui|grant|julia",',
		'      "actionType": "quick_response|raise_risk|raise_upside|agree_brief|disagree_reasoned|ask_general|ask_about_idea|clarify|answer_question|answer_simple_question|engage_[name]|research|pass|update_notes|think_hard",',
		'      "action": "speak|think|research|pass|update_notes",',
		'      "text": "required for speak/think",',
		'      "query": "required for research",',
		'      "findings": "required for research",',
		'      "noteUpdate": "required for update_notes, optional for speak"',
		'    }',
		'  ]',
		'}',
		'',
		'Rules:',
		'- Include exactly one entry per AI persona in the input roster.',
		'- Keep speak text concise.',
		'- Silent actions must not produce visible chat text.',
		'- If the first persona (highest overageBudget) uses ask_general, ask_about_idea, or clarify,',
		'  the second persona must NOT also use one of those actionTypes.',
		'  The second persona may answer, agree, disagree, speak briefly, or take a silent action instead.',
		'',
		'Overage budget rules (each persona\'s current overageBudget is in their roster entry):',
		'- Base speak limit: 150 characters. Speaking costs 25 budget flat.',
		'- Speak text < 50 chars: brevity bonus cancels the flat cost (net 0 budget change).',
		'- Speak text > 150 chars: overage (len-150) also deducted on top of flat 25.',
		'  Total cost = 25 + max(0, len-150). If budget cannot cover it, the server truncates.',
		'- Silent actions earn budget: pass=+100; think_hard/research/update_notes=random 10-60.',
		'- Personas not selected to act this round earn a random 10-60 budget automatically.',
		'- Plan speak text to fit within (150 + max(0, overageBudget-25)) chars.',
		'- A persona with overageBudget=0 must keep speak text ≤ 150 chars.',
	].join('\n');
}

function buildSupervisorUserPrompt({
	personas = [],
	messages = [],
	notes = '',
	attachedFiles = [],
	personaBudgets = {},
	conversationSummary = '',
	contextPostLimit = 0,
}) {
	const aiPersonas = personas
		.filter((p) => p.role === 'ai-persona')
		.map((p) => ({
			id: p.id,
			name: p.name,
			displayName: p.displayName,
			prioritizes: p.prioritizes || [],
			overageBudget: personaBudgets[p.id] ?? 0,
		}));

	// Trim to the last N posts when a limit is set
	const contextMessages = contextPostLimit > 0 && messages.length > contextPostLimit
		? messages.slice(-contextPostLimit)
		: messages;

	const parts = [
		'Plan one turn for each persona.',
		'',
		'AI Personas:',
		JSON.stringify(aiPersonas, null, 2),
	];

	const trimmedSummary = (conversationSummary || '').trim();
	if (trimmedSummary) {
		parts.push('', 'Conversation Summary (older messages):', trimmedSummary);
	}

	parts.push(
		'',
		`Recent Conversation (${contextMessages.length} messages):`,
		JSON.stringify(contextMessages, null, 2),
		'',
		'Current Notes:',
		notes || '',
		'',
		'Attached Files:',
		JSON.stringify(attachedFiles || [], null, 2),
	);

	return parts.join('\n');
}

function buildClaudeArgs(userPrompt, systemPrompt, model) {
	return [
		'-p', userPrompt,
		'--system-prompt', systemPrompt,
		'--output-format', 'json',
		'--model', model,
		'--no-session-persistence',
	];
}

function execPromise(execCommand, command, args, options) {
	if (execCommand === realExecFile) {
		return new Promise((resolve, reject) => {
			const child = spawn(command, args, {
				cwd: options?.cwd,
				env: options?.env,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			let stdout = '';
			let stderr = '';
			let settled = false;
			const timeoutMs = options?.timeout || 0;
			const maxBuffer = options?.maxBuffer || 1024 * 1024;
			const timer = timeoutMs > 0
				? setTimeout(() => {
					if (settled) return;
					settled = true;
					const err = new Error(`Command timed out after ${timeoutMs}ms`);
					err.killed = true;
					err.code = 143;
					err.stderr = stderr;
					child.kill('SIGTERM');
					reject(err);
				}, timeoutMs)
				: null;

			function done(handler) {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				handler();
			}

			child.stdout.on('data', (chunk) => {
				stdout += chunk.toString();
				if (stdout.length + stderr.length > maxBuffer) {
					done(() => {
						const err = new Error('maxBuffer exceeded for supervisor output');
						err.stderr = stderr;
						child.kill('SIGTERM');
						reject(err);
					});
				}
			});

			child.stderr.on('data', (chunk) => {
				stderr += chunk.toString();
				if (stdout.length + stderr.length > maxBuffer) {
					done(() => {
						const err = new Error('maxBuffer exceeded for supervisor output');
						err.stderr = stderr;
						child.kill('SIGTERM');
						reject(err);
					});
				}
			});

			child.on('error', (error) => {
				done(() => {
					error.stderr = stderr || '';
					reject(error);
				});
			});

			child.on('close', (code, signal) => {
				done(() => {
					if (code === 0) {
						resolve({ stdout, stderr });
						return;
					}
					const err = new Error(`Command failed (exit ${code ?? 'unknown'})`);
					err.stderr = stderr || '';
					err.stdout = stdout || '';
					err.code = code;
					err.signal = signal;
					reject(err);
				});
			});
		});
	}

	return new Promise((resolve, reject) => {
		execCommand(command, args, options, (error, stdout, stderr) => {
			if (error) {
				error.stderr = stderr || '';
				reject(error);
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}

function parseSupervisorPlan(resultText, aiPersonaIds) {
	if (!resultText) {
		return { success: false, error: 'Supervisor result is empty' };
	}
	let parsed = null;
	try {
		parsed = JSON.parse(resultText);
	} catch {
		const extracted = extractFirstJsonObject(resultText);
		if (extracted) {
			try {
				parsed = JSON.parse(extracted);
			} catch {
				parsed = null;
			}
		}
	}
	if (!parsed || typeof parsed !== 'object') {
		return { success: false, error: 'Supervisor result is not valid JSON object' };
	}
	const actions = parsed.personaActions;
	if (!Array.isArray(actions)) {
		return { success: false, error: 'Supervisor JSON missing personaActions array' };
	}
	const byId = new Map();
	for (const entry of actions) {
		if (!entry || typeof entry !== 'object') continue;
		if (typeof entry.personaId !== 'string') continue;
		byId.set(entry.personaId, entry);
	}
	for (const id of aiPersonaIds) {
		if (!byId.has(id)) {
			return { success: false, error: `Supervisor JSON missing persona action for ${id}` };
		}
	}
	return { success: true, byId };
}

function parsePersonaAction(entry) {
	const envelope = JSON.stringify({
		is_error: false,
		result: JSON.stringify(entry),
	});
	return parseResponse(envelope);
}

/**
 * Determine which AI personas are allowed to act this round.
 *
 * Rules:
 *   1. Top 2 personas by overageBudget (descending).
 *   2. Any persona whose name appears in the last human message.
 *   3. Union of both sets.
 *
 * @param {Array}  aiPersonas       - AI-role personas
 * @param {Object} personaBudgets   - Map of personaId → budget number
 * @param {Array}  messages         - Full conversation history
 * @param {Set}    humanPersonaIds  - Set of persona IDs with role 'human'
 * @returns {Array} Subset of aiPersonas allowed to act
 */
function getAllowedPersonas(aiPersonas, personaBudgets, messages, humanPersonaIds) {
	// Find last human message text
	const lastHumanMsg = [...messages].reverse().find((m) => humanPersonaIds.has(m.speakerId));
	const lastText = (lastHumanMsg?.text || '').toLowerCase();

	// Top 2 by budget
	const sorted = [...aiPersonas].sort(
		(a, b) => (personaBudgets[b.id] ?? 0) - (personaBudgets[a.id] ?? 0)
	);
	const allowed = new Set(sorted.slice(0, 2).map((p) => p.id));

	// Name-mentioned personas
	for (const persona of aiPersonas) {
		const names = [persona.id, persona.name, persona.displayName].filter(Boolean);
		if (names.some((n) => lastText.includes(n.toLowerCase()))) {
			allowed.add(persona.id);
		}
	}

	return aiPersonas.filter((p) => allowed.has(p.id));
}

function buildSessionSnapshot({ sessionId, session, personas, notes, messages }) {
	return {
		formatVersion: '1.0',
		session: {
			...session,
			id: sessionId,
			updatedAt: new Date().toISOString(),
		},
		personas,
		notes: { content: notes },
		messages,
	};
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const SECOND_RESPONDER_PASS_CHANCE = 0.35;

export async function runSupervisorTurn({
	sessionId,
	session = {},
	messages = [],
	notes = '',
	attachedFiles = [],
	personas = [],
	model = DEFAULT_MODEL,
	basePath = PROJECT_ROOT,
	execCommand = realExecFile,
	persistence = realPersistence,
	initialBudgetFn = () => Math.floor(Math.random() * 41) + 10,
	secondPassRollFn = () => Math.random(),
}) {
	const startedAt = new Date().toISOString();
	const startedMs = Date.now();
	debugLog(`turn start sessionId=${sessionId}`);
	await persistence.ensureSessionDir(sessionId, basePath);
	await persistence.writeTurnState(
		sessionId,
		{ state: 'running', startedAt, finishedAt: null, error: null },
		basePath
	);

	const aiPersonas = (personas || []).filter((p) => p.role === 'ai-persona');
	const humanPersonaIds = new Set((personas || []).filter((p) => p.role === 'human').map((p) => p.id));

	// Read the current conversation summary (empty string if none yet)
	const { content: conversationSummary } = await persistence.readSummary(sessionId, basePath);

	// Read persisted overage budgets; initialize missing ones with a random starting value
	const personaBudgets = {};
	for (const persona of aiPersonas) {
		const stored = await persistence.readOverageBudget(sessionId, persona.id, basePath);
		if (stored === null) {
			const initial = initialBudgetFn();
			await persistence.writeOverageBudget(sessionId, persona.id, initial, basePath);
			personaBudgets[persona.id] = initial;
		} else {
			personaBudgets[persona.id] = stored;
		}
	}

	// Only the top-2 by budget + any name-mentioned persona act this round
	const allowedPersonas = getAllowedPersonas(aiPersonas, personaBudgets, messages, humanPersonaIds);
	const allowedPersonaIds = allowedPersonas.map((p) => p.id);
	debugLog(`allowed personas: [${allowedPersonaIds.join(', ')}] sessionId=${sessionId}`);

	// Skipped personas earn a random 10–60 budget for sitting out
	for (const persona of aiPersonas) {
		if (!allowedPersonaIds.includes(persona.id)) {
			const gain = randomBudgetGain();
			const newBudget = (personaBudgets[persona.id] ?? 0) + gain;
			personaBudgets[persona.id] = newBudget;
			await persistence.writeOverageBudget(sessionId, persona.id, newBudget, basePath);
			debugLog(`skip budget +${gain} → ${persona.id} newBudget=${newBudget}`);
		}
	}

	for (const persona of allowedPersonas) {
		await persistence.writePersonaStatus(
			sessionId,
			persona.id,
			{
				personaName: persona.displayName || persona.name || persona.id,
				phase: 'deciding_action',
				action: null,
				actionType: null,
				provider: 'claude_code',
			},
			basePath
		);
	}

	const systemPrompt = buildSupervisorSystemPrompt();
	const userPrompt = buildSupervisorUserPrompt({
		personas: allowedPersonas,
		messages,
		notes,
		attachedFiles,
		personaBudgets,
		conversationSummary,
		contextPostLimit: SUMMARY_CONTEXT_POSTS,
	});
	const args = buildClaudeArgs(userPrompt, systemPrompt, model || DEFAULT_MODEL);

	try {
		debugLog(`spawning supervisor claude sessionId=${sessionId} model=${model || DEFAULT_MODEL}`);
		const { stdout } = await execPromise(execCommand, 'claude', args, {
			cwd: path.join(basePath, 'chats', sessionId),
			timeout: SUPERVISOR_TIMEOUT_MS,
			maxBuffer: 20 * 1024 * 1024,
			env: { ...process.env },
		});
		const resultText = extractEnvelopeResultText(stdout);
		debugLog(`supervisor returned sessionId=${sessionId} resultPreview=${String(resultText || '').slice(0, 80)}`);
		const parsedPlan = parseSupervisorPlan(resultText, allowedPersonaIds);
		if (!parsedPlan.success) {
			throw new Error(parsedPlan.error);
		}

		const workingMessages = [...messages];
		let workingNotes = notes || '';
		const parsedActions = new Map();
		for (const persona of allowedPersonas) {
			const actionEntry = parsedPlan.byId.get(persona.id);
			const parsedAction = parsePersonaAction(actionEntry);
			if (!parsedAction.success) {
				throw new Error(`Invalid persona action for ${persona.id}: ${parsedAction.error}`);
			}
			parsedActions.set(persona.id, parsedAction);
		}

		// Sort allowed personas by budget descending for override checks.
		const sortedByBudget = [...allowedPersonas].sort(
			(a, b) => (personaBudgets[b.id] ?? 0) - (personaBudgets[a.id] ?? 0)
		);

		// 35% chance the second-highest-budget responder is forced to pass this turn.
		if (sortedByBudget.length >= 2 && secondPassRollFn() < SECOND_RESPONDER_PASS_CHANCE) {
			const second = sortedByBudget[1];
			parsedActions.set(second.id, { success: true, action: 'pass', data: { actionType: 'pass', action: 'pass' } });
			console.log(`[supervisor] forced pass → ${second.id} (35% roll) sessionId=${sessionId}`);
		}

		// If the first responder asks a question, the second cannot also ask one.
		if (sortedByBudget.length >= 2) {
			const QUESTION_TYPES = new Set(['ask_general', 'ask_about_idea', 'clarify']);
			const firstAction = parsedActions.get(sortedByBudget[0].id);
			const secondAction = parsedActions.get(sortedByBudget[1].id);
			if (
				firstAction && QUESTION_TYPES.has(firstAction.data?.actionType) &&
				secondAction && QUESTION_TYPES.has(secondAction.data?.actionType)
			) {
				const second = sortedByBudget[1];
				parsedActions.set(second.id, { success: true, action: 'pass', data: { actionType: 'pass', action: 'pass' } });
				console.log(`[supervisor] question blocked → ${second.id} (first already asked) sessionId=${sessionId}`);
			}
		}

		// Phase 1: publish every allowed persona's chosen action first.
		for (const persona of allowedPersonas) {
			const personaName = persona.displayName || persona.name || persona.id;
			const { action, data } = parsedActions.get(persona.id);
			await persistence.writePersonaStatus(
				sessionId,
				persona.id,
				{
					personaName,
					phase: 'deciding_action',
					action,
					actionType: data.actionType || null,
					provider: 'claude_code',
				},
				basePath
			);
			await sleep(SUPERVISOR_DECISION_PACING_MS);
		}

		// Phase 2: execute actions after decision visibility is established.
		for (const persona of allowedPersonas) {
			const personaName = persona.displayName || persona.name || persona.id;
			const { action, data } = parsedActions.get(persona.id);
			await persistence.writePersonaStatus(
				sessionId,
				persona.id,
				{
					personaName,
					phase: 'executing_action',
					action,
					actionType: data.actionType || null,
					provider: 'claude_code',
				},
				basePath
			);

			const timestamp = new Date().toISOString();
			if (action === 'speak') {
				const currentBudget = personaBudgets[persona.id] ?? 0;
				const { text: finalText, newBudget } = applyBudget(data.text, currentBudget);
				personaBudgets[persona.id] = newBudget;
				await persistence.writeOverageBudget(sessionId, persona.id, newBudget, basePath);
				workingMessages.push({
					id: generateMessageId(),
					speakerId: persona.id,
					timestamp,
					text: finalText,
				});
				if (data.noteUpdate) {
					workingNotes = workingNotes
						? `${workingNotes}\n${data.noteUpdate}`
						: data.noteUpdate;
				}
			} else if (action === 'think') {
				const gain = silentActionBudgetGain(action);
				const newBudget = (personaBudgets[persona.id] ?? 0) + gain;
				personaBudgets[persona.id] = newBudget;
				await persistence.writeOverageBudget(sessionId, persona.id, newBudget, basePath);
				await persistence.appendMonologue(
					sessionId,
					persona.id,
					{ timestamp, text: data.text, type: 'think' },
					basePath
				);
			} else if (action === 'research') {
				const gain = silentActionBudgetGain(action);
				const newBudget = (personaBudgets[persona.id] ?? 0) + gain;
				personaBudgets[persona.id] = newBudget;
				await persistence.writeOverageBudget(sessionId, persona.id, newBudget, basePath);
				await persistence.appendMonologue(
					sessionId,
					persona.id,
					{ timestamp, text: `Research: ${data.query}\nFindings: ${data.findings}`, type: 'research' },
					basePath
				);
			} else if (action === 'update_notes') {
				const gain = silentActionBudgetGain(action);
				const newBudget = (personaBudgets[persona.id] ?? 0) + gain;
				personaBudgets[persona.id] = newBudget;
				await persistence.writeOverageBudget(sessionId, persona.id, newBudget, basePath);
				workingNotes = workingNotes
					? `${workingNotes}\n${data.noteUpdate}`
					: data.noteUpdate;
			} else if (action === 'pass') {
				const gain = silentActionBudgetGain(action);
				const newBudget = (personaBudgets[persona.id] ?? 0) + gain;
				personaBudgets[persona.id] = newBudget;
				await persistence.writeOverageBudget(sessionId, persona.id, newBudget, basePath);
			}

			await persistence.writePersonaStatus(
				sessionId,
				persona.id,
				{
					personaName,
					phase: 'completed',
					action,
					actionType: data.actionType || null,
					provider: 'claude_code',
				},
				basePath
			);

			await persistence.writeSessionChat(
				sessionId,
				buildSessionSnapshot({
					sessionId,
					session,
					personas,
					notes: workingNotes,
					messages: workingMessages,
				}),
				basePath
			);

			// Small pacing window so polling UIs observe progressive persona updates.
			await sleep(SUPERVISOR_EMIT_PACING_MS);
		}

		await persistence.writeSessionChat(
			sessionId,
			buildSessionSnapshot({
				sessionId,
				session,
				personas,
				notes: workingNotes,
				messages: workingMessages,
			}),
			basePath
		);

		// Generate session summary after the turn completes
		try {
			const ollamaConfig = getSummaryOllamaConfig();
			const summaryText = await generateSummary({
				messages: workingMessages,
				personas,
				ollamaConfig,
				model: model || DEFAULT_MODEL,
				cwd: path.join(basePath, 'chats', sessionId),
			});
			if (summaryText) {
				await persistence.writeSummary(sessionId, summaryText, basePath);
				debugLog(`summary written sessionId=${sessionId} length=${summaryText.length}`);
			}
		} catch (err) {
			debugLog(`summary generation failed sessionId=${sessionId} error=${err?.message}`);
		}

		await persistence.writeTurnState(
			sessionId,
			{
				state: 'completed',
				startedAt,
				finishedAt: new Date().toISOString(),
				error: null,
			},
			basePath
		);
		debugLog(`turn complete sessionId=${sessionId} durationMs=${Date.now() - startedMs}`);
		return { ok: true };
	} catch (err) {
		debugLog(`turn failed sessionId=${sessionId} durationMs=${Date.now() - startedMs} error=${err?.message || 'unknown'}`);
		if (err?.stderr) {
			debugLog(`stderr preview sessionId=${sessionId} stderr=${String(err.stderr).slice(0, 500)}`);
		}
		if (err?.stdout) {
			debugLog(`stdout preview sessionId=${sessionId} stdout=${String(err.stdout).slice(0, 500)}`);
		}
		for (const persona of allowedPersonas) {
			await persistence.writePersonaStatus(
				sessionId,
				persona.id,
				{
					personaName: persona.displayName || persona.name || persona.id,
					phase: 'failed',
					action: null,
					actionType: null,
					provider: 'claude_code',
				},
				basePath
			);
		}
		await persistence.writeTurnState(
			sessionId,
			{
				state: 'failed',
				startedAt,
				finishedAt: new Date().toISOString(),
				error: err.message || 'Supervisor failed',
			},
			basePath
		);
		throw err;
	}
}
