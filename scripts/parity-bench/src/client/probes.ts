// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * node:test adapter for a stack's `probe` namespace: one test per catalog case.
 * A fixed case runs once; a slider case runs a breakpoint search. Both are
 * recorded (`E2E_PARITY_DIR`) and assert only that the harness worked — seeding
 * succeeded and everything was cleaned up. Comparison happens afterwards in the
 * differ. Registers nothing unless `E2E_PARITY_PROBES=true`.
 */

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { findBreakpoint } from '../core/breakpoint.js';
import type { ParityCase, ProbeClient } from '../core/types.js';
import { writeRecord } from './recorder.js';

const ENV = process.env.BLOCKS_TEST_ENV || 'local';

export interface ParityProbeTestOptions {
	/** Per-case timeout. A slider case runs ~log2(range) + 3 attempts in one test. */
	fixedTimeoutMs?: number;
	sweepTimeoutMs?: number;
}

export function parityProbeTests(
	getProbe: () => ProbeClient,
	catalog: readonly ParityCase[],
	options: ParityProbeTestOptions = {},
): void {
	const enabled = process.env.E2E_PARITY_PROBES === 'true';
	describe('Parity probes', { skip: !enabled && 'E2E_PARITY_PROBES not set' }, () => {
		test('backend serves the same catalog as the runner', async () => {
			const served = (await getProbe().listCases()).map((c) => c.id);
			assert.deepStrictEqual(served, catalog.map((c) => c.id));
		});

		for (const c of catalog) {
			if (c.sweep) {
				const sweep = c.sweep;
				test(c.id, { timeout: options.sweepTimeoutMs ?? 600_000 }, async () => {
					const started = Date.now();
					let cleanupFailed = false;
					const result = await findBreakpoint(sweep, async (value) => {
						const r = await getProbe().attempt(c.id, value);
						if (r.cleanup !== 'ok') cleanupFailed = true;
						return r.outcome;
					});
					const failure = result.failure;
					writeRecord({
						kind: 'sweep',
						env: ENV,
						block: c.block,
						caseId: c.id,
						unit: sweep.unit,
						...(sweep.documented === undefined ? {} : { documented: sweep.documented }),
						breakpoint: result.breakpoint,
						max: sweep.max,
						...(failure && failure.status !== 'ok' ? { errorAtBreakpoint: failure.error } : {}),
						monotonic: result.monotonic,
						...(result.aborted ? { aborted: result.aborted } : {}),
						attempts: result.attempts,
						ms: Date.now() - started,
					});
					assert.strictEqual(result.aborted, undefined, `sweep aborted: ${result.aborted}`);
					assert.ok(!cleanupFailed, 'an attempt did not clean up after itself');
				});
				continue;
			}
			test(c.id, { timeout: options.fixedTimeoutMs ?? 120_000 }, async () => {
				const r = await getProbe().run(c.id);
				writeRecord({
					kind: 'probe',
					env: ENV,
					block: c.block,
					caseId: c.id,
					outcome: r.outcome,
					cleanup: r.cleanup,
					ms: r.durationMs,
				});
				assert.notStrictEqual(r.outcome.status, 'setup-failed', `setup failed: ${JSON.stringify(r.outcome)}`);
				assert.strictEqual(r.cleanup, 'ok', 'the case did not clean up after itself');
			});
		}
	});
}
