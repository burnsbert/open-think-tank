/**
 * Tests for lib/budget-manager.js
 */

import { describe, it, expect } from 'vitest';
import {
	applyBudget,
	truncateToLimit,
	silentActionBudgetGain,
	randomBudgetGain,
	BASE_LIMIT,
	SPEAK_COST,
	BREVITY_THRESHOLD,
	BREVITY_BONUS,
	PASS_BUDGET_GAIN,
	RANDOM_GAIN_MIN,
	RANDOM_GAIN_MAX,
} from '../lib/budget-manager.js';

// ---------------------------------------------------------------------------
// silentActionBudgetGain
// ---------------------------------------------------------------------------

describe('silentActionBudgetGain', () => {
	it('pass earns 100 (flat)', () => {
		expect(silentActionBudgetGain('pass')).toBe(100);
	});

	it('think earns a random value in [10, 60]', () => {
		const gain = silentActionBudgetGain('think');
		expect(gain).toBeGreaterThanOrEqual(RANDOM_GAIN_MIN);
		expect(gain).toBeLessThanOrEqual(RANDOM_GAIN_MAX);
		expect(Number.isInteger(gain)).toBe(true);
	});

	it('research earns a random value in [10, 60]', () => {
		const gain = silentActionBudgetGain('research');
		expect(gain).toBeGreaterThanOrEqual(RANDOM_GAIN_MIN);
		expect(gain).toBeLessThanOrEqual(RANDOM_GAIN_MAX);
	});

	it('update_notes earns a random value in [10, 60]', () => {
		const gain = silentActionBudgetGain('update_notes');
		expect(gain).toBeGreaterThanOrEqual(RANDOM_GAIN_MIN);
		expect(gain).toBeLessThanOrEqual(RANDOM_GAIN_MAX);
	});
});

// ---------------------------------------------------------------------------
// randomBudgetGain
// ---------------------------------------------------------------------------

