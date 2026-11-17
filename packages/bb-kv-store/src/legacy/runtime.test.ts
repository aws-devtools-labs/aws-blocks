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
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { isBlocksError } from '@aws-blocks/core';
import { LegacyKVStore as AwsLegacyKVStore } from '../index.aws.js';
import { KVStore, KVStoreErrors, LegacyKVStore } from '../index.mock.js';

beforeEach(() => {
	try {
		rmSync('.bb-data', { recursive: true, force: true });
	} catch {}
});

let n = 0;
const testScope = () => ({ id: `kv-legacy-${++n}-${Date.now()}` }) as any;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const FAR = 4102444800;

/** The data file of the store `id` under `scope`, as a release up to 0.4.0 writes it. */
function releaseFile(scope: { id: string }, id: string, entries: Record<string, unknown>): string {
	const dir = join('.bb-data', `${scope.id}-${id}`);
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
		const dir = join('.bb-data', `${scope.id}-broken`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'store.json'), 'not json');
		const { warnings, logger } = recorder();
		const broken = new LegacyKVStore(scope, 'broken', { logger });
		assert.deepEqual(await Array.fromAsync(broken.scan()), []);
		assert.equal(warnings.length, 1);
		assert.equal(readFileSync(join(dir, 'store.json'), 'utf8'), 'not json');
	});

	test('has get, scan, and delete, and no other data method', () => {
		const old: object = new LegacyKVStore(testScope(), 'prefs');
		for (const method of ['get', 'scan', 'delete']) assert.equal(method in old, true, method);
		for (const method of ['put', 'putBatch', 'deleteBatch', 'query', 'getBatch']) {
			assert.equal(method in old, false, method);
		}
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
});
