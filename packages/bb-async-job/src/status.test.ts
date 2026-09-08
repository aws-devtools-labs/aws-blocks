// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { AsyncJob, AsyncJobErrors } from './index.mock.js';
import { statusSchema, statusTableOptions, STATUS_TABLE_ID, JobStatusTracker } from './status.js';

// Every handler in this file settles immediately. The transition history is what
// makes intermediate states observable, so none of these tests pad the handler
// with a delay to widen the `processing` window.

function cleanMockData(): void {
	try {
		rmSync('.bb-data', { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

before(cleanMockData);
after(cleanMockData);

const FAST_POLL = { pollIntervalMs: 5, timeoutMs: 5_000 };

test('AsyncJob - records queued -> processing -> complete for an instant handler', async () => {
	let ran = false;
	const job = new AsyncJob<{ n: number }>(null as any, 'status-happy', {
		trackStatus: true,
		handler: async () => {
			ran = true;
		},
	});

	const { jobId } = await job.submit({ n: 1 });
	const status = await job.waitUntilComplete(jobId, FAST_POLL);

	assert.strictEqual(ran, true, 'handler should have run');
	assert.strictEqual(status.state, 'complete');
	assert.deepStrictEqual(
		status.transitions.map(t => t.state),
		['queued', 'processing', 'complete'],
		'every intermediate state must be recorded even though the handler returned immediately',
	);
	assert.deepStrictEqual(status.transitions.map(t => t.attempt), [0, 1, 1]);
	assert.strictEqual(status.attempts, 1);
	assert.strictEqual(status.jobId, jobId);
	assert.strictEqual(status.error, undefined);
});

test('AsyncJob - transitions stay readable long after the job settled', async () => {
	const job = new AsyncJob<{ n: number }>(null as any, 'status-after', {
		trackStatus: true,
		handler: async () => {},
	});

	const { jobId } = await job.submit({ n: 1 });
	await job.waitUntilComplete(jobId, FAST_POLL);

	// A single read, made only once the job is already done — this is the case that
	// used to require setTimeout(1500) in the handler.
	const status = await job.getStatus(jobId);
	assert.deepStrictEqual(
		status?.transitions.map(t => t.state),
		['queued', 'processing', 'complete'],
	);
});

test('AsyncJob - transitions are ordered and timestamped', async () => {
	const job = new AsyncJob<{ n: number }>(null as any, 'status-times', {
		trackStatus: true,
		handler: async () => {},
	});

	const { jobId } = await job.submit({ n: 1 });
	const status = await job.waitUntilComplete(jobId, FAST_POLL);

	const times = status.transitions.map(t => Date.parse(t.at));
	assert.ok(times.every(t => Number.isFinite(t)), 'every transition needs a parseable timestamp');
	for (let i = 1; i < times.length; i++) {
		assert.ok(times[i] >= times[i - 1], `transition ${i} must not predate transition ${i - 1}`);
	}
	assert.strictEqual(status.submittedAt, status.transitions[0].at);
	assert.strictEqual(status.updatedAt, status.transitions.at(-1)!.at);
});

test('AsyncJob - retries record processing twice then failed', async () => {
	let attempts = 0;
	const job = new AsyncJob<{ n: number }>(null as any, 'status-retry', {
		trackStatus: true,
		maxRetries: 2,
		handler: async () => {
			attempts++;
			throw new Error('handler blew up');
		},
	});

	const { jobId } = await job.submit({ n: 1 });
	const status = await job.waitUntilComplete(jobId, FAST_POLL);

	assert.strictEqual(attempts, 2, 'handler should run once per retry');
	assert.strictEqual(status.state, 'failed');
	assert.deepStrictEqual(
		status.transitions.map(t => t.state),
		['queued', 'processing', 'processing', 'failed'],
	);
	assert.deepStrictEqual(status.transitions.map(t => t.attempt), [0, 1, 2, 2]);
	assert.strictEqual(status.attempts, 2);
	assert.match(status.error ?? '', /handler blew up/);
});

test('AsyncJob - queued is observable before the handler runs', async () => {
	const job = new AsyncJob<{ n: number }>(null as any, 'status-delayed', {
		trackStatus: true,
		handler: async () => {},
	});

	// A delayed job stays queued, so the pre-processing state can be read directly
	// rather than inferred.
	const { jobId } = await job.submit({ n: 1 }, { delaySeconds: 30 });
	const status = await job.getStatus(jobId);

	assert.strictEqual(status?.state, 'queued');
	assert.deepStrictEqual(status?.transitions.map(t => t.state), ['queued']);
	assert.strictEqual(status?.attempts, 0);
});

test('AsyncJob - submitBatch records status for every job', async () => {
	const seen: number[] = [];
	const job = new AsyncJob<{ n: number }>(null as any, 'status-batch', {
		trackStatus: true,
		handler: async (payload) => {
			seen.push(payload.n);
		},
	});

	const { jobIds } = await job.submitBatch([{ n: 1 }, { n: 2 }, { n: 3 }]);
	const statuses = await Promise.all(
		jobIds.map(id => job.waitUntilComplete(id!, FAST_POLL)),
	);

	assert.strictEqual(seen.length, 3);
	for (const status of statuses) {
		assert.strictEqual(status.state, 'complete');
		assert.deepStrictEqual(
			status.transitions.map(t => t.state),
			['queued', 'processing', 'complete'],
		);
	}
});

test('AsyncJob - getStatus returns null for an unknown job id', async () => {
	const job = new AsyncJob(null as any, 'status-unknown', {
		trackStatus: true,
		handler: async () => {},
	});

	assert.strictEqual(await job.getStatus('no-such-job'), null);
});

test('AsyncJob - waitUntilComplete throws Timeout while a job is still processing', async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});

	const job = new AsyncJob<{ n: number }>(null as any, 'status-timeout', {
		trackStatus: true,
		handler: async () => {
			await gate;
		},
	});

	const { jobId } = await job.submit({ n: 1 });

	await assert.rejects(
		() => job.waitUntilComplete(jobId, { timeoutMs: 40, pollIntervalMs: 5 }),
		(err: Error) => {
			assert.strictEqual(err.name, AsyncJobErrors.Timeout);
			assert.match(err.message, /last observed state: processing/);
			return true;
		},
	);

	// The job was mid-flight, not lost: let it finish and the wait now succeeds.
	release!();
	const status = await job.waitUntilComplete(jobId, FAST_POLL);
	assert.strictEqual(status.state, 'complete');
});

test('AsyncJob - waitUntilComplete rejects with the abort reason', async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});

	const job = new AsyncJob<{ n: number }>(null as any, 'status-abort', {
		trackStatus: true,
		handler: async () => {
			await gate;
		},
	});

	const { jobId } = await job.submit({ n: 1 });

	const controller = new AbortController();
	const reason = new Error('caller gave up');
	const waiting = job.waitUntilComplete(jobId, {
		timeoutMs: 5_000,
		pollIntervalMs: 5,
		signal: controller.signal,
	});
	controller.abort(reason);

	await assert.rejects(() => waiting, (err: Error) => {
		assert.strictEqual(err, reason);
		return true;
	});

	release!();
	await job.waitUntilComplete(jobId, FAST_POLL);
});

