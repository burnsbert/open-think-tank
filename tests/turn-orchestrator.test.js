/**
 * Tests for lib/turn-orchestrator.js
 * TDD: tests written FIRST, verified failing, then implementation added.
 *
 * Function tested:
 *   runTurn({ sessionId, messages, notes, attachedFiles, personas, model,
 *             onEvent, execCommand, buildPrompt, persistence, basePath })
 *
 * The turn orchestrator is the core engine that:
 *   (a) determines persona order (name-mention prioritization + randomization)
 *   (b) for each persona: build prompt, spawn claude -p, parse response, apply result, write monologue
 *   (c) after all personas: write session-chat.json to disk
 *
 * All tests use dependency injection — no real claude calls, no real file I/O.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createSpeakResponse,
  createThinkResponse,
  createResearchResponse,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const PERSONAS = [
  { id: 'blake', name: 'Blake', displayName: 'Blake', role: 'ai-persona', prioritizes: ['quality'] },
  { id: 'yui', name: 'Yui', displayName: 'Yui', role: 'ai-persona', prioritizes: ['ux'] },
  { id: 'grant', name: 'Grant', displayName: 'Grant', role: 'ai-persona', prioritizes: ['innovation'] },
  { id: 'julia', name: 'Julia', displayName: 'Julia', role: 'ai-persona', prioritizes: ['strategy'] },
  { id: 'user', name: 'User', displayName: 'User', role: 'human' },
];

const AI_PERSONA_IDS = ['blake', 'yui', 'grant', 'julia'];

/**
 * Create a mock execCommand that returns configurable responses per persona.
 * Wraps each response in the claude -p --output-format json envelope.
 *
 * @param {Object} responseMap - Map from persona ID to response object (speak/think/research)
 * @param {Object} [options] - Additional options
 * @param {string[]} [options.errorPersonas] - Persona IDs that should fail
 * @param {string[]} [options.timeoutPersonas] - Persona IDs that should timeout
 * @returns {Function} Mock execCommand
 */
function createMockExecCommand(responseMap = {}, options = {}) {
  const { errorPersonas = [], timeoutPersonas = [] } = options;

  return vi.fn((command, args, opts, callback) => {
    // Extract the prompt from args to determine which persona is being called.
    // The prompt is the arg right after '-p'.
    const promptIndex = args.indexOf('-p');
    const prompt = promptIndex >= 0 ? args[promptIndex + 1] : '';

    // Determine persona from prompt content (system prompt path contains persona ID)
    let personaId = null;
    for (const id of AI_PERSONA_IDS) {
      if (prompt.includes(`personas/${id}/system.md`) || prompt.includes(`# ${id}`) || prompt.includes(id)) {
        personaId = id;
        break;
      }
    }

    // Check the system prompt path in the args for persona detection
    if (!personaId) {
      for (const id of AI_PERSONA_IDS) {
        const argStr = args.join(' ');
        if (argStr.includes(`personas/${id}`)) {
          personaId = id;
          break;
        }
      }
    }

    // Also detect from the --append-system-prompt or prompt text
    if (!personaId) {
      // fallback: use call order tracking
      personaId = AI_PERSONA_IDS[createMockExecCommand._callCount || 0];
    }

    if (timeoutPersonas.includes(personaId)) {
      // Simulate timeout — never call callback
      // The orchestrator should handle this via execFile timeout option
      const timeoutMs = opts?.timeout || 120000;
      const timer = setTimeout(() => {
        const err = new Error('Command timed out');
        err.killed = true;
        err.signal = 'SIGTERM';
        callback(err, '', '');
      }, 10); // Fast timeout for tests
      return { kill: vi.fn(() => clearTimeout(timer)) };
    }

    if (errorPersonas.includes(personaId)) {
      process.nextTick(() => {
        callback(new Error(`claude -p failed for ${personaId}`), '', 'CLI error');
      });
      return;
    }

    // Default response
    const response = responseMap[personaId] || createSpeakResponse(`Hello from ${personaId}`);
    const envelope = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: JSON.stringify(response),
      session_id: 'test-session',
      duration_ms: 1500,
    };

    process.nextTick(() => {
      callback(null, JSON.stringify(envelope), '');
    });
  });
}

/**
 * Create a mock buildPrompt function.
 * Returns a predictable prompt string based on personaId.
 */
function createMockBuildPrompt() {
  return vi.fn(async ({ personaId, systemPromptPath }) => {
    return `Mock prompt for ${personaId} using ${systemPromptPath}`;
  });
}

/**
 * Create a mock persistence object with all four functions.
 */
function createMockPersistence() {
  return {
    readMonologue: vi.fn(async () => []),
    appendMonologue: vi.fn(async () => {}),
    writeSessionChat: vi.fn(async () => {}),
    ensureSessionDir: vi.fn(async () => {}),
  };
}

/**
 * Create a mock onEvent callback that records all events.
 */
function createMockOnEvent() {
  const events = [];
  const fn = vi.fn((event) => {
    events.push(event);
  });
  fn.events = events;
  return fn;
}

/**
 * Create standard test options with all dependencies injected.
 */
