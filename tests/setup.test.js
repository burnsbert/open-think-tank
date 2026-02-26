/**
 * Trivial test to verify Vitest setup and helpers work correctly
 */

import { describe, it, expect } from 'vitest';
import {
  createMockExecFile,
  createMockSpawn,
  createSpeakResponse,
  createThinkResponse,
  createResearchResponse,
} from './helpers.js';

describe('Vitest Setup and Mock Helpers', () => {
  it('should create a mock execFile that calls callback with success', () => {
    return new Promise((resolve) => {
      const jsonResponse = { action: 'speak', text: 'Hello' };
      const mockExecFile = createMockExecFile({ jsonResponse });

      mockExecFile('claude', ['-p', '--output-format', 'json'], {}, (err, stdout, stderr) => {
        expect(err).toBeNull();
        expect(stdout).toBe(JSON.stringify(jsonResponse));
        expect(stderr).toBe('');
        resolve();
      });
    });
  });

  it('should create a mock execFile that simulates error', () => {
    return new Promise((resolve) => {
      const testError = new Error('Test error');
      const mockExecFile = createMockExecFile({ error: testError });

      mockExecFile('claude', ['-p'], {}, (err, stdout, stderr) => {
        expect(err).toBe(testError);
        resolve();
      });
    });
  });

  it('should create a mock execFile that returns malformed JSON', () => {
    return new Promise((resolve) => {
      const mockExecFile = createMockExecFile({ malformedJson: '{invalid json' });

      mockExecFile('claude', ['-p'], {}, (err, stdout, stderr) => {
        expect(err).toBeNull();
        expect(stdout).toBe('{invalid json');
        resolve();
      });
    });
  });

  it('should create a mock execFile that simulates timeout', () => {
    return new Promise((resolve) => {
      const mockExecFile = createMockExecFile({ timeout: true });
      let callbackCalled = false;

      mockExecFile('claude', ['-p'], {}, () => {
        callbackCalled = true;
      });

      // Wait a bit then verify callback was never called
      setTimeout(() => {
        expect(callbackCalled).toBe(false);
        resolve();
      }, 100);
    });
  });

  it('should create a mock spawn that emits data event', () => {
    return new Promise((resolve) => {
      const jsonResponse = { action: 'think', text: 'Thinking...' };
      const mockProcess = createMockSpawn({ jsonResponse });

      let dataReceived = '';
      mockProcess.stdout.on('data', (data) => {
        dataReceived += data.toString();
      });

      setTimeout(() => {
        expect(dataReceived).toBe(JSON.stringify(jsonResponse));
        resolve();
      }, 50);
    });
  });

  it('should create helper functions for valid response shapes', () => {
    const speak = createSpeakResponse('Hello', 'Note update');
    expect(speak.action).toBe('speak');
    expect(speak.text).toBe('Hello');
    expect(speak.noteUpdate).toBe('Note update');

    const think = createThinkResponse('Internal thought');
    expect(think.action).toBe('think');
    expect(think.text).toBe('Internal thought');

    const research = createResearchResponse('Query', 'Results');
    expect(research.action).toBe('research');
    expect(research.query).toBe('Query');
    expect(research.findings).toBe('Results');
  });

  it('should verify Vitest globals work', () => {
    expect(true).toBe(true);
  });
});
