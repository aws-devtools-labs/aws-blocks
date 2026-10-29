// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { test } from 'node:test';
import { findBreakpoint } from '../src/core/breakpoint.js';
import type { ProbeOutcome } from '../src/core/types.js';

const ok: ProbeOutcome = { status: 'ok', value: null };
const err = (name = 'Limit'): ProbeOutcome => ({ status: 'error', error: { name } });
const limitAt = (limit: number) => async (n: number) => (n <= limit ? ok : err());

test('finds the first failing value in ~log2(range) attempts', async () => {
	const r = await findBreakpoint({ min: 1, max: 10_000 }, limitAt(3000));
	assert.strictEqual(r.breakpoint, 3001);
	assert.strictEqual(r.monotonic, true);
	assert.deepStrictEqual(r.failure, err());
	assert.ok(r.attempts.length <= 18, `took ${r.attempts.length} attempts`);
});

test('no breakpoint when the top of the range succeeds — one attempt', async () => {
	const r = await findBreakpoint({ min: 1, max: 10_000 }, limitAt(Number.POSITIVE_INFINITY));
	assert.strictEqual(r.breakpoint, null);
	assert.strictEqual(r.attempts.length, 1);
});

test('edges: failing at min, failing only at max', async () => {
	assert.strictEqual((await findBreakpoint({ min: 1, max: 100 }, limitAt(0))).breakpoint, 1);
	assert.strictEqual((await findBreakpoint({ min: 1, max: 100 }, limitAt(99))).breakpoint, 100);
});

test('a success above the breakpoint marks the result non-monotonic', async () => {
	// Breaks above 3,000 but succeeds again at 7,667 — one of the re-checked points (3001 + ⌈6999·2/3⌉).
	const r = await findBreakpoint({ min: 1, max: 10_000 }, async (n) => (n <= 3000 || n === 7667 ? ok : err()));
	assert.strictEqual(r.breakpoint, 3001);
	assert.strictEqual(r.monotonic, false);
});

test('setup failure aborts the search instead of reporting a breakpoint', async () => {
	const r = await findBreakpoint({ min: 1, max: 100 }, async (n) =>
		n > 50 ? { status: 'setup-failed', error: { name: 'Seed' } } : ok,
	);
	assert.strictEqual(r.breakpoint, null);
	assert.match(r.aborted ?? '', /setup failed at \d+: Seed/);
});
