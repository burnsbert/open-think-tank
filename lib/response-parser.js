/**
 * Response parser for claude -p --output-format json output.
 *
 * The claude CLI with --output-format json wraps responses in an envelope:
 *   {
 *     "type": "result",
 *     "subtype": "success",
 *     "is_error": false,
 *     "duration_ms": 1234,
 *     "result": "<text output from model>",
 *     "session_id": "..."
 *   }
 *
 * The persona's JSON action is in the `result` field as a string.
 * The parser extracts and validates that inner JSON against supported action shapes:
 *   - speak:        { action, actionType, text, noteUpdate? }
 *   - think:        { action, actionType, text }
 *   - research:     { action, actionType, query, findings }
 *   - pass:         { action, actionType }
 *   - update_notes: { action, actionType, noteUpdate }
 *
 * NEVER throws — always returns a result object:
 *   { success: true, action: "speak"|"think"|"research"|"pass"|"update_notes", data: {...} }
 *   { success: false, error: "description" }
 */

const VALID_ACTIONS = new Set(['speak', 'think', 'research', 'pass', 'update_notes']);
const TALKING_ACTION_TYPES = new Set([
	'quick_response',
	'raise_risk',
	'raise_upside',
	'agree_brief',
	'disagree_reasoned',
	'ask_general',
	'ask_about_idea',
	'clarify',
]);
const SILENT_ACTION_TYPES = new Set([
	'research',
	'pass',
	'update_notes',
	'think_hard',
	'continue_monologue',
]);
const VALID_ACTION_TYPES = new Set([...TALKING_ACTION_TYPES, ...SILENT_ACTION_TYPES]);

/**
 * Strip markdown code fences from a string.
 * Claude sometimes wraps JSON in ```json ... ``` even when instructed not to.
 *
 * @param {string} text
 * @returns {string}
 */
function stripCodeFences(text) {
  // Match ```json ... ``` or ``` ... ``` (with optional language tag)
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch) {
    return fenceMatch[1];
  }
  return text;
}

/**
 * Try to parse a string as JSON. Returns parsed object or null on failure.
 *
 * @param {string} str
 * @returns {any|null}
 */
function tryParseJson(str) {
  try {
    return JSON.parse(str);
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
			if (ch === '"') {
				inString = false;
			}
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}

		if (ch === '{') {
			depth++;
			continue;
		}

		if (ch === '}') {
			depth--;
			if (depth === 0) {
				return source.slice(start, i + 1);
			}
		}
	}

	return null;
}

/**
 * Extract the persona action JSON from the claude output envelope.
 * The envelope has a `result` field containing the model's text output.
 * That text is itself a JSON string encoding the persona action.
 *
 * Fallback: if the outer JSON doesn't look like a claude envelope (no `result`
 * field), try treating the whole string as a direct persona action JSON.
 *
 * @param {string} claudeOutput - Raw stdout from claude -p --output-format json
 * @returns {{ personaJson: object, error: string|null }}
 */
function extractPersonaJson(claudeOutput) {
  // Guard against non-string / empty inputs
  if (claudeOutput == null || typeof claudeOutput !== 'string' || claudeOutput.trim() === '') {
    return { personaJson: null, error: 'Empty or non-string input' };
  }

  // Try to parse the outer JSON (claude envelope)
  const envelope = tryParseJson(claudeOutput.trim());
  if (envelope === null) {
    // Ollama/local models may wrap JSON in thinking tags or prose.
    const extracted = extractFirstJsonObject(claudeOutput);
    if (extracted) {
      const recovered = tryParseJson(extracted);
      if (recovered !== null) {
        return { personaJson: recovered, error: null };
      }
    }
    return { personaJson: null, error: 'Failed to parse outer JSON envelope' };
  }

  // If the envelope has is_error true, this is a claude-level error
  if (envelope.is_error === true) {
    return { personaJson: null, error: 'Claude reported an error in the response' };
  }

  // Check if this looks like a claude envelope (has a `result` field)
  if (Object.prototype.hasOwnProperty.call(envelope, 'result')) {
    const resultField = envelope.result;

    // result must be a non-null string
    if (resultField == null || typeof resultField !== 'string') {
      return { personaJson: null, error: 'Claude envelope result field is null or not a string' };
    }

    if (resultField.trim() === '') {
      return { personaJson: null, error: 'Claude envelope result field is empty' };
    }

    // Strip code fences if present, then trim
    const innerStr = stripCodeFences(resultField.trim());

    const personaJson = tryParseJson(innerStr);
    if (personaJson !== null) {
      return { personaJson, error: null };
    }

		// Recovery path: Claude sometimes adds prose around JSON.
		const jsonObjectCandidate = extractFirstJsonObject(innerStr);
		if (jsonObjectCandidate) {
			const recovered = tryParseJson(jsonObjectCandidate);
			if (recovered !== null) {
				return { personaJson: recovered, error: null };
			}
		}

		// Last-chance reliability path: keep the turn alive by treating
		// non-JSON text as a speak action.
		if (innerStr.trim().length > 0) {
			return {
				personaJson: { action: 'speak', text: innerStr.trim() },
				error: null,
			};
		}

    return { personaJson: null, error: 'Failed to parse persona action JSON from result field' };
  }

  // Fallback: treat the outer parsed JSON directly as a persona action
  // (handles case where output is already the persona JSON, no envelope)
  return { personaJson: envelope, error: null };
}

