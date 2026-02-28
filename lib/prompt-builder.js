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
  'You are in a quick standup-style discussion. Everyone can hear everyone.',
  'First decide your actionType, then execute it.',
  'If someone already made your point, use think_hard and move on.',
  'For greetings/small talk (for example: "hi", "hello", "thanks"), sound human and casual.',
  'Do not force specialty framing on lightweight social messages.',
  '',
  'Talking actionTypes (must use action="speak"):',
  '- quick_response',
  '- raise_risk',
  '- raise_upside',
  '- agree_brief',
  '- disagree_reasoned',
  '- ask_general',
  '- ask_about_idea',
  '- clarify',
  '- answer_question',
  '- answer_simple_question',
  '- engage_[name] (e.g., engage_blake)',
  '',
  'Silent actionTypes (must remain silent in chat):',
  '- research (use action="research" with query/findings)',
  '- pass (use action="pass")',
  '- update_notes (use action="update_notes" with noteUpdate)',
  '- think_hard (use action="think" with text)',
  '',
  'Output shape:',
  '- {"actionType":"quick_response","action":"speak","text":"...","noteUpdate":"optional","wantRound2":true|false,"round2Reason":"optional"}',
  '- {"actionType":"think_hard","action":"think","text":"...","wantRound2":true|false,"round2Reason":"optional"}',
  '- {"actionType":"research","action":"research","query":"...","findings":"...","wantRound2":true|false,"round2Reason":"optional"}',
  '- {"actionType":"pass","action":"pass","wantRound2":true|false,"round2Reason":"optional"}',
  '- {"actionType":"update_notes","action":"update_notes","noteUpdate":"...","wantRound2":true|false,"round2Reason":"optional"}',
  '',
  'Critical rules:',
  '- Never output markdown code fences or extra prose outside the JSON object.',
  '- Always include actionType and action.',
  '- BEFORE choosing speak, check if your point is genuinely new this round. If not, use think.',
  '- Keep speak concise. For simple asks: 1 sentence (~150 chars). Complex: 2-4 sentences (~400 chars).',
  '- Ask the shortest high-leverage question possible when one question is enough.',
  '- Vary rhythm naturally: often short, occasionally medium when substance requires it.',
  '- If more detail is needed, store overflow via think/research and continue next round.',
  '- Silent actions must never produce a visible chat message.',
  '- Hard cap: keep "speak.text" around 520 characters or less.',
  '- If the latest user message is lightweight social text, reply with a brief natural acknowledgment.',
  '- For lightweight social text, avoid turning the response into a framework, strategy, or specialty pitch.',
  '- Use persona specialty framing only when the user asks a substantive question or requests analysis.',
  '',
  'NEVER:',
  '- Start with "Great question", "That\'s a great point", or generic compliments.',
  '- Use bullet points or numbered lists in chat text (noteUpdate is fine).',
  '- Use filler like: "It\'s worth noting", "In my experience", "To be honest".',
  '- Repeat another persona\'s point with different wording.',
  '',
  'Examples:',
  'BAD: "I\'d suggest we look into using caching here to improve performance."',
  'GOOD: "Use caching here."',
  'BAD: "That\'s a great point about the database. I think we should consider Postgres..."',
  'GOOD: "Postgres. JSON support fits this exactly."',
  '- Use research only when investigation is required.',
  '- Optional: set wantRound2=true only when you have materially new follow-up for another short round.',
  '- If wantRound2 is true, include a brief round2Reason.',
  '',
  'Overage budget rules:',
  '- You have a per-session overageBudget that persists across turns (shown in context when non-zero).',
  '- Base speak limit: 150 characters. Speaking always costs 25 budget flat.',
  '- If your speak text is < 50 chars: brevity bonus cancels the flat cost (net 0 change).',
  '- If your speak text is > 150 chars: overage (len-150) is also deducted on top of the flat 25.',
  '  If your budget cannot cover the total cost, the server will truncate your message.',
  '- Silent actions earn budget: pass=+100; think_hard/research/update_notes=random 10-60.',
  '- If you are not selected to act this round, you earn a random 10-60 budget automatically.',
  '- Saving up budget by being silent lets you speak longer when it matters.',
].join('\n');

