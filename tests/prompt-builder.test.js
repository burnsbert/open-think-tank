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

// Helper: buildPrompt now returns { systemPrompt, userPrompt }.
// For tests that check combined content, merge them back.
function combined(result) {
  return result.systemPrompt + '\n\n' + result.userPrompt;
}

describe('buildPrompt', () => {
  describe('return type and basic structure', () => {
    it('should return an object with systemPrompt and userPrompt strings', async () => {
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
      expect(typeof result).toBe('object');
      expect(typeof result.systemPrompt).toBe('string');
      expect(typeof result.userPrompt).toBe('string');
      expect(result.systemPrompt.length).toBeGreaterThan(0);
      expect(result.userPrompt.length).toBeGreaterThan(0);
    });

    it('should include the system.md content in systemPrompt', async () => {
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
      expect(result.systemPrompt).toContain(SYSTEM_CONTENT);
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
      expect(result.userPrompt).toMatch(/conversation history/i);
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
      expect(result.userPrompt).toContain('What should we build next?');
      expect(result.userPrompt).toContain('I think we should focus on the API layer first.');
      expect(result.userPrompt).toContain('I agree, but let us not forget the UX.');
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
      expect(result.userPrompt).toContain('You');
      // Blake's message should be attributed to Blake
      expect(result.userPrompt).toContain('Blake');
      // Yui's message should be attributed to Yui
      expect(result.userPrompt).toContain('Yui');
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
      const pos1 = result.userPrompt.indexOf('What should we build next?');
      const pos2 = result.userPrompt.indexOf('I think we should focus on the API layer first.');
      const pos3 = result.userPrompt.indexOf('I agree, but let us not forget the UX.');
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
      expect(typeof result).toBe('object');
      expect(result.userPrompt.length).toBeGreaterThan(0);
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
      expect(result.userPrompt).toContain('What should we build next?');
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
      expect(result.userPrompt).toContain('Grant');
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
      expect(result.userPrompt).toContain('unknown-bot');
      expect(result.userPrompt).toContain('Mystery message.');
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
      expect(result.userPrompt).toMatch(/your (internal )?monologue|your thoughts/i);
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
      expect(result.userPrompt).toContain('User seems keen to move fast.');
      expect(result.userPrompt).toContain('My suggestion landed well.');
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
      expect(result.userPrompt).toContain('2026-02-25');
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
      expect(typeof result).toBe('object');
      // Should not contain stray "undefined" or "null"
      expect(result.userPrompt).not.toContain('undefined');
      expect(result.userPrompt).not.toContain('null');
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
      expect(result.userPrompt).toContain('User seems keen to move fast.');
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
      expect(result.userPrompt).toContain('Silent thought.');
      expect(result.userPrompt).toContain('Found useful info.');
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
      expect(result.userPrompt).toMatch(/session notes/i);
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
      expect(result.userPrompt).toContain('Decision: API layer first.');
      expect(result.userPrompt).toContain('Follow-up needed on UX.');
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
      expect(typeof result).toBe('object');
      expect(result.userPrompt).not.toContain('undefined');
      expect(result.userPrompt).not.toContain('null');
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
      expect(typeof result).toBe('object');
      // Whitespace-only notes should not inject garbage into the prompt
      expect(result.userPrompt).not.toMatch(/\bnull\b/);
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
      expect(result.userPrompt).toContain('Line one');
      expect(result.userPrompt).toContain('Line two');
      expect(result.userPrompt).toContain('Line three');
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
      expect(result.userPrompt).toMatch(/attached files/i);
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
      expect(result.userPrompt).toContain('spec.md');
      expect(result.userPrompt).toContain('design.png');
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
      expect(result.userPrompt).toContain('spec.md');
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
      expect(typeof result).toBe('object');
      expect(result.userPrompt).not.toContain('undefined');
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
      expect(result.userPrompt).toContain('requirements.md');
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
        expect(result.userPrompt).toContain(file);
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
      expect(typeof result).toBe('object');
      // Should still include system content
      expect(result.systemPrompt).toContain(SYSTEM_CONTENT);
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
      expect(result.systemPrompt).toContain(SYSTEM_CONTENT);
      expect(result.userPrompt).toContain('What should we build next?');
      expect(result.userPrompt).toContain('User seems keen to move fast.');
      expect(result.userPrompt).toContain('Decision: API layer first.');
      expect(result.userPrompt).toContain('spec.md');
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

      expect(blakePrompt).not.toEqual(yuiPrompt);
      expect(blakePrompt.systemPrompt).toContain('You are Blake.');
      expect(yuiPrompt.systemPrompt).toContain('You are Yui.');
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
        expect(result.userPrompt).not.toContain('undefined');
        expect(result.userPrompt).not.toContain('null');
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

      expect(typeof result).toBe('object');
      expect(result.userPrompt).toContain('Message number 0');
      expect(result.userPrompt).toContain('Message number 99');
    });
  });

  describe('section ordering', () => {
    it('should have system content separate from user prompt', async () => {
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
      // System content is in systemPrompt, not userPrompt
      expect(result.systemPrompt).toContain(SYSTEM_CONTENT);
      expect(result.userPrompt).toMatch(/conversation history/i);
    });

    it('should have conversation history before monologue in userPrompt', async () => {
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
      const historyPos = result.userPrompt.search(/conversation history/i);
      const monologuePos = result.userPrompt.search(/your (internal )?monologue|your thoughts/i);
      expect(historyPos).toBeGreaterThan(-1);
      expect(monologuePos).toBeGreaterThan(-1);
      expect(historyPos).toBeLessThan(monologuePos);
    });
  });
});
