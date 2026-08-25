// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { AsyncJob, AsyncJobErrors } from './index.mock.js';

// Helper: wait for async job processing to complete
async function waitForJobs(ms = 100) {
	await sleep(ms);
}

test('AsyncJob - submit calls handler with payload and context', async () => {
	let receivedPayload: any ;
	let receivedCtx: any ;

	const job = new AsyncJob(null as any, 'test', {
		handler: async (payload: { msg: string }, ctx) => {
			receivedPayload = payload;
			receivedCtx = ctx;
		},
	});

	const { jobId } = await job.submit({ msg: 'hello' });
	await waitForJobs();

	assert.deepStrictEqual(receivedPayload, { msg: 'hello' });
	assert.strictEqual(receivedCtx.jobId, jobId);
	assert.strictEqual(receivedCtx.receiveCount, 1);
	assert.ok(receivedCtx.sentAt, 'sentAt should be set');
});

test('AsyncJob - submit returns a jobId', async () => {
	const job = new AsyncJob(null as any, 'test', {
		handler: async () => {},
	});

	const { jobId } = await job.submit({ x: 1 });
	assert.ok(typeof jobId === 'string');
	assert.ok(jobId.length > 0);
});

test('AsyncJob - submitBatch returns jobIds in order', async () => {
	const payloads: number[] = [];

	const job = new AsyncJob(null as any, 'test', {
		handler: async (payload: { n: number }) => {
			payloads.push(payload.n);
		},
	});

	const { jobIds } = await job.submitBatch([{ n: 1 }, { n: 2 }, { n: 3 }]);
	await waitForJobs();

	assert.strictEqual(jobIds.length, 3);
	assert.ok(jobIds.every(id => typeof id === 'string' && id.length > 0));
});

test('AsyncJob - submitBatch throws BatchEmpty for empty array', async () => {
	const job = new AsyncJob(null as any, 'test', {
		handler: async () => {},
	});

	await assert.rejects(
		() => job.submitBatch([]),
		(err: Error) => {
			assert.strictEqual(err.name, AsyncJobErrors.BatchEmpty);
			assert.ok(err.message.includes('empty'));
			return true;
		}
	);
});

test('AsyncJob - submitBatch auto-chunks batches larger than 10', async () => {
	const received: number[] = [];

	const job = new AsyncJob(null as any, 'test', {
		handler: async (payload: { n: number }) => {
			received.push(payload.n);
		},
	});

	const items = Array.from({ length: 25 }, (_, i) => ({ n: i }));
	const { jobIds, failed } = await job.submitBatch(items);
	await waitForJobs();

	assert.strictEqual(jobIds.length, 25, 'a jobId per payload, no truncation');
	assert.ok(jobIds.every(id => typeof id === 'string' && id!.length > 0));
	assert.strictEqual(new Set(jobIds).size, 25, 'every jobId is unique');
	assert.deepStrictEqual(failed, []);
	assert.deepStrictEqual(received.sort((a, b) => a - b), items.map(i => i.n), 'every payload was processed');
});

test('AsyncJob - submit throws PayloadTooLarge for >256 KB', async () => {
	const job = new AsyncJob(null as any, 'test', {
		handler: async () => {},
	});

	const hugePayload = { data: 'x'.repeat(300 * 1024) };

	await assert.rejects(
		() => job.submit(hugePayload),
		(err: Error) => {
			assert.strictEqual(err.name, AsyncJobErrors.PayloadTooLarge);
			assert.ok(err.message.includes('256 KB'));
			return true;
		}
	);
});

test('AsyncJob - retries on handler failure up to maxRetries', async () => {
	let attempts = 0;

	const job = new AsyncJob(null as any, 'test', {
		handler: async () => {
			attempts++;
			throw new Error('fail');
		},
		maxRetries: 3,
	});

	await job.submit({ x: 1 });
	// Wait enough for all retries to complete
	await waitForJobs(500);

	assert.strictEqual(attempts, 3, 'should have attempted exactly maxRetries times');
});

test('AsyncJob - handler succeeds on retry', async () => {
	let attempts = 0;
	let succeeded = false;

	const job = new AsyncJob(null as any, 'test', {
		handler: async () => {
			attempts++;
			if (attempts < 3) throw new Error('not yet');
			succeeded = true;
		},
		maxRetries: 5,
	});

	await job.submit({ x: 1 });
	await waitForJobs(500);

	assert.ok(succeeded, 'handler should have eventually succeeded');
	assert.strictEqual(attempts, 3);
});

