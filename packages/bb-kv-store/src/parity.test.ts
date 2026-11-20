// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock/AWS parity: the AWS runtime is driven through a fake DocumentClient so
 * the commands it builds (item layout, condition expressions, query shape,
 * cursors, batch retries) can be asserted next to the mock's behaviour for the
 * same inputs, without touching the network.
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { beforeEach, describe, test } from 'node:test';
import { ApiError, isBlocksError } from '@aws-cdk-blocks/core';
import { z } from 'zod';
import { KVStore as AwsKVStore } from './index.aws.js';
import { KVStore, KVStoreErrors } from './index.mock.js';

beforeEach(() => {
	try {
		rmSync('.cdk-blocks/local/data', { recursive: true, force: true });
		rmSync('.bb-data', { recursive: true, force: true });
	} catch {}
});

let scopeN = 0;
function testScope() {
	return { id: `kv-parity-${++scopeN}-${Date.now()}` } as any;
}

/**
 * An AWS-runtime KVStore wired to a fake doc client. `send` receives each SDK
 * command and returns the simulated DynamoDB response; every command input is
 * recorded so the test can assert its shape. `input(i)` strips `TableName`
 * (the store's fullId, unique per test) so expectations can be literal.
 */
function awsStore(id: string, options?: any, respond: (command: any) => any = () => ({})) {
	const store = new AwsKVStore(testScope(), id, options as never) as any;
	const sent: any[] = [];
	store.docClient = {
		send: async (command: any) => {
			sent.push(command);
			const out = respond(command);
			if (out instanceof Error) throw out;
			return out ?? {};
		},
	};
	const input = (i = 0) => {
		const { TableName: _table, ...rest } = sent[i].input;
		return rest;
	};
	return { store, sent, input, tableName: store.fullId as string };
}

/** A mock store with loosely typed options, for the parity cases driven by plain JavaScript values. */
function mockStore(id: string, options?: any): any {
	return new KVStore(testScope(), id, options as never);
}

/** The one table a batch command addresses, and its requests. */
function batchOf(command: any): { table: string; requests: any } {
	const table = Object.keys(command.input.RequestItems)[0];
	return { table, requests: command.input.RequestItems[table] };
}

async function rejects(promise: Promise<unknown> | (() => unknown), name: string): Promise<Error> {
	try {
		await (typeof promise === 'function' ? promise() : promise);
	} catch (e) {
		assert.ok(isBlocksError(e, name), `expected ${name}, got ${(e as Error).name}: ${(e as Error).message}`);
		return e as Error;
	}
	assert.fail(`expected ${name}`);
}

const ddbError = (name: string, message = name) => {
	const e = new Error(message);
	e.name = name;
	return e;
};

// ── Browser entry ───────────────────────────────────────────────────────────

describe('browser entry exports error constants', () => {
	test('browser entry exports KVStoreErrors matching the mock', async () => {
		const browser = await import('./index.browser.js');
		assert.deepEqual(browser.KVStoreErrors, KVStoreErrors);
	});
});

// ── Item layout ─────────────────────────────────────────────────────────────

describe('AWS put writes the flat item layout', () => {
	test('a string value goes in _bkv_value under _bkv_pk', async () => {
		const { store, input } = awsStore('kv');
		await store.put('a', 'hello');
		assert.deepEqual(input(), { Item: { _bkv_pk: 'a', _bkv_value: 'hello' } });
	});

	test('an object value is one attribute per field, plus _bkv_pk', async () => {
		const { store, input } = awsStore('kv');
		await store.put('a', { name: 'A', n: 1 });
		assert.deepEqual(input().Item, { name: 'A', n: 1, _bkv_pk: 'a' });
	});

	test('a declared key writes the key fields into the item and nothing else of the block', async () => {
		const { store, input } = awsStore('orders', {
			schema: z.object({ userId: z.string(), orderId: z.string(), total: z.number() }),
			key: { partitionKey: 'userId', sortKey: 'orderId' },
		});
		await store.put({ userId: 'alice', orderId: '001' }, { total: 12 });
		assert.deepEqual(input().Item, { userId: 'alice', orderId: '001', total: 12 });
	});

	test('an expiry goes in _bkv_ttl, or in the ttl field when one is named', async () => {
		const { store, input } = awsStore('kv');
		await store.put('a', 'x', { expiresAt: 1800000000 });
		assert.equal(input().Item._bkv_ttl, 1800000000);
		const named = awsStore('sessions', {
			schema: z.object({ id: z.string(), expiresAt: z.number() }),
			key: { partitionKey: 'id' },
			ttl: 'expiresAt',
		});
		await named.store.put({ id: 's' }, { expiresAt: 1800000000 });
		assert.deepEqual(named.input().Item, { id: 's', expiresAt: 1800000000 });
		await named.store.put({ id: 's' }, { expiresAt: 1 }, { expiresAt: 1800000005 });
		assert.deepEqual(named.input(1).Item, { id: 's', expiresAt: 1800000005 });
		// The expiry of the call is in the value before the schema validates it.
		await named.store.put({ id: 's' }, {}, { expiresAt: 1800000009 });
		assert.deepEqual(named.input(2).Item, { id: 's', expiresAt: 1800000009 });
	});

	test('both runtimes reject a reserved field, a field name that DynamoDB cannot store, an empty key field, an empty indexed field, and a disagreeing key', async () => {
		const options = {
			schema: z.object({ pk: z.string(), email: z.string(), note: z.string().optional() }),
			key: { partitionKey: 'pk' },
			indexes: { byEmail: { partitionKey: 'email' } },
		};
		const mock = mockStore('t', options);
		const { store: aws, sent } = awsStore('t', options);
		for (const s of [mock, aws]) {
			await rejects(s.put({ pk: 'a' }, { email: 'e', _bkv_x: 1 }), KVStoreErrors.ValidationFailed);
			for (const json of [
				'{"email":"e","__proto__":{"x":1}}',
				'{"email":"e","extra":[{"deep":{"__proto__":1}}]}',
			]) {
				const e = await rejects(s.put({ pk: 'a' }, JSON.parse(json)), KVStoreErrors.ValidationFailed);
				assert.match(e.message, /a field named '__proto__'/);
			}
			await rejects(s.put({ pk: '' }, { email: 'e' }), KVStoreErrors.ValidationFailed);
			await rejects(s.put({ pk: 'a' }, { email: '' }), KVStoreErrors.ValidationFailed);
			await rejects(s.put({ pk: 'a' }, { pk: 'b', email: 'e' }), KVStoreErrors.ValidationFailed);
			await rejects(s.get('a'), KVStoreErrors.InvalidQuery);
			await rejects(s.get({ pk: 'a', extra: 1 }), KVStoreErrors.InvalidQuery);
		}
		assert.equal(sent.length, 0, 'every rejection happens before a DynamoDB call');
	});
});

