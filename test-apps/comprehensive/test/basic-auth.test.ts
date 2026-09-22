// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isBlocksError } from '@aws-blocks/core';
import type { api as apiType } from 'aws-blocks';
import { codePoller, type PollForCodeOptions } from './poll-for-code.js';

const InvalidCredentials = 'InvalidCredentialsException';
const UserAlreadyExists = 'UserAlreadyExistsException';
const SessionExpired = 'SessionExpiredException';
const InvalidPassword = 'InvalidPasswordException';
const InvalidCode = 'InvalidCodeException';

function uniqueUser() {
  return `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Wait for the AuthBasic code delivered to `username`. See ./poll-for-code.ts. */
const pollForCode = (api: typeof apiType, username: string, options?: PollForCodeOptions) =>
  codePoller('authGetLastCode', (u) => api.authGetLastCode(u))(username, options);

export function basicAuthTests(getApi: () => typeof apiType) {

  describe('AuthBasic', () => {

    // ── Sign Up (code-confirmed) ─────────────────────────────────────────

    describe('signUp', () => {
      test('creates user in unconfirmed state — signIn rejected until confirmed', async () => {
        const api = getApi();
        const username = uniqueUser();
        await api.authSignUp(username, 'password123');

        // Can't sign in yet — unconfirmed
        try {
          await api.authSignIn(username, 'password123');
          assert.fail('Expected error');
        } catch (e) {
          assert.ok(isBlocksError(e, InvalidCredentials), `Expected ${InvalidCredentials}, got ${e}`);
        }
      });

      test('confirm signup with code — then signIn succeeds', async () => {
        const api = getApi();
        const username = uniqueUser();
        await api.authSignUp(username, 'password123');

        const delivered = await pollForCode(api, username);
        assert.ok(delivered, 'Code should have been delivered');
        assert.strictEqual(delivered!.username, username);

        await api.authConfirmSignUp(username, delivered!.code);

        const user = await api.authSignIn(username, 'password123');
        assert.strictEqual(user.username, username);
        assert.ok(user.createdAt);
        await api.authSignOut();
      });

      test('confirm signup with wrong code — rejected', async () => {
        const api = getApi();
        const username = uniqueUser();
        await api.authSignUp(username, 'password123');

        try {
          await api.authConfirmSignUp(username, '000000');
          assert.fail('Expected error');
        } catch (e) {
          assert.ok(isBlocksError(e, InvalidCode), `Expected ${InvalidCode}, got ${e}`);
        }
      });

      test('rejects duplicate username', async () => {
        const api = getApi();
        const username = uniqueUser();
        await api.authSignUp(username, 'password123');
        try {
          await api.authSignUp(username, 'password456');
          assert.fail('Expected error');
        } catch (e) {
          assert.ok(isBlocksError(e, UserAlreadyExists), `Expected ${UserAlreadyExists}, got ${e}`);
        }
      });

      test('rejects password below minLength policy', async () => {
        const api = getApi();
        try {
          await api.authSignUp(uniqueUser(), 'short');
          assert.fail('Expected error');
        } catch (e) {
          assert.ok(isBlocksError(e, InvalidPassword), `Expected ${InvalidPassword}, got ${e}`);
        }
      });
    });

    // ── Sign In ──────────────────────────────────────────────────────────

    describe('signIn', () => {
      test('returns user on valid credentials', async () => {
        const api = getApi();
        const username = uniqueUser();
        await api.authSignUp(username, 'password123');
        const code = await pollForCode(api, username);
        await api.authConfirmSignUp(username, code!.code);

        const user = await api.authSignIn(username, 'password123');
        assert.strictEqual(user.username, username);
        assert.ok(user.userId);
        await api.authSignOut();
      });

      test('rejects wrong password', async () => {
        const api = getApi();
        const username = uniqueUser();
        await api.authSignUp(username, 'password123');
        const code = await pollForCode(api, username);
        await api.authConfirmSignUp(username, code!.code);

        try {
          await api.authSignIn(username, 'wrongpassword');
          assert.fail('Expected error');
        } catch (e) {
          assert.ok(isBlocksError(e, InvalidCredentials), `Expected ${InvalidCredentials}, got ${e}`);
        }
      });

      test('rejects non-existent user', async () => {
        const api = getApi();
        try {
          await api.authSignIn('no-such-user-ever', 'password123');
          assert.fail('Expected error');
        } catch (e) {
          assert.ok(isBlocksError(e, InvalidCredentials), `Expected ${InvalidCredentials}, got ${e}`);
        }
      });
    });

    // ── Session persistence ──────────────────────────────────────────────

    describe('session', () => {
      test('signIn sets session cookie — getCurrentUser returns user', async () => {
        const api = getApi();
        const username = uniqueUser();
        await api.authSignUp(username, 'password123');
        const code = await pollForCode(api, username);
        await api.authConfirmSignUp(username, code!.code);
        await api.authSignIn(username, 'password123');

        const user = await api.authGetCurrentUser();
        assert.ok(user, 'getCurrentUser should return user after signIn');
        assert.strictEqual(user!.username, username);
        await api.authSignOut();
      });

      test('signIn sets session cookie — checkAuth returns true', async () => {
        const api = getApi();
        const username = uniqueUser();
        await api.authSignUp(username, 'password123');
        const code = await pollForCode(api, username);
        await api.authConfirmSignUp(username, code!.code);
        await api.authSignIn(username, 'password123');

        assert.strictEqual(await api.authCheckAuth(), true);
        await api.authSignOut();
      });

      test('signIn sets session cookie — requireAuth returns user', async () => {
        const api = getApi();
        const username = uniqueUser();
        await api.authSignUp(username, 'password123');
        const code = await pollForCode(api, username);
        await api.authConfirmSignUp(username, code!.code);
        await api.authSignIn(username, 'password123');

        const result = await api.authRequired();
        assert.strictEqual(result.user.username, username);
        await api.authSignOut();
      });

      test('signOut clears session — getCurrentUser returns null', async () => {
        const api = getApi();
        const username = uniqueUser();
        await api.authSignUp(username, 'password123');
        const code = await pollForCode(api, username);
        await api.authConfirmSignUp(username, code!.code);
        await api.authSignIn(username, 'password123');
        await api.authSignOut();

        assert.strictEqual(await api.authGetCurrentUser(), null);
        assert.strictEqual(await api.authCheckAuth(), false);
      });

      test('signOut clears session — requireAuth throws', async () => {
        const api = getApi();
        const username = uniqueUser();
        await api.authSignUp(username, 'password123');
        const code = await pollForCode(api, username);
        await api.authConfirmSignUp(username, code!.code);
        await api.authSignIn(username, 'password123');
        await api.authSignOut();

        try {
          await api.authRequired();
          assert.fail('Expected error');
        } catch (e) {
          assert.ok(isBlocksError(e, SessionExpired), `Expected ${SessionExpired}, got ${e}`);
        }
      });

      test('no session — getCurrentUser returns null', async () => {
        const api = getApi();
        await api.authSignOut();
        assert.strictEqual(await api.authGetCurrentUser(), null);
      });
    });

    // ── Password Reset ───────────────────────────────────────────────────

    describe('password reset', () => {
      test('resetPassword does not throw for non-existent user', async () => {
        const api = getApi();
        await api.authResetPassword('no-such-user-ever');
      });

      test('full reset flow — reset, confirm with code, sign in with new password', async () => {
        const api = getApi();
        const username = uniqueUser();
        await api.authSignUp(username, 'password123');
        let code = await pollForCode(api, username);
        await api.authConfirmSignUp(username, code!.code);

        // Request reset
        await api.authResetPassword(username);
        // Reset issues a second code for the same user; wait for the one that
        // is not the sign-up code we just consumed.
        code = await pollForCode(api, username, { not: code.code });
        assert.ok(code);
        assert.strictEqual(code!.username, username);

        // Confirm reset with new password
        await api.authConfirmResetPassword(username, code!.code, 'newpass123');

        // Old password should fail
        try {
          await api.authSignIn(username, 'password123');
          assert.fail('Expected error');
        } catch (e) {
          assert.ok(isBlocksError(e, InvalidCredentials));
        }

        // New password should work
        const user = await api.authSignIn(username, 'newpass123');
        assert.strictEqual(user.username, username);
        await api.authSignOut();
      });

      test('confirmResetPassword rejects invalid code', async () => {
        const api = getApi();
        const username = uniqueUser();
        await api.authSignUp(username, 'password123');
        let code = await pollForCode(api, username);
        await api.authConfirmSignUp(username, code!.code);
        await api.authResetPassword(username);

        try {
          await api.authConfirmResetPassword(username, '000000', 'newpass123');
          assert.fail('Expected error');
        } catch (e) {
          assert.ok(isBlocksError(e, InvalidCode), `Expected ${InvalidCode}, got ${e}`);
        }
      });

      test('confirmResetPassword rejects without prior reset request', async () => {
        const api = getApi();
        const username = uniqueUser();
        await api.authSignUp(username, 'password123');
        const code = await pollForCode(api, username);
        await api.authConfirmSignUp(username, code!.code);

        try {
          await api.authConfirmResetPassword(username, '123456', 'newpass123');
          assert.fail('Expected error');
        } catch (e) {
          assert.ok(isBlocksError(e, InvalidCode), `Expected ${InvalidCode}, got ${e}`);
        }
      });
    });

    // ── Code read-back durability (regression, #172) ─────────────────────
    //
    // The delivered code used to be held in a module-level variable. Only the
    // instance that ran `codeDelivery` could see it, so in a deployed
    // environment the request serving `authGetLastCode` often read its own
    // `null` — or a leftover code from an earlier user it had handled — which
    // made every code-confirmed auth test intermittently red.
    //
    // Codes now live in the shared KVStore under one key per user, and
    // `authGetLastCode` requires the username, so neither half can come back.

    describe('verification code read-back', () => {
      test('delivered code is readable from shared state, not just process memory', async () => {
        const api = getApi();
        const username = uniqueUser();
        await api.authSignUp(username, 'password123');

        const delivered = await pollForCode(api, username);

        // Read the same record back through kvGet — a different API method
        // reaching the shared KVStore. If the code only lived in a module
        // variable this would be null, which is exactly what a cold Lambda
        // instance used to observe. Key mirrors the harness in
        // aws-blocks/index.ts.
        const persisted = await api.kvGet(`__last-code:auth:${username}`);
        assert.ok(persisted, 'code should be persisted in the shared store');
        assert.deepStrictEqual(JSON.parse(persisted!), { username, code: delivered.code });
      });

      test('codes are keyed per user — a later signup does not mask an earlier one', async () => {
        const api = getApi();
        const first = uniqueUser();
        const second = uniqueUser();

        await api.authSignUp(first, 'password123');
        const firstCode = await pollForCode(api, first);

        await api.authSignUp(second, 'password123');
        const secondCode = await pollForCode(api, second);

        // The earlier user's code must survive the later delivery, and each
        // lookup must return its own record.
        const reread = await api.authGetLastCode(first);
        assert.ok(reread, `code for ${first} should still be readable`);
        assert.strictEqual(reread!.username, first);
        assert.strictEqual(reread!.code, firstCode.code);
        assert.strictEqual(secondCode.username, second);

        // Both codes still confirm their own user.
        await api.authConfirmSignUp(first, firstCode.code);
        await api.authConfirmSignUp(second, secondCode.code);
      });

      test('unknown username returns null rather than another user code', async () => {
        const api = getApi();
        const username = uniqueUser();
        await api.authSignUp(username, 'password123');
        await pollForCode(api, username);

        assert.strictEqual(await api.authGetLastCode(`${username}-never-signed-up`), null);
      });

      test('delivery writes exactly one record — no shared "latest" pointer', async () => {
        const api = getApi();
        const username = uniqueUser();

        // Start from a known-empty set: the mock store persists to disk between
        // local runs, so leftovers from an earlier build would mask what this
        // delivery actually wrote.
        await api.authPurgeDeliveredCodes();
        await api.authSignUp(username, 'password123');
        await pollForCode(api, username);

        // Exactly one key. An unkeyed "latest code" slot is what made this
        // flaky in the first place: whoever delivered last owned it, so a
        // reader could be handed another user's code. Nothing reads one, so
        // nothing writes one — and that also halves the writes per delivery.
        const codeKeys = (await api.kvScan())
          .map((e) => e.key)
          .filter((key) => key.startsWith('__last-code:'));

        assert.deepStrictEqual(codeKeys, [`__last-code:auth:${username}`]);
      });

      // Runs last in this suite: it clears every channel's codes, and the
      // suites that follow deliver their own.
      test('purge clears code records and leaves other keys alone', async () => {
        const api = getApi();
        const username = uniqueUser();
        const bystander = `kv-bystander-${Date.now().toString(36)}`;
        await api.kvPut(bystander, 'keep me');
        await api.authSignUp(username, 'password123');
        await pollForCode(api, username);

        const { deleted } = await api.authPurgeDeliveredCodes();
        assert.ok(deleted >= 1, `expected at least one record purged, got ${deleted}`);

        assert.strictEqual(await api.authGetLastCode(username), null, 'purged code should be gone');
        assert.strictEqual(await api.kvGet(bystander), 'keep me', 'purge must only touch __last-code: keys');
        await api.kvDelete(bystander);
      });
    });

  });

}
