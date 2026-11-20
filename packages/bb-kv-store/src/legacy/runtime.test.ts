// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `LegacyKVStore`: the local mock over the data file of a release up to 0.4.0,
 * the AWS runtime over a fake DocumentClient, and the two side by side for the
 * same inputs.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import type { ChildLogger } from '@aws-cdk-blocks/bb-logger';
import { isBlocksError } from '@aws-cdk-blocks/core';
import { LegacyKVStore as AwsLegacyKVStore } from '../index.aws.js';
import { KVStore, KVStoreErrors, LegacyKVStore } from '../index.mock.js';

beforeEach(() => {
	try {
		rmSync('.cdk-blocks/local/data', { recursive: true, force: true });
		rmSync('.bb-data', { recursive: true, force: true });
	} catch {}
});

let n = 0;
const testScope = () => ({ id: `kv-legacy-${++n}-${Date.now()}` }) as any;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const FAR = 4102444800;

/** The data file of the store `id` under `scope`, as a release up to 0.4.0 writes it. */
function releaseFile(scope: { id: string }, id: string, entries: Record<string, unknown>): string {
	const dir = join('.cdk-blocks/local/data', `${scope.id}-${id}`);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, 'store.json');
	writeFileSync(path, JSON.stringify(entries, null, 2));
	return path;
}

/** A logger that keeps what the store reports at warn level. */
function recorder(): { warnings: string[]; logger: ChildLogger } {
	const warnings: string[] = [];
	const logger: ChildLogger = {
		debug() {},
		info() {},
		error() {},
		warn(message) {
			warnings.push(message);
		},
		child: () => logger,
	};
	return { warnings, logger };
}

/** An AWS-runtime store wired to a fake doc client. Every command is recorded; `respond` gives the DynamoDB response. */
function awsStore(options?: any, respond: (command: any) => any = () => ({})) {
	const store = new AwsLegacyKVStore(testScope(), 'prefs', options as never) as any;
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
	return { store: store as AwsLegacyKVStore<any>, sent, input, tableName: store.fullId as string };
}

/** An item as a release up to 0.4.0 stores it. */
const releaseItem = (pk: string, value: unknown, ttl?: number) => ({
	pk,
	value: JSON.stringify(value),
	...(ttl === undefined ? {} : { ttl }),
});

/** A schema that takes a string value only. */
const stringSchema = {
	'~standard': {
		version: 1,
		vendor: 'test',
		validate: (value: unknown) =>
			typeof value === 'string' ? { value } : { issues: [{ message: 'the value must be a string' }] },
	},
} as const;

/** An error with the name that DynamoDB gives it. */
const ddbError = (name: string, message: string) => Object.assign(new Error(message), { name });

/** The key attributes that a cursor holds. */
const cursorKey = (cursor: string | undefined) =>
	JSON.parse(Buffer.from(cursor ?? '', 'base64url').toString('utf8')).key;

async function rejects(run: () => unknown, name: string): Promise<Error> {
	try {
		await run();
	} catch (e) {
		assert.ok(isBlocksError(e, name), `expected ${name}, got ${(e as Error).name}: ${(e as Error).message}`);
		return e as Error;
	}
	assert.fail(`expected ${name}`);
}

// ── The local mock ──────────────────────────────────────────────────────────

