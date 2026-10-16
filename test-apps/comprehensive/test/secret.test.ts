// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import type { api as apiType } from 'aws-blocks';
import { getTestSupport } from './test-support.js';

/**
 * E2E tests for the Secret Building Block. Exercised by the shared suite in
 * e2e.test.ts against local (dev server), sandbox, and production via
 * BLOCKS_TEST_ENV. These represent real customer usage — no type casts.
 *
 * A secret's value is not something to serve to any caller, so the app exposes
 * these round-trips only on the secret-gated `testSupport` namespace (as it does
 * for the `AppSetting` secret).
 */
export function secretTests(_getApi: () => typeof apiType) {
  describe('Secret BB', () => {
    test('Secret - opaque string put then get round-trips', async () => {
      const { testSupport, secret } = await getTestSupport();
      await testSupport.secretPutApiKey(secret, 'sk-test-abc123');
      const { value } = await testSupport.secretGetApiKey(secret);
      assert.strictEqual(value, 'sk-test-abc123');
    });

    test('Secret - put overwrites the previous value', async () => {
      const { testSupport, secret } = await getTestSupport();
      await testSupport.secretPutApiKey(secret, 'sk-test-first');
      await testSupport.secretPutApiKey(secret, 'sk-test-second');
      const { value } = await testSupport.secretGetApiKey(secret);
      assert.strictEqual(value, 'sk-test-second');
    });

    test('Secret - typed JSON secret put then get returns the typed object', async () => {
      const { testSupport, secret } = await getTestSupport();
      await testSupport.secretPutDbCredentials(secret, { host: 'db.internal', port: 5432 });
      const { value } = await testSupport.secretGetDbCredentials(secret);
      assert.deepStrictEqual(value, { host: 'db.internal', port: 5432 });
    });

    test('Secret - typed secret rejects a value that fails schema validation', async () => {
      const { testSupport, secret } = await getTestSupport();
      await assert.rejects(
        () => testSupport.secretPutDbCredentialsInvalid(secret, { host: 'db.internal', port: 'not-a-number' }),
        /ValidationFailedException/,
      );
    });

    test('Secret - an unset secret reads null before any put', async () => {
      const { testSupport, secret } = await getTestSupport();
      // secretGetUnset maps to a Secret created without `generate` and never
      // written. On AWS the default L2 behavior would seed a random 32-char
      // value; the empty-secret fix makes this null, matching the mock.
      const { value } = await testSupport.secretGetUnset(secret);
      assert.strictEqual(value, null);
    });

    test('Secret - a generated secret has a non-null value before any put', async () => {
      const { testSupport, secret } = await getTestSupport();
      // `generate: true` seeds a random value on first create, so get() returns
      // a non-null string with no prior put().
      const { value } = await testSupport.secretGetGenerated(secret);
      assert.ok(value !== null, 'generated secret should have a value before any put');
      assert.strictEqual(typeof value, 'string');
      assert.ok(value.length > 0);
    });

    test('Secret - named secret put then get round-trips', async () => {
      const { testSupport, secret } = await getTestSupport();
      await testSupport.secretPutNamed(secret, 'whsec_abc123');
      const { value } = await testSupport.secretGetNamed(secret);
      assert.strictEqual(value, 'whsec_abc123');
    });

    test('Secret - previous version is readable after a change (grace window)', async () => {
      const { testSupport, secret } = await getTestSupport();
      await testSupport.secretPutApiKey(secret, 'sk-old');
      await testSupport.secretPutApiKey(secret, 'sk-new');
      const current = (await testSupport.secretGetApiKey(secret)).value;
      const previous = (await testSupport.secretGetApiKeyPrevious(secret)).value;
      assert.strictEqual(current, 'sk-new');
      assert.strictEqual(previous, 'sk-old');
    });

    test('Secret - listVersions returns current + previous with stage labels', async () => {
      const { testSupport, secret } = await getTestSupport();
      await testSupport.secretPutApiKey(secret, 'sk-1');
      await testSupport.secretPutApiKey(secret, 'sk-2');
      const versions = await testSupport.secretListApiKeyVersions(secret);
      assert.ok(versions.length >= 2);
      // Newest-first: first is current, includes a previous.
      assert.ok(versions.some((v) => v.stages.includes('AWSCURRENT')));
      assert.ok(versions.some((v) => v.stages.includes('AWSPREVIOUS')));
    });
  });
}
