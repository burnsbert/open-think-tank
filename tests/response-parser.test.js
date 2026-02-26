/**
 * Tests for lib/response-parser.js
 * TDD: write tests first, verify they fail, then implement.
 *
 * parseResponse(claudeOutput) takes the raw stdout from `claude -p --output-format json`
 * and returns a structured result:
 *   { success: true, action: "speak"|"think"|"research", data: {...} }
 *   { success: false, error: "description" }
 *
 * The claude -p --output-format json envelope looks like:
 *   { "type": "result", "subtype": "success", "is_error": false, "result": "<text>", ... }
 * where `result` is a string containing the persona's JSON action.
 *
 * NEVER throws — always returns a result object.
 */

import { describe, it, expect } from 'vitest';
import {
  createSpeakResponse,
  createThinkResponse,
  createResearchResponse,
} from './helpers.js';

// We import after test definitions so tests are registered before module loads
let parseResponse;

// Helper: wrap a persona action object in the claude -p --output-format json envelope
function wrapInClaudeEnvelope(personaAction) {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1500,
    duration_api_ms: 1200,
    num_turns: 1,
    result: JSON.stringify(personaAction),
    session_id: 'test-session-123',
  });
}

// Helper: wrap a plain string result in the claude envelope (for malformed persona JSON)
function wrapStringInClaudeEnvelope(resultStr) {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1000,
    result: resultStr,
    session_id: 'test-session-123',
  });
}

// ---------------------------------------------------------------------------
// Module import
// ---------------------------------------------------------------------------

beforeEach(async () => {
  const mod = await import('../lib/response-parser.js');
  parseResponse = mod.parseResponse;
});

// ---------------------------------------------------------------------------
// Claude envelope parsing
// ---------------------------------------------------------------------------

