// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `ApiNamespace`'s `httpErrorStatus` option, end to end: the same signed-out
 * `requireAuth()` call answers HTTP 401 on `strictStatusApi` (option on) and
 * HTTP 200 on `api` (the default), and the typed client rejects with the same
 * `ApiError` either way. Runs locally and on a deployed stack (the Lambda
 * handler sets the status the same way the dev server does).
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { ApiError, isBlocksError } from '@aws-blocks/core';
import { AuthErrors, isAuthError } from '@aws-blocks/bb-auth';
import type { api as apiType, strictStatusApi as strictStatusApiType } from 'aws-blocks';

/** Run `call` with a `fetch` spy (test plumbing) that records the HTTP status of every response. */
async function statusesOf(call: () => Promise<unknown>): Promise<{ statuses: number[]; error: unknown }> {
  const statuses: number[] = [];
  const originalFetch = global.fetch;
  global.fetch = (async (...args: Parameters<typeof fetch>) => {
    const response = await originalFetch(...args);
    statuses.push(response.status);
    return response;
  }) as typeof fetch;
  try {
    await call();
    return { statuses, error: undefined };
  } catch (error) {
    return { statuses, error };
  } finally {
    global.fetch = originalFetch;
  }
}

export function httpErrorStatusTests(getApis: () => { api: typeof apiType; strictStatusApi: typeof strictStatusApiType }) {
  test('ApiNamespace httpErrorStatus - a signed-out call is HTTP 401 with the option, 200 without; the client error is the same', async () => {
    const { api, strictStatusApi } = getApis();
    // No session for `auth`: sign out first (clears any session cookie in the jar).
    await api.authSignOut();

    const strict = await statusesOf(() => strictStatusApi.authRequired());
    const plain = await statusesOf(() => api.authRequired());

    assert.deepStrictEqual(strict.statuses, [401], 'httpErrorStatus: the HTTP status is the ApiError status');
    assert.deepStrictEqual(plain.statuses, [200], 'default: the HTTP status stays 200');

    for (const { error } of [strict, plain]) {
      assert.ok(error instanceof ApiError, `expected an ApiError, got ${String(error)}`);
      assert.strictEqual(error.status, 401);
      assert.ok(isBlocksError(error, AuthErrors.NotAuthenticated), `expected ${AuthErrors.NotAuthenticated}, got ${error.name}`);
      assert.ok(isAuthError(error, AuthErrors.NotAuthenticated));
    }
    assert.ok(strict.error instanceof ApiError && plain.error instanceof ApiError);
    assert.strictEqual(strict.error.message, plain.error.message, 'the same error, whatever the HTTP status');
  });
}
