// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { AuthErrors, isAuthError } from '@aws-blocks/bb-auth';
import type { api as apiType, protectedApi as protectedApiType } from 'aws-blocks';
import { callRpc, provisionConfirmedUser } from './test-support.js';

/** The generated clients the suite calls, as a frontend imports them. */
export interface ProtectApis {
  /** The app's own API: signs a user in to the `auth` instance (`authSignIn` / `authSignOut`). */
  api: typeof apiType;
  /** `auth.protect(scope, 'protectedApi', { public: () => ({ ping }), methods: (context, user) => ({ whoAmI, echo }) })`. */
  protectedApi: typeof protectedApiType;
}

function uniqueUser() {
  return `protect-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** A 401 `NotAuthenticatedException`, as the client sees it. */
function isNotAuthenticated(e: unknown): boolean {
  return isAuthError(e, AuthErrors.NotAuthenticated) && e instanceof Error && 'status' in e && e.status === 401;
}

/**
 * `auth.protect(...)`: a deny-by-default namespace. Its `methods` need a
 * signed-in user and get that user typed; its `public` methods don't — all
 * through the generated client, with no cast.
 */
export function authProtectTests(getApis: () => ProtectApis) {
  describe('Auth protect(): deny-by-default API namespace', () => {
    test('an unauthenticated call to a protected method is rejected with 401 NotAuthenticated', async () => {
      const { api, protectedApi } = getApis();
      await api.authSignOut();
      await assert.rejects(() => protectedApi.whoAmI(), (e) => isNotAuthenticated(e));
      await assert.rejects(() => protectedApi.echo('hello'), (e) => isNotAuthenticated(e));
    });

    test('an unknown method: 401 when signed out (the API is not enumerable), "method not found" when signed in', async () => {
      const { api } = getApis();
      // Not a method of the typed client: a raw JSON-RPC call (with the session cookie), as a script would make it.
      const call = () => callRpc('protectedApi.notAMethod', []);
      await api.authSignOut();
      const anonymous = await call();
      assert.strictEqual(anonymous.error?.code, 401, JSON.stringify(anonymous));
      const username = uniqueUser();
      await provisionConfirmedUser(api, username, 'password123');
      await api.authSignIn(username, 'password123');
      try {
        const signedIn = await call();
        assert.strictEqual(signedIn.error?.code, -32601, JSON.stringify(signedIn));
      } finally {
        await api.authSignOut();
      }
    });

    test('a public method works signed out', async () => {
      const { api, protectedApi } = getApis();
      await api.authSignOut();
      const pong: { ok: boolean } = await protectedApi.ping();
      assert.deepStrictEqual(pong, { ok: true });
    });

    test('an authenticated call reaches the method with the typed user', async () => {
      const { api, protectedApi } = getApis();
      const username = uniqueUser();
      await provisionConfirmedUser(api, username, 'password123');
      const signedIn = await api.authSignIn(username, 'password123');
      try {
        const me = await protectedApi.whoAmI();
        // Typed from the handler's `user` (`AuthenticatedUser` of `auth`'s options), no cast.
        const name: string = me.username;
        const provider: 'password' = me.signInProvider;
        assert.strictEqual(name, username);
        assert.strictEqual(me.userSub, signedIn.userSub);
        assert.strictEqual(provider, 'password');

        const echoed = await protectedApi.echo('hello');
        assert.deepStrictEqual(echoed, { text: 'hello', by: signedIn.userSub });
      } finally {
        await api.authSignOut();
      }
      await assert.rejects(() => protectedApi.whoAmI(), (e) => isNotAuthenticated(e), 'signed out again');
    });
  });
}