// ── Key types ───────────────────────────────────────────────────────────────

describe('a key field has one type in both runtimes', () => {
	test('both runtimes reject a key of the other type with the same message, before any call', async () => {
		const options = {
			schema: z.object({ id: z.number().positive(), label: z.string() }),
			key: { partitionKey: 'id' },
		};
		const aws = awsStore('typed', options);
		const mock = mockStore('typed', options);
		const messages: string[] = [];
		for (const store of [aws.store, mock]) {
			messages.push((await rejects(store.get({ id: '1' }), KVStoreErrors.InvalidQuery)).message);
		}
		assert.equal(messages[0], messages[1]);
		assert.match(messages[0], /'id' must be a number \(received string\)/);
		assert.equal(aws.sent.length, 0);

		await aws.store.put({ id: 1 }, { label: 'l' });
		assert.deepEqual(aws.input().Item, { id: 1, label: 'l' });
	});
});

// ── Reads ───────────────────────────────────────────────────────────────────

describe('AWS get', () => {
	test('is strongly consistent by default and opts out with consistentRead: false', async () => {
		const { store, input } = awsStore('kv');
		await store.get('a');
		assert.deepEqual(input(), { Key: { _bkv_pk: 'a' }, ConsistentRead: true });
		await store.get('a', { consistentRead: false });
		assert.equal(input(1).ConsistentRead, false);
	});

	test('reads the value back out of the flat layout and hides an expired item', async () => {
		let item: any;
		const { store } = awsStore('kv', undefined, () => ({ Item: item }));
		item = { _bkv_pk: 'a', name: 'A', _bkv_ttl: 1800000000 };
		assert.deepEqual(await store.get('a'), { name: 'A' });
		item = { _bkv_pk: 'a', _bkv_value: 'hello' };
		assert.deepEqual(await store.get('a'), 'hello');
		item = { _bkv_pk: 'a', _bkv_value: 'hello', _bkv_ttl: 1 };
		assert.equal(await store.get('a'), null);
		item = undefined;
		assert.equal(await store.get('a'), null);
	});
});

// ── Conditions ──────────────────────────────────────────────────────────────

describe('conditional-write composition (AWS PutCommand shape)', () => {
	test('ifNotExists alone → attribute_not_exists(#pk) on _bkv_pk', async () => {
		const { store, input } = awsStore('kv');
		await store.put('a', 'x', { ifNotExists: true });
		assert.equal(input().ConditionExpression, 'attribute_not_exists(#pk)');
		assert.deepEqual(input().ExpressionAttributeNames, { '#pk': '_bkv_pk' });
		assert.equal(input().ExpressionAttributeValues, undefined);
	});

	test('ifValueEquals alone → #value = :expected on _bkv_value, with the raw value', async () => {
		const { store, input } = awsStore('kv');
		await store.put('a', 2, { ifValueEquals: 1 });
		assert.equal(input().ConditionExpression, '#value = :expected');
		assert.deepEqual(input().ExpressionAttributeNames, { '#value': '_bkv_value' });
		assert.deepEqual(input().ExpressionAttributeValues, { ':expected': 1 });
	});

	test('ifNotExists + ifValueEquals → OR', async () => {
		const { store, input } = awsStore('kv');
		await store.put('a', 'x', { ifNotExists: true, ifValueEquals: 'old' });
		assert.equal(input().ConditionExpression, 'attribute_not_exists(#pk) OR #value = :expected');
	});

	test('ifFieldEquals → one clause per field, AND inside, and OR with ifNotExists', async () => {
		const { store, input } = awsStore('kv');
		await store.put('a', { v: 2, name: 'B' }, { ifFieldEquals: { v: 1 } });
		assert.equal(input().ConditionExpression, '#field0 = :val0');
		assert.deepEqual(input().ExpressionAttributeNames, { '#field0': 'v' });
		assert.deepEqual(input().ExpressionAttributeValues, { ':val0': 1 });
		await store.put('a', { v: 3, name: 'C' }, { ifNotExists: true, ifFieldEquals: { v: 2, name: 'B' } });
		assert.equal(
			input(1).ConditionExpression,
			'attribute_not_exists(#pk) OR (#field0 = :val0 AND #field1 = :val1)',
		);
	});

	test('a declared key names its partition field in attribute_not_exists', async () => {
		const { store, input } = awsStore('jobs', {
			schema: z.object({ jobId: z.string(), state: z.string() }),
			key: { partitionKey: 'jobId' },
		});
		await store.put({ jobId: 'j' }, { state: 'q' }, { ifNotExists: true });
		assert.deepEqual(input().ExpressionAttributeNames, { '#pk': 'jobId' });
	});

	test('no conditions → no ConditionExpression; ifValueEquals: undefined is a no-op; null is a real condition', async () => {
		const { store, input } = awsStore('kv');
		await store.put('a', 'x');
		assert.equal(input().ConditionExpression, undefined);
		await store.put('a', 'x', { ifValueEquals: undefined });
		assert.equal(input(1).ConditionExpression, undefined);
		await store.put('a', 'x', { ifValueEquals: null });
		assert.deepEqual(input(2).ExpressionAttributeValues, { ':expected': null });
	});

	test('a null option is absent on AWS too: no expiry attribute, no condition, a consistent read', async () => {
		const { store, sent, input } = awsStore('kv');
		await store.put('a', 'x', { ttlSeconds: null, expiresAt: null, ifNotExists: null });
		assert.deepEqual(input(), { Item: { _bkv_pk: 'a', _bkv_value: 'x' } });
		await store.get('a', { consistentRead: null });
		assert.equal(input(1).ConsistentRead, true);
		await store.delete('a', { ifExists: null });
		assert.equal(input(2).ConditionExpression, undefined);
		await store.putBatch([{ key: 'b', value: 'y', ttlSeconds: null, expiresAt: null }]);
		assert.deepEqual(batchOf(sent[3]).requests, [{ PutRequest: { Item: { _bkv_pk: 'b', _bkv_value: 'y' } } }]);
		// `ifFieldEquals: null` stays a call error, before any call.
		await rejects(store.put('a', { n: 1 }, { ifFieldEquals: null }), KVStoreErrors.InvalidQuery);
		assert.equal(sent.length, 4);
	});

	test('both runtimes reject ifValueEquals with an object, an empty ifFieldEquals, and both checks together', async () => {
		const mock = mockStore('kv');
		const { store: aws, sent } = awsStore('kv');
		for (const s of [mock, aws]) {
			await rejects(s.put('k', { a: 2 }, { ifValueEquals: { a: 1 } }), KVStoreErrors.InvalidQuery);
			await rejects(s.put('k', { a: 2 }, { ifFieldEquals: {} }), KVStoreErrors.InvalidQuery);
			await rejects(s.put('k', { a: 2 }, { ifFieldEquals: { a: undefined } }), KVStoreErrors.InvalidQuery);
			await rejects(
				s.put('k', { a: 2 }, { ifFieldEquals: { a: 1 }, ifValueEquals: 1 }),
				KVStoreErrors.InvalidQuery,
			);
			await rejects(s.delete('k', { ifFieldEquals: {} }), KVStoreErrors.InvalidQuery);
		}
		assert.equal(sent.length, 0);
	});

	test('a rejected conditional write maps to a 409 ApiError with the same retriable flag as the mock', async () => {
		const { store } = awsStore('kv', undefined, () => ddbError('ConditionalCheckFailedException'));
		const mock = new KVStore(testScope(), 'kv');
		await mock.put('a', 'x');
		const cases: [any, boolean][] = [
			[{ ifNotExists: true }, false],
			[{ ifValueEquals: 'stale' }, true],
			[{ ifNotExists: true, ifValueEquals: 'stale' }, true],
		];
		for (const [options, retriable] of cases) {
			for (const s of [store, mock]) {
				try {
					await s.put('a', 'y', options);
					assert.fail('expected a conflict');
				} catch (e) {
					assert.ok(e instanceof ApiError);
					assert.equal(e.status, 409);
					assert.equal(e.name, KVStoreErrors.ConditionalCheckFailed);
					assert.equal(e.retriable, retriable, `${JSON.stringify(options)} retriable`);
				}
			}
		}
	});
});

