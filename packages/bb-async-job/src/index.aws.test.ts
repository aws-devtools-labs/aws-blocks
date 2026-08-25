// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { Scope, registerSdkIdentifiers } from '@aws-blocks/core';
import { AsyncJob, AsyncJobErrors } from './index.aws.js';

/**
 * AWS-runtime coverage for `submitBatch` chunking. The mock runtime submits one
 * message at a time, so the SQS `SendMessageBatch` packing, the id-mapping back
 * into input order, and the not-atomic partial-failure semantics only exist here
 * and are only observable against a stubbed SQS client.
 */

const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/000000000000/test-queue';

/** Command shapes we assert against, avoiding an SQS SDK type import in the test. */
interface BatchEntry {
	Id: string;
	MessageBody: string;
	DelaySeconds?: number;
}

/**
 * Build an AsyncJob wired to a stub SQS client. `registerSdkIdentifiers` seeds the
 * queue URL keyed by the block's fullId so `ensureQueueUrl()` passes without a
 * deployed stack; the stub replaces the real client so nothing hits the network.
 */
function makeJob(failIds: Set<string> = new Set()) {
	const scope = new Scope(`aj-${Math.random().toString(36).slice(2)}`);
	const job = new AsyncJob<{ n?: number; data?: string }>(scope, 'batch', {
		handler: async () => {},
	});
	registerSdkIdentifiers(job.fullId, { queueUrl: QUEUE_URL });

	const sentBatches: BatchEntry[][] = [];
	(job as any)._sqsClient = {
		send: async (cmd: { input: { QueueUrl: string; Entries: BatchEntry[] } }) => {
			const entries = cmd.input.Entries;
			sentBatches.push(entries);
			const Successful: Array<{ Id: string; MessageId: string }> = [];
			const Failed: Array<{ Id: string; Code: string; Message: string; SenderFault: boolean }> = [];
			for (const e of entries) {
				if (failIds.has(e.Id)) {
					Failed.push({ Id: e.Id, Code: 'InternalError', Message: 'boom', SenderFault: false });
				} else {
					Successful.push({ Id: e.Id, MessageId: `msg-${e.Id}` });
				}
			}
			return { Successful, Failed };
		},
	};

	return { job, sentBatches };
}

describe('AsyncJob (aws runtime): submitBatch chunking', () => {
	test('splits >10 payloads into 10-entry SendMessageBatch requests', async () => {
		const { job, sentBatches } = makeJob();

		const { jobIds, failed } = await job.submitBatch(
			Array.from({ length: 25 }, (_, i) => ({ n: i })),
		);

		assert.strictEqual(sentBatches.length, 3, '25 → 10 + 10 + 5');
		assert.deepStrictEqual(sentBatches.map(b => b.length), [10, 10, 5]);
		assert.deepStrictEqual(failed, []);
		// jobIds are in input order and carry the SQS-assigned MessageId per index.
		assert.strictEqual(jobIds.length, 25);
		jobIds.forEach((id, i) => {
			assert.strictEqual(id, `msg-${i}`);
		});
	});

	test('each SendMessageBatch entry carries a unique Id within its request', async () => {
		const { job, sentBatches } = makeJob();
		await job.submitBatch(Array.from({ length: 15 }, (_, i) => ({ n: i })));
		for (const batch of sentBatches) {
			const ids = batch.map(e => e.Id);
			assert.strictEqual(new Set(ids).size, ids.length, 'SQS rejects duplicate batch entry Ids');
		}
	});

	test('starts a new chunk when the 256 KB aggregate-body limit would be exceeded', async () => {
		const { job, sentBatches } = makeJob();

		// Two ~200 KB payloads: each is under the 256 KB per-message limit, but their
		// sum exceeds the 256 KB per-request limit, so they cannot share a batch.
		const big = { data: 'x'.repeat(200 * 1024) };
		const { jobIds } = await job.submitBatch([big, big]);

		assert.strictEqual(sentBatches.length, 2, 'byte limit forces a split even under 10 entries');
		assert.deepStrictEqual(sentBatches.map(b => b.length), [1, 1]);
		assert.deepStrictEqual(jobIds, ['msg-0', 'msg-1']);
	});
});

describe('AsyncJob (aws runtime): submitBatch partial failure', () => {
	test('throws BatchSubmitFailed carrying jobIds (real ids + null) and failed[] across chunks', async () => {
		// 15 payloads → chunks [0..9] and [10..14]; fail one entry in the second chunk.
		const { job } = makeJob(new Set(['12']));

		await assert.rejects(
			() => job.submitBatch(Array.from({ length: 15 }, (_, i) => ({ n: i }))),
			(err: Error & { failed?: any[]; jobIds?: Array<string | null> }) => {
				assert.strictEqual(err.name, AsyncJobErrors.BatchSubmitFailed);
				assert.strictEqual(err.message.includes('1 of 15'), true);

				assert.deepStrictEqual(err.failed, [
					{ index: 12, code: 'InternalError', message: 'boom' },
				]);

				// The 14 that made it onto the queue keep their real MessageIds so the
				// caller can still look them up; only the failed index is null.
				assert.strictEqual(err.jobIds?.length, 15);
				assert.strictEqual(err.jobIds![12], null);
				assert.strictEqual(err.jobIds![0], 'msg-0');
				assert.strictEqual(err.jobIds![14], 'msg-14');
				return true;
			},
		);
	});

	test('empty batch throws BatchEmpty before touching SQS', async () => {
		const { job, sentBatches } = makeJob();
		await assert.rejects(
			() => job.submitBatch([]),
			(err: Error) => err.name === AsyncJobErrors.BatchEmpty,
		);
		assert.strictEqual(sentBatches.length, 0);
	});
});
