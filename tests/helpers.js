/**
 * Test helpers for mocking child_process calls to claude -p
 * All tests across the project use these mocks -- no real claude calls ever.
 */

import { vi } from 'vitest';

/**
 * Mock factory for child_process.execFile
 * Returns a mock function that simulates claude -p output
 *
 * @param {Object} options - Configuration for the mock
 * @param {Object|null} options.jsonResponse - JSON object to return as parsed output (success case)
 * @param {string|null} options.malformedJson - Malformed JSON string to return (to test parsing failures)
 * @param {boolean} options.timeout - If true, simulate a timeout by never calling callback
 * @param {Error|null} options.error - Error object to pass to callback (simulates process error)
 * @param {number} options.exitCode - Exit code to return (default 0 for success)
 * @returns {Function} Mock execFile function
 */
export function createMockExecFile({
  jsonResponse = null,
  malformedJson = null,
  timeout = false,
  error = null,
  exitCode = 0,
} = {}) {
  return vi.fn((command, args, options, callback) => {
    if (timeout) {
      // Simulate timeout - never call callback
      return;
    }

    if (error) {
      // Simulate process error
      process.nextTick(() => {
        callback(error, '', '');
      });
      return;
    }

    let stdout = '';
    if (malformedJson !== null) {
      stdout = malformedJson;
    } else if (jsonResponse !== null) {
      stdout = JSON.stringify(jsonResponse);
    }

    process.nextTick(() => {
      if (exitCode !== 0) {
        // Non-zero exit code with error
        const error = new Error(`Command exited with code ${exitCode}`);
        error.code = exitCode;
        callback(error, stdout, '');
      } else {
        // Success
        callback(null, stdout, '');
      }
    });
  });
}

/**
 * Mock factory for child_process.spawn
 * Returns a mock event emitter that simulates claude -p streaming
 *
 * @param {Object} options - Configuration for the mock
 * @param {Object|null} options.jsonResponse - JSON object to emit line by line
 * @param {string|null} options.malformedJson - Malformed JSON to emit
 * @param {boolean} options.timeout - If true, simulate timeout by never emitting 'close' or 'error'
 * @param {Error|null} options.error - Error to emit on 'error' event
 * @param {number} options.exitCode - Exit code to emit on 'close' event (default 0)
 * @returns {Object} Mock spawn child process with event emitter interface
 */
export function createMockSpawn({
  jsonResponse = null,
  malformedJson = null,
  timeout = false,
  error = null,
  exitCode = 0,
} = {}) {
  const listeners = {};

  const mockProcess = {
    stdout: {
      on: vi.fn((event, handler) => {
        listeners[event] = handler;
      }),
    },
    stderr: {
      on: vi.fn(),
    },
    on: vi.fn((event, handler) => {
      if (event === 'close' || event === 'error') {
        listeners[`_${event}`] = handler;
      }
    }),
    kill: vi.fn(),
  };

  process.nextTick(() => {
    if (timeout) {
      // Never emit close or error - simulate timeout
      return;
    }

    if (error) {
      // Emit error event
      if (listeners._error) {
        listeners._error(error);
      }
      return;
    }

    let data = '';
    if (malformedJson !== null) {
      data = malformedJson;
    } else if (jsonResponse !== null) {
      data = JSON.stringify(jsonResponse);
    }

    // Emit data event
    if (listeners.data) {
      listeners.data(Buffer.from(data));
    }

    // Emit close event
    if (listeners._close) {
      listeners._close(exitCode);
    }
  });

  return mockProcess;
}

/**
 * Helper to create a valid claude -p response object
 * for the "speak" action
 */
export function createSpeakResponse(text, noteUpdate = null) {
  const response = {
    action: 'speak',
    text,
  };
  if (noteUpdate) {
    response.noteUpdate = noteUpdate;
  }
  return response;
}

/**
 * Helper to create a valid claude -p response object
 * for the "think" action
 */
export function createThinkResponse(text) {
  return {
    action: 'think',
    text,
  };
}

/**
 * Helper to create a valid claude -p response object
 * for the "research" action
 */
export function createResearchResponse(query, findings) {
  return {
    action: 'research',
    query,
    findings,
  };
}
