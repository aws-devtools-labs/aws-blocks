// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { readFileSync, rmSync } from 'node:fs';
import { beforeEach, describe, test } from 'node:test';
import { ApiError, isBlocksError, Scope } from '@aws-blocks/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { KVStore, KVStoreErrors } from './index.mock.js';
import { probeKeyType } from './item.js';

// Clean mock data between tests to avoid cross-contamination
beforeEach(() => {
	try {
		rmSync('.bb-data', { recursive: true, force: true });
	} catch {}
});

let scopeCounter = 0;
function testScope() {
	return new Scope(`kv-test-${++scopeCounter}-${Date.now()}`);
}

/** `query` and `scan` check their options when called, so a bad call throws before any promise exists. */
async function rejects(promise: Promise<unknown> | (() => unknown), name: string, message?: RegExp): Promise<unknown> {
	try {
		await (typeof promise === 'function' ? promise() : promise);
	} catch (e) {
		assert.ok(isBlocksError(e, name), `expected ${name}, got ${(e as Error).name}: ${(e as Error).message}`);
		if (message) assert.match((e as Error).message, message);
		return e;
	}
	assert.fail(`expected ${name}`);
}

const orderSchema = z.object({
	userId: z.string(),
	orderId: z.string(),
	total: z.number(),
	note: z.string().optional(),
});

// ── 1. A string key ─────────────────────────────────────────────────────────

describe('a store with no options (string key, string value)', () => {
	test('put and get', async () => {
		const store = new KVStore(testScope(), 'kv');
		await store.put('a', 'hello');
		assert.strictEqual(await store.get('a'), 'hello');
	});

	test('get of a missing key returns null', async () => {
		const store = new KVStore(testScope(), 'kv');
		assert.strictEqual(await store.get('nope'), null);
	});

	test('put overwrites, delete removes', async () => {
		const store = new KVStore(testScope(), 'kv');
		await store.put('a', 'one');
		await store.put('a', 'two');
		assert.strictEqual(await store.get('a'), 'two');
		await store.delete('a');
		assert.strictEqual(await store.get('a'), null);
	});

	test('delete of a missing key is silent', async () => {
		const store = new KVStore(testScope(), 'kv');
		await store.delete('never');
	});

	test('scan yields { key, value } entries, with expiresAt only when set', async () => {
		const store = new KVStore(testScope(), 'kv');
		await store.put('a', 'one');
		await store.put('b', 'two', { expiresAt: 1800000000 });
		const entries = await Array.fromAsync(store.scan());
		assert.deepStrictEqual(entries, [
			{ key: 'a', value: 'one' },
			{ key: 'b', value: 'two', expiresAt: 1800000000 },
		]);
	});

	test('scan sees every write that happens between two scans', async () => {
		const store = new KVStore(testScope(), 'kv');
		await store.put('b', '2');
		assert.deepStrictEqual(
			(await Array.fromAsync(store.scan())).map((e) => e.key),
			['b'],
		);
		await store.put('a', '1');
		await store.delete('b');
		await store.putBatch([{ key: 'c', value: '3' }]);
		assert.deepStrictEqual(
			(await Array.fromAsync(store.scan())).map((e) => e.key),
			['a', 'c'],
		);
		await store.deleteBatch(['a']);
		assert.deepStrictEqual(
			(await Array.fromAsync(store.scan())).map((e) => e.key),
			['c'],
		);
	});

	test('scan on an empty store yields nothing and no cursor', async () => {
		const store = new KVStore(testScope(), 'kv');
		const results = store.scan();
		assert.deepStrictEqual(await Array.fromAsync(results), []);
		assert.strictEqual(results.cursor, undefined);
	});

	test('a type argument stores numbers, arrays, objects and null as they are', async () => {
		const scope = testScope();
		const nums = new KVStore<number>(scope, 'nums');
		await nums.put('n', 42);
		assert.strictEqual(await nums.get('n'), 42);
		const lists = new KVStore<number[]>(scope, 'lists');
		await lists.put('l', [1, 2]);
		assert.deepStrictEqual(await lists.get('l'), [1, 2]);
		const objs = new KVStore<{ name: string; tags: string[] }>(scope, 'objs');
		await objs.put('o', { name: 'A', tags: ['x'] });
		assert.deepStrictEqual(await objs.get('o'), { name: 'A', tags: ['x'] });
		const nulls = new KVStore<string | null>(scope, 'nulls');
		await nulls.put('z', null);
		assert.strictEqual(await nulls.get('z'), null);
	});

	test('an empty string key is rejected with ValidationFailed', async () => {
		const store = new KVStore(testScope(), 'kv');
		await rejects(store.put('', 'x'), KVStoreErrors.ValidationFailed, /empty string/);
		await rejects(store.get(''), KVStoreErrors.ValidationFailed);
	});

	test('an object key on a string store is rejected with InvalidQuery (JavaScript caller)', async () => {
		const store = new KVStore(testScope(), 'kv') as any;
		await rejects(store.get({ id: 'a' }), KVStoreErrors.InvalidQuery, /string key/);
	});

	test('data persists across instances', async () => {
		const scope = testScope();
		await new KVStore(scope, 'kv').put('a', 'persisted');
		assert.strictEqual(await new KVStore(scope, 'kv').get('a'), 'persisted');
	});

	test('the on-disk layout is flat: _bkv_pk, _bkv_value or the fields, _bkv_ttl', async () => {
		const scope = testScope();
		const strings = new KVStore(scope, 'strings');
		await strings.put('a', 'hello', { expiresAt: 1800000000 });
		const objs = new KVStore<{ name: string }>(scope, 'objs');
		await objs.put('o', { name: 'A' });
		const stored = (fullId: string) => JSON.parse(readFileSync(`.bb-data/${fullId}/store.json`, 'utf8'));
		assert.deepStrictEqual(Object.values(stored(strings.fullId)), [
			{ _bkv_pk: 'a', _bkv_value: 'hello', _bkv_ttl: 1800000000 },
		]);
		assert.deepStrictEqual(Object.values(stored(objs.fullId)), [{ name: 'A', _bkv_pk: 'o' }]);
	});

	test('a value field with the reserved prefix is rejected', async () => {
		const store = new KVStore<Record<string, unknown>>(testScope(), 'kv');
		await rejects(store.put('a', { _bkv_pk: 'other' }), KVStoreErrors.ValidationFailed, /reserved prefix/);
		await rejects(store.put('a', { _bkv_ttl: 1 }), KVStoreErrors.ValidationFailed, /reserved prefix/);
		assert.strictEqual(await store.get('a'), null);
	});

	test('a field named __proto__ is rejected at any depth: DynamoDB cannot store that field name', async () => {
		const objects = new KVStore<Record<string, unknown>>(testScope(), 'kv');
		for (const json of [
			'{"__proto__":{"admin":true},"name":"A"}',
			'{"name":"A","nested":{"list":[{"__proto__":1}]}}',
		]) {
			await rejects(
				objects.put('a', JSON.parse(json)),
				KVStoreErrors.ValidationFailed,
				/a field named '__proto__'/,
			);
		}
		assert.strictEqual(await objects.get('a'), null);

		const lists = new KVStore<unknown[]>(testScope(), 'kv');
		await rejects(
			lists.put('a', JSON.parse('[1, {"__proto__":1}]')),
			KVStoreErrors.ValidationFailed,
			/a field named '__proto__'/,
		);
		await rejects(
			lists.putBatch([{ key: 'a', value: JSON.parse('[{"deep":{"__proto__":1}}]') }]),
			KVStoreErrors.ValidationFailed,
		);
		assert.strictEqual(await lists.get('a'), null);

		// A value with no such field is stored as before.
		await objects.put('a', { name: 'A', nested: { list: [{ proto: 1 }] } });
		assert.deepStrictEqual(await objects.get('a'), { name: 'A', nested: { list: [{ proto: 1 }] } });
	});

	test('put rejects items exceeding 400 KB with ItemTooLarge', async () => {
		const store = new KVStore(testScope(), 'kv');
		await rejects(store.put('big', 'x'.repeat(400 * 1024 + 1)), KVStoreErrors.ItemTooLarge, /400 KB/);
	});
});

