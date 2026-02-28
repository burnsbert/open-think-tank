/**
 * lib/turn-orchestrator.js
 *
 * Core engine for running a full turn (round) of persona responses.
 *
 * Orchestrates:
 *   (a) Persona ordering — name-mention prioritization + randomization
 *   (b) Parallel persona processing — build prompt, spawn claude -p,
 *       parse response, apply result (speak/think/research), write monologue
 *   (c) Post-round persistence — write updated session-chat.json to disk
 *
 * Designed for testability via dependency injection:
 *   - execCommand: replaces child_process.execFile
 *   - buildPrompt: replaces lib/prompt-builder.js
 *   - persistence: replaces lib/persistence.js
 *   - onEvent: callback for SSE streaming
 *
 * Error handling: if a persona fails (CLI error, timeout, parse failure), that
 * persona's turn is skipped and the round continues. The round is never aborted
 * due to a single persona failure.
 */

import { execFile as realExecFile, spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildPrompt as realBuildPrompt, buildActionChoicePrompt as realBuildActionChoicePrompt } from './prompt-builder.js';
import * as realPersistence from './persistence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Default timeout per persona: 120 seconds
const PERSONA_TIMEOUT_MS = 120000;

// Default model
const DEFAULT_MODEL = 'haiku';
const SUMMARY_MODEL = 'haiku';
const DECISION_MODEL = 'haiku';
const DEFAULT_DECIDED_ACTION_TYPE = 'think_hard';
const OLLAMA_DECISION_TIMEOUT_MS = 15000;
const PROVIDER_OLLAMA = 'ollama';
const PROVIDER_CLAUDE_CODE = 'claude_code';
const SUMMARY_TAIL_COUNT = 16;
const SUMMARY_MIN_MESSAGES = 24;
const SUMMARY_REFRESH_INTERVAL = 8;
const SUMMARY_MAX_CHARS = 4000;
const MAX_SPEAK_CHARS = 520;
const MAX_SPEAK_SENTENCES = {
  simple: 2,
  medium: 3,
  complex: 4,
};
const MAX_SPEAK_CHARS_BY_INTENT = {
  simple: 250,
  medium: 400,
  complex: 520,
};
const SIMPLE_SENTENCE_CAP_BY_PERSONA = {
	blake: 1,
	yui: 2,
	grant: 2,
	julia: 1,
};

/**
 * Generate a message ID matching the frontend format.
 * Pattern: msg-{timestamp}-{random5chars}
 *
 * @returns {string}
 */
function generateMessageId() {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Shuffle an array in place using Fisher-Yates algorithm.
 *
 * @param {Array} arr
 * @returns {Array} The same array, shuffled
 */
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Determine the persona turn order.
 *
 * If the user's last message mentions a persona by name or displayName
 * (case-insensitive, word-boundary match), that persona goes first.
 * Remaining personas are randomized. If no mention, fully randomize.
 *
 * @param {Array} aiPersonas - AI persona objects (already filtered, no humans)
 * @param {Array} messages - Current message history
 * @param {Array} allPersonas - Full persona roster (for human/AI detection)
 * @returns {Array} Ordered persona objects
 */
function determinePersonaOrder(aiPersonas, messages, allPersonas) {
  if (aiPersonas.length === 0) return [];

  // Find the last message from a human (role === 'human') user
  const humanIds = new Set(
    allPersonas.filter(p => p.role === 'human').map(p => p.id)
  );

  let lastUserMessage = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (humanIds.has(messages[i].speakerId)) {
      lastUserMessage = messages[i];
      break;
    }
  }

  let prioritizedPersona = null;

  if (lastUserMessage && lastUserMessage.text) {
    const text = lastUserMessage.text.toLowerCase();

    // Check each AI persona for a name/displayName mention with word boundaries
    for (const persona of aiPersonas) {
      const names = [persona.name, persona.displayName].filter(Boolean);
      for (const name of names) {
        // Word boundary regex: match the name as a whole word
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
        if (pattern.test(lastUserMessage.text)) {
          prioritizedPersona = persona;
          break;
        }
      }
      if (prioritizedPersona) break;
    }
  }

  if (prioritizedPersona) {
    // Put prioritized persona first, randomize the rest
    const rest = aiPersonas.filter(p => p.id !== prioritizedPersona.id);
    shuffleArray(rest);
    return [prioritizedPersona, ...rest];
  }

  // No mention — fully randomize
  const shuffled = [...aiPersonas];
  shuffleArray(shuffled);
  return shuffled;
}

/**
 * Wrap execFile in a Promise.
 *
 * @param {Function} execCommand - The execFile function (real or mock)
 * @param {string} command - Command to execute
 * @param {string[]} args - Command arguments
 * @param {Object} options - execFile options (timeout, etc.)
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function execPromise(execCommand, command, args, options) {
  // `claude -p` can block indefinitely when stdin is left open as a pipe.
  // For the real CLI execution path, spawn with stdin ignored so the process
  // cannot wait on input.
  if (execCommand === realExecFile) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options?.cwd,
        env: options?.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      const timeoutMs = options?.timeout || 0;
      const maxBuffer = options?.maxBuffer || 1024 * 1024;
      let settled = false;

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

      function done(result) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        result();
      }

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        if (stdout.length + stderr.length > maxBuffer) {
          done(() => {
            const err = new Error('maxBuffer exceeded for claude output');
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
            const err = new Error('maxBuffer exceeded for claude output');
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
          const error = new Error(`Command failed (exit ${code ?? 'unknown'})`);
          error.stderr = stderr || '';
          error.code = code;
          error.signal = signal;
          reject(error);
        });
      });
    });
  }

  return new Promise((resolve, reject) => {
    execCommand(command, args, options, (error, stdout, stderr) => {
      if (error) {
        // Attach stderr to the error for better diagnostics
        error.stderr = stderr || '';
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Build the claude CLI args array for a persona's turn.
 *
 * @param {string} prompt - The assembled prompt string
 * @param {string} model - Model to use (e.g., 'sonnet', 'opus')
 * @returns {string[]}
 */
