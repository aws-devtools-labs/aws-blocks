// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The data file of the mock (`mock-file.ts`): the current format, a corrupt
 * entry, the two earlier formats that the loader converts, and a file that the
 * loader cannot read. "A corrupt entry" and "an earlier format" are separate
 * cases, with separate tests.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { z } from 'zod';
import { KVStore } from './index.mock.js';

beforeEach(() => {
	try {
		rmSync('.bb-data', { recursive: true, force: true });
	} catch {}
});

let n = 0;
const testScope = () => ({ id: `kv-file-${++n}-${Date.now()}` }) as any;

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

/**
 * The mock data directory of the store `id` under `scope`, created if it does
 * not exist. The path comes from the ids, not from a store: a store with other
 * options over the same directory would read the file as its own.
 */
function dataDir(scope: { id: string }, id: string): string {
	const dir = join('.bb-data', `${scope.id}-${id}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

const readJson = (dir: string, name = 'store.json') => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const nowSeconds = () => Math.floor(Date.now() / 1000);

const orderOptions = {
	schema: z.object({ userId: z.string(), orderId: z.string(), total: z.number() }),
	key: { partitionKey: 'userId', sortKey: 'orderId' },
} as const;

// ── The current format ──────────────────────────────────────────────────────

describe('the current format', () => {
	test('a write gives { version: 2, items } with the exact DynamoDB items', async () => {
		const scope = testScope();
		const store = new KVStore(scope, 'kv');
		await store.put('a', 'hello', { expiresAt: 1_800_000_000 });
		await store.put('b', 'world');
		assert.deepEqual(readJson(dataDir(scope, 'kv')), {
			version: 2,
			items: [
				{ _bkv_pk: 'a', _bkv_value: 'hello', _bkv_ttl: 1_800_000_000 },
				{ _bkv_pk: 'b', _bkv_value: 'world' },
			],
		});
	});

	test('a store loads the file that it wrote, with no warning and no other file', async () => {
		const scope = testScope();
		await new KVStore(scope, 'orders', orderOptions).put({ userId: 'alice', orderId: '001' }, { total: 12 });
		const { warnings, logger } = recorder();
		const reloaded = new KVStore(scope, 'orders', { ...orderOptions, logger });
		assert.deepEqual(await reloaded.get({ userId: 'alice', orderId: '001' }), {
			userId: 'alice',
			orderId: '001',
			total: 12,
		});
		assert.deepEqual(warnings, []);
		assert.equal(join('.bb-data', reloaded.fullId), dataDir(scope, 'orders'));
		assert.deepEqual(readdirSync(dataDir(scope, 'orders')), ['store.json']);
	});
});

// ── A corrupt entry ─────────────────────────────────────────────────────────

describe('a corrupt entry in a file of the current format', () => {
	test('is left out; the other items load; the store reports it once and keeps a copy of the file', async () => {
		const scope = testScope();
		await new KVStore(scope, 'kv').put('a', 'x');
		const dir = dataDir(scope, 'kv');
		const file = readJson(dir);
		file.items.push('not an item', { noKey: true }, null);
		// An item with a field name that a write refuses is not an item either.
		const damaged = JSON.stringify(file).replace(/\]\}$/, ',{"_bkv_pk":"p","__proto__":{"admin":true}}]}');
		writeFileSync(join(dir, 'store.json'), damaged);

		const { warnings, logger } = recorder();
		const reloaded = new KVStore(scope, 'kv', { logger });
		assert.deepEqual(await Array.fromAsync(reloaded.scan()), [{ key: 'a', value: 'x' }]);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /4 of the entries .* are not items of this store/);
		assert.ok(warnings[0].includes(join(dir, 'store.json.bak')));
		assert.equal(readFileSync(join(dir, 'store.json.bak'), 'utf8'), damaged);

		// The store wrote the file again without the entries, so the next load is clean.
		assert.deepEqual(readJson(dir), { version: 2, items: [{ _bkv_pk: 'a', _bkv_value: 'x' }] });
		const second = recorder();
		new KVStore(scope, 'kv', { logger: second.logger });
		assert.deepEqual(second.warnings, []);
		assert.deepEqual(readdirSync(dir).sort(), ['store.json', 'store.json.bak']);
	});
});

// ── An earlier format ───────────────────────────────────────────────────────

describe('a file of an earlier format is converted', () => {
	test('version 1 of KVStore: a JSON string for each key, or { value, ttl }', async () => {
		const scope = testScope();
		const dir = dataDir(scope, 'kv');
		const future = nowSeconds() + 3600;
		writeFileSync(
			join(dir, 'store.json'),
			JSON.stringify({
				greeting: JSON.stringify('hello'),
				user: JSON.stringify({ name: 'Ada', tags: ['a'] }),
				count: JSON.stringify(3),
				session: { value: JSON.stringify('live'), ttl: future },
				old: { value: JSON.stringify('dead'), ttl: 1 },
			}),
		);

		const { warnings, logger } = recorder();
		const store = new KVStore<unknown>(scope, 'kv', { logger });
		assert.equal(await store.get('greeting'), 'hello');
		assert.deepEqual(await store.get('user'), { name: 'Ada', tags: ['a'] });
		assert.equal(await store.get('count'), 3);
		assert.equal(await store.get('session'), 'live');
		// An entry whose expiry has passed is not carried over.
		assert.equal(await store.get('old'), null);
		const entries = await Array.fromAsync(store.scan());
		assert.equal(entries.find((entry) => entry.key === 'session')?.expiresAt, future);
		assert.deepEqual(warnings, []);

		// The file is in the current format now, and no file was set aside.
		assert.deepEqual(readJson(dir), {
			version: 2,
			items: [
				{ _bkv_pk: 'greeting', _bkv_value: 'hello' },
				{ _bkv_pk: 'user', name: 'Ada', tags: ['a'] },
				{ _bkv_pk: 'count', _bkv_value: 3 },
				{ _bkv_pk: 'session', _bkv_value: 'live', _bkv_ttl: future },
			],
		});
		assert.deepEqual(readdirSync(dir), ['store.json']);
	});

	test('the data.json of DistributedTable, when the directory has no store.json', async () => {
		const scope = testScope();
		const dir = dataDir(scope, 'orders');
		const rows = [
			{ userId: 'alice', orderId: '001', total: 12 },
			{ userId: 'alice', orderId: '002', total: 7 },
		];
		const tableFile = JSON.stringify(rows.map((row) => [JSON.stringify([row.userId, row.orderId]), row]));
		writeFileSync(join(dir, 'data.json'), tableFile);

		const { warnings, logger } = recorder();
		const store = new KVStore(scope, 'orders', { ...orderOptions, logger });
		assert.deepEqual(await store.get({ userId: 'alice', orderId: '002' }), rows[1]);
		const hits = await Array.fromAsync(store.query({ where: { userId: { equals: 'alice' } } }));
		assert.deepEqual(
			hits.map((hit) => hit.value),
			rows,
		);
		assert.deepEqual(warnings, []);

		// store.json is the file of the store from now on; the table file stays as it was.
		assert.deepEqual(readJson(dir), { version: 2, items: rows });
		assert.equal(readFileSync(join(dir, 'data.json'), 'utf8'), tableFile);
		assert.deepEqual(readdirSync(dir).sort(), ['data.json', 'store.json']);
	});

	test('a data.json is not read when the directory has a store.json', async () => {
		const scope = testScope();
		await new KVStore(scope, 'orders', orderOptions).put({ userId: 'bob', orderId: '900' }, { total: 1 });
		const dir = dataDir(scope, 'orders');
		const stale = { userId: 'alice', orderId: '001', total: 12 };
		writeFileSync(join(dir, 'data.json'), JSON.stringify([[JSON.stringify(['alice', '001']), stale]]));
		const reloaded = new KVStore(scope, 'orders', orderOptions);
		assert.equal(await reloaded.get({ userId: 'alice', orderId: '001' }), null);
		assert.equal((await Array.fromAsync(reloaded.scan())).length, 1);
	});
});

// ── A file that the store cannot read ───────────────────────────────────────

describe('a file that the store cannot read is set aside and never written over', () => {
	const cases: Array<[name: string, fileName: string, content: string]> = [
		['text that is not JSON', 'store.json', 'not json {'],
		['a JSON array in store.json', 'store.json', '[1, 2]'],
		['a later version', 'store.json', JSON.stringify({ version: 3, items: [] })],
		[
			'a version 1 file with an entry that is not a version 1 entry',
			'store.json',
			JSON.stringify({ a: JSON.stringify('x'), b: { _bkv_pk: 'b', _bkv_value: 'y' } }),
		],
		['a version 1 entry whose value is not JSON text', 'store.json', JSON.stringify({ a: 'plain text' })],
		[
			'a version 1 entry that the layout of a write refuses',
			'store.json',
			JSON.stringify({ a: JSON.stringify({ _bkv_pk: 'other' }) }),
		],
		[
			'a data.json for a store with a string key',
			'data.json',
			JSON.stringify([[JSON.stringify(['a']), { id: 'a' }]]),
		],
	];
	for (const [name, fileName, content] of cases) {
		test(name, async () => {
			const scope = testScope();
			const dir = dataDir(scope, 'kv');
			writeFileSync(join(dir, fileName), content);

			const { warnings, logger } = recorder();
			const store = new KVStore(scope, 'kv', { logger });
			assert.deepEqual(await Array.fromAsync(store.scan()), []);
			assert.equal(warnings.length, 1);
			assert.match(warnings[0], /is not in a format that this version can read/);
			assert.ok(warnings[0].includes(join(dir, `${fileName}.bak`)));
			assert.equal(existsSync(join(dir, fileName)), false);
			assert.equal(readFileSync(join(dir, `${fileName}.bak`), 'utf8'), content);

			// A write makes a new file. The file that was set aside keeps its content.
			await store.put('a', 'new');
			assert.deepEqual(readJson(dir), { version: 2, items: [{ _bkv_pk: 'a', _bkv_value: 'new' }] });
			assert.equal(readFileSync(join(dir, `${fileName}.bak`), 'utf8'), content);
		});
	}

	test('a version 1 file for a store that now declares a key', async () => {
		const scope = testScope();
		const dir = dataDir(scope, 'orders');
		const content = JSON.stringify({ 'alice:001': JSON.stringify({ total: 12 }) });
		writeFileSync(join(dir, 'store.json'), content);
		const { warnings, logger } = recorder();
		const store = new KVStore(scope, 'orders', { ...orderOptions, logger });
		assert.deepEqual(await Array.fromAsync(store.scan()), []);
		assert.equal(warnings.length, 1);
		assert.equal(readFileSync(join(dir, 'store.json.bak'), 'utf8'), content);
	});

	test('a second file that cannot be read gets a second name', async () => {
		const scope = testScope();
		const dir = dataDir(scope, 'kv');
		for (const content of ['first {', 'second {']) {
			writeFileSync(join(dir, 'store.json'), content);
			new KVStore(scope, 'kv', { logger: recorder().logger });
		}
		assert.equal(readFileSync(join(dir, 'store.json.bak'), 'utf8'), 'first {');
		assert.equal(readFileSync(join(dir, 'store.json.bak.2'), 'utf8'), 'second {');
		assert.deepEqual(readdirSync(dir).sort(), ['store.json.bak', 'store.json.bak.2']);
	});
});
