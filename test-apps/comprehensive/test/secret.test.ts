// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import type { api as apiType } from 'aws-blocks';

/**
 * E2E tests for the Secret Building Block. Exercised by the shared suite in
 * e2e.test.ts against local (dev server), sandbox, and production via
 * BLOCKS_TEST_ENV. These represent real customer usage — no type casts.
 */
export function secretTests(getApi: () => typeof apiType) {
  describe('Secret BB', () => {
    test('Secret - opaque string put then get round-trips', async () => {
      const api = getApi();
      await api.secretPutApiKey('sk-test-abc123');
      const { value } = await api.secretGetApiKey();
      assert.strictEqual(value, 'sk-test-abc123');
    });

    test('Secret - put overwrites the previous value', async () => {
      const api = getApi();
      await api.secretPutApiKey('sk-test-first');
      await api.secretPutApiKey('sk-test-second');
      const { value } = await api.secretGetApiKey();
      assert.strictEqual(value, 'sk-test-second');
    });

    test('Secret - typed JSON secret put then get returns the typed object', async () => {
      const api = getApi();
      await api.secretPutDbCredentials({ host: 'db.internal', port: 5432 });
      const { value } = await api.secretGetDbCredentials();
      assert.deepStrictEqual(value, { host: 'db.internal', port: 5432 });
    });

    test('Secret - typed secret rejects a value that fails schema validation', async () => {
      const api = getApi();
      await assert.rejects(
        () => api.secretPutDbCredentialsInvalid({ host: 'db.internal', port: 'not-a-number' }),
        /ValidationFailedException/,
      );
    });

    test('Secret - an unset secret reads null before any put', async () => {
      const api = getApi();
      // secretGetUnset maps to a Secret created without `generate` and never
      // written. On AWS the default L2 behavior would seed a random 32-char
      // value; the empty-secret fix makes this null, matching the mock.
      const { value } = await api.secretGetUnset();
      assert.strictEqual(value, null);
    });

    test('Secret - a generated secret has a non-null value before any put', async () => {
      const api = getApi();
      // `generate: true` seeds a random value on first create, so get() returns
      // a non-null string with no prior put().
      const { value } = await api.secretGetGenerated();
      assert.ok(value !== null, 'generated secret should have a value before any put');
      assert.strictEqual(typeof value, 'string');
      assert.ok(value.length > 0);
    });

    test('Secret - named secret put then get round-trips', async () => {
      const api = getApi();
      await api.secretPutNamed('whsec_abc123');
      const { value } = await api.secretGetNamed();
      assert.strictEqual(value, 'whsec_abc123');
    });

    test('Secret - previous version is readable after a change (grace window)', async () => {
      const api = getApi();
      await api.secretPutApiKey('sk-old');
      await api.secretPutApiKey('sk-new');
      const current = (await api.secretGetApiKey()).value;
      const previous = (await api.secretGetApiKeyPrevious()).value;
      assert.strictEqual(current, 'sk-new');
      assert.strictEqual(previous, 'sk-old');
    });

    test('Secret - listVersions returns current + previous with stage labels', async () => {
      const api = getApi();
      await api.secretPutApiKey('sk-1');
      await api.secretPutApiKey('sk-2');
      const versions = await api.secretListApiKeyVersions();
      assert.ok(versions.length >= 2);
      // Newest-first: first is current, includes a previous.
      assert.ok(versions.some((v) => v.stages.includes('AWSCURRENT')));
      assert.ok(versions.some((v) => v.stages.includes('AWSPREVIOUS')));
    });
  });
}