describe('conditional-delete composition (AWS DeleteCommand shape)', () => {
	test('ifExists + ifValueEquals compose with AND; a conflict carries the retriable flag the mock derives', async () => {
		const { store, input } = awsStore('kv', undefined, (c) =>
			c.input.ConditionExpression ? ddbError('ConditionalCheckFailedException') : {},
		);
		await store.delete('a');
		assert.equal(input().ConditionExpression, undefined);
		assert.deepEqual(input().Key, { _bkv_pk: 'a' });
		const cases: [any, boolean][] = [
			[{ ifExists: true }, false],
			[{ ifValueEquals: 'stale' }, true],
			[{ ifExists: true, ifValueEquals: 'stale' }, false],
		];
		for (const [options, retriable] of cases) {
			const e = (await rejects(store.delete('a', options), KVStoreErrors.ConditionalCheckFailed)) as ApiError;
			assert.equal(e.status, 409);
			assert.equal(e.retriable, retriable, `aws ${JSON.stringify(options)}`);
		}
	});

	test('the delete expressions', async () => {
		const { store, sent } = awsStore('kv');
		await store.delete('a', { ifExists: true });
		await store.delete('a', { ifValueEquals: 'v' });
		await store.delete('a', { ifExists: true, ifValueEquals: 'v' });
		assert.deepEqual(
			sent.map((c) => c.input.ConditionExpression),
			['attribute_exists(#pk)', '#value = :expected', 'attribute_exists(#pk) AND #value = :expected'],
		);
	});
});

// ── Query and scan ──────────────────────────────────────────────────────────

