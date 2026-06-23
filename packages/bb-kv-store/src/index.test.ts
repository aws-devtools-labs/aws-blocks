// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, beforeEach, describe } from 'node:test';
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { isBlocksError, Scope } from '@aws-blocks/core';
import { KVStore, KVStoreErrors } from './index.mock.js';

// Clean mock data between tests to avoid cross-contamination
beforeEach(() => {
	try { rmSync('.bb-data', { recursive: true, force: true }); } catch {}
});

// ── Basic CRUD ──────────────────────────────────────────────────────────────

test('put and get', async () => {
	const store = new KVStore({ id: 'root' } as any, 'test');
	await store.put('key1', 'value1');
	assert.strictEqual(await store.get('key1'), 'value1');
});

test('get non-existent key returns null', async () => {
	const store = new KVStore({ id: 'root' } as any, 'test');
	assert.strictEqual(await store.get('nonexistent'), null);
});

test('delete removes key', async () => {
	const store = new KVStore({ id: 'root' } as any, 'test');
	await store.put('key1', 'value1');
	await store.delete('key1');
	assert.strictEqual(await store.get('key1'), null);
});

// ── Conditional writes ──────────────────────────────────────────────────────

test('put with ifNotExists succeeds when key absent', async () => {
	const store = new KVStore({ id: 'root' } as any, 'test');
	await store.put('key1', 'value1', { ifNotExists: true });
	assert.strictEqual(await store.get('key1'), 'value1');
});

test('put with ifNotExists throws when key exists', async () => {
	const store = new KVStore({ id: 'root' } as any, 'test');
	await store.put('key1', 'value1');
	await assert.rejects(
		() => store.put('key1', 'value2', { ifNotExists: true }),
		(err: Error) => err.name === KVStoreErrors.ConditionalCheckFailed,
	);
});

test('put with ifValueEquals succeeds when value matches', async () => {
	const store = new KVStore({ id: 'root' } as any, 'test');
	await store.put('key1', 'v1');
	await store.put('key1', 'v2', { ifValueEquals: 'v1' });
	assert.strictEqual(await store.get('key1'), 'v2');
});

test('put with ifValueEquals throws when value differs', async () => {
	const store = new KVStore({ id: 'root' } as any, 'test');
	await store.put('key1', 'v1');
	await assert.rejects(
		() => store.put('key1', 'v2', { ifValueEquals: 'wrong' }),
		(err: Error) => err.name === KVStoreErrors.ConditionalCheckFailed,
	);
});

// ── Conditional deletes ─────────────────────────────────────────────────────

test('delete with ifExists succeeds when key exists', async () => {
	const store = new KVStore({ id: 'root' } as any, 'test');
	await store.put('key1', 'value1');
	await store.delete('key1', { ifExists: true });
	assert.strictEqual(await store.get('key1'), null);
});

test('delete with ifExists throws when key absent', async () => {
	const store = new KVStore({ id: 'root' } as any, 'test');
	await assert.rejects(
		() => store.delete('key1', { ifExists: true }),
		(err: Error) => err.name === KVStoreErrors.ConditionalCheckFailed,
	);
});

test('delete with ifValueEquals succeeds when value matches', async () => {
	const store = new KVStore({ id: 'root' } as any, 'test');
	await store.put('key1', 'v1');
	await store.delete('key1', { ifValueEquals: 'v1' });
	assert.strictEqual(await store.get('key1'), null);
});

test('delete with ifValueEquals throws when value differs', async () => {
	const store = new KVStore({ id: 'root' } as any, 'test');
	await store.put('key1', 'v1');
	await assert.rejects(
		() => store.delete('key1', { ifValueEquals: 'wrong' }),
		(err: Error) => err.name === KVStoreErrors.ConditionalCheckFailed,
	);
});

// ── Generic T (JSON serialization) ──────────────────────────────────────────

test('typed store serializes and deserializes objects', async () => {
	interface Session { userId: string; expiresAt: number }
	const store = new KVStore<Session>({ id: 'root' } as any, 'typed');
	const session = { userId: 'alice', expiresAt: 1234567890 };
	await store.put('s1', session);
	assert.deepStrictEqual(await store.get('s1'), session);
});

// ── scan() ──────────────────────────────────────────────────────────────────

test('scan yields all entries', async () => {
	const store = new KVStore({ id: 'root' } as any, 'scantest');
	await store.put('a', 'one');
	await store.put('b', 'two');
	const entries: { key: string; value: string }[] = [];
	for await (const entry of store.scan()) entries.push(entry);
	assert.strictEqual(entries.length, 2);
	const keys = entries.map(e => e.key).sort();
	assert.deepStrictEqual(keys, ['a', 'b']);
});

test('scan on empty store yields nothing', async () => {
	const store = new KVStore({ id: 'root' } as any, 'empty');
	const entries: unknown[] = [];
	for await (const entry of store.scan()) entries.push(entry);
	assert.strictEqual(entries.length, 0);
});

// ── Disk persistence ────────────────────────────────────────────────────────