function buildClaudeArgs(prompt, systemPrompt, model, tools = 'Read,WebSearch,WebFetch,Glob,Grep') {
  return [
    '-p', prompt,
    '--system-prompt', systemPrompt,
    '--output-format', 'json',
    '--model', model,
    '--no-session-persistence',
    '--tools', tools,
  ];
}

function buildSummaryArgs(summaryPrompt) {
  const systemPrompt = [
    'You are a summarizer for a multi-persona chat application.',
    'Summarize older conversation content concisely for AI context.',
    'Output plain text only. No markdown code fences.',
    `Keep the summary under ${SUMMARY_MAX_CHARS} characters.`,
  ].join('\n');

  return [
    '-p', summaryPrompt,
    '--system-prompt', systemPrompt,
    '--output-format', 'json',
    '--model', SUMMARY_MODEL,
    '--no-session-persistence',
    '--tools', '',
  ];
}

function getOllamaConfig() {
  const isTestEnv = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
  if (isTestEnv && process.env.OLLAMA_FORCE_IN_TESTS !== 'true') {
    return null;
  }

  const enabledRaw = String(process.env.OLLAMA_ENABLED || '').trim().toLowerCase();
  const explicitlyEnabled = enabledRaw === 'true' || enabledRaw === '1' || enabledRaw === 'yes';
  const explicitlyDisabled = enabledRaw === 'false' || enabledRaw === '0' || enabledRaw === 'no';

  const baseModel = String(process.env.OLLAMA_MODEL || '').trim();
  const decisionModel = String(process.env.OLLAMA_DECISION_MODEL || '').trim() || baseModel;
  const simpleActionModel = String(process.env.OLLAMA_SIMPLE_ACTION_MODEL || '').trim() || baseModel;

  // Allow Ollama when either role-specific model is configured, even if
  // OLLAMA_MODEL is not set. This avoids silent disablement.
  const hasAnyModel = Boolean(decisionModel || simpleActionModel);

  if (explicitlyDisabled) {
    return null;
  }
  if (!explicitlyEnabled && !hasAnyModel) {
    return null;
  }
  if (!hasAnyModel) {
    return null;
  }

  const baseUrl = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');

  return {
    baseUrl,
    decisionModel: decisionModel || null,
    simpleActionModel: simpleActionModel || null,
  };
}

async function generateWithOllama({ baseUrl, model, systemPrompt, userPrompt, timeoutMs = OLLAMA_DECISION_TIMEOUT_MS, noThink = false, assistantPrefill = null }) {
  if (!baseUrl || !model) {
    throw new Error('Ollama baseUrl/model missing');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    if (assistantPrefill !== null) {
      messages.push({ role: 'assistant', content: assistantPrefill });
    }
    const body = {
      model,
      messages,
      stream: false,
      think: noThink ? false : undefined,
      keep_alive: -1,
      options: { temperature: 0.3 },
    };
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Ollama chat failed (${response.status})`);
    }

    const json = await response.json();
    const rawText = typeof json?.message?.content === 'string'
      ? json.message.content.trim()
      : '';
    if (!rawText && assistantPrefill === null) {
      throw new Error('Ollama response text is empty');
    }
    // Reconstruct full text by prepending the assistant prefill
    const text = assistantPrefill !== null ? assistantPrefill + rawText : rawText;
    return text;
  } finally {
    clearTimeout(timer);
  }
}


async function isOllamaModelLoaded(baseUrl, model) {
	try {
		const res = await fetch(`${baseUrl}/api/ps`, { signal: AbortSignal.timeout(2000) });
		if (!res.ok) return false;
		const json = await res.json();
		const baseName = model.split(':')[0];
		return (json.models || []).some((m) => {
			const name = m.name || m.model || '';
			return name === model || name.startsWith(baseName + ':');
		});
	} catch {
		return false;
	}
}

async function batchOllamaDecisions({ ollamaConfig, personaIds, messages, personas }) {
	const results = new Map();
	if (!ollamaConfig?.decisionModel || personaIds.length === 0) return results;

	const modelLoaded = await isOllamaModelLoaded(ollamaConfig.baseUrl, ollamaConfig.decisionModel);
	if (!modelLoaded) {
		console.log('[turn-orchestrator] batch decision: model not loaded in ollama, skipping');
		return results;
	}

	const nameMap = {};
	for (const p of personas) nameMap[p.id] = p.displayName || p.name || p.id;

	const tail = (messages || []).slice(-4);
	const history = tail.map((m) => `${nameMap[m.speakerId] || m.speakerId}: ${m.text}`).join('\n');

	const personaList = personaIds.map((id) => nameMap[id] || id).join(', ');
	const idList = personaIds.map((id) => `"${id}"`).join(', ');

	const systemPrompt = [
		'You complete JSON. Values must be exact codes from this list only:',
		'quick_response, raise_risk, raise_upside, agree_brief, disagree_reasoned, ask_general, ask_about_idea, clarify, research, pass, update_notes, think_hard',
		'Do not use any other values.',
	].join('\n');

	const userPrompt = [
		`Chat: ${history || '(empty)'}`,
		'',
		`Complete this JSON with one code per key:`,
		`{${personaIds.map((id) => `"${id}":"CODE"`).join(',')}}`,
	].join('\n');

	const firstId = personaIds[0];
	const assistantPrefill = `{"${firstId}":"`;

	try {
		console.log(`[turn-orchestrator] batch decision: trying ollama for ${personaIds.length} personas`);
		const startMs = Date.now();
		const raw = await generateWithOllama({
			baseUrl: ollamaConfig.baseUrl,
			model: ollamaConfig.decisionModel,
			systemPrompt,
			userPrompt,
			noThink: true,
			timeoutMs: OLLAMA_DECISION_TIMEOUT_MS,
			assistantPrefill,
		});
		console.log(`[turn-orchestrator] batch decision: ollama returned in ${Date.now() - startMs}ms`);

		let parsed = tryParseJson(raw);
		if (!parsed) parsed = tryParseJson(stripCodeFences(raw));
		if (!parsed) {
			const braceStart = raw.indexOf('{');
			const braceEnd = raw.lastIndexOf('}');
			if (braceStart >= 0 && braceEnd > braceStart) {
				parsed = tryParseJson(raw.slice(braceStart, braceEnd + 1));
			}
		}
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			const { parseActionChoice } = await import('./response-parser.js');
			for (const id of personaIds) {
				const val = parsed[id];
				if (typeof val === 'string') {
					const check = parseActionChoice(JSON.stringify({ actionType: val }));
					if (check.success) {
						results.set(id, check.actionType);
					}
				}
			}
			console.log(`[turn-orchestrator] batch decision: resolved ${results.size}/${personaIds.length} via ollama`);
		} else {
			console.warn('[turn-orchestrator] batch decision: ollama returned non-object; all fall back to claude');
		}
	} catch (err) {
		console.warn(`[turn-orchestrator] batch decision: ollama error: ${err.message}; all fall back to claude`);
	}

	return results;
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stripCodeFences(text) {
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch) return fenceMatch[1];
  return text;
}

function extractEnvelopeResultText(stdout) {
  const parsed = tryParseJson((stdout || '').trim());
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.is_error === true) return null;
  if (typeof parsed.result !== 'string') return null;
  return stripCodeFences(parsed.result.trim());
}