function createTestOptions(overrides = {}) {
  const responseMap = overrides.responseMap || {
    blake: createSpeakResponse('Great point!'),
    yui: createSpeakResponse('I love this idea!'),
    grant: createThinkResponse('Interesting approach...'),
    julia: createSpeakResponse('Strategically sound.'),
  };

  return {
    sessionId: 'test-session-001',
    messages: [
      { id: 'msg-1', speakerId: 'user', timestamp: '2026-02-25T10:00:00.000Z', text: 'Hello everyone!' },
    ],
    notes: 'Initial session notes.',
    attachedFiles: [],
    personas: PERSONAS,
    model: 'sonnet',
    onEvent: createMockOnEvent(),
    execCommand: createMockExecCommand(responseMap),
    buildPrompt: createMockBuildPrompt(),
    persistence: createMockPersistence(),
    basePath: '/tmp/test-base',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

let runTurn;

beforeEach(async () => {
  const mod = await import('../lib/turn-orchestrator.js');
  runTurn = mod.runTurn;
});

// ---------------------------------------------------------------------------
// Basic functionality
// ---------------------------------------------------------------------------

describe('runTurn — basic functionality', () => {
  it('is a function', () => {
    expect(typeof runTurn).toBe('function');
  });

  it('returns a promise', () => {
    const opts = createTestOptions();
    const result = runTurn(opts);
    expect(result).toBeInstanceOf(Promise);
  });

  it('resolves without throwing on successful round', async () => {
    const opts = createTestOptions();
    await expect(runTurn(opts)).resolves.not.toThrow();
  });

  it('calls buildPrompt for each AI persona', async () => {
    const opts = createTestOptions();
    await runTurn(opts);
    // 4 AI personas, not the human user
    expect(opts.buildPrompt).toHaveBeenCalledTimes(4);
  });

  it('calls execCommand for each AI persona', async () => {
    const opts = createTestOptions();
    await runTurn(opts);
    expect(opts.execCommand).toHaveBeenCalledTimes(4);
  });

  it('processes only AI personas, skipping human personas', async () => {
    const opts = createTestOptions();
    await runTurn(opts);

    // buildPrompt should not be called with 'user' personaId
    const calledPersonaIds = opts.buildPrompt.mock.calls.map(call => call[0].personaId);
    expect(calledPersonaIds).not.toContain('user');
    expect(calledPersonaIds).toHaveLength(4);
    for (const id of AI_PERSONA_IDS) {
      expect(calledPersonaIds).toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// Persona ordering
// ---------------------------------------------------------------------------

describe('runTurn — persona ordering', () => {
  it('randomizes persona order when no name is mentioned', async () => {
    // Run multiple times and check that order varies
    const orders = new Set();
    for (let i = 0; i < 20; i++) {
      const callOrder = [];
      const mockBuild = vi.fn(async ({ personaId }) => {
        callOrder.push(personaId);
        return `Prompt for ${personaId}`;
      });
      const opts = createTestOptions({
        buildPrompt: mockBuild,
        messages: [
          { id: 'msg-1', speakerId: 'user', timestamp: '2026-02-25T10:00:00.000Z', text: 'Hello everyone!' },
        ],
      });
      await runTurn(opts);
      orders.add(callOrder.join(','));
    }
    // With 4 personas and 20 runs, we should see at least 2 different orders
    // (probability of all same order is (1/24)^19 ≈ 0, effectively impossible)
    expect(orders.size).toBeGreaterThan(1);
  });

  it('puts mentioned persona first when name appears in last user message', async () => {
    const callOrder = [];
    const mockBuild = vi.fn(async ({ personaId }) => {
      callOrder.push(personaId);
      return `Prompt for ${personaId}`;
    });
    const opts = createTestOptions({
      buildPrompt: mockBuild,
      messages: [
        { id: 'msg-1', speakerId: 'user', timestamp: '2026-02-25T10:00:00.000Z', text: 'Hey Julia, what do you think?' },
      ],
    });
    await runTurn(opts);

    expect(callOrder[0]).toBe('julia');
    expect(callOrder).toHaveLength(4);
  });

  it('matches persona name case-insensitively', async () => {
    const callOrder = [];
    const mockBuild = vi.fn(async ({ personaId }) => {
      callOrder.push(personaId);
      return `Prompt for ${personaId}`;
    });
    const opts = createTestOptions({
      buildPrompt: mockBuild,
      messages: [
        { id: 'msg-1', speakerId: 'user', timestamp: '2026-02-25T10:00:00.000Z', text: 'BLAKE, your thoughts?' },
      ],
    });
    await runTurn(opts);

    expect(callOrder[0]).toBe('blake');
  });

  it('matches persona displayName', async () => {
    const callOrder = [];
    const customPersonas = [
      ...PERSONAS.filter(p => p.id !== 'grant'),
      { id: 'grant', name: 'Grant', displayName: 'The Innovator', role: 'ai-persona', prioritizes: ['innovation'] },
    ];
    const mockBuild = vi.fn(async ({ personaId }) => {
      callOrder.push(personaId);
      return `Prompt for ${personaId}`;
    });
    const opts = createTestOptions({
      personas: customPersonas,
      buildPrompt: mockBuild,
      messages: [
        { id: 'msg-1', speakerId: 'user', timestamp: '2026-02-25T10:00:00.000Z', text: 'The Innovator should weigh in' },
      ],
    });
    await runTurn(opts);

    expect(callOrder[0]).toBe('grant');
  });

  it('uses only the last message from the user for mention detection', async () => {
    const callOrder = [];
    const mockBuild = vi.fn(async ({ personaId }) => {
      callOrder.push(personaId);
      return `Prompt for ${personaId}`;
    });
    const opts = createTestOptions({
      buildPrompt: mockBuild,
      messages: [
        { id: 'msg-1', speakerId: 'user', timestamp: '2026-02-25T10:00:00.000Z', text: 'Julia, hello!' },
        { id: 'msg-2', speakerId: 'blake', timestamp: '2026-02-25T10:01:00.000Z', text: 'Hi there!' },
        { id: 'msg-3', speakerId: 'user', timestamp: '2026-02-25T10:02:00.000Z', text: 'Yui, what do you think?' },
      ],
    });
    await runTurn(opts);

    // Should prioritize Yui (last user message), not Julia (earlier user message)
    expect(callOrder[0]).toBe('yui');
  });

  it('fully randomizes when last user message mentions no persona', async () => {
    const callOrder = [];
    const mockBuild = vi.fn(async ({ personaId }) => {
      callOrder.push(personaId);
      return `Prompt for ${personaId}`;
    });
    const opts = createTestOptions({
      buildPrompt: mockBuild,
      messages: [
        { id: 'msg-1', speakerId: 'user', timestamp: '2026-02-25T10:00:00.000Z', text: 'What does everyone think?' },
      ],
    });
    await runTurn(opts);

    // All 4 AI personas should be present
    expect(callOrder).toHaveLength(4);
    for (const id of AI_PERSONA_IDS) {
      expect(callOrder).toContain(id);
    }
  });

  it('handles empty messages array — fully randomizes', async () => {
    const opts = createTestOptions({ messages: [] });
    await expect(runTurn(opts)).resolves.not.toThrow();
    expect(opts.buildPrompt).toHaveBeenCalledTimes(4);
  });

  it('only considers user messages for mention detection (ignores AI messages)', async () => {
    const callOrder = [];
    const mockBuild = vi.fn(async ({ personaId }) => {
      callOrder.push(personaId);
      return `Prompt for ${personaId}`;
    });
    const opts = createTestOptions({
      buildPrompt: mockBuild,
      messages: [
        { id: 'msg-1', speakerId: 'user', timestamp: '2026-02-25T10:00:00.000Z', text: 'Hello' },
        { id: 'msg-2', speakerId: 'blake', timestamp: '2026-02-25T10:01:00.000Z', text: 'Hey Yui, agree?' },
      ],
    });
    // The last message is from blake (AI), not user. Last USER message is 'Hello' with no mention.
    // Ordering should be randomized.
    await runTurn(opts);

    expect(callOrder).toHaveLength(4);
    // We cannot assert exact order since it's random, but all personas should be present
    for (const id of AI_PERSONA_IDS) {
      expect(callOrder).toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// Speak action handling
// ---------------------------------------------------------------------------

describe('runTurn — speak action', () => {
  it('appends spoken message to the messages array', async () => {
    const opts = createTestOptions({
      responseMap: {
        blake: createSpeakResponse('Hello from Blake!'),
        yui: createThinkResponse('Thinking...'),
        grant: createThinkResponse('Thinking...'),
        julia: createThinkResponse('Thinking...'),
      },
    });
    const initialCount = opts.messages.length;
    await runTurn(opts);

    // Blake speaks, so one new message should be appended
    const newMessages = opts.messages.slice(initialCount);
    const blakeMsg = newMessages.find(m => m.speakerId === 'blake');
    expect(blakeMsg).toBeDefined();
    expect(blakeMsg.text).toBe('Hello from Blake!');
  });

  it('generates message IDs in the expected format', async () => {
    const opts = createTestOptions({
      responseMap: {
        blake: createSpeakResponse('Test message'),
        yui: createThinkResponse('...'),
        grant: createThinkResponse('...'),
        julia: createThinkResponse('...'),
      },
    });
    const initialCount = opts.messages.length;
    await runTurn(opts);

    const newMessages = opts.messages.slice(initialCount);
    const blakeMsg = newMessages.find(m => m.speakerId === 'blake');
    expect(blakeMsg.id).toMatch(/^msg-\d+-[a-z0-9]{5}$/);
  });

  it('includes timestamp on spoken messages', async () => {
    const opts = createTestOptions({
      responseMap: {
        blake: createSpeakResponse('Timed message'),
        yui: createThinkResponse('...'),
        grant: createThinkResponse('...'),
        julia: createThinkResponse('...'),
      },
    });
    const initialCount = opts.messages.length;
    await runTurn(opts);

    const newMessages = opts.messages.slice(initialCount);
    const blakeMsg = newMessages.find(m => m.speakerId === 'blake');
    expect(blakeMsg.timestamp).toBeDefined();
    // Should be a valid ISO string
    expect(new Date(blakeMsg.timestamp).toISOString()).toBe(blakeMsg.timestamp);
  });

  it('emits a message event for spoken messages', async () => {
    const opts = createTestOptions({
      responseMap: {
        blake: createSpeakResponse('Event test'),
        yui: createThinkResponse('...'),
        grant: createThinkResponse('...'),
        julia: createThinkResponse('...'),
      },
    });
    await runTurn(opts);

    const messageEvents = opts.onEvent.events.filter(e => e.type === 'message');
    const blakeEvent = messageEvents.find(e => e.personaId === 'blake');
    expect(blakeEvent).toBeDefined();
    expect(blakeEvent.message.text).toBe('Event test');
    expect(blakeEvent.action).toBe('speak');
  });

  it('makes earlier speak messages visible to later personas', async () => {
    // Blake speaks first, then Yui should see Blake's message in the prompt
    const callOrder = [];
    const promptMessages = {};
    const mockBuild = vi.fn(async ({ personaId, messages }) => {
      callOrder.push(personaId);
      promptMessages[personaId] = [...messages];
      return `Prompt for ${personaId}`;
    });

    // Force order: blake first
    const opts = createTestOptions({
      buildPrompt: mockBuild,
      messages: [
        { id: 'msg-1', speakerId: 'user', timestamp: '2026-02-25T10:00:00.000Z', text: 'Blake, start us off' },
      ],
      responseMap: {
        blake: createSpeakResponse('Blake speaks first'),
        yui: createSpeakResponse('Yui follows'),
        grant: createThinkResponse('...'),
        julia: createThinkResponse('...'),
      },
    });
    await runTurn(opts);

    // Blake goes first (mentioned)
    expect(callOrder[0]).toBe('blake');

    // The second persona should have blake's message in their messages array
    const secondPersona = callOrder[1];
    const secondMessages = promptMessages[secondPersona];
    const blakeMsg = secondMessages.find(m => m.speakerId === 'blake');
    expect(blakeMsg).toBeDefined();
    expect(blakeMsg.text).toBe('Blake speaks first');
  });
});

// ---------------------------------------------------------------------------
// Think action handling
// ---------------------------------------------------------------------------

describe('runTurn — think action', () => {
  it('does NOT append a message to the messages array for think', async () => {
    const opts = createTestOptions({
      responseMap: {
        blake: createThinkResponse('Deep thoughts...'),
        yui: createThinkResponse('More thoughts...'),
        grant: createThinkResponse('Even more thoughts...'),
        julia: createThinkResponse('Strategic thoughts...'),
      },
    });
    const initialCount = opts.messages.length;
    await runTurn(opts);

    // No new messages since all personas thought silently
    expect(opts.messages.length).toBe(initialCount);
  });

  it('appends think entry to monologue via persistence', async () => {
    const opts = createTestOptions({
      responseMap: {
        blake: createThinkResponse('I think this is good'),
        yui: createThinkResponse('...'),
        grant: createThinkResponse('...'),
        julia: createThinkResponse('...'),
      },
    });
    await runTurn(opts);

    // appendMonologue should have been called for each persona that thought
    const blakeCalls = opts.persistence.appendMonologue.mock.calls.filter(
      call => call[1] === 'blake'
    );
    expect(blakeCalls.length).toBeGreaterThanOrEqual(1);
    // The entry should have type 'think' and the text
    const blakeEntry = blakeCalls[0][2]; // third arg is the entry
    expect(blakeEntry.type).toBe('think');
    expect(blakeEntry.text).toBe('I think this is good');
  });

  it('emits a message event with action think (not added to chat)', async () => {
    const opts = createTestOptions({
      responseMap: {
        blake: createThinkResponse('Silent thought'),
        yui: createThinkResponse('...'),
        grant: createThinkResponse('...'),
        julia: createThinkResponse('...'),
      },
    });
    await runTurn(opts);

    const messageEvents = opts.onEvent.events.filter(e => e.type === 'message');
    const blakeEvent = messageEvents.find(e => e.personaId === 'blake');
    expect(blakeEvent).toBeDefined();
    expect(blakeEvent.action).toBe('think');
  });
});

// ---------------------------------------------------------------------------
// Research action handling
// ---------------------------------------------------------------------------

describe('runTurn — research action', () => {
  it('does NOT append a message to messages array for research', async () => {
    const opts = createTestOptions({
      responseMap: {
        blake: createResearchResponse('query here', 'findings here'),
        yui: createThinkResponse('...'),
        grant: createThinkResponse('...'),
        julia: createThinkResponse('...'),
      },
    });
    const initialCount = opts.messages.length;
    await runTurn(opts);

    // No new messages from research action
    const blakeMessages = opts.messages.filter(m => m.speakerId === 'blake');
    expect(blakeMessages).toHaveLength(0);
  });

  it('appends research entry to monologue with query and findings', async () => {
    const opts = createTestOptions({
      responseMap: {
        blake: createResearchResponse('What is TDD?', 'TDD is test-driven development'),
        yui: createThinkResponse('...'),
        grant: createThinkResponse('...'),
        julia: createThinkResponse('...'),
      },
    });
    await runTurn(opts);

    const blakeCalls = opts.persistence.appendMonologue.mock.calls.filter(
      call => call[1] === 'blake'
    );
    expect(blakeCalls.length).toBeGreaterThanOrEqual(1);
    const entry = blakeCalls[0][2];
    expect(entry.type).toBe('research');
    expect(entry.text).toContain('What is TDD?');
    expect(entry.text).toContain('TDD is test-driven development');
  });

  it('emits a message event with action research', async () => {
    const opts = createTestOptions({
      responseMap: {
        blake: createResearchResponse('query', 'findings'),
        yui: createThinkResponse('...'),
        grant: createThinkResponse('...'),
        julia: createThinkResponse('...'),
      },
    });
    await runTurn(opts);

    const messageEvents = opts.onEvent.events.filter(e => e.type === 'message');
    const blakeEvent = messageEvents.find(e => e.personaId === 'blake');
    expect(blakeEvent).toBeDefined();
    expect(blakeEvent.action).toBe('research');
  });
});

// ---------------------------------------------------------------------------
// Note update handling
// ---------------------------------------------------------------------------

describe('runTurn — noteUpdate in speak action', () => {
  it('updates notes content when speak includes noteUpdate', async () => {
    const opts = createTestOptions({
      notes: 'Initial notes.',
      responseMap: {
        blake: createSpeakResponse('I have a note', 'Blake: Important finding'),
        yui: createThinkResponse('...'),
        grant: createThinkResponse('...'),
        julia: createThinkResponse('...'),
      },
    });
    await runTurn(opts);

    // The returned notes should include the noteUpdate
    // The orchestrator should have updated the notes string
    const notesEvents = opts.onEvent.events.filter(e => e.type === 'notes');
    expect(notesEvents.length).toBeGreaterThanOrEqual(1);
    expect(notesEvents[0].content).toContain('Blake: Important finding');
  });

  it('emits a notes event when noteUpdate is present', async () => {
    const opts = createTestOptions({
      responseMap: {
        blake: createSpeakResponse('Note message', 'Blake: Key insight'),
        yui: createThinkResponse('...'),
        grant: createThinkResponse('...'),
        julia: createThinkResponse('...'),
      },
    });
    await runTurn(opts);

    const notesEvents = opts.onEvent.events.filter(e => e.type === 'notes');
    expect(notesEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT emit notes event when speak has no noteUpdate', async () => {
    const opts = createTestOptions({
      responseMap: {
        blake: createSpeakResponse('No note here'),
        yui: createThinkResponse('...'),
        grant: createThinkResponse('...'),
        julia: createThinkResponse('...'),
      },
    });
    await runTurn(opts);

    const notesEvents = opts.onEvent.events.filter(e => e.type === 'notes');
    expect(notesEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Event emission
// ---------------------------------------------------------------------------

describe('runTurn — event emission', () => {
  it('emits thinking event before each persona processes', async () => {
    const opts = createTestOptions();
    await runTurn(opts);

    const thinkingEvents = opts.onEvent.events.filter(e => e.type === 'thinking');
    expect(thinkingEvents).toHaveLength(4);
  });

  it('thinking events include personaId and personaName', async () => {
    const opts = createTestOptions();
    await runTurn(opts);

    const thinkingEvents = opts.onEvent.events.filter(e => e.type === 'thinking');
    for (const event of thinkingEvents) {
      expect(event.personaId).toBeDefined();
      expect(event.personaName).toBeDefined();
      expect(AI_PERSONA_IDS).toContain(event.personaId);
    }
  });

  it('emits a done event after all personas complete', async () => {
    const opts = createTestOptions();
    await runTurn(opts);

    const doneEvents = opts.onEvent.events.filter(e => e.type === 'done');
    expect(doneEvents).toHaveLength(1);
  });

  it('done event is the last event emitted', async () => {
    const opts = createTestOptions();
    await runTurn(opts);

    const lastEvent = opts.onEvent.events[opts.onEvent.events.length - 1];
    expect(lastEvent.type).toBe('done');
  });

  it('events are emitted in order: thinking, message, [notes], ... thinking, message, ... done', async () => {
    const opts = createTestOptions({
      responseMap: {
        blake: createSpeakResponse('Blake speaks'),
        yui: createSpeakResponse('Yui speaks'),
        grant: createSpeakResponse('Grant speaks'),
        julia: createSpeakResponse('Julia speaks'),
      },
    });
    await runTurn(opts);

    const events = opts.onEvent.events;
    // Should be: thinking, message, thinking, message, ... done
    // Each persona gets thinking then message
    let i = 0;
    while (i < events.length - 1) {
      expect(events[i].type).toBe('thinking');
      i++;
      expect(events[i].type).toBe('message');
      i++;
    }
    expect(events[events.length - 1].type).toBe('done');
  });

  it('message events include the full message object for speak actions', async () => {
    const opts = createTestOptions({
      responseMap: {
        blake: createSpeakResponse('Full message test'),
        yui: createThinkResponse('...'),
        grant: createThinkResponse('...'),
        julia: createThinkResponse('...'),
      },
    });
    await runTurn(opts);

    const messageEvents = opts.onEvent.events.filter(e => e.type === 'message');
    const blakeEvent = messageEvents.find(e => e.personaId === 'blake');
    expect(blakeEvent.message).toBeDefined();
    expect(blakeEvent.message.id).toBeDefined();
    expect(blakeEvent.message.speakerId).toBe('blake');
    expect(blakeEvent.message.text).toBe('Full message test');
    expect(blakeEvent.message.timestamp).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('runTurn — error handling', () => {
  it('continues the round when a persona fails', async () => {
    const opts = createTestOptions({
      responseMap: {
        blake: createSpeakResponse('Blake OK'),
        yui: createSpeakResponse('Yui OK'),
        grant: createSpeakResponse('Grant OK'),
        julia: createSpeakResponse('Julia OK'),
      },
    });
    // Make execCommand fail for blake
    const originalExec = opts.execCommand;
    let callCount = 0;
    opts.execCommand = vi.fn((cmd, args, execOpts, cb) => {
      callCount++;
      if (callCount === 1) {
        // First persona fails
        process.nextTick(() => cb(new Error('CLI crashed'), '', ''));
        return;
      }
      return originalExec(cmd, args, execOpts, cb);
    });

    await runTurn(opts);

    // Round should still complete — 3 remaining personas get called
    // Total calls: 4 (1 failed + 3 succeeded)
    expect(opts.execCommand).toHaveBeenCalledTimes(4);
    // Done event should still be emitted
    const doneEvents = opts.onEvent.events.filter(e => e.type === 'done');
    expect(doneEvents).toHaveLength(1);
  });

  it('emits an error event when a persona fails', async () => {
    const opts = createTestOptions();
    let callCount = 0;
    opts.execCommand = vi.fn((cmd, args, execOpts, cb) => {
      callCount++;
      if (callCount === 1) {
        process.nextTick(() => cb(new Error('Boom'), '', ''));
        return;
      }
      // Success for others
      const envelope = {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: JSON.stringify(createSpeakResponse('OK')),
        session_id: 'test',
        duration_ms: 100,
      };
      process.nextTick(() => cb(null, JSON.stringify(envelope), ''));
    });

    await runTurn(opts);

    const errorEvents = opts.onEvent.events.filter(e => e.type === 'error');
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    expect(errorEvents[0].personaId).toBeDefined();
    expect(errorEvents[0].error).toBeDefined();
  });

  it('handles malformed JSON from claude gracefully', async () => {
    const opts = createTestOptions();
    let callCount = 0;
    opts.execCommand = vi.fn((cmd, args, execOpts, cb) => {
      callCount++;
      if (callCount === 1) {
        // Return malformed JSON
        process.nextTick(() => cb(null, 'not valid json at all', ''));
        return;
      }
      const envelope = {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: JSON.stringify(createSpeakResponse('OK')),
        session_id: 'test',
        duration_ms: 100,
      };
      process.nextTick(() => cb(null, JSON.stringify(envelope), ''));
    });

    await runTurn(opts);

    // Should emit error for malformed persona, continue for others
    const errorEvents = opts.onEvent.events.filter(e => e.type === 'error');
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    const doneEvents = opts.onEvent.events.filter(e => e.type === 'done');
    expect(doneEvents).toHaveLength(1);
  });

  it('handles buildPrompt failure gracefully', async () => {
    const opts = createTestOptions();
    let callCount = 0;
    opts.buildPrompt = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('System prompt file not found');
      }
      return 'Mock prompt';
    });

    await runTurn(opts);

    // Should emit error for the failed persona
    const errorEvents = opts.onEvent.events.filter(e => e.type === 'error');
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    // But still complete the round
    const doneEvents = opts.onEvent.events.filter(e => e.type === 'done');
    expect(doneEvents).toHaveLength(1);
  });

  it('handles all personas failing without crashing', async () => {
    const opts = createTestOptions();
    opts.execCommand = vi.fn((cmd, args, execOpts, cb) => {
      process.nextTick(() => cb(new Error('All fail'), '', ''));
    });

    await runTurn(opts);

    // Should still complete — no messages appended, but done event emitted
    const doneEvents = opts.onEvent.events.filter(e => e.type === 'done');
    expect(doneEvents).toHaveLength(1);
    const errorEvents = opts.onEvent.events.filter(e => e.type === 'error');
    expect(errorEvents).toHaveLength(4);
  });

  it('does not abort the round on persistence failure', async () => {
    const opts = createTestOptions({
      responseMap: {
        blake: createThinkResponse('Think entry'),
        yui: createSpeakResponse('Hello'),
        grant: createThinkResponse('...'),
        julia: createThinkResponse('...'),
      },
    });
    opts.persistence.appendMonologue = vi.fn(async () => {
      throw new Error('Disk full');
    });

    await runTurn(opts);

    // Round should still complete
    const doneEvents = opts.onEvent.events.filter(e => e.type === 'done');
    expect(doneEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Timeout handling
// ---------------------------------------------------------------------------

describe('runTurn — timeout handling', () => {
  it('passes timeout option to execCommand', async () => {
    const opts = createTestOptions();
    await runTurn(opts);

    // Every execCommand call should include a timeout option
    for (const call of opts.execCommand.mock.calls) {
      const execOpts = call[2]; // third argument is options
      expect(execOpts).toBeDefined();
      expect(execOpts.timeout).toBeDefined();
      expect(execOpts.timeout).toBe(120000); // 120 seconds
    }
  });

  it('handles timeout errors from execCommand', async () => {
    const opts = createTestOptions();
    let callCount = 0;
    opts.execCommand = vi.fn((cmd, args, execOpts, cb) => {
      callCount++;
      if (callCount === 1) {
        // Simulate timeout error
        const err = new Error('Command timed out');
        err.killed = true;
        err.signal = 'SIGTERM';
        process.nextTick(() => cb(err, '', ''));
        return;
      }
      const envelope = {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: JSON.stringify(createSpeakResponse('OK')),
        session_id: 'test',
        duration_ms: 100,
      };
      process.nextTick(() => cb(null, JSON.stringify(envelope), ''));
    });

    await runTurn(opts);

    // Should emit error event for timed out persona
    const errorEvents = opts.onEvent.events.filter(e => e.type === 'error');
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    // Should still complete the round
    const doneEvents = opts.onEvent.events.filter(e => e.type === 'done');
    expect(doneEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Persistence integration
// ---------------------------------------------------------------------------

describe('runTurn — persistence', () => {
  it('calls ensureSessionDir at the start', async () => {
    const opts = createTestOptions();
    await runTurn(opts);

    expect(opts.persistence.ensureSessionDir).toHaveBeenCalledWith(
      'test-session-001',
      '/tmp/test-base'
    );
  });

  it('reads monologue for each persona before building prompt', async () => {
    const opts = createTestOptions();
    await runTurn(opts);

    expect(opts.persistence.readMonologue).toHaveBeenCalledTimes(4);
    for (const id of AI_PERSONA_IDS) {
      expect(opts.persistence.readMonologue).toHaveBeenCalledWith(
        'test-session-001',
        id,
        '/tmp/test-base'
      );
    }
  });

  it('passes monologue entries to buildPrompt', async () => {
    const mockMonologue = [
      { timestamp: '2026-02-25T09:00:00.000Z', text: 'Earlier thought', type: 'think' },
    ];
    const opts = createTestOptions();
    opts.persistence.readMonologue = vi.fn(async () => mockMonologue);

    await runTurn(opts);

    // Each buildPrompt call should receive the monologue entries
    for (const call of opts.buildPrompt.mock.calls) {
      expect(call[0].monologue).toEqual(mockMonologue);
    }
  });

  it('writes session-chat.json after all personas complete', async () => {
    const opts = createTestOptions();
    await runTurn(opts);

    expect(opts.persistence.writeSessionChat).toHaveBeenCalledTimes(1);
    expect(opts.persistence.writeSessionChat).toHaveBeenCalledWith(
      'test-session-001',
      expect.any(Object),
      '/tmp/test-base'
    );
  });

  it('includes new messages in the written session data', async () => {
    const opts = createTestOptions({
      responseMap: {
        blake: createSpeakResponse('Blake spoke!'),
        yui: createThinkResponse('...'),
        grant: createThinkResponse('...'),
        julia: createThinkResponse('...'),
      },
    });
    await runTurn(opts);

    const writeCall = opts.persistence.writeSessionChat.mock.calls[0];
    const writtenData = writeCall[1];
    // Should have original message + blake's message
    expect(writtenData.messages.length).toBeGreaterThan(1);
    const blakeMsg = writtenData.messages.find(m => m.speakerId === 'blake');
    expect(blakeMsg).toBeDefined();
    expect(blakeMsg.text).toBe('Blake spoke!');
  });

  it('includes updated notes in the written session data', async () => {
    const opts = createTestOptions({
      notes: 'Initial notes.',
      responseMap: {
        blake: createSpeakResponse('Note update', 'Blake: New finding'),
        yui: createThinkResponse('...'),
        grant: createThinkResponse('...'),
        julia: createThinkResponse('...'),
      },
    });
    await runTurn(opts);

    const writeCall = opts.persistence.writeSessionChat.mock.calls[0];
    const writtenData = writeCall[1];
    expect(writtenData.notes.content).toContain('Blake: New finding');
  });
});

// ---------------------------------------------------------------------------
// Claude command construction
// ---------------------------------------------------------------------------

describe('runTurn — claude command construction', () => {
  it('calls execCommand with "claude" as the command', async () => {
    const opts = createTestOptions();
    await runTurn(opts);

    for (const call of opts.execCommand.mock.calls) {
      expect(call[0]).toBe('claude');
    }
  });

  it('includes -p flag with the prompt', async () => {
    const opts = createTestOptions();
    await runTurn(opts);

    for (const call of opts.execCommand.mock.calls) {
      const args = call[1];
      expect(args).toContain('-p');
    }
  });

  it('includes --output-format json', async () => {
    const opts = createTestOptions();
    await runTurn(opts);

    for (const call of opts.execCommand.mock.calls) {
      const args = call[1];
      expect(args).toContain('--output-format');
      expect(args).toContain('json');
    }
  });

  it('includes --model with the specified model', async () => {
    const opts = createTestOptions({ model: 'opus' });
    await runTurn(opts);

    for (const call of opts.execCommand.mock.calls) {
      const args = call[1];
      expect(args).toContain('--model');
      expect(args).toContain('opus');
    }
  });

  it('defaults model to "sonnet" when not specified', async () => {
    const opts = createTestOptions();
    delete opts.model;
    await runTurn(opts);

    for (const call of opts.execCommand.mock.calls) {
      const args = call[1];
      const modelIdx = args.indexOf('--model');
      expect(modelIdx).toBeGreaterThanOrEqual(0);
      expect(args[modelIdx + 1]).toBe('sonnet');
    }
  });

  it('includes --allowedTools with appropriate tools', async () => {
    const opts = createTestOptions();
    await runTurn(opts);

    for (const call of opts.execCommand.mock.calls) {
      const args = call[1];
      expect(args).toContain('--allowedTools');
      const toolsIdx = args.indexOf('--allowedTools');
      const toolsValue = args[toolsIdx + 1];
      expect(toolsValue).toContain('Read');
    }
  });

  it('includes permission bypass flags', async () => {
    const opts = createTestOptions();
    await runTurn(opts);

    for (const call of opts.execCommand.mock.calls) {
      const args = call[1];
      const argsStr = args.join(' ');
      // Should include some form of permission bypass
      expect(argsStr).toMatch(/--permission-mode|bypassPermissions/);
    }
  });
});

// ---------------------------------------------------------------------------
// Prompt building integration
// ---------------------------------------------------------------------------

describe('runTurn — prompt building', () => {
  it('passes correct systemPromptPath for each persona', async () => {
    const opts = createTestOptions();
    await runTurn(opts);

    for (const call of opts.buildPrompt.mock.calls) {
      const { personaId, systemPromptPath } = call[0];
      expect(systemPromptPath).toContain(`personas/${personaId}/system.md`);
    }
  });

  it('passes current messages to buildPrompt', async () => {
    const opts = createTestOptions();
    await runTurn(opts);

    for (const call of opts.buildPrompt.mock.calls) {
      const { messages } = call[0];
      expect(Array.isArray(messages)).toBe(true);
      expect(messages.length).toBeGreaterThanOrEqual(1); // At least the initial user message
    }
  });

  it('passes notes to buildPrompt', async () => {
    const opts = createTestOptions({ notes: 'Session notes content.' });
    await runTurn(opts);

    for (const call of opts.buildPrompt.mock.calls) {
      expect(call[0].notes).toBeDefined();
    }
  });

  it('passes attachedFiles to buildPrompt', async () => {
    const opts = createTestOptions({ attachedFiles: ['readme.md', 'data.csv'] });
    await runTurn(opts);

    for (const call of opts.buildPrompt.mock.calls) {
      expect(call[0].attachedFiles).toEqual(['readme.md', 'data.csv']);
    }
  });

  it('passes personas roster to buildPrompt', async () => {
    const opts = createTestOptions();
    await runTurn(opts);

    for (const call of opts.buildPrompt.mock.calls) {
      expect(call[0].personas).toEqual(PERSONAS);
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('runTurn — edge cases', () => {
  it('handles session with no AI personas gracefully', async () => {
    const opts = createTestOptions({
      personas: [
        { id: 'user', name: 'User', displayName: 'User', role: 'human' },
      ],
    });
    await runTurn(opts);

    // No personas to process — should complete immediately
    expect(opts.buildPrompt).not.toHaveBeenCalled();
    expect(opts.execCommand).not.toHaveBeenCalled();
    const doneEvents = opts.onEvent.events.filter(e => e.type === 'done');
    expect(doneEvents).toHaveLength(1);
  });

  it('handles empty personas array gracefully', async () => {
    const opts = createTestOptions({ personas: [] });
    await runTurn(opts);

    expect(opts.buildPrompt).not.toHaveBeenCalled();
    const doneEvents = opts.onEvent.events.filter(e => e.type === 'done');
    expect(doneEvents).toHaveLength(1);
  });

  it('all personas think — no messages added, round still completes', async () => {
    const opts = createTestOptions({
      responseMap: {
        blake: createThinkResponse('Thinking...'),
        yui: createThinkResponse('Also thinking...'),
        grant: createThinkResponse('Deep thought...'),
        julia: createThinkResponse('Pondering...'),
      },
    });
    const initialCount = opts.messages.length;
    await runTurn(opts);

    expect(opts.messages.length).toBe(initialCount);
    const doneEvents = opts.onEvent.events.filter(e => e.type === 'done');
    expect(doneEvents).toHaveLength(1);
  });

  it('all personas research — no messages added, round still completes', async () => {
    const opts = createTestOptions({
      responseMap: {
        blake: createResearchResponse('q1', 'f1'),
        yui: createResearchResponse('q2', 'f2'),
        grant: createResearchResponse('q3', 'f3'),
        julia: createResearchResponse('q4', 'f4'),
      },
    });
    const initialCount = opts.messages.length;
    await runTurn(opts);

    expect(opts.messages.length).toBe(initialCount);
  });

  it('handles mixed actions across personas', async () => {
    const opts = createTestOptions({
      responseMap: {
        blake: createSpeakResponse('Blake speaks!'),
        yui: createThinkResponse('Yui thinks'),
        grant: createResearchResponse('research q', 'research f'),
        julia: createSpeakResponse('Julia also speaks!', 'Julia: A note'),
      },
    });
    const initialCount = opts.messages.length;
    await runTurn(opts);

    // 2 speak actions = 2 new messages
    const newMessages = opts.messages.slice(initialCount);
    expect(newMessages).toHaveLength(2);

    // Check speak messages
    const speakers = newMessages.map(m => m.speakerId).sort();
    expect(speakers).toContain('blake');
    expect(speakers).toContain('julia');

    // Check think/research went to monologue
    const monologueCalls = opts.persistence.appendMonologue.mock.calls;
    const yuiMonologue = monologueCalls.find(c => c[1] === 'yui');
    expect(yuiMonologue).toBeDefined();
    expect(yuiMonologue[2].type).toBe('think');

    const grantMonologue = monologueCalls.find(c => c[1] === 'grant');
    expect(grantMonologue).toBeDefined();
    expect(grantMonologue[2].type).toBe('research');
  });

  it('persona name as substring does not cause false match', async () => {
    // "Grant" should not match "granting"
    const callOrder = [];
    const mockBuild = vi.fn(async ({ personaId }) => {
      callOrder.push(personaId);
      return `Prompt for ${personaId}`;
    });
    const opts = createTestOptions({
      buildPrompt: mockBuild,
      messages: [
        { id: 'msg-1', speakerId: 'user', timestamp: '2026-02-25T10:00:00.000Z', text: 'We are granting access to the system' },
      ],
    });

    // Run multiple times — if Grant always goes first, the word boundary check is broken
    const firstPersonas = new Set();
    for (let i = 0; i < 10; i++) {
      const order = [];
      opts.buildPrompt = vi.fn(async ({ personaId }) => {
        order.push(personaId);
        return `Prompt for ${personaId}`;
      });
      await runTurn(opts);
      firstPersonas.add(order[0]);
    }
    // With word boundary matching, "granting" should NOT match "Grant"
    // So order should be randomized — multiple different first personas
    expect(firstPersonas.size).toBeGreaterThan(1);
  });

  it('onEvent can be a no-op function without errors', async () => {
    const opts = createTestOptions({
      onEvent: () => {}, // no-op
    });
    await expect(runTurn(opts)).resolves.not.toThrow();
  });

  it('returns a result summary from runTurn', async () => {
    const opts = createTestOptions({
      responseMap: {
        blake: createSpeakResponse('Hello!'),
        yui: createThinkResponse('...'),
        grant: createResearchResponse('q', 'f'),
        julia: createSpeakResponse('Hi!'),
      },
    });
    const result = await runTurn(opts);

    // Should return some summary info
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// Session data construction for writeSessionChat
// ---------------------------------------------------------------------------

describe('runTurn — session data written to disk', () => {
  it('includes formatVersion in written session data', async () => {
    const opts = createTestOptions();
    await runTurn(opts);

    const writeCall = opts.persistence.writeSessionChat.mock.calls[0];
    const writtenData = writeCall[1];
    expect(writtenData.formatVersion).toBe('1.0');
  });

  it('includes session metadata in written data', async () => {
    const opts = createTestOptions();
    await runTurn(opts);

    const writeCall = opts.persistence.writeSessionChat.mock.calls[0];
    const writtenData = writeCall[1];
    expect(writtenData.session).toBeDefined();
    expect(writtenData.session.id).toBe('test-session-001');
  });

  it('includes personas in written data', async () => {
    const opts = createTestOptions();
    await runTurn(opts);

    const writeCall = opts.persistence.writeSessionChat.mock.calls[0];
    const writtenData = writeCall[1];
    expect(writtenData.personas).toEqual(PERSONAS);
  });

  it('updates session.updatedAt timestamp', async () => {
    const opts = createTestOptions();
    const before = new Date().toISOString();
    await runTurn(opts);
    const after = new Date().toISOString();

    const writeCall = opts.persistence.writeSessionChat.mock.calls[0];
    const writtenData = writeCall[1];
    expect(writtenData.session.updatedAt).toBeDefined();
    expect(writtenData.session.updatedAt >= before).toBe(true);
    expect(writtenData.session.updatedAt <= after).toBe(true);
  });

  it('preserves session.title from incoming session metadata', async () => {
    const opts = createTestOptions({
      session: { id: 'test-session-001', title: 'My Chat Title', startedAt: '2026-01-01T00:00:00Z' },
    });
    await runTurn(opts);

    const writeCall = opts.persistence.writeSessionChat.mock.calls[0];
    const writtenData = writeCall[1];
    expect(writtenData.session.title).toBe('My Chat Title');
  });

  it('preserves session.startedAt from incoming session metadata', async () => {
    const opts = createTestOptions({
      session: { id: 'test-session-001', startedAt: '2026-01-01T00:00:00Z', title: 'Test' },
    });
    await runTurn(opts);

    const writeCall = opts.persistence.writeSessionChat.mock.calls[0];
    const writtenData = writeCall[1];
    expect(writtenData.session.startedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('preserves session.topic from incoming session metadata', async () => {
    const opts = createTestOptions({
      session: { id: 'test-session-001', topic: 'Architecture Discussion' },
    });
    await runTurn(opts);

    const writeCall = opts.persistence.writeSessionChat.mock.calls[0];
    const writtenData = writeCall[1];
    expect(writtenData.session.topic).toBe('Architecture Discussion');
  });

  it('overrides session.updatedAt even when incoming session has one', async () => {
    const opts = createTestOptions({
      session: { id: 'test-session-001', updatedAt: '2020-01-01T00:00:00Z' },
    });
    const before = new Date().toISOString();
    await runTurn(opts);

    const writeCall = opts.persistence.writeSessionChat.mock.calls[0];
    const writtenData = writeCall[1];
    // updatedAt should be fresh, not the old one
    expect(writtenData.session.updatedAt >= before).toBe(true);
  });

  it('uses sessionId as session.id even when incoming session has a different id', async () => {
    const opts = createTestOptions({
      session: { id: 'different-id', title: 'Test' },
    });
    await runTurn(opts);

    const writeCall = opts.persistence.writeSessionChat.mock.calls[0];
    const writtenData = writeCall[1];
    expect(writtenData.session.id).toBe('test-session-001');
  });

  it('works correctly when no session metadata is provided (backward compat)', async () => {
    const opts = createTestOptions();
    // No session field — should still work as before
    await runTurn(opts);

    const writeCall = opts.persistence.writeSessionChat.mock.calls[0];
    const writtenData = writeCall[1];
    expect(writtenData.session.id).toBe('test-session-001');
    expect(writtenData.session.updatedAt).toBeDefined();
  });
});
