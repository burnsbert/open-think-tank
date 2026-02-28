/**
 * lib/summarizer.js
 *
 * Generates a concise session summary from conversation messages.
 * Tries Ollama first (if configured), falls back to Claude Code.
 *
 * Env vars:
 *   OLLAMA_ENABLED           — set to 'true' to enable Ollama
 *   OLLAMA_SUMMARY_MODEL     — model for summaries (falls back to OLLAMA_DECISION_MODEL)
 *   OLLAMA_BASE_URL          — Ollama base URL (default: http://localhost:11434)
 *   SUMMARY_TIMEOUT_MS       — per-request timeout in ms (default: 20000)
 */

import { spawn } from 'child_process';

const SUMMARY_TIMEOUT_MS = 20000;

const SUMMARY_SYSTEM_PROMPT = [
	'You are a terse conversation summarizer.',
	'Summarize the key discussion points, decisions, and open questions from this conversation.',
	'Use 3-6 bullet points, each starting with "- ".',
	'Plain text only. No markdown headers. Be concise.',
].join('\n');

function formatMessagesForSummary(messages, personas) {
	const nameMap = {};
	for (const p of (personas || [])) {
		nameMap[p.id] = p.displayName || p.name || p.id;
	}
	return messages
		.map((m) => `${nameMap[m.speakerId] || m.speakerId}: ${m.text}`)
		.join('\n');
}

export function getSummaryOllamaConfig() {
	const isTestEnv = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
	if (isTestEnv) return null;

	const enabledRaw = String(process.env.OLLAMA_ENABLED || '').trim().toLowerCase();
	const enabled = enabledRaw === 'true' || enabledRaw === '1' || enabledRaw === 'yes';
	if (!enabled) return null;

	const model = String(
		process.env.OLLAMA_SUMMARY_MODEL || process.env.OLLAMA_DECISION_MODEL || ''
	).trim();
	if (!model) return null;

	const baseUrl = String(process.env.OLLAMA_BASE_URL || 'http://localhost:11434')
		.trim()
		.replace(/\/+$/, '');

	return { baseUrl, model };
}

async function generateWithOllama({ baseUrl, model, userPrompt, timeoutMs }) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const body = {
			model,
			messages: [
				{ role: 'system', content: SUMMARY_SYSTEM_PROMPT },
				{ role: 'user', content: userPrompt },
			],
			stream: false,
			options: { temperature: 0.3 },
		};
		const response = await fetch(`${baseUrl}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			signal: controller.signal,
			body: JSON.stringify(body),
		});
		if (!response.ok) throw new Error(`Ollama chat failed (${response.status})`);
		const json = await response.json();
		const text = typeof json?.message?.content === 'string' ? json.message.content.trim() : '';
		if (!text) throw new Error('Ollama summary response is empty');
		return text;
	} finally {
		clearTimeout(timer);
	}
}

function generateWithClaudeCode({ userPrompt, model, cwd, timeoutMs }) {
	const args = [
		'-p', userPrompt,
		'--system-prompt', SUMMARY_SYSTEM_PROMPT,
		'--output-format', 'json',
		'--model', model || 'haiku',
		'--no-session-persistence',
	];

	return new Promise((resolve, reject) => {
		const child = spawn('claude', args, {
			cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		let stdout = '';
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill('SIGTERM');
			reject(new Error(`Summary generation timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });

		child.on('close', (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code !== 0) {
				reject(new Error(`Summary claude exited ${code}`));
				return;
			}
			try {
				const parsed = JSON.parse(stdout.trim());
				if (parsed.is_error === true) {
					reject(new Error('Summary claude returned error'));
					return;
				}
				const text = typeof parsed.result === 'string' ? parsed.result.trim() : '';
				resolve(text || '');
			} catch {
				resolve('');
			}
		});

		child.on('error', (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(err);
		});
	});
}

/**
 * Generate a session summary from conversation messages.
 * Returns '' immediately in test environments.
 *
 * @param {Object}      params
 * @param {Array}       params.messages      — all session messages (speak actions only reach here)
 * @param {Array}       params.personas      — persona roster (for display names)
 * @param {Object|null} params.ollamaConfig  — { baseUrl, model } or null
 * @param {string}      params.model         — Claude model to use as fallback
 * @param {string}      params.cwd           — working dir for claude spawn
 * @param {number}      [params.timeoutMs]   — timeout in ms (default: 20000)
 * @returns {Promise<string>} summary text, or '' on failure/skip
 */
export async function generateSummary({ messages, personas, ollamaConfig, model, cwd, timeoutMs = SUMMARY_TIMEOUT_MS }) {
	const isTestEnv = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
	if (isTestEnv) return '';

	if (!messages || messages.length === 0) return '';

	const convoText = formatMessagesForSummary(messages, personas);
	const userPrompt = `Conversation:\n${convoText}`;

	if (ollamaConfig?.baseUrl && ollamaConfig?.model) {
		try {
			const summary = await generateWithOllama({ ...ollamaConfig, userPrompt, timeoutMs });
			if (summary) return summary;
		} catch (err) {
			console.log(`[summarizer] Ollama failed, falling back to Claude: ${err.message}`);
		}
	}

	try {
		return await generateWithClaudeCode({ userPrompt, model, cwd, timeoutMs });
	} catch (err) {
		console.log(`[summarizer] Claude Code summary failed: ${err.message}`);
		return '';
	}
}
