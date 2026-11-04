// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { rmSync, existsSync, readdirSync } from 'node:fs';
import { Scope } from '@aws-blocks/core';
import { FileBucket } from './index.mock.js';
import type { ObjectCreatedContext, ObjectCreatedEvent } from './index.mock.js';
import { toObjectCreatedEvents } from './object-created.js';

const scope = new Scope('ooc');

beforeEach(() => {
	const dir = '.bb-data';
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir)) {
		if (entry.startsWith('ooc-')) rmSync(`${dir}/${entry}`, { recursive: true, force: true });
	}
});

/** Records every handler call, and resolves once `count` calls have happened. */
function recorder(): {
	calls: Array<{ event: ObjectCreatedEvent; context: ObjectCreatedContext }>;
	handler: (event: ObjectCreatedEvent, context: ObjectCreatedContext) => Promise<void>;
	waitFor: (count: number) => Promise<void>;
} {
	const calls: Array<{ event: ObjectCreatedEvent; context: ObjectCreatedContext }> = [];
	return {
		calls,
		handler: async (event, context) => {
			calls.push({ event, context });
		},
		waitFor: async (count) => {
			const deadline = Date.now() + 2000;
			while (calls.length < count && Date.now() < deadline) await sleep(5);
			assert.strictEqual(calls.length, count, `expected ${count} handler call(s)`);
		},
	};
}

// ── Mock delivery ───────────────────────────────────────────────────────────

test('runs the handler after put() with the path, size and created versionId', async () => {
	const r = recorder();
	const bucket = new FileBucket(scope, 'versioned', { onObjectCreated: { handler: r.handler } });

	await bucket.put('docs/a.txt', 'first');
	// put() only enqueues: the handler runs after the write, as with S3 notifications.
	assert.strictEqual(r.calls.length, 0);
	await bucket.put('docs/a.txt', 'second!');
	await r.waitFor(2);

	const [first, second] = r.calls.map((c) => c.event);
	assert.deepStrictEqual(first, { path: 'docs/a.txt', size: 5, versionId: first.versionId });
	assert.strictEqual(second.size, 7);
	assert.notStrictEqual(first.versionId, second.versionId);
	// Each event names the version it was created for, even after a newer write.
	assert.strictEqual((await bucket.get(first.path, { versionId: first.versionId }))?.body.toString(), 'first');
	assert.strictEqual(r.calls[0].context.receiveCount, 1);
});

test('restoreVersion() creates an object, so it notifies too', async () => {
	const r = recorder();
	const bucket = new FileBucket(scope, 'restore', { onObjectCreated: { handler: r.handler } });
	await bucket.put('r.txt', 'v1');
	await bucket.put('r.txt', 'v2');
	await r.waitFor(2);
	await bucket.restoreVersion('r.txt', r.calls[0].event.versionId ?? '');
	await r.waitFor(3);
	assert.strictEqual(r.calls[2].event.path, 'r.txt');
	assert.strictEqual((await bucket.get('r.txt'))?.body.toString(), 'v1');
});

test('an unversioned bucket sends no versionId', async () => {
	const r = recorder();
	const bucket = new FileBucket(scope, 'plain', { versioned: false, onObjectCreated: { handler: r.handler } });
	await bucket.put('p.txt', 'x');
	await r.waitFor(1);
	assert.deepStrictEqual(r.calls[0].event, { path: 'p.txt', size: 1 });
});

test('prefix and suffix must both match', async () => {
	const r = recorder();
	const bucket = new FileBucket(scope, 'filtered', {
		onObjectCreated: { prefix: 'incoming/', suffix: '.csv', handler: r.handler },
	});
	await bucket.put('incoming/skip.txt', 'x');
	await bucket.put('other/skip.csv', 'x');
	await bucket.put('incoming/take.csv', 'x');
	// Jobs run in submission order and non-matching keys are never enqueued, so
	// once the matching call lands, nothing else can still arrive.
	await r.waitFor(1);
	assert.deepStrictEqual(r.calls.map((c) => c.event.path), ['incoming/take.csv']);
});

test('keys with spaces, plus signs and non-ASCII characters reach the handler unchanged', async () => {
	const r = recorder();
	const bucket = new FileBucket(scope, 'keys', { onObjectCreated: { handler: r.handler } });
	const path = 'in box/a+b %20 café.txt';
	await bucket.put(path, 'x');
	await r.waitFor(1);
	assert.strictEqual(r.calls[0].event.path, path);
	assert.ok(await bucket.get(r.calls[0].event.path));
});

test('a failing handler is retried, up to 3 attempts in total', async () => {
	const receiveCounts: number[] = [];
	const bucket = new FileBucket(scope, 'retry', {
		onObjectCreated: {
			handler: async (_event, context) => {
				receiveCounts.push(context.receiveCount);
				throw new Error('boom');
			},
		},
	});
	await bucket.put('f.txt', 'x');
	const deadline = Date.now() + 2000;
	while (receiveCounts.length < 3 && Date.now() < deadline) await sleep(5);
	// A 4th attempt would be scheduled on the next timer tick; give it a few to show up.
	await sleep(20);
	assert.deepStrictEqual(receiveCounts, [1, 2, 3]);
});

test('rejects onObjectCreated on a bucket wrapped with fromExisting, like synth', () => {
	assert.throws(
		() =>
			new FileBucket(scope, 'wrapped', {
				bucket: FileBucket.fromExisting('existing-bucket'),
				onObjectCreated: { handler: async () => {} },
			}),
		/onObjectCreated is not supported on a bucket wrapped with FileBucket\.fromExisting/,
	);
});

// ── S3 notification parsing (the AWS delivery path) ─────────────────────────

test('decodes S3 notification keys, keeps a versionId and drops a null one', () => {
	const events = toObjectCreatedEvents({
		Records: [
			{
				eventName: 'ObjectCreated:Put',
				s3: { object: { key: 'in+box/a%2Bb+caf%C3%A9.txt', size: 3, versionId: 'abc' } },
			},
			{
				eventName: 'ObjectCreated:CompleteMultipartUpload',
				s3: { object: { key: 'big.bin', size: 10 } },
			},
			// Unversioned buckets: S3 documents versionId as "null or not present".
			{
				eventName: 'ObjectCreated:Put',
				s3: { object: { key: 'plain.txt', size: 1, versionId: null } },
			},
		],
	});
	assert.deepStrictEqual(events, [
		{ path: 'in box/a+b café.txt', size: 3, versionId: 'abc' },
		{ path: 'big.bin', size: 10 },
		{ path: 'plain.txt', size: 1 },
	]);
});

test('ignores the s3:TestEvent message and non-create records', () => {
	// S3 sends this message to the queue when the notification is configured.
	const testEvent = JSON.parse('{"Service":"Amazon S3","Event":"s3:TestEvent","Bucket":"b"}');
	assert.deepStrictEqual(toObjectCreatedEvents(testEvent), []);
	assert.deepStrictEqual(
		toObjectCreatedEvents({ Records: [{ eventName: 'ObjectRemoved:Delete', s3: { object: { key: 'k', size: 0 } } }] }),
		[],
	);
});
