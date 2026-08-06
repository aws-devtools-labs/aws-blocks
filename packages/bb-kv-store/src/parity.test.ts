// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for KVStore mock/browser parity and conditional operation correctness.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { KVStore, KVStoreErrors } from './index.mock.js';
import { KVStore as AwsKVStore } from './index.aws.js';
import { TTL_ATTRIBUTE, nowEpochSeconds } from './ttl.js';
import { z } from 'zod';

beforeEach(() => {
	try { rmSync('.bb-data', { recursive: true, force: true }); } catch {}
});

// Browser entry must export error constants for client-side error handling

describe('browser entry exports error constants', () => {
	test('browser entry exports KVStoreErrors matching the mock', async () => {
		const browser = await import('./index.browser.js');
		assert.deepStrictEqual(
			(browser as any).KVStoreErrors,
			KVStoreErrors,
		);
	});
});

// Schema validation must run before conditional checks to match AWS behavior.
// The AWS entry validates client-side before sending to DynamoDB, so the mock
// must do the same — otherwise error-handling code written against the mock
// handles the wrong exception type in production.

describe('schema validation runs before conditional checks', () => {
	test('invalid value + ifNotExists on existing key throws ValidationFailed', async () => {
		
		const schema = z.object({ name: z.string().min(3) });
		const store = new KVStore({ id: 'root' } as any, 'val-order-1', { schema });

		await store.put('key1', { name: 'valid' } as any);

		await assert.rejects(
			() => store.put('key1', { name: 'x' } as any, { ifNotExists: true }),
			(err: any) => {
				assert.strictEqual(err.name, 'ValidationFailedException',
					'Schema validation must run first — invalid data should never reach the condition check');
				return true;
			},
		);
	});

	test('invalid value + ifValueEquals mismatch throws ValidationFailed', async () => {
		
		const schema = z.object({ count: z.number().min(0) });
		const store = new KVStore({ id: 'root' } as any, 'val-order-2', { schema });

		await store.put('counter', { count: 5 } as any);

		await assert.rejects(
			() => store.put('counter', { count: -1 } as any, { ifValueEquals: { count: 999 } as any }),
			(err: any) => {
				assert.strictEqual(err.name, 'ValidationFailedException');
				return true;
			},
		);
	});

	test('valid value + failing condition still throws ConditionalCheckFailed', async () => {
		
		const schema = z.object({ name: z.string().min(3) });
		const store = new KVStore({ id: 'root' } as any, 'val-order-3', { schema });

		await store.put('key1', { name: 'valid' } as any);

		await assert.rejects(
			() => store.put('key1', { name: 'also-valid' } as any, { ifNotExists: true }),
			(err: any) => {
				assert.strictEqual(err.name, KVStoreErrors.ConditionalCheckFailed);
				return true;
			},
		);
	});
});

// Passing { ifValueEquals: undefined } must be treated as "no condition".
// Using `'ifValueEquals' in obj` is true for explicit undefined, which causes
// a false ConditionalCheckFailed (mock) or SDK marshalling error (AWS).

describe('ifValueEquals: undefined is treated as no-op', () => {
	test('put with ifValueEquals: undefined overwrites normally', async () => {
		const store = new KVStore({ id: 'root' } as any, 'undef-put');
		await store.put('key1', 'hello');

		await store.put('key1', 'updated', { ifValueEquals: undefined } as any);
		assert.strictEqual(await store.get('key1'), 'updated');
	});

	test('put with ifValueEquals: undefined on new key succeeds', async () => {
		const store = new KVStore({ id: 'root' } as any, 'undef-put-new');

		await store.put('newkey', 'value', { ifValueEquals: undefined } as any);
		assert.strictEqual(await store.get('newkey'), 'value');
	});

	test('delete with ifValueEquals: undefined removes the key', async () => {
		const store = new KVStore({ id: 'root' } as any, 'undef-del');
		await store.put('key1', 'hello');

		await store.delete('key1', { ifValueEquals: undefined } as any);
		assert.strictEqual(await store.get('key1'), null);
	});

	test('delete with ifValueEquals: undefined on missing key succeeds silently', async () => {
		const store = new KVStore({ id: 'root' } as any, 'undef-del-new');
		await store.delete('nonexistent', { ifValueEquals: undefined } as any);
	});
});

