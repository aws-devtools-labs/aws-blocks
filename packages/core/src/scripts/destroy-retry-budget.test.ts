// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it, mock } from 'node:test';

import { maxDestroyRetryMs, THROTTLE_BACKOFF_DEFAULTS } from './destroy-retry-budget.js';
import { runDestroyWithRetries } from './sandbox.js';

// A caller that stops a destroy at its own timeout (the telemetry E2E suite)
// has to wait at least maxDestroyRetryMs, or it kills a destroy that is still
// retrying, and the destroy never reports its own result. These pin that the
// bound holds for the retry loop as it is, and that it is not loose.

const MIN = 60_000;
const THROTTLED = 'Too Many Requests (Service: ApiGateway, Status Code: 429)';

/** A seeded PRNG (mulberry32), so a failing case can be replayed. */
function prng(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

/**
 * Run the retry loop on a fake clock that only attempts and waits advance.
 * Attempt `i` takes `durations[i]` ms and fails throttled when `throttled[i]`,
 * ordinarily otherwise (it always fails). Returns the elapsed time. The
 * loop's console output is muted.
 */
async function elapsedFor(durations: number[], throttled: boolean[], random: () => number): Promise<number> {
	const muted = (['log', 'error', 'warn'] as const).map((name) => mock.method(console, name, () => {}));
	let t = 0;
	let attempts = 0;
	try {
		await assert.rejects(
			runDestroyWithRetries({
				runDestroy: () => {
					t += durations[attempts++] ?? 0;
					throw new Error(THROTTLED);
				},
				listStacks: () => [{ stackName: 'stackA' }],
				emptyBuckets: async () => {},
				isThrottled: async () => throttled[attempts - 1] ?? false,
				sleep: async (ms) => {
					t += ms;
				},
				now: () => t,
				random,
			}),
		);
	} finally {
		for (const m of muted) m.mock.restore();
	}
	return t;
}

describe('maxDestroyRetryMs', () => {
	it('is reached: a throttled destroy can run its first attempt, the whole budget, a 2 min wait and one more attempt', async () => {
		// Attempts of up to 5 min (a throttled delete of the telemetry app's stack).
		// Ordinary fail@5 (the first failure), wait 1 -> throttled fail@11, wait 0.5
		// -> throttled fail@16.5, wait 1 -> throttled fail@22.5, wait 2 -> ordinary
		// fail@25, exactly 20 min after the first failure, so the budget is not yet
		// spent: wait 2 -> the last attempt fails @32.
		const durations = [5 * MIN, 5 * MIN, 5 * MIN, 5 * MIN, MIN / 2, 5 * MIN];
		const throttled = [false, true, true, true, false, false];
		const elapsed = await elapsedFor(durations, throttled, () => 0);
		assert.strictEqual(elapsed, 32 * MIN);
		assert.strictEqual(maxDestroyRetryMs(5 * MIN), elapsed);
		assert.ok(
			elapsed > THROTTLE_BACKOFF_DEFAULTS.budgetMs + 10 * MIN,
			'the budget is not a limit on the whole call',
		);
	});

	it('is reached by attempts that are never throttled: three attempts and both ordinary waits', async () => {
		const elapsed = await elapsedFor([25 * MIN, 25 * MIN, 25 * MIN], [false, false, false], () => 0);
		assert.strictEqual(elapsed, 78 * MIN);
		assert.strictEqual(maxDestroyRetryMs(25 * MIN), elapsed);
	});

	it('bounds every schedule of throttled and ordinary failures whose attempts take at most attemptMs', async () => {
		const random = prng(0x5eed);
		for (const attemptMs of [0, MIN / 2, 3 * MIN, 5 * MIN, 6 * MIN, 9 * MIN, 25 * MIN]) {
			const bound = maxDestroyRetryMs(attemptMs);
			for (let trial = 0; trial < 400; trial++) {
				// Long enough for any call: each wait is at least 30 s.
				const durations = Array.from({ length: 60 }, () => (random() < 0.5 ? attemptMs : random() * attemptMs));
				const throttleShare = random();
				const throttled = durations.map(() => random() < throttleShare);
				const elapsed = await elapsedFor(durations, throttled, random);
				assert.ok(
					elapsed <= bound,
					`attemptMs=${attemptMs} trial=${trial}: ran ${elapsed} ms, bound ${bound} ms (throttled ${throttled.join(',')})`,
				);
			}
		}
	});
});
