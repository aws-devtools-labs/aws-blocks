// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reusable probe shapes. A pack supplies only block-specific facts — which
 * method, how the service measures the dimension — and the kind supplies the
 * shape: read the sweep value, build input of exactly that size or count, run
 * setup → act → cleanup, and report a small summary.
 *
 *   countLimit — n units acted on at once: rows per statement, items per batch, recipients, keys per delete
 *   sizeLimit  — one value of exactly n bytes: item, message, metadata, secret, payload
 */

import { param, runCase } from '../server/helpers.js';
import type { ParityCase, ProbeRun } from '../core/types.js';

/** The value the driver is sweeping on a slider case (or the fixed value on a fixed case). */
export function sweepValue(c: ParityCase): number {
	const key = c.sweep?.param;
	if (!key) throw new Error(`parity case ${c.id} is not a slider case`);
	return param(c.params, key, 'number');
}

/** Seed `n` units, act on all of them in one call, clean up whatever was seeded. */
export function countLimit<S>(
	c: ParityCase,
	steps: {
		setup: (n: number) => Promise<S>;
		act: (state: S, n: number) => Promise<unknown>;
		cleanup: (state: S | undefined, n: number) => Promise<void>;
	},
): Promise<ProbeRun> {
	const n = sweepValue(c);
	return runCase({
		setup: () => steps.setup(n),
		act: (state) => steps.act(state, n),
		cleanup: (state) => steps.cleanup(state, n),
	});
}

/** Write one value of exactly `n` bytes (as built by `build`), then report what the block did. */
export function sizeLimit<V, S = undefined>(
	c: ParityCase,
	steps: {
		build: (n: number) => V;
		setup?: () => Promise<S>;
		act: (value: V, state: S) => Promise<unknown>;
		cleanup?: (state: S | undefined) => Promise<void>;
	},
): Promise<ProbeRun> {
	const n = sweepValue(c);
	return runCase({
		setup: async () => ({ value: steps.build(n), state: (await steps.setup?.()) as S }),
		act: ({ value, state }) => steps.act(value, state),
		cleanup: async (s) => steps.cleanup?.(s?.state),
	});
}

// ── Payload generators: exact sizes, measured the way AWS services measure (UTF-8 bytes) ──

/** A string of exactly `bytes` UTF-8 bytes. `multibyte` packs 3-byte characters, so chars ≈ bytes / 3. */
export function utf8OfBytes(bytes: number, options: { multibyte?: boolean } = {}): string {
	if (!options.multibyte) return 'a'.repeat(bytes);
	const wide = '日'; // 3 bytes in UTF-8
	return wide.repeat(Math.floor(bytes / 3)) + 'a'.repeat(bytes % 3);
}

/** A string whose `JSON.stringify` form is exactly `bytes` UTF-8 bytes (the two quotes count). */
export function jsonStringOfBytes(bytes: number): string {
	if (bytes < 2) throw new Error('a JSON string is at least 2 bytes ("")');
	return 'a'.repeat(bytes - 2);
}

/** `n` ids `<prefix><zero-padded index>`, split into batches of at most `batchSize` (for seeding under a limit). */
export function idBatches(prefix: string, n: number, batchSize: number): string[][] {
	const width = String(Math.max(n - 1, 0)).length;
	const batches: string[][] = [];
	for (let start = 0; start < n; start += batchSize) {
		const end = Math.min(n, start + batchSize);
		batches.push(Array.from({ length: end - start }, (_, i) => `${prefix}${String(start + i).padStart(width, '0')}`));
	}
	return batches;
}