function inferActionType(obj) {
	const action = obj?.action;
	if (action === 'speak') return 'quick_response';
	if (action === 'think') return 'think_hard';
	if (action === 'research') return 'research';
	if (action === 'pass') return 'pass';
	if (action === 'update_notes') return 'update_notes';
	return null;
}

function normalizeActionType(actionType) {
	if (actionType === 'continue_monologue') {
		return 'think_hard';
	}
	return actionType;
}

function parseActionType(obj) {
	const provided = obj?.actionType;
	if (typeof provided === 'string') {
		const trimmed = provided.trim();
		if (!trimmed) {
			return { success: false, error: 'actionType must be a non-empty string when provided' };
		}
		if (!VALID_ACTION_TYPES.has(trimmed)) {
			return { success: false, error: `Invalid actionType: ${JSON.stringify(trimmed)}` };
		}
		return { success: true, actionType: normalizeActionType(trimmed) };
	}

	const inferred = inferActionType(obj);
	if (!inferred) {
		return { success: false, error: 'Missing actionType and could not infer from action' };
	}
	return { success: true, actionType: normalizeActionType(inferred) };
}

function validateActionTypeMapping(action, actionType) {
	if (TALKING_ACTION_TYPES.has(actionType)) {
		return action === 'speak'
			? { success: true }
			: { success: false, error: `actionType "${actionType}" must be paired with action "speak"` };
	}

	if (actionType === 'think_hard' || actionType === 'continue_monologue') {
		return action === 'think'
			? { success: true }
			: { success: false, error: 'actionType "think_hard" must be paired with action "think"' };
	}

	if (actionType === 'research') {
		return action === 'research'
			? { success: true }
			: { success: false, error: 'actionType "research" must be paired with action "research"' };
	}

	if (actionType === 'pass') {
		return action === 'pass'
			? { success: true }
			: { success: false, error: 'actionType "pass" must be paired with action "pass"' };
	}

	if (actionType === 'update_notes') {
		return action === 'update_notes'
			? { success: true }
			: { success: false, error: 'actionType "update_notes" must be paired with action "update_notes"' };
	}

	return { success: false, error: `Unhandled actionType mapping for "${actionType}"` };
}

/**
 * Validate a speak action object.
 * Requirements: action === 'speak', text is a non-null string.
 * Edge case: empty/whitespace-only text is converted to a think action.
 *
 * @param {object} obj
 * @returns {{ success: true, action: string, data: object }|{ success: false, error: string }}
 */
function validateSpeak(obj) {
  const actionTypeResult = parseActionType(obj);
  if (!actionTypeResult.success) return { success: false, error: actionTypeResult.error };
  const mapped = validateActionTypeMapping('speak', actionTypeResult.actionType);
  if (!mapped.success) return mapped;

  if (!Object.prototype.hasOwnProperty.call(obj, 'text') || obj.text === null || obj.text === undefined) {
    return { success: false, error: 'speak action missing required text field' };
  }

  if (typeof obj.text !== 'string') {
    return { success: false, error: 'speak action text field must be a string' };
  }

  // Edge case #8: empty or whitespace-only text in a speak action → treat as think
  if (obj.text.trim() === '') {
    const thinkData = { action: 'think', actionType: 'think_hard', text: obj.text };
    return { success: true, action: 'think', data: thinkData };
  }

  // Build normalized data with only the expected fields
  const data = { action: 'speak', actionType: actionTypeResult.actionType, text: obj.text };
  if (obj.noteUpdate != null) {
    data.noteUpdate = obj.noteUpdate;
  }
  const round2Meta = parseRound2Meta(obj);
  if (!round2Meta.success) return round2Meta;
  Object.assign(data, round2Meta.data);

  return { success: true, action: 'speak', data };
}

