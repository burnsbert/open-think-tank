/**
 * lib/prompt-builder.js
 *
 * Assembles the full prompt string for a given persona's turn.
 *
 * Input:
 *   - personaId {string}           — ID of the persona whose turn it is
 *   - systemPromptPath {string}    — Absolute path to system.md for this persona
 *   - messages {Array}             — Full conversation history including earlier responses this turn
 *                                    Each: { id, speakerId, timestamp, text }
 *   - monologue {Array}            — This persona's own internal monologue entries
 *                                    Each: { timestamp, text, type }
 *   - notes {string}               — Current session notes content
 *   - attachedFiles {Array}        — List of attached filenames (strings)
 *                                    (Content NOT injected — available via --allowedTools per decision #5)
 *   - personas {Array}             — Persona roster for display name lookup
 *                                    Each: { id, displayName }
 *
 * Output: {Promise<string>} — The fully assembled prompt string
 *
 * Section order:
 *   1. System prompt content (from system.md)
 *   2. Conversation history (speaker-attributed, chronological)
 *   3. Own monologue (timestamped entries, if any)
 *   4. Session notes (if any)
 *   5. Attached files (filenames only, if any)
 */

import { promises as fs } from 'fs';

const CACHE_STABLE_SYSTEM_PREAMBLE = [
  'Open Think Tank multi-persona assistant context.',
  'Return exactly one valid JSON object and nothing else.',
  '',
  'Allowed actions:',
  '1) {"action":"speak","text":"...","noteUpdate":"optional","wantRound2":true|false,"round2Reason":"optional"}',
  '2) {"action":"think","text":"...","wantRound2":true|false,"round2Reason":"optional"}',
  '3) {"action":"research","query":"...","findings":"...","wantRound2":true|false,"round2Reason":"optional"}',
  '',
  'Critical rules:',
  '- Never output markdown code fences or extra prose outside the JSON object.',
  '- Keep everyday speak responses short and natural (usually 1-3 sentences).',
  '- Prefer efficiency and focus in each atomic response: answer the core point directly.',
  '- Ask the shortest high-leverage clarifying question possible when one question is enough.',
  '- Do not front-load every thought; you can add detail in later rounds if needed.',
  '- Engage with other personas\' ideas from recent context, not just the user.',
  '- Avoid repetition; do not restate the same point unless adding new value.',
  '- Hard cap: keep "speak.text" around 520 characters or less.',
  '- If more detail is needed, store overflow via think/research and continue next round.',
  '- Use research only when investigation is required.',
  '- Optional: set wantRound2=true only when you have materially new follow-up for another short round.',
  '- If wantRound2 is true, include a brief round2Reason.',
].join('\n');

/**
 * Build the full prompt string for a persona's turn.
 *
 * @param {Object} params
 * @param {string} params.personaId
 * @param {string} params.systemPromptPath
 * @param {Array}  params.messages
 * @param {Array}  params.monologue
 * @param {string} params.notes
 * @param {Array}  params.attachedFiles
 * @param {Array}  params.personas
 * @param {string} params.conversationSummary
 * @param {number} params.roundNumber
 * @param {number} params.totalRounds
 * @returns {Promise<string>}
 */
export async function buildPrompt({
  personaId,
  systemPromptPath,
  messages = [],
  monologue = [],
  notes = '',
  attachedFiles = [],
  personas = [],
  conversationSummary = '',
  roundNumber = 1,
  totalRounds = 1,
}) {
  // 1. Read system.md from disk (throws if file doesn't exist — intentional, propagated to caller)
  const personaSystemPrompt = (await fs.readFile(systemPromptPath, 'utf8')).trim();
  const systemPrompt = `${CACHE_STABLE_SYSTEM_PREAMBLE}\n\n${personaSystemPrompt}`;

  // Build a quick display-name lookup from the personas roster
  const nameMap = {};
  for (const persona of personas) {
    nameMap[persona.id] = persona.displayName;
  }

  const sections = [];

  // 1.5. Conversation summary for older messages (if available)
  const trimmedSummary = (conversationSummary || '').trim();
  if (trimmedSummary.length > 0) {
    sections.push(buildConversationSummarySection(trimmedSummary));
  }

  // 2. Conversation history
  sections.push(buildConversationHistory(messages, nameMap));

  // 2.5 Round guidance (for multi-round turns)
  if (totalRounds > 1) {
    sections.push(buildRoundGuidanceSection(roundNumber, totalRounds));
  }

  // 3. Own monologue (skip section if empty)
  if (monologue.length > 0) {
    sections.push(buildMonologueSection(monologue));
  }

  // 4. Session notes (skip section if blank)
  const trimmedNotes = (notes || '').trim();
  if (trimmedNotes.length > 0) {
    sections.push(buildNotesSection(trimmedNotes));
  }

  // 5. Attached files (skip section if none)
  if (attachedFiles.length > 0) {
    sections.push(buildAttachedFilesSection(attachedFiles));
  }

  const userPrompt = sections.join('\n\n');

  return { systemPrompt, userPrompt };
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

/**
 * Format the conversation history section.
 * Each message is prefixed with the speaker's display name.
 *
 * @param {Array}  messages  — Array of { speakerId, timestamp, text }
 * @param {Object} nameMap   — Map from speakerId to displayName
 * @returns {string}
 */
function buildConversationHistory(messages, nameMap) {
  const heading = '## Conversation History';

  if (messages.length === 0) {
    return `${heading}\n(No messages yet.)`;
  }

  const lines = messages.map((msg) => {
    const speaker = nameMap[msg.speakerId] || msg.speakerId;
    return `${speaker}: ${msg.text}`;
  });

  return `${heading}\n${lines.join('\n')}`;
}

/**
 * Format the compressed summary of older conversation context.
 *
 * @param {string} summary
 * @returns {string}
 */
function buildConversationSummarySection(summary) {
  return `## Conversation Summary (Older Messages)\n${summary}`;
}

function buildRoundGuidanceSection(roundNumber, totalRounds) {
  if (roundNumber <= 1) {
    return `## Round Context\nThis is round ${roundNumber} of ${totalRounds}. Contribute your best concise perspective.`;
  }
  return [
    '## Round Context',
    `This is round ${roundNumber} of ${totalRounds}.`,
    'Only speak if you can add materially new information beyond what was already said.',
    'If your point is mostly repetition, use think instead.',
  ].join('\n');
}

/**
 * Format the persona's own internal monologue section.
 * Each entry shows its timestamp and text.
 *
 * @param {Array} monologue — Array of { timestamp, text, type }
 * @returns {string}
 */
function buildMonologueSection(monologue) {
  const heading = '## Your Internal Monologue';

  const lines = monologue.map((entry) => {
    const ts = entry.timestamp || '';
    const type = entry.type ? ` [${entry.type}]` : '';
    return `[${ts}]${type} ${entry.text}`;
  });

  return `${heading}\n${lines.join('\n')}`;
}

/**
 * Format the session notes section.
 *
 * @param {string} notes — Notes content (already trimmed)
 * @returns {string}
 */
function buildNotesSection(notes) {
  return `## Session Notes\n${notes}`;
}

/**
 * Format the attached files section.
 * Lists filenames only — content is available via --allowedTools (decision #5).
 *
 * @param {Array} attachedFiles — Array of filename strings
 * @returns {string}
 */
function buildAttachedFilesSection(attachedFiles) {
  const heading = '## Attached Files';
  const note = '(Content available via research action — use your file-reading tools to access these.)';
  const fileList = attachedFiles.map((f) => `- ${f}`).join('\n');
  return `${heading}\n${note}\n${fileList}`;
}
