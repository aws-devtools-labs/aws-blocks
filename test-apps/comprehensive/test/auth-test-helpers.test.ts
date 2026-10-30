// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The auth test helpers from `@aws-blocks/blocks/utils`, used the way an app's
 * e2e suite uses them: two users from `createTestClient()` hold two sessions at
 * once, and `getLastAuthCode()` reads each sign-up code from the local pool
 * without knowing where the block keeps its data. Customer code: no casts.
 *
 * Local only: against a deployed stack Cognito emails the code, so there is
 * nothing for `getLastAuthCode()` to read.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isBlocksError } from '@aws-blocks/blocks/client';
import { createTestClient, getLastAuthCode } from '@aws-blocks/blocks/utils';

type App = typeof import('aws-blocks');

const isLocal = (process.env.BLOCKS_TEST_ENV || 'local') === 'local';
const password = 'TestPass123!';

/** Sign `name` up on the `auth` block and in, as `user`; the code comes from the local pool. */
async function signUpAndIn(user: App, name: string) {
  const signUp = await user.authApi.setAuthState({ action: 'signUp', username: name, password });
  assert.strictEqual(signUp.state, 'confirmingSignUp');
  const code = await getLastAuthCode(name, { purpose: 'signUp' });
  const confirmed = await user.authApi.setAuthState({ action: 'confirmSignUp', username: name, code });
  assert.ok(confirmed.actions.some((a) => a.name === 'autoSignIn'));
  const state = await user.authApi.setAuthState({ action: 'autoSignIn', username: name });
  assert.strictEqual(state.state, 'signedIn');
}

export function authTestHelpersTests(getApp: () => App) {
  describe('Auth test helpers: createTestClient + getLastAuthCode', { skip: !isLocal && 'local mock only' }, () => {
    test('two users hold two sessions at once; neither sees the other', async () => {
      const app = getApp();
      const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const owner = createTestClient(app);
      const intruder = createTestClient(app);
      const ownerName = `helpers-owner-${suffix}`;
      const intruderName = `helpers-intruder-${suffix}`;

      await signUpAndIn(owner, ownerName);
      // The intruder signs up after the owner: the owner's session is untouched.
      await signUpAndIn(intruder, intruderName);

      assert.deepStrictEqual(await owner.api.authRequired(), { user: { username: ownerName } });
      assert.deepStrictEqual(await intruder.api.authRequired(), { user: { username: intruderName } });
      const ownerState = await owner.authApi.getAuthState();
      assert.strictEqual(ownerState.user?.username, ownerName);

      // Signing one user out leaves the other signed in.
      await intruder.authApi.setAuthState({ action: 'signOut' });
      await assert.rejects(intruder.api.authRequired(), (e: unknown) => isBlocksError(e, 'NotAuthenticatedException'));
      assert.deepStrictEqual(await owner.api.authRequired(), { user: { username: ownerName } });
      await owner.authApi.setAuthState({ action: 'signOut' });
    });

    test("getLastAuthCode reads a user's code after another user's code was sent", async () => {
      const app = getApp();
      const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const first = createTestClient(app);
      const second = createTestClient(app);
      const firstName = `helpers-first-${suffix}`;
      const secondName = `helpers-second-${suffix}`;
      await first.authApi.setAuthState({ action: 'signUp', username: firstName, password });
      await second.authApi.setAuthState({ action: 'signUp', username: secondName, password });
      // last-code.json now holds the second user's code; the first is still pending in the pool.
      for (const [user, name] of [[first, firstName], [second, secondName]] as const) {
        const code = await getLastAuthCode(name);
        await user.authApi.setAuthState({ action: 'confirmSignUp', username: name, code });
        assert.strictEqual((await user.authApi.setAuthState({ action: 'autoSignIn', username: name })).state, 'signedIn');
        await user.authApi.setAuthState({ action: 'signOut' });
      }
      await assert.rejects(getLastAuthCode(`helpers-nobody-${suffix}`), /No code for 'helpers-nobody-/);
    });
  });
}