describe('mock: reads the data file of a release up to 0.4.0', () => {
	test('get returns each value, and null for a key that is absent or expired', async () => {
		const scope = testScope();
		releaseFile(scope, 'prefs', {
			greeting: JSON.stringify('hello'),
			profile: JSON.stringify({ name: 'Ada', tags: ['a'] }),
			count: JSON.stringify(3),
			live: { value: JSON.stringify('x'), ttl: FAR },
			dead: { value: JSON.stringify('y'), ttl: nowSeconds() - 60 },
		});
		const old = new LegacyKVStore<unknown>(scope, 'prefs', { ttl: true });
		assert.equal(await old.get('greeting'), 'hello');
		assert.deepEqual(await old.get('profile'), { name: 'Ada', tags: ['a'] });
		assert.equal(await old.get('count'), 3);
		assert.equal(await old.get('live'), 'x');
		assert.equal(await old.get('dead'), null);
		assert.equal(await old.get('missing'), null);
	});

	test('scan yields the live entries in key order, each with its expiry; includeExpired yields the rest', async () => {
		const scope = testScope();
		const expired = nowSeconds() - 60;
		releaseFile(scope, 'prefs', {
			b: JSON.stringify({ n: 2 }),
			a: { value: JSON.stringify('one'), ttl: FAR },
			dead: { value: JSON.stringify('y'), ttl: expired },
		});
		const old = new LegacyKVStore<unknown>(scope, 'prefs');
		assert.deepEqual(await Array.fromAsync(old.scan()), [
			{ key: 'a', value: 'one', expiresAt: FAR },
			{ key: 'b', value: { n: 2 } },
		]);
		assert.deepEqual(await Array.fromAsync(old.scan({ includeExpired: true })), [
			{ key: 'a', value: 'one', expiresAt: FAR },
			{ key: 'b', value: { n: 2 } },
			{ key: 'dead', value: 'y', expiresAt: expired },
		]);
	});

	test('scan reads a page at a time with limit and cursor', async () => {
		const scope = testScope();
		releaseFile(scope, 'prefs', Object.fromEntries(['e', 'a', 'c', 'b', 'd'].map((k) => [k, JSON.stringify(k)])));
		const old = new LegacyKVStore(scope, 'prefs');
		const seen: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		do {
			const page = old.scan({ limit: 2, cursor });
			seen.push(...(await Array.fromAsync(page)).map((entry) => entry.key));
			cursor = page.cursor;
			pages++;
		} while (cursor);
		assert.deepEqual(seen, ['a', 'b', 'c', 'd', 'e']);
		assert.equal(pages, 3);
	});

	test('a read does not change the data file; a delete removes the key and keeps the format of the release', async () => {
		const scope = testScope();
		const path = releaseFile(scope, 'prefs', {
			a: JSON.stringify('one'),
			b: { value: JSON.stringify('two'), ttl: FAR },
		});
		const before = readFileSync(path, 'utf8');
		const old = new LegacyKVStore(scope, 'prefs');
		await old.get('a');
		await Array.fromAsync(old.scan());
		await old.delete('missing');
		assert.equal(readFileSync(path, 'utf8'), before);

		await old.delete('a');
		assert.equal(await old.get('a'), null);
		assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { b: { value: JSON.stringify('two'), ttl: FAR } });
		// A new instance reads what the delete left.
		const again = new LegacyKVStore(scope, 'prefs');
		assert.deepEqual(await Array.fromAsync(again.scan()), [{ key: 'b', value: 'two', expiresAt: FAR }]);
	});

	test('reads the copy of the file when a KVStore of this release converted it', async () => {
		const scope = testScope();
		const path = releaseFile(scope, 'prefs', {
			a: JSON.stringify({ theme: 'dark' }),
			b: { value: JSON.stringify('two'), ttl: FAR },
		});
		const original = readFileSync(path, 'utf8');
		// The app ran once with the old line unchanged, also its `ttl: true`: the mock of KVStore wrote the file in its own format.
		new KVStore<unknown>(scope, 'prefs', { ttl: true } as never);
		assert.notEqual(readFileSync(path, 'utf8'), original);
		assert.equal(readFileSync(`${path}.bak`, 'utf8'), original);
		const old = new LegacyKVStore<unknown>(scope, 'prefs', { ttl: true });
		assert.deepEqual(await Array.fromAsync(old.scan()), [
			{ key: 'a', value: { theme: 'dark' } },
			{ key: 'b', value: 'two', expiresAt: FAR },
		]);
	});

	test('reads the copy of the file when a KVStore of this release could not convert it', async () => {
		const scope = testScope();
		const refused = { _bkv_pk: 'not a key', note: 'written by the release' };
		const path = releaseFile(scope, 'prefs', { odd: JSON.stringify(refused), b: JSON.stringify('two') });
		const { logger } = recorder();
		// The mock of KVStore sets the file aside, and starts empty.
		new KVStore<unknown>(scope, 'prefs', { logger });
		assert.throws(() => readFileSync(path, 'utf8'), /ENOENT/);
		const old = new LegacyKVStore<unknown>(scope, 'prefs');
		assert.deepEqual(await Array.fromAsync(old.scan()), [
			{ key: 'b', value: 'two' },
			{ key: 'odd', value: refused },
		]);
	});

	test('reads each entry as the release reads it, and leaves out an entry that the release leaves out', async () => {
		const scope = testScope();
		releaseFile(scope, 'prefs', {
			plain: JSON.stringify('one'),
			extra: { value: JSON.stringify('two'), ttl: FAR, note: 'a field that the release ignores' },
			textTtl: { value: JSON.stringify('three'), ttl: 'soon' },
			noValue: { ttl: FAR },
			number: 7,
		});
		const old = new LegacyKVStore<unknown>(scope, 'prefs');
		assert.deepEqual(await Array.fromAsync(old.scan()), [
			{ key: 'extra', value: 'two', expiresAt: FAR },
			{ key: 'plain', value: 'one' },
			{ key: 'textTtl', value: 'three' },
		]);
	});

	test('reads a value that a KVStore of this release does not store', async () => {
		const scope = testScope();
		const value = { _bkv_pk: 'not a key', note: 'written by the release' };
		releaseFile(scope, 'prefs', { odd: JSON.stringify(value) });
		const old = new LegacyKVStore<unknown>(scope, 'prefs');
		assert.deepEqual(await old.get('odd'), value);
	});

	test('starts empty with no data file; reports a file that is not a file of a release, and leaves it as it is', async () => {
		const scope = testScope();
		assert.deepEqual(await Array.fromAsync(new LegacyKVStore(scope, 'none').scan()), []);
		const dir = join('.cdk-blocks/local/data', `${scope.id}-broken`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'store.json'), 'not json');
		const { warnings, logger } = recorder();
		const broken = new LegacyKVStore(scope, 'broken', { logger });
		assert.deepEqual(await Array.fromAsync(broken.scan()), []);
		assert.equal(warnings.length, 1);
		assert.equal(readFileSync(join(dir, 'store.json'), 'utf8'), 'not json');
	});

	test('has get, put, scan, and delete, and no other data method', () => {
		const old: object = new LegacyKVStore(testScope(), 'prefs');
		for (const method of ['get', 'put', 'scan', 'delete']) assert.equal(method in old, true, method);
		for (const method of ['putBatch', 'deleteBatch', 'query', 'getBatch']) {
			assert.equal(method in old, false, method);
		}
	});
});