function extractCacheUsage(stdout) {
  const parsed = tryParseJson((stdout || '').trim());
  const usage = parsed?.usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  return {
    inputTokens: usage.input_tokens ?? null,
    cacheCreateTokens: usage.cache_creation_input_tokens ?? null,
    cacheReadTokens: usage.cache_read_input_tokens ?? null,
  };
}

function normalizeConversationSummary(value) {
  if (!value || typeof value !== 'object') {
    return { content: '', coveredMessageCount: 0, updatedAt: null };
  }
  return {
    content: typeof value.content === 'string' ? value.content : '',
    coveredMessageCount: Number.isInteger(value.coveredMessageCount) ? value.coveredMessageCount : 0,
    updatedAt: value.updatedAt || null,
  };
}

function buildSummaryPrompt(previousSummary, olderMessages, personas) {
  const nameMap = {};
  for (const persona of personas) {
    nameMap[persona.id] = persona.displayName || persona.name || persona.id;
  }

  const lines = olderMessages.map((msg) => {
    const speaker = nameMap[msg.speakerId] || msg.speakerId;
    return `${speaker}: ${msg.text}`;
  });

  const parts = [];
  if (previousSummary) {
    parts.push('## Existing Summary');
    parts.push(previousSummary);
  }
  parts.push('## Older Messages To Cover');
  parts.push(lines.join('\n'));
  parts.push('## Output Requirements');
  parts.push('- Keep key decisions, constraints, action items, and unresolved questions.');
  parts.push('- Remove repetition and examples that are no longer relevant.');
  parts.push(`- Keep under ${SUMMARY_MAX_CHARS} characters.`);
  parts.push('- Output plain text only.');
  return parts.join('\n\n');
}

/**
 * Run a full turn (round) of persona responses.
 *
 * @param {Object} params
 * @param {string} params.sessionId - Session identifier
 * @param {Object} [params.session={}] - Session metadata (title, startedAt, topic) to preserve on disk writes
 * @param {Array} params.messages - Current session messages (mutable — new messages appended)
 * @param {string} params.notes - Current session notes content
 * @param {Array} params.attachedFiles - List of attached filenames
 * @param {Array} params.personas - Full persona roster from session JSON
 * @param {Object} [params.contextSummary] - Rolling summary for older chat context
 * @param {string[]} [params.runPersonaIds] - Optional subset of AI persona IDs to run this round
 * @param {string} [params.model='sonnet'] - Model to use for claude -p calls
 * @param {Function} params.onEvent - Callback for streaming events
 * @param {Function} [params.execCommand] - Injected execFile (default: child_process.execFile)
 * @param {Function} [params.buildPrompt] - Injected prompt builder
 * @param {Function} [params.buildActionChoicePrompt] - Injected action-choice prompt builder
 * @param {Object} [params.persistence] - Injected persistence module
 * @param {string} [params.basePath] - Base path for file operations
 * @returns {Promise<Object>} Summary of the turn
 */
