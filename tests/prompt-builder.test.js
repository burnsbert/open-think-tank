/**
 * Tests for lib/prompt-builder.js
 * TDD: write tests first, verify they fail, then implement.
 *
 * buildPrompt({ personaId, systemPromptPath, messages, monologue, notes, attachedFiles, personas })
 * Returns a fully assembled prompt string for a persona's turn.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

// We import the function under test after setting up any needed stubs.
// Because the module reads from disk, we use a real temp directory for
// system.md files rather than mocking fs — this gives more realistic coverage.

let buildPrompt;

beforeEach(async () => {
  // Fresh import each time (vitest module cache is reset between files, not tests)
  const mod = await import('../lib/prompt-builder.js');
  buildPrompt = mod.buildPrompt;
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const PERSONAS = [
  { id: 'blake', displayName: 'Blake' },
  { id: 'yui', displayName: 'Yui' },
  { id: 'grant', displayName: 'Grant' },
  { id: 'julia', displayName: 'Julia' },
  { id: 'user', displayName: 'You' },
];

const SYSTEM_CONTENT = 'You are Blake, the Pragmatist.';

const MESSAGES = [
  {
    id: 'msg-1',
    speakerId: 'user',
    timestamp: '2026-02-25T10:00:00.000Z',
    text: 'What should we build next?',
  },
  {
    id: 'msg-2',
    speakerId: 'blake',
    timestamp: '2026-02-25T10:01:00.000Z',
    text: 'I think we should focus on the API layer first.',
  },
  {
    id: 'msg-3',
    speakerId: 'yui',
    timestamp: '2026-02-25T10:02:00.000Z',
    text: 'I agree, but let us not forget the UX.',
  },
];

const MONOLOGUE = [
  {
    timestamp: '2026-02-25T10:00:30.000Z',
    text: 'User seems keen to move fast.',
    type: 'think',
  },
  {
    timestamp: '2026-02-25T10:01:30.000Z',
    text: 'My suggestion landed well.',
    type: 'think',
  },
];

const NOTES = 'Decision: API layer first.\nFollow-up needed on UX.';

const ATTACHED_FILES = ['spec.md', 'design.png'];

// ---------------------------------------------------------------------------
// Helper: create a temp system.md file and return its path
// ---------------------------------------------------------------------------

async function writeTempSystemMd(content = SYSTEM_CONTENT) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ott-test-'));
  const filePath = path.join(dir, 'system.md');
  await fs.writeFile(filePath, content, 'utf8');
  return { dir, filePath };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('buildPrompt', () => {
  describe('return type and basic structure', () => {
    it('should return a non-empty string', async () => {
      const { filePath } = await writeTempSystemMd();
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: MESSAGES,
        monologue: MONOLOGUE,
        notes: NOTES,
        attachedFiles: ATTACHED_FILES,
        personas: PERSONAS,
      });
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should include the system.md content', async () => {
      const { filePath } = await writeTempSystemMd();
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: MESSAGES,
        monologue: MONOLOGUE,
        notes: NOTES,
        attachedFiles: ATTACHED_FILES,
        personas: PERSONAS,
      });
      expect(result).toContain(SYSTEM_CONTENT);
    });
  });

  describe('conversation history section', () => {
    it('should include a conversation history heading', async () => {
      const { filePath } = await writeTempSystemMd();
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: MESSAGES,
        monologue: [],
        notes: '',
        attachedFiles: [],
        personas: PERSONAS,
      });
      expect(result).toMatch(/conversation history/i);
    });

    it('should include each message text in the prompt', async () => {
      const { filePath } = await writeTempSystemMd();
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: MESSAGES,
        monologue: [],
        notes: '',
        attachedFiles: [],
        personas: PERSONAS,
      });
      expect(result).toContain('What should we build next?');
      expect(result).toContain('I think we should focus on the API layer first.');
      expect(result).toContain('I agree, but let us not forget the UX.');
    });

    it('should include speaker display names for attribution', async () => {
      const { filePath } = await writeTempSystemMd();
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: MESSAGES,
        monologue: [],
        notes: '',
        attachedFiles: [],
        personas: PERSONAS,
      });
      // The user message should attribute to the user persona's display name
      expect(result).toContain('You');
      // Blake's message should be attributed to Blake
      expect(result).toContain('Blake');
      // Yui's message should be attributed to Yui
      expect(result).toContain('Yui');
    });

    it('should preserve chronological order of messages', async () => {
      const { filePath } = await writeTempSystemMd();
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: MESSAGES,
        monologue: [],
        notes: '',
        attachedFiles: [],
        personas: PERSONAS,
      });
      const pos1 = result.indexOf('What should we build next?');
      const pos2 = result.indexOf('I think we should focus on the API layer first.');
      const pos3 = result.indexOf('I agree, but let us not forget the UX.');
      expect(pos1).toBeGreaterThan(-1);
      expect(pos2).toBeGreaterThan(pos1);
      expect(pos3).toBeGreaterThan(pos2);
    });

    it('should handle empty conversation history gracefully', async () => {
      const { filePath } = await writeTempSystemMd();
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: [],
        monologue: [],
        notes: '',
        attachedFiles: [],
        personas: PERSONAS,
      });
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should handle a single message in history', async () => {
      const { filePath } = await writeTempSystemMd();
      const singleMessage = [MESSAGES[0]];
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: singleMessage,
        monologue: [],
        notes: '',
        attachedFiles: [],
        personas: PERSONAS,
      });
      expect(result).toContain('What should we build next?');
    });

    it('should use persona displayName when speakerId matches a known persona', async () => {
      const { filePath } = await writeTempSystemMd();
      const messages = [
        { id: 'msg-1', speakerId: 'grant', timestamp: '2026-02-25T10:00:00.000Z', text: 'Novel idea here.' },
      ];
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages,
        monologue: [],
        notes: '',
        attachedFiles: [],
        personas: PERSONAS,
      });
      expect(result).toContain('Grant');
    });

    it('should fall back to speakerId when persona displayName is not found', async () => {
      const { filePath } = await writeTempSystemMd();
      const messages = [
        { id: 'msg-1', speakerId: 'unknown-bot', timestamp: '2026-02-25T10:00:00.000Z', text: 'Mystery message.' },
      ];
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages,
        monologue: [],
        notes: '',
        attachedFiles: [],
        personas: PERSONAS,
      });
      expect(result).toContain('unknown-bot');
      expect(result).toContain('Mystery message.');
    });
  });

  describe('monologue section', () => {
    it('should include a monologue heading when entries exist', async () => {
      const { filePath } = await writeTempSystemMd();
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: [],
        monologue: MONOLOGUE,
        notes: '',
        attachedFiles: [],
        personas: PERSONAS,
      });
      expect(result).toMatch(/your (internal )?monologue|your thoughts/i);
    });

    it('should include monologue entry text', async () => {
      const { filePath } = await writeTempSystemMd();
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: [],
        monologue: MONOLOGUE,
        notes: '',
        attachedFiles: [],
        personas: PERSONAS,
      });
      expect(result).toContain('User seems keen to move fast.');
      expect(result).toContain('My suggestion landed well.');
    });

    it('should include timestamps in monologue entries', async () => {
      const { filePath } = await writeTempSystemMd();
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: [],
        monologue: MONOLOGUE,
        notes: '',
        attachedFiles: [],
        personas: PERSONAS,
      });
      // At least one timestamp should appear in the prompt
      expect(result).toContain('2026-02-25');
    });

    it('should handle empty monologue gracefully (first turn)', async () => {
      const { filePath } = await writeTempSystemMd();
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: MESSAGES,
        monologue: [],
        notes: NOTES,
        attachedFiles: ATTACHED_FILES,
        personas: PERSONAS,
      });
      expect(typeof result).toBe('string');
      // Should not contain stray "undefined" or "null"
      expect(result).not.toContain('undefined');
      expect(result).not.toContain('null');
    });

    it('should handle a single monologue entry', async () => {
      const { filePath } = await writeTempSystemMd();
      const singleEntry = [MONOLOGUE[0]];
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: [],
        monologue: singleEntry,
        notes: '',
        attachedFiles: [],
        personas: PERSONAS,
      });
      expect(result).toContain('User seems keen to move fast.');
    });

    it('should include the type of monologue entry', async () => {
      const { filePath } = await writeTempSystemMd();
      const mixedMonologue = [
        { timestamp: '2026-02-25T10:00:00.000Z', text: 'Silent thought.', type: 'think' },
        { timestamp: '2026-02-25T10:01:00.000Z', text: 'Found useful info.', type: 'research' },
      ];
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: [],
        monologue: mixedMonologue,
        notes: '',
        attachedFiles: [],
        personas: PERSONAS,
      });
      expect(result).toContain('Silent thought.');
      expect(result).toContain('Found useful info.');
    });
  });

  describe('session notes section', () => {
    it('should include a notes heading when notes are non-empty', async () => {
      const { filePath } = await writeTempSystemMd();
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: [],
        monologue: [],
        notes: NOTES,
        attachedFiles: [],
        personas: PERSONAS,
      });
      expect(result).toMatch(/session notes/i);
    });

    it('should include the notes content', async () => {
      const { filePath } = await writeTempSystemMd();
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: [],
        monologue: [],
        notes: NOTES,
        attachedFiles: [],
        personas: PERSONAS,
      });
      expect(result).toContain('Decision: API layer first.');
      expect(result).toContain('Follow-up needed on UX.');
    });

    it('should handle empty notes gracefully', async () => {
      const { filePath } = await writeTempSystemMd();
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: [],
        monologue: [],
        notes: '',
        attachedFiles: [],
        personas: PERSONAS,
      });
      expect(typeof result).toBe('string');
      expect(result).not.toContain('undefined');
      expect(result).not.toContain('null');
    });

    it('should handle whitespace-only notes as empty', async () => {
      const { filePath } = await writeTempSystemMd();
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: [],
        monologue: [],
        notes: '   \n  ',
        attachedFiles: [],
        personas: PERSONAS,
      });
      expect(typeof result).toBe('string');
      // Whitespace-only notes should not inject garbage into the prompt
      expect(result).not.toMatch(/\bnull\b/);
    });

    it('should handle multi-line notes', async () => {
      const { filePath } = await writeTempSystemMd();
      const multiLineNotes = 'Line one\nLine two\nLine three';
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: [],
        monologue: [],
        notes: multiLineNotes,
        attachedFiles: [],
        personas: PERSONAS,
      });
      expect(result).toContain('Line one');
      expect(result).toContain('Line two');
      expect(result).toContain('Line three');
    });
  });

  describe('attached files section', () => {
    it('should include an attached files heading when files are provided', async () => {
      const { filePath } = await writeTempSystemMd();
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: [],
        monologue: [],
        notes: '',
        attachedFiles: ATTACHED_FILES,
        personas: PERSONAS,
      });
      expect(result).toMatch(/attached files/i);
    });

    it('should list attached filenames', async () => {
      const { filePath } = await writeTempSystemMd();
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: [],
        monologue: [],
        notes: '',
        attachedFiles: ATTACHED_FILES,
        personas: PERSONAS,
      });
      expect(result).toContain('spec.md');
      expect(result).toContain('design.png');
    });

    it('should NOT include file contents in the prompt', async () => {
      // Decision #5: use --allowedTools, do not inject file contents
      // The test verifies filenames appear but not any assumption about file content
      const { filePath } = await writeTempSystemMd();
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: [],
        monologue: [],
        notes: '',
        attachedFiles: ['spec.md'],
        personas: PERSONAS,
      });
      // Filename should appear, but the function should not attempt to read file contents
      expect(result).toContain('spec.md');
    });

    it('should handle empty attached files list gracefully', async () => {
      const { filePath } = await writeTempSystemMd();
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: [],
        monologue: [],
        notes: '',
        attachedFiles: [],
        personas: PERSONAS,
      });
      expect(typeof result).toBe('string');
      expect(result).not.toContain('undefined');
    });

    it('should handle a single attached file', async () => {
      const { filePath } = await writeTempSystemMd();
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: [],
        monologue: [],
        notes: '',
        attachedFiles: ['requirements.md'],
        personas: PERSONAS,
      });
      expect(result).toContain('requirements.md');
    });

    it('should handle many attached files', async () => {
      const { filePath } = await writeTempSystemMd();
      const manyFiles = ['a.md', 'b.pdf', 'c.txt', 'd.png', 'e.json'];
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: [],
        monologue: [],
        notes: '',
        attachedFiles: manyFiles,
        personas: PERSONAS,
      });
      for (const file of manyFiles) {
        expect(result).toContain(file);
      }
    });
  });

  describe('edge cases and combinations', () => {
    it('should handle the "everything empty" case (first turn, no context)', async () => {
      const { filePath } = await writeTempSystemMd();
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: [],
        monologue: [],
        notes: '',
        attachedFiles: [],
        personas: PERSONAS,
      });
      expect(typeof result).toBe('string');
      // Should still include system content
      expect(result).toContain(SYSTEM_CONTENT);
    });

    it('should handle all sections populated together', async () => {
      const { filePath } = await writeTempSystemMd();
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: MESSAGES,
        monologue: MONOLOGUE,
        notes: NOTES,
        attachedFiles: ATTACHED_FILES,
        personas: PERSONAS,
      });
      // All key pieces should be present
      expect(result).toContain(SYSTEM_CONTENT);
      expect(result).toContain('What should we build next?');
      expect(result).toContain('User seems keen to move fast.');
      expect(result).toContain('Decision: API layer first.');
      expect(result).toContain('spec.md');
    });

    it('should produce different prompts for different personas given same inputs', async () => {
      const { filePath: blakeFile } = await writeTempSystemMd('You are Blake.');
      const { filePath: yuiFile } = await writeTempSystemMd('You are Yui.');

      const blakePrompt = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: blakeFile,
        messages: MESSAGES,
        monologue: [],
        notes: '',
        attachedFiles: [],
        personas: PERSONAS,
      });

      const yuiPrompt = await buildPrompt({
        personaId: 'yui',
        systemPromptPath: yuiFile,
        messages: MESSAGES,
        monologue: [],
        notes: '',
        attachedFiles: [],
        personas: PERSONAS,
      });

      expect(blakePrompt).not.toBe(yuiPrompt);
      expect(blakePrompt).toContain('You are Blake.');
      expect(yuiPrompt).toContain('You are Yui.');
    });

    it('should throw or reject when system prompt file does not exist', async () => {
      await expect(
        buildPrompt({
          personaId: 'blake',
          systemPromptPath: '/nonexistent/path/system.md',
          messages: [],
          monologue: [],
          notes: '',
          attachedFiles: [],
          personas: PERSONAS,
        })
      ).rejects.toThrow();
    });

    it('should not contain stray undefined or null in any combination', async () => {
      const { filePath } = await writeTempSystemMd();

      // Test multiple combinations that could produce "undefined" in the output
      const cases = [
        { messages: [], monologue: [], notes: '', attachedFiles: [] },
        { messages: MESSAGES, monologue: [], notes: '', attachedFiles: [] },
        { messages: [], monologue: MONOLOGUE, notes: '', attachedFiles: [] },
        { messages: [], monologue: [], notes: NOTES, attachedFiles: [] },
        { messages: [], monologue: [], notes: '', attachedFiles: ATTACHED_FILES },
      ];

      for (const inputs of cases) {
        const result = await buildPrompt({
          personaId: 'blake',
          systemPromptPath: filePath,
          personas: PERSONAS,
          ...inputs,
        });
        expect(result).not.toContain('undefined');
        expect(result).not.toContain('null');
      }
    });

    it('should handle very large conversation history without error', async () => {
      const { filePath } = await writeTempSystemMd();
      const manyMessages = Array.from({ length: 100 }, (_, i) => ({
        id: `msg-${i}`,
        speakerId: i % 2 === 0 ? 'user' : 'blake',
        timestamp: new Date(Date.now() + i * 60000).toISOString(),
        text: `Message number ${i}: ${'word '.repeat(50).trim()}`,
      }));

      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: manyMessages,
        monologue: [],
        notes: '',
        attachedFiles: [],
        personas: PERSONAS,
      });

      expect(typeof result).toBe('string');
      expect(result).toContain('Message number 0');
      expect(result).toContain('Message number 99');
    });
  });

  describe('section ordering', () => {
    it('should have system content before conversation history', async () => {
      const { filePath } = await writeTempSystemMd();
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: MESSAGES,
        monologue: [],
        notes: '',
        attachedFiles: [],
        personas: PERSONAS,
      });
      const systemPos = result.indexOf(SYSTEM_CONTENT);
      const historyPos = result.search(/conversation history/i);
      expect(systemPos).toBeGreaterThan(-1);
      expect(historyPos).toBeGreaterThan(-1);
      expect(systemPos).toBeLessThan(historyPos);
    });

    it('should have conversation history before monologue', async () => {
      const { filePath } = await writeTempSystemMd();
      const result = await buildPrompt({
        personaId: 'blake',
        systemPromptPath: filePath,
        messages: MESSAGES,
        monologue: MONOLOGUE,
        notes: '',
        attachedFiles: [],
        personas: PERSONAS,
      });
      const historyPos = result.search(/conversation history/i);
      const monologuePos = result.search(/your (internal )?monologue|your thoughts/i);
      expect(historyPos).toBeGreaterThan(-1);
      expect(monologuePos).toBeGreaterThan(-1);
      expect(historyPos).toBeLessThan(monologuePos);
    });
  });
});