// ── Conditions ──────────────────────────────────────────────────────────────

describe('conditions on a string value', () => {
	test('ifNotExists succeeds when the key is absent and fails when it exists', async () => {
		const store = new KVStore(testScope(), 'kv');
		await store.put('a', 'first', { ifNotExists: true });
		await rejects(store.put('a', 'second', { ifNotExists: true }), KVStoreErrors.ConditionalCheckFailed);
		assert.strictEqual(await store.get('a'), 'first');
	});

	test('ifValueEquals succeeds on a match and fails on a mismatch or a missing key', async () => {
		const store = new KVStore(testScope(), 'kv');
		await store.put('a', 'v1');
		await store.put('a', 'v2', { ifValueEquals: 'v1' });
		assert.strictEqual(await store.get('a'), 'v2');
		await rejects(store.put('a', 'v3', { ifValueEquals: 'wrong' }), KVStoreErrors.ConditionalCheckFailed);
		await rejects(store.put('b', 'v1', { ifValueEquals: 'anything' }), KVStoreErrors.ConditionalCheckFailed);
	});

	test('ifValueEquals: null is a real condition (null is distinct from undefined)', async () => {
		const store = new KVStore<string | null>(testScope(), 'kv');
		await store.put('a', null);
		await store.put('a', 'set', { ifValueEquals: null });
		assert.strictEqual(await store.get('a'), 'set');
		await rejects(store.put('a', 'again', { ifValueEquals: null }), KVStoreErrors.ConditionalCheckFailed);
	});

	test('ifValueEquals: undefined is a no-op', async () => {
		const store = new KVStore(testScope(), 'kv');
		await store.put('a', 'v1');
		await store.put('a', 'v2', { ifValueEquals: undefined });
		assert.strictEqual(await store.get('a'), 'v2');
		await store.delete('a', { ifValueEquals: undefined });
		assert.strictEqual(await store.get('a'), null);
	});

	test('ifNotExists OR ifValueEquals: writes a new key, updates a matching key, fails otherwise', async () => {
		const store = new KVStore(testScope(), 'kv');
		await store.put('a', 'v1', { ifNotExists: true, ifValueEquals: 'nope' });
		assert.strictEqual(await store.get('a'), 'v1');
		await store.put('a', 'v2', { ifNotExists: true, ifValueEquals: 'v1' });
		assert.strictEqual(await store.get('a'), 'v2');
		await rejects(
			store.put('a', 'v3', { ifNotExists: true, ifValueEquals: 'stale' }),
			KVStoreErrors.ConditionalCheckFailed,
		);
		assert.strictEqual(await store.get('a'), 'v2');
	});

	test('delete: ifExists, ifValueEquals, and both compose with AND', async () => {
		const store = new KVStore(testScope(), 'kv');
		await rejects(store.delete('a', { ifExists: true }), KVStoreErrors.ConditionalCheckFailed);
		await store.put('a', 'v1');
		await rejects(store.delete('a', { ifValueEquals: 'wrong' }), KVStoreErrors.ConditionalCheckFailed);
		await rejects(
			store.delete('a', { ifExists: true, ifValueEquals: 'wrong' }),
			KVStoreErrors.ConditionalCheckFailed,
		);
		await store.delete('a', { ifExists: true, ifValueEquals: 'v1' });
		assert.strictEqual(await store.get('a'), null);
	});

	test('ifValueEquals with an object is InvalidQuery (JavaScript caller)', async () => {
		const store = new KVStore<{ a: number }>(testScope(), 'kv') as any;
		await store.put('k', { a: 1 });
		await rejects(
			store.put('k', { a: 2 }, { ifValueEquals: { a: 1 } }),
			KVStoreErrors.InvalidQuery,
			/ifFieldEquals/,
		);
		await rejects(store.delete('k', { ifValueEquals: { a: 1 } }), KVStoreErrors.InvalidQuery);
	});

	test('ifFieldEquals and ifValueEquals together are InvalidQuery', async () => {
		const store = new KVStore<string | { a: number }>(testScope(), 'kv');
		await store.put('k', { a: 1 });
		await rejects(
			store.put('k', { a: 2 }, { ifFieldEquals: { a: 1 }, ifValueEquals: 'x' }),
			KVStoreErrors.InvalidQuery,
			/not both/,
		);
	});
});

describe('conditions on an object value', () => {
	interface Profile {
		name: string;
		version: number;
		meta?: { tags: string[] };
	}

	test('ifFieldEquals succeeds when every field matches and fails otherwise', async () => {
		const store = new KVStore<Profile>(testScope(), 'kv');
		await store.put('u', { name: 'A', version: 1 });
		await store.put('u', { name: 'A', version: 2 }, { ifFieldEquals: { version: 1 } });
		assert.deepStrictEqual(await store.get('u'), { name: 'A', version: 2 });
		await rejects(
			store.put('u', { name: 'B', version: 3 }, { ifFieldEquals: { version: 1 } }),
			KVStoreErrors.ConditionalCheckFailed,
		);
		await rejects(
			store.put('u', { name: 'B', version: 3 }, { ifFieldEquals: { version: 2, name: 'Z' } }),
			KVStoreErrors.ConditionalCheckFailed,
		);
		await rejects(
			store.put('x', { name: 'B', version: 1 }, { ifFieldEquals: { version: 0 } }),
			KVStoreErrors.ConditionalCheckFailed,
		);
	});

	test('ifFieldEquals compares nested values structurally, key order aside', async () => {
		const store = new KVStore<Profile>(testScope(), 'kv');
		await store.put('u', { name: 'A', version: 1, meta: { tags: ['x', 'y'] } });
		await store.put('u', { name: 'A', version: 2 }, { ifFieldEquals: { meta: { tags: ['x', 'y'] } } });
		await rejects(
			store.put('u', { name: 'A', version: 3 }, { ifFieldEquals: { meta: { tags: ['y', 'x'] } } }),
			KVStoreErrors.ConditionalCheckFailed,
		);
	});

	test('ifNotExists OR ifFieldEquals', async () => {
		const store = new KVStore<Profile>(testScope(), 'kv');
		await store.put('u', { name: 'A', version: 1 }, { ifNotExists: true, ifFieldEquals: { version: 0 } });
		await store.put('u', { name: 'A', version: 2 }, { ifNotExists: true, ifFieldEquals: { version: 1 } });
		await rejects(
			store.put('u', { name: 'A', version: 3 }, { ifNotExists: true, ifFieldEquals: { version: 1 } }),
			KVStoreErrors.ConditionalCheckFailed,
		);
	});

	test('an empty ifFieldEquals (or all undefined) is InvalidQuery', async () => {
		const store = new KVStore<Profile>(testScope(), 'kv') as any;
		await store.put('u', { name: 'A', version: 1 });
		await rejects(
			store.put('u', { name: 'A', version: 1 }, { ifFieldEquals: {} }),
			KVStoreErrors.InvalidQuery,
			/at least one/,
		);
		await rejects(store.delete('u', { ifFieldEquals: { version: undefined } }), KVStoreErrors.InvalidQuery);
	});

	test('delete with ifFieldEquals', async () => {
		const store = new KVStore<Profile>(testScope(), 'kv');
		await store.put('u', { name: 'A', version: 1 });
		await rejects(store.delete('u', { ifFieldEquals: { version: 2 } }), KVStoreErrors.ConditionalCheckFailed);
		await store.delete('u', { ifFieldEquals: { version: 1 } });
		assert.strictEqual(await store.get('u'), null);
	});
});