export async function runTurn({
  sessionId,
  session = {},
  turnCounter = null,
  messages = [],
  notes = '',
  attachedFiles = [],
  personas = [],
  contextSummary,
  runPersonaIds,
  roundNumber = 1,
  totalRounds = 1,
  model,
  onEvent = () => {},
  execCommand = realExecFile,
  buildPrompt = realBuildPrompt,
  buildActionChoicePrompt = realBuildActionChoicePrompt,
  persistence = realPersistence,
  basePath,
}) {
  const effectiveModel = model || DEFAULT_MODEL;
  const effectiveBasePath = basePath || PROJECT_ROOT;
  const personaCallCwd = path.join(effectiveBasePath, 'chats', sessionId);
  const ollamaConfig = getOllamaConfig();
  if (ollamaConfig) {
    console.log(
      `[turn-orchestrator] routing: ollama enabled decision=${ollamaConfig.decisionModel || 'off'} simple=${ollamaConfig.simpleActionModel || 'off'} baseUrl=${ollamaConfig.baseUrl}`
    );
  } else {
    console.log('[turn-orchestrator] routing: ollama disabled (using claude code)');
  }
  const defaultDecisionProvider = ollamaConfig?.decisionModel
    ? PROVIDER_OLLAMA
    : PROVIDER_CLAUDE_CODE;

  // Filter to AI personas only (skip human)
  const runSet = Array.isArray(runPersonaIds) && runPersonaIds.length > 0
    ? new Set(runPersonaIds)
    : null;
  const aiPersonas = personas.filter((p) => {
    if (p.role !== 'ai-persona') return false;
    if (!runSet) return true;
    return runSet.has(p.id);
  });

  // Ensure session directory exists
  try {
    await persistence.ensureSessionDir(sessionId, effectiveBasePath);
  } catch (err) {
    // Log but don't abort — directory may already exist
    console.error(`[turn-orchestrator] Failed to ensure session dir: ${err.message}`);
  }

  // Determine persona ordering
  const orderedPersonas = determinePersonaOrder(aiPersonas, messages, personas);
  const aiIds = new Set(aiPersonas.map((p) => p.id));

  // Track what happened this turn for the summary
  const summary = {
    personasProcessed: 0,
    personasSucceeded: 0,
    personasFailed: 0,
    messagesAdded: 0,
    monologueEntriesAdded: 0,
    notesUpdated: false,
    updatedNotes: '',
    contextSummary: null,
    round2RequestedPersonaIds: [],
    round2RequestReasons: {},
  };

  async function persistPersonaStatus(personaId, personaName, status) {
    if (typeof persistence.writePersonaStatus !== 'function') {
      return;
    }
    try {
      await persistence.writePersonaStatus(
        sessionId,
        personaId,
        {
          personaName,
          ...status,
          updatedAt: new Date().toISOString(),
        },
        effectiveBasePath
      );
    } catch (err) {
      console.error(`[turn-orchestrator] Failed to write status for ${personaId}: ${err.message}`);
    }
  }

  // Mutable notes — we update this as noteUpdates come in
  let currentNotes = notes || '';
  let workingSummary = normalizeConversationSummary(contextSummary);

  // Load persisted summary if caller did not provide one
  if (!contextSummary && typeof persistence.readSessionChat === 'function') {
    try {
      const existingSession = await persistence.readSessionChat(sessionId, effectiveBasePath);
      if (existingSession?.conversationSummary) {
        workingSummary = normalizeConversationSummary(existingSession.conversationSummary);
      }
    } catch (err) {
      console.error(`[turn-orchestrator] Failed to read session summary for ${sessionId}: ${err.message}`);
    }
  }

  // Periodically summarize older messages and keep only the recent tail in prompts.
  const olderMessageCount = Math.max(0, messages.length - SUMMARY_TAIL_COUNT);
  const needsSummaryRefresh = olderMessageCount >= SUMMARY_MIN_MESSAGES
    && (olderMessageCount - workingSummary.coveredMessageCount) >= SUMMARY_REFRESH_INTERVAL;

  if (needsSummaryRefresh) {
    try {
      const olderMessages = messages.slice(0, messages.length - SUMMARY_TAIL_COUNT);
      const summaryPrompt = buildSummaryPrompt(workingSummary.content, olderMessages, personas);
      const summaryArgs = buildSummaryArgs(summaryPrompt);
      const cleanEnv = { ...process.env };
      delete cleanEnv.CLAUDECODE;
      const summaryOptions = {
        cwd: personaCallCwd,
        timeout: PERSONA_TIMEOUT_MS,
        maxBuffer: 5 * 1024 * 1024,
        env: cleanEnv,
      };
      const startMs = Date.now();
      const { stdout } = await execPromise(execCommand, 'claude', summaryArgs, summaryOptions);
      const elapsedMs = Date.now() - startMs;
      const summaryText = extractEnvelopeResultText(stdout);
      if (summaryText && summaryText.trim().length > 0) {
        workingSummary = {
          content: summaryText.trim().slice(0, SUMMARY_MAX_CHARS),
          coveredMessageCount: olderMessages.length,
          updatedAt: new Date().toISOString(),
        };
        console.log(`[turn-orchestrator] Updated conversation summary in ${elapsedMs}ms (covered=${olderMessages.length})`);
      } else {
        console.warn('[turn-orchestrator] Summary refresh returned empty output; keeping previous summary');
      }
    } catch (err) {
      console.error(`[turn-orchestrator] Summary refresh failed: ${err.message}`);
    }
  }

  const roundMessages = messages.slice(-SUMMARY_TAIL_COUNT);
  const roundNotes = currentNotes;
  const intent = classifyIntent(roundMessages, personas);
  const maxSpeakSentences = MAX_SPEAK_SENTENCES[intent];
  const roundOrderRank = new Map(orderedPersonas.map((p, idx) => [p.id, idx]));
  const recentAiTexts = roundMessages
    .filter((m) => aiIds.has(m.speakerId))
    .map((m) => m.text)
    .filter((t) => typeof t === 'string' && t.trim().length > 0);

  // Emit all thinking events first so the UI shows all personas working.
  for (const persona of orderedPersonas) {
    const { id: personaId, name: personaName, displayName } = persona;
    const resolvedPersonaName = displayName || personaName;
    summary.personasProcessed++;
    onEvent({ type: 'thinking', personaId, personaName: resolvedPersonaName });
    onEvent({
      type: 'status',
      personaId,
      personaName: resolvedPersonaName,
      phase: 'deciding_action',
      action: null,
      actionType: null,
      provider: defaultDecisionProvider,
    });
    await persistPersonaStatus(personaId, resolvedPersonaName, {
      phase: 'deciding_action',
      action: null,
      actionType: null,
      provider: defaultDecisionProvider,
    });
  }

  // Single batch Ollama call to decide actions for all AI personas at once.
  const aiPersonaIds = orderedPersonas.map((p) => p.id);
  const batchedDecisions = await batchOllamaDecisions({
    ollamaConfig,
    personaIds: aiPersonaIds,
    messages: roundMessages,
    personas,
  });

  function isRetryableParseError(errorText) {
    return typeof errorText === 'string'
      && errorText.includes('Claude envelope result field is empty');
  }

  function buildLastChancePrompt(historyMessages, personaId) {
    const humanIds = new Set(personas.filter(p => p.role === 'human').map(p => p.id));
    const lastHumanMessage = [...historyMessages].reverse().find((m) => humanIds.has(m.speakerId));
    const latestText = lastHumanMessage?.text?.trim() || 'No recent user message provided.';
    return [
      'CRITICAL: The prior attempt returned an empty result envelope.',
      'Return exactly ONE valid JSON object and nothing else.',
      `You are responding as persona: ${personaId}.`,
      '',
      '## Latest User Message',
      latestText,
      '',
      'Choose one action and return only JSON:',
      '{"actionType":"quick_response","action":"speak","text":"..."} OR {"actionType":"think_hard","action":"think","text":"..."} OR {"actionType":"research","action":"research","query":"...","findings":"..."} OR {"actionType":"pass","action":"pass"} OR {"actionType":"update_notes","action":"update_notes","noteUpdate":"..."}',
    ].join('\n');
  }

  async function processPersona(persona, { promptMessages, priorWaveContext = null }) {
    const { id: personaId } = persona;
    const personaName = persona.displayName || persona.name || personaId;

    try {
      // 1. Read this persona's monologue
      let monologue = [];
      try {
        monologue = await persistence.readMonologue(sessionId, personaId, effectiveBasePath);
      } catch (err) {
        console.error(`[turn-orchestrator] Failed to read monologue for ${personaId}: ${err.message}`);
      }

      const systemPromptPath = path.join(effectiveBasePath, 'personas', personaId, 'system.md');
      const cleanEnv = { ...process.env };
      delete cleanEnv.CLAUDECODE;
      const execOptions = {
        cwd: personaCallCwd,
        timeout: PERSONA_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        env: cleanEnv,
      };

      // --- Phase 1: Action choice ---
      // Use the pre-computed batch decision if available; fall back to Claude.
      let chosenActionType = batchedDecisions.get(personaId) || null;
      let decisionProvider = chosenActionType ? PROVIDER_OLLAMA : PROVIDER_CLAUDE_CODE;

      if (chosenActionType) {
        console.log(`[turn-orchestrator] ${personaId} using batched ollama decision: ${chosenActionType}`);
      } else {
        try {
          const choicePrompt = await buildActionChoicePrompt({
            personaId,
            messages: promptMessages,
            monologue,
            personas,
            conversationSummary: workingSummary.content,
            notes: roundNotes,
          });
          const { parseActionChoice } = await import('./response-parser.js');

          let choiceError = null;
          for (let attempt = 1; attempt <= 2; attempt++) {
            const choicePromptText = attempt === 1
              ? choicePrompt.userPrompt
              : `${choicePrompt.userPrompt}\n\nCRITICAL RETRY INSTRUCTION: Return exactly one JSON object in this shape: {"actionType":"..."} and nothing else.`;
            const choiceArgs = buildClaudeArgs(
              choicePromptText,
              choicePrompt.systemPrompt,
              DECISION_MODEL,
              '',
            );

            console.log(`[turn-orchestrator] ${personaId} decision phase: spawning claude attempt ${attempt} (model=${DECISION_MODEL})`);
            const choiceStart = Date.now();
            const { stdout: choiceStdout } = await execPromise(execCommand, 'claude', choiceArgs, execOptions);
            console.log(`[turn-orchestrator] ${personaId} decision phase returned in ${Date.now() - choiceStart}ms (attempt ${attempt})`);
            console.log(`[turn-orchestrator] ${personaId} decision raw (first 300 chars): ${(choiceStdout || '').slice(0, 300)}`);

            const choiceResult = parseActionChoice(choiceStdout);
            if (choiceResult.success) {
              chosenActionType = choiceResult.actionType;
              decisionProvider = PROVIDER_CLAUDE_CODE;
              choiceError = null;
              console.log(`[turn-orchestrator] ${personaId} chose actionType: ${chosenActionType}`);
              break;
            }

            choiceError = choiceResult.error;
            if (attempt < 2 && isRetryableParseError(choiceResult.error)) {
              console.warn(`[turn-orchestrator] ${personaId} decision parse empty envelope; retrying once`);
              continue;
            }
            break;
          }

          if (!chosenActionType && choiceError) {
            console.warn(`[turn-orchestrator] ${personaId} decision parse failed: ${choiceError}, proceeding without constraint`);
          }
        } catch (choiceErr) {
          console.warn(`[turn-orchestrator] ${personaId} decision phase error: ${choiceErr.message}, proceeding without constraint`);
        }
      }

      if (!chosenActionType) {
        chosenActionType = DEFAULT_DECIDED_ACTION_TYPE;
        console.warn(
          `[turn-orchestrator] ${personaId} decision fallback applied: ${chosenActionType}`
        );
      }

      // Update status with the chosen action type
      onEvent({
        type: 'status',
        personaId,
        personaName,
        phase: 'executing_action',
        action: null,
        actionType: chosenActionType,
        provider: PROVIDER_CLAUDE_CODE,
      });
      await persistPersonaStatus(personaId, personaName, {
        phase: 'executing_action',
        action: null,
        actionType: chosenActionType,
        provider: PROVIDER_CLAUDE_CODE,
      });

      // "pass" is a non-action: do not perform an execution call.
      if (chosenActionType === 'pass') {
        onEvent({
          type: 'message',
          personaId,
          message: null,
          action: 'pass',
          actionType: 'pass',
          provider: PROVIDER_CLAUDE_CODE,
        });
        summary.personasSucceeded++;
        await persistPersonaStatus(personaId, personaName, {
          phase: 'completed',
          action: 'pass',
          actionType: 'pass',
          provider: PROVIDER_CLAUDE_CODE,
        });
        return { spoke: false };
      }

      // --- Phase 2: Execute the chosen action (full prompt, tools) ---
      const { systemPrompt, userPrompt } = await buildPrompt({
        personaId,
        systemPromptPath,
        messages: promptMessages,
        monologue,
        notes: roundNotes,
        attachedFiles,
        personas,
        conversationSummary: workingSummary.content,
        roundNumber,
        totalRounds,
        priorWaveContext,
        chosenActionType,
      });

      const { parseResponse } = await import('./response-parser.js');
      let parsed = null;
      let finalError = null;
      let executionProvider = PROVIDER_CLAUDE_CODE;

      if (!parsed?.success) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          const attemptPrompt = attempt === 1
            ? userPrompt
            : attempt === 2
              ? `${userPrompt}\n\nCRITICAL RETRY INSTRUCTION: Return exactly one valid JSON object with action/text fields as required. Do not return an empty result.`
              : buildLastChancePrompt(promptMessages, personaId);
          const attemptTools = attempt < 3 ? 'Read,WebSearch,WebFetch,Glob,Grep' : '';
          const args = buildClaudeArgs(attemptPrompt, systemPrompt, effectiveModel, attemptTools);

          console.log(`[turn-orchestrator] Spawning claude for ${personaId} (attempt ${attempt}): system=${systemPrompt.length} chars, user=${attemptPrompt.length} chars, model=${effectiveModel}`);
          const startMs = Date.now();
          const { stdout } = await execPromise(execCommand, 'claude', args, execOptions);
          const elapsedMs = Date.now() - startMs;
          console.log(`[turn-orchestrator] ${personaId} claude returned in ${elapsedMs}ms, stdout length=${stdout?.length || 0} (attempt ${attempt})`);
          console.log(`[turn-orchestrator] ${personaId} raw stdout (first 500 chars): ${(stdout || '').slice(0, 500)}`);
          const cacheUsage = extractCacheUsage(stdout);
          if (cacheUsage) {
            console.log(
              `[turn-orchestrator] ${personaId} usage tokens (attempt ${attempt}): input=${cacheUsage.inputTokens}, cache_create=${cacheUsage.cacheCreateTokens}, cache_read=${cacheUsage.cacheReadTokens}`
            );
          }

          parsed = parseResponse(stdout);
          console.log(`[turn-orchestrator] ${personaId} parse result: success=${parsed.success}, action=${parsed.action || 'N/A'}, error=${parsed.error || 'none'} (attempt ${attempt})`);

          if (parsed.success) {
            finalError = null;
            executionProvider = PROVIDER_CLAUDE_CODE;
            break;
          }

          finalError = parsed.error;
          if (attempt < 3 && isRetryableParseError(parsed.error)) {
            const retryLabel = attempt === 1 ? 'retrying once' : 'running last-chance minimal retry';
            console.warn(`[turn-orchestrator] ${personaId} received empty result envelope; ${retryLabel}`);
            continue;
          }
          break;
        }
      }

      if (finalError || !parsed?.success) {
        throw new Error(`Response parsing failed: ${finalError || 'Unknown parse failure'}`);
      }

      // 5. Apply the result based on action type
      const { action, data } = parsed;
      console.log(`[turn-orchestrator] ${personaId} action=${action}, data keys=${Object.keys(data).join(',')}`);
      const timestamp = new Date().toISOString();

      if (data.wantRound2 === true) {
        if (!summary.round2RequestedPersonaIds.includes(personaId)) {
          summary.round2RequestedPersonaIds.push(personaId);
        }
        if (data.round2Reason) {
          summary.round2RequestReasons[personaId] = data.round2Reason;
        }
      }

      if (action === 'speak') {
        const rank = roundOrderRank.get(personaId) ?? 0;
        const personaSentenceCap = resolvePersonaSentenceCap({
					personaId,
					intent,
					roundNumber,
					defaultCap: maxSpeakSentences,
					rank,
				});
				const personaCharCap = resolvePersonaCharCap({ intent, roundNumber });
        const { visible, overflow } = splitSpeakText(data.text, personaSentenceCap, personaCharCap);
        const suppressReason = shouldSuppressSpeak(visible, recentAiTexts, roundNumber);
        if (suppressReason) {
          const heldEntry = {
            timestamp,
            text: `Held speak (${suppressReason}) for later: ${data.text}`,
            type: 'think',
          };
          try {
            await persistence.appendMonologue(sessionId, personaId, heldEntry, effectiveBasePath);
          } catch (err) {
            console.error(`[turn-orchestrator] Failed to write held-speak monologue for ${personaId}: ${err.message}`);
          }
          summary.monologueEntriesAdded++;
          onEvent({
            type: 'message',
            personaId,
            message: { text: heldEntry.text },
            action: 'think',
            actionType: 'think_hard',
            provider: executionProvider,
          });
          summary.personasSucceeded++;
          await persistPersonaStatus(personaId, personaName, {
            phase: 'completed',
            action: 'think',
            actionType: 'think_hard',
            provider: executionProvider,
          });
          return;
        }
        const message = {
          id: generateMessageId(),
          speakerId: personaId,
          timestamp,
          text: visible,
        };
        messages.push(message);
        recentAiTexts.push(visible);
        summary.messagesAdded++;

        onEvent({
          type: 'message',
          personaId,
          message,
          action: 'speak',
          actionType: data.actionType || 'quick_response',
          provider: executionProvider,
        });

        if (data.noteUpdate) {
          currentNotes = currentNotes
            ? `${currentNotes}\n${data.noteUpdate}`
            : data.noteUpdate;
          summary.notesUpdated = true;
          onEvent({ type: 'notes', content: currentNotes });
        }

        if (overflow) {
          const overflowEntry = {
            timestamp,
            text: `Speak overflow queued for later: ${overflow}`,
            type: 'think',
          };
          try {
            await persistence.appendMonologue(sessionId, personaId, overflowEntry, effectiveBasePath);
          } catch (err) {
            console.error(`[turn-orchestrator] Failed to write speak overflow monologue for ${personaId}: ${err.message}`);
          }
          summary.monologueEntriesAdded++;
        }
        summary.personasSucceeded++;
        await persistPersonaStatus(personaId, personaName, {
          phase: 'completed',
          action: 'speak',
          actionType: data.actionType || 'quick_response',
          provider: executionProvider,
        });
        return { spoke: true };
      } else if (action === 'think') {
        const entry = { timestamp, text: data.text, type: 'think' };
        try {
          await persistence.appendMonologue(sessionId, personaId, entry, effectiveBasePath);
        } catch (err) {
          console.error(`[turn-orchestrator] Failed to write monologue for ${personaId}: ${err.message}`);
        }
        summary.monologueEntriesAdded++;

        onEvent({
          type: 'message',
          personaId,
          message: { text: data.text },
          action: 'think',
          actionType: data.actionType || 'think_hard',
          provider: executionProvider,
        });
      } else if (action === 'research') {
        const entryText = `Research: ${data.query}\nFindings: ${data.findings}`;
        const entry = { timestamp, text: entryText, type: 'research' };
        try {
          await persistence.appendMonologue(sessionId, personaId, entry, effectiveBasePath);
        } catch (err) {
          console.error(`[turn-orchestrator] Failed to write monologue for ${personaId}: ${err.message}`);
        }
        summary.monologueEntriesAdded++;

        onEvent({
          type: 'message',
          personaId,
          message: { text: entryText, query: data.query, findings: data.findings },
          action: 'research',
          actionType: data.actionType || 'research',
          provider: executionProvider,
        });
      } else if (action === 'pass') {
        onEvent({
          type: 'message',
          personaId,
          message: null,
          action: 'pass',
          actionType: data.actionType || 'pass',
          provider: executionProvider,
        });
      } else if (action === 'update_notes') {
        currentNotes = currentNotes
          ? `${currentNotes}\n${data.noteUpdate}`
          : data.noteUpdate;
        summary.notesUpdated = true;
        onEvent({ type: 'notes', content: currentNotes });
        onEvent({
          type: 'message',
          personaId,
          message: null,
          action: 'update_notes',
          actionType: data.actionType || 'update_notes',
          provider: executionProvider,
        });
      }

      summary.personasSucceeded++;
      await persistPersonaStatus(personaId, personaName, {
        phase: 'completed',
        action,
        actionType: data?.actionType || null,
        provider: executionProvider,
      });
      return { spoke: false };
    } catch (err) {
      console.error(`[turn-orchestrator] Persona ${personaId} FAILED: ${err.message}`);
      if (err.stderr) console.error(`[turn-orchestrator] ${personaId} stderr: ${err.stderr.slice(0, 500)}`);
      if (err.code) console.error(`[turn-orchestrator] ${personaId} exit code: ${err.code}`);
      summary.personasFailed++;

      onEvent({
        type: 'error',
        personaId,
        error: err.message || 'Unknown error',
      });
      await persistPersonaStatus(personaId, personaName, {
        phase: 'failed',
        action: null,
        actionType: null,
      });
      return { spoke: false };
    }
  }

  async function processBatch(personaBatch, { promptMessages, priorWaveContext = null }) {
    return Promise.all(
      personaBatch.map((persona) => processPersona(persona, { promptMessages, priorWaveContext }))
    );
  }

  const useWaves = roundNumber === 1 && orderedPersonas.length > 2;
  const waveParity = Number.isInteger(turnCounter) ? Math.abs(turnCounter) % 2 : 0;
  const waveOnePersonas = useWaves
    ? orderedPersonas.filter((_, idx) => idx % 2 === waveParity)
    : orderedPersonas;
  const waveTwoPersonas = useWaves
    ? orderedPersonas.filter((_, idx) => idx % 2 !== waveParity)
    : [];

  const waveOneResults = await processBatch(waveOnePersonas, {
    promptMessages: roundMessages,
    priorWaveContext: null,
  });
  const waveOneSpokenCount = waveOneResults.filter((r) => r?.spoke).length;

  if (waveTwoPersonas.length > 0) {
    const waveTwoPromptMessages = messages.slice(-SUMMARY_TAIL_COUNT);
    await processBatch(waveTwoPersonas, {
      promptMessages: waveTwoPromptMessages,
      priorWaveContext: {
        waveNumber: 2,
        spokeCount: waveOneSpokenCount,
      },
    });
  }

  // After all personas complete, write the updated session to disk
  try {
    const sessionData = {
      formatVersion: '1.0',
      session: {
        ...session,
        ...(Number.isInteger(turnCounter) ? { turnCounter } : {}),
        id: sessionId,
        updatedAt: new Date().toISOString(),
      },
      personas,
      notes: { content: currentNotes },
      messages,
      conversationSummary: workingSummary,
    };
    await persistence.writeSessionChat(sessionId, sessionData, effectiveBasePath);
  } catch (err) {
    console.error(`[turn-orchestrator] Failed to write session: ${err.message}`);
    onEvent({ type: 'error', personaId: null, error: `Session write failed: ${err.message}` });
  }

  // Emit done event
  onEvent({ type: 'done' });

  summary.updatedNotes = currentNotes;
  summary.contextSummary = workingSummary;
  return summary;
}

