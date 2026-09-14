// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * TTL coverage for KVStore: option resolution, mock expiry emulation, and the
 * DynamoDB wire format produced by the AWS runtime.
 *
 * The AWS-runtime tests drive the REAL `KVStore` from `index.aws.ts` against a
 * real `DynamoDBDocumentClient`; only the network boundary is intercepted (an
 * SDK middleware captures the command input and returns a canned response), so
 * the production put/get/scan code paths execute unchanged.
 */

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KVStore as MockKVStore, KVStoreErrors } from './index.mock.js';
import { KVStore as AwsKVStore } from './index.aws.js';
import { TTL_ATTRIBUTE, isExpired, nowEpochSeconds, resolveTtlEpochSeconds } from './ttl.js';

/**
 * These tests assert on the mock's persisted bytes, so they wipe its data root
 * between cases. The mock resolves that root from `process.cwd()`, and the test
 * runner executes files concurrently by default — so wiping the shared
 * `.bb-data` would delete directories a sibling test file is actively reading.
 * Run against a private root instead.
 */
const originalCwd = process.cwd();
const dataRoot = mkdtempSync(join(tmpdir(), 'bb-kv-store-ttl-'));
process.chdir(dataRoot);

after(() => {
	process.chdir(originalCwd);
	rmSync(dataRoot, { recursive: true, force: true });
});

beforeEach(() => {
	rmSync('.bb-data', { recursive: true, force: true });
});

function mockStore<T = string>(id: string): MockKVStore<T> {
	return new MockKVStore<T>({ id: 'root' } as any, id);
}

/** Path the mock persists to, so tests can assert the on-disk shape. */
function storeFile(id: string): string {
	return join('.bb-data', `root-${id}`, 'store.json');
}

// ── Captured DynamoDB traffic ───────────────────────────────────────────────

interface Captured {
	commandName: string;
	input: any;
}

/**
 * Short-circuit the SDK before it reaches the network. Middleware added at the
 * `initialize` step sees the document-shaped input our code built and returns
 * the document-shaped output our code reads.
 */
function interceptDynamo(
	store: AwsKVStore<any>,
	respond: (captured: Captured) => any = () => ({}),
): Captured[] {
	const calls: Captured[] = [];
	const docClient = (store as any).docClient;
	docClient.middlewareStack.add(
		(_next: any, context: any) => async (args: any) => {
			const captured: Captured = { commandName: String(context.commandName), input: args.input };
			calls.push(captured);
			return { output: respond(captured) };
		},
		{ step: 'initialize', name: 'kv-ttl-test-intercept', override: true },
	);
	return calls;
}

function awsStore<T = string>(id: string): AwsKVStore<T> {
	return new AwsKVStore<T>({ id: 'root' } as any, id);
}

// ── Option resolution ───────────────────────────────────────────────────────

describe('resolveTtlEpochSeconds', () => {
	test('returns undefined when no expiry is requested', () => {
		assert.strictEqual(resolveTtlEpochSeconds(undefined), undefined);
		assert.strictEqual(resolveTtlEpochSeconds({}), undefined);
		assert.strictEqual(resolveTtlEpochSeconds({ ifNotExists: true }), undefined);
	});

	test('ttlSeconds resolves to now + seconds', () => {
		const before = nowEpochSeconds();
		const resolved = resolveTtlEpochSeconds({ ttlSeconds: 3600 });
		assert.ok(resolved !== undefined);
		assert.ok(resolved >= before + 3600, `expected >= ${before + 3600}, got ${resolved}`);
		assert.ok(resolved <= nowEpochSeconds() + 3601, `expected <= now+3601, got ${resolved}`);
	});

	test('fractional ttlSeconds rounds up so a sub-second TTL never lands in the past', () => {
		const resolved = resolveTtlEpochSeconds({ ttlSeconds: 0.25 });
		assert.strictEqual(resolved, nowEpochSeconds() + 1);
	});

	test('expiresAt accepts a Date and converts to epoch seconds', () => {
		const when = new Date('2030-01-01T00:00:00.000Z');
		assert.strictEqual(resolveTtlEpochSeconds({ expiresAt: when }), Math.floor(when.getTime() / 1000));
	});

	test('expiresAt accepts epoch seconds unchanged', () => {
		assert.strictEqual(resolveTtlEpochSeconds({ expiresAt: 1893456000 }), 1893456000);
	});

	test('expiresAt in the past is allowed (caller asked for immediate expiry)', () => {
		const past = nowEpochSeconds() - 60;
		assert.strictEqual(resolveTtlEpochSeconds({ expiresAt: past }), past);
	});

	test('expiresAt has no positive lower bound — epoch 0 and negatives are past instants', () => {
		assert.strictEqual(resolveTtlEpochSeconds({ expiresAt: 0 }), 0);
		assert.strictEqual(resolveTtlEpochSeconds({ expiresAt: -1 }), -1);
		assert.strictEqual(resolveTtlEpochSeconds({ expiresAt: new Date(0) }), 0);
	});

	test('rejects epoch milliseconds passed as expiresAt', () => {
		assert.throws(
			() => resolveTtlEpochSeconds({ expiresAt: Date.now() }),
			(err: any) => {
				assert.strictEqual(err.name, KVStoreErrors.ValidationFailed);
				assert.match(err.message, /milliseconds/);
				return true;
			},
		);
	});

	test('rejects ttlSeconds together with expiresAt', () => {
		assert.throws(
			() => resolveTtlEpochSeconds({ ttlSeconds: 60, expiresAt: new Date() }),
			(err: any) => {
				assert.strictEqual(err.name, KVStoreErrors.ValidationFailed);
				assert.match(err.message, /not both/);
				return true;
			},
		);
	});

	for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '60' as any]) {
		test(`rejects ttlSeconds: ${String(bad)}`, () => {
			assert.throws(
				() => resolveTtlEpochSeconds({ ttlSeconds: bad }),
				(err: any) => {
					assert.strictEqual(err.name, KVStoreErrors.ValidationFailed);
					return true;
				},
			);
		});
	}

	test('rejects an Invalid Date', () => {
		assert.throws(
			() => resolveTtlEpochSeconds({ expiresAt: new Date('nope') }),
			(err: any) => {
				assert.strictEqual(err.name, KVStoreErrors.ValidationFailed);
				return true;
			},
		);
	});
});

