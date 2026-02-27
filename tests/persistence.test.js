/**
 * Tests for lib/persistence.js
 * TDD: tests written FIRST, verified failing, then implementation added.
 *
 * Functions tested:
 *   readMonologue(sessionId, personaId, basePath)
 *   appendMonologue(sessionId, personaId, entry, basePath)
 *   writeSessionChat(sessionId, sessionData, basePath)
 *   ensureSessionDir(sessionId, basePath)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

// Module under test — imported after each test so we can verify on fresh state
let readMonologue, appendMonologue, writeSessionChat, ensureSessionDir, writePersonaStatus, readSessionStatuses;

beforeEach(async () => {
  const mod = await import('../lib/persistence.js');
  readMonologue = mod.readMonologue;
  appendMonologue = mod.appendMonologue;
  writeSessionChat = mod.writeSessionChat;
  ensureSessionDir = mod.ensureSessionDir;
  writePersonaStatus = mod.writePersonaStatus;
  readSessionStatuses = mod.readSessionStatuses;
});

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

/**
 * Create a fresh temp directory for each test suite.
 * Callers are responsible for cleanup in afterEach.
 */
async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ott-persistence-test-'));
}

// ---------------------------------------------------------------------------
// readMonologue
// ---------------------------------------------------------------------------

describe('readMonologue', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns an empty array when the monologue file does not exist', async () => {
    const result = await readMonologue('session-001', 'blake', tmpDir);
    expect(result).toEqual([]);
  });

  it('returns an empty array when the session directory does not exist', async () => {
    const result = await readMonologue('nonexistent-session', 'yui', tmpDir);
    expect(result).toEqual([]);
  });

  it('reads and parses an existing monologue file', async () => {
    // Set up the file manually
    const sessionDir = path.join(tmpDir, 'chats', 'session-001');
    await fs.mkdir(sessionDir, { recursive: true });

    const entries = [
      { timestamp: '2026-02-25T10:00:00.000Z', text: 'First thought', type: 'think' },
      { timestamp: '2026-02-25T10:01:00.000Z', text: 'Research findings here', type: 'research' },
    ];
    await fs.writeFile(
      path.join(sessionDir, 'monologue-blake.json'),
      JSON.stringify(entries, null, 2),
      'utf8'
    );

    const result = await readMonologue('session-001', 'blake', tmpDir);
    expect(result).toEqual(entries);
  });

  it('reads monologue for the correct persona file', async () => {
    const sessionDir = path.join(tmpDir, 'chats', 'session-abc');
    await fs.mkdir(sessionDir, { recursive: true });

    const blakeEntries = [{ timestamp: '2026-02-25T10:00:00.000Z', text: 'Blake thought', type: 'think' }];
    const yuiEntries = [{ timestamp: '2026-02-25T10:05:00.000Z', text: 'Yui thought', type: 'think' }];

    await fs.writeFile(
      path.join(sessionDir, 'monologue-blake.json'),
      JSON.stringify(blakeEntries, null, 2),
      'utf8'
    );
    await fs.writeFile(
      path.join(sessionDir, 'monologue-yui.json'),
      JSON.stringify(yuiEntries, null, 2),
      'utf8'
    );

    const blakeResult = await readMonologue('session-abc', 'blake', tmpDir);
    const yuiResult = await readMonologue('session-abc', 'yui', tmpDir);

    expect(blakeResult).toEqual(blakeEntries);
    expect(yuiResult).toEqual(yuiEntries);
  });

  it('returns an empty array when monologue file is empty JSON array', async () => {
    const sessionDir = path.join(tmpDir, 'chats', 'session-empty');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, 'monologue-grant.json'),
      '[]',
      'utf8'
    );

    const result = await readMonologue('session-empty', 'grant', tmpDir);
    expect(result).toEqual([]);
  });

  it('preserves all entry fields (timestamp, text, type)', async () => {
    const sessionDir = path.join(tmpDir, 'chats', 'session-fields');
    await fs.mkdir(sessionDir, { recursive: true });

    const entries = [
      { timestamp: '2026-02-25T12:00:00.000Z', text: 'Strategy note', type: 'think' },
      { timestamp: '2026-02-25T12:30:00.000Z', text: 'Research on competitors', type: 'research' },
    ];
    await fs.writeFile(
      path.join(sessionDir, 'monologue-julia.json'),
      JSON.stringify(entries, null, 2),
      'utf8'
    );

    const result = await readMonologue('session-fields', 'julia', tmpDir);
    expect(result).toHaveLength(2);
    expect(result[0].timestamp).toBe('2026-02-25T12:00:00.000Z');
    expect(result[0].text).toBe('Strategy note');
    expect(result[0].type).toBe('think');
    expect(result[1].type).toBe('research');
  });
});