describe('a conflict is an ApiError with status 409 and the right retriable flag', () => {
	async function conflict(promise: Promise<unknown>): Promise<ApiError> {
		try {
			await promise;
		} catch (e) {
			assert.ok(e instanceof ApiError, `expected ApiError, got ${e}`);
			assert.strictEqual(e.status, 409);
			assert.strictEqual(e.name, KVStoreErrors.ConditionalCheckFailed);
			assert.ok(isBlocksError(e, KVStoreErrors.ConditionalCheckFailed));
			return e;
		}
		assert.fail('expected a conflict');
	}

	test('put ifNotExists: not retriable', async () => {
		const store = new KVStore(testScope(), 'kv');
		await store.put('a', 'x');
		assert.strictEqual((await conflict(store.put('a', 'y', { ifNotExists: true }))).retriable, false);
	});

	test('put ifValueEquals / ifFieldEquals: retriable', async () => {
		const store = new KVStore<string | { v: number }>(testScope(), 'kv');
		await store.put('a', 'x');
		assert.strictEqual((await conflict(store.put('a', 'y', { ifValueEquals: 'stale' }))).retriable, true);
		await store.put('o', { v: 1 });
		assert.strictEqual((await conflict(store.put('o', { v: 2 }, { ifFieldEquals: { v: 0 } }))).retriable, true);
	});

	test('put ifNotExists + value check: retriable (OR: the stale-value case)', async () => {
		const store = new KVStore(testScope(), 'kv');
		await store.put('a', 'x');
		assert.strictEqual(
			(await conflict(store.put('a', 'y', { ifNotExists: true, ifValueEquals: 'stale' }))).retriable,
			true,
		);
	});

	test('delete ifExists: not retriable; value check alone: retriable; both: not retriable', async () => {
		const store = new KVStore(testScope(), 'kv');
		assert.strictEqual((await conflict(store.delete('a', { ifExists: true }))).retriable, false);
		await store.put('a', 'x');
		assert.strictEqual((await conflict(store.delete('a', { ifValueEquals: 'stale' }))).retriable, true);
		assert.strictEqual(
			(await conflict(store.delete('a', { ifExists: true, ifValueEquals: 'stale' }))).retriable,
			false,
		);
	});
});

// ── 2. A schema and indexes, string key ─────────────────────────────────────

describe('a store with a schema and indexes (string key)', () => {
	const userSchema = z.object({ name: z.string(), email: z.string(), age: z.number().optional() });
	function users() {
		return new KVStore(testScope(), 'users', {
			schema: userSchema,
			indexes: { byEmail: { partitionKey: 'email' } },
		});
	}

	test('put validates against the schema', async () => {
		const store = users();
		await store.put('u1', { name: 'A', email: 'a@x' });
		await rejects(store.put('u2', { name: 1, email: 'b@x' } as any), KVStoreErrors.ValidationFailed);
		assert.strictEqual(await store.get('u2'), null);
	});

	test('an index query reads by another field, and returns the string key', async () => {
		const store = users();
		await store.put('u1', { name: 'A', email: 'a@x' });
		await store.put('u2', { name: 'B', email: 'b@x' });
		await store.put('u3', { name: 'C', email: 'a@x' });
		const hits = await Array.fromAsync(store.query({ index: 'byEmail', where: { email: { equals: 'a@x' } } }));
		assert.deepStrictEqual(
			hits.map((h) => [h.key, h.value.name]),
			[
				['u1', 'A'],
				['u3', 'C'],
			],
		);
	});

	test('a query without an index on a string store is InvalidQuery', async () => {
		const store = users() as any;
		await rejects(
			() => store.query({ where: { email: { equals: 'a@x' } } }),
			KVStoreErrors.InvalidQuery,
			/declared `key`/,
		);
	});

	test('an unknown index is InvalidQuery', async () => {
		const store = users() as any;
		await rejects(
			() => store.query({ index: 'nope', where: { email: { equals: 'a@x' } } }),
			KVStoreErrors.InvalidQuery,
			/not found/,
		);
	});

	test('an empty string in an indexed field is rejected before the write', async () => {
		const store = users();
		await rejects(
			store.put('u1', { name: 'A', email: '' }),
			KVStoreErrors.ValidationFailed,
			/indexed field 'email'/,
		);
		assert.strictEqual(await store.get('u1'), null);
	});

	test('an item that lacks an optional indexed field is skipped by that index', async () => {
		const store = new KVStore(testScope(), 'users', {
			schema: userSchema,
			indexes: { byAge: { partitionKey: 'age' } },
		});
		await store.put('u1', { name: 'A', email: 'a@x', age: 30 });
		await store.put('u2', { name: 'B', email: 'b@x' });
		const hits = await Array.fromAsync(store.query({ index: 'byAge', where: { age: { equals: 30 } } }));
		assert.deepStrictEqual(
			hits.map((h) => h.key),
			['u1'],
		);
	});
});

// ── 3. A declared key ───────────────────────────────────────────────────────