describe('isExpired', () => {
	test('true only once the timestamp has been reached', () => {
		const now = 1_000_000;
		assert.strictEqual(isExpired(now - 1, now), true);
		assert.strictEqual(isExpired(now, now), true);
		assert.strictEqual(isExpired(now + 1, now), false);
	});

	test('missing or non-numeric ttl is never expired (DynamoDB ignores those items)', () => {
		assert.strictEqual(isExpired(undefined), false);
		assert.strictEqual(isExpired(null), false);
		assert.strictEqual(isExpired('123'), false);
		assert.strictEqual(isExpired(Number.NaN), false);
	});
});

// ── Mock expiry emulation ───────────────────────────────────────────────────

describe('mock runtime emulates DynamoDB TTL', () => {
	test('get returns the value while it is still live', async () => {
		const store = mockStore('ttl-live');
		await store.put('k', 'v', { ttlSeconds: 600 });
		assert.strictEqual(await store.get('k'), 'v');
	});

	test('get returns null once the item has expired', async () => {
		const store = mockStore('ttl-expired');
		await store.put('k', 'v', { expiresAt: nowEpochSeconds() - 1 });
		assert.strictEqual(await store.get('k'), null);
	});

	test('get prunes the expired item from disk', async () => {
		const store = mockStore('ttl-prune-get');
		await store.put('gone', 'v', { expiresAt: nowEpochSeconds() - 1 });
		await store.put('stays', 'v');
		await store.get('gone');
		const onDisk = JSON.parse(readFileSync(storeFile('ttl-prune-get'), 'utf8'));
		assert.deepStrictEqual(Object.keys(onDisk), ['stays']);
	});

	test('scan skips expired items and keeps live ones', async () => {
		const store = mockStore('ttl-scan');
		await store.put('live', 'a');
		await store.put('dead', 'b', { expiresAt: nowEpochSeconds() - 1 });
		await store.put('later', 'c', { ttlSeconds: 600 });

		const seen: string[] = [];
		for await (const { key } of store.scan()) seen.push(key);
		assert.deepStrictEqual(seen.sort(), ['later', 'live']);
	});

	test('scan sweeps expired items off disk', async () => {
		const store = mockStore('ttl-scan-prune');
		await store.put('dead1', 'a', { expiresAt: nowEpochSeconds() - 5 });
		await store.put('dead2', 'b', { expiresAt: nowEpochSeconds() - 5 });
		await store.put('live', 'c');

		for await (const _ of store.scan()) { /* drain */ }
		const onDisk = JSON.parse(readFileSync(storeFile('ttl-scan-prune'), 'utf8'));
		assert.deepStrictEqual(Object.keys(onDisk), ['live']);
	});

	test('scan({ includeExpired }) yields expired-but-unreaped items', async () => {
		const store = mockStore('ttl-scan-include');
		await store.put('live', 'a');
		await store.put('dead', 'b', { expiresAt: nowEpochSeconds() - 1 });

		const seen: string[] = [];
		for await (const { key } of store.scan({ includeExpired: true })) seen.push(key);
		assert.deepStrictEqual(seen.sort(), ['dead', 'live']);
	});

	test('scan({ includeExpired }) leaves expired rows on disk for the caller to delete', async () => {
		const store = mockStore('ttl-scan-include-nodelete');
		await store.put('dead', 'b', { expiresAt: nowEpochSeconds() - 1 });

		for await (const _ of store.scan({ includeExpired: true })) { /* drain */ }
		const onDisk = JSON.parse(readFileSync(storeFile('ttl-scan-include-nodelete'), 'utf8'));
		assert.deepStrictEqual(Object.keys(onDisk), ['dead']);
	});

	test('expiry survives a restart (persisted, not in-memory only)', async () => {
		const first = mockStore('ttl-restart');
		await first.put('live', 'a', { ttlSeconds: 600 });
		await first.put('dead', 'b', { expiresAt: nowEpochSeconds() - 1 });

		const second = mockStore('ttl-restart');
		assert.strictEqual(await second.get('live'), 'a');
		assert.strictEqual(await second.get('dead'), null);
	});

	test('re-putting without a TTL clears a previous expiry', async () => {
		const store = mockStore('ttl-cleared');
		await store.put('k', 'v', { ttlSeconds: 600 });
		await store.put('k', 'v2');

		const onDisk = JSON.parse(readFileSync(storeFile('ttl-cleared'), 'utf8'));
		assert.strictEqual(onDisk.k, JSON.stringify('v2'), 'no-TTL write must persist as a bare string');
		assert.strictEqual(await store.get('k'), 'v2');
	});

	test('TTL composes with conditional writes', async () => {
		const store = mockStore('ttl-conditional');
		await store.put('k', 'v', { ifNotExists: true, ttlSeconds: 600 });
		await assert.rejects(
			() => store.put('k', 'v2', { ifNotExists: true, ttlSeconds: 600 }),
			(err: any) => {
				assert.strictEqual(err.name, KVStoreErrors.ConditionalCheckFailed);
				return true;
			},
		);
		assert.strictEqual(await store.get('k'), 'v');
	});

	test('invalid TTL options throw before anything is written', async () => {
		const store = mockStore('ttl-invalid');
		await assert.rejects(
			() => store.put('k', 'v', { ttlSeconds: -5 }),
			(err: any) => {
				assert.strictEqual(err.name, KVStoreErrors.ValidationFailed);
				return true;
			},
		);
		assert.strictEqual(await store.get('k'), null);
	});

	test('items written without a TTL never expire', async () => {
		const store = mockStore('ttl-absent');
		await store.put('k', 'v');
		const onDisk = JSON.parse(readFileSync(storeFile('ttl-absent'), 'utf8'));
		assert.strictEqual(typeof onDisk.k, 'string', 'expected the legacy bare-string shape');
		assert.strictEqual(await store.get('k'), 'v');
	});

	test('stores written by earlier versions (bare strings) still load', async () => {
		const dir = join('.bb-data', 'root-ttl-legacy');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'store.json'), JSON.stringify({ legacy: JSON.stringify('old-value') }));

		const store = mockStore('ttl-legacy');
		assert.strictEqual(await store.get('legacy'), 'old-value');

		await store.put('fresh', 'new-value', { ttlSeconds: 600 });
		assert.strictEqual(await store.get('legacy'), 'old-value');
		assert.strictEqual(await store.get('fresh'), 'new-value');
	});

	test('typed values round-trip with a TTL', async () => {
		interface Session { user: string; token: string }
		const store = mockStore<Session>('ttl-typed');
		await store.put('s1', { user: 'alice', token: 'abc' }, { ttlSeconds: 600 });
		assert.deepStrictEqual(await store.get('s1'), { user: 'alice', token: 'abc' });
	});

	test('a corrupt entry is dropped rather than crashing the load', async () => {
		const dir = join('.bb-data', 'root-ttl-corrupt');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'store.json'), JSON.stringify({
			good: JSON.stringify('kept'),
			bad: { ttl: 123 },
			alsoBad: 42,
		}));

		const store = mockStore('ttl-corrupt');
		assert.strictEqual(await store.get('good'), 'kept');
		assert.strictEqual(await store.get('bad'), null);
		assert.strictEqual(await store.get('alsoBad'), null);
	});
});

