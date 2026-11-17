// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { UNLOCK_TTL_MS, isUnlocked, resetUnlockForTests, setUnlocked, unlockState } from './write-guard.js';

/** A fixed, readable epoch so failures report comprehensible timestamps. */
const T0 = Date.parse('2024-01-01T00:00:00.000Z');

afterEach(() => {
	resetUnlockForTests();
});

describe('the window length itself', () => {
	it('is fifteen minutes, pinned to the literal value', () => {
		// Every other assertion in this file references the symbol, which left the
		// duration defended by nothing: changing 15 minutes to 15 hours — or 15
		// seconds — kept all 700 tests green. The length of a security window is a
		// product decision, so it gets an assertion that names the number.
		assert.strictEqual(UNLOCK_TTL_MS, 900_000);
		assert.strictEqual(UNLOCK_TTL_MS, 15 * 60 * 1000);
	});
});

describe('the initial state', () => {
	it('starts locked', () => {
		assert.strictEqual(isUnlocked(T0), false);
		assert.deepStrictEqual(unlockState(T0), { unlocked: false, ttlMs: UNLOCK_TTL_MS });
	});

	it('reports the window length even while locked, so a UI need not hardcode it', () => {
		assert.strictEqual(unlockState(T0).ttlMs, UNLOCK_TTL_MS);
	});
});

describe('unlocking', () => {
	it('reports unlocked with the ttl, an ISO expiresAt and a positive expiresInMs', () => {
		const state = setUnlocked(true, T0);
		assert.strictEqual(state.unlocked, true);
		assert.strictEqual(state.ttlMs, UNLOCK_TTL_MS);
		assert.strictEqual(state.expiresAt, new Date(T0 + UNLOCK_TTL_MS).toISOString());
		assert.strictEqual(state.expiresInMs, UNLOCK_TTL_MS);
		assert.ok((state.expiresInMs ?? 0) > 0, 'expiresInMs is positive');
	});

	it('is still unlocked one millisecond before the deadline', () => {
		setUnlocked(true, T0);
		const state = unlockState(T0 + UNLOCK_TTL_MS - 1);
		assert.strictEqual(state.unlocked, true);
		assert.strictEqual(state.expiresInMs, 1);
	});

	it('is locked exactly at the deadline', () => {
		setUnlocked(true, T0);
		assert.strictEqual(isUnlocked(T0 + UNLOCK_TTL_MS), false);
	});

	it('is locked after the deadline', () => {
		setUnlocked(true, T0);
		assert.strictEqual(isUnlocked(T0 + UNLOCK_TTL_MS + 60_000), false);
	});

	it('counts expiresInMs DOWN as the clock advances', () => {
		setUnlocked(true, T0);
		const first = unlockState(T0 + 1_000).expiresInMs;
		const second = unlockState(T0 + 5_000).expiresInMs;
		const third = unlockState(T0 + 60_000).expiresInMs;
		assert.strictEqual(first, UNLOCK_TTL_MS - 1_000);
		assert.strictEqual(second, UNLOCK_TTL_MS - 5_000);
		assert.strictEqual(third, UNLOCK_TTL_MS - 60_000);
		assert.ok((first ?? 0) > (second ?? 0) && (second ?? 0) > (third ?? 0), 'strictly decreasing');
	});

	it('omits expiresAt and expiresInMs while locked', () => {
		const locked = unlockState(T0);
		assert.strictEqual(locked.expiresAt, undefined);
		assert.strictEqual(locked.expiresInMs, undefined);
		assert.ok(!('expiresAt' in locked), 'expiresAt is absent, not undefined');
		assert.ok(!('expiresInMs' in locked), 'expiresInMs is absent, not undefined');
	});

	it('omits expiresAt and expiresInMs once the window has lapsed', () => {
		setUnlocked(true, T0);
		const lapsed = unlockState(T0 + UNLOCK_TTL_MS);
		assert.strictEqual(lapsed.unlocked, false);
		assert.strictEqual(lapsed.expiresAt, undefined);
		assert.strictEqual(lapsed.expiresInMs, undefined);
	});
});