describe('a store with a declared key', () => {
	function orders() {
		return new KVStore(testScope(), 'orders', {
			schema: orderSchema,
			key: { partitionKey: 'userId', sortKey: 'orderId' },
		});
	}

	test('put writes the key fields from the key; the value may leave them out', async () => {
		const store = orders();
		await store.put({ userId: 'alice', orderId: '001' }, { total: 12 });
		assert.deepStrictEqual(await store.get({ userId: 'alice', orderId: '001' }), {
			userId: 'alice',
			orderId: '001',
			total: 12,
		});
	});

	test('a value whose key field agrees is accepted; one that disagrees is ValidationFailed', async () => {
		const store = orders();
		await store.put({ userId: 'alice', orderId: '001' }, { userId: 'alice', orderId: '001', total: 1 });
		await rejects(
			store.put({ userId: 'alice', orderId: '001' }, { userId: 'bob', total: 1 }),
			KVStoreErrors.ValidationFailed,
			/does not equal the key/,
		);
	});

	test('a key of the wrong shape is InvalidQuery (JavaScript caller)', async () => {
		const store = orders() as any;
		await rejects(store.get('alice'), KVStoreErrors.InvalidQuery, /key object/);
		await rejects(store.get({ userId: 'alice' }), KVStoreErrors.InvalidQuery);
		await rejects(store.get({ userId: 'alice', orderId: '001', total: 1 }), KVStoreErrors.InvalidQuery);
		await rejects(store.get({ userId: 1, orderId: '001' }), KVStoreErrors.InvalidQuery, /must be a string/);
		await rejects(
			store.put({ userId: 'alice', orderId: '001' }, 'text'),
			KVStoreErrors.ValidationFailed,
			/object value/,
		);
	});

	test('an empty string in a key field is ValidationFailed', async () => {
		const store = orders();
		await rejects(
			store.put({ userId: '', orderId: '001' }, { total: 1 }),
			KVStoreErrors.ValidationFailed,
			/empty string/,
		);
	});

	test('the stored item is flat: the key fields and the value fields, no _bkv_ attributes', async () => {
		const store = orders();
		await store.put({ userId: 'alice', orderId: '001' }, { total: 12 });
		const stored = JSON.parse(readFileSync(`.bb-data/${store.fullId}/store.json`, 'utf8'));
		assert.deepStrictEqual(Object.values(stored), [{ userId: 'alice', orderId: '001', total: 12 }]);
	});

	test('a key with one field', async () => {
		const store = new KVStore(testScope(), 'jobs', {
			schema: z.object({ jobId: z.string(), state: z.string() }),
			key: { partitionKey: 'jobId' },
		});
		await store.put({ jobId: 'j1' }, { state: 'queued' }, { ifNotExists: true });
		assert.deepStrictEqual(await store.get({ jobId: 'j1' }), { jobId: 'j1', state: 'queued' });
		await rejects(
			store.put({ jobId: 'j1' }, { state: 'again' }, { ifNotExists: true }),
			KVStoreErrors.ConditionalCheckFailed,
		);
	});

	test('a number partition key', async () => {
		const store = new KVStore(testScope(), 'readings', {
			schema: z.object({ deviceId: z.number(), at: z.number(), celsius: z.number() }),
			key: { partitionKey: 'deviceId', sortKey: 'at' },
		});
		await store.put({ deviceId: 7, at: 1 }, { celsius: 20 });
		await store.put({ deviceId: 7, at: 2 }, { celsius: 21 });
		const hits = await Array.fromAsync(store.query({ where: { deviceId: { equals: 7 }, at: { greaterThan: 1 } } }));
		assert.deepStrictEqual(
			hits.map((h) => h.value.celsius),
			[21],
		);
	});

	test('a key field takes only the type that its schema states', async () => {
		const store = new KVStore(testScope(), 'readings', {
			schema: z.object({ deviceId: z.number(), room: z.string(), celsius: z.number() }),
			key: { partitionKey: 'deviceId', sortKey: 'room' },
		});
		await rejects(
			store.get({ deviceId: '7', room: 'a' } as never),
			KVStoreErrors.InvalidQuery,
			/'deviceId' must be a number \(received string\)/,
		);
		await rejects(
			store.put({ deviceId: 7, room: 1 } as never, { celsius: 20 }),
			KVStoreErrors.InvalidQuery,
			/'room' must be a string \(received number\)/,
		);
	});

	test('a refined number key field is a number key: the probe tries 0, 1 and -1', async () => {
		const store = new KVStore(testScope(), 'ledger', {
			schema: z.object({ account: z.number().positive(), delta: z.number().negative(), note: z.string() }),
			key: { partitionKey: 'account', sortKey: 'delta' },
		});
		await store.put({ account: 3, delta: -2 }, { note: 'n' });
		assert.deepStrictEqual(await store.get({ account: 3, delta: -2 }), { account: 3, delta: -2, note: 'n' });
		await rejects(
			store.get({ account: '3', delta: -2 } as never),
			KVStoreErrors.InvalidQuery,
			/'account' must be a number/,
		);
		await rejects(
			store.get({ account: 3, delta: '-2' } as never),
			KVStoreErrors.InvalidQuery,
			/'delta' must be a number/,
		);
	});

	test('a schema that accepts every value makes a key field a number key, as the CDK layer provisions it', async () => {
		const anything: StandardSchemaV1<{ id: string; label: string }> = {
			'~standard': {
				version: 1,
				vendor: 'test',
				validate: (value: unknown) => ({ value: value as { id: string; label: string } }),
			},
		};
		const store = new KVStore(testScope(), 'loose', { schema: anything, key: { partitionKey: 'id' } });
		await rejects(store.get({ id: 'a' }), KVStoreErrors.InvalidQuery, /'id' must be a number/);
	});

	test('batch calls', async () => {
		const store = orders();
		await store.putBatch([
			{ key: { userId: 'a', orderId: '1' }, value: { total: 1 } },
			{ key: { userId: 'a', orderId: '2' }, value: { total: 2 }, ttlSeconds: 60 },
		]);
		const got = await store.getBatch([
			{ userId: 'a', orderId: '1' },
			{ userId: 'a', orderId: 'missing' },
			{ userId: 'a', orderId: '2' },
		]);
		assert.deepStrictEqual(got, [
			{ userId: 'a', orderId: '1', total: 1 },
			null,
			{ userId: 'a', orderId: '2', total: 2 },
		]);
		await store.deleteBatch([
			{ userId: 'a', orderId: '1' },
			{ userId: 'a', orderId: '2' },
		]);
		assert.deepStrictEqual(await Array.fromAsync(store.scan()), []);
	});

	test('putBatch validates every entry before writing any', async () => {
		const store = orders();
		await rejects(
			store.putBatch([
				{ key: { userId: 'a', orderId: '1' }, value: { total: 1 } },
				{ key: { userId: 'a', orderId: '2' }, value: { total: 'x' as unknown as number } },
			]),
			KVStoreErrors.ValidationFailed,
		);
		assert.strictEqual(await store.get({ userId: 'a', orderId: '1' }), null);
	});
});

// ── Query ───────────────────────────────────────────────────────────────────

