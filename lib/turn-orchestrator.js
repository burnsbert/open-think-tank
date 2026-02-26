/**
 * lib/turn-orchestrator.js
 *
 * Core engine for running a full turn (round) of persona responses.
 *
 * Orchestrates:
 *   (a) Persona ordering — name-mention prioritization + randomization
 *   (b) Sequential persona processing — build prompt, spawn claude -p,
 *       parse response, apply result (speak/think/research), write monologue
 *   (c) Post-round persistence — write updated session-chat.json to disk
 *
 * Designed for testability via dependency injection:
 *   - execCommand: replaces child_process.execFile
 *   - buildPrompt: replaces lib/prompt-builder.js
 *   - persistence: replaces lib/persistence.js
 *   - onEvent: callback for SSE streaming
 *
 * Error handling: if a persona fails (CLI error, timeout, parse failure),
 * that persona's turn is skipped and the round continues. The round is
 * never aborted due to a single persona failure.
 */

import { execFile as realExecFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildPrompt as realBuildPrompt } from './prompt-builder.js';
import * as realPersistence from './persistence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Default timeout per persona: 120 seconds
const PERSONA_TIMEOUT_MS = 120000;

// Default model
const DEFAULT_MODEL = 'sonnet';

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
  return new Promise((resolve, reject) => {
    execCommand(command, args, options, (error, stdout, stderr) => {
      if (error) {
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
function buildClaudeArgs(prompt, model) {
  return [
    '-p', prompt,
    '--output-format', 'json',
    '--model', model,
    '--allowedTools', 'Read,WebSearch',
    '--permission-mode', 'bypassPermissions',
  ];
}

/**
 * Run a full turn (round) of persona responses.
 *
 * @param {Object} params
 * @param {string} params.sessionId - Session identifier
 * @param {Array} params.messages - Current session messages (mutable — new messages appended)
 * @param {string} params.notes - Current session notes content
 * @param {Array} params.attachedFiles - List of attached filenames
 * @param {Array} params.personas - Full persona roster from session JSON
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
  messages = [],
  notes = '',
  attachedFiles = [],
  personas = [],
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
  const aiPersonas = personas.filter(p => p.role === 'ai-persona');

  // Ensure session directory exists
  try {
    await persistence.ensureSessionDir(sessionId, effectiveBasePath);
  } catch (err) {
    // Log but don't abort — directory may already exist
    console.error(`[turn-orchestrator] Failed to ensure session dir: ${err.message}`);
  }

  // Determine persona ordering
  const orderedPersonas = determinePersonaOrder(aiPersonas, messages, personas);

  // Track what happened this turn for the summary
  const summary = {
    personasProcessed: 0,
    personasSucceeded: 0,
    personasFailed: 0,
    messagesAdded: 0,
    monologueEntriesAdded: 0,
    notesUpdated: false,
  };

  // Mutable notes — we update this as noteUpdates come in
  let currentNotes = notes || '';

  // Process each persona sequentially
  for (const persona of orderedPersonas) {
    const { id: personaId, name: personaName, displayName } = persona;
    summary.personasProcessed++;

    // Emit thinking event
    onEvent({ type: 'thinking', personaId, personaName: displayName || personaName });

    try {
      // 1. Read this persona's monologue
      let monologue = [];
      try {
        monologue = await persistence.readMonologue(sessionId, personaId, effectiveBasePath);
      } catch (err) {
        console.error(`[turn-orchestrator] Failed to read monologue for ${personaId}: ${err.message}`);
        // Continue with empty monologue
      }

      // 2. Build the prompt
      const systemPromptPath = path.join(effectiveBasePath, 'personas', personaId, 'system.md');
      const prompt = await buildPrompt({
        personaId,
        systemPromptPath,
        messages,
        monologue,
        notes: currentNotes,
        attachedFiles,
        personas,
      });

      // 3. Spawn claude -p with the assembled args
      const args = buildClaudeArgs(prompt, effectiveModel);
      const execOptions = {
        timeout: PERSONA_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024, // 10MB max buffer
      };

      const { stdout } = await execPromise(execCommand, 'claude', args, execOptions);

      // 4. Parse the response
      // Import parseResponse dynamically to avoid circular dependency issues,
      // but since this is a static import at module level we use a local import.
      const { parseResponse } = await import('./response-parser.js');
      const parsed = parseResponse(stdout);

      if (!parsed.success) {
        throw new Error(`Response parsing failed: ${parsed.error}`);
      }

      // 5. Apply the result based on action type
      const { action, data } = parsed;
      const timestamp = new Date().toISOString();

      if (action === 'speak') {
        // Append message to the messages array so later personas see it
        const message = {
          id: generateMessageId(),
          speakerId: personaId,
          timestamp,
          text: data.text,
        };
        messages.push(message);
        summary.messagesAdded++;

        // Emit message event with the full message object
        onEvent({ type: 'message', personaId, message, action: 'speak' });

        // Handle noteUpdate if present
        if (data.noteUpdate) {
          currentNotes = currentNotes
            ? `${currentNotes}\n${data.noteUpdate}`
            : data.noteUpdate;
          summary.notesUpdated = true;

          onEvent({ type: 'notes', content: currentNotes });
        }
      } else if (action === 'think') {
        // Append to monologue, no chat message
        const entry = { timestamp, text: data.text, type: 'think' };
        try {
          await persistence.appendMonologue(sessionId, personaId, entry, effectiveBasePath);
        } catch (err) {
          console.error(`[turn-orchestrator] Failed to write monologue for ${personaId}: ${err.message}`);
        }
        summary.monologueEntriesAdded++;

        // Emit message event with action type (SSE client uses this for UI updates)
        onEvent({ type: 'message', personaId, message: { text: data.text }, action: 'think' });
      } else if (action === 'research') {
        // Append to monologue with query + findings
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
      // Persona failed — log error, emit error event, continue round
      console.error(`[turn-orchestrator] Persona ${personaId} failed: ${err.message}`);
      summary.personasFailed++;

      onEvent({
        type: 'error',
        personaId,
        error: err.message || 'Unknown error',
      });
    }
  }

  // After all personas complete, write the updated session to disk
  try {
    const sessionData = {
      formatVersion: '1.0',
      session: {
        id: sessionId,
        updatedAt: new Date().toISOString(),
      },
      personas,
      notes: { content: currentNotes },
      messages,
    };
    await persistence.writeSessionChat(sessionId, sessionData, effectiveBasePath);
  } catch (err) {
    console.error(`[turn-orchestrator] Failed to write session: ${err.message}`);
    onEvent({ type: 'error', personaId: null, error: `Session write failed: ${err.message}` });
  }

  // Emit done event
  onEvent({ type: 'done' });

  return summary;
}