// ---------------------------------------------------------------------------
// appendMonologue
// ---------------------------------------------------------------------------

describe('appendMonologue', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates the monologue file when it does not exist', async () => {
    const entry = { timestamp: '2026-02-25T10:00:00.000Z', text: 'First thought', type: 'think' };
    await appendMonologue('session-new', 'blake', entry, tmpDir);

    const filePath = path.join(tmpDir, 'chats', 'session-new', 'monologue-blake.json');
    const exists = await fs.stat(filePath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it('creates the session directory if it does not exist', async () => {
    const entry = { timestamp: '2026-02-25T10:00:00.000Z', text: 'Thought', type: 'think' };
    await appendMonologue('brand-new-session', 'yui', entry, tmpDir);

    const dirPath = path.join(tmpDir, 'chats', 'brand-new-session');
    const stats = await fs.stat(dirPath);
    expect(stats.isDirectory()).toBe(true);
  });

  it('stores the entry as a JSON array with the entry inside', async () => {
    const entry = { timestamp: '2026-02-25T10:00:00.000Z', text: 'My first thought', type: 'think' };
    await appendMonologue('session-001', 'blake', entry, tmpDir);

    const filePath = path.join(tmpDir, 'chats', 'session-001', 'monologue-blake.json');
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(entry);
  });

  it('appends to existing entries rather than overwriting', async () => {
    const entry1 = { timestamp: '2026-02-25T10:00:00.000Z', text: 'First thought', type: 'think' };
    const entry2 = { timestamp: '2026-02-25T10:01:00.000Z', text: 'Second thought', type: 'research' };

    await appendMonologue('session-append', 'grant', entry1, tmpDir);
    await appendMonologue('session-append', 'grant', entry2, tmpDir);

    const filePath = path.join(tmpDir, 'chats', 'session-append', 'monologue-grant.json');
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual(entry1);
    expect(parsed[1]).toEqual(entry2);
  });

  it('appends multiple entries sequentially to the same file', async () => {
    const entries = [
      { timestamp: '2026-02-25T10:00:00.000Z', text: 'Entry 1', type: 'think' },
      { timestamp: '2026-02-25T10:01:00.000Z', text: 'Entry 2', type: 'think' },
      { timestamp: '2026-02-25T10:02:00.000Z', text: 'Entry 3', type: 'research' },
    ];

    for (const entry of entries) {
      await appendMonologue('session-multi', 'julia', entry, tmpDir);
    }

    const filePath = path.join(tmpDir, 'chats', 'session-multi', 'monologue-julia.json');
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);

    expect(parsed).toHaveLength(3);
    expect(parsed).toEqual(entries);
  });

  it('writes valid JSON that can be read back by readMonologue', async () => {
    const entry = { timestamp: '2026-02-25T11:00:00.000Z', text: 'Cross-function test', type: 'think' };
    await appendMonologue('session-roundtrip', 'blake', entry, tmpDir);

    const result = await readMonologue('session-roundtrip', 'blake', tmpDir);
    expect(result).toEqual([entry]);
  });

  it('creates a separate file for each persona', async () => {
    const blakeEntry = { timestamp: '2026-02-25T10:00:00.000Z', text: 'Blake thinks', type: 'think' };
    const yuiEntry = { timestamp: '2026-02-25T10:01:00.000Z', text: 'Yui thinks', type: 'think' };

    await appendMonologue('session-multi-persona', 'blake', blakeEntry, tmpDir);
    await appendMonologue('session-multi-persona', 'yui', yuiEntry, tmpDir);

    const blakeResult = await readMonologue('session-multi-persona', 'blake', tmpDir);
    const yuiResult = await readMonologue('session-multi-persona', 'yui', tmpDir);

    expect(blakeResult).toEqual([blakeEntry]);
    expect(yuiResult).toEqual([yuiEntry]);
  });

  it('writes pretty-printed JSON (2-space indent)', async () => {
    const entry = { timestamp: '2026-02-25T10:00:00.000Z', text: 'Pretty print check', type: 'think' };
    await appendMonologue('session-pretty', 'blake', entry, tmpDir);

    const filePath = path.join(tmpDir, 'chats', 'session-pretty', 'monologue-blake.json');
    const raw = await fs.readFile(filePath, 'utf8');

    // Pretty printed JSON should have newlines and spaces
    expect(raw).toContain('\n');
    expect(raw).toContain('  ');
  });
});