describe('re-locking', () => {
	it('takes effect immediately, with no grace period', () => {
		setUnlocked(true, T0);
		const state = setUnlocked(false, T0 + 1_000);
		assert.strictEqual(state.unlocked, false);
		assert.strictEqual(state.expiresAt, undefined);
		assert.strictEqual(isUnlocked(T0 + 1_000), false);
	});

	it('stays locked even at an instant the old window still covered', () => {
		setUnlocked(true, T0);
		setUnlocked(false, T0 + 1_000);
		assert.strictEqual(isUnlocked(T0 + 2_000), false);
	});
});

describe('unlocking again', () => {
	it('refreshes the window from the new instant', () => {
		setUnlocked(true, T0);
		const state = setUnlocked(true, T0 + 10 * 60 * 1000);
		assert.strictEqual(state.expiresInMs, UNLOCK_TTL_MS);
		assert.strictEqual(state.expiresAt, new Date(T0 + 10 * 60 * 1000 + UNLOCK_TTL_MS).toISOString());
		// Past the FIRST window's deadline, but inside the second.
		assert.strictEqual(isUnlocked(T0 + UNLOCK_TTL_MS + 1_000), true);
	});

	it('re-unlocking after a lapse works from the locked state', () => {
		setUnlocked(true, T0);
		assert.strictEqual(isUnlocked(T0 + UNLOCK_TTL_MS), false);
		const state = setUnlocked(true, T0 + UNLOCK_TTL_MS);
		assert.strictEqual(state.unlocked, true);
		assert.strictEqual(state.expiresInMs, UNLOCK_TTL_MS);
	});
});

describe('the window is absolute, not idle-extended', () => {
	it('repeated isUnlocked() reads do NOT extend the deadline', () => {
		setUnlocked(true, T0);
		// Poll every 30s for the whole window, exactly as an open dashboard tab would.
		for (let t = T0; t < T0 + UNLOCK_TTL_MS; t += 30_000) {
			assert.strictEqual(isUnlocked(t), true, `still unlocked at +${t - T0}ms`);
		}
		// An idle-extended window would have renewed on the last read and still be open.
		assert.strictEqual(isUnlocked(T0 + UNLOCK_TTL_MS), false, 'reads did not renew the window');
	});

	it('repeated unlockState() reads do NOT extend the deadline', () => {
		setUnlocked(true, T0);
		for (let t = T0; t < T0 + UNLOCK_TTL_MS; t += 1_000) {
			unlockState(t);
		}
		assert.strictEqual(unlockState(T0 + UNLOCK_TTL_MS).unlocked, false);
	});

	it('expiresAt is pinned to the unlock instant across many reads', () => {
		const expected = new Date(T0 + UNLOCK_TTL_MS).toISOString();
		setUnlocked(true, T0);
		for (const t of [T0, T0 + 1_000, T0 + 120_000, T0 + UNLOCK_TTL_MS - 1]) {
			assert.strictEqual(unlockState(t).expiresAt, expected, `expiresAt unchanged at +${t - T0}ms`);
		}
	});

	it('a read close to the deadline does not buy another full window', () => {
		setUnlocked(true, T0);
		assert.strictEqual(unlockState(T0 + UNLOCK_TTL_MS - 1).expiresInMs, 1);
		assert.strictEqual(isUnlocked(T0 + UNLOCK_TTL_MS), false);
	});
});

describe('lazy expiry', () => {
	it('a process that sleeps through the window comes back locked', () => {
		setUnlocked(true, T0);
		// No read at all until long after the deadline: no timer was needed.
		assert.strictEqual(isUnlocked(T0 + 24 * 60 * 60 * 1000), false);
	});

	it('an expired unlock stays expired even if the clock is asked about an earlier instant', () => {
		setUnlocked(true, T0);
		assert.strictEqual(isUnlocked(T0 + UNLOCK_TTL_MS), false);
		// The lapse was recorded, so a stale/earlier clock reading cannot resurrect it.
		assert.strictEqual(isUnlocked(T0 + 1_000), false);
	});
});

describe('the default clock', () => {
	it('uses Date.now() when no clock is injected', () => {
		const state = setUnlocked(true);
		assert.strictEqual(state.unlocked, true);
		assert.ok((state.expiresInMs ?? 0) > UNLOCK_TTL_MS - 5_000, 'a fresh window');
		assert.strictEqual(isUnlocked(), true);
	});
});
