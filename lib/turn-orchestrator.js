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
import { buildPrompt as realBuildPrompt } from './prompt-builder.js';
import * as realPersistence from './persistence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Default timeout per persona: 120 seconds
const PERSONA_TIMEOUT_MS = 120000;

// Default model
const DEFAULT_MODEL = 'haiku';
const SUMMARY_MODEL = 'haiku';
const SUMMARY_TAIL_COUNT = 16;
const SUMMARY_MIN_MESSAGES = 24;
const SUMMARY_REFRESH_INTERVAL = 8;
const SUMMARY_MAX_CHARS = 4000;
const MAX_SPEAK_CHARS = 520;
const SIMPLE_INTENT_MAX_SPEAK_SENTENCES = 2;
const COMPLEX_INTENT_MAX_SPEAK_SENTENCES = 4;
const SIMPLE_INTENT_ROUND1_MAX_SPEAKERS = 2;

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
 * @param {Object} [params.persistence] - Injected persistence module
 * @param {string} [params.basePath] - Base path for file operations
 * @returns {Promise<Object>} Summary of the turn
 */
export async function runTurn({
  sessionId,
  session = {},
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
  persistence = realPersistence,
  basePath,
}) {
  const effectiveModel = model || DEFAULT_MODEL;
  const effectiveBasePath = basePath || PROJECT_ROOT;

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

  // Snapshot input state once per round so personas can run in parallel.
  // This trades intra-round dependency (later personas seeing earlier ones)
  // for much lower wall-clock latency.
  const roundMessages = messages.slice(-SUMMARY_TAIL_COUNT);
  const roundNotes = currentNotes;
  const simpleIntent = !isComplexIntent(roundMessages, personas);
  const maxSpeakSentences = !simpleIntent
    ? COMPLEX_INTENT_MAX_SPEAK_SENTENCES
    : SIMPLE_INTENT_MAX_SPEAK_SENTENCES;
  const roundOrderRank = new Map(orderedPersonas.map((p, idx) => [p.id, idx]));
  const enforcedSpeakIds = (
    totalRounds > 1
    && roundNumber === 1
    && simpleIntent
  )
    ? new Set(orderedPersonas.slice(0, SIMPLE_INTENT_ROUND1_MAX_SPEAKERS).map((p) => p.id))
    : null;
  const recentAiTexts = roundMessages
    .filter((m) => aiIds.has(m.speakerId))
    .map((m) => m.text)
    .filter((t) => typeof t === 'string' && t.trim().length > 0);

  // Emit all thinking events first so the UI shows all personas working.
  for (const persona of orderedPersonas) {
    const { id: personaId, name: personaName, displayName } = persona;
    summary.personasProcessed++;
    onEvent({ type: 'thinking', personaId, personaName: displayName || personaName });
  }

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
      '{"action":"speak","text":"..."} OR {"action":"think","text":"..."} OR {"action":"research","query":"...","findings":"..."}',
    ].join('\n');
  }

  // Process personas concurrently.
  await Promise.all(orderedPersonas.map(async (persona) => {
    const { id: personaId } = persona;

    try {
      // 1. Read this persona's monologue
      let monologue = [];
      try {
        monologue = await persistence.readMonologue(sessionId, personaId, effectiveBasePath);
      } catch (err) {
        console.error(`[turn-orchestrator] Failed to read monologue for ${personaId}: ${err.message}`);
      }

      // 2. Build the prompt (system prompt separate from user message)
      const systemPromptPath = path.join(effectiveBasePath, 'personas', personaId, 'system.md');
      const { systemPrompt, userPrompt } = await buildPrompt({
        personaId,
        systemPromptPath,
        messages: roundMessages,
        monologue,
        notes: roundNotes,
        attachedFiles,
        personas,
        conversationSummary: workingSummary.content,
        roundNumber,
        totalRounds,
      });

      // 3. Spawn claude -p with the assembled args
      // Retry once if Claude returns a success envelope with empty `result`.
      const cleanEnv = { ...process.env };
      delete cleanEnv.CLAUDECODE;
      const execOptions = {
        timeout: PERSONA_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024, // 10MB max buffer
        env: cleanEnv,
      };
      const { parseResponse } = await import('./response-parser.js');
      let parsed = null;
      let finalError = null;

      for (let attempt = 1; attempt <= 3; attempt++) {
        const isRetryAttempt = attempt > 1;
        const attemptPrompt = attempt === 1
          ? userPrompt
          : attempt === 2
            ? `${userPrompt}\n\nCRITICAL RETRY INSTRUCTION: Return exactly one valid JSON object with action/text fields as required. Do not return an empty result.`
            : buildLastChancePrompt(roundMessages, personaId);
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
        if (enforcedSpeakIds && !enforcedSpeakIds.has(personaId)) {
          const heldEntry = {
            timestamp,
            text: `Held speak (simple-turn-speaker-limit) for later: ${data.text}`,
            type: 'think',
          };
          try {
            await persistence.appendMonologue(sessionId, personaId, heldEntry, effectiveBasePath);
          } catch (err) {
            console.error(`[turn-orchestrator] Failed to write held-speak monologue for ${personaId}: ${err.message}`);
          }
          summary.monologueEntriesAdded++;
          onEvent({ type: 'message', personaId, message: { text: heldEntry.text }, action: 'think' });
          summary.personasSucceeded++;
          return;
        }

        const rank = roundOrderRank.get(personaId) ?? 0;
        const personaSentenceCap = simpleIntent
          ? Math.max(1, maxSpeakSentences - Math.min(rank, 1))
          : maxSpeakSentences;
        const { visible, overflow } = splitSpeakText(data.text, personaSentenceCap);
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
          onEvent({ type: 'message', personaId, message: { text: heldEntry.text }, action: 'think' });
          summary.personasSucceeded++;
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

        onEvent({ type: 'message', personaId, message, action: 'speak' });

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
      } else if (action === 'think') {
        const entry = { timestamp, text: data.text, type: 'think' };
        try {
          await persistence.appendMonologue(sessionId, personaId, entry, effectiveBasePath);
        } catch (err) {
          console.error(`[turn-orchestrator] Failed to write monologue for ${personaId}: ${err.message}`);
        }
        summary.monologueEntriesAdded++;

        onEvent({ type: 'message', personaId, message: { text: data.text }, action: 'think' });
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
        });
      }

      summary.personasSucceeded++;
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
    }
  }));

  // After all personas complete, write the updated session to disk
  try {
    const sessionData = {
      formatVersion: '1.0',
      session: {
        ...session,
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

function isComplexIntent(messages, personas) {
  const humanIds = new Set((personas || []).filter((p) => p.role === 'human').map((p) => p.id));
  const lastHumanMessage = [...(messages || [])].reverse().find((m) => humanIds.has(m.speakerId));
  const text = String(lastHumanMessage?.text || '').trim();
  if (!text) return false;

  if (text.length >= 180) return true;
  if ((text.match(/\?/g) || []).length >= 2) return true;
  if (splitSentences(text).length >= 3) return true;
  if (text.includes('\n- ') || text.includes('\n1.')) return true;

  const complexitySignals = [
    'tradeoff', 'trade-off', 'compare', 'analysis', 'architecture',
    'refactor', 'debug', 'strategy', 'plan', 'optimize', 'migration',
  ];
  const lowered = text.toLowerCase();
  return complexitySignals.some((signal) => lowered.includes(signal));
}

function splitSpeakText(text, maxSentences = SIMPLE_INTENT_MAX_SPEAK_SENTENCES) {
  if (typeof text !== 'string') return { visible: '', overflow: '' };
  let working = text.trim();
  const overflowParts = [];

  const sentences = splitSentences(working);
  if (maxSentences > 0 && sentences.length > maxSentences) {
    working = sentences.slice(0, maxSentences).join(' ').trim();
    const sentenceOverflow = sentences.slice(maxSentences).join(' ').trim();
    if (sentenceOverflow) overflowParts.push(sentenceOverflow);
  }

  if (working.length > MAX_SPEAK_CHARS) {
    const candidate = working.slice(0, MAX_SPEAK_CHARS);
    const lastBoundary = Math.max(
      candidate.lastIndexOf('. '),
      candidate.lastIndexOf('! '),
      candidate.lastIndexOf('? ')
    );
    const cutAt = lastBoundary > Math.floor(MAX_SPEAK_CHARS * 0.7)
      ? lastBoundary + 1
      : MAX_SPEAK_CHARS;
    const charOverflow = working.slice(cutAt).trim();
    working = working.slice(0, cutAt).trim();
    if (charOverflow) overflowParts.unshift(charOverflow);
  }

  return {
    visible: working,
    overflow: overflowParts.join(' ').trim(),
  };
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

  let maxSimilarity = 0;
  for (const prevText of recentAiTexts) {
    const score = jaccardSimilarity(candidate, prevText);
    if (score > maxSimilarity) maxSimilarity = score;
  }

  if (maxSimilarity >= 0.82) return 'near-duplicate';
  if (roundNumber > 1 && maxSimilarity >= 0.62) return 'round-two-repetition';
  return null;
}