test('AsyncJob - waitUntilComplete honours a signal that is already aborted', async () => {
	const job = new AsyncJob(null as any, 'status-preaborted', {
		trackStatus: true,
		handler: async () => {},
	});

	const controller = new AbortController();
	const reason = new Error('never mind');
	controller.abort(reason);

	await assert.rejects(
		() => job.waitUntilComplete('any-job', { signal: controller.signal }),
		(err: Error) => {
			assert.strictEqual(err, reason);
			return true;
		},
	);
});

test('AsyncJob - status methods throw StatusNotTracked when trackStatus is off', async () => {
	const job = new AsyncJob<{ n: number }>(null as any, 'status-off', {
		handler: async () => {},
	});

	const { jobId } = await job.submit({ n: 1 });

	await assert.rejects(() => job.getStatus(jobId), (err: Error) => {
		assert.strictEqual(err.name, AsyncJobErrors.StatusNotTracked);
		assert.match(err.message, /trackStatus: true/);
		return true;
	});

	await assert.rejects(() => job.waitUntilComplete(jobId), (err: Error) => {
		assert.strictEqual(err.name, AsyncJobErrors.StatusNotTracked);
		return true;
	});
});

test('AsyncJob - tracked and untracked jobs keep their own status records', async () => {
	const tracked = new AsyncJob<{ n: number }>(null as any, 'status-isolated-a', {
		trackStatus: true,
		handler: async () => {},
	});
	const other = new AsyncJob<{ n: number }>(null as any, 'status-isolated-b', {
		trackStatus: true,
		handler: async () => {},
	});

	const { jobId } = await tracked.submit({ n: 1 });
	await tracked.waitUntilComplete(jobId, FAST_POLL);

	assert.strictEqual(await other.getStatus(jobId), null, 'status must not leak across jobs');
});

