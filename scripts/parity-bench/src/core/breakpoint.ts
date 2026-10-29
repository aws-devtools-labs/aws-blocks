// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Breakpoint search for slider cases. Pure: the caller supplies `attempt`, so
 * the same algorithm drives a local dev server, a deployed stack, or a unit test.
 *
 * Limits are almost always monotonic — once a block fails at N it fails above N —
 * so a binary search finds the first failing value in ~log2(max − min) attempts
 * instead of stepping through the range. A few values above the breakpoint are
 * then re-checked; if one succeeds again, the result is marked non-monotonic
 * rather than trusted.
 */

import type { ProbeOutcome, SweepSpec } from './types.js';

export interface BreakpointResult {
	/** First failing value, or `null` when every value up to `max` succeeded. */
	breakpoint: number | null;
	/** The failing outcome at the breakpoint. */
	failure?: ProbeOutcome;
	monotonic: boolean;
	/** Set when an attempt reported `setup-failed`: the search stopped, and its result is not trustworthy. */
	aborted?: string;
	attempts: { value: number; status: ProbeOutcome['status'] }[];
}

/** How many values above the breakpoint are re-checked for monotonicity. */
const CONFIRM_POINTS = 3;

export async function findBreakpoint(
	sweep: Pick<SweepSpec, 'min' | 'max'>,
	attempt: (value: number) => Promise<ProbeOutcome>,
): Promise<BreakpointResult> {
	const attempts: BreakpointResult['attempts'] = [];
	const seen = new Map<number, ProbeOutcome>();
	let aborted: string | undefined;
	const probe = async (value: number): Promise<ProbeOutcome> => {
		const cached = seen.get(value);
		if (cached) return cached;
		const outcome = await attempt(value);
		seen.set(value, outcome);
		attempts.push({ value, status: outcome.status });
		if (outcome.status === 'setup-failed') aborted ??= `setup failed at ${value}: ${outcome.error.name}`;
		return outcome;
	};
	const fails = (o: ProbeOutcome) => o.status !== 'ok';

	const { min, max } = sweep;
	if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
		throw new Error(`invalid sweep range [${min}, ${max}]`);
	}

	const top = await probe(max);
	if (aborted) return { breakpoint: null, monotonic: true, aborted, attempts };
	if (!fails(top)) return { breakpoint: null, monotonic: true, attempts };
	// Invariant: everything below `lo` is assumed to succeed; `hi` is the lowest known failure.
	// `min` itself is never probed on its own: a case must declare a `min` that is expected to
	// succeed. If it fails anyway, the search reports `breakpoint === min` (the first failure
	// observed), with no evidence about the values below it.
	let lo = min;
	let hi = max;
	while (lo < hi) {
		const mid = Math.floor((lo + hi) / 2);
		const o = await probe(mid);
		if (aborted) return { breakpoint: null, monotonic: true, aborted, attempts };
		if (fails(o)) hi = mid;
		else lo = mid + 1;
	}
	const breakpoint = hi;

	// Re-check a few values above the breakpoint: spread across (breakpoint, max].
	let monotonic = true;
	for (let i = 1; i <= CONFIRM_POINTS && breakpoint + i <= max; i++) {
		const value = i === 1 ? breakpoint + 1 : breakpoint + Math.ceil(((max - breakpoint) * i) / CONFIRM_POINTS);
		const o = await probe(Math.min(value, max));
		if (aborted) return { breakpoint: null, monotonic: true, aborted, attempts };
		if (!fails(o)) monotonic = false;
	}
	return { breakpoint, failure: seen.get(breakpoint), monotonic, attempts };
}