function splitSentences(text) {
  return String(text || '')
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
}

function getLastHumanMessageText(messages, personas) {
  const humanIds = new Set((personas || []).filter((p) => p.role === 'human').map((p) => p.id));
  const lastHumanMessage = [...(messages || [])].reverse().find((m) => humanIds.has(m.speakerId));
  return String(lastHumanMessage?.text || '').trim();
}

export function classifyIntent(messages, personas) {
  const text = getLastHumanMessageText(messages, personas);
  if (!text) return 'simple';

  const questionCount = (text.match(/\?/g) || []).length;
  const sentenceCount = splitSentences(text).length;
  const hasList = text.includes('\n- ') || text.includes('\n1.');

  const complexitySignals = [
    'tradeoff', 'trade-off', 'compare', 'analysis', 'architecture',
    'refactor', 'debug', 'strategy', 'plan', 'optimize', 'migration',
  ];
  const lowered = text.toLowerCase();
  const signalCount = complexitySignals.reduce(
    (count, signal) => count + (lowered.includes(signal) ? 1 : 0),
    0
  );

  const isComplex = (
    text.length >= 180
    || questionCount >= 2
    || sentenceCount >= 3
    || hasList
    || signalCount >= 2
  );
  if (isComplex) return 'complex';

  const isMedium = (
    (text.length >= 80 && text.length <= 179)
    || (questionCount === 1 && sentenceCount >= 2)
    || signalCount === 1
  );
  return isMedium ? 'medium' : 'simple';
}