describe('query', () => {
	const eventSchema = z.object({ pk: z.string(), at: z.number(), name: z.string(), path: z.string() });
	async function seeded() {
		const store = new KVStore(testScope(), 'events', {
			schema: eventSchema,
			key: { partitionKey: 'pk', sortKey: 'at' },
			indexes: { byPath: { partitionKey: 'pk', sortKey: 'path' }, byName: { partitionKey: 'name' } },
		});
		await store.put({ pk: 'p', at: 1000 }, { name: 'a', path: '/docs/a' });
		await store.put({ pk: 'p', at: 2000 }, { name: 'b', path: '/docs/b' });
		await store.put({ pk: 'p', at: 3000 }, { name: 'c', path: '/images/c' });
		await store.put({ pk: 'p', at: 4000 }, { name: 'd', path: '/images/d' });
		await store.put({ pk: 'p', at: 5000 }, { name: 'e', path: '/videos/e' });
		await store.put({ pk: 'other', at: 1000 }, { name: 'z', path: '/docs/z' });
		return store;
	}
	const ats = async (results: AsyncIterable<{ value: { at: number } }>) =>
		(await Array.fromAsync(results)).map((e) => e.value.at);

	test('no filter returns the partition in sort order; order desc reverses it', async () => {
		const store = await seeded();
		assert.deepStrictEqual(
			await ats(store.query({ where: { pk: { equals: 'p' } } })),
			[1000, 2000, 3000, 4000, 5000],
		);
		assert.deepStrictEqual(
			await ats(store.query({ where: { pk: { equals: 'p' } }, order: 'desc' })),
			[5000, 4000, 3000, 2000, 1000],
		);
	});

	test('number sort conditions', async () => {
		const store = await seeded();
		const where = (c: object) => store.query({ where: { pk: { equals: 'p' }, at: c as { equals: number } } });
		assert.deepStrictEqual(await ats(where({ equals: 3000 })), [3000]);
		assert.deepStrictEqual(await ats(where({ greaterThan: 3000 })), [4000, 5000]);
		assert.deepStrictEqual(await ats(where({ greaterThanOrEqual: 3000 })), [3000, 4000, 5000]);
		assert.deepStrictEqual(await ats(where({ lessThan: 3000 })), [1000, 2000]);
		assert.deepStrictEqual(await ats(where({ lessThanOrEqual: 3000 })), [1000, 2000, 3000]);
		assert.deepStrictEqual(await ats(where({ between: [2000, 4000] })), [2000, 3000, 4000]);
		assert.deepStrictEqual(await ats(where({ between: [5500, 6000] })), []);
	});

	test('string sort conditions on an index', async () => {
		const store = await seeded();
		const where = (c: object) =>
			store.query({ index: 'byPath', where: { pk: { equals: 'p' }, path: c as { equals: string } } });
		assert.deepStrictEqual(await ats(where({ beginsWith: '/docs/' })), [1000, 2000]);
		assert.deepStrictEqual(await ats(where({ beginsWith: '/music/' })), []);
		assert.deepStrictEqual(await ats(where({ greaterThan: '/images/' })), [3000, 4000, 5000]);
		assert.deepStrictEqual(await ats(where({ between: ['/docs/', '/images/d'] })), [1000, 2000, 3000, 4000]);
	});

	test('limit, and the entries carry the key', async () => {
		const store = await seeded();
		const entries = await Array.fromAsync(store.query({ where: { pk: { equals: 'p' } }, limit: 2 }));
		assert.deepStrictEqual(entries, [
			{ key: { pk: 'p', at: 1000 }, value: { pk: 'p', at: 1000, name: 'a', path: '/docs/a' } },
			{ key: { pk: 'p', at: 2000 }, value: { pk: 'p', at: 2000, name: 'b', path: '/docs/b' } },
		]);
	});

	test('an index without a sort key orders ties by the base key', async () => {
		const store = await seeded();
		await store.put({ pk: 'q', at: 1 }, { name: 'a', path: '/x' });
		const hits = await Array.fromAsync(store.query({ index: 'byName', where: { name: { equals: 'a' } } }));
		assert.deepStrictEqual(
			hits.map((h) => h.key),
			[
				{ pk: 'p', at: 1000 },
				{ pk: 'q', at: 1 },
			],
		);
	});

	test('a partition with no items returns nothing', async () => {
		const store = await seeded();
		assert.deepStrictEqual(await ats(store.query({ where: { pk: { equals: 'nobody' } } })), []);
	});

	test('a missing where, a partition without equals, and two sort conditions are InvalidQuery', async () => {
		const store = (await seeded()) as any;
		await rejects(() => store.query({}), KVStoreErrors.InvalidQuery, /where/);
		await rejects(() => store.query({ where: { pk: 'p' } }), KVStoreErrors.InvalidQuery, /equals/);
		await rejects(
			() => store.query({ where: { pk: { equals: 'p' }, at: { greaterThan: 1, lessThan: 2 } } }),
			KVStoreErrors.InvalidQuery,
			/between/,
		);
	});

	test('the partition value and the sort operands pass the same check as a key', async () => {
		const store = await seeded();
		const read = (where: object, index?: string) => () => store.query({ where, index } as never);
		const { InvalidQuery, ValidationFailed } = KVStoreErrors;

		// The partition value: the type of the field, and no empty string.
		await rejects(read({ pk: { equals: 1 } }), InvalidQuery, /'pk' must be a string \(received number\)/);
		await rejects(read({ pk: { equals: Number.NaN } }), InvalidQuery, /'pk' must be a string/);
		await rejects(read({ pk: { equals: null } }), InvalidQuery, /received null/);
		await rejects(read({ pk: { equals: '' } }), ValidationFailed, /'pk' cannot be an empty string/);
		// An index field has a type too.
		await rejects(read({ name: { equals: 7 } }, 'byName'), InvalidQuery, /'name' must be a string/);

		// The sort operands.
		const pk = { equals: 'p' };
		await rejects(
			read({ pk, at: { greaterThan: '1000' } }),
			InvalidQuery,
			/'at' must be a number \(received string\)/,
		);
		await rejects(read({ pk, at: { equals: Number.NaN } }), InvalidQuery, /'at' must be a number/);
		await rejects(read({ pk, at: { lessThan: null } }), InvalidQuery, /'at' must be a number/);
		await rejects(read({ pk, at: { between: [1000, '2000'] } }), InvalidQuery, /'at' must be a number/);
		await rejects(read({ pk, path: { beginsWith: 5 } }, 'byPath'), InvalidQuery, /'path' must be a string/);
		await rejects(
			read({ pk, path: { beginsWith: '' } }, 'byPath'),
			ValidationFailed,
			/'path' cannot be an empty string/,
		);

		// The shape of the sort condition.
		await rejects(read({ pk, at: { between: [1000] } }), InvalidQuery, /two values/);
		await rejects(read({ pk, at: { between: 1000 } }), InvalidQuery, /two values/);
		await rejects(read({ pk, at: { beginsWith: '1' } }), InvalidQuery, /'beginsWith' needs a string field/);
		await rejects(read({ pk, at: { startsWith: 1 } }), InvalidQuery, /'startsWith' is not a sort condition/);
		await rejects(read({ pk, at: 1000 }), InvalidQuery, /must be an object/);
	});

	test('a present-but-empty sort condition is no filter', async () => {
		const store = await seeded();
		assert.deepStrictEqual(
			await ats(store.query({ where: { pk: { equals: 'p' }, at: {} as { equals: number } } })),
			[1000, 2000, 3000, 4000, 5000],
		);
	});
});

// ── Pages ───────────────────────────────────────────────────────────────────