describe('mock: put writes as a release up to 0.4.0 writes', () => {
	test('a put is read back by get and by scan in key order, and the data file keeps the format of the release', async () => {
		const scope = testScope();
		const path = releaseFile(scope, 'prefs', { b: JSON.stringify('two') });
		const old = new LegacyKVStore<unknown>(scope, 'prefs');
		await old.put('c', { n: 3 });
		await old.put('a', 'one', { expiresAt: FAR });
		await old.put('b', 'two again');
		assert.deepEqual(await old.get('c'), { n: 3 });
		assert.deepEqual(await Array.fromAsync(old.scan()), [
			{ key: 'a', value: 'one', expiresAt: FAR },
			{ key: 'b', value: 'two again' },
			{ key: 'c', value: { n: 3 } },
		]);
		assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
			a: { value: JSON.stringify('one'), ttl: FAR },
			b: JSON.stringify('two again'),
			c: JSON.stringify({ n: 3 }),
		});
		// A second store over the same file reads what the first one wrote.
		assert.deepEqual(await new LegacyKVStore<unknown>(scope, 'prefs').get('a'), 'one');
	});

	test('ttlSeconds counts from now, and a put with no expiry clears the expiry', async () => {
		const old = new LegacyKVStore<string>(testScope(), 'prefs');
		await old.put('k', 'v', { ttlSeconds: 60 });
		const [entry] = await Array.fromAsync(old.scan());
		assert.ok(entry.expiresAt !== undefined);
		assert.ok(entry.expiresAt >= nowSeconds() + 59 && entry.expiresAt <= nowSeconds() + 61, `${entry.expiresAt}`);
		await old.put('k', 'v');
		assert.deepEqual(await Array.fromAsync(old.scan()), [{ key: 'k', value: 'v' }]);
	});

	test('ifNotExists and ifValueEquals compose with OR, and a failed condition is a 409', async () => {
		const old = new LegacyKVStore<unknown>(testScope(), 'prefs');
		await old.put('k', { v: 1 }, { ifNotExists: true });
		const exists: any = await rejects(
			() => old.put('k', { v: 2 }, { ifNotExists: true }),
			KVStoreErrors.ConditionalCheckFailed,
		);
		assert.deepEqual([exists.status, exists.retriable], [409, false]);
		await old.put('k', { v: 2 }, { ifValueEquals: { v: 1 } });
		const stale: any = await rejects(
			() => old.put('k', { v: 3 }, { ifValueEquals: { v: 1 } }),
			KVStoreErrors.ConditionalCheckFailed,
		);
		assert.deepEqual([stale.status, stale.retriable], [409, true]);
		// With both, the write goes ahead if the key is absent, or if its value matches.
		await old.put('k', { v: 3 }, { ifNotExists: true, ifValueEquals: { v: 2 } });
		await old.put('new', 'x', { ifNotExists: true, ifValueEquals: 'other' });
		assert.deepEqual(await old.get('k'), { v: 3 });
		assert.deepEqual(await old.get('new'), 'x');
	});

	test('a value is checked against the schema; a value with no JSON text and an item over 400 KB are rejected', async () => {
		const old: any = new LegacyKVStore(testScope(), 'prefs', { schema: stringSchema } as never);
		const bad = await rejects(() => old.put('k', 1), KVStoreErrors.ValidationFailed);
		assert.match(bad.message, /the value must be a string$/);
		await rejects(() => old.put('k', 'x'.repeat(400 * 1024)), KVStoreErrors.ItemTooLarge);
		const free: any = new LegacyKVStore(testScope(), 'free');
		await rejects(() => free.put('k', undefined), KVStoreErrors.ValidationFailed);
		assert.equal(await old.get('k'), null);
		assert.equal(await free.get('k'), null);
	});
});

