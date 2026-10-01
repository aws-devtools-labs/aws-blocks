// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { isBlocksError, Scope } from '@aws-blocks/core';
import { z } from 'zod';
import { Secret, SecretErrors } from './index.mock.js';

// Reset mock data between tests so state does not leak. The mock persists to
// the shared `.bb-data/settings.json` under the current working directory.
const BB_DATA = join(process.cwd(), '.bb-data');

function freshScope(): Scope {
	return new Scope('test-app');
}

beforeEach(() => {
	rmSync(BB_DATA, { recursive: true, force: true });
});

describe('Secret (mock)', () => {
	test('get returns null before any value is set', async () => {
		const secret = new Secret(freshScope(), 'api-key');
		assert.strictEqual(await secret.get(), null);
	});

	test('put then get round-trips an opaque string', async () => {
		const secret = new Secret(freshScope(), 'api-key');
		await secret.put('sk_live_abc123');
		assert.strictEqual(await secret.get(), 'sk_live_abc123');
	});

	test('put overwrites a previous value', async () => {
		const secret = new Secret(freshScope(), 'api-key');
		await secret.put('first');
		await secret.put('second');
		assert.strictEqual(await secret.get(), 'second');
	});

	test('distinct instances are isolated by id', async () => {
		const scope = freshScope();
		const a = new Secret(scope, 'secret-a');
		const b = new Secret(scope, 'secret-b');
		await a.put('value-a');
		await b.put('value-b');
		assert.strictEqual(await a.get(), 'value-a');
		assert.strictEqual(await b.get(), 'value-b');
	});

	test('a new instance with the same id reads a persisted value', async () => {
		const scope = freshScope();
		await new Secret(scope, 'api-key').put('persisted');
		// A fresh instance (same fullId) reads what the previous one wrote.
		const reopened = new Secret(freshScope(), 'api-key');
		assert.strictEqual(await reopened.get(), 'persisted');
	});

	describe('with a schema', () => {
		const schema = z.object({ host: z.string(), port: z.number() });

		test('put validates and get returns the typed object', async () => {
			const secret = new Secret(freshScope(), 'db-config', { schema });
			await secret.put({ host: 'db.internal', port: 5432 });
			assert.deepStrictEqual(await secret.get(), { host: 'db.internal', port: 5432 });
		});

		test('put rejects a value that fails validation', async () => {
			const secret = new Secret(freshScope(), 'db-config', { schema });
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
			await new Secret(scope, 'db-config').put('not json');
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
			const secret = new Secret(freshScope(), 'legacy-key', {
				secret: Secret.fromExisting('arn:aws:secretsmanager:us-east-1:123456789012:secret:legacy-AbCdEf'),
			});
			await secret.put('legacy-value');
			assert.strictEqual(await secret.get(), 'legacy-value');
		});
	});

	describe('local storage (shared settings.json)', () => {
		const SETTINGS = join(BB_DATA, 'settings.json');

		test('values are stored in the shared .bb-data/settings.json', async () => {
			const secret = new Secret(freshScope(), 'api-key');
			await secret.put('v1');
			assert.ok(existsSync(SETTINGS), 'settings.json should exist after put()');
			const parsed = JSON.parse(readFileSync(SETTINGS, 'utf8'));
			// Keyed by the instance fullId when no explicit name is given.
			assert.strictEqual(parsed['test-app-api-key'], 'v1');
		});

		test('secrets live alongside the shape AppSetting uses ({ key: value })', async () => {
			const scope = freshScope();
			await new Secret(scope, 'alpha').put('a');
			await new Secret(scope, 'beta').put('b');
			const parsed = JSON.parse(readFileSync(SETTINGS, 'utf8'));
			assert.deepStrictEqual(parsed, { 'test-app-alpha': 'a', 'test-app-beta': 'b' });
		});
	});

	describe('name option', () => {
		const SETTINGS = join(BB_DATA, 'settings.json');

		test('an explicit name keys the local store by that name', async () => {
			const secret = new Secret(freshScope(), 'stripe', { name: 'my-app/stripe-key' });
			await secret.put('sk_live_x');
			const parsed = JSON.parse(readFileSync(SETTINGS, 'utf8'));
			assert.strictEqual(parsed['my-app/stripe-key'], 'sk_live_x');
			// NOT keyed by fullId when a name is provided.
			assert.ok(!('test-app-stripe' in parsed));
		});

		test('two instances sharing a name share the value', async () => {
			await new Secret(freshScope(), 'a', { name: 'shared/key' }).put('one');
			const reopened = new Secret(freshScope(), 'b', { name: 'shared/key' });
			assert.strictEqual(await reopened.get(), 'one');
		});
	});
});
