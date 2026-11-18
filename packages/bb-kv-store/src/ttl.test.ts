// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { beforeEach, describe, test } from 'node:test';
import { isBlocksError } from '@aws-blocks/core';
import { KVStore as AwsKVStore } from './index.aws.js';
import { KVStore, KVStoreErrors } from './index.mock.js';
import { isExpired, nowEpochSeconds, resolveTtlEpochSeconds, TTL_ATTRIBUTE } from './ttl.js';

beforeEach(() => {
	try {
		rmSync('.bb-data', { recursive: true, force: true });
	} catch {}
});

let n = 0;
const testScope = () => ({ id: `kv-ttl-${++n}-${Date.now()}` }) as any;

function assertValidationFailed(fn: () => unknown, message?: RegExp) {
	assert.throws(fn, (e: unknown) => {
		assert.ok(isBlocksError(e, KVStoreErrors.ValidationFailed), `expected ValidationFailed, got ${e}`);
		if (message) assert.match((e as Error).message, message);
		return true;
	});
}

describe('resolveTtlEpochSeconds', () => {
	test('returns undefined when no expiry is requested', () => {
		assert.equal(resolveTtlEpochSeconds(undefined), undefined);
		assert.equal(resolveTtlEpochSeconds({}), undefined);
	});

	test('ttlSeconds resolves to now + seconds, rounding a fraction up', () => {
		const before = nowEpochSeconds();
		const got = resolveTtlEpochSeconds({ ttlSeconds: 300 }) as number;
		assert.ok(got >= before + 300 && got <= before + 301);
		assert.equal(resolveTtlEpochSeconds({ ttlSeconds: 0.2 }), nowEpochSeconds() + 1);
	});

	test('expiresAt accepts a Date or epoch seconds, including a past instant', () => {
		assert.equal(resolveTtlEpochSeconds({ expiresAt: new Date(1_800_000_000_000) }), 1_800_000_000);
		assert.equal(resolveTtlEpochSeconds({ expiresAt: 1_800_000_000 }), 1_800_000_000);
		assert.equal(resolveTtlEpochSeconds({ expiresAt: 0 }), 0);
		assert.equal(resolveTtlEpochSeconds({ expiresAt: -5 }), -5);
	});

	test('rejects epoch milliseconds, both options, bad durations, and an Invalid Date', () => {
		assertValidationFailed(() => resolveTtlEpochSeconds({ expiresAt: Date.now() }), /milliseconds/);
		assertValidationFailed(() => resolveTtlEpochSeconds({ ttlSeconds: 60, expiresAt: 1 } as any), /not both/);
		for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 'x' as any]) {
			assertValidationFailed(() => resolveTtlEpochSeconds({ ttlSeconds: bad }), /ttlSeconds/);
		}
		assertValidationFailed(() => resolveTtlEpochSeconds({ expiresAt: new Date('nope') }), /Invalid Date/);
		assertValidationFailed(() => resolveTtlEpochSeconds({ expiresAt: 'soon' as any }), /expiresAt/);
	});
});

describe('isExpired', () => {
	test('true only once the timestamp has been reached', () => {
		assert.equal(isExpired(100, 99), false);
		assert.equal(isExpired(100, 100), true);
		assert.equal(isExpired(100, 101), true);
	});

	test('missing or non-numeric ttl is never expired (DynamoDB ignores those items)', () => {
		assert.equal(isExpired(undefined), false);
		assert.equal(isExpired(null), false);
		assert.equal(isExpired('100'), false);
		assert.equal(isExpired(Number.NaN), false);
	});
});

