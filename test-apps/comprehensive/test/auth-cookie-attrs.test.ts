// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import type { api as apiType } from 'aws-blocks';

/**
 * Session-cookie attribute convergence (D-007): AuthBasic defaults to
 * `SameSite=Lax` and switches to `SameSite=None; Secure; Partitioned` under
 * `crossDomain: true`. Signs in against a default and a crossDomain instance
 * and asserts the emitted `Set-Cookie`.
 *
 * `Secure` / `Partitioned` are conditioned on the request being plain-HTTP
 * localhost: the BB drops `Secure` for the `Lax` default and drops
 * `Partitioned` for the cross-domain recipe on loopback (CHIPS requires
 * HTTPS). This suite runs against local (HTTP localhost) AND sandbox /
 * production (HTTPS API Gateway), so the attribute expectations branch on
 * the resolved API origin rather than hardcoding the localhost case.
 */

function getBaseUrl(): string {
  const config = JSON.parse(readFileSync('.blocks-sandbox/config.json', 'utf-8'));
  const apiUrl: string = config.apiUrl;
  return apiUrl.replace(/\/aws-blocks\/api$/, '');
}

/** Whether the resolved API origin is plain-HTTP loopback (the local dev case). */
function isHttpLocalhost(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Call an API method over raw JSON-RPC and return the response's
 * `Set-Cookie` headers. Bypasses the shared cookie jar, which strips them.
 */
async function rpcSetCookies(
  baseUrl: string,
  method: string,
  args: unknown[],
): Promise<string[]> {
  const resp = await fetch(`${baseUrl}/aws-blocks/api/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: `api.${method}`, params: args, id: 1 }),
  });
  const body = await resp.json();
  assert.ok(!body.error, `RPC ${method} failed: ${JSON.stringify(body.error)}`);
  return resp.headers.getSetCookie?.() ?? [];
}

function uniqueUser(): string {
  return `cookie-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** The session cookie name is `auth_${fullId}`; match the auth scope only. */
function sessionCookie(setCookies: string[], idFragment: string): string {
  const found = setCookies.find((c) => c.startsWith('auth_') && c.includes(idFragment));
  assert.ok(found, `Expected a session Set-Cookie containing "${idFragment}", got: ${setCookies.join(' | ')}`);
  return found!;
}

export function authCookieAttrsTests(getApi: () => typeof apiType) {
  describe('AuthBasic cookie attributes (D-007)', () => {
    test('same-origin default → SameSite=Lax (Secure only off localhost), never Partitioned', async () => {
      const baseUrl = getBaseUrl();
      const localhost = isHttpLocalhost(baseUrl);
      const setCookies = await rpcSetCookies(baseUrl, 'authSameOriginSignInSetsCookie', [uniqueUser(), 'password123']);
      const cookie = sessionCookie(setCookies, 'auth-same-origin');

      assert.match(cookie, /SameSite=Lax/, 'default cookie should be SameSite=Lax');
      assert.ok(!/SameSite=None/.test(cookie), 'default cookie should not be SameSite=None');
      assert.match(cookie, /HttpOnly/, 'session cookie should be HttpOnly');
      assert.ok(!/Partitioned/i.test(cookie), 'same-origin cookie should never be Partitioned');
      if (localhost) {
        assert.ok(!/;\s*Secure/i.test(cookie), 'Lax cookie on plain-HTTP localhost should omit Secure');
      } else {
        assert.match(cookie, /;\s*Secure/i, 'Lax cookie over HTTPS should set Secure');
      }
    });

    test('crossDomain opt-in → SameSite=None; Secure (Partitioned only off localhost)', async () => {
      const baseUrl = getBaseUrl();
      const localhost = isHttpLocalhost(baseUrl);
      const setCookies = await rpcSetCookies(baseUrl, 'authCrossDomainSignInSetsCookie', [uniqueUser(), 'password123']);
      const cookie = sessionCookie(setCookies, 'auth-cross-domain');

      assert.match(cookie, /SameSite=None/, 'crossDomain cookie should be SameSite=None');
      assert.match(cookie, /;\s*Secure/i, 'SameSite=None requires Secure');
      assert.match(cookie, /HttpOnly/, 'session cookie should be HttpOnly');
      if (localhost) {
        assert.ok(!/Partitioned/i.test(cookie), 'Partitioned is dropped on plain-HTTP localhost (CHIPS requires HTTPS)');
      } else {
        assert.match(cookie, /Partitioned/i, 'crossDomain cookie over HTTPS should set Partitioned');
      }
    });
  });
}
