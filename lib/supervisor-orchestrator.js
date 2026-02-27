import { execFile as realExecFile, spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import * as realPersistence from './persistence.js';
import { parseResponse } from './response-parser.js';

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
	].join('\n');
}

function buildSupervisorUserPrompt({
	personas = [],
	messages = [],
	notes = '',
	attachedFiles = [],
}) {
	const aiPersonas = personas
		.filter((p) => p.role === 'ai-persona')
		.map((p) => ({
			id: p.id,
			name: p.name,
			displayName: p.displayName,
			prioritizes: p.prioritizes || [],
		}));

	return [
		'Plan one turn for each persona.',
		'',
		'AI Personas:',
		JSON.stringify(aiPersonas, null, 2),
		'',
		'Conversation Messages:',
		JSON.stringify(messages || [], null, 2),
		'',
		'Current Notes:',
		notes || '',
		'',
		'Attached Files:',
		JSON.stringify(attachedFiles || [], null, 2),
	].join('\n');
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
	const aiPersonaIds = aiPersonas.map((p) => p.id);
	for (const persona of aiPersonas) {
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
	const userPrompt = buildSupervisorUserPrompt({ personas, messages, notes, attachedFiles });
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
		const parsedPlan = parseSupervisorPlan(resultText, aiPersonaIds);
		if (!parsedPlan.success) {
			throw new Error(parsedPlan.error);
		}

		const workingMessages = [...messages];
		let workingNotes = notes || '';
		const parsedActions = new Map();
		for (const persona of aiPersonas) {
			const actionEntry = parsedPlan.byId.get(persona.id);
			const parsedAction = parsePersonaAction(actionEntry);
			if (!parsedAction.success) {
				throw new Error(`Invalid persona action for ${persona.id}: ${parsedAction.error}`);
			}
			parsedActions.set(persona.id, parsedAction);
		}

		// Phase 1: publish every persona's chosen action first.
		for (const persona of aiPersonas) {
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
		for (const persona of aiPersonas) {
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
				workingMessages.push({
					id: generateMessageId(),
					speakerId: persona.id,
					timestamp,
					text: data.text,
				});
				if (data.noteUpdate) {
					workingNotes = workingNotes
						? `${workingNotes}\n${data.noteUpdate}`
						: data.noteUpdate;
				}
			} else if (action === 'think') {
				await persistence.appendMonologue(
					sessionId,
					persona.id,
					{ timestamp, text: data.text, type: 'think' },
					basePath
				);
			} else if (action === 'research') {
				await persistence.appendMonologue(
					sessionId,
					persona.id,
					{ timestamp, text: `Research: ${data.query}\nFindings: ${data.findings}`, type: 'research' },
					basePath
				);
			} else if (action === 'update_notes') {
				workingNotes = workingNotes
					? `${workingNotes}\n${data.noteUpdate}`
					: data.noteUpdate;
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
		for (const persona of aiPersonas) {
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
