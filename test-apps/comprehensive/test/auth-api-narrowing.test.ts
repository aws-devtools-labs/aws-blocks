// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { AuthErrors } from '@aws-blocks/bb-auth';
import type {
  api as apiType,
  authApi as authApiType,
  authCApi as authCApiType,
  oidcAuthApi as oidcAuthApiType,
} from 'aws-blocks';
import { codePoller } from './poll-for-code.js';

/** The generated clients of two `createApi()` namespaces, as a frontend imports them. */
export interface AuthStateApis {
  /** `auth`: email + password; no passkeys, MFA off. */
  authApi: typeof authApiType;
  /** `oidcAuth`: `emailPassword: false` and two OIDC providers. */
  oidcAuthApi: typeof oidcAuthApiType;
  /** `authC`: declared groups (`admins`, `readers`) and a `department` attribute. */
  authCApi: typeof authCApiType;
  /** The app's own API, to read the confirmation code `authC` delivers. */
  api: typeof apiType;
}

const isLocal = (process.env.BLOCKS_TEST_ENV || 'local') === 'local';

/**
 * `createApi()` is typed by the block's options, through the generated client:
 * an action the options turn off is a compile error (each `@ts-expect-error`
 * fails `tsc` if it stops being one). The calls still run, as an untyped
 * JavaScript caller would make them, and the server answers each with an error
 * state rather than performing it.
 */
export function authApiNarrowingTests(getApis: () => AuthStateApis) {
  describe('Auth createApi() is typed by the block options', () => {
    test('emailPassword: false — password actions are compile errors and refused at runtime', async () => {
      const { oidcAuthApi } = getApis();
      // @ts-expect-error — email + password is off on this block
      const state = await oidcAuthApi.setAuthState({ action: 'signIn', username: 'nobody', password: 'pw' });
      assert.strictEqual(state.state, 'signedOut');
      assert.strictEqual(state.errorName, AuthErrors.EmailPasswordNotEnabled);

      // signOut is the one setAuthState action this block takes; federated sign-in is a URL action.
      const out = await oidcAuthApi.setAuthState({ action: 'signOut' });
      assert.strictEqual(out.state, 'signedOut');
      assert.strictEqual(out.errorName, undefined);
      assert.deepStrictEqual(
        out.actions.map((a) => a.name),
        ['signIn:google', 'signIn:corporate'],
      );
    });

    test('passkeys off — passkey actions are compile errors and refused at runtime', async () => {
      const { authApi } = getApis();
      // @ts-expect-error — passkeys are off on this block
      const state = await authApi.setAuthState({ action: 'signInWithPasskey', username: 'nobody' });
      assert.strictEqual(state.state, 'signedOut');
      // The named gate, not the engine's answer to a password sign-in it could not have made.
      assert.strictEqual(state.errorName, AuthErrors.PasskeysNotEnabled, JSON.stringify(state));
      assert.doesNotMatch(state.error ?? '', /Incorrect username or password/);

      // @ts-expect-error — passkeys are off on this block
      const listing = await authApi.setAuthState({ action: 'listPasskeys' });
      assert.strictEqual(listing.errorName, AuthErrors.PasskeysNotEnabled, JSON.stringify(listing));
    });

    test('MFA off — an MFA confirmSignIn challenge is a compile error and refused at runtime', async () => {
      const { authApi } = getApis();
      // @ts-expect-error — MFA is off on this block, so no step asks for a code
      const state = await authApi.setAuthState({ action: 'confirmSignIn', challenge: 'code', session: 'x', code: '123456' });
      assert.strictEqual(state.state, 'signedOut');
      assert.strictEqual(state.errorName, AuthErrors.MfaNotEnabled, JSON.stringify(state));
    });

    test('the signed-in user reaches the frontend typed: groups, attributes and userSub, no cast', { skip: !isLocal && 'reads the local code inbox' }, async () => {
      const { api, authCApi } = getApis();
      const username = `narrow-${Date.now().toString(36)}`;
      const password = 'Passw0rd!1';
      await api.authCSignUp(username, password, `${username}@example.com`, 'engineering');
      const { code } = await codePoller<{ username: string; code: string; purpose: string }>('authCGetLastCode', (u) => api.authCGetLastCode(u))(username);
      await api.authCConfirmSignUp(username, code);

      const state = await authCApi.setAuthState({ action: 'signIn', username, password });
      assert.strictEqual(state.state, 'signedIn');
      // Typed by authC's options: what a frontend reads without an `api.me()` endpoint.
      const groups: ('admins' | 'readers')[] | undefined = state.user?.groups;
      const department: string | undefined = state.user?.attributes['custom:department'];
      const userSub: string | undefined = state.user?.userSub;
      assert.deepStrictEqual(groups, []);
      assert.strictEqual(department, 'engineering');
      assert.strictEqual(typeof userSub, 'string');
      // @ts-expect-error — `claims` is server-only; AuthState.user never carries it.
      assert.strictEqual(state.user?.claims, undefined);

      const again = await authCApi.getAuthState();
      assert.deepStrictEqual(again.user?.groups, []);
      await authCApi.setAuthState({ action: 'signOut' });
    });

    test('federated action names are not setAuthState actions', async () => {
      const { oidcAuthApi } = getApis();
      // @ts-expect-error — `signIn:<id>` is a URL action in getAuthState(), not a setAuthState input
      const state = await oidcAuthApi.setAuthState({ action: 'signIn:google' });
      assert.strictEqual(state.state, 'signedOut');
      assert.strictEqual(state.errorName, AuthErrors.InvalidParameter);
    });
  });
}