describe('mock: delete takes the conditions of a release up to 0.4.0', () => {
	test('ifExists fails for a key that the store does not hold, and passes for one that it holds', async () => {
		const old = new LegacyKVStore<string>(testScope(), 'prefs');
		await old.put('k', 'v');
		const missing: any = await rejects(
			() => old.delete('other', { ifExists: true }),
			KVStoreErrors.ConditionalCheckFailed,
		);
		assert.deepEqual([missing.status, missing.retriable], [409, false]);
		await old.delete('k', { ifExists: true });
		assert.equal(await old.get('k'), null);
	});

	test('ifValueEquals compares the JSON text; with ifExists, both must hold', async () => {
		const old = new LegacyKVStore<unknown>(testScope(), 'prefs');
		await old.put('k', { v: 1 });
		const stale: any = await rejects(
			() => old.delete('k', { ifValueEquals: { v: 2 } }),
			KVStoreErrors.ConditionalCheckFailed,
		);
		assert.deepEqual([stale.status, stale.retriable], [409, true]);
		const both: any = await rejects(
			() => old.delete('k', { ifExists: true, ifValueEquals: { v: 2 } }),
			KVStoreErrors.ConditionalCheckFailed,
		);
		assert.deepEqual([both.status, both.retriable], [409, false]);
		// A value check on a key that the store does not hold fails too.
		await rejects(() => old.delete('other', { ifValueEquals: { v: 1 } }), KVStoreErrors.ConditionalCheckFailed);
		assert.deepEqual(await old.get('k'), { v: 1 });
		await old.delete('k', { ifExists: true, ifValueEquals: { v: 1 } });
		assert.equal(await old.get('k'), null);
	});
});

