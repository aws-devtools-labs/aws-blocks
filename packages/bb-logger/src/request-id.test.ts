// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * On AWS, core's Lambda handler runs each invocation with its awsRequestId in
 * the `__BLOCKS_REQUEST_ID_STORE__` store (see core's request-context.ts), and
 * every log line carries it as `requestId`.
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
	assert.strictEqual(entry.requestId, 'req-123');
});

test('a line logged outside an invocation has no request id', () => {
	assert.strictEqual('requestId' in parse(buildEntry('info', 'hello', 'app', [])), false);
});

test('a requestId the caller passes in context wins', () => {
	const entry = store.run('req-123', () => parse(buildEntry('info', 'hello', 'app', [{ requestId: 'mine' }])));
	assert.strictEqual(entry.requestId, 'mine');
});

test('overlapping invocations each log their own id', async () => {
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const logAfter = (id: string, ms: number) =>
		store.run(id, async () => {
			await sleep(ms);
			return parse(buildEntry('info', id, 'app', [])).requestId;
		});
	const [a, b] = await Promise.all([logAfter('req-a', 30), logAfter('req-b', 5)]);
	assert.deepStrictEqual([a, b], ['req-a', 'req-b']);
});

test('the structural fields keep their order, with requestId after logger', () => {
	const entry = store.run('req-1', () => parse(buildEntry('warn', 'm', 'app', [{ k: 1 }])));
	assert.deepStrictEqual(Object.keys(entry).slice(0, 5), ['level', 'message', 'timestamp', 'logger', 'requestId']);
});

test('the degraded line written on a serialization failure keeps requestId and traceId', () => {
	const unserializable = { toJSON() { throw new Error('boom'); } };
	const line = parse(
		safeStringify({ level: 'error', message: 'm', timestamp: 't', logger: 'app', requestId: 'req-9', traceId: '1-abc', bad: unserializable }),
	);
	assert.strictEqual(line._serializationError, 'SerializationFailedException');
	assert.strictEqual(line.requestId, 'req-9');
	assert.strictEqual(line.traceId, '1-abc');
});

test('the degraded line drops a non-string requestId rather than failing again', () => {
	const unserializable = { toJSON() { throw new Error('boom'); } };
	const line = parse(safeStringify({ level: 'error', message: 'm', timestamp: 't', logger: 'app', requestId: 1n, bad: unserializable }));
	assert.strictEqual('requestId' in line, false);
});