describe('AWS query', () => {
	const options = {
		schema: z.object({ pk: z.string(), sk: z.number(), n: z.string() }),
		key: { partitionKey: 'pk', sortKey: 'sk' },
		indexes: { byN: { partitionKey: 'n', sortKey: 'sk' } },
	};

	test('builds the KeyConditionExpression, index, order and limit', async () => {
		const { store, input } = awsStore('t', options, () => ({ Items: [] }));
		await Array.fromAsync(
			store.query({
				index: 'byN',
				where: { n: { equals: 'x' }, sk: { between: [1, 5] } },
				order: 'desc',
				limit: 10,
			}),
		);
		assert.deepEqual(input(), {
			IndexName: 'byN',
			KeyConditionExpression: '#pk = :pkval AND #sk BETWEEN :skval1 AND :skval2',
			ExpressionAttributeNames: { '#pk': 'n', '#sk': 'sk' },
			ExpressionAttributeValues: { ':pkval': 'x', ':skval1': 1, ':skval2': 5 },
			ExclusiveStartKey: undefined,
			Limit: 10,
			ScanIndexForward: false,
		});
	});

	test('an empty sort condition issues a partition-only expression with no #sk', async () => {
		const { store, input } = awsStore('t', options, () => ({ Items: [] }));
		await Array.fromAsync(store.query({ where: { pk: { equals: 'p' }, sk: {} } }));
		assert.equal(input().KeyConditionExpression, '#pk = :pkval');
		assert.deepEqual(input().ExpressionAttributeNames, { '#pk': 'pk' });
	});

	test('two sort conditions, a bad where and an unknown index are rejected before any call', async () => {
		const { store: s, sent } = awsStore('t', options);
		await rejects(
			() => s.query({ where: { pk: { equals: 'p' }, sk: { greaterThan: 1, lessThan: 2 } } }),
			KVStoreErrors.InvalidQuery,
		);
		await rejects(() => s.query({ where: { pk: 'p' } }), KVStoreErrors.InvalidQuery);
		await rejects(() => s.query({ index: 'nope', where: { pk: { equals: 'p' } } }), KVStoreErrors.InvalidQuery);
		assert.equal(sent.length, 0);
	});

	test('follows LastEvaluatedKey, hides expired items, and yields the entry shape', async () => {
		const pages = [
			{
				Items: [
					{ pk: 'p', sk: 1, n: 'a', _bkv_ttl: 1 },
					{ pk: 'p', sk: 2, n: 'b' },
				],
				LastEvaluatedKey: { pk: 'p', sk: 2 },
			},
			{ Items: [{ pk: 'p', sk: 3, n: 'c', _bkv_ttl: 1800000000 }] },
		];
		const { store, sent } = awsStore('t', options, () => pages.shift());
		const results = store.query({ where: { pk: { equals: 'p' } } });
		assert.deepEqual(await Array.fromAsync(results), [
			{ key: { pk: 'p', sk: 2 }, value: { pk: 'p', sk: 2, n: 'b' } },
			{ key: { pk: 'p', sk: 3 }, value: { pk: 'p', sk: 3, n: 'c' }, expiresAt: 1800000000 },
		]);
		assert.equal(sent[1].input.ExclusiveStartKey.sk, 2);
		assert.equal(results.cursor, undefined);
	});

	test('stops at limit with a cursor for the last entry, and a cursor becomes ExclusiveStartKey', async () => {
		// Every page says more may follow; the loop must stop at `limit`, not at the end of the data.
		const { store, input } = awsStore('t', options, (c) =>
			c.input.ExclusiveStartKey
				? { Items: [] }
				: {
						Items: [
							{ pk: 'p', sk: 1, n: 'a' },
							{ pk: 'p', sk: 2, n: 'b' },
							{ pk: 'p', sk: 3, n: 'c' },
						],
						LastEvaluatedKey: { pk: 'p', sk: 3 },
					},
		);
		const first = store.query({ where: { pk: { equals: 'p' } }, limit: 2 });
		assert.equal((await Array.fromAsync(first)).length, 2);
		assert.equal(input().Limit, 2);
		assert.deepEqual(JSON.parse(Buffer.from(first.cursor, 'base64url').toString()), {
			v: 1,
			index: null,
			key: { pk: 'p', sk: 2 },
		});
		await Array.fromAsync(store.query({ where: { pk: { equals: 'p' } }, cursor: first.cursor }));
		assert.deepEqual(input(1).ExclusiveStartKey, { pk: 'p', sk: 2 });
		// An index cursor carries the index key and the table key.
		const indexed = store.query({ index: 'byN', where: { n: { equals: 'a' } }, limit: 1 });
		await Array.fromAsync(indexed);
		assert.deepEqual(JSON.parse(Buffer.from(indexed.cursor, 'base64url').toString()).key, {
			pk: 'p',
			sk: 1,
			n: 'a',
		});
	});

	test('the mock and AWS produce the same cursor for the same item', async () => {
		const mock = mockStore('t', options);
		await mock.put({ pk: 'p', sk: 1 }, { n: 'a' });
		const m = mock.query({ where: { pk: { equals: 'p' } }, limit: 1 });
		await Array.fromAsync(m);
		const { store } = awsStore('t', options, () => ({
			Items: [{ pk: 'p', sk: 1, n: 'a' }],
			LastEvaluatedKey: { pk: 'p', sk: 1 },
		}));
		const a = store.query({ where: { pk: { equals: 'p' } }, limit: 1 });
		await Array.fromAsync(a);
		assert.equal(a.cursor, m.cursor);
	});

	test('both runtimes reject a partition value, a sort operand and a cursor key value that fail the key check, with the same error', async () => {
		const mock = mockStore('t', options);
		const { store: aws, sent } = awsStore('t', options);
		const badCursor = Buffer.from(JSON.stringify({ v: 1, index: null, key: { pk: 'p', sk: '1' } })).toString(
			'base64url',
		);
		const pk = { equals: 'p' };
		const calls: Array<[object, string]> = [
			[{ where: { pk: { equals: 1 } } }, KVStoreErrors.InvalidQuery],
			[{ where: { pk: { equals: '' } } }, KVStoreErrors.ValidationFailed],
			[{ where: { pk, sk: { greaterThan: '1' } } }, KVStoreErrors.InvalidQuery],
			[{ where: { pk, sk: { between: [1] } } }, KVStoreErrors.InvalidQuery],
			[{ where: { pk, sk: { beginsWith: '1' } } }, KVStoreErrors.InvalidQuery],
			[{ where: { pk, sk: { like: 1 } } }, KVStoreErrors.InvalidQuery],
			[{ where: { pk, sk: 1 } }, KVStoreErrors.InvalidQuery],
			[{ index: 'byN', where: { n: { equals: 5 } } }, KVStoreErrors.InvalidQuery],
			[{ where: { pk }, cursor: badCursor }, KVStoreErrors.InvalidQuery],
		];
		for (const [call, name] of calls) {
			const fromMock = await rejects(() => mock.query(call), name);
			const fromAws = await rejects(() => aws.query(call), name);
			assert.equal(fromAws.message, fromMock.message);
		}
		assert.equal(sent.length, 0, 'every rejection happens before a DynamoDB call');
	});

	test('both runtimes reject a cursor of another partition or index with the same name', async () => {
		const mock = mockStore('t', options);
		const { store: aws } = awsStore('t', options);
		const foreign = Buffer.from(JSON.stringify({ v: 1, index: null, key: { pk: 'other', sk: 1 } })).toString(
			'base64url',
		);
		for (const s of [mock, aws]) {
			await rejects(
				() => s.query({ where: { pk: { equals: 'p' } }, cursor: foreign }),
				KVStoreErrors.InvalidQuery,
			);
			await rejects(
				() => s.query({ index: 'byN', where: { n: { equals: 'x' } }, cursor: foreign }),
				KVStoreErrors.InvalidQuery,
			);
			await rejects(() => s.scan({ cursor: 'garbage' }), KVStoreErrors.InvalidQuery);
		}
	});
});

describe('AWS scan', () => {
	test('a null cursor and limit send no ExclusiveStartKey and no Limit; a bad limit is rejected before any call', async () => {
		const { store, sent, input } = awsStore('kv', undefined, () => ({ Items: [] }));
		await Array.fromAsync(store.scan({ limit: null, cursor: null }));
		assert.equal(input().Limit, undefined);
		assert.equal(input().ExclusiveStartKey, undefined);
		await rejects(() => store.scan({ limit: 0 }), KVStoreErrors.InvalidQuery);
		await rejects(() => store.query({ index: 'nope', where: {}, limit: 0 }), KVStoreErrors.InvalidQuery);
		assert.equal(sent.length, 1);
	});

	test('passes Limit, follows LastEvaluatedKey, filters expired unless includeExpired', async () => {
		const page = {
			Items: [
				{ _bkv_pk: 'a', _bkv_value: 1, _bkv_ttl: 1 },
				{ _bkv_pk: 'b', _bkv_value: 2 },
			],
		};
		const { store, input } = awsStore('kv', undefined, () => page);
		assert.deepEqual(await Array.fromAsync(store.scan({ limit: 5 })), [{ key: 'b', value: 2 }]);
		assert.equal(input().Limit, 5);
		assert.deepEqual(
			(await Array.fromAsync(store.scan({ includeExpired: true }))).map((e: any) => e.key),
			['a', 'b'],
		);
	});
});

// ── Batches ─────────────────────────────────────────────────────────────────