describe('randomBudgetGain', () => {
	it('returns an integer in [10, 60]', () => {
		for (let i = 0; i < 20; i++) {
			const gain = randomBudgetGain();
			expect(gain).toBeGreaterThanOrEqual(RANDOM_GAIN_MIN);
			expect(gain).toBeLessThanOrEqual(RANDOM_GAIN_MAX);
			expect(Number.isInteger(gain)).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// truncateToLimit
// ---------------------------------------------------------------------------

describe('truncateToLimit', () => {
	it('text within limit is returned unchanged', () => {
		expect(truncateToLimit('Hello world', 20)).toBe('Hello world');
	});

	it('text at exactly the limit is returned unchanged', () => {
		const text = 'A'.repeat(20);
		expect(truncateToLimit(text, 20)).toBe(text);
	});

	it('truncates at sentence boundary (period + space)', () => {
		// candidate = 'Sentence one. Senten'
		// last sentence end within 20 chars: 'Sentence one.' at pos 13
		const text = 'Sentence one. Sentence two is very long indeed.';
		expect(truncateToLimit(text, 20)).toBe('Sentence one.');
	});

	it('truncates at exclamation mark boundary', () => {
		const text = 'Great idea! More words here that go on forever.';
		expect(truncateToLimit(text, 15)).toBe('Great idea!');
	});

	it('truncates at question mark boundary', () => {
		const text = 'Is that right? Well maybe yes but I am not sure.';
		expect(truncateToLimit(text, 20)).toBe('Is that right?');
	});

	it('falls back to word boundary when no previous sentence exists', () => {
		// candidate for limit=20: 'One long sentence wi'
		// no sentence end → last space before pos 20 → 'One long sentence'
		const text = 'One long sentence without any end punctuation here';
		expect(truncateToLimit(text, 20)).toBe('One long sentence');
	});

	it('hard truncates when no spaces or sentence ends exist', () => {
		expect(truncateToLimit('AAAAAAAAAAAAAAAAAAA', 10)).toBe('AAAAAAAAAA');
	});

	it('prefers the latest sentence boundary within the limit', () => {
		const text = 'First. Second. Third goes way over the limit here.';
		// limit 20: candidate 'First. Second. Third'
		// sentence ends at 'First.' (pos 6) and 'Second.' (pos 14)
		// should use the later one: 'First. Second.'
		expect(truncateToLimit(text, 20)).toBe('First. Second.');
	});
});

// ---------------------------------------------------------------------------
// applyBudget
// ---------------------------------------------------------------------------

describe('applyBudget', () => {
	describe('brevity bonus (< 50 chars) — net 0', () => {
		it('short text with budget=0: net 0, text unchanged', () => {
			const { text, newBudget } = applyBudget('Use Postgres.', 0);
			expect(text).toBe('Use Postgres.');
			expect(newBudget).toBe(0);
		});

		it('short text with existing budget: no change', () => {
			const { newBudget } = applyBudget('Short.', 150);
			expect(newBudget).toBe(150);
		});

		it('text at exactly BREVITY_THRESHOLD is not brevity — costs flat 25', () => {
			// 50 chars: overage = max(0, 50-150) = 0, totalCost = 25
			// 25 > 0 budget → truncate to BASE_LIMIT, text is 50 chars ≤ 150 so unchanged, budget = 0
			const text = 'A'.repeat(BREVITY_THRESHOLD);
			const { text: out, newBudget } = applyBudget(text, 0);
			expect(out).toBe(text); // unchanged (50 ≤ 150)
			expect(newBudget).toBe(0);
		});

		it('text at BREVITY_THRESHOLD - 1 earns brevity bonus (net 0)', () => {
			const text = 'A'.repeat(BREVITY_THRESHOLD - 1);
			const { newBudget } = applyBudget(text, 50);
			expect(newBudget).toBe(50); // no change
		});
	});

	describe('within base limit (50..150 chars), budget covers flat cost', () => {
		it('100 chars, budget=50: text passes, budget reduced by 25', () => {
			const text = 'A'.repeat(100);
			const { text: out, newBudget } = applyBudget(text, 50);
			expect(out).toBe(text);
			expect(newBudget).toBe(25);
		});

		it('150 chars, budget=25: text passes, budget becomes 0', () => {
			const text = 'A'.repeat(BASE_LIMIT);
			const { text: out, newBudget } = applyBudget(text, 25);
			expect(out).toBe(text);
			expect(newBudget).toBe(0);
		});

		it('150 chars, budget=100: text passes, budget reduced by 25', () => {
			const text = 'A'.repeat(BASE_LIMIT);
			const { text: out, newBudget } = applyBudget(text, 100);
			expect(out).toBe(text);
			expect(newBudget).toBe(75);
		});
	});

	describe('within base limit, budget cannot cover flat cost — text passes anyway', () => {
		it('100 chars, budget=0: text passes (within truncation limit), budget becomes 0', () => {
			// totalCost=25 > 0, so truncate path; limit = 150+max(0,0-25) = 150; 100 ≤ 150 → unchanged
			const text = 'A'.repeat(100);
			const { text: out, newBudget } = applyBudget(text, 0);
			expect(out).toBe(text);
			expect(newBudget).toBe(0);
		});

		it('100 chars, budget=10: text passes, budget becomes 0', () => {
			const text = 'A'.repeat(100);
			const { text: out, newBudget } = applyBudget(text, 10);
			expect(out).toBe(text);
			expect(newBudget).toBe(0);
		});
	});

	describe('over base limit (> 150 chars), budget covers full cost', () => {
		it('200 chars, budget=100: text passes, budget reduced by 75 (25+50)', () => {
			const text = 'A'.repeat(200);
			const { text: out, newBudget } = applyBudget(text, 100);
			expect(out).toBe(text);
			expect(newBudget).toBe(25);
		});

		it('200 chars, budget=75: text passes, budget becomes 0', () => {
			const text = 'A'.repeat(200);
			const { text: out, newBudget } = applyBudget(text, 75);
			expect(out).toBe(text);
			expect(newBudget).toBe(0);
		});

		it('151 chars, budget=26: exactly covered (25+1=26), budget becomes 0', () => {
			const text = 'A'.repeat(151);
			const { text: out, newBudget } = applyBudget(text, 26);
			expect(out).toBe(text);
			expect(newBudget).toBe(0);
		});
	});

	describe('over base limit, budget cannot cover full cost — truncation', () => {
		it('200 chars, budget=0: truncated to ≤150, newBudget=0', () => {
			const text = ('word ').repeat(40).trim(); // well over 150
			const { text: out, newBudget } = applyBudget(text, 0);
			expect(out.length).toBeLessThanOrEqual(BASE_LIMIT);
			expect(newBudget).toBe(0);
		});

		it('200 chars, budget=50: truncated to ≤175, newBudget=0', () => {
			// availableOverage = max(0, 50-25) = 25; limit = 150+25 = 175
			const text = 'A'.repeat(200) + '. ' + 'B'.repeat(50);
			const { text: out, newBudget } = applyBudget(text, 50);
			expect(out.length).toBeLessThanOrEqual(175);
			expect(newBudget).toBe(0);
		});

		it('truncates at sentence boundary when available', () => {
			// budget=0 so limit=150. Put a sentence end at char ~120.
			const prefix = 'A'.repeat(110) + '. '; // 112 chars, sentence end at 111
			const suffix = 'B'.repeat(100); // pushes total well past 150
			const text = prefix + suffix;
			const { text: out } = applyBudget(text, 0);
			expect(out).toBe('A'.repeat(110) + '.');
		});

		it('truncates at word boundary when no sentence', () => {
			const words = ('longword ').repeat(20).trim(); // ~180 chars, no sentence end
			const { text: out } = applyBudget(words, 0);
			expect(out.endsWith(' ')).toBe(false);
			expect(out.length).toBeLessThanOrEqual(BASE_LIMIT);
		});

		it('returned text does not exceed (BASE_LIMIT + max(0, budget - SPEAK_COST))', () => {
			const text = 'X'.repeat(500);
			const budget = 75;
			const { text: out } = applyBudget(text, budget);
			const expectedMax = BASE_LIMIT + Math.max(0, budget - SPEAK_COST);
			expect(out.length).toBeLessThanOrEqual(expectedMax);
		});
	});
});
