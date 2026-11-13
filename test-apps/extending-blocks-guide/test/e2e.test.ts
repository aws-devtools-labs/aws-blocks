// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end test against a deployed stack.
 *
 * Prerequisites:
 *   - `npm run deploy` has been run; cdk.outputs.json exists.
 *   - AWS creds with access to the deployed stack.
 *
 * Hits the deployed API Gateway directly (no client SDK) for each pattern.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..');
const OUTPUTS = join(APP_ROOT, 'cdk.outputs.json');

let apiUrl: string;

async function call(method: string, args: unknown[]) {
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiNamespace: 'api', method, args }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

describe('extending-blocks-guide e2e', () => {
  before(() => {
    if (!existsSync(OUTPUTS)) {
      throw new Error(
        `${OUTPUTS} not found. Run 'npm run deploy' inside the test-app first.`
      );
    }
    const raw = JSON.parse(readFileSync(OUTPUTS, 'utf-8'));
    const stackKey = Object.keys(raw)[0];
    apiUrl = raw[stackKey].ApiUrl;
    assert.ok(apiUrl, 'ApiUrl missing from outputs');
  });

  test('Pattern 1: raw SQS via env var', async () => {
    const result = await call('pattern1Enqueue', [{ pattern: 1, ts: Date.now() }]);
    assert.deepStrictEqual(result, { ok: true });
  });

  test('Pattern 2a: KVStore.fromExisting put + get', async () => {
    const token = `tok-${Date.now()}`;
    await call('pattern2Put', [token, 'hello-from-pattern-2']);
    const got = await call('pattern2Get', [token]);
    assert.strictEqual(got.value, 'hello-from-pattern-2');
  });

  test('Pattern 2b: KVStore.fromExisting with a declared key put + get', async () => {
    const user = {
      userId: `user-${Date.now()}`,
      email: 'pattern-2b@example.com',
      createdAt: Date.now(),
    };
    await call('pattern2bPutUser', [user]);
    const got = await call('pattern2bGetUser', [{ userId: user.userId, createdAt: user.createdAt }]);
    assert.deepStrictEqual(got.user, user);
  });

  test('Pattern 3: custom BB enqueue', async () => {
    const result = await call('pattern3Enqueue', [{ pattern: 3, ts: Date.now() }]);
    assert.deepStrictEqual(result, { ok: true });
  });
});