function isComplexIntent(messages, personas) {
  return classifyIntent(messages, personas) === 'complex';
}

function splitSpeakText(
	text,
	maxSentences = MAX_SPEAK_SENTENCES.simple,
	maxChars = MAX_SPEAK_CHARS
) {
  if (typeof text !== 'string') return { visible: '', overflow: '' };
  let working = text.trim();
  const overflowParts = [];

  const sentences = splitSentences(working);
  if (maxSentences > 0 && sentences.length > maxSentences) {
    working = sentences.slice(0, maxSentences).join(' ').trim();
    const sentenceOverflow = sentences.slice(maxSentences).join(' ').trim();
    if (sentenceOverflow) overflowParts.push(sentenceOverflow);
  }

  if (working.length > maxChars) {
    const candidate = working.slice(0, maxChars);
    const lastBoundary = Math.max(
      candidate.lastIndexOf('. '),
      candidate.lastIndexOf('! '),
      candidate.lastIndexOf('? ')
    );
    const cutAt = lastBoundary > Math.floor(maxChars * 0.7)
      ? lastBoundary + 1
      : maxChars;
    const charOverflow = working.slice(cutAt).trim();
    working = working.slice(0, cutAt).trim();
    if (charOverflow) overflowParts.unshift(charOverflow);
  }

  return {
    visible: working,
    overflow: overflowParts.join(' ').trim(),
  };
}

