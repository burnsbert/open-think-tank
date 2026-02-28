/**
 * lib/budget-manager.js
 *
 * Overage budget logic for persona speak turns.
 *
 * Budget rules:
 *   - Base speak limit: 150 characters.
 *   - Speaking always costs 25 budget (flat speak cost).
 *   - Speak text < 50 chars: earns +25 (brevity bonus), which cancels the speak cost (net 0).
 *   - Speak text over 150 chars: also loses (len - 150) overage budget.
 *   - Total speak cost = SPEAK_COST + max(0, len - BASE_LIMIT).
 *   - If total cost > budget: message truncated to (150 + max(0, budget - 25)) chars,
 *     at sentence boundary or word boundary. Budget becomes 0.
 *
 *   Silent actions earn budget:
 *     pass                                    → +100 (flat)
 *     think / research / update_notes         → random 10–60
 *
 *   Skipped personas (not selected to act this round) earn budget:
 *     skipped                                 → random 10–60
 */

export const BASE_LIMIT = 150;
export const SPEAK_COST = 25;
export const BREVITY_THRESHOLD = 50;
export const BREVITY_BONUS = 25;
export const PASS_BUDGET_GAIN = 100;
export const RANDOM_GAIN_MIN = 10;
export const RANDOM_GAIN_MAX = 60;

/**
 * Return a random budget gain for non-pass silent actions and skipped personas.
 * Returns an integer in [RANDOM_GAIN_MIN, RANDOM_GAIN_MAX] inclusive.
 *
 * @returns {number}
 */
export function randomBudgetGain() {
	return Math.floor(Math.random() * (RANDOM_GAIN_MAX - RANDOM_GAIN_MIN + 1)) + RANDOM_GAIN_MIN;
}

/**
 * Return how much budget a silent action earns.
 *
 * @param {string} action - 'pass', 'think', 'research', or 'update_notes'
 * @returns {number}
 */
export function silentActionBudgetGain(action) {
	if (action === 'pass') return PASS_BUDGET_GAIN;
	return randomBudgetGain();
}

/**
 * Truncate text to at most `limit` characters, preferring sentence boundaries.
 * Falls back to word boundary, then hard truncation if no boundary exists.
 *
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
export function truncateToLimit(text, limit) {
	if (text.length <= limit) return text;
	const candidate = text.slice(0, limit);

	// Find last sentence-ending punctuation (.!?) optionally followed by a quote,
	// then a space or end-of-string.
	const sentenceRegex = /[.!?]['"]?(?=\s|$)/g;
	let lastEnd = -1;
	let match;
	while ((match = sentenceRegex.exec(candidate)) !== null) {
		lastEnd = match.index + match[0].length;
	}

	if (lastEnd > 0) {
		return candidate.slice(0, lastEnd);
	}

	// Fall back to word boundary
	const lastSpace = candidate.lastIndexOf(' ');
	if (lastSpace > 0) {
		return candidate.slice(0, lastSpace);
	}

	// Hard truncate — no whitespace or sentence boundary found
	return candidate;
}

/**
 * Apply the overage budget to a speak message.
 *
 * Returns the (possibly truncated) text and the updated budget.
 *
 * @param {string} text    - The speak text (trimmed)
 * @param {number} budget  - Current overage budget (non-negative integer)
 * @returns {{ text: string, newBudget: number }}
 */
export function applyBudget(text, budget) {
	const len = text.length;

	// Brevity bonus cancels flat speak cost — net 0
	if (len < BREVITY_THRESHOLD) {
		return { text, newBudget: budget };
	}

	// Total cost = flat speak cost + overage beyond base limit
	const overage = Math.max(0, len - BASE_LIMIT);
	const totalCost = SPEAK_COST + overage;

	if (totalCost <= budget) {
		// Budget covers the full cost — message passes through
		return { text, newBudget: budget - totalCost };
	}

	// Budget can't cover the full cost — truncate to (BASE_LIMIT + max(0, budget - SPEAK_COST))
	const availableOverage = Math.max(0, budget - SPEAK_COST);
	const limit = BASE_LIMIT + availableOverage;
	const truncated = truncateToLimit(text, limit);
	return { text: truncated, newBudget: 0 };
}