describe('pages', () => {
	const schema = z.object({ pk: z.string(), sk: z.number(), n: z.string() });
	async function seeded() {
		const store = new KVStore(testScope(), 'paged', {
			schema,
			key: { partitionKey: 'pk', sortKey: 'sk' },
			indexes: { byN: { partitionKey: 'n', sortKey: 'sk' } },
		});
		for (const sk of [1, 2, 3, 4, 5]) await store.put({ pk: 'p', sk }, { n: 'x' });
		return store;
	}

	test('query: a cursor continues across two calls and is undefined at the end', async () => {
		const store = await seeded();
		const first = store.query({ where: { pk: { equals: 'p' } }, limit: 2 });
		assert.deepStrictEqual(
			(await Array.fromAsync(first)).map((e) => e.value.sk),
			[1, 2],
		);
		assert.strictEqual(typeof first.cursor, 'string');
		const second = store.query({ where: { pk: { equals: 'p' } }, limit: 2, cursor: first.cursor });
		assert.deepStrictEqual(
			(await Array.fromAsync(second)).map((e) => e.value.sk),
			[3, 4],
		);
		const third = store.query({ where: { pk: { equals: 'p' } }, limit: 2, cursor: second.cursor });
		assert.deepStrictEqual(
			(await Array.fromAsync(third)).map((e) => e.value.sk),
			[5],
		);
		assert.strictEqual(third.cursor, undefined);
	});

	test('query: the cursor follows order desc', async () => {
		const store = await seeded();
		const first = store.query({ where: { pk: { equals: 'p' } }, limit: 2, order: 'desc' });
		assert.deepStrictEqual(
			(await Array.fromAsync(first)).map((e) => e.value.sk),
			[5, 4],
		);
		const second = store.query({ where: { pk: { equals: 'p' } }, limit: 2, order: 'desc', cursor: first.cursor });
		assert.deepStrictEqual(
			(await Array.fromAsync(second)).map((e) => e.value.sk),
			[3, 2],
		);
	});

	test('a read that stops early still has a cursor', async () => {
		const store = await seeded();
		const results = store.query({ where: { pk: { equals: 'p' } } });
		for await (const { value } of results) {
			if (value.sk === 2) break;
		}
		const rest = store.query({ where: { pk: { equals: 'p' } }, cursor: results.cursor });
		assert.deepStrictEqual(
			(await Array.fromAsync(rest)).map((e) => e.value.sk),
			[3, 4, 5],
		);
	});

	test('the cursor is undefined before iteration and after a full read', async () => {
		const store = await seeded();
		const results = store.query({ where: { pk: { equals: 'p' } } });
		assert.strictEqual(results.cursor, undefined);
		await Array.fromAsync(results);
		assert.strictEqual(results.cursor, undefined);
	});

	test('a cursor is readable and holds exactly the key attributes', async () => {
		const store = await seeded();
		const first = store.query({ where: { pk: { equals: 'p' } }, limit: 1 });
		await Array.fromAsync(first);
		const decoded = JSON.parse(Buffer.from(first.cursor as string, 'base64url').toString('utf8'));
		assert.deepStrictEqual(decoded, { v: 1, index: null, key: { pk: 'p', sk: 1 } });
		const indexed = store.query({ index: 'byN', where: { n: { equals: 'x' } }, limit: 1 });
		await Array.fromAsync(indexed);
		assert.deepStrictEqual(JSON.parse(Buffer.from(indexed.cursor as string, 'base64url').toString('utf8')), {
			v: 1,
			index: 'byN',
			key: { pk: 'p', sk: 1, n: 'x' },
		});
	});

	test('a cursor that does not decode, or that names another index or partition, is InvalidQuery', async () => {
		const store = await seeded();
		const first = store.query({ where: { pk: { equals: 'p' } }, limit: 1 });
		await Array.fromAsync(first);
		const cursor = first.cursor as string;
		const read = (options: object) => () => store.query(options as never);
		await rejects(
			read({ where: { pk: { equals: 'p' } }, cursor: 'not-a-cursor' }),
			KVStoreErrors.InvalidQuery,
			/not a cursor/,
		);
		await rejects(
			read({ where: { pk: { equals: 'p' } }, cursor: Buffer.from('{"v":1}').toString('base64url') }),
			KVStoreErrors.InvalidQuery,
		);
		await rejects(
			read({ index: 'byN', where: { n: { equals: 'x' } }, cursor }),
			KVStoreErrors.InvalidQuery,
			/belongs to the table key/,
		);
		await rejects(
			read({ where: { pk: { equals: 'other' } }, cursor }),
			KVStoreErrors.InvalidQuery,
			/another 'pk' partition/,
		);
		const tampered = Buffer.from(JSON.stringify({ v: 1, index: null, key: { pk: 'p', sk: 1, extra: 1 } })).toString(
			'base64url',
		);
		await rejects(
			read({ where: { pk: { equals: 'p' } }, cursor: tampered }),
			KVStoreErrors.InvalidQuery,
			/exactly the key attributes/,
		);
		await rejects(() => store.scan({ cursor: indexedCursor(store) }), KVStoreErrors.InvalidQuery);
	});

	function indexedCursor(_store: unknown): string {
		return Buffer.from(JSON.stringify({ v: 1, index: 'byN', key: { pk: 'p', sk: 1, n: 'x' } })).toString(
			'base64url',
		);
	}

	test('a cursor whose key values fail the key check is InvalidQuery', async () => {
		const store = await seeded();
		const cursorOf = (key: object, index: string | null = null) =>
			Buffer.from(JSON.stringify({ v: 1, index, key })).toString('base64url');
		// A string in a number field, null (what JSON makes of NaN), an empty string, a number in a string field.
		for (const key of [
			{ pk: 'p', sk: '1' },
			{ pk: 'p', sk: null },
			{ pk: '', sk: 1 },
			{ pk: 1, sk: 1 },
		]) {
			const cursor = cursorOf(key);
			await rejects(
				() => store.query({ where: { pk: { equals: 'p' } }, cursor }),
				KVStoreErrors.InvalidQuery,
				/exactly the key attributes/,
			);
			await rejects(() => store.scan({ cursor }), KVStoreErrors.InvalidQuery, /exactly the key attributes/);
		}
		// The index field of an index cursor has the type of that field.
		await rejects(
			() =>
				store.query({
					index: 'byN',
					where: { n: { equals: 'x' } },
					cursor: cursorOf({ pk: 'p', sk: 1, n: 5 }, 'byN'),
				}),
			KVStoreErrors.InvalidQuery,
			/exactly the key attributes/,
		);
	});

	test('a null cursor, limit or index counts as absent (a JSON transport sends null for an argument left out)', async () => {
		const store = await seeded();
		const all = await Array.fromAsync(
			store.query({ where: { pk: { equals: 'p' } }, limit: null, cursor: null, index: null } as never),
		);
		assert.strictEqual(all.length, 5);
		assert.strictEqual((await Array.fromAsync(store.scan({ limit: null, cursor: null } as never))).length, 5);
	});

	test('a null option counts as absent in every method; the two value checks are the exception', async () => {
		const store = new KVStore(testScope(), 'kv');
		const nulls = { ttlSeconds: null, expiresAt: null, ifNotExists: null } as never;
		await store.put('a', 'one', nulls);
		// `ifNotExists: null` is no condition, so the second write goes through.
		await store.put('a', 'two', nulls);
		assert.strictEqual(await store.get('a', { consistentRead: null } as never), 'two');
		const [entry] = await Array.fromAsync(store.scan({ includeExpired: null } as never));
		assert.deepStrictEqual(entry, { key: 'a', value: 'two' });
		await store.putBatch([{ key: 'b', value: 'three', ttlSeconds: null, expiresAt: null } as never]);
		assert.strictEqual(await store.get('b'), 'three');
		await store.delete('b', { ifExists: null } as never);
		// No `ifExists`, so a delete of a missing key is not a conflict.
		await store.delete('b', { ifExists: null } as never);

		// `ifValueEquals: null` stays a compare with a stored null.
		await rejects(store.put('a', 'three', { ifValueEquals: null } as never), KVStoreErrors.ConditionalCheckFailed);
		assert.strictEqual(await store.get('a'), 'two');
		const nullable = new KVStore<string | null>(testScope(), 'kv');
		await nullable.put('n', null);
		await nullable.put('n', 'set', { ifValueEquals: null });
		assert.strictEqual(await nullable.get('n'), 'set');
		await rejects(nullable.delete('n', { ifValueEquals: null }), KVStoreErrors.ConditionalCheckFailed);

		// `ifFieldEquals: null` stays a call error.
		const objects = new KVStore<{ n: number }>(testScope(), 'kv');
		await rejects(objects.put('o', { n: 1 }, { ifFieldEquals: null } as never), KVStoreErrors.InvalidQuery);
		await rejects(objects.delete('o', { ifFieldEquals: null } as never), KVStoreErrors.InvalidQuery);
	});

	test('a limit that is not a positive integer is InvalidQuery', async () => {
		const store = await seeded();
		for (const limit of [0, -1, 1.5, '2']) {
			await rejects(
				() => store.query({ where: { pk: { equals: 'p' } }, limit } as never),
				KVStoreErrors.InvalidQuery,
				/positive integer/,
			);
			await rejects(() => store.scan({ limit } as never), KVStoreErrors.InvalidQuery, /positive integer/);
		}
	});

	test('scan: a cursor continues across two calls', async () => {
		const store = await seeded();
		const first = store.scan({ limit: 3 });
		assert.strictEqual((await Array.fromAsync(first)).length, 3);
		const second = store.scan({ limit: 3, cursor: first.cursor });
		assert.strictEqual((await Array.fromAsync(second)).length, 2);
		assert.strictEqual(second.cursor, undefined);
	});

	test('scan: a string store pages too', async () => {
		const store = new KVStore(testScope(), 'kv');
		for (const k of ['a', 'b', 'c']) await store.put(k, k);
		const first = store.scan({ limit: 2 });
		assert.deepStrictEqual(
			(await Array.fromAsync(first)).map((e) => e.key),
			['a', 'b'],
		);
		const second = store.scan({ cursor: first.cursor });
		assert.deepStrictEqual(
			(await Array.fromAsync(second)).map((e) => e.key),
			['c'],
		);
	});
});

