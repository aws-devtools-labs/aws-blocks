// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The browser redirect client (`@aws-blocks/bb-auth/browser-client`, L69): a
 * web frontend on ANOTHER origin than the API signs in with a federated
 * provider, reads its session and signs out — against the running backend
 * (the dev server locally; the deployed stack in sandbox / production).
 *
 * Instance: `oidc-auth-web` (routes under `/aws-blocks/auth/web/*`, the stub
 * IdP as provider `web-idp`). The frontend is `http://127.0.0.1:5173`, a
 * loopback origin the relay always allows.
 *
 * The page is simulated (address bar, sessionStorage, navigations) and every
 * request carries the frontend's `Origin`, as a browser's cross-origin fetch
 * does. Cookies travel through the suite's cookie jar on `global.fetch`. The
 * customer-shaped part — `createAuthClient()` and its methods — has no casts.
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { AuthErrors } from '@aws-blocks/bb-auth';
import { createAuthClient, type AuthClientEnvironment } from '@aws-blocks/bb-auth/browser-client';
import { isBlocksError } from '@aws-blocks/core';

const SPA = 'http://127.0.0.1:5173';
const RETURN_PAGE = `${SPA}/return`;
const BASE = '/aws-blocks/auth/web';

function getBaseUrl(): string {
  const config = JSON.parse(readFileSync('.blocks-sandbox/config.json', 'utf-8'));
  const apiUrl: string = config.apiUrl;
  return apiUrl.replace(/\/aws-blocks\/api$/, '');
}

/** Test plumbing: one tab of the frontend. */
class Page {
  url = `${SPA}/`;
  readonly storage = new Map<string, string>();
  readonly navigations: string[] = [];

  env(): AuthClientEnvironment {
    return {
      fetch: (input, init) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((value, key) => {
          headers[key] = value;
        });
        headers.origin = SPA;
        return fetch(input, { ...init, headers, redirect: 'manual' });
      },
      storage: {
        getItem: (k) => this.storage.get(k) ?? null,
        setItem: (k, v) => void this.storage.set(k, v),
        removeItem: (k) => void this.storage.delete(k),
      },
      currentUrl: () => this.url,
      navigate: (url) => void this.navigations.push(url),
      replaceUrl: (url) => {
        this.url = url;
      },
    };
  }

  /** What the browser does after `navigate()`: the provider, the block's callback, then the relay back here. */
  async followProvider(): Promise<void> {
    const authorize = this.navigations.at(-1);
    assert.ok(authorize, 'the client navigated to the provider');
    const toCallback = await fetch(authorize, { redirect: 'manual' });
    assert.strictEqual(toCallback.status, 302, `the stub IdP redirects to the callback, got ${toCallback.status}`);
    const callback = new URL(toCallback.headers.get('location') ?? '', authorize).toString();
    const toApp = await fetch(callback, { redirect: 'manual' });
    assert.strictEqual(toApp.status, 302, `the callback relays to the frontend, got ${toApp.status}`);
    this.url = new URL(toApp.headers.get('location') ?? '', callback).toString();
  }
}

export function browserClientTests(): void {
  describe('Auth browser redirect client (frontend on another origin)', () => {
    test('sign in with a provider, read the session, sign out', async () => {
      const baseUrl = getBaseUrl();
      const page = new Page();
      const auth = createAuthClient<'web-idp'>({
        baseUrl,
        callbackPath: `${BASE}/callback`,
        signOutPath: `${BASE}/signout`,
        redirectUri: RETURN_PAGE,
        environment: page.env(),
      });

      const before = await auth.fetchAuthSession();
      assert.strictEqual(before.signedIn, false);

      await auth.signInWithRedirect({ provider: 'web-idp', customState: '/notes' });
      await page.followProvider();
      assert.ok(page.url.startsWith(`${RETURN_PAGE}?`), `back on the frontend: ${page.url}`);

      const result = await auth.handleSignInRedirect();
      assert.ok(result, 'the return page finishes the sign-in');
      assert.strictEqual(result.customState, '/notes');
      assert.strictEqual(result.user.signInProvider, 'web-idp');
      assert.strictEqual(page.url, RETURN_PAGE, 'the one-time parameters are gone from the address bar');

      const user = await auth.getCurrentUser();
      assert.strictEqual(user.userId, result.user.userId);
      const session = await auth.fetchAuthSession();
      assert.ok(session.signedIn);
      assert.strictEqual(session.user.userSub, result.user.userSub);

      const out = await auth.signOut();
      assert.ok(out.logoutUrl, 'the stub IdP keeps its own session, so there is a logout URL');
      const after = await auth.fetchAuthSession();
      assert.strictEqual(after.signedIn, false);
    });

    test('a return page on an origin the block does not allow is refused', async () => {
      const page = new Page();
      const auth = createAuthClient({
        baseUrl: getBaseUrl(),
        callbackPath: `${BASE}/callback`,
        environment: page.env(),
      });
      await assert.rejects(
        auth.signInWithRedirect({ provider: 'web-idp', redirectUri: 'https://evil.example/return' }),
        (e: unknown) => isBlocksError(e, AuthErrors.InvalidRelay),
      );
      assert.strictEqual(page.navigations.length, 0, 'never sent to the provider');
    });

    test('the session route answers the frontend origin with CORS credentials (local dev server)', async (t) => {
      if (process.env.BLOCKS_TEST_ENV && process.env.BLOCKS_TEST_ENV !== 'local') {
        t.skip('CORS origins of a deployed stack are its own configuration');
        return;
      }
      const res = await fetch(`${getBaseUrl()}${BASE}/session`, { headers: { origin: SPA } });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.headers.get('access-control-allow-origin'), SPA);
      assert.strictEqual(res.headers.get('access-control-allow-credentials'), 'true');
    });
  });
}