function resolvePersonaSentenceCap({ personaId, intent, roundNumber, defaultCap, rank }) {
	if (intent !== 'simple') return defaultCap;
	const personaCap = SIMPLE_SENTENCE_CAP_BY_PERSONA[personaId];
	if (typeof personaCap === 'number') {
		if (roundNumber > 1) return Math.max(1, personaCap - 1);
		return personaCap;
	}
	// Preserve slight ordering variance for unknown personas.
	return Math.max(1, defaultCap - Math.min(rank, 1));
}

function resolvePersonaCharCap({ intent, roundNumber }) {
  const intentCap = MAX_SPEAK_CHARS_BY_INTENT[intent] ?? MAX_SPEAK_CHARS;
	if (roundNumber > 1) return Math.min(intentCap, 320);
	return intentCap;
}

function normalizeForSimilarity(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function jaccardSimilarity(aText, bText) {
  const a = new Set(normalizeForSimilarity(aText));
  const b = new Set(normalizeForSimilarity(bText));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function shouldSuppressSpeak(text, recentAiTexts, roundNumber) {
  const candidate = String(text || '').trim();
  if (!candidate) return 'empty-speak';

  if (recentAiTexts.length > 0 && isGreetingLike(candidate)) return 'greeting-pile-on';

  const normalizedCandidate = normalizeForSimilarity(candidate);
  for (const prevText of recentAiTexts) {
    const prevTokens = normalizeForSimilarity(prevText);
    if (sharesLeadingPhrase(normalizedCandidate, prevTokens)) {
      return 'same-opening-phrase';
    }
  }

  let maxSimilarity = 0;
  for (const prevText of recentAiTexts) {
    const score = jaccardSimilarity(candidate, prevText);
    if (score > maxSimilarity) maxSimilarity = score;
  }

  if (maxSimilarity >= 0.82) return 'near-duplicate';
  if (roundNumber > 1 && maxSimilarity >= 0.62) return 'round-two-repetition';
  return null;
}

function isGreetingLike(text) {
	const t = String(text || '').trim().toLowerCase();
	if (!t) return false;
	return /^(hi|hey|hello|yo|good (morning|afternoon|evening)|what's up|thanks)/i.test(t);
}

function sharesLeadingPhrase(aTokens, bTokens) {
	if (aTokens.length < 4 || bTokens.length < 4) return false;
	const count = Math.min(6, aTokens.length, bTokens.length);
	for (let i = 0; i < count; i++) {
		if (aTokens[i] !== bTokens[i]) return false;
	}
	return true;
}