// ── The AWS runtime ─────────────────────────────────────────────────────────

describe('aws: reads the table of a release up to 0.4.0', () => {
	test('get reads by pk, strongly consistent by default, and parses the JSON text', async () => {
		const { store, input, sent, tableName } = awsStore(undefined, () => ({ Item: releaseItem('a', { n: 1 }) }));
		assert.deepEqual(await store.get('a'), { n: 1 });
		assert.deepEqual(input(), { Key: { pk: 'a' }, ConsistentRead: true });
		assert.equal(sent[0].input.TableName, tableName);
		await store.get('a', { consistentRead: false });
		assert.equal(input(1).ConsistentRead, false);
	});

	test('get returns null for a key that is absent or expired', async () => {
		const absent = awsStore();
		assert.equal(await absent.store.get('a'), null);
		const expired = awsStore(undefined, () => ({ Item: releaseItem('a', 'x', nowSeconds() - 60) }));
		assert.equal(await expired.store.get('a'), null);
	});

	test('scan follows LastEvaluatedKey, leaves out expired items, and reports each expiry', async () => {
		const pages = [
			{
				Items: [releaseItem('a', 'one', FAR), releaseItem('dead', 'y', nowSeconds() - 60)],
				LastEvaluatedKey: { pk: 'dead' },
			},
			{ Items: [releaseItem('b', { n: 2 })] },
		];
		const { store, input } = awsStore(undefined, () => pages.shift());
		assert.deepEqual(await Array.fromAsync(store.scan()), [
			{ key: 'a', value: 'one', expiresAt: FAR },
			{ key: 'b', value: { n: 2 } },
		]);
		assert.deepEqual(input(0), { ExclusiveStartKey: undefined, Limit: undefined });
		assert.deepEqual(input(1), { ExclusiveStartKey: { pk: 'dead' }, Limit: undefined });
	});

	test('a cursor of one page starts the next page after the last entry', async () => {
		const first = awsStore(undefined, () => ({
			Items: [releaseItem('a', '1'), releaseItem('b', '2'), releaseItem('c', '3')],
			LastEvaluatedKey: { pk: 'c' },
		}));
		const page = first.store.scan({ limit: 2 });
		assert.deepEqual(
			(await Array.fromAsync(page)).map((e) => e.key),
			['a', 'b'],
		);
		assert.equal(first.input().Limit, 2);
		const next = awsStore();
		await Array.fromAsync(next.store.scan({ limit: 2, cursor: page.cursor }));
		assert.deepEqual(next.input().ExclusiveStartKey, { pk: 'b' });
	});

	test('delete removes the key, with no condition', async () => {
		const { store, input } = awsStore();
		await store.delete('a');
		assert.deepEqual(input(), { Key: { pk: 'a' } });
	});

	test('delete sends ifExists and ifValueEquals as one condition, joined with AND, and gives a failed one as a 409', async () => {
		const { store, input } = awsStore();
		await store.delete('a', { ifExists: true });
		await store.delete('a', { ifValueEquals: { n: 1 } });
		await store.delete('a', { ifExists: true, ifValueEquals: 'old' });
		assert.deepEqual(input(0), {
			Key: { pk: 'a' },
			ConditionExpression: 'attribute_exists(#pk)',
			ExpressionAttributeNames: { '#pk': 'pk' },
		});
		assert.deepEqual(input(1), {
			Key: { pk: 'a' },
			ConditionExpression: '#value = :expected',
			ExpressionAttributeNames: { '#value': 'value' },
			ExpressionAttributeValues: { ':expected': JSON.stringify({ n: 1 }) },
		});
		assert.deepEqual(input(2), {
			Key: { pk: 'a' },
			ConditionExpression: 'attribute_exists(#pk) AND #value = :expected',
			ExpressionAttributeNames: { '#pk': 'pk', '#value': 'value' },
			ExpressionAttributeValues: { ':expected': JSON.stringify('old') },
		});

		const conflict = awsStore(undefined, () =>
			ddbError('ConditionalCheckFailedException', 'The conditional request failed'),
		);
		const failed: any = await rejects(
			() => conflict.store.delete('a', { ifValueEquals: 'old' }),
			KVStoreErrors.ConditionalCheckFailed,
		);
		assert.deepEqual([failed.status, failed.retriable], [409, true]);
	});

	test('put writes the item of the release: pk, the JSON text, and ttl only with an expiry', async () => {
		const { store, input } = awsStore();
		await store.put('a', { n: 1 });
		await store.put('b', 'two', { expiresAt: FAR });
		assert.deepEqual(input(0), { Item: { pk: 'a', value: JSON.stringify({ n: 1 }) } });
		assert.deepEqual(input(1), { Item: { pk: 'b', value: JSON.stringify('two'), ttl: FAR } });
	});

	test('put sends ifNotExists and ifValueEquals as one condition, joined with OR', async () => {
		const { store, input } = awsStore();
		const Item = { pk: 'a', value: JSON.stringify('v') };
		await store.put('a', 'v', { ifNotExists: true });
		await store.put('a', 'v', { ifValueEquals: { n: 1 } });
		await store.put('a', 'v', { ifNotExists: true, ifValueEquals: 'old' });
		assert.deepEqual(input(0), {
			Item,
			ConditionExpression: 'attribute_not_exists(#pk)',
			ExpressionAttributeNames: { '#pk': 'pk' },
		});
		assert.deepEqual(input(1), {
			Item,
			ConditionExpression: '#value = :expected',
			ExpressionAttributeNames: { '#value': 'value' },
			ExpressionAttributeValues: { ':expected': JSON.stringify({ n: 1 }) },
		});
		assert.deepEqual(input(2), {
			Item,
			ConditionExpression: 'attribute_not_exists(#pk) OR #value = :expected',
			ExpressionAttributeNames: { '#pk': 'pk', '#value': 'value' },
			ExpressionAttributeValues: { ':expected': JSON.stringify('old') },
		});
	});

	test('put gives a failed condition as a 409, and an oversize item as ItemTooLarge', async () => {
		const conflict = awsStore(undefined, () =>
			ddbError('ConditionalCheckFailedException', 'The conditional request failed'),
		);
		const failed: any = await rejects(
			() => conflict.store.put('a', 'v', { ifValueEquals: 'old' }),
			KVStoreErrors.ConditionalCheckFailed,
		);
		assert.deepEqual([failed.status, failed.retriable], [409, true]);
		const large = awsStore(undefined, () =>
			ddbError('ValidationException', 'Item size has exceeded the maximum allowed size'),
		);
		await rejects(() => large.store.put('a', 'v'), KVStoreErrors.ItemTooLarge);
	});

	test('a table from KVStore.fromExisting is read by its name', async () => {
		const { store, sent } = awsStore({ table: KVStore.fromExisting('my-table') });
		await store.get('a');
		assert.equal(sent[0].input.TableName, 'my-table');
	});
});