describe('Claude envelope parsing', () => {
  it('extracts persona JSON from claude output-format json envelope', async () => {
    const speakAction = createSpeakResponse('Hello everyone');
    const claudeOutput = wrapInClaudeEnvelope(speakAction);

    const result = parseResponse(claudeOutput);

    expect(result.success).toBe(true);
    expect(result.action).toBe('speak');
  });

  it('returns error when outer envelope JSON is malformed', async () => {
    const result = parseResponse('{invalid json here');

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(typeof result.error).toBe('string');
  });

  it('handles direct persona JSON without envelope (fallback for backward compat)', async () => {
    // If the output is already a valid persona action JSON (not wrapped in envelope),
    // the parser should try to parse it directly
    const speakAction = createSpeakResponse('Direct speak response');
    const directJson = JSON.stringify(speakAction);

    const result = parseResponse(directJson);

    expect(result.success).toBe(true);
    expect(result.action).toBe('speak');
  });

  it('handles claude envelope where result field is missing', async () => {
    const envelope = JSON.stringify({
      type: 'result',
      is_error: false,
      // No `result` field
    });

    const result = parseResponse(envelope);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('handles claude envelope where result field is null', async () => {
    const envelope = JSON.stringify({
      type: 'result',
      is_error: false,
      result: null,
    });

    const result = parseResponse(envelope);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('handles empty string input', async () => {
    const result = parseResponse('');

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('handles null input', async () => {
    const result = parseResponse(null);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('handles undefined input', async () => {
    const result = parseResponse(undefined);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Speak action validation
// ---------------------------------------------------------------------------

describe('speak action', () => {
  it('parses valid speak action with text only', async () => {
    const speakAction = createSpeakResponse('I think we should prototype first');
    const claudeOutput = wrapInClaudeEnvelope(speakAction);

    const result = parseResponse(claudeOutput);

    expect(result.success).toBe(true);
    expect(result.action).toBe('speak');
    expect(result.data.action).toBe('speak');
    expect(result.data.text).toBe('I think we should prototype first');
    expect(result.data.noteUpdate).toBeUndefined();
  });

  it('parses valid speak action with noteUpdate', async () => {
    const speakAction = createSpeakResponse('Agreed on the approach', 'Decision: use prototyping');
    const claudeOutput = wrapInClaudeEnvelope(speakAction);

    const result = parseResponse(claudeOutput);

    expect(result.success).toBe(true);
    expect(result.action).toBe('speak');
    expect(result.data.text).toBe('Agreed on the approach');
    expect(result.data.noteUpdate).toBe('Decision: use prototyping');
  });

  it('converts empty text speak action to think action (edge case #8)', async () => {
    const speakAction = { action: 'speak', text: '' };
    const claudeOutput = wrapInClaudeEnvelope(speakAction);

    const result = parseResponse(claudeOutput);

    // Empty speak text is treated as think
    expect(result.success).toBe(true);
    expect(result.action).toBe('think');
    expect(result.data.action).toBe('think');
    expect(result.data.text).toBe('');
  });

  it('converts whitespace-only text speak action to think action', async () => {
    const speakAction = { action: 'speak', text: '   ' };
    const claudeOutput = wrapInClaudeEnvelope(speakAction);

    const result = parseResponse(claudeOutput);

    expect(result.success).toBe(true);
    expect(result.action).toBe('think');
  });

  it('ignores extra fields on speak action', async () => {
    const speakAction = {
      action: 'speak',
      text: 'Hello',
      noteUpdate: null,
      extraField: 'should be ignored',
      anotherExtra: 42,
    };
    const claudeOutput = wrapInClaudeEnvelope(speakAction);

    const result = parseResponse(claudeOutput);

    expect(result.success).toBe(true);
    expect(result.action).toBe('speak');
    expect(result.data.text).toBe('Hello');
    // Extra fields are not included in data (or at minimum, don't cause failure)
  });

  it('returns error when speak action is missing text field', async () => {
    const speakAction = { action: 'speak' };
    const claudeOutput = wrapInClaudeEnvelope(speakAction);

    const result = parseResponse(claudeOutput);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('returns error when speak action has null text', async () => {
    const speakAction = { action: 'speak', text: null };
    const claudeOutput = wrapInClaudeEnvelope(speakAction);

    const result = parseResponse(claudeOutput);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Think action validation
// ---------------------------------------------------------------------------

describe('think action', () => {
  it('parses valid think action', async () => {
    const thinkAction = createThinkResponse('I should let the others speak first');
    const claudeOutput = wrapInClaudeEnvelope(thinkAction);

    const result = parseResponse(claudeOutput);

    expect(result.success).toBe(true);
    expect(result.action).toBe('think');
    expect(result.data.action).toBe('think');
    expect(result.data.text).toBe('I should let the others speak first');
  });

  it('ignores extra fields on think action', async () => {
    const thinkAction = {
      action: 'think',
      text: 'Pondering...',
      extraField: 'ignored',
    };
    const claudeOutput = wrapInClaudeEnvelope(thinkAction);

    const result = parseResponse(claudeOutput);

    expect(result.success).toBe(true);
    expect(result.action).toBe('think');
  });

  it('returns error when think action is missing text field', async () => {
    const thinkAction = { action: 'think' };
    const claudeOutput = wrapInClaudeEnvelope(thinkAction);

    const result = parseResponse(claudeOutput);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('returns error when think action has null text', async () => {
    const thinkAction = { action: 'think', text: null };
    const claudeOutput = wrapInClaudeEnvelope(thinkAction);

    const result = parseResponse(claudeOutput);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('allows empty string text in think action (silent thought)', async () => {
    const thinkAction = { action: 'think', text: '' };
    const claudeOutput = wrapInClaudeEnvelope(thinkAction);

    const result = parseResponse(claudeOutput);

    // Empty think text is valid (no conversion needed, it's already think)
    expect(result.success).toBe(true);
    expect(result.action).toBe('think');
    expect(result.data.text).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Research action validation
// ---------------------------------------------------------------------------

describe('research action', () => {
  it('parses valid research action', async () => {
    const researchAction = createResearchResponse(
      'summarize the attached spec doc',
      'The spec calls for a three-tier data model'
    );
    const claudeOutput = wrapInClaudeEnvelope(researchAction);

    const result = parseResponse(claudeOutput);

    expect(result.success).toBe(true);
    expect(result.action).toBe('research');
    expect(result.data.action).toBe('research');
    expect(result.data.query).toBe('summarize the attached spec doc');
    expect(result.data.findings).toBe('The spec calls for a three-tier data model');
  });

  it('ignores extra fields on research action', async () => {
    const researchAction = {
      action: 'research',
      query: 'what is the design system?',
      findings: 'Uses CSS custom properties',
      extraField: 'ignored',
    };
    const claudeOutput = wrapInClaudeEnvelope(researchAction);

    const result = parseResponse(claudeOutput);

    expect(result.success).toBe(true);
    expect(result.action).toBe('research');
  });

  it('returns error when research action is missing query field', async () => {
    const researchAction = { action: 'research', findings: 'some results' };
    const claudeOutput = wrapInClaudeEnvelope(researchAction);

    const result = parseResponse(claudeOutput);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('returns error when research action is missing findings field', async () => {
    const researchAction = { action: 'research', query: 'what is X?' };
    const claudeOutput = wrapInClaudeEnvelope(researchAction);

    const result = parseResponse(claudeOutput);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('returns error when research action has null query', async () => {
    const researchAction = { action: 'research', query: null, findings: 'some results' };
    const claudeOutput = wrapInClaudeEnvelope(researchAction);

    const result = parseResponse(claudeOutput);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('returns error when research action has null findings', async () => {
    const researchAction = { action: 'research', query: 'what is X?', findings: null };
    const claudeOutput = wrapInClaudeEnvelope(researchAction);

    const result = parseResponse(claudeOutput);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Missing / invalid action field
// ---------------------------------------------------------------------------

describe('missing or invalid action field', () => {
  it('returns error when action field is missing', async () => {
    const noAction = { text: 'Hello there' };
    const claudeOutput = wrapInClaudeEnvelope(noAction);

    const result = parseResponse(claudeOutput);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('returns error when action field is an unrecognized value', async () => {
    const badAction = { action: 'dance', text: 'Some text' };
    const claudeOutput = wrapInClaudeEnvelope(badAction);

    const result = parseResponse(claudeOutput);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('returns error when action field is null', async () => {
    const nullAction = { action: null, text: 'Some text' };
    const claudeOutput = wrapInClaudeEnvelope(nullAction);

    const result = parseResponse(claudeOutput);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('returns error when persona JSON is just a plain string', async () => {
    const claudeOutput = wrapStringInClaudeEnvelope('This is just a plain string response, not JSON');

    const result = parseResponse(claudeOutput);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('returns error when persona JSON is a number', async () => {
    const claudeOutput = wrapStringInClaudeEnvelope('42');

    const result = parseResponse(claudeOutput);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('returns error when persona JSON is an array', async () => {
    const claudeOutput = JSON.stringify({
      type: 'result',
      is_error: false,
      result: JSON.stringify([{ action: 'speak', text: 'hello' }]),
    });

    const result = parseResponse(claudeOutput);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Malformed inner persona JSON
// ---------------------------------------------------------------------------

describe('malformed inner persona JSON', () => {
  it('returns error when inner persona JSON is malformed', async () => {
    const claudeOutput = wrapStringInClaudeEnvelope('{invalid json');

    const result = parseResponse(claudeOutput);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('returns error when inner persona JSON is empty string', async () => {
    const claudeOutput = wrapStringInClaudeEnvelope('');

    const result = parseResponse(claudeOutput);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('does not throw on any malformed input — always returns result object', async () => {
    const badInputs = [
      null,
      undefined,
      '',
      'random garbage',
      '{malformed',
      '{"no_result_field": true}',
      wrapStringInClaudeEnvelope('{invalid'),
      wrapStringInClaudeEnvelope(''),
      wrapInClaudeEnvelope({ action: 'speak' }), // missing text
      wrapInClaudeEnvelope({ action: 'unknown' }),
    ];

    for (const input of badInputs) {
      let result;
      expect(() => {
        result = parseResponse(input);
      }).not.toThrow();
      expect(typeof result).toBe('object');
      expect(result).not.toBeNull();
      expect(typeof result.success).toBe('boolean');
    }
  });
});

// ---------------------------------------------------------------------------
// Result shape verification
// ---------------------------------------------------------------------------

describe('result shape', () => {
  it('success result has correct shape: { success, action, data }', async () => {
    const speakAction = createSpeakResponse('Hello');
    const claudeOutput = wrapInClaudeEnvelope(speakAction);

    const result = parseResponse(claudeOutput);

    expect(result).toHaveProperty('success', true);
    expect(result).toHaveProperty('action');
    expect(result).toHaveProperty('data');
    expect(['speak', 'think', 'research']).toContain(result.action);
    expect(typeof result.data).toBe('object');
  });

  it('error result has correct shape: { success, error }', async () => {
    const result = parseResponse('invalid');

    expect(result).toHaveProperty('success', false);
    expect(result).toHaveProperty('error');
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
  });

  it('speak data includes action and text fields', async () => {
    const speakAction = createSpeakResponse('A message');
    const claudeOutput = wrapInClaudeEnvelope(speakAction);

    const result = parseResponse(claudeOutput);

    expect(result.data).toHaveProperty('action', 'speak');
    expect(result.data).toHaveProperty('text', 'A message');
  });

  it('think data includes action and text fields', async () => {
    const thinkAction = createThinkResponse('A thought');
    const claudeOutput = wrapInClaudeEnvelope(thinkAction);

    const result = parseResponse(claudeOutput);

    expect(result.data).toHaveProperty('action', 'think');
    expect(result.data).toHaveProperty('text', 'A thought');
  });

  it('research data includes action, query, and findings fields', async () => {
    const researchAction = createResearchResponse('my query', 'my findings');
    const claudeOutput = wrapInClaudeEnvelope(researchAction);

    const result = parseResponse(claudeOutput);

    expect(result.data).toHaveProperty('action', 'research');
    expect(result.data).toHaveProperty('query', 'my query');
    expect(result.data).toHaveProperty('findings', 'my findings');
  });
});

// ---------------------------------------------------------------------------
// Edge cases with envelope structure variations
// ---------------------------------------------------------------------------

describe('envelope structure variations', () => {
  it('handles result field containing extra whitespace around JSON', async () => {
    const envelope = JSON.stringify({
      type: 'result',
      is_error: false,
      result: '  ' + JSON.stringify(createSpeakResponse('Trimmed response')) + '  ',
    });

    const result = parseResponse(envelope);

    expect(result.success).toBe(true);
    expect(result.action).toBe('speak');
  });

  it('handles result field containing JSON with markdown code fences', async () => {
    // Claude sometimes wraps JSON in code fences even when asked not to
    const personaJson = JSON.stringify(createSpeakResponse('Fenced response'));
    const envelope = JSON.stringify({
      type: 'result',
      is_error: false,
      result: '```json\n' + personaJson + '\n```',
    });

    const result = parseResponse(envelope);

    // Should successfully extract and parse the JSON from code fences
    expect(result.success).toBe(true);
    expect(result.action).toBe('speak');
  });

  it('handles envelope with is_error true by returning error result', async () => {
    const envelope = JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'Claude encountered an error',
    });

    const result = parseResponse(envelope);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
