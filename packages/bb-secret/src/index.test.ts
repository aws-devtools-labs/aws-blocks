// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { isBlocksError, Scope } from '@aws-blocks/core';
import { z } from 'zod';
import { Secret, SecretErrors, type SecretOptions, type WritableSecret } from './index.mock.js';

// Reset mock data between tests so state does not leak. The mock persists to
// the shared `.bb-data/settings.json` under the current working directory.
const BB_DATA = join(process.cwd(), '.bb-data');

function freshScope(): Scope {
	return new Scope('test-app');
}

/**
 * Construct a write-enabled Secret. Writes are opt-in (`allowRuntimeWrite`), so
 * every test that calls `put()` builds its instance through here. The explicit
 * `allowRuntimeWrite: true` overload returns a {@link WritableSecret} (with
 * `put`), with no cast at the call site.
 */
function writable<T = string>(
	scope: Scope,
	id: string,
	options?: Omit<SecretOptions<T>, 'allowRuntimeWrite'>,
): WritableSecret<T> {
	return new Secret<T>(scope, id, { ...options, allowRuntimeWrite: true });
}

beforeEach(() => {
	rmSync(BB_DATA, { recursive: true, force: true });
});

describe('Secret (mock)', () => {
	test('get returns null before any value is set', async () => {
		const secret = new Secret(freshScope(), 'api-key');
		assert.strictEqual(await secret.get(), null);
	});

	describe('allowRuntimeWrite', () => {
		test('put is absent from the instance by default (read-only)', () => {
			const secret = new Secret(freshScope(), 'api-key');
			// Absent from the object at runtime, not just the type.
			assert.strictEqual('put' in secret, false);
			assert.strictEqual((secret as { put?: unknown }).put, undefined);
		});

		test('allowRuntimeWrite: true exposes a working put()', async () => {
			const secret = writable(freshScope(), 'api-key');
			assert.strictEqual(typeof secret.put, 'function');
			await secret.put('written');
			assert.strictEqual(await secret.get(), 'written');
		});

		test('allowRuntimeWrite: false is read-only (put absent)', () => {
			const secret = new Secret(freshScope(), 'api-key', { allowRuntimeWrite: false });
			assert.strictEqual('put' in secret, false);
		});

		test('a fromExisting secret is read-only by default too', () => {
			const secret = new Secret(freshScope(), 'legacy', {
				secret: Secret.fromExisting('arn:aws:secretsmanager:us-east-1:123456789012:secret:legacy-AbCdEf'),
			});
			assert.strictEqual('put' in secret, false);
		});
	});

	test('generate:true seeds a non-null random value on first construction', async () => {
		const secret = new Secret(freshScope(), 'signing-key', { generate: true });
		const value = await secret.get();
		assert.ok(value !== null, 'generated secret should have a value before any put');
		assert.strictEqual(typeof value, 'string');
		assert.ok(value.length > 0);
	});

	test('generate:true does not overwrite an existing value on re-construction', async () => {
		const scope = freshScope();
		const first = new Secret(scope, 'signing-key', { generate: true });
		const seeded = await first.get();
		// A second instance of the same secret must not re-seed (deploy-once).
		const second = new Secret(scope, 'signing-key', { generate: true });
		assert.strictEqual(await second.get(), seeded);
	});

	test('generate:true leaves an explicitly put() value intact', async () => {
		const scope = freshScope();
		const secret = writable(scope, 'signing-key', { generate: true });
		await secret.put('explicit');
		const reopened = new Secret(scope, 'signing-key', { generate: true });
		assert.strictEqual(await reopened.get(), 'explicit');
	});

	test('put then get round-trips an opaque string', async () => {
		const secret = writable(freshScope(), 'api-key');
		await secret.put('sk_live_abc123');
		assert.strictEqual(await secret.get(), 'sk_live_abc123');
	});

	test('put overwrites a previous value', async () => {
		const secret = writable(freshScope(), 'api-key');
		await secret.put('first');
		await secret.put('second');
		assert.strictEqual(await secret.get(), 'second');
	});

	test('distinct instances are isolated by id', async () => {
		const scope = freshScope();
		const a = writable(scope, 'secret-a');
		const b = writable(scope, 'secret-b');
		await a.put('value-a');
		await b.put('value-b');
		assert.strictEqual(await a.get(), 'value-a');
		assert.strictEqual(await b.get(), 'value-b');
	});

	test('a new instance with the same id reads a persisted value', async () => {
		const scope = freshScope();
		await writable(scope, 'api-key').put('persisted');
		// A fresh instance (same fullId) reads what the previous one wrote.
		const reopened = new Secret(freshScope(), 'api-key');
		assert.strictEqual(await reopened.get(), 'persisted');
	});

	describe('with a schema', () => {
		const schema = z.object({ host: z.string(), port: z.number() });

		test('put validates and get returns the typed object', async () => {
			const secret = writable(freshScope(), 'db-config', { schema });
			await secret.put({ host: 'db.internal', port: 5432 });
			assert.deepStrictEqual(await secret.get(), { host: 'db.internal', port: 5432 });
		});

		test('put rejects a value that fails validation', async () => {
			const secret = writable(freshScope(), 'db-config', { schema });
			await assert.rejects(
				// @ts-expect-error — intentionally wrong shape to exercise validation
				() => secret.put({ host: 'db.internal', port: 'not-a-number' }),
				(e: unknown) => isBlocksError(e, SecretErrors.ValidationFailed),
			);
		});

		test('get returns null before any value is set', async () => {
			const secret = new Secret(freshScope(), 'db-config', { schema });
			assert.strictEqual(await secret.get(), null);
		});

		test('get throws ValidationFailed when stored value is not valid JSON', async () => {
			const scope = freshScope();
			// Write a raw (non-JSON) string via a schemaless instance, then read it
			// back through a schema'd instance with the same id.
			await writable(scope, 'db-config').put('not json');
			const typed = new Secret<{ host: string; port: number }>(freshScope(), 'db-config', { schema });
			await assert.rejects(
				() => typed.get(),
				(e: unknown) => isBlocksError(e, SecretErrors.ValidationFailed),
			);
		});
	});

	describe('fromExisting', () => {
		test('returns a branded reference carrying the ARN', () => {
			const ref = Secret.fromExisting('arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret-AbCdEf');
			assert.strictEqual(ref.__brand, 'ExternalSecretRef');
			assert.strictEqual(ref.secretArn, 'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret-AbCdEf');
		});

		test('a wrapped secret still round-trips locally', async () => {
			const secret = writable(freshScope(), 'legacy-key', {
				secret: Secret.fromExisting('arn:aws:secretsmanager:us-east-1:123456789012:secret:legacy-AbCdEf'),
			});
			await secret.put('legacy-value');
			assert.strictEqual(await secret.get(), 'legacy-value');
		});
	});

	describe('local storage (shared settings.json)', () => {
		const SETTINGS = join(BB_DATA, 'settings.json');

		test('values are stored in the shared .bb-data/settings.json', async () => {
			const secret = writable(freshScope(), 'api-key');
			await secret.put('v1');
			assert.ok(existsSync(SETTINGS), 'settings.json should exist after put()');
			const parsed = JSON.parse(readFileSync(SETTINGS, 'utf8'));
			// Keyed by the instance fullId when no explicit name is given.
			assert.strictEqual(parsed['test-app-api-key'], 'v1');
		});

		test('secrets live alongside the shape AppSetting uses ({ key: value })', async () => {
			const scope = freshScope();
			await writable(scope, 'alpha').put('a');
			await writable(scope, 'beta').put('b');
			const parsed = JSON.parse(readFileSync(SETTINGS, 'utf8'));
			assert.deepStrictEqual(parsed, { 'test-app-alpha': 'a', 'test-app-beta': 'b' });
		});
	});

	describe('name option', () => {
		const SETTINGS = join(BB_DATA, 'settings.json');

		test('an explicit name keys the local store by that name', async () => {
			const secret = writable(freshScope(), 'stripe', { name: 'my-app/stripe-key' });
			await secret.put('sk_live_x');
			const parsed = JSON.parse(readFileSync(SETTINGS, 'utf8'));
			assert.strictEqual(parsed['my-app/stripe-key'], 'sk_live_x');
			// NOT keyed by fullId when a name is provided.
			assert.ok(!('test-app-stripe' in parsed));
		});

		test('two instances sharing a name share the value', async () => {
			await writable(freshScope(), 'a', { name: 'shared/key' }).put('one');
			const reopened = new Secret(freshScope(), 'b', { name: 'shared/key' });
			assert.strictEqual(await reopened.get(), 'one');
		});
	});

	describe('version retrieval', () => {
		test('get({ version: "previous" }) is null until the value changes', async () => {
			const secret = writable(freshScope(), 'signing-key');
			assert.strictEqual(await secret.get({ version: 'previous' }), null);
			await secret.put('v1');
			// Only one version so far — still no previous.
			assert.strictEqual(await secret.get({ version: 'previous' }), null);
		});

		test('after a change, current and previous reflect the last two values', async () => {
			const secret = writable(freshScope(), 'signing-key');
			await secret.put('v1');
			await secret.put('v2');
			assert.strictEqual(await secret.get(), 'v2');
			assert.strictEqual(await secret.get({ version: 'current' }), 'v2');
			assert.strictEqual(await secret.get({ version: 'previous' }), 'v1');
		});

		test('only current + previous are retained (2-deep)', async () => {
			const secret = writable(freshScope(), 'signing-key');
			await secret.put('v1');
			await secret.put('v2');
			await secret.put('v3');
			assert.strictEqual(await secret.get(), 'v3');
			assert.strictEqual(await secret.get({ version: 'previous' }), 'v2');
			const versions = await secret.listVersions();
			assert.strictEqual(versions.length, 2);
		});

		test('listVersions returns metadata newest-first with AWSCURRENT/AWSPREVIOUS stages', async () => {
			const secret = writable(freshScope(), 'signing-key');
			await secret.put('v1');
			await secret.put('v2');
			const versions = await secret.listVersions();
			assert.deepStrictEqual(
				versions.map((v) => v.stages),
				[['AWSCURRENT'], ['AWSPREVIOUS']],
			);
			for (const v of versions) {
				assert.ok(typeof v.versionId === 'string' && v.versionId.length > 0);
				assert.ok(v.createdDate instanceof Date);
			}
			// SecretVersionInfo items never carry the value.
			assert.ok(!('value' in versions[0]));
		});

		test('get accepts a SecretVersion handle from listVersions', async () => {
			const secret = writable(freshScope(), 'signing-key');
			await secret.put('v1');
			await secret.put('v2');
			const versions = await secret.listVersions();
			// versions[1] is AWSPREVIOUS → value v1; pass the handle straight back to get().
			assert.strictEqual(await secret.get({ version: versions[1] }), 'v1');
			assert.strictEqual(await secret.get({ version: versions[0] }), 'v2');
		});

		test('listVersions is empty before any value is set', async () => {
			const secret = new Secret(freshScope(), 'signing-key');
			assert.deepStrictEqual(await secret.listVersions(), []);
		});
	});
});
