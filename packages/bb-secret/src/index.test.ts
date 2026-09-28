// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { isBlocksError, Scope } from '@aws-blocks/core';
import { z } from 'zod';
import { Secret, SecretErrors } from './index.mock.js';

// Reset mock data between tests so state does not leak. The mock persists to
// `.bb-data/{fullId}/secret` under the current working directory.
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
});
