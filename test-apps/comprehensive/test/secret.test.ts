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
  // AWS Secrets Manager is NOT strongly read-after-write consistent: a
  // GetSecretValue immediately after a PutSecretValue can still return a prior
  // value until the write propagates. These tests write then read the same
  // secret back-to-back, so a single immediate get() flakes on real AWS
  // (observed: a `grace window` read returning a value from two tests earlier).
  // Poll the read until it converges on the expected value (bounded); locally
  // the mock is instant so this returns on the first attempt. The read itself is
  // ordinary customer usage — only the retry loop is test plumbing.
  async function pollUntil<T>(
    read: () => Promise<T>,
    predicate: (value: T) => boolean,
    { timeoutMs = 15000, intervalMs = 500 }: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last = await read();
    while (!predicate(last) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, intervalMs));
      last = await read();
    }
    return last;
  }

  describe('Secret BB', () => {
    test('Secret - opaque string put then get round-trips', async () => {
      const { testSupport, secret } = await getTestSupport();
      await testSupport.secretPutApiKey(secret, 'sk-test-abc123');
      const { value } = await pollUntil(() => testSupport.secretGetApiKey(secret), (r) => r.value === 'sk-test-abc123');
      assert.strictEqual(value, 'sk-test-abc123');
    });

    test('Secret - put overwrites the previous value', async () => {
      const { testSupport, secret } = await getTestSupport();
      await testSupport.secretPutApiKey(secret, 'sk-test-first');
      await testSupport.secretPutApiKey(secret, 'sk-test-second');
      const { value } = await pollUntil(() => testSupport.secretGetApiKey(secret), (r) => r.value === 'sk-test-second');
      assert.strictEqual(value, 'sk-test-second');
    });

    test('Secret - typed JSON secret put then get returns the typed object', async () => {
      const { testSupport, secret } = await getTestSupport();
      await testSupport.secretPutDbCredentials(secret, { host: 'db.internal', port: 5432 });
      const { value } = await pollUntil(
        () => testSupport.secretGetDbCredentials(secret),
        (r) => r.value?.host === 'db.internal' && r.value?.port === 5432,
      );
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
      const { value } = await pollUntil(() => testSupport.secretGetNamed(secret), (r) => r.value === 'whsec_abc123');
      assert.strictEqual(value, 'whsec_abc123');
    });

    test('Secret - previous version is readable after a change (grace window)', async () => {
      const { testSupport, secret } = await getTestSupport();
      await testSupport.secretPutApiKey(secret, 'sk-old');
      await testSupport.secretPutApiKey(secret, 'sk-new');
      // Poll for Secrets Manager to converge on the post-rotation state before
      // asserting the current/previous pair.
      const current = (await pollUntil(() => testSupport.secretGetApiKey(secret), (r) => r.value === 'sk-new')).value;
      const previous = (await pollUntil(() => testSupport.secretGetApiKeyPrevious(secret), (r) => r.value === 'sk-old')).value;
      assert.strictEqual(current, 'sk-new');
      assert.strictEqual(previous, 'sk-old');
    });

    test('Secret - listVersions returns current + previous with stage labels', async () => {
      const { testSupport, secret } = await getTestSupport();
      await testSupport.secretPutApiKey(secret, 'sk-1');
      await testSupport.secretPutApiKey(secret, 'sk-2');
      // Wait for both labeled versions to be present before asserting the labels.
      const versions = await pollUntil(
        () => testSupport.secretListApiKeyVersions(secret),
        (vs) =>
          vs.some((v) => v.stages.includes('AWSCURRENT')) && vs.some((v) => v.stages.includes('AWSPREVIOUS')),
      );
      assert.ok(versions.length >= 2);
      // Newest-first: first is current, includes a previous.
      assert.ok(versions.some((v) => v.stages.includes('AWSCURRENT')));
      assert.ok(versions.some((v) => v.stages.includes('AWSPREVIOUS')));
    });

    // allowRuntimeWrite matrix — the three cases, asserted end to end.
    //
    // Build/type behavior is proven in the backend module itself
    // (aws-blocks/index.ts `_secretWriteTypeAssertions`): the read-only secrets
    // carry `@ts-expect-error` on `.put`, and the writable one calls `.put` with
    // a correctly-typed value and `@ts-expect-error` on a wrong-typed value. That
    // module is compiled as part of this e2e build/synth, so a regression (put
    // reappearing on the read-only type, or the writable type going wrong) fails
    // this suite at build time. The runtime behavior is asserted below.

    test('Secret (allowRuntimeWrite omitted) - put absent at runtime; forced call errors', async () => {
      const { testSupport, secret } = await getTestSupport();
      const { hasPut, callError } = await testSupport.secretWriteProbeOmitted(secret);
      assert.strictEqual(hasPut, false, 'put must be absent from a read-only secret object');
      // A customer who bypasses the type and calls put() gets a meaningful error.
      assert.strictEqual(callError, 'TypeError', 'forcing a call to the absent put() must throw TypeError');
    });

    test('Secret (allowRuntimeWrite: false) - put absent at runtime; forced call errors', async () => {
      const { testSupport, secret } = await getTestSupport();
      const { hasPut, callError } = await testSupport.secretWriteProbeFalse(secret);
      assert.strictEqual(hasPut, false, 'put must be absent when allowRuntimeWrite is false');
      assert.strictEqual(callError, 'TypeError', 'forcing a call to the absent put() must throw TypeError');
    });

    test('Secret (allowRuntimeWrite: true) - put present, callable, round-trips', async () => {
      const { testSupport, secret } = await getTestSupport();
      // The probe does put→get server-side; poll it so a Secrets Manager
      // read-after-write lag resolves (re-writing the same value is idempotent).
      const { hasPut, readBack } = await pollUntil(
        () => testSupport.secretWriteProbeTrue(secret, 'write-enabled-value'),
        (r) => r.readBack === 'write-enabled-value',
      );
      assert.strictEqual(hasPut, true, 'put must be present when allowRuntimeWrite is true');
      assert.strictEqual(readBack, 'write-enabled-value', 'the written value must read back');
    });
  });
}