// ---------------------------------------------------------------------------
// writeSessionChat
// ---------------------------------------------------------------------------

describe('writeSessionChat', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes session data as JSON to chats/<id>/session-chat.json', async () => {
    // Ensure directory exists first
    const sessionDir = path.join(tmpDir, 'chats', 'session-write');
    await fs.mkdir(sessionDir, { recursive: true });

    const sessionData = {
      formatVersion: '1.0',
      session: { id: 'session-write', title: 'Test Session' },
      messages: [],
    };

    await writeSessionChat('session-write', sessionData, tmpDir);

    const filePath = path.join(tmpDir, 'chats', 'session-write', 'session-chat.json');
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);

    expect(parsed).toEqual(sessionData);
  });

  it('creates the session directory if it does not exist', async () => {
    const sessionData = {
      formatVersion: '1.0',
      session: { id: 'session-auto-dir' },
      messages: [],
    };

    await writeSessionChat('session-auto-dir', sessionData, tmpDir);

    const filePath = path.join(tmpDir, 'chats', 'session-auto-dir', 'session-chat.json');
    const exists = await fs.stat(filePath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it('overwrites an existing session-chat.json file', async () => {
    const sessionDir = path.join(tmpDir, 'chats', 'session-overwrite');
    await fs.mkdir(sessionDir, { recursive: true });

    // Write initial version
    const initial = { formatVersion: '1.0', session: { id: 'session-overwrite' }, messages: [] };
    await writeSessionChat('session-overwrite', initial, tmpDir);

    // Overwrite with updated version
    const updated = {
      ...initial,
      messages: [{ id: 'msg-1', speakerId: 'blake', timestamp: '2026-02-25T10:00:00.000Z', text: 'Hello' }],
    };
    await writeSessionChat('session-overwrite', updated, tmpDir);

    const filePath = path.join(tmpDir, 'chats', 'session-overwrite', 'session-chat.json');
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].text).toBe('Hello');
  });

  it('writes pretty-printed JSON with 2-space indent', async () => {
    const sessionDir = path.join(tmpDir, 'chats', 'session-pretty');
    await fs.mkdir(sessionDir, { recursive: true });

    const sessionData = { formatVersion: '1.0', session: { id: 'session-pretty' }, messages: [] };
    await writeSessionChat('session-pretty', sessionData, tmpDir);

    const filePath = path.join(tmpDir, 'chats', 'session-pretty', 'session-chat.json');
    const raw = await fs.readFile(filePath, 'utf8');

    // Pretty-printed JSON should contain newlines and 2-space indent
    expect(raw).toContain('\n');
    expect(raw).toContain('  ');
    // Check that 2-space indent is used (not 4)
    expect(raw).toContain('  "formatVersion"');
  });

  it('preserves all session fields faithfully', async () => {
    const sessionDir = path.join(tmpDir, 'chats', 'session-full');
    await fs.mkdir(sessionDir, { recursive: true });

    const sessionData = {
      formatVersion: '1.0',
      session: {
        id: 'session-full',
        title: 'Full Session',
        startedAt: '2026-02-25T09:00:00.000Z',
        updatedAt: '2026-02-25T10:00:00.000Z',
        topic: 'Testing persistence',
      },
      personas: [{ id: 'blake', name: 'Blake', displayName: 'Blake', role: 'ai-persona' }],
      notes: { content: 'Some notes here' },
      messages: [
        { id: 'msg-1', speakerId: 'blake', timestamp: '2026-02-25T09:30:00.000Z', text: 'Hello world' },
      ],
    };

    await writeSessionChat('session-full', sessionData, tmpDir);

    const filePath = path.join(tmpDir, 'chats', 'session-full', 'session-chat.json');
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);

    expect(parsed).toEqual(sessionData);
    expect(parsed.personas).toHaveLength(1);
    expect(parsed.notes.content).toBe('Some notes here');
    expect(parsed.messages[0].text).toBe('Hello world');
  });

  it('writes to the correct path (chats/<sessionId>/session-chat.json)', async () => {
    const sessionData = { formatVersion: '1.0', session: { id: 'my-unique-id' }, messages: [] };
    await writeSessionChat('my-unique-id', sessionData, tmpDir);

    const expectedPath = path.join(tmpDir, 'chats', 'my-unique-id', 'session-chat.json');
    const exists = await fs.stat(expectedPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    // Verify the file is NOT at any other path
    const wrongPath = path.join(tmpDir, 'session-chat.json');
    const wrongExists = await fs.stat(wrongPath).then(() => true).catch(() => false);
    expect(wrongExists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ensureSessionDir
// ---------------------------------------------------------------------------

describe('ensureSessionDir', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates the chats/<id>/ directory when it does not exist', async () => {
    await ensureSessionDir('new-session', tmpDir);

    const dirPath = path.join(tmpDir, 'chats', 'new-session');
    const stats = await fs.stat(dirPath);
    expect(stats.isDirectory()).toBe(true);
  });

  it('does not throw if the directory already exists', async () => {
    // Create directory first
    const dirPath = path.join(tmpDir, 'chats', 'existing-session');
    await fs.mkdir(dirPath, { recursive: true });

    // Calling ensureSessionDir again should not throw
    await expect(ensureSessionDir('existing-session', tmpDir)).resolves.not.toThrow();
  });

  it('creates nested directories (chats/<id>/) using recursive mkdir', async () => {
    // The 'chats' parent doesn't exist yet — recursive mkdir should handle it
    await ensureSessionDir('deeply-nested', tmpDir);

    const dirPath = path.join(tmpDir, 'chats', 'deeply-nested');
    const stats = await fs.stat(dirPath);
    expect(stats.isDirectory()).toBe(true);
  });

  it('is idempotent — calling multiple times has the same result', async () => {
    await ensureSessionDir('idempotent-session', tmpDir);
    await ensureSessionDir('idempotent-session', tmpDir);
    await ensureSessionDir('idempotent-session', tmpDir);

    const dirPath = path.join(tmpDir, 'chats', 'idempotent-session');
    const stats = await fs.stat(dirPath);
    expect(stats.isDirectory()).toBe(true);
  });

  it('creates separate directories for different session IDs', async () => {
    await ensureSessionDir('session-a', tmpDir);
    await ensureSessionDir('session-b', tmpDir);

    const dirA = path.join(tmpDir, 'chats', 'session-a');
    const dirB = path.join(tmpDir, 'chats', 'session-b');

    const statsA = await fs.stat(dirA);
    const statsB = await fs.stat(dirB);

    expect(statsA.isDirectory()).toBe(true);
    expect(statsB.isDirectory()).toBe(true);
  });

  it('works with session IDs that look like local chat IDs (timestamp-based)', async () => {
    const localId = 'local-1740484800000';
    await ensureSessionDir(localId, tmpDir);

    const dirPath = path.join(tmpDir, 'chats', localId);
    const stats = await fs.stat(dirPath);
    expect(stats.isDirectory()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: full round-trip workflow
// ---------------------------------------------------------------------------

describe('Full persistence round-trip', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('complete turn workflow: ensure dir, append monologue entries, write session', async () => {
    const sessionId = 'integration-session';

    // Step 1: Ensure session directory exists
    await ensureSessionDir(sessionId, tmpDir);

    // Step 2: Read monologue before any entries (should be empty)
    const initialMonologue = await readMonologue(sessionId, 'blake', tmpDir);
    expect(initialMonologue).toEqual([]);

    // Step 3: Persona thinks during turn
    const thinkEntry = {
      timestamp: new Date().toISOString(),
      text: 'This is a good approach',
      type: 'think',
    };
    await appendMonologue(sessionId, 'blake', thinkEntry, tmpDir);

    // Step 4: Persona does research during turn
    const researchEntry = {
      timestamp: new Date().toISOString(),
      text: 'Found relevant information about the topic',
      type: 'research',
    };
    await appendMonologue(sessionId, 'blake', researchEntry, tmpDir);

    // Step 5: Write updated session after turn completes
    const sessionData = {
      formatVersion: '1.0',
      session: { id: sessionId, title: 'Integration Test' },
      messages: [
        { id: 'msg-1', speakerId: 'user', timestamp: thinkEntry.timestamp, text: 'Hello everyone' },
        { id: 'msg-2', speakerId: 'blake', timestamp: researchEntry.timestamp, text: 'Great question!' },
      ],
      notes: { content: '' },
    };
    await writeSessionChat(sessionId, sessionData, tmpDir);

    // Step 6: Verify monologue was written correctly
    const finalMonologue = await readMonologue(sessionId, 'blake', tmpDir);
    expect(finalMonologue).toHaveLength(2);
    expect(finalMonologue[0]).toEqual(thinkEntry);
    expect(finalMonologue[1]).toEqual(researchEntry);

    // Step 7: Verify session chat was written correctly
    const sessionChatPath = path.join(tmpDir, 'chats', sessionId, 'session-chat.json');
    const raw = await fs.readFile(sessionChatPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[1].text).toBe('Great question!');
  });

  it('multiple personas can have independent monologues in same session', async () => {
    const sessionId = 'multi-persona-session';

    const personaIds = ['blake', 'yui', 'grant', 'julia'];

    // Each persona gets their own monologue entries
    for (const personaId of personaIds) {
      await appendMonologue(
        sessionId,
        personaId,
        { timestamp: new Date().toISOString(), text: `${personaId} is thinking`, type: 'think' },
        tmpDir
      );
    }

    // Each persona's monologue should only have their own entry
    for (const personaId of personaIds) {
      const monologue = await readMonologue(sessionId, personaId, tmpDir);
      expect(monologue).toHaveLength(1);
      expect(monologue[0].text).toBe(`${personaId} is thinking`);
    }
  });
});

describe('persona status persistence', () => {
	let tmpDir;

	beforeEach(async () => {
		tmpDir = await makeTempDir();
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it('writes a status file per persona', async () => {
		await writePersonaStatus(
			'session-status',
			'blake',
			{ personaName: 'Blake', phase: 'executing_action', action: 'speak', actionType: 'raise_upside' },
			tmpDir
		);

		const filePath = path.join(tmpDir, 'chats', 'session-status', 'status-blake.json');
		const raw = await fs.readFile(filePath, 'utf8');
		const parsed = JSON.parse(raw);
		expect(parsed.personaId).toBe('blake');
		expect(parsed.actionType).toBe('raise_upside');
	});

	it('reads all status files for a session', async () => {
		await writePersonaStatus(
			'session-status-read',
			'blake',
			{ personaName: 'Blake', phase: 'deciding_action', action: null, actionType: null },
			tmpDir
		);
		await writePersonaStatus(
			'session-status-read',
			'yui',
			{ personaName: 'Yui', phase: 'executing_action', action: 'research', actionType: 'research' },
			tmpDir
		);

		const statuses = await readSessionStatuses('session-status-read', tmpDir);
		expect(statuses).toHaveLength(2);
		expect(statuses.map((s) => s.personaId).sort()).toEqual(['blake', 'yui']);
	});
});
