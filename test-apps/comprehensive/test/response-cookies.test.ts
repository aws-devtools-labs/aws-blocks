// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import type { api as apiType } from 'aws-blocks';
import { provisionConfirmedUser } from './test-support.js';

/**
 * Multiple `Set-Cookie` values from one API method must all reach the client.
 * On an error response only cookie deletions do (a 401 that clears a session
 * cookie); a method that signs a user in and then throws must not issue one.
 *
 * On AWS the backend sits behind an API Gateway REST Lambda proxy, whose
 * single-value `headers` map collapses repeated headers — cookies must travel
 * in `multiValueHeaders`. The local dev server splits cookies itself, so this
 * only proves the fix when run against a sandbox / production deploy
 * (`test:e2e:sandbox`); locally it guards the dev-server path.
 *
 * Uses raw `fetch` because the shared cookie jar consumes `Set-Cookie`.
 */
function getApiUrl(): string {
  const config = JSON.parse(readFileSync('.blocks-sandbox/config.json', 'utf-8'));
  return config.apiUrl;
}

export function responseCookieTests(getApi: () => typeof apiType) {
  describe('API method response cookies', () => {
    test('every Set-Cookie set by one API method reaches the client', { timeout: 15_000 }, async () => {
      const prefix = `mc${Date.now().toString(36)}`;
      const resp = await fetch(getApiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'api.setTwoCookies', params: [prefix], id: 1 }),
      });
      const body = await resp.json();
      assert.ok(!body.error, `RPC setTwoCookies failed: ${JSON.stringify(body.error)}`);

      const setCookies = resp.headers.getSetCookie?.() ?? [];
      const ours = setCookies.filter((c) => c.startsWith(`${prefix}-`));
      assert.deepStrictEqual(
        ours.map((c) => c.split(';')[0]).sort(),
        [`${prefix}-a=1`, `${prefix}-b=2`],
        `Expected both cookies, got: ${setCookies.join(' | ')}`,
      );
    });

    test('a cookie cleared by a method that then throws reaches the client with the error', { timeout: 15_000 }, async () => {
      const name = `mc${Date.now().toString(36)}-clear`;
      const resp = await fetch(getApiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'api.clearCookieThenThrow', params: [name], id: 1 }),
      });
      const body = await resp.json();
      assert.strictEqual(body.error?.code, 401, `Expected a 401 RPC error, got: ${JSON.stringify(body)}`);
      assert.strictEqual(body.error?.data?.name, 'NotAuthenticated');

      const setCookies = resp.headers.getSetCookie?.() ?? [];
      const cleared = setCookies.find((c) => c.startsWith(`${name}=;`));
      assert.ok(cleared, `Expected the clearing Set-Cookie for ${name}, got: ${setCookies.join(' | ')}`);
      assert.match(cleared, /Max-Age=0/);
    });

    test('a method that signs a user in and then throws does NOT hand out a session cookie', { timeout: 15_000 }, async () => {
      const username = `mc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      // `authSignInThenThrow` creates no account, so provision the user first.
      await provisionConfirmedUser(getApi(), username, 'password123', 'auth-same-origin');

      const resp = await fetch(getApiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'api.authSignInThenThrow', params: [username, 'password123'], id: 1 }),
      });
      const body = await resp.json();
      assert.strictEqual(body.error?.code, 403, `Expected a 403 RPC error, got: ${JSON.stringify(body)}`);
      assert.strictEqual(body.error?.data?.name, 'Forbidden');

      const setCookies = resp.headers.getSetCookie?.() ?? [];
      const session = setCookies.find((c) => c.startsWith('auth_') && c.includes('auth-same-origin'));
      assert.strictEqual(session, undefined, `A failed call issued a session cookie: ${setCookies.join(' | ')}`);
    });
  });
}