/**
 * Validate a think action object.
 * Requirements: action === 'think', text is a non-null string (empty string is OK).
 *
 * @param {object} obj
 * @returns {{ success: true, action: string, data: object }|{ success: false, error: string }}
 */
function validateThink(obj) {
  const actionTypeResult = parseActionType(obj);
  if (!actionTypeResult.success) return { success: false, error: actionTypeResult.error };
  const mapped = validateActionTypeMapping('think', actionTypeResult.actionType);
  if (!mapped.success) return mapped;

  if (!Object.prototype.hasOwnProperty.call(obj, 'text') || obj.text === null || obj.text === undefined) {
    return { success: false, error: 'think action missing required text field' };
  }

  if (typeof obj.text !== 'string') {
    return { success: false, error: 'think action text field must be a string' };
  }

  const data = { action: 'think', actionType: actionTypeResult.actionType, text: obj.text };
  const round2Meta = parseRound2Meta(obj);
  if (!round2Meta.success) return round2Meta;
  Object.assign(data, round2Meta.data);
  return { success: true, action: 'think', data };
}

/**
 * Validate a research action object.
 * Requirements: action === 'research', query and findings are non-null strings.
 *
 * @param {object} obj
 * @returns {{ success: true, action: string, data: object }|{ success: false, error: string }}
 */
function validateResearch(obj) {
  const actionTypeResult = parseActionType(obj);
  if (!actionTypeResult.success) return { success: false, error: actionTypeResult.error };
  const mapped = validateActionTypeMapping('research', actionTypeResult.actionType);
  if (!mapped.success) return mapped;

  if (!Object.prototype.hasOwnProperty.call(obj, 'query') || obj.query === null || obj.query === undefined) {
    return { success: false, error: 'research action missing required query field' };
  }

  if (typeof obj.query !== 'string') {
    return { success: false, error: 'research action query field must be a string' };
  }

  if (!Object.prototype.hasOwnProperty.call(obj, 'findings') || obj.findings === null || obj.findings === undefined) {
    return { success: false, error: 'research action missing required findings field' };
  }

  if (typeof obj.findings !== 'string') {
    return { success: false, error: 'research action findings field must be a string' };
  }

  const data = {
    action: 'research',
    actionType: actionTypeResult.actionType,
    query: obj.query,
    findings: obj.findings,
  };
  const round2Meta = parseRound2Meta(obj);
  if (!round2Meta.success) return round2Meta;
  Object.assign(data, round2Meta.data);
  return { success: true, action: 'research', data };
}

function validatePass(obj) {
  const actionTypeResult = parseActionType(obj);
  if (!actionTypeResult.success) return { success: false, error: actionTypeResult.error };
  const mapped = validateActionTypeMapping('pass', actionTypeResult.actionType);
  if (!mapped.success) return mapped;

  const data = { action: 'pass', actionType: actionTypeResult.actionType };
  const round2Meta = parseRound2Meta(obj);
  if (!round2Meta.success) return round2Meta;
  Object.assign(data, round2Meta.data);
  return { success: true, action: 'pass', data };
}

function validateUpdateNotes(obj) {
  const actionTypeResult = parseActionType(obj);
  if (!actionTypeResult.success) return { success: false, error: actionTypeResult.error };
  const mapped = validateActionTypeMapping('update_notes', actionTypeResult.actionType);
  if (!mapped.success) return mapped;

  if (
    !Object.prototype.hasOwnProperty.call(obj, 'noteUpdate')
    || obj.noteUpdate === null
    || obj.noteUpdate === undefined
  ) {
    return { success: false, error: 'update_notes action missing required noteUpdate field' };
  }
  if (typeof obj.noteUpdate !== 'string' || obj.noteUpdate.trim() === '') {
    return { success: false, error: 'update_notes action noteUpdate must be a non-empty string' };
  }

  const data = {
    action: 'update_notes',
    actionType: actionTypeResult.actionType,
    noteUpdate: obj.noteUpdate.trim(),
  };
  const round2Meta = parseRound2Meta(obj);
  if (!round2Meta.success) return round2Meta;
  Object.assign(data, round2Meta.data);
  return { success: true, action: 'update_notes', data };
}

