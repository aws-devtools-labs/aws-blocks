// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AsyncJob status tracking e2e.
 *
 * These run in every environment on purpose. Locally they exercise the mock
 * store; against a sandbox or production stack the identical assertions travel
 * through SQS, the shared Lambda and a real DynamoDB table, which is the only
 * place the nested `transitions` list and the numeric attributes actually get
 * marshalled and unmarshalled.
 *
 * No handler involved here contains a delay. The point of the transition history
 * is that intermediate states stay observable without one.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import type { api as apiType } from 'aws-blocks';

const ENV = process.env.BLOCKS_TEST_ENV || 'local';
const isDeployed = ENV === 'sandbox' || ENV === 'production';

// Deployed runs pay for SQS delivery plus a Lambda cold start before the handler
// even begins, so the wait budget is far longer than the local one.
const WAIT_BUDGET_MS = isDeployed ? 120_000 : 15_000;
const TEST_TIMEOUT_MS = WAIT_BUDGET_MS + 60_000;

type Transition = { state: string; at: string; attempt: number };

function assertWellFormedTransitions(transitions: Transition[]): void {
	assert.ok(Array.isArray(transitions), 'transitions must survive as an array');

	for (const [index, transition] of transitions.entries()) {
		// A DynamoDB list of maps round-trips through the document client; if
		// marshalling regressed these would come back as strings or wrapped
		// attribute values rather than plain JS types.
		assert.strictEqual(
			typeof transition.state,
			'string',
			`transition ${index} state should be a string, got ${typeof transition.state}`,
		);
		assert.strictEqual(
			typeof transition.attempt,
			'number',
			`transition ${index} attempt should be a number, got ${typeof transition.attempt}`,
		);
		assert.ok(
			Number.isInteger(transition.attempt),
			`transition ${index} attempt should be an integer, got ${transition.attempt}`,
		);
		assert.ok(
			Number.isFinite(Date.parse(transition.at)),
			`transition ${index} at should parse as a date, got ${transition.at}`,
		);
	}

	const times = transitions.map(t => Date.parse(t.at));
	for (let i = 1; i < times.length; i++) {
		assert.ok(times[i] >= times[i - 1], `transition ${i} must not predate transition ${i - 1}`);
	}
}

function assertNoStorageLeak(status: object): void {
	const record = status as Record<string, unknown>;
	assert.strictEqual(record.expiresAt, undefined, 'TTL attribute must not surface');
	assert.strictEqual(record.version, undefined, 'concurrency version must not surface');
}

export function asyncJobStatusTests(getApi: () => typeof apiType) {
	describe('AsyncJob status tracking', () => {
		test(
			'AsyncJob status - queued/processing/complete round-trips through the store',
			{ timeout: TEST_TIMEOUT_MS },
			async () => {
				const api = getApi();
				const testId = Date.now().toString(36);
				const { jobId } = await api.asyncJobStatusSubmit(`tracked-${testId}`, 'hello');
				assert.ok(typeof jobId === 'string' && jobId.length > 0);

				const status = await api.asyncJobStatusWait(jobId, WAIT_BUDGET_MS);

				assert.strictEqual(status.state, 'complete');
				assert.strictEqual(status.jobId, jobId);
				assert.deepStrictEqual(
					status.transitions.map((t: Transition) => t.state),
					['queued', 'processing', 'complete'],
					'the whole sequence must be recorded even though the handler returned immediately',
				);
				assertWellFormedTransitions(status.transitions);
				assert.deepStrictEqual(status.transitions.map((t: Transition) => t.attempt), [0, 1, 1]);

				assert.strictEqual(typeof status.attempts, 'number');
				assert.strictEqual(status.attempts, 1);
				assert.ok(Number.isFinite(Date.parse(status.submittedAt)));
				assert.ok(Number.isFinite(Date.parse(status.updatedAt)));
				assert.strictEqual(status.error, undefined, 'a successful job must not carry an error');
				assertNoStorageLeak(status);

				// The handler wrote through a separate KVStore, so this also confirms the
				// job really ran rather than the status being recorded speculatively.
				assert.strictEqual(await api.asyncJobGetResult(`tracked-${testId}`), null);
			},
		);

		test(
			'AsyncJob status - a single read after the job settled still shows processing',
			{ timeout: TEST_TIMEOUT_MS },
			async () => {
				const api = getApi();
				const testId = Date.now().toString(36);
				const { jobId } = await api.asyncJobStatusSubmit(`after-${testId}`, 'value');

				await api.asyncJobStatusWait(jobId, WAIT_BUDGET_MS);

				// One read, taken only once the job is already done. This is the case that
				// used to need setTimeout(1500) in the handler to be observable at all.
				const status = await api.asyncJobStatusGet(jobId);
				assert.ok(status, 'status should be readable after completion');
				assert.deepStrictEqual(
					status.transitions.map((t: Transition) => t.state),
					['queued', 'processing', 'complete'],
				);
				assertWellFormedTransitions(status.transitions);
				assertNoStorageLeak(status);
			},
		);

		test(
			'AsyncJob status - failed path records the handler error',
			{ timeout: TEST_TIMEOUT_MS },
			async () => {
				const api = getApi();
				const reason = `boom-${Date.now().toString(36)}`;
				const { jobId } = await api.asyncJobStatusSubmitFailing(reason);

				const status = await api.asyncJobStatusWaitFailing(jobId, WAIT_BUDGET_MS);

				assert.strictEqual(status.state, 'failed');
				assert.deepStrictEqual(
					status.transitions.map((t: Transition) => t.state),
					['queued', 'processing', 'failed'],
				);
				assertWellFormedTransitions(status.transitions);

				// The error string is the field most likely to be dropped by a
				// marshalling regression, since it is only present on the failed path.
				assert.ok(status.error, 'a failed job must carry an error message');
				const error: string = status.error;
				assert.match(error, new RegExp(reason));
				assert.match(error, /failed on purpose/);
				assert.strictEqual(status.attempts, 1);
				assertNoStorageLeak(status);
			},
		);

		test(
			'AsyncJob status - submitBatch tracks every job',
			{ timeout: TEST_TIMEOUT_MS },
			async () => {
				const api = getApi();
				const testId = Date.now().toString(36);
				const items = [
					{ key: `tracked-batch-${testId}-0`, value: 'a' },
					{ key: `tracked-batch-${testId}-1`, value: 'b' },
				];

				const { jobIds } = await api.asyncJobStatusSubmitBatch(items);
				assert.strictEqual(jobIds.length, items.length);

				for (const jobId of jobIds) {
					assert.ok(jobId, 'every batch entry should return a job id');
					const status = await api.asyncJobStatusWait(jobId, WAIT_BUDGET_MS);
					assert.strictEqual(status.state, 'complete');
					assert.deepStrictEqual(
						status.transitions.map((t: Transition) => t.state),
						['queued', 'processing', 'complete'],
					);
					assertWellFormedTransitions(status.transitions);
				}
			},
		);

		test(
			'AsyncJob status - getStatus returns null for an unknown job id',
			{ timeout: 30_000 },
			async () => {
				const api = getApi();
				assert.strictEqual(await api.asyncJobStatusGet(`missing-${Date.now()}`), null);
			},
		);
	});
}
