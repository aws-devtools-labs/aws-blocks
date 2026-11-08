// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * On AWS, core's Lambda handler runs each invocation with its awsRequestId in
 * the `__BLOCKS_REQUEST_ID_STORE__` store (see core's request-context.ts), and
 * every log line carries it as `awsRequestId`.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { AsyncLocalStorage } from 'node:async_hooks';
import { buildEntry, safeStringify } from './serializer.js';

// The serializer reads the id through `currentRequestId()` from core's bb-utils,
// which registers core's own store here on load. Use that real store, not a stand-in.
const globals = globalThis as { __BLOCKS_REQUEST_ID_STORE__?: AsyncLocalStorage<string | undefined> };
const registered = globals.__BLOCKS_REQUEST_ID_STORE__;
assert.ok(registered instanceof AsyncLocalStorage, "core's request-id store is registered once the serializer loads");
const store: AsyncLocalStorage<string | undefined> = registered;

const parse = (line: string) => JSON.parse(line) as Record<string, unknown>;

test('a line logged inside an invocation carries its request id', () => {
	const entry = store.run('req-123', () => parse(buildEntry('info', 'hello', 'app', [])));
	assert.strictEqual(entry.awsRequestId, 'req-123');
	assert.strictEqual('requestId' in entry, false, 'the app-owned requestId key is left alone');
});

test('a line logged outside an invocation has no request id', () => {
	assert.strictEqual('awsRequestId' in parse(buildEntry('info', 'hello', 'app', [])), false);
});

test("an app's own requestId in context is kept and doesn't replace the invocation id", () => {
	const entry = store.run('req-123', () => parse(buildEntry('info', 'hello', 'app', [{ requestId: 'mine' }])));
	assert.strictEqual(entry.awsRequestId, 'req-123');
	assert.strictEqual(entry.requestId, 'mine');
});

test('awsRequestId is reserved: a context value under that key is ignored', () => {
	const inside = store.run('req-123', () => parse(buildEntry('info', 'm', 'app', [{ awsRequestId: 'spoofed' }])));
	assert.strictEqual(inside.awsRequestId, 'req-123');
	const outside = parse(buildEntry('info', 'm', 'app', [{ awsRequestId: 'spoofed' }]));
	assert.strictEqual('awsRequestId' in outside, false);
});

test('overlapping invocations each log their own id', async () => {
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const logAfter = (id: string, ms: number) =>
		store.run(id, async () => {
			await sleep(ms);
			return parse(buildEntry('info', id, 'app', [])).awsRequestId;
		});
	const [a, b] = await Promise.all([logAfter('req-a', 30), logAfter('req-b', 5)]);
	assert.deepStrictEqual([a, b], ['req-a', 'req-b']);
});

test('the structural fields keep their order, with awsRequestId after logger', () => {
	const entry = store.run('req-1', () => parse(buildEntry('warn', 'm', 'app', [{ k: 1 }])));
	assert.deepStrictEqual(Object.keys(entry).slice(0, 5), ['level', 'message', 'timestamp', 'logger', 'awsRequestId']);
});

test('the degraded line written on a serialization failure keeps the correlation ids', () => {
	const unserializable = {
		toJSON() {
			throw new Error('boom');
		},
	};
	const line = parse(
		safeStringify({
			level: 'error',
			message: 'm',
			timestamp: 't',
			logger: 'app',
			awsRequestId: 'req-9',
			requestId: 'app-1',
			traceId: '1-abc',
			bad: unserializable,
		}),
	);
	assert.strictEqual(line._serializationError, 'SerializationFailedException');
	assert.strictEqual(line.awsRequestId, 'req-9');
	assert.strictEqual(line.requestId, 'app-1');
	assert.strictEqual(line.traceId, '1-abc');
});

test('the degraded line drops a non-string id rather than failing again', () => {
	const unserializable = {
		toJSON() {
			throw new Error('boom');
		},
	};
	const line = parse(
		safeStringify({
			level: 'error',
			message: 'm',
			timestamp: 't',
			logger: 'app',
			awsRequestId: 1n,
			requestId: 2n,
			bad: unserializable,
		}),
	);
	assert.strictEqual('awsRequestId' in line, false);
	assert.strictEqual('requestId' in line, false);
});