// TTL parity. DynamoDB's reaper is asynchronous, so an expired item can still
// be physically present; both runtimes must therefore hide expired items on
// read, and neither may write the `ttl` attribute unless asked. Divergence here
// means code that self-expires sessions locally silently retains them in AWS.

/**
 * Capture what the AWS runtime would send to DynamoDB and control what it reads
 * back, without touching the network. Real `KVStore`, real `PutCommand`.
 */
function captureAws(id: string, respond: () => any = () => ({})): {
	store: AwsKVStore<string>;
	items: () => any[];
} {
	const store = new AwsKVStore<string>({ id: 'root' } as any, id);
	const sent: any[] = [];
	(store as any).docClient.middlewareStack.add(
		(_next: any) => async (args: any) => {
			sent.push(args.input);
			return { output: respond() };
		},
		{ step: 'initialize', name: 'kv-parity-intercept', override: true },
	);
	return { store, items: () => sent };
}

describe('TTL parity between mock and AWS runtimes', () => {
	test('neither runtime writes a ttl attribute when none is requested', async () => {
		const mock = new KVStore({ id: 'root' } as any, 'parity-no-ttl');
		await mock.put('k', 'v');
		assert.strictEqual(await mock.get('k'), 'v');

		const { store, items } = captureAws('parity-no-ttl-aws');
		await store.put('k', 'v');
		assert.ok(!(TTL_ATTRIBUTE in items()[0].Item));
	});

	test('both runtimes hide an item whose expiry has passed', async () => {
		const expired = nowEpochSeconds() - 1;

		const mock = new KVStore({ id: 'root' } as any, 'parity-expired');
		await mock.put('k', 'v', { expiresAt: expired });
		assert.strictEqual(await mock.get('k'), null);

		const { store } = captureAws('parity-expired-aws', () => ({
			Item: { pk: 'k', value: JSON.stringify('v'), [TTL_ATTRIBUTE]: expired },
		}));
		assert.strictEqual(await store.get('k'), null);
	});

	test('both runtimes still return an item whose expiry is in the future', async () => {
		const future = nowEpochSeconds() + 600;

		const mock = new KVStore({ id: 'root' } as any, 'parity-live');
		await mock.put('k', 'v', { expiresAt: future });
		assert.strictEqual(await mock.get('k'), 'v');

		const { store } = captureAws('parity-live-aws', () => ({
			Item: { pk: 'k', value: JSON.stringify('v'), [TTL_ATTRIBUTE]: future },
		}));
		assert.strictEqual(await store.get('k'), 'v');
	});

	test('both runtimes skip expired items during scan', async () => {
		const expired = nowEpochSeconds() - 1;

		const mock = new KVStore({ id: 'root' } as any, 'parity-scan');
		await mock.put('live', 'a');
		await mock.put('dead', 'b', { expiresAt: expired });
		const mockKeys: string[] = [];
		for await (const { key } of mock.scan()) mockKeys.push(key);
		assert.deepStrictEqual(mockKeys, ['live']);

		const { store } = captureAws('parity-scan-aws', () => ({
			Items: [
				{ pk: 'live', value: JSON.stringify('a') },
				{ pk: 'dead', value: JSON.stringify('b'), [TTL_ATTRIBUTE]: expired },
			],
		}));
		const awsKeys: string[] = [];
		for await (const { key } of store.scan()) awsKeys.push(key);
		assert.deepStrictEqual(awsKeys, mockKeys);
	});

	test('both runtimes reject the same invalid TTL options with the same error name', async () => {
		const bad = [
			{ ttlSeconds: 60, expiresAt: 123456 },
			{ ttlSeconds: 0 },
			{ ttlSeconds: -1 },
			{ expiresAt: Date.now() },
		] as const;

		const mock = new KVStore({ id: 'root' } as any, 'parity-invalid');
		const { store } = captureAws('parity-invalid-aws');

		for (const options of bad) {
			const label = JSON.stringify(options);
			await assert.rejects(() => mock.put('k', 'v', options as any), (err: any) => {
				assert.strictEqual(err.name, KVStoreErrors.ValidationFailed, `mock: ${label}`);
				return true;
			});
			await assert.rejects(() => store.put('k', 'v', options as any), (err: any) => {
				assert.strictEqual(err.name, KVStoreErrors.ValidationFailed, `aws: ${label}`);
				return true;
			});
		}
	});
});
