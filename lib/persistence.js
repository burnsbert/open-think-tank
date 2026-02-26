/**
 * lib/persistence.js
 *
 * File I/O for monologue files and session JSON.
 *
 * All functions accept an optional `basePath` parameter for the root directory
 * that contains the `chats/` folder. This allows tests to use a temp directory
 * without touching the actual chats/ directory on disk.
 *
 * Default basePath is the project root (one level up from this lib/ directory),
 * so in production callers don't need to pass basePath explicitly.
 *
 * File layout:
 *   <basePath>/chats/<sessionId>/monologue-<personaId>.json
 *   <basePath>/chats/<sessionId>/session-chat.json
 *
 * Monologue schema: [{timestamp: ISO string, text: string, type: "think"|"research"}]
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Default base path is the project root (parent of this lib/ directory)
const DEFAULT_BASE_PATH = path.resolve(fileURLToPath(import.meta.url), '..', '..');

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the path to a session's directory.
 *
 * @param {string} sessionId
 * @param {string} basePath
 * @returns {string}
 */
function sessionDir(sessionId, basePath) {
  return path.join(basePath, 'chats', sessionId);
}

/**
 * Resolve the path to a persona's monologue file.
 *
 * @param {string} sessionId
 * @param {string} personaId
 * @param {string} basePath
 * @returns {string}
 */
function monologuePath(sessionId, personaId, basePath) {
  return path.join(sessionDir(sessionId, basePath), `monologue-${personaId}.json`);
}

/**
 * Resolve the path to the session-chat.json file.
 *
 * @param {string} sessionId
 * @param {string} basePath
 * @returns {string}
 */
function sessionChatPath(sessionId, basePath) {
  return path.join(sessionDir(sessionId, basePath), 'session-chat.json');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read a persona's monologue for a given session.
 *
 * Returns an empty array if the file does not exist (not an error).
 * Throws on any other I/O error.
 *
 * @param {string} sessionId
 * @param {string} personaId
 * @param {string} [basePath]
 * @returns {Promise<Array<{timestamp: string, text: string, type: string}>>}
 */
export async function readMonologue(sessionId, personaId, basePath = DEFAULT_BASE_PATH) {
  const filePath = monologuePath(sessionId, personaId, basePath);

  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // File doesn't exist yet — return empty array (not an error condition)
      return [];
    }
    throw err;
  }
}

/**
 * Append an entry to a persona's monologue file.
 *
 * Creates the file and any missing directories on demand.
 * Existing entries are preserved — the new entry is appended to the array.
 *
 * @param {string} sessionId
 * @param {string} personaId
 * @param {{timestamp: string, text: string, type: string}} entry
 * @param {string} [basePath]
 * @returns {Promise<void>}
 */
export async function appendMonologue(sessionId, personaId, entry, basePath = DEFAULT_BASE_PATH) {
  const dir = sessionDir(sessionId, basePath);
  const filePath = monologuePath(sessionId, personaId, basePath);

  // Ensure directory exists before reading/writing
  await fs.mkdir(dir, { recursive: true });

  // Read existing entries (empty array if file doesn't exist)
  const existing = await readMonologue(sessionId, personaId, basePath);

  // Append the new entry
  existing.push(entry);

  // Write back as pretty-printed JSON
  await fs.writeFile(filePath, JSON.stringify(existing, null, 2), 'utf8');
}

/**
 * Write the full session JSON to chats/<sessionId>/session-chat.json.
 *
 * Creates the session directory on demand.
 * Overwrites the file if it already exists.
 *
 * @param {string} sessionId
 * @param {Object} sessionData - Full session JSON object
 * @param {string} [basePath]
 * @returns {Promise<void>}
 */
export async function writeSessionChat(sessionId, sessionData, basePath = DEFAULT_BASE_PATH) {
  const dir = sessionDir(sessionId, basePath);
  const filePath = sessionChatPath(sessionId, basePath);

  // Ensure directory exists before writing
  await fs.mkdir(dir, { recursive: true });

  // Write pretty-printed JSON (2-space indent for readability)
  await fs.writeFile(filePath, JSON.stringify(sessionData, null, 2), 'utf8');
}

/**
 * Read the full session JSON from chats/<sessionId>/session-chat.json.
 *
 * Returns null when the file does not exist.
 *
 * @param {string} sessionId
 * @param {string} [basePath]
 * @returns {Promise<Object|null>}
 */
export async function readSessionChat(sessionId, basePath = DEFAULT_BASE_PATH) {
	const filePath = sessionChatPath(sessionId, basePath);

	try {
		const raw = await fs.readFile(filePath, 'utf8');
		return JSON.parse(raw);
	} catch (err) {
		if (err.code === 'ENOENT') {
			return null;
		}
		throw err;
	}
}

/**
 * Ensure the session directory (and its chats/ parent) exist.
 *
 * Uses fs.mkdir with {recursive: true} so it's idempotent — safe to call
 * even if the directory already exists.
 *
 * Per decision #6: server creates chats/<id>/ on demand for any session,
 * including local chats that don't have a pre-existing directory.
 *
 * @param {string} sessionId
 * @param {string} [basePath]
 * @returns {Promise<void>}
 */
export async function ensureSessionDir(sessionId, basePath = DEFAULT_BASE_PATH) {
  const dir = sessionDir(sessionId, basePath);
  await fs.mkdir(dir, { recursive: true });
}
