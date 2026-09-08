// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { Scope, registerSdkIdentifiers } from '@aws-blocks/core';
import { AsyncJob, AsyncJobErrors, BatchSubmitFailedError } from './index.aws.js';

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
			(err: unknown) => {
				assert.ok(err instanceof BatchSubmitFailedError, 'typed error, no cast needed');
				assert.strictEqual(err.name, AsyncJobErrors.BatchSubmitFailed);
				assert.strictEqual(err.message.includes('1 of 15'), true);

				assert.deepStrictEqual(err.failed, [
					{ index: 12, code: 'InternalError', message: 'boom' },
				]);

				// The 14 that made it onto the queue keep their real MessageIds so the
				// caller can still look them up; only the failed index is null.
				assert.strictEqual(err.jobIds.length, 15);
				assert.strictEqual(err.jobIds[12], null);
				assert.strictEqual(err.jobIds[0], 'msg-0');
				assert.strictEqual(err.jobIds[14], 'msg-14');
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

	test('a MissingResult (entry in neither Successful nor Failed) becomes a failure, not a null success', async () => {
		const scope = new Scope(`aj-${Math.random().toString(36).slice(2)}`);
		const job = new AsyncJob<{ n: number }>(scope, 'batch', { handler: async () => {} });
		registerSdkIdentifiers(job.fullId, { queueUrl: QUEUE_URL });
		// Drop entry '1' from both result lists — SQS should never do this, but if it
		// does the index must not silently return as a null "success".
		(job as any)._sqsClient = {
			send: async (cmd: { input: { Entries: BatchEntry[] } }) => {
				const kept = cmd.input.Entries.filter(e => e.Id !== '1');
				return { Successful: kept.map(e => ({ Id: e.Id, MessageId: `msg-${e.Id}` })), Failed: [] };
			},
		};

		await assert.rejects(
			() => job.submitBatch(Array.from({ length: 3 }, (_, i) => ({ n: i }))),
			(err: unknown) => {
				assert.ok(err instanceof BatchSubmitFailedError);
				assert.strictEqual(err.jobIds[1], null);
				assert.strictEqual(err.jobIds[0], 'msg-0');
				const f = err.failed.find(x => x.index === 1);
				assert.strictEqual(f?.code, 'MissingResult');
				return true;
			},
		);
	});

	test('rejects a batch over the soft cap with BatchTooLarge before touching SQS', async () => {
		const { job, sentBatches } = makeJob();
		await assert.rejects(
			() => job.submitBatch(Array.from({ length: 10_001 }, () => ({ n: 0 }))),
			(err: Error) => {
				assert.strictEqual(err.name, AsyncJobErrors.BatchTooLarge);
				return true;
			},
		);
		assert.strictEqual(sentBatches.length, 0);
	});

	test('a status-write failure on the success path does not fail the submit', async () => {
		const { job } = makeJob();
		// No trackStatus, so inject a tracker whose batch write rejects. Every message
		// is already enqueued and the handler backfills `queued`, so submit must still
		// resolve rather than making the caller re-submit and double-enqueue.
		(job as any)._status = {
			recordQueuedBatch: async () => { throw new Error('ProvisionedThroughputExceededException'); },
		};

		const { jobIds, failed } = await job.submitBatch(Array.from({ length: 3 }, (_, i) => ({ n: i })));
		assert.deepStrictEqual(failed, []);
		assert.deepStrictEqual(jobIds, ['msg-0', 'msg-1', 'msg-2']);
	});
});

describe('AsyncJob (aws runtime): submitBatch concurrency and transport failures', () => {
	test('sends chunks with bounded concurrency (>1 in flight, never more than 5)', async () => {
		const scope = new Scope(`aj-${Math.random().toString(36).slice(2)}`);
		const job = new AsyncJob<{ n: number }>(scope, 'batch', { handler: async () => {} });
		registerSdkIdentifiers(job.fullId, { queueUrl: QUEUE_URL });

		let inFlight = 0;
		let peak = 0;
		(job as any)._sqsClient = {
			send: async (cmd: { input: { Entries: BatchEntry[] } }) => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await new Promise(r => setTimeout(r, 5));
				inFlight--;
				return { Successful: cmd.input.Entries.map(e => ({ Id: e.Id, MessageId: `msg-${e.Id}` })), Failed: [] };
			},
		};

		// 80 payloads → 8 chunks of 10.
		const { jobIds } = await job.submitBatch(Array.from({ length: 80 }, (_, i) => ({ n: i })));
		assert.strictEqual(jobIds.length, 80);
		assert.ok(peak > 1, 'chunks should overlap rather than run fully serially');
		assert.ok(peak <= 5, `peak concurrency ${peak} must not exceed 5`);
	});

	test('a transport-level send rejection fails that chunk and short-circuits the rest', async () => {
		const scope = new Scope(`aj-${Math.random().toString(36).slice(2)}`);
		const job = new AsyncJob<{ n: number }>(scope, 'batch', { handler: async () => {} });
		registerSdkIdentifiers(job.fullId, { queueUrl: QUEUE_URL });

		const sent: string[][] = [];
		(job as any)._sqsClient = {
			send: async (cmd: { input: { Entries: BatchEntry[] } }) => {
				const ids = cmd.input.Entries.map(e => e.Id);
				sent.push(ids);
				// Chunk whose first entry is index 10 rejects synchronously (before any
				// await), so `aborted` is set before workers pick up chunks 5..9.
				if (ids[0] === '10') {
					const err = new Error('Rate exceeded');
					err.name = 'ThrottlingException';
					throw err;
				}
				await new Promise(r => setTimeout(r, 20));
				return { Successful: cmd.input.Entries.map(e => ({ Id: e.Id, MessageId: `msg-${e.Id}` })), Failed: [] };
			},
		};

		// 100 payloads → 10 chunks of 10, concurrency 5: chunks 0..4 dispatch first,
		// chunk 1 (indices 10..19) rejects, chunks 5..9 are short-circuited.
		await assert.rejects(
			() => job.submitBatch(Array.from({ length: 100 }, (_, i) => ({ n: i }))),
			(err: unknown) => {
				assert.ok(err instanceof BatchSubmitFailedError);
				assert.strictEqual(err.jobIds.length, 100);

				// Chunk 0 landed.
				assert.strictEqual(err.jobIds[0], 'msg-0');
				// Chunk 1 failed at the transport level — every index carries the code.
				assert.strictEqual(err.jobIds[10], null);
				assert.strictEqual(err.failed.find(f => f.index === 10)?.code, 'ThrottlingException');
				assert.strictEqual(err.failed.find(f => f.index === 19)?.code, 'ThrottlingException');
				// Chunks 5..9 were never sent (only 0..4 attempted).
				assert.strictEqual(sent.length, 5);
				assert.strictEqual(err.jobIds[50], null);
				assert.strictEqual(err.failed.find(f => f.index === 50)?.code, 'BatchSubmitAborted');
				return true;
			},
		);
	});
});