describe('mock runtime emulates DynamoDB TTL', () => {
	test('get returns the value while live, null once expired; the row stays until deleted', async () => {
		const store = new KVStore(testScope(), 'kv');
		await store.put('live', 'x', { ttlSeconds: 60 });
		await store.put('dead', 'y', { expiresAt: 1 });
		assert.equal(await store.get('live'), 'x');
		assert.equal(await store.get('dead'), null);
		// Still on disk for a cleanup sweep.
		assert.deepEqual(
			(await Array.fromAsync(store.scan({ includeExpired: true }))).map((e) => e.key),
			['dead', 'live'],
		);
		assert.deepEqual(
			(await Array.fromAsync(store.scan())).map((e) => e.key),
			['live'],
		);
	});

	test('expiry survives a restart (persisted, not in-memory only)', async () => {
		const scope = testScope();
		await new KVStore(scope, 'kv').put('dead', 'y', { expiresAt: 1 });
		assert.equal(await new KVStore(scope, 'kv').get('dead'), null);
	});

	test('an expired item is dropped when the store loads its file, so the file does not grow', async () => {
		const scope = testScope();
		const first = new KVStore(scope, 'kv');
		await first.put('dead', 'y', { expiresAt: 1 });
		await first.put('live', 'x');
		const reloaded = new KVStore(scope, 'kv');
		assert.deepEqual(
			(await Array.fromAsync(reloaded.scan({ includeExpired: true }))).map((e) => e.key),
			['live'],
		);
		await reloaded.put('other', 'z');
		assert.equal(readFileSync(`.bb-data/${reloaded.fullId}/store.json`, 'utf8').includes('dead'), false);
	});

	test('re-putting without a TTL clears a previous expiry', async () => {
		const store = new KVStore(testScope(), 'kv');
		await store.put('a', 'x', { ttlSeconds: 60 });
		await store.put('a', 'y');
		assert.deepEqual(await Array.fromAsync(store.scan()), [{ key: 'a', value: 'y' }]);
	});

	test('invalid TTL options throw before anything is written', async () => {
		const store = new KVStore(testScope(), 'kv');
		await assert.rejects(store.put('a', 'x', { ttlSeconds: 60, expiresAt: 1 } as any), (e: unknown) =>
			isBlocksError(e, KVStoreErrors.ValidationFailed),
		);
		assert.equal(await store.get('a'), null);
	});

	test('the on-disk attribute is _bkv_ttl, in epoch seconds', async () => {
		const store = new KVStore(testScope(), 'kv');
		await store.put('a', 'x', { expiresAt: 1_800_000_000 });
		const stored = JSON.parse(readFileSync(`.bb-data/${store.fullId}/store.json`, 'utf8'));
		assert.equal(stored.items[0][TTL_ATTRIBUTE], 1_800_000_000);
	});
});

describe('AWS runtime writes the DynamoDB TTL attribute', () => {
	function captureAws<T = string>(respond: () => any = () => ({})) {
		const store = new AwsKVStore<T>(testScope(), 'kv');
		const sent: any[] = [];
		(store as any).docClient = {
			send: async (c: any) => {
				sent.push(c.input);
				return respond();
			},
		};
		return { store, sent };
	}

	test('put with ttlSeconds writes a numeric epoch-seconds _bkv_ttl; expiresAt writes that timestamp', async () => {
		const { store, sent } = captureAws();
		await store.put('a', 'x', { ttlSeconds: 300 });
		const ttl = sent[0].Item[TTL_ATTRIBUTE];
		assert.equal(typeof ttl, 'number');
		assert.ok(ttl > nowEpochSeconds() + 290 && ttl <= nowEpochSeconds() + 301);
		await store.put('a', 'x', { expiresAt: 1_800_000_000 });
		assert.equal(sent[1].Item[TTL_ATTRIBUTE], 1_800_000_000);
		await store.put('a', 'x');
		assert.equal(TTL_ATTRIBUTE in sent[2].Item, false);
	});

	test('TTL composes with a conditional write expression', async () => {
		const { store, sent } = captureAws();
		await store.put('a', 'x', { ttlSeconds: 60, ifNotExists: true });
		assert.equal(sent[0].ConditionExpression, 'attribute_not_exists(#pk)');
		assert.equal(typeof sent[0].Item[TTL_ATTRIBUTE], 'number');
	});

	test('invalid TTL options throw before any DynamoDB call', async () => {
		const { store, sent } = captureAws();
		await assert.rejects(store.put('a', 'x', { expiresAt: Date.now() }), (e: unknown) =>
			isBlocksError(e, KVStoreErrors.ValidationFailed),
		);
		assert.equal(sent.length, 0);
	});

	test('get and scan filter an expired item DynamoDB has not reaped yet', async () => {
		let item: any = { _bkv_pk: 'a', _bkv_value: 'x', [TTL_ATTRIBUTE]: 1 };
		const { store } = captureAws(() => ({ Item: item, Items: [item] }));
		assert.equal(await store.get('a'), null);
		assert.deepEqual(await Array.fromAsync(store.scan()), []);
		item = { _bkv_pk: 'a', _bkv_value: 'x', [TTL_ATTRIBUTE]: nowEpochSeconds() + 60 };
		assert.equal(await store.get('a'), 'x');
	});
});