test('data persists across instances', async () => {
	const store1 = new KVStore({ id: 'root' } as any, 'persist');
	await store1.put('key', 'saved');

	// New instance with same scope path reads from disk
	const store2 = new KVStore({ id: 'root' } as any, 'persist');
	assert.strictEqual(await store2.get('key'), 'saved');
});

// ── 400 KB validation ───────────────────────────────────────────────────────

test('put rejects items exceeding 400 KB', async () => {
	const store = new KVStore({ id: 'root' } as any, 'big');
	const bigValue = 'x'.repeat(401 * 1024);
	await assert.rejects(
		() => store.put('key', bigValue),
		/size has exceeded/,
	);
});

test('400 KB rejection is matchable via KVStoreErrors.ItemTooLarge', async () => {
	const store = new KVStore({ id: 'root' } as any, 'big2');
	const bigValue = 'x'.repeat(401 * 1024);
	await assert.rejects(
		() => store.put('key', bigValue),
		(e: unknown) => {
			assert.ok(isBlocksError(e, KVStoreErrors.ItemTooLarge));
			return true;
		},
	);
});

test('ItemTooLarge error name is distinct from generic ValidationException', async () => {
	const store = new KVStore({ id: 'root' } as any, 'big3');
	const bigValue = 'x'.repeat(401 * 1024);
	await assert.rejects(
		() => store.put('key', bigValue),
		(e: unknown) => {
			assert.ok(e instanceof Error);
			assert.strictEqual(e.name, 'ItemTooLargeException');
			assert.notStrictEqual(e.name, 'ValidationException',
				'ItemTooLarge must NOT use the generic ValidationException name');
			return true;
		},
	);
});

test('ItemTooLarge error message matches DynamoDB size-exceeded pattern', async () => {
	const store = new KVStore({ id: 'root' } as any, 'big4');
	const bigValue = 'x'.repeat(401 * 1024);
	await assert.rejects(
		() => store.put('key', bigValue),
		(e: unknown) => {
			assert.ok(e instanceof Error);
			assert.match(e.message, /size has exceeded/i,
				'Error message must contain "size has exceeded" to match DynamoDB pattern');
			return true;
		},
	);
});

// ── fromExisting ────────────────────────────────────────────────────────────

test('fromExisting returns ExternalTableRef', () => {
	const ref = KVStore.fromExisting('my-table');
	assert.strictEqual(ref.tableName, 'my-table');
});

// ── Error constants ─────────────────────────────────────────────────────────

test('KVStoreErrors has ConditionalCheckFailed', () => {
	assert.strictEqual(KVStoreErrors.ConditionalCheckFailed, 'ConditionalCheckFailedException');
});

test('KVStoreErrors.ItemTooLarge is a distinct name, not generic ValidationException', () => {
	assert.strictEqual(KVStoreErrors.ItemTooLarge, 'ItemTooLargeException');
	assert.notStrictEqual(KVStoreErrors.ItemTooLarge, 'ValidationException');
});

// ── fullId ──────────────────────────────────────────────────────────────────

test('fullId generation with parent', () => {
	const store = new KVStore({ id: 'parent' } as any, 'child');
	assert.strictEqual(store.fullId, 'parent-child');
});

// ── toAgentTools() ──────────────────────────────────────────────────────────

describe('toAgentTools()', () => {
	test('exposes get, put, delete, scan', () => {
		const scope = new Scope('app');
		const store = new KVStore(scope, 'memory');
		const tools = store.toAgentTools();
		assert.deepStrictEqual(Object.keys(tools).sort(), ['memory__delete', 'memory__get', 'memory__put', 'memory__scan']);
	});

	test('get handler reads from the store', async () => {
		const scope = new Scope('app');
		const store = new KVStore(scope, 'memory');
		await store.put('k', 'v');
		const tools = store.toAgentTools();
		const result = await tools['memory__get'].handler({ input: { key: 'k' }, context: {} });
		assert.strictEqual(result, 'v');
	});

	test('put handler writes to the store', async () => {
		const scope = new Scope('app');
		const store = new KVStore(scope, 'memory');
		const tools = store.toAgentTools();
		await tools['memory__put'].handler({ input: { key: 'k', value: 'v' }, context: {} });
		assert.strictEqual(await store.get('k'), 'v');
	});

	test('scan handler collects all entries', async () => {
		const scope = new Scope('app');
		const store = new KVStore(scope, 'memory');
		await store.put('a', '1');
		await store.put('b', '2');
		const tools = store.toAgentTools();
		const result = await tools['memory__scan'].handler({ input: {}, context: {} }) as any[];
		assert.strictEqual(result.length, 2);
	});

	test('scan handler respects limit', async () => {
		const scope = new Scope('app');
		const store = new KVStore(scope, 'memory');
		for (let i = 0; i < 5; i++) await store.put(`key${i}`, `val${i}`);
		const tools = store.toAgentTools();
		const result = await tools['memory__scan'].handler({ input: { limit: 2 }, context: {} }) as any[];
		assert.strictEqual(result.length, 2);
	});
});
