// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A method that returns nothing answers `"result": null`. `JSON.stringify` drops
 * an `undefined` result, and a response with no `result` field is not a JSON-RPC
 * 2.0 success response: clients that require the field (the Kotlin and Swift
 * native clients) threw on every void call. Runs locally and on a deployed stack.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import type { api as apiType } from 'cdk-blocks';
import { testApiUrl } from './api-url.js';

export function voidResultTests(getApi: () => typeof apiType) {
  test('RPC - a void method answers "result": null on the wire', async () => {
    const response = await fetch(testApiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'api.voidResult', params: [], id: 1 }),
    });
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), { jsonrpc: '2.0', result: null, id: 1 });
  });

  test('RPC - a void method resolves to null through the typed client', async () => {
    assert.strictEqual(await getApi().voidResult(), null);
  });
}
