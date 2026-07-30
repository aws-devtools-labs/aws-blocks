// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { isBlocksError } from '@aws-blocks/core';
import type { api as apiType } from 'aws-blocks';
import { signInPoller } from './poll-for-signin.js';

const NotAuthenticated = 'NotAuthenticatedException';

function getBaseUrl(): string {
  const config = JSON.parse(readFileSync('.blocks-sandbox/config.json', 'utf-8'));
  const apiUrl: string = config.apiUrl;
  return apiUrl.replace(/\/aws-blocks\/api$/, '');
}

/**
 * Call an API method over the JSON-RPC wire protocol. We bypass the
 * generated client here because these tests need to drive raw cookie
 * lifecycles across redirects — the test cookie-jar / fetch wrapper used
 * by `getApi()` re-uses a single jar and would obscure exactly which
 * cookies were being sent.
 */
async function rpcCall(
  baseUrl: string,
  apiNamespace: string,
  method: string,
  args: unknown[],
  init?: { cookies?: string[] },
): Promise<{ status: number; result?: any; error?: any }> {
  const resp = await fetch(`${baseUrl}/aws-blocks/api`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.cookies ? { cookie: init.cookies.join('; ') } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: `${apiNamespace}.${method}`,
      params: args,
      id: 1,
    }),
  });
  const body = await resp.json();
  return { status: resp.status, result: body.result, error: body.error };
}

/** Wait for the sign-in record the first AuthOIDC instance wrote for `userId`. */
const pollOidcSignIn = (api: typeof apiType, userId: string) =>
  signInPoller('oidcGetLastSignInUser', (id) => api.oidcGetLastSignInUser(id))(userId);

/** Wait for the sign-in record the `extras` AuthOIDC instance wrote for `userId`. */
const pollExtrasSignIn = (api: typeof apiType, userId: string) =>
  signInPoller('oidcExtrasGetLastSignInUser', (id) => api.oidcExtrasGetLastSignInUser(id))(userId);

/**
 * Drive a full stub-IdP sign-in and return the resulting session, including the
 * `userId` it authenticated as. Tests need that id to read back anything the
 * `onSignIn` hook recorded, since those records are keyed per user.
 *
 * @param signinPath Path segment before `/signin`, e.g. `signin` for the first
 *        instance or `extras/signin` for the second.
 * @param requireAuthMethod The instance's `requireAuth` RPC, used to resolve the
 *        session back to a `userId`.
 */
async function signInVia(
  baseUrl: string,
  signinPath: string,
  provider: string,
  requireAuthMethod: string,
): Promise<{ userId: string; sessionCookies: string[] }> {
  const signinResp = await fetch(`${baseUrl}/aws-blocks/auth/${signinPath}/${provider}`, { redirect: 'manual' });
  assert.strictEqual(signinResp.status, 302, `signin kickoff should 302, got ${signinResp.status}`);
  const cookies = collectCookies(signinResp);

  const authResp = await fetch(signinResp.headers.get('location')!, { redirect: 'manual' });
  const cbResp = await fetch(authResp.headers.get('location')!, {
    redirect: 'manual',
    headers: { cookie: cookies.join('; ') },
  });
  assert.strictEqual(cbResp.status, 302, `callback should 302, got ${cbResp.status}`);
  const sessionCookies = mergeCookies(cookies, collectCookies(cbResp));

  const meCall = await rpcCall(baseUrl, 'api', requireAuthMethod, [], { cookies: sessionCookies });
  assert.strictEqual(meCall.status, 200, `${requireAuthMethod} should succeed after sign-in`);
  return { userId: meCall.result.userId, sessionCookies };
}