test('AsyncJob - failed jobs appear in _queue.failed after exhausting retries', async () => {
	const job = new AsyncJob(null as any, 'test', {
		handler: async () => {
			throw new Error('always fails');
		},
		maxRetries: 2,
	});

	await job.submit({ key: 'val' });
	await waitForJobs(500);

	assert.strictEqual(job._queue.failed.length, 1);
	assert.deepStrictEqual(job._queue.failed[0].payload, { key: 'val' });
	assert.strictEqual(job._queue.failed[0].receiveCount, 2);
	assert.ok(job._queue.failed[0].lastError?.includes('always fails'));
});

test('AsyncJob - tracks totalSubmitted and totalCompleted', async () => {
	const job = new AsyncJob(null as any, 'test', {
		handler: async () => {},
	});

	await job.submit({ a: 1 });
	await job.submit({ a: 2 });
	await waitForJobs();

	assert.strictEqual(job._queue.totalSubmitted, 2);
	assert.strictEqual(job._queue.totalCompleted, 2);
});

test('AsyncJob - submitBatch with exactly 10 items succeeds', async () => {
	const job = new AsyncJob(null as any, 'test', {
		handler: async () => {},
	});

	const items = Array.from({ length: 10 }, (_, i) => ({ n: i }));
	const { jobIds } = await job.submitBatch(items);

	assert.strictEqual(jobIds.length, 10);
});

test('AsyncJob - jobId returned by submit is the key getStatus is looked up by', async () => {
	const job = new AsyncJob(null as any, 'test', {
		trackStatus: true,
		handler: async () => {},
	});

	const { jobId } = await job.submit({ x: 1 });

	const status = await job.getStatus(jobId);
	assert.ok(status, 'the id submit returned must resolve a status record');
	assert.strictEqual(status!.jobId, jobId);
});

test('AsyncJob - every jobId from submitBatch resolves its own status record', async () => {
	const job = new AsyncJob(null as any, 'test', {
		trackStatus: true,
		handler: async () => {},
	});

	const { jobIds } = await job.submitBatch(Array.from({ length: 12 }, (_, i) => ({ n: i })));

	for (const jobId of jobIds) {
		assert.ok(jobId, 'no null ids on a fully successful batch');
		const status = await job.getStatus(jobId!);
		assert.ok(status, `getStatus must resolve the id submitBatch returned (${jobId})`);
		assert.strictEqual(status!.jobId, jobId);
	}
});

// ---------------------------------------------------------------------------
// Phase 2: Schema validation
// ---------------------------------------------------------------------------

// Minimal StandardSchemaV1-compatible schema for testing (no Zod dependency)
function createTestSchema<T>(validate: (value: unknown) => { issues: { message: string }[] } | { value: T }) {
	return {
		'~standard': {
			version: 1 as const,
			vendor: 'test',
			validate: (v: unknown) => {
				const r = validate(v);
				if ('issues' in r) return { issues: r.issues, value: undefined as any };
				return { value: r.value, issues: undefined };
			},
		},
	};
}

test('AsyncJob - schema validation passes for valid payload on submit', async () => {
	let received = false;

	const schema = createTestSchema<{ name: string }>((value: any) => {
		if (typeof value?.name === 'string') return { value };
		return { issues: [{ message: 'name must be a string' }] };
	});

	const job = new AsyncJob(null as any, 'test', {
		handler: async () => { received = true; },
		schema,
	});

	await job.submit({ name: 'Alice' });
	await waitForJobs();
	assert.ok(received, 'handler should have run for valid payload');
});

test('AsyncJob - schema validation rejects invalid payload on submit', async () => {
	const schema = createTestSchema<{ name: string }>((value: any) => {
		if (typeof value?.name === 'string') return { value };
		return { issues: [{ message: 'name must be a string' }] };
	});

	const job = new AsyncJob(null as any, 'test', {
		handler: async () => {},
		schema,
	});

	await assert.rejects(
		() => job.submit({ name: 123 } as any),
		(err: Error) => {
			assert.strictEqual(err.name, AsyncJobErrors.ValidationFailed);
			assert.ok(err.message.includes('name must be a string'));
			return true;
		}
	);
});

