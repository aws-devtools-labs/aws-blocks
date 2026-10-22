// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { isBlocksError } from '@aws-blocks/core';
import type { api as apiType } from 'aws-blocks';
import { codePoller, type PollForCodeOptions } from './poll-for-code.js';

/** Resolve the API origin from the sandbox config (same source the client uses). */
function getBaseUrl(): string {
  const config = JSON.parse(readFileSync('.blocks-sandbox/config.json', 'utf-8'));
  const apiUrl: string = config.apiUrl;
  return apiUrl.replace(/\/aws-blocks\/api$/, '');
}

/**
 * One raw JSON-RPC call with an optional MANUAL `Cookie` header, returning the
 * result and any `Set-Cookie` headers. Bypasses the shared cookie jar so a
 * captured session cookie can be replayed verbatim (the auth-cookie-attrs
 * technique), which is what proves revocation against the real backing store.
 */
async function rpcRaw(
  baseUrl: string,
  method: string,
  args: unknown[],
  cookie?: string,
): Promise<{ result: unknown; setCookies: string[] }> {
  const resp = await fetch(`${baseUrl}/aws-blocks/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', method: `api.${method}`, params: args, id: 1 }),
  });
  const body = await resp.json();
  assert.ok(!body.error, `RPC ${method} failed: ${JSON.stringify(body.error)}`);
  return { result: body.result, setCookies: resp.headers.getSetCookie?.() ?? [] };
}

/**
 * Like `rpcRaw`, but for a call expected to FAIL: returns the JSON-RPC error
 * object (`{ code, message, data }`) instead of asserting it is absent. The
 * serialized `data.name` is how a branded `ApiError`'s name crosses the wire.
 */
async function rpcRawExpectError(
  baseUrl: string,
  method: string,
  args: unknown[],
  cookie?: string,
): Promise<{ code: number; message: string; data?: { name?: string } }> {
  const resp = await fetch(`${baseUrl}/aws-blocks/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', method: `api.${method}`, params: args, id: 1 }),
  });
  const body = await resp.json();
  assert.ok(body.error, `RPC ${method} was expected to fail but succeeded: ${JSON.stringify(body.result)}`);
  return body.error;
}

/** The `name=value` of the AuthBasic session cookie, ready to send back as a Cookie header. */
function sessionCookieHeader(setCookies: string[]): string | null {
  const found = setCookies.find((c) => c.startsWith('auth_'));
  if (!found) return null;
  return found.split(';')[0]; // name=value, drop attributes
}