// ── Expiry ──────────────────────────────────────────────────────────────────

describe('expiry', () => {
	test('every read hides an expired item; includeExpired shows it on scan', async () => {
		const store = new KVStore(testScope(), 'orders', {
			schema: orderSchema,
			key: { partitionKey: 'userId', sortKey: 'orderId' },
			indexes: { byNote: { partitionKey: 'note' } },
		});
		await store.put({ userId: 'a', orderId: '1' }, { total: 1, note: 'n' }, { expiresAt: 1 });
		await store.put({ userId: 'a', orderId: '2' }, { total: 2, note: 'n' });
		assert.strictEqual(await store.get({ userId: 'a', orderId: '1' }), null);
		assert.deepStrictEqual(await store.getBatch([{ userId: 'a', orderId: '1' }]), [null]);
		assert.deepStrictEqual(
			(await Array.fromAsync(store.query({ where: { userId: { equals: 'a' } } }))).map((e) => e.value.total),
			[2],
		);
		assert.deepStrictEqual(
			(await Array.fromAsync(store.query({ index: 'byNote', where: { note: { equals: 'n' } } }))).map(
				(e) => e.value.total,
			),
			[2],
		);
		assert.deepStrictEqual(
			(await Array.fromAsync(store.scan())).map((e) => e.value.total),
			[2],
		);
		assert.deepStrictEqual(
			(await Array.fromAsync(store.scan({ includeExpired: true }))).map((e) => e.value.total),
			[1, 2],
		);
	});

	test('a condition still sees an expired item', async () => {
		const store = new KVStore(testScope(), 'kv');
		await store.put('a', 'old', { expiresAt: 1 });
		await rejects(store.put('a', 'new', { ifNotExists: true }), KVStoreErrors.ConditionalCheckFailed);
		await store.put('a', 'new', { ifValueEquals: 'old' });
		assert.strictEqual(await store.get('a'), 'new');
	});

	test('ttl names a field of the value: a put with no expiry option uses the field', async () => {
		const store = new KVStore(testScope(), 'sessions', {
			schema: z.object({ sessionId: z.string(), userId: z.string(), expiresAt: z.number() }),
			key: { partitionKey: 'sessionId' },
			ttl: 'expiresAt',
		});
		const future = Math.floor(Date.now() / 1000) + 3600;
		await store.put({ sessionId: 'live' }, { userId: 'a', expiresAt: future });
		await store.put({ sessionId: 'dead' }, { userId: 'a', expiresAt: 1 });
		assert.deepStrictEqual(await store.get({ sessionId: 'live' }), {
			sessionId: 'live',
			userId: 'a',
			expiresAt: future,
		});
		assert.strictEqual(await store.get({ sessionId: 'dead' }), null);
		const entries = await Array.fromAsync(store.scan());
		assert.deepStrictEqual(entries, [
			{
				key: { sessionId: 'live' },
				value: { sessionId: 'live', userId: 'a', expiresAt: future },
				expiresAt: future,
			},
		]);
		// An expiry option writes the field.
		await store.put({ sessionId: 'live' }, { userId: 'a', expiresAt: future }, { expiresAt: future + 10 });
		assert.strictEqual((await store.get({ sessionId: 'live' }))?.expiresAt, future + 10);
		const stored = JSON.parse(readFileSync(`.bb-data/${store.fullId}/store.json`, 'utf8'));
		assert.ok(
			Object.values(stored).every((item: any) => !('_bkv_ttl' in item)),
			'no _bkv_ttl when ttl names a field',
		);
	});

	test('ttl names a field: the expiry of the call is in the value before the schema validates it', async () => {
		const store = new KVStore(testScope(), 'sessions', {
			schema: z.object({
				sessionId: z.string(),
				userId: z.string(),
				expiresAt: z.number().min(1_700_000_000),
			}),
			key: { partitionKey: 'sessionId' },
			ttl: 'expiresAt',
		});
		// The value holds a number that the schema rejects. The option replaces it,
		// and the schema validates the number that is stored.
		await store.put({ sessionId: 's1' }, { userId: 'a', expiresAt: 1 }, { expiresAt: 1_800_000_000 });
		assert.deepStrictEqual(await store.get({ sessionId: 's1' }), {
			sessionId: 's1',
			userId: 'a',
			expiresAt: 1_800_000_000,
		});
		// A JavaScript caller can leave the field out when the call gives the expiry.
		await store.put({ sessionId: 's2' }, { userId: 'b' } as never, { ttlSeconds: 60 });
		const expiresAt = (await store.get({ sessionId: 's2' }))?.expiresAt ?? 0;
		assert.ok(expiresAt > Date.now() / 1000 && expiresAt <= Date.now() / 1000 + 61);
		// With no expiry option, the schema validates the field of the value, as before.
		await rejects(store.put({ sessionId: 's3' }, { userId: 'c', expiresAt: 1 }), KVStoreErrors.ValidationFailed);
		await rejects(store.put({ sessionId: 's4' }, { userId: 'd' } as never), KVStoreErrors.ValidationFailed);
	});

	test('a rewrite can pass expiresAt from scan back into put', async () => {
		const store = new KVStore(testScope(), 'kv');
		await store.put('a', ' padded ', { expiresAt: 1800000000 });
		for await (const { key, value, expiresAt } of store.scan()) {
			await store.put(key, value.trim(), { ifValueEquals: value, expiresAt });
		}
		assert.deepStrictEqual(await Array.fromAsync(store.scan()), [
			{ key: 'a', value: 'padded', expiresAt: 1800000000 },
		]);
	});
});