// The CDK layer infers a key's DynamoDB attribute type by probing the schema with
// a numeric value and reading "no issue for that field" as numeric. If this schema
// ever stops rejecting a numeric jobId, the status table would be provisioned with
// an `N` partition key and every runtime write would fail against it.
test('AsyncJob - status schema rejects a numeric jobId so CDK provisions a string key', () => {
	const result = statusSchema['~standard'].validate({ jobId: 0 }) as {
		issues?: ReadonlyArray<{ path?: readonly unknown[] }>;
	};

	assert.ok(result.issues, 'a numeric jobId must produce issues');
	assert.ok(
		result.issues.some(i => i.path?.length === 1 && i.path[0] === 'jobId'),
		'the issue must be attributed to the jobId field',
	);
});

test('AsyncJob - status schema accepts a well-formed record', () => {
	const result = statusSchema['~standard'].validate({
		jobId: 'job-1',
		state: 'complete',
		transitions: [{ state: 'queued', at: new Date().toISOString(), attempt: 0 }],
		attempts: 1,
		submittedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		expiresAt: 1_800_000_000,
	}) as { issues?: unknown };

	assert.strictEqual(result.issues, undefined);
});

test('AsyncJob - status table is keyed by jobId with a TTL attribute', () => {
	assert.strictEqual(STATUS_TABLE_ID, 'status');
	assert.deepStrictEqual(statusTableOptions.key, { partitionKey: 'jobId' });
	assert.strictEqual(statusTableOptions.ttl, 'expiresAt');
});

// ── Concurrency ───────────────────────────────────────────────────────
// Appending a transition is a read-modify-write. SQS is at-least-once, so two
// deliveries of the same message can overlap, and in AWS the `queued` write can
// only happen after SendMessage returns, so it can land after the handler has
// already created the record. Both cases are exercised directly against the
// tracker rather than through submit(), since the mock queue cannot reproduce a
// duplicate delivery on its own.

test('JobStatusTracker - concurrent appends do not lose a transition', async () => {
	const tracker = new JobStatusTracker({ id: 'cas-parallel' } as any);
	await tracker.recordQueued('job-cas', new Date().toISOString());

	await Promise.all([
		tracker.recordTransition('job-cas', 'processing', 1),
		tracker.recordTransition('job-cas', 'processing', 2),
		tracker.recordTransition('job-cas', 'complete', 2),
	]);

	const status = await tracker.get('job-cas');
	assert.strictEqual(
		status?.transitions.length,
		4,
		`expected queued + 3 appended transitions, got ${JSON.stringify(status?.transitions)}`,
	);
	assert.strictEqual(status.transitions[0].state, 'queued');
	assert.strictEqual(
		status.transitions.filter(t => t.state === 'complete').length,
		1,
		'the terminal transition must survive a concurrent append',
	);
});

test('JobStatusTracker - a late queued write does not clobber an earlier transition', async () => {
	const tracker = new JobStatusTracker({ id: 'cas-late-queued' } as any);

	// The handler wins the race: it creates the record by backfilling `queued`.
	await tracker.recordTransition('job-late', 'processing', 1);
	// submit()'s write arrives afterwards and must not reset the record.
	await tracker.recordQueued('job-late', new Date().toISOString());

	const status = await tracker.get('job-late');
	assert.strictEqual(status?.state, 'processing', 'state must not fall back to queued');
	assert.deepStrictEqual(status?.transitions.map(t => t.state), ['queued', 'processing']);
});

