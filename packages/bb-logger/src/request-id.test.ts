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
import { buildEntry } from './serializer.js';

const globals = globalThis as { __BLOCKS_REQUEST_ID_STORE__?: AsyncLocalStorage<string | undefined> };
// Core registers this store when its handler loads; stand in for it here.
if (!globals.__BLOCKS_REQUEST_ID_STORE__) globals.__BLOCKS_REQUEST_ID_STORE__ = new AsyncLocalStorage();
const store: AsyncLocalStorage<string | undefined> = globals.__BLOCKS_REQUEST_ID_STORE__;

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