const InvalidCredentials = 'InvalidCredentialsException';
const UserAlreadyExists = 'UserAlreadyExistsException';
const SessionExpired = 'SessionExpiredException';
const SessionRevoked = 'SessionRevokedException';
const InvalidPassword = 'InvalidPasswordException';
const InvalidCode = 'InvalidCodeException';
const AccountLocked = 'AccountLockedException';

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

    // ── Server-side revocation on sign-out (#766) ────────────────────────
    // The shared `api` client auto-manages one cookie jar, so it cannot hold a
    // cookie across a sign-out that clears it. These tests drive raw JSON-RPC
    // with a MANUAL Cookie header (the same bypass auth-cookie-attrs uses) to
    // capture a session cookie, sign out WITH it, then REPLAY it — proving the
    // revocation marker is written to and read from the real backing store
    // (DynamoDB under sandbox/production, the mock locally), not just the mock.

    describe('session revocation on sign-out', () => {
      test('a cookie captured before sign-out is rejected when replayed after', async () => {
        const baseUrl = getBaseUrl();
        const username = uniqueUser();

        // Confirm the user through the normal client first (needs the code poll).
        const api = getApi();
        await api.authSignUp(username, 'password123');
        const code = await pollForCode(api, username);
        await api.authConfirmSignUp(username, code!.code);

        // Sign in over raw RPC and capture the Set-Cookie (jar-bypassed).
        const signIn = await rpcRaw(baseUrl, 'authSignIn', [username, 'password123']);
        const cookie = sessionCookieHeader(signIn.setCookies);
        assert.ok(cookie, 'authSignIn issued a session cookie');

        // The captured cookie authenticates before sign-out.
        const before = await rpcRaw(baseUrl, 'authCheckAuth', [], cookie);
        assert.strictEqual(before.result, true, 'captured cookie authenticates before sign-out');

        // Sign out carrying the captured cookie — this revokes its jti.
        await rpcRaw(baseUrl, 'authSignOut', [], cookie);

        // Replaying the exact same cookie now fails: the token is unexpired and
        // signature-valid, but its jti is on the revocation list.
        const after = await rpcRaw(baseUrl, 'authCheckAuth', [], cookie);
        assert.strictEqual(after.result, false, 'replayed cookie is rejected after sign-out');

        // The revoked session must surface as SessionRevokedException (not
        // SessionExpiredException) THROUGH the JSON-RPC serializer — not just
        // in-process. A requireAuth-gated call with the replayed cookie carries
        // the branded name across the wire in error.data.name (AGENTS.md asks
        // for an e2e when serialization changes).
        const err = await rpcRawExpectError(baseUrl, 'authRequired', [], cookie);
        assert.strictEqual(err.code, 401, 'requireAuth rejects the revoked cookie with 401');
        assert.strictEqual(
          err.data?.name,
          SessionRevoked,
          'the revoked session surfaces as SessionRevokedException over the wire',
        );
      });
    });

    // ── Sign-in throttling / lockout (#766) ──────────────────────────────

    describe('sign-in throttling', () => {
      test('locks out after too many failed attempts — AccountLockedException over the wire', async () => {
        const baseUrl = getBaseUrl();
        const username = uniqueUser();

        // The throttle pool confirms immediately (no codeDelivery).
        await rpcRaw(baseUrl, 'authThrottleSignUp', [username, 'password123']);

        // maxAttempts is 2 on this pool: two wrong-password attempts are plain
        // InvalidCredentials…
        for (let i = 0; i < 2; i++) {
          const err = await rpcRawExpectError(baseUrl, 'authThrottleSignIn', [username, 'wrong-pass']);
          assert.strictEqual(
            err.data?.name,
            InvalidCredentials,
            `attempt ${i + 1} is a credential failure, not yet locked`,
          );
        }

        // …then the account is locked: even the CORRECT password is rejected
        // with AccountLockedException (429) THROUGH the JSON-RPC serializer.
        const locked = await rpcRawExpectError(baseUrl, 'authThrottleSignIn', [username, 'password123']);
        assert.strictEqual(locked.code, 429, 'locked sign-in rejects with 429');
        assert.strictEqual(
          locked.data?.name,
          AccountLocked,
          'the lockout surfaces as AccountLockedException over the wire',
        );
        // The message must not leak the username or any SDK metadata.
        assert.doesNotMatch(locked.message, new RegExp(username, 'i'), 'lockout message does not echo the username');
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

        await api.authSignUp(username, 'password123');
        await pollForCode(api, username);

        // Exactly one key. An unkeyed "latest code" slot is what made this
        // flaky in the first place: whoever delivered last owned it, so a
        // reader could be handed another user's code. Nothing reads one, so
        // nothing writes one — and that also halves the writes per delivery.
        //
        // Count the records that hold this delivery (by their username), not
        // every code key: the store also holds other users' records, from the
        // Agent suite signing up users in a background process at the same time
        // (./background-suites.ts) and, locally, from earlier runs persisted in
        // .bb-data/. A shared slot would still show up here, as a second key
        // holding this username.
        const codeKeys = (await api.kvScan())
          .filter((e) => e.key.startsWith('__last-code:'))
          .filter((e) => (JSON.parse(e.value) as { username?: string }).username === username)
          .map((e) => e.key);

        assert.deepStrictEqual(codeKeys, [`__last-code:auth:${username}`]);
      });

      // Purges only this test's user: a purge of every code would delete one
      // the Agent suite, running in a background process at the same time, is
      // still waiting to read (./background-suites.ts).
      test('purge clears code records and leaves other keys alone', async () => {
        const api = getApi();
        const username = uniqueUser();
        const bystander = `kv-bystander-${Date.now().toString(36)}`;
        await api.kvPut(bystander, 'keep me');
        await api.authSignUp(username, 'password123');
        await pollForCode(api, username);

        const { deleted } = await api.authPurgeDeliveredCodes(username);
        assert.strictEqual(deleted, 1, `expected this user's one record purged, got ${deleted}`);

        assert.strictEqual(await api.authGetLastCode(username), null, 'purged code should be gone');
        assert.strictEqual(await api.kvGet(bystander), 'keep me', 'purge must only touch __last-code: keys');
        await api.kvDelete(bystander);
      });
    });

  });

}