export function oidcAuthTests(getApi: () => typeof apiType) {

  describe('AuthOIDC', () => {

    describe('providers', () => {
      test('returns configured provider names', async () => {
        const api = getApi();
        const providers = await api.oidcGetProviders();
        assert.deepStrictEqual(providers, ['google', 'corporate']);
      });
    });

    describe('unauthenticated', () => {
      test('requireAuth throws NotAuthenticated when no session', async () => {
        const api = getApi();
        try {
          await api.oidcRequireAuth();
          assert.fail('Expected error');
        } catch (e) {
          assert.ok(isBlocksError(e, NotAuthenticated), `Expected ${NotAuthenticated}, got ${e}`);
        }
      });

      test('checkAuth returns false when no session', async () => {
        const api = getApi();
        const result = await api.oidcCheckAuth();
        assert.strictEqual(result, false);
      });

      test('getCurrentUser returns null when no session', async () => {
        const api = getApi();
        const user = await api.oidcGetCurrentUser();
        assert.strictEqual(user, null);
      });
    });

    describe('sign-in flow', () => {
      test('getSignInUrl returns a valid authorize URL for google', async () => {
        const api = getApi();
        const { url } = await api.oidcGetSignInUrl('google');
        assert.ok(url, 'Should return a URL');
        assert.match(url, /\/aws-blocks\/auth\/idp\/google\/authorize\?/, 'URL should point to stub IdP');
        // Verify PKCE and required params are present
        const parsed = new URL(url);
        assert.ok(parsed.searchParams.get('client_id'), 'Should have client_id');
        assert.ok(parsed.searchParams.get('redirect_uri'), 'Should have redirect_uri');
        assert.ok(parsed.searchParams.get('code_challenge'), 'Should have PKCE code_challenge');
        assert.strictEqual(parsed.searchParams.get('code_challenge_method'), 'S256');
        assert.strictEqual(parsed.searchParams.get('response_type'), 'code');
        assert.ok(parsed.searchParams.get('state'), 'Should have state');
        assert.ok(parsed.searchParams.get('nonce'), 'Should have nonce');
      });

      test('getSignInUrl returns a valid authorize URL for corporate', async () => {
        const api = getApi();
        const { url } = await api.oidcGetSignInUrl('corporate');
        assert.ok(url, 'Should return a URL');
        assert.match(url, /\/aws-blocks\/auth\/idp\/corporate\/authorize\?/, 'URL should point to stub IdP');
      });

      test('getSignInUrl throws ProviderNotConfigured for unknown provider', async () => {
        const api = getApi();
        try {
          await api.oidcGetSignInUrl('nonexistent');
          assert.fail('Expected error');
        } catch (e) {
          assert.ok(isBlocksError(e, 'ProviderNotConfiguredException'), `Expected ProviderNotConfiguredException, got ${e}`);
        }
      });

      test('full sign-in flow via HTTP redirects — google', async () => {
        const baseUrl = getBaseUrl();

        // Step 1: Hit the sign-in kickoff route (mounted by AuthOIDC)
        const signinResp = await fetch(`${baseUrl}/aws-blocks/auth/signin/google`, { redirect: 'manual' });
        assert.strictEqual(signinResp.status, 302, 'Sign-in kickoff should 302');
        const authorizeUrl = signinResp.headers.get('location');
        assert.ok(authorizeUrl, 'Should redirect to authorize URL');
        assert.match(authorizeUrl!, /\/aws-blocks\/auth\/idp\/google\/authorize/);

        // Collect cookies from the sign-in response (pending-auth cookie)
        const cookies = collectCookies(signinResp);
        assert.ok(cookies.length > 0, 'Should set pending-auth cookie');

        // Step 2: Follow the authorize redirect — stub IdP auto-approves
        const authResp = await fetch(authorizeUrl!, { redirect: 'manual' });
        assert.strictEqual(authResp.status, 302, 'Stub IdP should 302 back to callback');
        const callbackUrl = authResp.headers.get('location');
        assert.ok(callbackUrl, 'Should redirect to callback');
        assert.match(callbackUrl!, /\/aws-blocks\/auth\/callback\?code=/);

        // Step 3: Hit the callback with the pending-auth cookie
        const cbResp = await fetch(callbackUrl!, {
          redirect: 'manual',
          headers: { cookie: cookies.join('; ') },
        });
        assert.strictEqual(cbResp.status, 302, `Callback should 302, got ${cbResp.status}: ${await cbResp.clone().text()}`);
        assert.strictEqual(cbResp.headers.get('location'), '/');

        // Collect session cookie
        const sessionCookies = collectCookies(cbResp);
        const allCookies = mergeCookies(cookies, sessionCookies);
        assert.ok(allCookies.some(c => c.includes('oidc_') && c.includes('_session')), 'Should set session cookie');

        // Step 4: Verify authenticated state
        const meCall = await rpcCall(baseUrl, 'api', 'oidcRequireAuth', [], { cookies: allCookies });
        assert.strictEqual(meCall.status, 200);
        const me = meCall.result;
        assert.strictEqual(me.provider, 'google');
        assert.ok(me.userId, 'Should have userId');
        assert.ok(me.userId.includes(':'), 'userId should be iss:sub format');
        assert.ok(me.sub, 'Should have sub');
        assert.ok(me.iss, 'Should have iss');
        assert.strictEqual(me.email, 'google-user@stub.invalid');
        assert.strictEqual(me.name, 'Stub google User');

        // Step 5: Sign out
        const signoutResp = await fetch(`${baseUrl}/aws-blocks/auth/signout`, {
          method: 'POST',
          redirect: 'manual',
          headers: { cookie: allCookies.join('; ') },
        });
        assert.strictEqual(signoutResp.status, 204);

        // Step 6: Verify unauthenticated after sign-out
        const afterCookies = applyCookies(allCookies, signoutResp);
        const meAfterCall = await rpcCall(baseUrl, 'api', 'oidcRequireAuth', [], { cookies: afterCookies });
        // Should get an error response (NotAuthenticated)
        assert.ok(meAfterCall.error || meAfterCall.status !== 200, 'Should be unauthenticated after sign-out');
      });

      test('full sign-in flow via HTTP redirects — corporate (custom OIDC)', async () => {
        const baseUrl = getBaseUrl();

        // Step 1: Hit the sign-in kickoff route
        const signinResp = await fetch(`${baseUrl}/aws-blocks/auth/signin/corporate`, { redirect: 'manual' });
        assert.strictEqual(signinResp.status, 302);
        const authorizeUrl = signinResp.headers.get('location');
        assert.match(authorizeUrl!, /\/aws-blocks\/auth\/idp\/corporate\/authorize/);

        const cookies = collectCookies(signinResp);

        // Step 2: Stub IdP auto-approves
        const authResp = await fetch(authorizeUrl!, { redirect: 'manual' });
        assert.strictEqual(authResp.status, 302);
        const callbackUrl = authResp.headers.get('location');

        // Step 3: Callback
        const cbResp = await fetch(callbackUrl!, {
          redirect: 'manual',
          headers: { cookie: cookies.join('; ') },
        });
        assert.strictEqual(cbResp.status, 302);

        const sessionCookies = mergeCookies(cookies, collectCookies(cbResp));

        // Step 4: Verify user
        const meCall = await rpcCall(baseUrl, 'api', 'oidcRequireAuth', [], { cookies: sessionCookies });
        assert.strictEqual(meCall.status, 200);
        const me = meCall.result;
        assert.strictEqual(me.provider, 'corporate');
        assert.ok(me.userId.includes(':stub-corporate-user'), 'userId should contain corporate sub');

        // Cleanup: sign out
        await fetch(`${baseUrl}/aws-blocks/auth/signout`, {
          method: 'POST',
          headers: { cookie: sessionCookies.join('; ') },
        });
      });
    });

    describe('onSignIn hook', () => {
      test('onSignIn fires on successful sign-in', async () => {
        const baseUrl = getBaseUrl();
        const api = getApi();

        // Do a full sign-in flow
        const signinResp = await fetch(`${baseUrl}/aws-blocks/auth/signin/google`, { redirect: 'manual' });
        const cookies = collectCookies(signinResp);
        const authorizeUrl = signinResp.headers.get('location')!;

        const authResp = await fetch(authorizeUrl, { redirect: 'manual' });
        const callbackUrl = authResp.headers.get('location')!;

        const cbResp = await fetch(callbackUrl, {
          redirect: 'manual',
          headers: { cookie: cookies.join('; ') },
        });
        const sessionCookies = mergeCookies(cookies, collectCookies(cbResp));

        // Who did we just sign in as? The hook record is keyed by userId, so we
        // need the session's own id to look it up rather than asking for
        // whichever sign-in happened to be most recent.
        const meCall = await rpcCall(baseUrl, 'api', 'oidcRequireAuth', [], { cookies: sessionCookies });
        assert.strictEqual(meCall.status, 200);
        const me = meCall.result;

        // Verify the hook fired
        const lastUser = await pollOidcSignIn(api, me.userId);
        assert.strictEqual(lastUser.provider, 'google');
        assert.strictEqual(lastUser.userId, me.userId);
        assert.strictEqual(lastUser.email, 'google-user@stub.invalid');

        // Cleanup: sign out
        await fetch(`${baseUrl}/aws-blocks/auth/signout`, {
          method: 'POST',
          headers: { cookie: sessionCookies.join('; ') },
        });
      });

      // ── Sign-in read-back durability (regression, #284) ──────────────────
      //
      // The record used to live in a module-level variable, so only the Lambda
      // instance that served the callback could see it. A reader on any other
      // instance got its own `null`, or the previous sign-in it had handled —
      // and because the assertions only checked `provider`, a leftover record
      // from the same provider would pass while proving nothing.

      test('sign-in record is keyed per user, not a shared "last sign-in" slot', async () => {
        const baseUrl = getBaseUrl();
        const api = getApi();

        const { userId, sessionCookies } = await signInVia(baseUrl, 'signin', 'google', 'oidcRequireAuth');
        await pollOidcSignIn(api, userId);

        // Asking for a user who never signed in must not hand back somebody
        // else's record. With a single module-level slot this returned the user
        // above, which is the bug.
        assert.strictEqual(
          await api.oidcGetLastSignInUser(`${userId}-never-signed-in`),
          null,
          'unknown userId should read as null, not the most recent sign-in',
        );

        await fetch(`${baseUrl}/aws-blocks/auth/signout`, {
          method: 'POST',
          headers: { cookie: sessionCookies.join('; ') },
        });
      });

      test('each AuthOIDC instance keeps its own sign-in records', async () => {
        const baseUrl = getBaseUrl();
        const api = getApi();

        const first = await signInVia(baseUrl, 'signin', 'google', 'oidcRequireAuth');
        const second = await signInVia(baseUrl, 'extras/signin', 'google-extras', 'oidcExtrasRequireAuth');

        // Each instance answers for its own user...
        assert.strictEqual((await pollOidcSignIn(api, first.userId)).provider, 'google');
        assert.strictEqual((await pollExtrasSignIn(api, second.userId)).provider, 'google-extras');

        // ...and does not answer for the other instance's user. The later
        // sign-in also must not have clobbered the earlier record.
        assert.strictEqual(await api.oidcGetLastSignInUser(second.userId), null);
        assert.strictEqual(await api.oidcExtrasGetLastSignInUser(first.userId), null);

        for (const [path, session] of [['signout', first], ['extras/signout', second]] as const) {
          await fetch(`${baseUrl}/aws-blocks/auth/${path}`, {
            method: 'POST',
            headers: { cookie: session.sessionCookies.join('; ') },
          });
        }
      });
    });

    describe('userId format', () => {
      test('userId is ${iss}:${sub}', async () => {
        const baseUrl = getBaseUrl();

        const signinResp = await fetch(`${baseUrl}/aws-blocks/auth/signin/google`, { redirect: 'manual' });
        const cookies = collectCookies(signinResp);
        const authorizeUrl = signinResp.headers.get('location')!;

        const authResp = await fetch(authorizeUrl, { redirect: 'manual' });
        const callbackUrl = authResp.headers.get('location')!;

        const cbResp = await fetch(callbackUrl, {
          redirect: 'manual',
          headers: { cookie: cookies.join('; ') },
        });
        const sessionCookies = mergeCookies(cookies, collectCookies(cbResp));

        const meCall = await rpcCall(baseUrl, 'api', 'oidcRequireAuth', [], { cookies: sessionCookies });
        const me = meCall.result;
        assert.strictEqual(me.userId, `${me.iss}:${me.sub}`, 'userId should be ${iss}:${sub}');

        // Cleanup
        await fetch(`${baseUrl}/aws-blocks/auth/signout`, {
          method: 'POST',
          headers: { cookie: sessionCookies.join('; ') },
        });
      });
    });

    describe('createApi state machine', () => {
      test('signedOut state has one action per provider', async () => {
        const baseUrl = getBaseUrl();

        // Call the auth state machine endpoint (no session = signedOut)
        const call = await rpcCall(baseUrl, 'oidcAuthApi', 'getAuthState', []);

        // If the state machine is exposed via the API, check it
        if (call.status === 200 && call.result) {
          const state = call.result;
          assert.strictEqual(state.state, 'signedOut');
          assert.ok(Array.isArray(state.actions));
          assert.strictEqual(state.actions.length, 2, 'Should have one action per provider');
          const names = state.actions.map((a: any) => a.name);
          assert.ok(names.includes('google'));
          assert.ok(names.includes('corporate'));
        }
      });
    });

    describe('callback errors', () => {
      test('callback without pending cookie returns error', async () => {
        const baseUrl = getBaseUrl();
        // Hit callback directly without going through the sign-in flow
        const resp = await fetch(`${baseUrl}/aws-blocks/auth/callback?code=fake&state=fake`, {
          redirect: 'manual',
        });
        // Should fail — no pending-auth cookie
        assert.ok(resp.status >= 400, `Expected error status, got ${resp.status}`);
      });

      test('callback with invalid code returns error', async () => {
        const baseUrl = getBaseUrl();

        // Start a real sign-in to get a valid pending cookie
        const signinResp = await fetch(`${baseUrl}/aws-blocks/auth/signin/google`, { redirect: 'manual' });
        const cookies = collectCookies(signinResp);

        // Hit callback with a bogus code but the real pending cookie
        const resp = await fetch(`${baseUrl}/aws-blocks/auth/callback?code=bogus-code&state=wrong-state`, {
          redirect: 'manual',
          headers: { cookie: cookies.join('; ') },
        });
        assert.ok(resp.status >= 400, `Expected error status, got ${resp.status}`);
      });
    });

    describe('signOut', () => {
      test('signOut clears session and returns 204', async () => {
        const baseUrl = getBaseUrl();

        // Sign in first
        const signinResp = await fetch(`${baseUrl}/aws-blocks/auth/signin/google`, { redirect: 'manual' });
        const cookies = collectCookies(signinResp);
        const authResp = await fetch(signinResp.headers.get('location')!, { redirect: 'manual' });
        const cbResp = await fetch(authResp.headers.get('location')!, {
          redirect: 'manual',
          headers: { cookie: cookies.join('; ') },
        });
        const sessionCookies = mergeCookies(cookies, collectCookies(cbResp));

        // Sign out
        const signoutResp = await fetch(`${baseUrl}/aws-blocks/auth/signout`, {
          method: 'POST',
          headers: { cookie: sessionCookies.join('; ') },
        });
        assert.strictEqual(signoutResp.status, 204);

        // Verify the session cookie was cleared (Max-Age=0 in Set-Cookie)
        const setCookies = signoutResp.headers.getSetCookie?.() ?? [];
        const sessionClear = setCookies.find(c => c.includes('session') && c.includes('Max-Age=0'));
        assert.ok(sessionClear, 'Should clear session cookie with Max-Age=0');
      });
    });

    describe('stub IdP routes', () => {
      test('discovery endpoint returns valid OIDC configuration', async () => {
        const baseUrl = getBaseUrl();
        const resp = await fetch(`${baseUrl}/aws-blocks/auth/idp/google/.well-known/openid-configuration`);
        assert.strictEqual(resp.status, 200);
        const doc = await resp.json();
        assert.ok(doc.issuer);
        assert.ok(doc.authorization_endpoint);
        assert.ok(doc.token_endpoint);
        assert.ok(doc.jwks_uri);
        assert.deepStrictEqual(doc.response_types_supported, ['code']);
        assert.deepStrictEqual(doc.code_challenge_methods_supported, ['S256']);
      });

      test('JWKS endpoint returns a valid key set', async () => {
        const baseUrl = getBaseUrl();
        const resp = await fetch(`${baseUrl}/aws-blocks/auth/idp/google/jwks.json`);
        assert.strictEqual(resp.status, 200);
        const jwks = await resp.json();
        assert.ok(Array.isArray(jwks.keys));
        assert.ok(jwks.keys.length > 0);
        const key = jwks.keys[0];
        assert.strictEqual(key.alg, 'RS256');
        assert.strictEqual(key.use, 'sig');
        assert.ok(key.kid);
        assert.ok(key.n); // RSA modulus
        assert.ok(key.e); // RSA exponent
      });

      test('authorize endpoint rejects missing params', async () => {
        const baseUrl = getBaseUrl();
        const resp = await fetch(`${baseUrl}/aws-blocks/auth/idp/google/authorize`);
        assert.strictEqual(resp.status, 400);
      });
    });

    describe('onSignIn profile upsert', () => {
      test('sign-in flow works and onSignIn upserts profile', async () => {
        const baseUrl = getBaseUrl();
        const api = getApi();

        // Sign in via the second instance (oidcAuthExtras — with onSignIn hook).
        // Its routes derive from callbackPath '/aws-blocks/auth/extras/callback', so the
        // signin kickoff is /aws-blocks/auth/extras/signin/<provider>.
        const signinResp = await fetch(`${baseUrl}/aws-blocks/auth/extras/signin/google-extras`, { redirect: 'manual' });
        assert.strictEqual(signinResp.status, 302);
        const cookies = collectCookies(signinResp);
        const authorizeUrl = signinResp.headers.get('location')!;

        const authResp = await fetch(authorizeUrl, { redirect: 'manual' });
        const callbackUrl = authResp.headers.get('location')!;

        const cbResp = await fetch(callbackUrl, {
          redirect: 'manual',
          headers: { cookie: cookies.join('; ') },
        });
        assert.strictEqual(cbResp.status, 302, `Callback should 302, got ${cbResp.status}`);
        const sessionCookies = mergeCookies(cookies, collectCookies(cbResp));

        // Verify authenticated
        const meCall = await rpcCall(baseUrl, 'api', 'oidcExtrasRequireAuth', [], { cookies: sessionCookies });
        assert.strictEqual(meCall.status, 200);
        const me = meCall.result;
        assert.strictEqual(me.provider, 'google-extras');
        assert.ok(me.userId);

        // Verify onSignIn fired and profile was upserted
        const lastUser = await pollExtrasSignIn(api, me.userId);
        assert.strictEqual(lastUser.provider, 'google-extras');
        assert.strictEqual(lastUser.userId, me.userId);

        const profile = await api.oidcExtrasGetProfile(me.userId);
        assert.ok(profile, 'Profile should have been upserted');
        assert.strictEqual(profile.userId, me.userId);
        assert.ok(profile.lastSignIn, 'Should have lastSignIn timestamp');

        // Cleanup
        await fetch(`${baseUrl}/aws-blocks/auth/extras/signout`, {
          method: 'POST',
          headers: { cookie: sessionCookies.join('; ') },
        });
      });

      test('second sign-in updates profile, does not duplicate', async () => {
        const baseUrl = getBaseUrl();
        const api = getApi();

        // First sign-in
        const signin1 = await fetch(`${baseUrl}/aws-blocks/auth/extras/signin/google-extras`, { redirect: 'manual' });
        const cookies1 = collectCookies(signin1);
        const auth1 = await fetch(signin1.headers.get('location')!, { redirect: 'manual' });
        const cb1 = await fetch(auth1.headers.get('location')!, {
          redirect: 'manual',
          headers: { cookie: cookies1.join('; ') },
        });
        const session1 = mergeCookies(cookies1, collectCookies(cb1));

        // Get the userId
        const me1Call = await rpcCall(baseUrl, 'api', 'oidcExtrasRequireAuth', [], { cookies: session1 });
        const me1 = me1Call.result;
        const userId = me1.userId;

        // Get the first profile
        const profile1 = await api.oidcExtrasGetProfile(userId);
        assert.ok(profile1, 'First profile should exist');
        const firstSignIn = profile1.lastSignIn;

        // Sign out
        await fetch(`${baseUrl}/aws-blocks/auth/extras/signout`, {
          method: 'POST',
          headers: { cookie: session1.join('; ') },
        });

        // Small delay so lastSignIn timestamp differs
        await new Promise(r => setTimeout(r, 50));

        // Second sign-in (same user — stub IdP returns the same sub)
        const signin2 = await fetch(`${baseUrl}/aws-blocks/auth/extras/signin/google-extras`, { redirect: 'manual' });
        const cookies2 = collectCookies(signin2);
        const auth2 = await fetch(signin2.headers.get('location')!, { redirect: 'manual' });
        const cb2 = await fetch(auth2.headers.get('location')!, {
          redirect: 'manual',
          headers: { cookie: cookies2.join('; ') },
        });
        const session2 = mergeCookies(cookies2, collectCookies(cb2));

        // Get the updated profile
        const profile2 = await api.oidcExtrasGetProfile(userId);
        assert.ok(profile2, 'Profile should still exist');
        assert.strictEqual(profile2.userId, userId, 'Same userId');
        assert.notStrictEqual(profile2.lastSignIn, firstSignIn, 'lastSignIn should be updated');

        // Cleanup
        await fetch(`${baseUrl}/aws-blocks/auth/extras/signout`, {
          method: 'POST',
          headers: { cookie: session2.join('; ') },
        });
      });
    });

    describe('no session → NotAuthenticated', () => {
      test('no session cookie results in NotAuthenticated', async () => {
        const baseUrl = getBaseUrl();
        const api = getApi();

        // Calling requireAuth via the typed client (no cookies attached)
        // should throw NotAuthenticated. This is the same code path as an
        // expired session — verifySession returns null in both cases.
        try {
          await api.oidcRequireAuth();
          assert.fail('Expected NotAuthenticated');
        } catch (e) {
          assert.ok(isBlocksError(e, NotAuthenticated), `Expected ${NotAuthenticated}, got ${e}`);
        }
      });
    });

    describe('client-initiated PKCE', () => {
      test('GET /aws-blocks/auth/authorize-params/:provider returns public params', async () => {
        const baseUrl = getBaseUrl();
        const resp = await fetch(`${baseUrl}/aws-blocks/auth/authorize-params/google`);
        assert.strictEqual(resp.status, 200);
        const params = await resp.json() as any;
        assert.ok(params.authorizeUrl, 'should have authorizeUrl');
        assert.strictEqual(params.clientId, 'stub-client-id');
        assert.ok(Array.isArray(params.scopes));
        assert.ok(params.scopes.includes('openid'));
        assert.ok(params.kind, 'should have kind');
      });

      test('GET /aws-blocks/auth/authorize-params/:provider returns 400 for unknown provider', async () => {
        const baseUrl = getBaseUrl();
        const resp = await fetch(`${baseUrl}/aws-blocks/auth/authorize-params/nonexistent`);
        assert.ok(resp.status >= 400, `Expected error status, got ${resp.status}`);
      });

      test('POST /aws-blocks/auth/exchange returns 400 when fields are missing', async () => {
        const baseUrl = getBaseUrl();
        const resp = await fetch(`${baseUrl}/aws-blocks/auth/exchange`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: 'abc' }),
        });
        assert.strictEqual(resp.status, 400);
        const body = await resp.json() as any;
        assert.ok(body.error.includes('Missing required fields'));
      });

      test('POST /aws-blocks/auth/exchange returns 400 for unknown provider', async () => {
        const baseUrl = getBaseUrl();
        const resp = await fetch(`${baseUrl}/aws-blocks/auth/exchange`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: 'abc',
            verifier: 'xyz',
            state: 'state1',
            nonce: 'nonce1',
            provider: 'nonexistent',
            callbackUrl: 'http://localhost/aws-blocks/auth/callback',
          }),
        });
        assert.ok(resp.status >= 400);
      });

      test('full client PKCE exchange flow', async () => {
        const baseUrl = getBaseUrl();

        // Step 1: Get authorize params from the server.
        const paramsResp = await fetch(`${baseUrl}/aws-blocks/auth/authorize-params/google`);
        assert.strictEqual(paramsResp.status, 200);
        const params = await paramsResp.json() as any;

        // Step 2: Generate PKCE client-side (simulate what the browser client does).
        const verifierBytes = new Uint8Array(32);
        crypto.getRandomValues(verifierBytes);
        const verifier = Buffer.from(verifierBytes).toString('base64url');
        const challengeDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
        const challenge = Buffer.from(new Uint8Array(challengeDigest)).toString('base64url');
        const stateBytes = new Uint8Array(32);
        crypto.getRandomValues(stateBytes);
        const state = Buffer.from(stateBytes).toString('base64url');
        const nonceBytes = new Uint8Array(32);
        crypto.getRandomValues(nonceBytes);
        const nonce = Buffer.from(nonceBytes).toString('base64url');
        const callbackUrl = `${baseUrl}/aws-blocks/auth/callback`;

        // Step 3: Build authorize URL and hit the stub IdP.
        const authorizeUrl = new URL(params.authorizeUrl);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('client_id', params.clientId);
        authorizeUrl.searchParams.set('redirect_uri', callbackUrl);
        authorizeUrl.searchParams.set('scope', params.scopes.join(' '));
        authorizeUrl.searchParams.set('state', state);
        authorizeUrl.searchParams.set('nonce', nonce);
        authorizeUrl.searchParams.set('code_challenge', challenge);
        authorizeUrl.searchParams.set('code_challenge_method', 'S256');

        const authResp = await fetch(authorizeUrl.toString(), { redirect: 'manual' });
        assert.strictEqual(authResp.status, 302, 'Stub IdP should 302');
        const redirectLocation = authResp.headers.get('location')!;
        const redirectUrl = new URL(redirectLocation);
        const code = redirectUrl.searchParams.get('code');
        assert.ok(code, 'Should have code in redirect');
        assert.strictEqual(redirectUrl.searchParams.get('state'), state, 'State should round-trip');

        // Step 4: POST /aws-blocks/auth/exchange with the code + verifier.
        const exchangeResp = await fetch(`${baseUrl}/aws-blocks/auth/exchange`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code,
            verifier,
            state,
            nonce,
            provider: 'google',
            callbackUrl,
          }),
        });
        assert.strictEqual(exchangeResp.status, 200, `Exchange failed: ${await exchangeResp.clone().text()}`);
        const result = await exchangeResp.json() as any;
        assert.ok(result.user, 'Should return user');
        assert.strictEqual(result.user.provider, 'google');
        assert.ok(result.user.userId, 'Should have userId');
        assert.ok(result.user.userId.includes(':'), 'userId should be iss:sub format');

        // On the cookie-only instance (allowBearerAuth not set), /aws-blocks/auth/exchange
        // must NOT expose tokens in the response body.
        assert.strictEqual(result.accessToken, undefined, 'Cookie-only instance should not expose accessToken');
        assert.strictEqual(result.refreshToken, undefined, 'Cookie-only instance should not expose refreshToken');
        assert.strictEqual(result.expiresIn, undefined, 'Cookie-only instance should not expose expiresIn');

        // Session cookie should be set on the exchange response.
        const setCookies = exchangeResp.headers.getSetCookie?.() ?? [];
        assert.ok(setCookies.some(c => c.includes('session')), 'Should set session cookie');
      });

      test('POST /aws-blocks/auth/refresh is not mounted when allowBearerAuth is disabled', async () => {
        // The default `oidc-auth` instance does not enable allowBearerAuth,
        // so the refresh route must not exist.
        const baseUrl = getBaseUrl();
        const resp = await fetch(`${baseUrl}/aws-blocks/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: 'any', provider: 'google' }),
        });
        assert.strictEqual(resp.status, 404, 'Refresh endpoint should not exist on cookie-only instances');
      });
    });

    describe('bearer-token auth (native clients)', () => {
      // These tests exercise the native-client path on the second instance
      // (`oidc-auth-extras`), which enables `allowBearerAuth: true`. The flow:
      //   1. Client does PKCE exchange → /aws-blocks/auth/extras/exchange returns
      //      { user, accessToken, refreshToken, expiresIn }
      //   2. Client stores the refresh token and later POSTs it to
      //      /aws-blocks/auth/extras/refresh → gets a rotated access token back.

      async function completePkceExchange(baseUrl: string) {
        // Same client-PKCE flow as above, but targeted at the second instance.
        // Its routes are rooted at /aws-blocks/auth/extras (derived from callbackPath),
        // so authorize-params, exchange, and refresh all sit under that base.
        const paramsResp = await fetch(`${baseUrl}/aws-blocks/auth/extras/authorize-params/google-extras`);
        assert.strictEqual(paramsResp.status, 200);
        const params = await paramsResp.json() as any;

        const verifierBytes = new Uint8Array(32);
        crypto.getRandomValues(verifierBytes);
        const verifier = Buffer.from(verifierBytes).toString('base64url');
        const challengeDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
        const challenge = Buffer.from(new Uint8Array(challengeDigest)).toString('base64url');
        const stateBytes = new Uint8Array(32);
        crypto.getRandomValues(stateBytes);
        const state = Buffer.from(stateBytes).toString('base64url');
        const nonceBytes = new Uint8Array(32);
        crypto.getRandomValues(nonceBytes);
        const nonce = Buffer.from(nonceBytes).toString('base64url');
        const callbackUrl = `${baseUrl}/aws-blocks/auth/extras/callback`;

        const authorizeUrl = new URL(params.authorizeUrl);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('client_id', params.clientId);
        authorizeUrl.searchParams.set('redirect_uri', callbackUrl);
        authorizeUrl.searchParams.set('scope', params.scopes.join(' '));
        authorizeUrl.searchParams.set('state', state);
        authorizeUrl.searchParams.set('nonce', nonce);
        authorizeUrl.searchParams.set('code_challenge', challenge);
        authorizeUrl.searchParams.set('code_challenge_method', 'S256');

        const authResp = await fetch(authorizeUrl.toString(), { redirect: 'manual' });
        const code = new URL(authResp.headers.get('location')!).searchParams.get('code')!;

        const exchangeResp = await fetch(`${baseUrl}/aws-blocks/auth/extras/exchange`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, verifier, state, nonce, provider: 'google-extras', callbackUrl }),
        });
        return { exchangeResp, result: await exchangeResp.json() as any };
      }

      test('/aws-blocks/auth/extras/exchange returns tokens when allowBearerAuth is enabled', async () => {
        const baseUrl = getBaseUrl();
        const { exchangeResp, result } = await completePkceExchange(baseUrl);

        assert.strictEqual(exchangeResp.status, 200, `Exchange failed: ${JSON.stringify(result)}`);
        assert.ok(result.user, 'Should return user');
        assert.strictEqual(result.user.provider, 'google-extras');
        assert.ok(typeof result.accessToken === 'string' && result.accessToken.length > 0, 'Should include accessToken');
        assert.ok(typeof result.refreshToken === 'string' && result.refreshToken.length > 0, 'Should include refreshToken');
        assert.ok(typeof result.expiresIn === 'number' && result.expiresIn > 0, 'Should include expiresIn');
      });

      test('POST /aws-blocks/auth/extras/refresh returns new tokens for a valid refresh token', async () => {
        const baseUrl = getBaseUrl();
        const { result: exchange } = await completePkceExchange(baseUrl);
        assert.ok(exchange.refreshToken, 'Exchange should produce a refresh token');

        const refreshResp = await fetch(`${baseUrl}/aws-blocks/auth/extras/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: exchange.refreshToken, provider: 'google-extras' }),
        });
        assert.strictEqual(refreshResp.status, 200, `Refresh failed: ${await refreshResp.clone().text()}`);
        const refreshed = await refreshResp.json() as any;
        assert.ok(typeof refreshed.accessToken === 'string' && refreshed.accessToken.length > 0, 'Should include new accessToken');
        assert.ok(typeof refreshed.refreshToken === 'string' && refreshed.refreshToken.length > 0, 'Should include refreshToken');
        assert.ok(typeof refreshed.expiresIn === 'number' && refreshed.expiresIn > 0, 'Should include expiresIn');
      });

      test('POST /aws-blocks/auth/extras/refresh returns 401 for an invalid refresh token', async () => {
        const baseUrl = getBaseUrl();
        const resp = await fetch(`${baseUrl}/aws-blocks/auth/extras/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: 'invalid-token-does-not-exist', provider: 'google-extras' }),
        });
        assert.strictEqual(resp.status, 401, 'Invalid refresh token should return 401');
        const body = await resp.json() as any;
        assert.strictEqual(body.name, 'TokenExpiredException');
      });

      test('POST /aws-blocks/auth/extras/refresh returns 400 when fields are missing', async () => {
        const baseUrl = getBaseUrl();
        const resp = await fetch(`${baseUrl}/aws-blocks/auth/extras/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'google-extras' }),
        });
        assert.strictEqual(resp.status, 400);
        const body = await resp.json() as any;
        assert.ok(body.error.includes('Missing required fields'));
      });
    });

    describe('relay flow (native clients)', () => {
      // These tests exercise the full relay round-trip against the third
      // AuthOIDC instance (`oidc-auth-relay`), which has:
      //   - allowedRelayOrigins: [relayOrigin('testapp://auth')]
      //   - allowBearerAuth: true
      //   - routes at /aws-blocks/auth/relay/*
      //
      // The relay flow:
      //   1. POST /aws-blocks/auth/relay/authorize-params/google-relay with { csrf, relayTo }
      //   2. Build authorize URL, hit stub IdP → IdP 302s to /aws-blocks/auth/relay/callback
      //   3. Backend decodes state, sees relay, 302s to testapp://auth?code=...&state=...
      //   4. Client extracts code, POSTs to /aws-blocks/auth/relay/exchange → gets tokens

      function generateCsrf(): string {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        return Buffer.from(bytes).toString('base64url');
      }

      async function generatePkce() {
        const verifierBytes = new Uint8Array(32);
        crypto.getRandomValues(verifierBytes);
        const verifier = Buffer.from(verifierBytes).toString('base64url');
        const challengeDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
        const challenge = Buffer.from(new Uint8Array(challengeDigest)).toString('base64url');
        return { verifier, challenge };
      }

      test('happy path: full relay sign-in round-trip', async () => {
        const baseUrl = getBaseUrl();
        const csrf = generateCsrf();
        const { verifier, challenge } = await generatePkce();

        // Step 1: POST /aws-blocks/auth/relay/authorize-params/google-relay with relay request.
        const paramsResp = await fetch(`${baseUrl}/aws-blocks/auth/relay/authorize-params/google-relay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            csrf,
            relayTo: 'testapp://auth',
          }),
        });
        assert.strictEqual(paramsResp.status, 200, `authorize-params failed: ${await paramsResp.clone().text()}`);
        const params = await paramsResp.json() as any;
        assert.ok(params.authorizeUrl, 'should have authorizeUrl');
        assert.ok(params.clientId, 'should have clientId');
        assert.ok(params.state, 'should have signed state envelope');
        assert.ok(params.scopes, 'should have scopes');

        // Step 2: Build authorize URL and hit the stub IdP.
        const callbackUrl = `${baseUrl}/aws-blocks/auth/relay/callback`;
        const authorizeUrl = new URL(params.authorizeUrl);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('client_id', params.clientId);
        authorizeUrl.searchParams.set('redirect_uri', callbackUrl);
        authorizeUrl.searchParams.set('scope', params.scopes.join(' '));
        authorizeUrl.searchParams.set('state', params.state);
        authorizeUrl.searchParams.set('code_challenge', challenge);
        authorizeUrl.searchParams.set('code_challenge_method', 'S256');
        if (params.nonce) authorizeUrl.searchParams.set('nonce', params.nonce);

        const authResp = await fetch(authorizeUrl.toString(), { redirect: 'manual' });
        assert.strictEqual(authResp.status, 302, 'Stub IdP should 302');
        const idpRedirect = authResp.headers.get('location')!;
        assert.ok(idpRedirect.includes('/aws-blocks/auth/relay/callback'), 'IdP should redirect to backend callback');

        // Step 3: Hit the callback — NO cookies (relay flow).
        // The backend should 302 to testapp://auth with code + state.
        const cbResp = await fetch(idpRedirect, { redirect: 'manual' });
        assert.strictEqual(cbResp.status, 302, `Callback should 302, got ${cbResp.status}: ${await cbResp.clone().text()}`);
        const relayLocation = cbResp.headers.get('location')!;
        assert.ok(relayLocation.startsWith('testapp://auth'), `Should relay to testapp://auth, got: ${relayLocation}`);

        const relayUrl = new URL(relayLocation);
        const code = relayUrl.searchParams.get('code');
        const returnedState = relayUrl.searchParams.get('state');
        assert.ok(code, 'Relay should include code');
        assert.strictEqual(returnedState, params.state, 'Relay should include unmodified state envelope');

        // Step 4: POST /aws-blocks/auth/relay/exchange with the code + verifier.
        const exchangeResp = await fetch(`${baseUrl}/aws-blocks/auth/relay/exchange`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code,
            verifier,
            state: returnedState,
            nonce: params.nonce ?? '',
            provider: 'google-relay',
            callbackUrl,
          }),
        });
        assert.strictEqual(exchangeResp.status, 200, `Exchange failed: ${await exchangeResp.clone().text()}`);
        const result = await exchangeResp.json() as any;
        assert.ok(result.user, 'Should return user');
        assert.strictEqual(result.user.provider, 'google-relay');
        assert.ok(result.user.userId, 'Should have userId');
        assert.ok(typeof result.accessToken === 'string' && result.accessToken.length > 0, 'Should include accessToken');
        assert.ok(typeof result.refreshToken === 'string' && result.refreshToken.length > 0, 'Should include refreshToken');
      });

      test('loopback relay: no allowlist entry needed', async () => {
        const baseUrl = getBaseUrl();
        const csrf = generateCsrf();
        const { verifier, challenge } = await generatePkce();

        // Loopback relay — http://127.0.0.1:<port> is implicitly allowed.
        const paramsResp = await fetch(`${baseUrl}/aws-blocks/auth/relay/authorize-params/google-relay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            csrf,
            relayTo: 'http://127.0.0.1:9876',
          }),
        });
        assert.strictEqual(paramsResp.status, 200);
        const params = await paramsResp.json() as any;
        assert.ok(params.state, 'should have signed state');

        // Drive through the IdP.
        const callbackUrl = `${baseUrl}/aws-blocks/auth/relay/callback`;
        const authorizeUrl = new URL(params.authorizeUrl);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('client_id', params.clientId);
        authorizeUrl.searchParams.set('redirect_uri', callbackUrl);
        authorizeUrl.searchParams.set('scope', params.scopes.join(' '));
        authorizeUrl.searchParams.set('state', params.state);
        authorizeUrl.searchParams.set('code_challenge', challenge);
        authorizeUrl.searchParams.set('code_challenge_method', 'S256');
        if (params.nonce) authorizeUrl.searchParams.set('nonce', params.nonce);

        const authResp = await fetch(authorizeUrl.toString(), { redirect: 'manual' });
        const idpRedirect = authResp.headers.get('location')!;

        const cbResp = await fetch(idpRedirect, { redirect: 'manual' });
        assert.strictEqual(cbResp.status, 302);
        const relayLocation = cbResp.headers.get('location')!;
        assert.ok(relayLocation.startsWith('http://127.0.0.1:9876'), `Should relay to loopback, got: ${relayLocation}`);
        const relayUrl = new URL(relayLocation);
        assert.ok(relayUrl.searchParams.get('code'), 'Should have code');
        assert.ok(relayUrl.searchParams.get('state'), 'Should have state');
      });

      test('app state round-trip: appState surfaces in the relay state param', async () => {
        const baseUrl = getBaseUrl();
        const csrf = generateCsrf();
        const { challenge } = await generatePkce();

        const paramsResp = await fetch(`${baseUrl}/aws-blocks/auth/relay/authorize-params/google-relay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            csrf,
            relayTo: 'testapp://auth',
            appState: 'my-custom-state-value',
          }),
        });
        assert.strictEqual(paramsResp.status, 200);
        const params = await paramsResp.json() as any;
        // The appState is inside the signed state envelope — the SDK decodes
        // it after verifying the HMAC. We just verify the state is present
        // and the round-trip completes.
        assert.ok(params.state, 'should have state with appState encoded');

        // Drive through IdP and verify relay works.
        const callbackUrl = `${baseUrl}/aws-blocks/auth/relay/callback`;
        const authorizeUrl = new URL(params.authorizeUrl);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('client_id', params.clientId);
        authorizeUrl.searchParams.set('redirect_uri', callbackUrl);
        authorizeUrl.searchParams.set('scope', params.scopes.join(' '));
        authorizeUrl.searchParams.set('state', params.state);
        authorizeUrl.searchParams.set('code_challenge', challenge);
        authorizeUrl.searchParams.set('code_challenge_method', 'S256');
        if (params.nonce) authorizeUrl.searchParams.set('nonce', params.nonce);

        const authResp = await fetch(authorizeUrl.toString(), { redirect: 'manual' });
        const cbResp = await fetch(authResp.headers.get('location')!, { redirect: 'manual' });
        assert.strictEqual(cbResp.status, 302);
        const relayUrl = new URL(cbResp.headers.get('location')!);
        // State param is the full envelope — SDK decodes it to get appState.
        assert.strictEqual(relayUrl.searchParams.get('state'), params.state);
      });

      test('wire-shape assertion: redirect_uri sent to IdP is the backend HTTPS URL, never relayTo', async () => {
        const baseUrl = getBaseUrl();
        const csrf = generateCsrf();
        const { challenge } = await generatePkce();

        const paramsResp = await fetch(`${baseUrl}/aws-blocks/auth/relay/authorize-params/google-relay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csrf, relayTo: 'testapp://auth' }),
        });
        const params = await paramsResp.json() as any;

        // The authorize URL the SDK builds must have redirect_uri = backend callback.
        const callbackUrl = `${baseUrl}/aws-blocks/auth/relay/callback`;
        const authorizeUrl = new URL(params.authorizeUrl);
        authorizeUrl.searchParams.set('redirect_uri', callbackUrl);

        // Verify the redirect_uri is the backend URL, not the relay target.
        assert.strictEqual(
          authorizeUrl.searchParams.get('redirect_uri'),
          callbackUrl,
          'redirect_uri must be the backend callback URL, not the relay target',
        );
        assert.ok(
          !authorizeUrl.searchParams.get('redirect_uri')!.includes('testapp://'),
          'redirect_uri must never be the custom scheme',
        );
      });

      // --- Negative tests: authorize-params ---

      test('negative: relay not in allowlist → 400 unknown-origin', async () => {
        const baseUrl = getBaseUrl();
        const resp = await fetch(`${baseUrl}/aws-blocks/auth/relay/authorize-params/google-relay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csrf: generateCsrf(), relayTo: 'evilapp://steal' }),
        });
        assert.strictEqual(resp.status, 400);
        const body = await resp.json() as any;
        assert.strictEqual(body.error, 'invalid_relay');
        assert.strictEqual(body.reason, 'unknown-origin');
      });

      test('relay with path allowed: testapp://auth/callback → 200 with state', async () => {
        const baseUrl = getBaseUrl();
        const csrf = generateCsrf();
        const { verifier, challenge } = await generatePkce();

        const resp = await fetch(`${baseUrl}/aws-blocks/auth/relay/authorize-params/google-relay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csrf, relayTo: 'testapp://auth/callback' }),
        });
        assert.strictEqual(resp.status, 200, `Expected 200, got ${resp.status}: ${await resp.clone().text()}`);
        const params = await resp.json() as any;
        assert.ok(params.state, 'should have signed state envelope');

        // Drive through IdP and verify path is preserved in relay Location.
        const callbackUrl = `${baseUrl}/aws-blocks/auth/relay/callback`;
        const authorizeUrl = new URL(params.authorizeUrl);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('client_id', params.clientId);
        authorizeUrl.searchParams.set('redirect_uri', callbackUrl);
        authorizeUrl.searchParams.set('scope', params.scopes.join(' '));
        authorizeUrl.searchParams.set('state', params.state);
        authorizeUrl.searchParams.set('code_challenge', challenge);
        authorizeUrl.searchParams.set('code_challenge_method', 'S256');
        if (params.nonce) authorizeUrl.searchParams.set('nonce', params.nonce);

        const authResp = await fetch(authorizeUrl.toString(), { redirect: 'manual' });
        const idpRedirect = authResp.headers.get('location')!;
        const cbResp = await fetch(idpRedirect, { redirect: 'manual' });
        assert.strictEqual(cbResp.status, 302);
        const relayLocation = cbResp.headers.get('location')!;
        // Path must be preserved and query params appended.
        assert.ok(relayLocation.startsWith('testapp://auth/callback'), `Should relay to testapp://auth/callback, got: ${relayLocation}`);
        const relayUrl = new URL(relayLocation);
        assert.ok(relayUrl.searchParams.get('code'), 'Should have code');
        assert.ok(relayUrl.searchParams.get('state'), 'Should have state');
      });

      test('negative: relay over plain HTTP (non-loopback) → 400 plaintext-non-loopback', async () => {
        const baseUrl = getBaseUrl();
        const resp = await fetch(`${baseUrl}/aws-blocks/auth/relay/authorize-params/google-relay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csrf: generateCsrf(), relayTo: 'http://example.com:8080' }),
        });
        assert.strictEqual(resp.status, 400);
        const body = await resp.json() as any;
        assert.strictEqual(body.error, 'invalid_relay');
        assert.strictEqual(body.reason, 'plaintext-non-loopback');
      });

      test('negative: malformed URI → 400 malformed', async () => {
        const baseUrl = getBaseUrl();
        const resp = await fetch(`${baseUrl}/aws-blocks/auth/relay/authorize-params/google-relay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csrf: generateCsrf(), relayTo: 'not a uri' }),
        });
        assert.strictEqual(resp.status, 400);
        const body = await resp.json() as any;
        assert.strictEqual(body.error, 'invalid_relay');
        assert.strictEqual(body.reason, 'malformed');
      });

      // --- Negative tests: callback ---

      test('negative: tampered state → 400 invalid_state', async () => {
        const baseUrl = getBaseUrl();
        // Hit callback directly with a tampered state (no pending-auth cookie).
        const resp = await fetch(`${baseUrl}/aws-blocks/auth/relay/callback?code=fake&state=tampered.garbage`, {
          redirect: 'manual',
        });
        assert.strictEqual(resp.status, 400);
        const body = await resp.json() as any;
        assert.strictEqual(body.error, 'invalid_state');
      });

      test('negative: wrong code (exchange fails) → 400', async () => {
        const baseUrl = getBaseUrl();
        const csrf = generateCsrf();
        const { verifier, challenge } = await generatePkce();

        // Get valid params and drive through IdP to get a valid relay redirect.
        const paramsResp = await fetch(`${baseUrl}/aws-blocks/auth/relay/authorize-params/google-relay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csrf, relayTo: 'testapp://auth' }),
        });
        const params = await paramsResp.json() as any;

        const callbackUrl = `${baseUrl}/aws-blocks/auth/relay/callback`;
        const authorizeUrl = new URL(params.authorizeUrl);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('client_id', params.clientId);
        authorizeUrl.searchParams.set('redirect_uri', callbackUrl);
        authorizeUrl.searchParams.set('scope', params.scopes.join(' '));
        authorizeUrl.searchParams.set('state', params.state);
        authorizeUrl.searchParams.set('code_challenge', challenge);
        authorizeUrl.searchParams.set('code_challenge_method', 'S256');
        if (params.nonce) authorizeUrl.searchParams.set('nonce', params.nonce);

        const authResp = await fetch(authorizeUrl.toString(), { redirect: 'manual' });
        const cbResp = await fetch(authResp.headers.get('location')!, { redirect: 'manual' });
        const relayUrl = new URL(cbResp.headers.get('location')!);
        const returnedState = relayUrl.searchParams.get('state')!;

        // Try to exchange with a wrong code.
        const exchangeResp = await fetch(`${baseUrl}/aws-blocks/auth/relay/exchange`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: 'wrong-code-does-not-exist',
            verifier,
            state: returnedState,
            nonce: params.nonce ?? '',
            provider: 'google-relay',
            callbackUrl,
          }),
        });
        assert.ok(exchangeResp.status >= 400, `Expected error, got ${exchangeResp.status}`);
      });

      // --- Stub IdP scheme rejection (Phase 5) ---

      test('stub IdP rejects custom-scheme redirect_uri', async () => {
        const baseUrl = getBaseUrl();
        // Hit the stub IdP's authorize endpoint directly with a custom-scheme
        // redirect_uri — this is what would happen if the relay flow
        // accidentally sent the custom scheme to the IdP instead of the
        // backend's HTTPS callback.
        const resp = await fetch(
          `${baseUrl}/aws-blocks/auth/idp/google-relay/authorize?` +
          `response_type=code&client_id=stub-client-id&` +
          `redirect_uri=${encodeURIComponent('testapp://auth/callback')}&` +
          `scope=openid&state=test&code_challenge=test&code_challenge_method=S256`,
          { redirect: 'manual' },
        );
        assert.strictEqual(resp.status, 400, 'Stub IdP should reject custom-scheme redirect_uri');
        const body = await resp.json() as any;
        assert.strictEqual(body.error, 'invalid_request');
        assert.ok(body.error_description.includes('HTTPS or loopback HTTP'));
      });

      test('stub IdP rejects plain HTTP non-loopback redirect_uri', async () => {
        const baseUrl = getBaseUrl();
        const resp = await fetch(
          `${baseUrl}/aws-blocks/auth/idp/google-relay/authorize?` +
          `response_type=code&client_id=stub-client-id&` +
          `redirect_uri=${encodeURIComponent('http://example.com/cb')}&` +
          `scope=openid&state=test&code_challenge=test&code_challenge_method=S256`,
          { redirect: 'manual' },
        );
        assert.strictEqual(resp.status, 400);
        const body = await resp.json() as any;
        assert.strictEqual(body.error, 'invalid_request');
      });

      test('stub IdP accepts loopback http://127.0.0.1 redirect_uri', async () => {
        const baseUrl = getBaseUrl();
        const resp = await fetch(
          `${baseUrl}/aws-blocks/auth/idp/google-relay/authorize?` +
          `response_type=code&client_id=stub-client-id&` +
          `redirect_uri=${encodeURIComponent('http://127.0.0.1:54321/cb')}&` +
          `scope=openid&state=test&nonce=test&code_challenge=test&code_challenge_method=S256`,
          { redirect: 'manual' },
        );
        assert.strictEqual(resp.status, 302, 'Loopback redirect_uri should be accepted');
      });

      test('stub IdP accepts https redirect_uri', async () => {
        const baseUrl = getBaseUrl();
        const resp = await fetch(
          `${baseUrl}/aws-blocks/auth/idp/google-relay/authorize?` +
          `response_type=code&client_id=stub-client-id&` +
          `redirect_uri=${encodeURIComponent('https://example.com/cb')}&` +
          `scope=openid&state=test&nonce=test&code_challenge=test&code_challenge_method=S256`,
          { redirect: 'manual' },
        );
        assert.strictEqual(resp.status, 302, 'HTTPS redirect_uri should be accepted');
      });
    });
  });
}

/**
 * Collect Set-Cookie values from a response. Returns name=value pairs for
 * cookies that are being set (not cleared).
 */
function collectCookies(resp: Response): string[] {
  const cookies: string[] = [];
  const setCookies: string[] = resp.headers.getSetCookie?.() ?? [];
  for (const sc of setCookies) {
    const firstSemi = sc.indexOf(';');
    const nv = firstSemi >= 0 ? sc.slice(0, firstSemi) : sc;
    if (nv && !sc.includes('Max-Age=0')) {
      cookies.push(nv);
    }
  }
  return cookies;
}

/**
 * Merge cookies, applying Set-Cookie semantics: new values override old ones.
 */
function mergeCookies(existing: string[], incoming: string[]): string[] {
  const map = new Map<string, string>();
  for (const c of existing) {
    const eq = c.indexOf('=');
    if (eq > 0) map.set(c.slice(0, eq), c);
  }
  for (const c of incoming) {
    const eq = c.indexOf('=');
    if (eq > 0) map.set(c.slice(0, eq), c);
  }
  return [...map.values()];
}

/**
 * Apply Set-Cookie headers from a response to an existing cookie jar,
 * properly handling cookie deletion (Max-Age=0 or empty value).
 */
function applyCookies(existing: string[], resp: Response): string[] {
  const map = new Map<string, string>();
  for (const c of existing) {
    const eq = c.indexOf('=');
    if (eq > 0) map.set(c.slice(0, eq), c);
  }
  const setCookies: string[] = resp.headers.getSetCookie?.() ?? [];
  for (const sc of setCookies) {
    const firstSemi = sc.indexOf(';');
    const nv = firstSemi >= 0 ? sc.slice(0, firstSemi) : sc;
    const eq = nv.indexOf('=');
    if (eq <= 0) continue;
    const name = nv.slice(0, eq);
    const value = nv.slice(eq + 1);
    if (!value || sc.includes('Max-Age=0')) {
      map.delete(name);
    } else {
      map.set(name, nv);
    }
  }
  return [...map.values()];
}
