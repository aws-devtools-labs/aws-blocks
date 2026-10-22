// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { callRpc, callTestSupport, TEST_SUPPORT_METHODS } from './test-support.js';

/**
 * The `testSupport` methods create accounts, drive the whole `authC.admin`
 * surface, read and overwrite a secret setting, and sweep the delivered codes.
 * On an e2e build (every run of this harness) each one must refuse a caller
 * without the build's secret, before doing anything. A normal build registers
 * none of them (`test-support-synth.test.ts`). The success paths run wherever a
 * suite uses them (`provisionConfirmedUser`, `getTestSupport`).
 */
export function testSupportGateTests() {
  describe('Test support endpoints are gated', () => {
    for (const method of TEST_SUPPORT_METHODS) {
      test(`testSupport.${method} refuses a wrong secret`, { timeout: 15_000 }, async () => {
        const probe = `e2e-gate-${Date.now().toString(36)}`;
        const body = await callTestSupport(method, ['not-the-secret', probe, 'password123', probe]);
        assert.strictEqual(body.result, undefined, `Expected no result, got: ${JSON.stringify(body)}`);
        assert.strictEqual(body.error?.code, 403, `Unexpected response: ${JSON.stringify(body)}`);
      });

      // Each one used to be an ungated `api.*` method (`provisionUser` was
      // `api.authProvisionUser`). None may survive there.
      const legacy = method === 'provisionUser' ? 'authProvisionUser' : method;
      test(`the ungated api.${legacy} route no longer exists`, { timeout: 15_000 }, async () => {
        const probe = `e2e-gate-old-${Date.now().toString(36)}`;
        const body = await callRpc(`api.${legacy}`, [probe, 'password123', probe]);
        assert.strictEqual(body.result, undefined, `Expected no result, got: ${JSON.stringify(body)}`);
        assert.strictEqual(body.error?.code, -32601, `Unexpected response: ${JSON.stringify(body)}`);
      });
    }
  });
}
