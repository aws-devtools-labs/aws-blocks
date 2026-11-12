// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { AuthErrors } from '@aws-blocks/bb-auth';
import { totpCodeFor } from '@aws-blocks/blocks/utils';
import type { api as apiType, authApi as authApiType, authCMfaApi as authCMfaApiType } from 'aws-blocks';
import { codePoller } from './poll-for-code.js';

/** The generated clients the TOTP enrolment suite drives, as a frontend imports them. */
export interface AuthTotpApis {
  /** `authCMfa`: `mfa: { mode: 'optional', types: ['TOTP'] }`, codes checked by RFC 6238 locally. */
  authCMfaApi: typeof authCMfaApiType;
  /** `auth`: MFA off. */
  authApi: typeof authApiType;
  /** The app's own API, to read the sign-up code `authCMfa` delivers. */
  api: typeof apiType;
}

const isLocal = (process.env.BLOCKS_TEST_ENV || 'local') === 'local';

/**
 * Authenticator-app (TOTP) enrolment through `createApi()`'s `setAuthState`, the
 * way a frontend drives it: set up, verify with a code computed from the shared
 * secret, sign out, sign back in and answer the TOTP challenge. `authCMfa` runs
 * with `totpVerification: 'rfc6238'`, so a wrong code is refused locally as on
 * Cognito.
 */
export function authTotpEnrolmentTests(getApis: () => AuthTotpApis) {
  describe('Auth createApi() — TOTP enrolment (authCMfa)', { skip: !isLocal && 'reads the local code inbox' }, () => {
    test('enrol through authCMfaApi, sign out, sign in: challenged, and a totpCodeFor() code passes', async () => {
      const { api, authCMfaApi } = getApis();
      const username = `totp-${Date.now().toString(36)}`;
      const password = 'Password1!';

      await authCMfaApi.setAuthState({ action: 'signUp', username, password, email: `${username}@example.com` });
      const delivered = await codePoller('authCMfaGetLastCode', (u) => api.authCMfaGetLastCode(u))(username);
      await authCMfaApi.setAuthState({ action: 'confirmSignUp', username, code: delivered.code });
      const first = await authCMfaApi.setAuthState({ action: 'signIn', username, password });
      assert.strictEqual(first.state, 'signedIn', 'nothing enrolled yet: no challenge');

      const setup = await authCMfaApi.setAuthState({ action: 'setUpTotp' });
      assert.strictEqual(setup.state, 'signedIn');
      const verify = setup.actions.find((a) => a.name === 'verifyTotpSetup');
      assert.ok(verify, JSON.stringify(setup.actions.map((a) => a.name)));
      const sharedSecret = verify.fields.find((f) => f.name === 'sharedSecret')?.defaultValue ?? '';
      const otpauthUri = verify.fields.find((f) => f.name === 'otpauthUri')?.defaultValue ?? '';
      assert.match(sharedSecret, /^[A-Z2-7]+$/);
      assert.strictEqual(
        otpauthUri,
        `otpauth://totp/AWS%20Blocks%20e2e:${username}?secret=${sharedSecret}&issuer=AWS%20Blocks%20e2e&algorithm=SHA1&digits=6&period=30`,
      );

      // Verification is on: a code for another secret is refused, and the form stays.
      const wrong = await authCMfaApi.setAuthState({
        action: 'verifyTotpSetup',
        code: totpCodeFor('JBSWY3DPEHPK3PXP'),
      });
      assert.strictEqual(wrong.retriable, true, JSON.stringify(wrong));
      assert.strictEqual(wrong.errorName, AuthErrors.EnableSoftwareTokenMFA);

      const enrolled = await authCMfaApi.setAuthState({ action: 'verifyTotpSetup', code: totpCodeFor(sharedSecret) });
      assert.strictEqual(enrolled.state, 'signedIn', JSON.stringify(enrolled));
      assert.strictEqual(enrolled.user?.username, username);
      const turnOff = enrolled.actions.find(
        (a) => a.name === 'updateMfaPreference' && a.fields.some((f) => f.name === 'totp' && f.defaultValue === 'DISABLED'),
      );
      assert.ok(turnOff, 'enrolled: the settings offer turning the authenticator off');

      await authCMfaApi.setAuthState({ action: 'signOut' });

      const challenged = await authCMfaApi.setAuthState({ action: 'signIn', username, password });
      assert.strictEqual(challenged.state, 'confirmingSignIn', JSON.stringify(challenged));
      const confirm = challenged.actions.find((a) => a.name === 'confirmSignIn');
      assert.ok(confirm);
      assert.strictEqual(confirm.fields.find((f) => f.name === 'challenge')?.defaultValue, 'code');
      const session = confirm.fields.find((f) => f.name === 'session')?.defaultValue ?? '';

      // Next step's code: Cognito refuses a code that was already used (the setup's).
      const signedIn = await authCMfaApi.setAuthState({
        action: 'confirmSignIn',
        challenge: 'code',
        session,
        code: totpCodeFor(sharedSecret, Date.now() + 30_000),
      });
      assert.strictEqual(signedIn.state, 'signedIn', JSON.stringify(signedIn));
      assert.strictEqual(signedIn.user?.username, username);

      // Turn it off again: the next sign-in is not challenged.
      const off = await authCMfaApi.setAuthState({ action: 'updateMfaPreference', totp: 'DISABLED' });
      assert.strictEqual(off.state, 'signedIn');
      await authCMfaApi.setAuthState({ action: 'signOut' });
      const unchallenged = await authCMfaApi.setAuthState({ action: 'signIn', username, password });
      assert.strictEqual(unchallenged.state, 'signedIn');
      await authCMfaApi.setAuthState({ action: 'signOut' });
    });

    test('signed out: setUpTotp answers the not-authenticated error state', async () => {
      const { authCMfaApi } = getApis();
      await authCMfaApi.setAuthState({ action: 'signOut' });
      const state = await authCMfaApi.setAuthState({ action: 'setUpTotp' });
      assert.strictEqual(state.state, 'signedOut');
      assert.strictEqual(state.errorName, AuthErrors.NotAuthenticated);
    });

    test('MFA off: the enrolment actions are compile errors and refused at runtime', async () => {
      const { authApi } = getApis();
      // @ts-expect-error — MFA is off on this block
      const state = await authApi.setAuthState({ action: 'setUpTotp' });
      assert.strictEqual(state.errorName, AuthErrors.MfaNotEnabled, JSON.stringify(state));
      // @ts-expect-error — MFA is off on this block
      const prefs = await authApi.setAuthState({ action: 'updateMfaPreference', totp: 'ENABLED' });
      assert.strictEqual(prefs.errorName, AuthErrors.MfaNotEnabled, JSON.stringify(prefs));
    });
  });
}