test('JobStatusTracker - a late queued write corrects the backfilled submission time', async () => {
	const tracker = new JobStatusTracker({ id: 'cas-backdate' } as any);

	// The job really was submitted a full minute before the handler observed it.
	// The handler cannot know that, so its backfill dates the submission from its
	// own clock.
	const submittedAt = new Date(Date.now() - 60_000).toISOString();

	await tracker.recordTransition('job-backdate', 'processing', 1);

	const backfilled = await tracker.get('job-backdate');
	assert.ok(
		Date.parse(backfilled!.submittedAt) > Date.parse(submittedAt),
		'precondition: the backfill must have stamped a later submittedAt',
	);

	// submit()'s write loses the create race, so it corrects the record instead of
	// silently dropping the only accurate submission time anybody holds.
	await tracker.recordQueued('job-backdate', submittedAt);

	const status = await tracker.get('job-backdate');
	assert.strictEqual(
		status?.submittedAt,
		submittedAt,
		'submittedAt must be the real submission time, not the time the handler first saw the job',
	);
	assert.strictEqual(
		status.transitions[0].at,
		submittedAt,
		'the queued transition and submittedAt are the same instant and must agree',
	);

	// The correction must not cost anything else on the record.
	assert.strictEqual(status.state, 'processing', 'state must not fall back to queued');
	assert.deepStrictEqual(status.transitions.map(t => t.state), ['queued', 'processing']);
	assert.strictEqual(status.attempts, 1);
	assert.strictEqual(
		status.transitions[1].at,
		backfilled!.transitions[1].at,
		'the processing transition must keep its own timestamp',
	);
	assert.strictEqual(status.updatedAt, backfilled!.updatedAt, 'updatedAt tracks transitions, not submission');
});

test('JobStatusTracker - queued only ever moves the submission time earlier', async () => {
	const tracker = new JobStatusTracker({ id: 'cas-monotonic' } as any);

	// submit() wins the race here, so the record already holds the true time.
	const submittedAt = new Date(Date.now() - 60_000).toISOString();
	await tracker.recordQueued('job-monotonic', submittedAt);

	// A later write for the same id must not drag the submission forward: nothing
	// is submitted twice, so a later timestamp is never the better one.
	await tracker.recordQueued('job-monotonic', new Date().toISOString());

	const status = await tracker.get('job-monotonic');
	assert.strictEqual(status?.submittedAt, submittedAt);
	assert.strictEqual(status.transitions[0].at, submittedAt);
	assert.deepStrictEqual(status.transitions.map(t => t.state), ['queued']);
});

test('JobStatusTracker - correcting the submission time does not drop a concurrent transition', async () => {
	const tracker = new JobStatusTracker({ id: 'cas-backdate-parallel' } as any);

	const submittedAt = new Date(Date.now() - 60_000).toISOString();
	await tracker.recordTransition('job-both', 'processing', 1);

	// The correction is a read-modify-write, so it races the handler's terminal
	// append exactly as two appends race each other. Neither may be lost.
	await Promise.all([
		tracker.recordQueued('job-both', submittedAt),
		tracker.recordTransition('job-both', 'complete', 1),
	]);

	const status = await tracker.get('job-both');
	assert.strictEqual(status?.state, 'complete', 'the terminal transition must survive the correction');
	assert.deepStrictEqual(status.transitions.map(t => t.state), ['queued', 'processing', 'complete']);
	assert.strictEqual(
		status.submittedAt,
		submittedAt,
		'the correction must survive a concurrent append',
	);
	assert.strictEqual(status.transitions[0].at, submittedAt);
});

test('JobStatusTracker - correcting a record that is gone does not recreate it', async () => {
	const tracker = new JobStatusTracker({ id: 'cas-reaped' } as any);

	// The TTL can reap a job's history in the window between submit()'s failed
	// create and the correction's read. Writing the correction blind would put the
	// record back and report a job as freshly queued long after its history was
	// deliberately dropped, so a missing record has to stay missing.
	await (tracker as any).backdateSubmission('job-reaped', new Date().toISOString());

	assert.strictEqual(await tracker.get('job-reaped'), null);
});

test('JobStatusTracker - get does not leak storage bookkeeping', async () => {
	const tracker = new JobStatusTracker({ id: 'cas-clean' } as any);
	await tracker.recordQueued('job-clean', new Date().toISOString());
	await tracker.recordTransition('job-clean', 'complete', 1);

	const status = await tracker.get('job-clean');
	assert.ok(status);
	assert.deepStrictEqual(
		Object.keys(status).sort(),
		['attempts', 'jobId', 'state', 'submittedAt', 'transitions', 'updatedAt'],
		'expiresAt and version are storage details and must not surface',
	);
});