describe('AWS batch calls retry unprocessed entries', () => {
	const options = { schema: z.object({ id: z.string(), value: z.number() }), key: { partitionKey: 'id' } };

	test('getBatch resubmits only the unprocessed keys, merges results, and hides expired items', async () => {
		let attempt = 0;
		const { store, sent } = awsStore('t', options, (c) => {
			attempt++;
			const { table, requests } = batchOf(c);
			if (attempt === 1) {
				return {
					Responses: { [table]: [{ id: 'a', value: 1 }] },
					UnprocessedKeys: { [table]: { Keys: requests.Keys.slice(1) } },
				};
			}
			return {
				Responses: {
					[table]: [
						{ id: 'b', value: 2 },
						{ id: 'c', value: 3, _bkv_ttl: 1 },
					],
				},
			};
		});
		store.backoff = async () => {};
		const got = await store.getBatch([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
		assert.deepEqual(got, [{ id: 'a', value: 1 }, { id: 'b', value: 2 }, null, null]);
		assert.equal(sent.length, 2);
		assert.deepEqual(batchOf(sent[1]).requests.Keys, [{ id: 'b' }, { id: 'c' }, { id: 'd' }]);
	});

	test('getBatch throws BatchIncomplete when keys never resolve', async () => {
		const { store } = awsStore('t', options, (c) => {
			const { table, requests } = batchOf(c);
			return { UnprocessedKeys: { [table]: { Keys: requests.Keys } } };
		});
		store.backoff = async () => {};
		await rejects(store.getBatch([{ id: 'a' }]), KVStoreErrors.BatchIncomplete);
	});

	test('putBatch writes flat items and resubmits only the unprocessed requests', async () => {
		let attempt = 0;
		const { store, sent } = awsStore('t', options, (c) => {
			attempt++;
			const { table, requests } = batchOf(c);
			return attempt === 1 ? { UnprocessedItems: { [table]: requests.slice(1) } } : {};
		});
		store.backoff = async () => {};
		await store.putBatch([
			{ key: { id: 'a' }, value: { value: 1 } },
			{ key: { id: 'b' }, value: { value: 2 }, expiresAt: 1800000000 },
		]);
		assert.deepEqual(batchOf(sent[0]).requests, [
			{ PutRequest: { Item: { id: 'a', value: 1 } } },
			{ PutRequest: { Item: { id: 'b', value: 2, _bkv_ttl: 1800000000 } } },
		]);
		assert.deepEqual(batchOf(sent[1]).requests, [
			{ PutRequest: { Item: { id: 'b', value: 2, _bkv_ttl: 1800000000 } } },
		]);
	});

	test('deleteBatch resubmits only the unprocessed deletes and throws when they never complete', async () => {
		let attempt = 0;
		const { store, sent } = awsStore('t', options, (c) => {
			attempt++;
			const { table, requests } = batchOf(c);
			return attempt === 1 ? { UnprocessedItems: { [table]: requests.slice(1) } } : {};
		});
		store.backoff = async () => {};
		await store.deleteBatch([{ id: 'a' }, { id: 'b' }]);
		assert.deepEqual(batchOf(sent[1]).requests, [{ DeleteRequest: { Key: { id: 'b' } } }]);
		const stuck = awsStore('t', options, (c) => {
			const { table, requests } = batchOf(c);
			return { UnprocessedItems: { [table]: requests } };
		});
		stuck.store.backoff = async () => {};
		await rejects(stuck.store.deleteBatch([{ id: 'a' }]), KVStoreErrors.BatchIncomplete);
	});
});

// ── Errors ──────────────────────────────────────────────────────────────────

describe('the 400 KB overflow is a distinct ItemTooLarge error', () => {
	test("AWS: put re-maps DynamoDB's oversized ValidationException to ItemTooLarge; an unrelated one passes through", async () => {
		const big = awsStore('kv', undefined, () =>
			ddbError('ValidationException', 'Item size has exceeded the maximum allowed size'),
		);
		const e = await rejects(big.store.put('a', 'x'), KVStoreErrors.ItemTooLarge);
		assert.match(e.message, /400 KB/);
		const other = awsStore('kv', undefined, () => ddbError('ValidationException', 'Something else'));
		try {
			await other.store.put('a', 'x');
			assert.fail('expected a throw');
		} catch (err) {
			assert.equal((err as Error).name, 'ValidationException');
		}
	});

	test('mock: put rejects an oversized item with ItemTooLarge', async () => {
		const mock = new KVStore(testScope(), 'kv');
		await rejects(mock.put('a', 'x'.repeat(400 * 1024 + 1)), KVStoreErrors.ItemTooLarge);
	});
});

describe('readValidation behaves identically on the mock and the AWS runtime', () => {
	const v2 = z.object({ id: z.string(), total: z.number(), currency: z.string().default('USD') });
	const legacy = { id: 'o1', total: 10, extra: 'kept' };

	test("'coerce' fills the default and keeps unknown keys on both", async () => {
		const { store } = awsStore('t', { schema: v2, key: { partitionKey: 'id' } }, () => ({ Item: { ...legacy } }));
		assert.deepEqual(await store.get({ id: 'o1' }), { id: 'o1', total: 10, extra: 'kept', currency: 'USD' });
		const scope = testScope();
		await new KVStore<any>(scope, 't').put('o1', legacy);
		assert.deepEqual(await new KVStore(scope, 't', { schema: v2 }).get('o1'), { ...legacy, currency: 'USD' });
	});

	test("'off' returns the raw row; 'strict' throws on both", async () => {
		const off = awsStore('t', { schema: v2, key: { partitionKey: 'id' }, readValidation: 'off' }, () => ({
			Item: { ...legacy },
		}));
		assert.deepEqual(await off.store.get({ id: 'o1' }), legacy);
		const strict = awsStore('t', { schema: v2, key: { partitionKey: 'id' }, readValidation: 'strict' }, () => ({
			Item: { id: 'o1', total: 'x' },
		}));
		await rejects(strict.store.get({ id: 'o1' }), KVStoreErrors.ValidationFailed);
	});
});

// A bad `order`, an unknown index, a bad `indexes` option, a batch with one bad
// key, and the message of a failed condition. Each fails the same way in both
// runtimes, and the AWS runtime fails before it calls DynamoDB.

describe('a bad order, an unknown index and a bad indexes option fail the same way in both runtimes', () => {
	const schema = z.object({ handle: z.string(), postId: z.string(), status: z.string().optional() });
	const options = {
		schema,
		key: { partitionKey: 'handle', sortKey: 'postId' },
		indexes: { byStatus: { partitionKey: 'status', sortKey: 'postId' } },
	};
	const where = { handle: { equals: 'a' } };

	/** Run `call` on a mock store and on an AWS store. Both reject with the same InvalidQuery message, and DynamoDB gets no call. */
	async function rejectsOnBoth(id: string, storeOptions: any, call: (store: any) => unknown): Promise<string> {
		const aws = awsStore(id, storeOptions);
		const messages: string[] = [];
		for (const store of [mockStore(id, storeOptions), aws.store]) {
			messages.push((await rejects(() => call(store), KVStoreErrors.InvalidQuery)).message);
		}
		assert.equal(messages[0], messages[1]);
		assert.equal(aws.sent.length, 0);
		return messages[0];
	}

	test("query() rejects an order other than 'asc' and 'desc'", async () => {
		assert.match(
			await rejectsOnBoth('order-text', options, (store) =>
				Array.fromAsync(store.query({ where, order: 'DESC' })),
			),
			/query\(\) order must be 'asc' or 'desc' \(received 'DESC'\)$/,
		);
		assert.match(
			await rejectsOnBoth('order-number', options, (store) => Array.fromAsync(store.query({ where, order: -1 }))),
			/\(received number\)$/,
		);
	});

	test('an order of null or undefined reads ascending, and desc reads descending', async () => {
		const mock = mockStore('order-ok', options);
		await mock.put({ handle: 'a', postId: 'p1' }, {});
		await mock.put({ handle: 'a', postId: 'p2' }, {});
		const postIds = async (order: unknown) =>
			(await Array.fromAsync(mock.query({ where, order }))).map((entry: any) => entry.key.postId);
		assert.deepEqual(await postIds(null), ['p1', 'p2']);
		assert.deepEqual(await postIds(undefined), ['p1', 'p2']);
		assert.deepEqual(await postIds('desc'), ['p2', 'p1']);

		const { store, input } = awsStore('order-ok', options, () => ({ Items: [] }));
		await Array.fromAsync(store.query({ where, order: null }));
		await Array.fromAsync(store.query({ where, order: 'desc' }));
		assert.notEqual(input(0).ScanIndexForward, false);
		assert.equal(input(1).ScanIndexForward, false);
	});

	test('query() on an unknown index lists the declared indexes', async () => {
		const call = (store: any) =>
			Array.fromAsync(store.query({ index: 'byStats', where: { status: { equals: 'open' } } }));
		assert.match(
			await rejectsOnBoth('index-list', options, call),
			/Index 'byStats' not found; declared indexes: 'byStatus'$/,
		);
		const { indexes: _indexes, ...noIndexes } = options;
		assert.match(
			await rejectsOnBoth('index-none', noIndexes, call),
			/Index 'byStats' not found; declared indexes: none$/,
		);
	});

	test('the constructor rejects indexes given as an array, and takes null as no indexes', async () => {
		const arrayIndexes = { ...options, indexes: [{ partitionKey: 'status', sortKey: 'postId' }] };
		const messages: string[] = [];
		for (const build of [
			() => mockStore('indexes-array', arrayIndexes),
			() => awsStore('indexes-array', arrayIndexes),
		]) {
			messages.push((await rejects(build, KVStoreErrors.InvalidQuery)).message);
		}
		assert.equal(messages[0], messages[1]);
		assert.match(messages[0], /indexes must be an object keyed by index name, .*\(received an array\)$/);

		mockStore('indexes-null', { ...options, indexes: null });
		awsStore('indexes-null', { ...options, indexes: null });
	});

	test('a deleteBatch() with one bad key deletes nothing', async () => {
		const keys = [{ handle: 'a', postId: 'p1' }, 'b'];
		const mock = mockStore('batch-one-bad-key', options);
		await mock.put({ handle: 'a', postId: 'p1' }, {});
		await rejects(mock.deleteBatch(keys), KVStoreErrors.InvalidQuery);
		assert.notEqual(await mock.get({ handle: 'a', postId: 'p1' }), null);

		const aws = awsStore('batch-one-bad-key', options);
		await rejects(aws.store.deleteBatch(keys), KVStoreErrors.InvalidQuery);
		assert.equal(aws.sent.length, 0);
	});

	test('a failed condition has the same message in both runtimes, and the message names the error', async () => {
		const mock = mockStore('conflict-message');
		await mock.put('k', 'v');
		const aws = awsStore('conflict-message', undefined, () =>
			ddbError('ConditionalCheckFailedException', 'The conditional request failed'),
		);
		for (const store of [mock, aws.store]) {
			const error = await rejects(
				store.put('k', 'v2', { ifNotExists: true }),
				KVStoreErrors.ConditionalCheckFailed,
			);
			assert.equal(error.message, 'ConditionalCheckFailedException: The conditional request failed');
		}
	});
});

describe('the mock stores and returns copies that went through the DocumentClient marshaller', () => {
	const options = { key: { partitionKey: 'pk', sortKey: 'sk' } };
	const key = { pk: 'a', sk: '1' };

	test('changing a value after put() does not change the stored item', async () => {
		const store = mockStore('copy-put', options);
		const value = { ...key, tags: ['x'] };
		await store.put(key, value);
		value.tags.push('changed-after-put');
		assert.deepEqual((await store.get(key)).tags, ['x']);
	});

	test('changing an item returned by get(), getBatch(), query() or scan() does not change the stored item', async () => {
		const store = mockStore('copy-read', options);
		await store.put(key, { ...key, tags: ['x'] });
		(await store.get(key)).tags.push('1');
		(await store.getBatch([key]))[0].tags.push('2');
		const [queried]: any[] = await Array.fromAsync(store.query({ where: { pk: { equals: 'a' } } }));
		queried.value.tags.push('3');
		const [scanned]: any[] = await Array.fromAsync(store.scan());
		scanned.value.tags.push('4');
		assert.deepEqual((await store.get(key)).tags, ['x']);
	});

	test('putBatch() stores a copy too', async () => {
		const store = mockStore('copy-batch', options);
		const value = { ...key, tags: ['x'] };
		await store.putBatch([{ key, value }]);
		value.tags.push('changed-after-put');
		assert.deepEqual((await store.get(key)).tags, ['x']);
	});

	test('values the marshaller rejects fail on put() and putBatch(), and nothing is written', async () => {
		const store = mockStore('reject', options);
		class Point {
			x = 1;
		}
		const rejected: unknown[] = [
			new Set(),
			new Date(0),
			Number.NaN,
			Number.POSITIVE_INFINITY,
			new Point(),
			/re/,
			Number.MAX_SAFE_INTEGER + 1,
		];
		for (const data of rejected) {
			await assert.rejects(store.put(key, { ...key, data }), `put ${String(data)}`);
			await assert.rejects(store.putBatch([{ key, value: { ...key, data } }]), `putBatch ${String(data)}`);
		}
		assert.equal(await store.get(key), null);
	});

	test('undefined is dropped at any depth, as by the AWS client', async () => {
		const store = mockStore('undefined', options);
		await store.put(key, { ...key, data: { a: undefined, b: 1 }, list: [1, undefined, 2] });
		assert.deepEqual(await store.get(key), { ...key, data: { b: 1 }, list: [1, 2] });
	});

	test('a rejected put() leaves the existing item unchanged', async () => {
		const store = mockStore('reject-keeps', options);
		await store.put(key, { ...key, tags: ['x'] });
		await assert.rejects(store.put(key, { ...key, data: new Set() }));
		assert.deepEqual((await store.get(key)).tags, ['x']);
	});

	test('values the marshaller converts read back converted: Map as an object, -0 as 0, bigint as a number', async () => {
		const store = mockStore('converted', options);
		await store.put(key, { ...key, data: { m: new Map([['a', 1]]), z: -0, n: 1n } });
		const back = (await store.get(key)).data;
		assert.deepEqual(back, { m: { a: 1 }, z: 0, n: 1 });
		assert.ok(Object.is(back.z, 0));
	});

	test('a non-empty Set reads back as a Set, as on AWS', async () => {
		const store = mockStore('set', options);
		await store.put(key, { ...key, data: new Set(['a', 'b']) });
		assert.deepEqual((await store.get(key)).data, new Set(['a', 'b']));
	});

	test('the 400 KB check counts the elements of a Set', async () => {
		const store = mockStore('set-size', options);
		const big = new Set(Array.from({ length: 50 }, (_, i) => `${i}`.padEnd(10_000, 'x')));
		await assert.rejects(store.put(key, { ...key, data: big }), (e: unknown) =>
			isBlocksError(e, KVStoreErrors.ItemTooLarge),
		);
	});

	test('a plain string value still round-trips', async () => {
		const store = mockStore('string');
		await store.put('k', 'v');
		assert.equal(await store.get('k'), 'v');
	});
});

describe('inputs DynamoDB rejects fail the same way on the mock and the AWS runtime, before any request', () => {
	const options = {
		key: { partitionKey: 'pk', sortKey: 'sk' },
		indexes: { byTag: { partitionKey: 'tag', sortKey: 'at' } },
	};
	const key = (pk: string, sk = 's') => ({ pk, sk });

	async function failsOnBoth(id: string, name: string, call: (store: any) => unknown): Promise<string> {
		const aws = awsStore(id, options);
		const messages: string[] = [];
		for (const store of [mockStore(id, options), aws.store]) {
			messages.push((await rejects(() => call(store), name)).message);
		}
		assert.equal(messages[0], messages[1], 'mock and AWS must produce the same message');
		assert.equal(aws.sent.length, 0, 'the AWS runtime must reject before calling DynamoDB');
		return messages[0];
	}

	function nestedMaps(levels: number): unknown {
		let value: unknown = 'leaf';
		for (let i = 0; i < levels; i++) value = { n: value };
		return value;
	}

	/** `levels` lists, each holding the next; the innermost is empty. */
	function nestedLists(levels: number): unknown {
		let value: unknown = [];
		for (let i = 1; i < levels; i++) value = [value];
		return value;
	}

	test('putBatch() with two entries sharing a key in one request is rejected and writes nothing', async () => {
		const entries = [
			{ key: key('a'), value: { n: 1 } },
			{ key: key('b'), value: {} },
			{ key: key('a'), value: { n: 2 } },
		];
		assert.match(
			await failsOnBoth('dup-put', KVStoreErrors.InvalidQuery, (store) => store.putBatch(entries)),
			/putBatch was given the same key at index 0 and index 2, which fall in the same DynamoDB request; DynamoDB rejects a request that repeats a key$/,
		);
		const store = mockStore('dup-put-nothing', options);
		await assert.rejects(store.putBatch(entries));
		assert.deepEqual(await Array.fromAsync(store.scan()), []);
	});

	test('getBatch() and deleteBatch() with the same key twice are rejected', async () => {
		assert.match(
			await failsOnBoth('dup-get', KVStoreErrors.InvalidQuery, (store) => store.getBatch([key('a'), key('a')])),
			/getBatch was given the same key at index 0 and index 1/,
		);
		assert.match(
			await failsOnBoth('dup-delete', KVStoreErrors.InvalidQuery, (store) =>
				store.deleteBatch([key('a'), key('a')]),
			),
			/deleteBatch was given the same key at index 0 and index 1/,
		);
	});

	test('keys that differ only in the sort key are not duplicates', async () => {
		const store = mockStore('dup-distinct', options);
		await store.putBatch([
			{ key: key('a', 's1'), value: {} },
			{ key: key('a', 's2'), value: {} },
		]);
		assert.equal((await store.getBatch([key('a', 's1'), key('a', 's2')])).length, 2);
	});

	test('a key repeated in a later DynamoDB request is allowed, and the later write wins', async () => {
		// putBatch() sends 25 writes per request and getBatch() 100 keys. DynamoDB
		// rejects a repeat only within one request.
		const writes = Array.from({ length: 30 }, (_, i) => ({ key: key(`k${i}`), value: { n: i } }));
		writes[26] = { key: key('k0'), value: { n: 26 } };
		const reads = Array.from({ length: 101 }, (_, i) => key(`k${i}`));
		reads[100] = key('k0');

		const aws = awsStore('dup-next-request', options);
		await aws.store.putBatch(writes);
		await aws.store.getBatch(reads);
		await aws.store.deleteBatch(writes.map((w) => w.key));
		assert.equal(aws.sent.length, 2 + 2 + 2, 'two requests per batch call');

		const store = mockStore('dup-next-request', options);
		await store.putBatch(writes);
		assert.equal((await store.get(key('k0'))).n, 26);
		assert.equal((await store.getBatch(reads)).length, 101);

		const sameRequest = writes.map((w, i) => (i === 27 ? writes[26] : w));
		assert.match(
			await failsOnBoth('dup-same-later-request', KVStoreErrors.InvalidQuery, (s) => s.putBatch(sameRequest)),
			/same key at index 26 and index 27, which fall in the same DynamoDB request/,
		);
	});

	test('a sort key over 1,024 bytes or a partition key over 2,048 bytes is rejected, counted in UTF-8 bytes', async () => {
		assert.match(
			await failsOnBoth('long-sk', KVStoreErrors.ValidationFailed, (store) =>
				store.put(key('a', 's'.repeat(1025)), {}),
			),
			/key field 'sk' is 1025 bytes; DynamoDB allows at most 1024 bytes$/,
		);
		assert.match(
			await failsOnBoth('long-sk-utf8', KVStoreErrors.ValidationFailed, (store) =>
				store.put(key('a', 'é'.repeat(513)), {}),
			),
			/key field 'sk' is 1026 bytes/,
		);
		assert.match(
			await failsOnBoth('long-pk', KVStoreErrors.ValidationFailed, (store) => store.get(key('p'.repeat(2049)))),
			/key field 'pk' is 2049 bytes; DynamoDB allows at most 2048 bytes$/,
		);
		assert.match(
			await failsOnBoth('long-query-sk', KVStoreErrors.ValidationFailed, (store) =>
				Array.fromAsync(store.query({ where: { pk: { equals: 'a' }, sk: { greaterThan: 's'.repeat(1025) } } })),
			),
			/key field 'sk' is 1025 bytes/,
		);

		const store = mockStore('long-at-limit', options);
		await store.put(key('p'.repeat(2048), 's'.repeat(1024)), {});
		const strings = mockStore('long-string-store');
		await strings.put('p'.repeat(2048), 'v');
		await assert.rejects(strings.put('p'.repeat(2049), 'v'), (e: unknown) =>
			isBlocksError(e, KVStoreErrors.ValidationFailed),
		);
	});

	test('an indexed field over its key size limit is rejected; a missing indexed field is allowed', async () => {
		assert.match(
			await failsOnBoth('long-index-pk', KVStoreErrors.ValidationFailed, (store) =>
				store.put(key('a'), { tag: 't'.repeat(2049) }),
			),
			/indexed field 'tag' \(index 'byTag'\) is 2049 bytes; DynamoDB allows at most 2048 bytes$/,
		);
		assert.match(
			await failsOnBoth('long-index-sk', KVStoreErrors.ValidationFailed, (store) =>
				store.putBatch([{ key: key('a'), value: { tag: 't', at: 'x'.repeat(1025) } }]),
			),
			/indexed field 'at' \(index 'byTag'\) is 1025 bytes; DynamoDB allows at most 1024 bytes$/,
		);
		await mockStore('no-index-field', options).put(key('a'), {});
	});

	test('lists or maps nested 32 levels deep are rejected; 31 levels are accepted', async () => {
		assert.match(
			await failsOnBoth('nest-32', KVStoreErrors.ValidationFailed, (store) =>
				store.put(key('a'), { nested: nestedMaps(32) }),
			),
			/a value nests lists or maps more than 32 levels deep, which DynamoDB cannot store$/,
		);
		let list: unknown = [];
		for (let i = 0; i < 31; i++) list = [list];
		assert.deepEqual(list, nestedLists(32));
		await failsOnBoth('nest-32-list', KVStoreErrors.ValidationFailed, (store) => store.put(key('a'), { list }));
		// A string store keeps a non-object value in one attribute, so a list counts from there.
		await assert.rejects(mockStore('nest-32-string-store').put('k', list), (e: unknown) =>
			isBlocksError(e, KVStoreErrors.ValidationFailed),
		);
		await mockStore('nest-31-string-store').put('k', nestedLists(31));

		await mockStore('nest-31', options).put(key('a'), { nested: nestedMaps(31) });
	});

	test("a 'between' with the bounds reversed is rejected; equal bounds are allowed", async () => {
		assert.match(
			await failsOnBoth('between-reversed', KVStoreErrors.InvalidQuery, (store) =>
				Array.fromAsync(store.query({ where: { pk: { equals: 'a' }, sk: { between: ['z', 'a'] } } })),
			),
			/'between' on 'sk' takes the lower bound first; the first value is greater than the second$/,
		);
		const store = mockStore('between-equal', options);
		await store.put(key('a', 'm'), {});
		assert.equal(
			(await Array.fromAsync(store.query({ where: { pk: { equals: 'a' }, sk: { between: ['m', 'm'] } } })))
				.length,
			1,
		);
	});

	test("sort-key ranges and order follow DynamoDB's UTF-8 byte order", async () => {
		// '\uFF61' sorts after '\u{1F600}' in UTF-16 but before it in UTF-8, which is DynamoDB's order.
		const store = mockStore('utf8-order', options);
		for (const sk of ['\u{1F601}', '\uFF61', '\u{1F600}', '\uFFFD']) await store.put(key('u', sk), {});
		const sortKeys = (entries: any[]) => entries.map((e) => e.key.sk);
		assert.deepEqual(sortKeys(await Array.fromAsync(store.query({ where: { pk: { equals: 'u' } } }))), [
			'\uFF61',
			'\uFFFD',
			'\u{1F600}',
			'\u{1F601}',
		]);
		const inRange = store.query({ where: { pk: { equals: 'u' }, sk: { between: ['\uFF61', '\u{1F600}'] } } });
		assert.deepEqual(sortKeys(await Array.fromAsync(inRange)), ['\uFF61', '\uFFFD', '\u{1F600}']);
		const above = store.query({ where: { pk: { equals: 'u' }, sk: { greaterThan: '\uFFFD' } } });
		assert.deepEqual(sortKeys(await Array.fromAsync(above)), ['\u{1F600}', '\u{1F601}']);
	});
});

describe('the mock measures item size the way DynamoDB does', () => {
	const options = { key: { partitionKey: 'id' } };

	test('a list of empty lists over 400 KB by DynamoDB sizing is rejected though its JSON is about 300 KB', async () => {
		const store = mockStore('size-lists', options);
		await assert.rejects(
			store.put({ id: '1' }, { lists: Array.from({ length: 102_400 }, () => []) }),
			(e: unknown) => isBlocksError(e, KVStoreErrors.ItemTooLarge),
		);
	});

	test('an item of exactly 409,600 DynamoDB bytes is accepted, and one byte more is not', async () => {
		const store = mockStore('size-exact', options);
		// 'id' + '1' + 'blob' = 7 bytes of names and key value.
		await store.put({ id: '1' }, { blob: 'x'.repeat(409_600 - 7) });
		await assert.rejects(store.put({ id: '1' }, { blob: 'x'.repeat(409_600 - 6) }), (e: unknown) =>
			isBlocksError(e, KVStoreErrors.ItemTooLarge),
		);
	});

	test('an attribute set to undefined does not count toward the size, as the AWS client leaves it out', async () => {
		const store = mockStore('size-undefined', options);
		// 7 bytes of names and key value, plus 'meta' (4) and an empty map's overhead (3).
		await store.put({ id: '1' }, { blob: 'x'.repeat(409_600 - 7 - 7), note: undefined, meta: { tag: undefined } });
	});
});