// ── Reads and schema changes ────────────────────────────────────────────────

describe('readValidation', () => {
	const v1 = z.object({ id: z.string(), total: z.number() });
	const v2 = z.object({ id: z.string(), total: z.number(), currency: z.string().default('USD') });
	// A required field with no default: a legacy row can never satisfy it.
	const v2Required = z.object({ id: z.string(), total: z.number(), currency: z.string() });
	type V2 = z.infer<typeof v2>;
	async function legacyRow(mode?: 'off' | 'coerce' | 'strict', schema: typeof v2 | typeof v2Required = v2) {
		const scope = testScope();
		const old = new KVStore(scope, 't', { schema: v1, key: { partitionKey: 'id' } });
		await old.put({ id: 'o1' }, { total: 10 });
		return new KVStore(scope, 't', {
			schema,
			key: { partitionKey: 'id' },
			...(mode ? { readValidation: mode } : {}),
			logger: { warn() {}, info() {}, debug() {}, error() {} } as any,
		});
	}

	test("default 'coerce' fills a default and the read can be written back", async () => {
		const store = await legacyRow();
		const row = await store.get({ id: 'o1' });
		assert.deepStrictEqual(row, { id: 'o1', total: 10, currency: 'USD' });
		await store.put({ id: 'o1' }, { ...(row as V2), total: 20 });
		assert.deepStrictEqual(await store.get({ id: 'o1' }), { id: 'o1', total: 20, currency: 'USD' });
	});

	test("'coerce' preserves stored fields the schema does not declare", async () => {
		const scope = testScope();
		const loose = new KVStore<Record<string, unknown>>(scope, 't');
		await loose.put('o1', { id: 'o1', total: 10, legacy: 'keep' });
		const store = new KVStore(scope, 't', { schema: v2 });
		assert.deepStrictEqual(await store.get('o1'), { id: 'o1', total: 10, legacy: 'keep', currency: 'USD' });
	});

	test("'coerce' returns an uncoercible row raw and never throws", async () => {
		const scope = testScope();
		const loose = new KVStore<Record<string, unknown>>(scope, 't');
		await loose.put('bad', { id: 'bad', total: 'not a number' });
		const store = new KVStore(scope, 't', {
			schema: v2,
			logger: { warn() {}, info() {}, debug() {}, error() {} } as any,
		});
		assert.deepStrictEqual(await store.get('bad'), { id: 'bad', total: 'not a number' });
	});

	test("'off' returns the raw row; 'strict' throws ValidationFailed", async () => {
		assert.deepStrictEqual(await (await legacyRow('off')).get({ id: 'o1' }), { id: 'o1', total: 10 });
		await rejects((await legacyRow('strict', v2Required)).get({ id: 'o1' }), KVStoreErrors.ValidationFailed);
		assert.deepStrictEqual(await (await legacyRow('strict')).get({ id: 'o1' }), {
			id: 'o1',
			total: 10,
			currency: 'USD',
		});
		// 'coerce' returns the uncoercible legacy row raw.
		assert.deepStrictEqual(await (await legacyRow('coerce', v2Required)).get({ id: 'o1' }), {
			id: 'o1',
			total: 10,
		});
	});

	test('a missing item is null in every mode', async () => {
		for (const mode of ['off', 'coerce', 'strict'] as const) {
			assert.strictEqual(await (await legacyRow(mode)).get({ id: 'missing' }), null);
		}
	});
});

// ── The key type probe ──────────────────────────────────────────────────────

describe('the key type probe', () => {
	test('a field is a number if the schema accepts 0, 1 or -1 for it; in all other cases it is a string', () => {
		const schema = z.object({
			text: z.string(),
			uuid: z.string().uuid(),
			choice: z.enum(['a', 'b']),
			count: z.number(),
			positive: z.number().positive(),
			negative: z.number().negative(),
			either: z.union([z.string(), z.number()]),
			atLeastFive: z.number().min(5),
		});
		const types = Object.fromEntries(
			Object.keys(schema.shape).map((field) => [field, probeKeyType(schema, field)]),
		);
		assert.deepStrictEqual(types, {
			text: 'S',
			uuid: 'S',
			choice: 'S',
			count: 'N',
			positive: 'N',
			negative: 'N',
			either: 'N',
			// A number field that rejects all three samples reads as a string (see DESIGN.md, D-KV-17).
			atLeastFive: 'S',
		});
	});

	test('no schema gives a string; a schema that validates asynchronously gives a number', () => {
		assert.strictEqual(probeKeyType(undefined, 'id'), 'S');
		const asyncSchema: StandardSchemaV1<{ id: string }> = {
			'~standard': {
				version: 1,
				vendor: 'test',
				validate: async () => ({ issues: [{ message: 'id must be a string', path: ['id'] }] }),
			},
		};
		assert.strictEqual(probeKeyType(asyncSchema, 'id'), 'N');
	});
});

// ── Statics and constants ───────────────────────────────────────────────────

describe('statics and constants', () => {
	test('fromExisting and fromKmsKey return branded refs', () => {
		assert.deepStrictEqual(KVStore.fromExisting('t'), { __brand: 'ExternalTableRef', tableName: 't' });
		assert.deepStrictEqual(KVStore.fromKmsKey('arn'), { __brand: 'ExternalKmsKeyRef', keyArn: 'arn' });
	});

	test('KVStoreErrors is the union of both blocks, five distinct names', () => {
		assert.deepStrictEqual(KVStoreErrors, {
			ConditionalCheckFailed: 'ConditionalCheckFailedException',
			ValidationFailed: 'ValidationFailedException',
			InvalidQuery: 'InvalidQueryException',
			ItemTooLarge: 'ItemTooLargeException',
			BatchIncomplete: 'BatchIncompleteException',
		});
		assert.strictEqual(new Set(Object.values(KVStoreErrors)).size, 5);
	});

	test('fullId generation with parent', () => {
		const store = new KVStore(new Scope('app'), 'kv');
		assert.strictEqual(store.fullId, 'app-kv');
	});
});
