// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { afterEach, describe, test } from 'node:test';
import { SERVERLESS_COMPUTE_LIMITS, validateComputeRequirements } from './compute-provider.js';
// The default/mock entry — the same module a deployed Lambda and `npm run dev`
// import. Resolves `ComputeProvider` to its runtime wrapper and `LambdaCompute`
// to the inert mock handle.
import { ComputeProvider } from './index.js';

/**
 * Requirements are validated against the one fulfillment Phase 1 has
 * (serverless). A workload that exceeds its ceilings has nowhere to go — there
 * is no compute-type escape hatch yet — so it must fail at synth rather than
 * deploy and then time out or OOM under load.
 */
describe('compute requirements validation', () => {
	test('accepts omitted requirements (an app that never mentions compute)', () => {
		assert.doesNotThrow(() => validateComputeRequirements({}));
	});

	test('accepts requirements inside the serverless limits', () => {
		assert.doesNotThrow(() => validateComputeRequirements({ timeoutSeconds: 30, memoryMb: 1024 }));
	});

	test('accepts the limits themselves (boundaries are inclusive)', () => {
		const { maxTimeoutSeconds, maxMemoryMb, minTimeoutSeconds, minMemoryMb } = SERVERLESS_COMPUTE_LIMITS;
		assert.doesNotThrow(() => validateComputeRequirements({ timeoutSeconds: maxTimeoutSeconds, memoryMb: maxMemoryMb }));
		assert.doesNotThrow(() => validateComputeRequirements({ timeoutSeconds: minTimeoutSeconds, memoryMb: minMemoryMb }));
	});

	test('rejects a timeout above the serverless ceiling, naming the value and the limit', () => {
		assert.throws(
			() => validateComputeRequirements({ timeoutSeconds: 1800 }),
			(err: Error) => {
				// An actionable message: which field, what was asked, what the cap is,
				// and what to do instead. "Invalid requirements" alone would leave the
				// customer guessing which dial to turn.
				assert.match(err.message, /timeoutSeconds is 1800/);
				assert.match(err.message, /maximum is 900/);
				assert.match(err.message, /background job/);
				return true;
			},
		);
	});

	test('rejects memory above the serverless ceiling', () => {
		assert.throws(
			() => validateComputeRequirements({ memoryMb: 20480 }),
			(err: Error) => {
				assert.match(err.message, /memoryMb is 20480/);
				assert.match(err.message, /maximum is 10240/);
				return true;
			},
		);
	});

	test('rejects memory below the serverless floor', () => {
		assert.throws(() => validateComputeRequirements({ memoryMb: 64 }), /minimum is 128/);
	});

	test('rejects non-integer and non-positive values', () => {
		assert.throws(() => validateComputeRequirements({ timeoutSeconds: 1.5 }), /positive whole number/);
		assert.throws(() => validateComputeRequirements({ timeoutSeconds: 0 }), /positive whole number/);
		assert.throws(() => validateComputeRequirements({ memoryMb: -512 }), /positive whole number/);
	});

	test('names the compute in the message so a multi-compute app points at the right one', () => {
		assert.throws(() => validateComputeRequirements({ memoryMb: 99999 }, 'app/ReportWorker'), /"app\/ReportWorker"/);
	});
});

/**
 * The runtime/mock path. A backend module that declares a compute is imported
 * twice — at synth (CDK) and again inside the deployed Lambda and local dev,
 * where there is no BlocksStack and no ambient `CURRENT_BLOCKS_STACK`. The
 * declaration must still resolve to an inert handle there rather than throw, or
 * every app that declares a compute would crash on cold start and under
 * `npm run dev`. (The "declared before the stack existed" guard is CDK-only.)
 */
describe('ComputeProvider.provide (runtime/mock)', () => {
	afterEach(() => {
		delete (globalThis as { CURRENT_BLOCKS_STACK?: unknown }).CURRENT_BLOCKS_STACK;
	});

	test('resolves to an inert handle when no stack exists (Lambda / local dev)', () => {
		delete (globalThis as { CURRENT_BLOCKS_STACK?: unknown }).CURRENT_BLOCKS_STACK;

		let handle: unknown;
		assert.doesNotThrow(() => {
			handle = ComputeProvider.provide('reports', { timeoutSeconds: 60, memoryMb: 512 });
		});
		assert.ok(handle, 'a reference to the declared compute still points at something at runtime');
	});

	test('still validates requirements at runtime, not only at synth', () => {
		delete (globalThis as { CURRENT_BLOCKS_STACK?: unknown }).CURRENT_BLOCKS_STACK;

		// A bad value must fail the first time the app runs locally, not silently
		// resolve and then deploy an out-of-policy compute.
		assert.throws(() => ComputeProvider.provide('reports', { timeoutSeconds: 3600 }), /maximum is 900/);
	});
});
