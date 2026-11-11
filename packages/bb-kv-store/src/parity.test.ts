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
import { ApiError, isBlocksError } from '@aws-blocks/core';
import { z } from 'zod';
import { KVStore as AwsKVStore } from './index.aws.js';
import { KVStore, KVStoreErrors } from './index.mock.js';

beforeEach(() => {
	try {
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