test('AsyncJob - schema validation rejects invalid payload on submitBatch', async () => {
	const schema = createTestSchema<{ name: string }>((value: any) => {
		if (typeof value?.name === 'string') return { value };
		return { issues: [{ message: 'name must be a string' }] };
	});

	const job = new AsyncJob(null as any, 'test', {
		handler: async () => {},
		schema,
	});

	await assert.rejects(
		() => job.submitBatch([{ name: 'ok' }, { name: 42 } as any]),
		(err: Error) => {
			assert.strictEqual(err.name, AsyncJobErrors.ValidationFailed);
			assert.ok(err.message.includes('name must be a string'));
			return true;
		}
	);
});

test('AsyncJob - schema validation passes for valid batch on submitBatch', async () => {
	const received: string[] = [];

	const schema = createTestSchema<{ name: string }>((value: any) => {
		if (typeof value?.name === 'string') return { value };
		return { issues: [{ message: 'name must be a string' }] };
	});

	const job = new AsyncJob(null as any, 'test', {
		handler: async (payload: { name: string }) => { received.push(payload.name); },
		schema,
	});

	await job.submitBatch([{ name: 'Alice' }, { name: 'Bob' }]);
	await waitForJobs();
	assert.deepStrictEqual(received.sort(), ['Alice', 'Bob']);
});

// ---------------------------------------------------------------------------
// Phase 2: delaySeconds
// ---------------------------------------------------------------------------

test('AsyncJob - submit with delaySeconds defers handler execution', async () => {
	let handlerRan = false;

	const job = new AsyncJob(null as any, 'test', {
		handler: async () => { handlerRan = true; },
	});

	await job.submit({ x: 1 }, { delaySeconds: 1 });

	// Handler should NOT have run yet
	await waitForJobs(100);
	assert.strictEqual(handlerRan, false, 'handler should not run before delay');

	// Wait for delay to expire
	await sleep(1200);
	await waitForJobs(100);
	assert.strictEqual(handlerRan, true, 'handler should run after delay');
});

test('AsyncJob - submitBatch with delaySeconds defers all handlers', async () => {
	const received: number[] = [];

	const job = new AsyncJob(null as any, 'test', {
		handler: async (payload: { n: number }) => { received.push(payload.n); },
	});

	await job.submitBatch([{ n: 1 }, { n: 2 }], { delaySeconds: 1 });

	// Handlers should NOT have run yet
	await waitForJobs(100);
	assert.strictEqual(received.length, 0, 'handlers should not run before delay');

	// Wait for delay to expire
	await sleep(1200);
	await waitForJobs(100);
	assert.strictEqual(received.length, 2, 'both handlers should run after delay');
});

test('AsyncJob - delayed job appears in _queue.delayed before processing', async () => {
	const job = new AsyncJob(null as any, 'test', {
		handler: async () => {},
	});

	await job.submit({ x: 1 }, { delaySeconds: 2 });

	assert.strictEqual(job._queue.delayed.length, 1, 'job should be in delayed queue');
	assert.ok(job._queue.delayed[0].delayedUntil, 'delayedUntil should be set');
});

// ---------------------------------------------------------------------------
// Phase 2: Console log format for delayed jobs
// ---------------------------------------------------------------------------

test('AsyncJob - delayed job logs correct format', async () => {
	const logs: string[] = [];
	const originalLog = console.log;
	console.log = (...args: any[]) => { logs.push(args.join(' ')); };

	try {
		const job = new AsyncJob(null as any, 'delay-fmt', {
			handler: async () => {},
		});

		await job.submit({ x: 1 }, { delaySeconds: 60 });

		const submitLog = logs.find(l => l.includes('[AsyncJob:delay-fmt]') && l.includes('submitted'));
		assert.ok(submitLog, 'should have a submit log');
		assert.ok(submitLog!.includes('(delayed 60s)'), `log should contain "(delayed 60s)", got: ${submitLog}`);
	} finally {
		console.log = originalLog;
	}
});

test('AsyncJob - non-delayed job log does NOT contain delay suffix', async () => {
	const logs: string[] = [];
	const originalLog = console.log;
	console.log = (...args: any[]) => { logs.push(args.join(' ')); };

	try {
		const job = new AsyncJob(null as any, 'nodelay-fmt', {
			handler: async () => {},
		});

		await job.submit({ x: 1 });

		const submitLog = logs.find(l => l.includes('[AsyncJob:nodelay-fmt]') && l.includes('submitted'));
		assert.ok(submitLog, 'should have a submit log');
		assert.ok(!submitLog!.includes('delayed'), `non-delayed log should not mention delay, got: ${submitLog}`);
	} finally {
		console.log = originalLog;
	}
});