const ACTION_CHOICE_SYSTEM = [
	'You are choosing what to do next in a multi-persona standup discussion.',
	'FIRST, choose exactly one actionType.',
	'Return exactly one valid JSON object with a single field "actionType".',
	'When the latest user message is lightweight social text (for example: "hi", "hello", "thanks"),',
	'prefer quick_response or answer_simple_question and avoid specialty pitches.',
	'If another persona already gave a good social acknowledgment, prefer think_hard or pass.',
	'',
	'Talking actionTypes (you will speak in chat):',
	'- quick_response',
	'- raise_risk',
	'- raise_upside',
	'- agree_brief',
	'- disagree_reasoned',
	'- ask_general',
	'- ask_about_idea',
	'- clarify',
	'- answer_question',
	'- answer_simple_question',
	'- engage_[name] (e.g., engage_blake)',
	'',
	'Silent actionTypes (no chat message):',
	'- research',
	'- pass',
	'- update_notes',
	'- think_hard',
	'',
	'Output exactly: {"actionType":"<one of the above>"}',
	'No extra fields. No prose. Just that JSON object.',
	'Do not output markdown fences.',
].join('\n');
const ACTION_CHOICE_MONOLOGUE_TAIL_LINES = 16;

/**
 * Build a lightweight prompt for the action-choice phase.
 * Includes recent conversation tail and monologue so the persona has context,
 * but no tools and no heavy instructions.
 */
export async function buildActionChoicePrompt({
	personaId,
	messages = [],
	monologue = [],
	personas = [],
	conversationSummary = '',
	notes = '',
}) {
	const systemPrompt = `${ACTION_CHOICE_SYSTEM}\n\nPersona ID: ${personaId}`;

	const nameMap = {};
	for (const persona of personas) {
		nameMap[persona.id] = persona.displayName;
	}

	const sections = [];
	const trimmedSummary = (conversationSummary || '').trim();
	if (trimmedSummary.length > 0) {
		sections.push(buildConversationSummarySection(trimmedSummary));
	}
	sections.push(buildConversationHistory(messages.slice(-6), nameMap));

	if (monologue.length > 0) {
		sections.push(buildMonologueLineTailSection(monologue));
	}

	const trimmedNotes = (notes || '').trim();
	if (trimmedNotes.length > 0) {
		sections.push(buildNotesSection(trimmedNotes));
	}

	sections.push('FIRST: choose one actionType and return only {"actionType":"..."}');

	return { systemPrompt, userPrompt: sections.join('\n\n') };
}

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
 * @param {Object|null} params.priorWaveContext
 * @param {number} params.roundNumber
 * @param {number} params.totalRounds
 * @param {string|null} params.chosenActionType
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
  priorWaveContext = null,
  roundNumber = 1,
  totalRounds = 1,
  chosenActionType = null,
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

  if (priorWaveContext) {
    sections.push(buildPriorWaveContextSection());
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

  // 6. Constrain to pre-chosen actionType (from the decision phase)
  if (chosenActionType) {
    sections.push(buildChosenActionExecutionSection(chosenActionType));
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

function buildPriorWaveContextSection() {
  return [
    '## What\'s Already Been Said (do not repeat)',
    'Other personas have already responded this round.',
    'Only speak if your angle is genuinely different.',
    'Respond to the user\'s message directly, not meta-commentary about others.',
  ].join('\n');
}

function buildMonologueLineTailSection(monologue, lineLimit = ACTION_CHOICE_MONOLOGUE_TAIL_LINES) {
  const heading = '## Your Internal Monologue (Latest Lines)';
  const flattenedLines = [];

  for (const entry of monologue) {
    const ts = entry.timestamp || '';
    const type = entry.type ? ` [${entry.type}]` : '';
    const rawText = typeof entry.text === 'string' ? entry.text : '';
    const textLines = rawText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of textLines) {
      flattenedLines.push(`[${ts}]${type} ${line}`);
    }
  }

  if (flattenedLines.length === 0) {
    return `${heading}\n(None yet.)`;
  }

  const tailLines = flattenedLines.slice(-lineLimit);
  return `${heading}\n${tailLines.join('\n')}`;
}

function buildChosenActionExecutionSection(chosenActionType) {
  const header = [
    '## Your Chosen Action',
    `You already decided: actionType="${chosenActionType}".`,
    `Execute only that actionType. Your JSON must include "actionType":"${chosenActionType}".`,
  ];

  if (chosenActionType === 'research') {
    return [
      ...header,
      'You must return action="research" with both query and findings.',
      'Do not return speak/think/pass/update_notes.',
    ].join('\n');
  }

  if (chosenActionType === 'update_notes') {
    return [
      ...header,
      'You must return action="update_notes" with noteUpdate.',
      'Do not return a visible chat message field.',
    ].join('\n');
  }

  if (chosenActionType === 'pass') {
    return [
      ...header,
      'You must return action="pass".',
      'No text field needed.',
    ].join('\n');
  }

  if (chosenActionType === 'think_hard' || chosenActionType === 'continue_monologue') {
    return [
      ...header,
      'You must return action="think" with text.',
      'Keep the monologue concise and internal.',
    ].join('\n');
  }

  // Talking actionTypes
  return [
    ...header,
    'You must return action="speak" with text.',
    'Keep it concise and add a genuinely new point.',
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