/**
 * Parse and validate optional round-2 request metadata.
 * Allowed shape:
 *   wantRound2?: boolean
 *   round2Reason?: string
 *
 * If wantRound2 is true and reason is missing, it's still valid.
 *
 * @param {object} obj
 * @returns {{ success: true, data: object }|{ success: false, error: string }}
 */
function parseRound2Meta(obj) {
  const data = {};

  if (Object.prototype.hasOwnProperty.call(obj, 'wantRound2')) {
    if (typeof obj.wantRound2 !== 'boolean') {
      return { success: false, error: 'wantRound2 must be a boolean when provided' };
    }
    data.wantRound2 = obj.wantRound2;
  }

  if (Object.prototype.hasOwnProperty.call(obj, 'round2Reason')) {
    if (typeof obj.round2Reason !== 'string') {
      return { success: false, error: 'round2Reason must be a string when provided' };
    }
    const trimmed = obj.round2Reason.trim();
    if (trimmed.length > 0) {
      data.round2Reason = trimmed;
    }
  }

  return { success: true, data };
}

/**
 * Parse the action-choice response (phase 1).
 * Expects: { "actionType": "<valid action type>" }
 * Never throws.
 *
 * @param {string} claudeOutput - Raw stdout from claude -p --output-format json
 * @returns {{ success: true, actionType: string }|{ success: false, error: string }}
 */
export function parseActionChoice(claudeOutput) {
	try {
		const { personaJson, error: extractError } = extractPersonaJson(claudeOutput);
		if (extractError) {
			return { success: false, error: extractError };
		}
		if (typeof personaJson === 'string') {
			const trimmed = personaJson.trim();
			if (VALID_ACTION_TYPES.has(trimmed)) {
				return { success: true, actionType: trimmed };
			}
		}
		if (personaJson === null || typeof personaJson !== 'object' || Array.isArray(personaJson)) {
			return { success: false, error: 'Action choice must be a JSON object or actionType string' };
		}
		const parsedType = parseActionType(personaJson);
		if (!parsedType.success) {
			return { success: false, error: parsedType.error };
		}
		return { success: true, actionType: parsedType.actionType };
	} catch (err) {
		return { success: false, error: `Unexpected action choice parser error: ${err.message}` };
	}
}

/**
 * Parse and validate the JSON output from `claude -p --output-format json`.
 *
 * Extracts the persona action from the claude output envelope, validates its
 * shape, and returns a structured result. Never throws.
 *
 * @param {string} claudeOutput - Raw stdout from claude -p --output-format json
 * @returns {{ success: true, action: "speak"|"think"|"research"|"pass"|"update_notes", data: object }
 *          |{ success: false, error: string }}
 */
export function parseResponse(claudeOutput) {
  try {
    // Step 1: Extract persona JSON from claude envelope
    const { personaJson, error: extractError } = extractPersonaJson(claudeOutput);

    if (extractError) {
      return { success: false, error: extractError };
    }

    // Step 2: Persona JSON must be a plain object (not array, not primitive)
    if (personaJson === null || typeof personaJson !== 'object' || Array.isArray(personaJson)) {
      return { success: false, error: 'Persona response must be a JSON object, not an array or primitive' };
    }

    // Step 3: Validate the action field
    const { action } = personaJson;

    if (action === null || action === undefined || !VALID_ACTIONS.has(action)) {
      return {
        success: false,
        error: `Invalid or missing action field: ${JSON.stringify(action)}. Must be one of: speak, think, research, pass, update_notes`,
      };
    }

    // Step 4: Validate based on action type
    switch (action) {
      case 'speak':
        return validateSpeak(personaJson);
      case 'think':
        return validateThink(personaJson);
      case 'research':
        return validateResearch(personaJson);
      case 'pass':
        return validatePass(personaJson);
      case 'update_notes':
        return validateUpdateNotes(personaJson);
      default:
        // Unreachable given VALID_ACTIONS check above, but satisfies exhaustiveness
        return { success: false, error: `Unhandled action: ${action}` };
    }
  } catch (err) {
    // Safety net — should never be reached, but ensures we never throw
    return { success: false, error: `Unexpected parser error: ${err.message}` };
  }
}