// ── AWS runtime wire format ─────────────────────────────────────────────────

describe('AWS runtime writes a DynamoDB TTL attribute', () => {
	test('put with ttlSeconds writes a numeric epoch-seconds ttl', async () => {
		const store = awsStore('aws-ttl-put');
		const calls = interceptDynamo(store);

		const before = nowEpochSeconds();
		await store.put('k', 'v', { ttlSeconds: 3600 });

		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].commandName, 'PutItemCommand');
		const ttl = calls[0].input.Item[TTL_ATTRIBUTE];
		assert.strictEqual(typeof ttl, 'number');
		assert.ok(Number.isInteger(ttl), 'DynamoDB TTL must be an integer');
		assert.ok(ttl >= before + 3600 && ttl <= nowEpochSeconds() + 3601, `ttl ${ttl} out of expected window`);
		assert.strictEqual(calls[0].input.Item.pk, 'k');
		assert.strictEqual(calls[0].input.Item.value, JSON.stringify('v'));
	});

	test('put with expiresAt writes that exact timestamp', async () => {
		const store = awsStore('aws-ttl-expires-at');
		const calls = interceptDynamo(store);

		await store.put('k', 'v', { expiresAt: new Date('2031-06-01T12:00:00.000Z') });
		assert.strictEqual(calls[0].input.Item[TTL_ATTRIBUTE], Math.floor(Date.parse('2031-06-01T12:00:00.000Z') / 1000));
	});

	test('put without TTL options omits the attribute entirely', async () => {
		const store = awsStore('aws-ttl-omitted');
		const calls = interceptDynamo(store);

		await store.put('k', 'v');
		await store.put('k2', 'v2', { ifNotExists: true });

		for (const call of calls) {
			assert.ok(!(TTL_ATTRIBUTE in call.input.Item), `unexpected ttl attribute in ${JSON.stringify(call.input.Item)}`);
		}
	});

	test('TTL composes with a conditional write expression', async () => {
		const store = awsStore('aws-ttl-conditional');
		const calls = interceptDynamo(store);

		await store.put('k', 'v', { ifNotExists: true, ttlSeconds: 60 });
		assert.strictEqual(calls[0].input.ConditionExpression, 'attribute_not_exists(#pk)');
		assert.strictEqual(typeof calls[0].input.Item[TTL_ATTRIBUTE], 'number');
	});

	test('invalid TTL options throw before any DynamoDB call', async () => {
		const store = awsStore('aws-ttl-invalid');
		const calls = interceptDynamo(store);

		await assert.rejects(
			() => store.put('k', 'v', { ttlSeconds: 60, expiresAt: 123456 }),
			(err: any) => {
				assert.strictEqual(err.name, KVStoreErrors.ValidationFailed);
				return true;
			},
		);
		assert.strictEqual(calls.length, 0, 'nothing should be sent to DynamoDB');
	});

	test('get filters an expired item DynamoDB has not reaped yet', async () => {
		const store = awsStore('aws-ttl-get-expired');
		interceptDynamo(store, () => ({
			Item: { pk: 'k', value: JSON.stringify('stale'), [TTL_ATTRIBUTE]: nowEpochSeconds() - 1 },
		}));
		assert.strictEqual(await store.get('k'), null);
	});

	test('get returns an item whose ttl is still in the future', async () => {
		const store = awsStore('aws-ttl-get-live');
		interceptDynamo(store, () => ({
			Item: { pk: 'k', value: JSON.stringify('fresh'), [TTL_ATTRIBUTE]: nowEpochSeconds() + 600 },
		}));
		assert.strictEqual(await store.get('k'), 'fresh');
	});

	test('scan filters unreaped expired items', async () => {
		const store = awsStore('aws-ttl-scan');
		interceptDynamo(store, () => ({
			Items: [
				{ pk: 'live', value: JSON.stringify('a') },
				{ pk: 'dead', value: JSON.stringify('b'), [TTL_ATTRIBUTE]: nowEpochSeconds() - 1 },
				{ pk: 'later', value: JSON.stringify('c'), [TTL_ATTRIBUTE]: nowEpochSeconds() + 600 },
			],
		}));

		const seen: string[] = [];
		for await (const { key } of store.scan()) seen.push(key);
		assert.deepStrictEqual(seen, ['live', 'later']);
	});
});

// ── CDK opt-in guard ────────────────────────────────────────────────────────

describe('mock/browser runtimes ignore the ttl construct flag', () => {
	test('{ ttl: true } is accepted and does not change data behavior', async () => {
		const store = new MockKVStore({ id: 'root' } as any, 'ttl-flag', { ttl: true });
		await store.put('k', 'v');
		assert.strictEqual(await store.get('k'), 'v');
		assert.ok(existsSync(storeFile('ttl-flag')));
	});
});