// ── Mock and AWS, side by side ──────────────────────────────────────────────

describe('parity: the mock and the AWS runtime agree', () => {
	/** A mock over a data file, and an AWS store over the same items. */
	function both(entries: Record<string, { value: unknown; ttl?: number } | { text: string }>) {
		const scope = testScope();
		const file: Record<string, unknown> = {};
		const items: Record<string, unknown>[] = [];
		for (const [key, entry] of Object.entries(entries)) {
			const text = 'text' in entry ? entry.text : JSON.stringify(entry.value);
			const ttl = 'ttl' in entry ? entry.ttl : undefined;
			file[key] = ttl === undefined ? text : { value: text, ttl };
			items.push(ttl === undefined ? { pk: key, value: text } : { pk: key, value: text, ttl });
		}
		releaseFile(scope, 'prefs', file);
		items.sort((a, b) => ((a.pk as string) < (b.pk as string) ? -1 : 1));
		const aws = awsStore(undefined, (command) => {
			if (command.constructor.name === 'ScanCommand') {
				const after = command.input.ExclusiveStartKey?.pk;
				return { Items: items.filter((item) => after === undefined || (item.pk as string) > after) };
			}
			return { Item: items.find((item) => item.pk === command.input.Key.pk) };
		});
		return [new LegacyKVStore<unknown>(scope, 'prefs'), aws.store] as const;
	}

	test('a key that is not a string, and an empty key', async () => {
		for (const store of both({ a: { value: 'one' } })) {
			for (const call of [(key: any) => store.get(key), (key: any) => store.delete(key)]) {
				await rejects(() => call(7), KVStoreErrors.InvalidQuery);
				await rejects(() => call({ pk: 'a' }), KVStoreErrors.InvalidQuery);
				await rejects(() => call(''), KVStoreErrors.ValidationFailed);
			}
		}
	});

	test('the same message for the same bad key', async () => {
		const [mock, aws] = both({ a: { value: 'one' } });
		const fromMock = await rejects(() => mock.get(''), KVStoreErrors.ValidationFailed);
		const fromAws = await rejects(() => aws.get(''), KVStoreErrors.ValidationFailed);
		assert.equal(fromMock.message, fromAws.message);
	});

	test('a limit that is not a positive integer, and a cursor that is not a cursor', async () => {
		for (const store of both({ a: { value: 'one' } })) {
			await rejects(() => store.scan({ limit: 0 }), KVStoreErrors.InvalidQuery);
			await rejects(() => store.scan({ limit: 1.5 }), KVStoreErrors.InvalidQuery);
			await rejects(() => store.scan({ cursor: 'not a cursor' }), KVStoreErrors.InvalidQuery);
		}
	});

	test('the same entries, with and without the expired ones, and the same values', async () => {
		const expired = nowSeconds() - 60;
		const [mock, aws] = both({
			a: { value: { n: 1 }, ttl: FAR },
			b: { value: 'two' },
			dead: { value: 'y', ttl: expired },
			odd: { value: { _bkv_pk: 'not a key' } },
		});
		const expected = [
			{ key: 'a', value: { n: 1 }, expiresAt: FAR },
			{ key: 'b', value: 'two' },
			{ key: 'odd', value: { _bkv_pk: 'not a key' } },
		];
		for (const store of [mock, aws]) {
			assert.deepEqual(await Array.fromAsync(store.scan()), expected);
			assert.deepEqual(await Array.fromAsync(store.scan({ includeExpired: true })), [
				...expected.slice(0, 2),
				{ key: 'dead', value: 'y', expiresAt: expired },
				expected[2],
			]);
			assert.deepEqual(await store.get('a'), { n: 1 });
			assert.equal(await store.get('dead'), null);
			assert.equal(await store.get('missing'), null);
		}
	});

	test('the same cursor for the same position, and a cursor of one runtime reads on in the other', async () => {
		const [mock, aws] = both({ a: { value: 1 }, b: { value: 2 }, c: { value: 3 } });
		const cursors: string[] = [];
		for (const store of [mock, aws]) {
			const page = store.scan({ limit: 2 });
			await Array.fromAsync(page);
			assert.deepEqual(cursorKey(page.cursor), { pk: 'b' });
			cursors.push(page.cursor as string);
		}
		assert.equal(cursors[0], cursors[1]);
		for (const store of [mock, aws]) {
			assert.deepEqual(await Array.fromAsync(store.scan({ cursor: cursors[0] })), [{ key: 'c', value: 3 }]);
		}
	});

	test('an item whose value is not JSON text is the same named error', async () => {
		const [mock, aws] = both({ a: { text: 'not JSON {' } });
		for (const store of [mock, aws]) {
			const error = await rejects(() => store.get('a'), KVStoreErrors.ValidationFailed);
			assert.match(error.message, /'a' is not an item of a KVStore release/);
			await rejects(() => Array.fromAsync(store.scan()), KVStoreErrors.ValidationFailed);
		}
	});

	test('put: the same named error and message for a bad key, a bad value, a bad expiry, and a failed condition', async () => {
		const mock: any = new LegacyKVStore(testScope(), 'prefs', { schema: stringSchema } as never);
		await mock.put('taken', 'v');
		const aws = awsStore({ schema: stringSchema }, () =>
			ddbError('ConditionalCheckFailedException', 'The conditional request failed'),
		);
		const stores: any[] = [mock, aws.store];
		const cases: [string, (store: any) => Promise<void>, string][] = [
			['a key that is not a string', (store) => store.put(1, 'v'), KVStoreErrors.InvalidQuery],
			['an empty key', (store) => store.put('', 'v'), KVStoreErrors.ValidationFailed],
			['a value that fails the schema', (store) => store.put('k', 1), KVStoreErrors.ValidationFailed],
			[
				'both expiry options',
				(store) => store.put('k', 'v', { ttlSeconds: 60, expiresAt: FAR }),
				KVStoreErrors.ValidationFailed,
			],
		];
		for (const [label, call, name] of cases) {
			const messages: string[] = [];
			for (const store of stores) messages.push((await rejects(() => call(store), name)).message);
			assert.equal(messages[0], messages[1], label);
		}
		assert.equal(aws.sent.length, 0, 'the AWS runtime rejects these before it calls DynamoDB');

		const conflicts: any[] = [];
		for (const store of stores) {
			conflicts.push(
				await rejects(
					() => store.put('taken', 'v2', { ifNotExists: true }),
					KVStoreErrors.ConditionalCheckFailed,
				),
			);
		}
		assert.equal(conflicts[0].message, conflicts[1].message);
		assert.deepEqual(
			conflicts.map((error) => [error.status, error.retriable]),
			[
				[409, false],
				[409, false],
			],
		);
	});

	test('delete: a failed condition is the same 409, with the same message and the same retriable flag', async () => {
		const mock: any = new LegacyKVStore(testScope(), 'prefs');
		await mock.put('k', 'v');
		const aws = awsStore(undefined, () =>
			ddbError('ConditionalCheckFailedException', 'The conditional request failed'),
		);
		const cases: [Record<string, unknown>, string, boolean][] = [
			[{ ifExists: true }, 'missing', false],
			[{ ifValueEquals: 'other' }, 'k', true],
			[{ ifExists: true, ifValueEquals: 'other' }, 'k', false],
		];
		for (const [conditions, key, retriable] of cases) {
			const errors: any[] = [];
			for (const store of [mock, aws.store] as any[]) {
				errors.push(await rejects(() => store.delete(key, conditions), KVStoreErrors.ConditionalCheckFailed));
			}
			assert.equal(errors[0].message, errors[1].message);
			assert.deepEqual(
				errors.map((error) => [error.status, error.retriable]),
				[
					[409, retriable],
					[409, retriable],
				],
				JSON.stringify(conditions),
			);
		}
	});
});

// ── The deprecation ─────────────────────────────────────────────────────────

describe('LegacyKVStore is deprecated in every entry point', () => {
	const dist = join(import.meta.dirname, '..');

	test('each declaration has the @deprecated tag, and the tag points to the upgrade section of the README', () => {
		for (const file of ['legacy/aws.d.ts', 'legacy/mock.d.ts', 'legacy/cdk.d.ts', 'index.browser.d.ts']) {
			const text = readFileSync(join(dist, file), 'utf8');
			const at = text.indexOf('export declare class LegacyKVStore');
			assert.ok(at > 0, `${file} declares the class`);
			const doc = text.slice(text.lastIndexOf('/**', at), at);
			assert.match(doc, /@deprecated[\s\S]*README\.md#upgrade-from-release-040-or-earlier/, file);
		}
	});

	test('the README has the section that the tag names', () => {
		const readme = readFileSync(join(dist, '..', 'README.md'), 'utf8');
		assert.match(readme, /^## Upgrade from release 0\.4\.0 or earlier$/m);
		assert.match(readme, /`LegacyKVStore` is deprecated and frozen\./);
	});
});
