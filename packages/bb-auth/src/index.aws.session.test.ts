// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS runtime — session lifecycle and cookie verification, against a spied
 * Cognito client (no network): cookie → verify → record lookup → access-token
 * expiry → `REFRESH_TOKEN_AUTH` → (re-issue | delete + clear cookie).
 *
 * Ported from `bb-auth-cognito/src/index.aws.session.test.ts` (B5/B6). Where an
 * expectation differs it says why, inline (`Auth:`). Renames: `fetchAuthSession`
 * → `getAuthSession` (D3). The "token-bearing call" these tests drive is
 * `updatePassword` (`ChangePassword`), not `fetchUserAttributes`: attribute
 * reads are D5c2's, and `updatePassword` exercises the same refresh-then-use
 * path. Harness: `test-support/aws-harness.ts`.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { BlocksContext } from '@aws-blocks/core';
import { isBlocksError } from '@aws-blocks/core';
import { signSessionId } from './cookies.js';
import { AuthErrors } from './index.aws.js';
import {
	Browser,
	cognitoError,
	makeAwsAuth,
	sessionIdOf,
	setCookieFor,
	signInAs,
	TEST_CLIENT_ID,
} from './test-support/aws-harness.js';

const DEFAULT_TTL = 400 * 86400;

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

/** Signed in, but the stored access token has already expired. */
async function signedInWithExpiredAccess(opts: { refreshToken?: string | null } = {}) {
	const h = makeAwsAuth();
	const b = new Browser();
	const tokens = h.idp.authResult('alice', { accessExpIn: -60, refreshToken: opts.refreshToken });
	const sid = await signInAs(h, b, 'alice', tokens);
	return { h, b, sid, tokens };
}

/** A token-bearing call: Cognito's `ChangePassword` with the session's access token. */
function changePassword(h: ReturnType<typeof makeAwsAuth>, ctx: BlocksContext): Promise<void> {
	return h.auth.updatePassword(ctx, 'Old!pass1', 'New!pass1');
}

describe('AWS session lookup (unexpired access token)', () => {
	test('no cookie → signed out, no Cognito call, no Set-Cookie', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		assert.strictEqual(await b.request((ctx) => h.auth.getCurrentUser(ctx)), null);
		assert.strictEqual(await b.request((ctx) => h.auth.checkAuth(ctx)), false);
		assert.deepStrictEqual(h.sent, []);
		assert.deepStrictEqual(b.lastSetCookies, []);
	});

	test('a valid session is served from the record: zero Cognito calls, cookie not re-issued', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		await signInAs(h, b, 'alice');
		const user = await b.request((ctx) => h.auth.getCurrentUser(ctx));
		assert.strictEqual(user?.username, 'alice');
		assert.strictEqual(await b.request((ctx) => h.auth.checkAuth(ctx)), true);
		assert.strictEqual((await b.request((ctx) => h.auth.requireAuth(ctx))).userSub, 'sub-alice');
		assert.deepStrictEqual(h.sent, []);
		assert.deepStrictEqual(b.lastSetCookies, []);
		assert.deepStrictEqual(h.sessionWrites, []);
	});

	test('a disabled or deleted user is not seen until the access token expires (added for Auth: L14)', async () => {
		// requireAuth makes no per-request liveness call: with an unexpired access
		// token the session is served from the record whatever Cognito would say.
		// The user is detected at the next refresh (see "a rejected refresh" below).
		const h = makeAwsAuth();
		const b = new Browser();
		await signInAs(h, b, 'alice');
		h.on('GetUserCommand', () => {
			throw cognitoError('NotAuthorizedException', 'User is disabled.');
		});
		assert.strictEqual((await b.request((ctx) => h.auth.requireAuth(ctx))).username, 'alice');
		assert.deepStrictEqual(h.sent, [], 'no Cognito call on a guarded request');
	});

	test('a cookie whose record is gone → signed out and the cookie is cleared', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		const sid = await signInAs(h, b, 'alice');
		await h.deleteSession(sid);
		assert.strictEqual(await b.request((ctx) => h.auth.getCurrentUser(ctx)), null);
		assert.ok(setCookieFor(b.lastSetCookies, h.cookieName)?.includes('Max-Age=0'));
		assert.strictEqual(b.jar.get(h.cookieName), undefined);
		assert.deepStrictEqual(h.sent, []);
	});

	test('requireAuth with no session → 401 NotAuthenticatedException', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		await assert.rejects(
			() => b.request((ctx) => h.auth.requireAuth(ctx)),
			(e: Error & { status?: number }) => e.status === 401 && isBlocksError(e, AuthErrors.NotAuthenticated),
		);
	});
});

describe('AWS session refresh (expired access token)', () => {
	test('sends InitiateAuth REFRESH_TOKEN_AUTH with the stored refresh token', async () => {
		const { h, b, tokens } = await signedInWithExpiredAccess();
		h.on('InitiateAuthCommand', () => ({
			AuthenticationResult: h.idp.authResult('alice', { refreshToken: null }),
		}));
		await b.request((ctx) => h.auth.getCurrentUser(ctx));
		assert.deepStrictEqual(h.sent, [
			{
				name: 'InitiateAuthCommand',
				input: {
					AuthFlow: 'REFRESH_TOKEN_AUTH',
					ClientId: TEST_CLIENT_ID,
					AuthParameters: { REFRESH_TOKEN: tokens.RefreshToken },
				},
			},
		]);
	});

	test('rewrites the same record with the new tokens (keeping the refresh token when not rotated) and slides the TTL', async () => {
		const { h, b, sid, tokens } = await signedInWithExpiredAccess();
		const fresh = h.idp.authResult('alice', { refreshToken: null, claims: { email: 'new@example.com' } });
		h.on('InitiateAuthCommand', () => ({ AuthenticationResult: fresh }));
		const user = await b.request((ctx) => h.auth.getCurrentUser(ctx));

		assert.deepStrictEqual(
			user?.attributes,
			{ email: 'new@example.com' },
			'user comes from the refreshed ID token',
		);
		assert.strictEqual(h.sessionWrites.length, 1);
		assert.deepStrictEqual(h.sessionWrites[0], {
			key: sid,
			value: { idToken: fresh.IdToken, accessToken: fresh.AccessToken, refreshToken: tokens.RefreshToken },
			options: { ttlSeconds: DEFAULT_TTL },
		});
	});

	test('stores a rotated refresh token when Cognito returns one', async () => {
		const { h, b, sid } = await signedInWithExpiredAccess();
		h.on('InitiateAuthCommand', () => ({
			AuthenticationResult: h.idp.authResult('alice', { refreshToken: 'rotated-rt' }),
		}));
		await b.request((ctx) => h.auth.getCurrentUser(ctx));
		assert.strictEqual((await h.lookupSession(sid))?.refreshToken, 'rotated-rt');
	});

	test('re-issues the cookie for the same session id with a fresh Max-Age', async () => {
		const { h, b, sid } = await signedInWithExpiredAccess();
		h.on('InitiateAuthCommand', () => ({ AuthenticationResult: h.idp.authResult('alice') }));
		await b.request((ctx) => h.auth.getCurrentUser(ctx));
		const line = setCookieFor(b.lastSetCookies, h.cookieName);
		assert.ok(line?.includes(`Max-Age=${DEFAULT_TTL}`));
		assert.strictEqual(sessionIdOf(b.jar.get(h.cookieName) ?? ''), sid, 'session id is not rotated on refresh');
	});

	test('after a refresh the next request is served without another Cognito call', async () => {
		const { h, b } = await signedInWithExpiredAccess();
		h.on('InitiateAuthCommand', () => ({ AuthenticationResult: h.idp.authResult('alice') }));
		await b.request((ctx) => h.auth.getCurrentUser(ctx));
		await b.request((ctx) => h.auth.getCurrentUser(ctx));
		assert.deepStrictEqual(h.sentNames(), ['InitiateAuthCommand']);
	});

	test('a rejected refresh → signed out, record deleted, cookie cleared', async () => {
		const { h, b, sid } = await signedInWithExpiredAccess();
		h.on('InitiateAuthCommand', () => {
			throw cognitoError('NotAuthorizedException', 'Refresh Token has been revoked');
		});
		assert.strictEqual(await b.request((ctx) => h.auth.getCurrentUser(ctx)), null);
		assert.strictEqual(await h.lookupSession(sid), null);
		assert.ok(setCookieFor(b.lastSetCookies, h.cookieName)?.includes('Max-Age=0'));
		assert.strictEqual(b.jar.get(h.cookieName), undefined);
		// The browser no longer replays the dead session.
		h.sent.length = 0;
		assert.strictEqual(await b.request((ctx) => h.auth.getCurrentUser(ctx)), null);
		assert.deepStrictEqual(h.sent, []);
	});

	test('a disabled or deleted user is signed out at the refresh (added for Auth: L14)', async () => {
		for (const err of [
			cognitoError('NotAuthorizedException', 'User is disabled.'),
			cognitoError('UserNotFoundException', 'User does not exist.'),
			cognitoError('PasswordResetRequiredException', 'Password reset required for the user'),
		]) {
			const { h, b, sid } = await signedInWithExpiredAccess();
			h.on('InitiateAuthCommand', () => {
				throw err;
			});
			await assert.rejects(
				() => b.request((ctx) => h.auth.requireAuth(ctx)),
				(e: Error & { status?: number }) => e.status === 401 && isBlocksError(e, AuthErrors.NotAuthenticated),
				err.name,
			);
			assert.strictEqual(await h.lookupSession(sid), null, err.name);
			assert.strictEqual(b.jar.get(h.cookieName), undefined, err.name);
		}
	});

	test('a transient refresh failure keeps the session and is a retriable 5xx (added for Auth: L15)', async () => {
		// Auth: AuthCognito signed the user out on ANY refresh failure; Auth keeps
		// the session for a Cognito blip (throttling, 5xx, network) — L15.
		for (const err of [
			cognitoError('TooManyRequestsException', 'Rate exceeded'),
			cognitoError('InternalErrorException', 'Internal server error.', 500),
			new TypeError('fetch failed'),
		]) {
			const { h, b, sid } = await signedInWithExpiredAccess();
			h.on('InitiateAuthCommand', () => {
				throw err;
			});
			await assert.rejects(
				() => b.request((ctx) => h.auth.requireAuth(ctx)),
				(e: Error & { status?: number; retriable?: boolean }) => {
					assert.notStrictEqual(e.status, 401, err.name);
					return true;
				},
			);
			assert.ok(await h.lookupSession(sid), `${err.name}: the session survives`);
			assert.ok(b.jar.get(h.cookieName), `${err.name}: the cookie is kept`);
			// Once Cognito recovers, the same session refreshes normally.
			h.on('InitiateAuthCommand', () => ({ AuthenticationResult: h.idp.authResult('alice') }));
			assert.strictEqual((await b.request((ctx) => h.auth.requireAuth(ctx))).username, 'alice');
		}
	});

	test('a refresh that returns no tokens is treated as rejected', async () => {
		const { h, b, sid } = await signedInWithExpiredAccess();
		h.on('InitiateAuthCommand', () => ({ AuthenticationResult: {} }));
		assert.strictEqual(await b.request((ctx) => h.auth.getCurrentUser(ctx)), null);
		assert.strictEqual(await h.lookupSession(sid), null);
		assert.strictEqual(b.jar.get(h.cookieName), undefined);
	});

	test('an expired session with no refresh token → signed out without calling Cognito', async () => {
		const { h, b, sid } = await signedInWithExpiredAccess({ refreshToken: null });
		assert.strictEqual(await b.request((ctx) => h.auth.getCurrentUser(ctx)), null);
		assert.deepStrictEqual(h.sent, []);
		assert.strictEqual(await h.lookupSession(sid), null);
		assert.strictEqual(b.jar.get(h.cookieName), undefined);
	});

	test('a session whose access token does not decode is signed out', async () => {
		// Auth: AuthCognito treated an unreadable access token as "expired" and
		// refreshed it. Auth's row parser (sessions.ts, D5a) rejects a pool row
		// whose ID or access token does not decode as one it did not write:
		// signed out, cookie cleared, no Cognito call. Cognito never issues a
		// non-JWT access token, so only a corrupted row can reach this.
		const h = makeAwsAuth();
		const b = new Browser();
		await signInAs(h, b, 'alice', { ...h.idp.authResult('alice'), AccessToken: 'not-a-jwt' });
		assert.strictEqual(await b.request((ctx) => h.auth.getCurrentUser(ctx)), null);
		assert.deepStrictEqual(h.sent, []);
		assert.strictEqual(b.jar.get(h.cookieName), undefined);
	});

	test('requireAuth after a rejected refresh → 401 NotAuthenticatedException', async () => {
		const { h, b } = await signedInWithExpiredAccess();
		h.on('InitiateAuthCommand', () => {
			throw cognitoError('NotAuthorizedException', 'Refresh Token has expired');
		});
		await assert.rejects(
			() => b.request((ctx) => h.auth.requireAuth(ctx)),
			(e: Error & { status?: number }) => e.status === 401 && isBlocksError(e, AuthErrors.NotAuthenticated),
		);
	});

	test('token-bearing calls refresh first, then use the NEW access token', async () => {
		const { h, b } = await signedInWithExpiredAccess();
		const fresh = h.idp.authResult('alice');
		h.on('InitiateAuthCommand', () => ({ AuthenticationResult: fresh }));
		h.on('ChangePasswordCommand', () => ({}));
		await b.request((ctx) => changePassword(h, ctx));
		assert.deepStrictEqual(h.sentNames(), ['InitiateAuthCommand', 'ChangePasswordCommand']);
		assert.deepStrictEqual(h.sent[1].input, {
			AccessToken: fresh.AccessToken,
			PreviousPassword: 'Old!pass1',
			ProposedPassword: 'New!pass1',
		});
	});

	test('token-bearing calls after a rejected refresh → 401, record deleted, cookie cleared', async () => {
		const { h, b, sid } = await signedInWithExpiredAccess();
		h.on('InitiateAuthCommand', () => {
			throw cognitoError('NotAuthorizedException', 'Refresh Token has expired');
		});
		await assert.rejects(
			() => b.request((ctx) => changePassword(h, ctx)),
			(e: Error & { status?: number }) => e.status === 401 && isBlocksError(e, AuthErrors.NotAuthenticated),
		);
		assert.deepStrictEqual(h.sentNames(), ['InitiateAuthCommand']);
		assert.strictEqual(await h.lookupSession(sid), null);
		assert.strictEqual(b.jar.get(h.cookieName), undefined);
	});

	/** Refresh answers with an ID token signed by a key that is not the pool's. */
	async function refreshWithForgedIdToken(claims: Record<string, unknown> = { 'cognito:groups': ['admins'] }) {
		const ctx = await signedInWithExpiredAccess();
		const { privateKey: foreign } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
		const genuine = ctx.h.idp.authResult('alice');
		const payload = JSON.parse(Buffer.from(genuine.IdToken.split('.')[1], 'base64url').toString());
		const forged = ctx.h.idp.sign({ ...payload, ...claims }, foreign);
		ctx.h.on('InitiateAuthCommand', () => ({ AuthenticationResult: { ...genuine, IdToken: forged } }));
		return { ...ctx, forged };
	}

	test('a refreshed ID token that fails verification → signed out, record deleted, cookie cleared', async () => {
		// The record's tokens are verified on sign-in AND every refresh (sessions.ts).
		const { h, b, sid } = await refreshWithForgedIdToken();
		assert.strictEqual(await b.request((ctx) => h.auth.getCurrentUser(ctx)), null);
		assert.strictEqual(await h.lookupSession(sid), null);
		assert.ok(setCookieFor(b.lastSetCookies, h.cookieName)?.includes('Max-Age=0'));
		assert.strictEqual(b.jar.get(h.cookieName), undefined);
		assert.deepStrictEqual(h.sessionWrites, [], 'the unverified token is never stored');
	});

	test('a refreshed ID token for another app client is rejected the same way', async () => {
		const { h, b, sid } = await refreshWithForgedIdToken();
		h.on('InitiateAuthCommand', () => ({
			AuthenticationResult: {
				...h.idp.authResult('alice'),
				IdToken: h.idp.idToken('alice', { aud: 'other-client' }),
			},
		}));
		assert.strictEqual(await b.request((ctx) => h.auth.getCurrentUser(ctx)), null);
		assert.strictEqual(await h.lookupSession(sid), null);
	});

	test('a failed refresh verification is a 401 on guarded and token-bearing calls, never a 500', async () => {
		type H = Awaited<ReturnType<typeof refreshWithForgedIdToken>>['h'];
		const calls: Record<string, (h: H, ctx: BlocksContext) => Promise<unknown>> = {
			requireAuth: (h, ctx) => h.auth.requireAuth(ctx),
			updatePassword: (h, ctx) => changePassword(h, ctx),
		};
		for (const [label, call] of Object.entries(calls)) {
			const { h, b } = await refreshWithForgedIdToken();
			await assert.rejects(
				() => b.request((ctx) => call(h, ctx)),
				(e: Error & { status?: number }) => e.status === 401 && isBlocksError(e, AuthErrors.NotAuthenticated),
				label,
			);
		}
		const { h, b } = await refreshWithForgedIdToken();
		assert.deepStrictEqual(await b.request((ctx) => h.auth.getAuthSession(ctx)), { tokens: undefined });
	});
});

describe('AWS getAuthSession', () => {
	test('no session → { tokens: undefined }', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		assert.deepStrictEqual(await b.request((ctx) => h.auth.getAuthSession(ctx)), { tokens: undefined });
	});

	test('valid session → stored tokens + userSub, no Cognito call', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		const tokens = h.idp.authResult('alice');
		await signInAs(h, b, 'alice', tokens);
		const s = await b.request((ctx) => h.auth.getAuthSession(ctx));
		assert.strictEqual(s.userSub, 'sub-alice');
		assert.strictEqual(String(s.tokens?.idToken), tokens.IdToken);
		assert.strictEqual(String(s.tokens?.accessToken), tokens.AccessToken);
		assert.deepStrictEqual(h.sent, []);
	});

	test('forceRefresh rotates even an unexpired session', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		const tokens = h.idp.authResult('alice');
		await signInAs(h, b, 'alice', tokens);
		const fresh = h.idp.authResult('alice');
		h.on('InitiateAuthCommand', () => ({ AuthenticationResult: fresh }));
		const s = await b.request((ctx) => h.auth.getAuthSession(ctx, { forceRefresh: true }));
		assert.deepStrictEqual(h.sent[0].input.AuthParameters, { REFRESH_TOKEN: tokens.RefreshToken });
		assert.strictEqual(String(s.tokens?.accessToken), fresh.AccessToken);
	});

	test('a rejected refresh → { tokens: undefined } and the cookie is cleared', async () => {
		const { h, b } = await signedInWithExpiredAccess();
		h.on('InitiateAuthCommand', () => {
			throw cognitoError('NotAuthorizedException', 'Refresh Token has expired');
		});
		assert.deepStrictEqual(await b.request((ctx) => h.auth.getAuthSession(ctx)), { tokens: undefined });
		assert.strictEqual(b.jar.get(h.cookieName), undefined);
	});
});

describe('AWS session cookie parse/verify — bad cookies mean signed-out, never a throw', () => {
	/** Every read path must answer "signed out" (or 401), never 500, and never reach Cognito. */
	async function assertSignedOut(h: ReturnType<typeof makeAwsAuth>, b: Browser, cookie: string) {
		const header = `${h.cookieName}=${cookie}`;
		assert.strictEqual(await b.request((ctx) => h.auth.getCurrentUser(ctx), b.context(header)), null, cookie);
		assert.strictEqual(await b.request((ctx) => h.auth.checkAuth(ctx), b.context(header)), false, cookie);
		assert.deepStrictEqual(await b.request((ctx) => h.auth.getAuthSession(ctx), b.context(header)), {
			tokens: undefined,
		});
		await assert.rejects(
			() => b.request((ctx) => h.auth.requireAuth(ctx), b.context(header)),
			(e: Error & { status?: number }) => e.status === 401 && isBlocksError(e, AuthErrors.NotAuthenticated),
		);
		await assert.rejects(
			() => b.request((ctx) => changePassword(h, ctx), b.context(header)),
			(e: Error & { status?: number }) => e.status === 401,
		);
		assert.deepStrictEqual(h.sent, [], 'a bad cookie never reaches Cognito');
	}

	test('tampered signature', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		await signInAs(h, b, 'alice');
		const good = b.jar.get(h.cookieName) ?? '';
		const last = good.at(-1) === 'A' ? 'B' : 'A';
		await assertSignedOut(h, b, `${good.slice(0, -1)}${last}`);
	});

	test('tampered session id under the original signature', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		await signInAs(h, b, 'alice');
		const good = b.jar.get(h.cookieName) ?? '';
		const sig = good.slice(good.lastIndexOf('.') + 1);
		await assertSignedOut(h, b, `${crypto.randomBytes(24).toString('base64url')}.${sig}`);
	});

	test('the right session id signed with the wrong secret', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		const sid = await signInAs(h, b, 'alice');
		await assertSignedOut(h, b, signSessionId(sid, 'not-the-session-secret'));
	});

	test('malformed values', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		await signInAs(h, b, 'alice');
		for (const bad of [
			'nodot',
			'.',
			'..',
			'a.b.c',
			'.sig-only',
			'sid-only.',
			'%E0%A4%A',
			'é.ü',
			'x'.repeat(8192),
		]) {
			await assertSignedOut(h, b, bad);
		}
	});

	test('a sibling cookie whose name merely ends with ours is ignored', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		await signInAs(h, b, 'alice');
		const good = b.jar.get(h.cookieName) ?? '';
		const header = `my_${h.cookieName}=${good}; ${h.cookieName}x=${good}`;
		assert.strictEqual(await b.request((ctx) => h.auth.getCurrentUser(ctx), b.context(header)), null);
	});

	test('the session cookie is found among unrelated cookies', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		await signInAs(h, b, 'alice');
		const good = b.jar.get(h.cookieName) ?? '';
		const header = `theme=dark; ${h.cookieName}=${good}; _ga=GA1.2.3`;
		assert.strictEqual(
			(await b.request((ctx) => h.auth.getCurrentUser(ctx), b.context(header)))?.username,
			'alice',
		);
	});

	test("another Auth instance's cookie is not accepted", async () => {
		const a = makeAwsAuth();
		const other = makeAwsAuth();
		const b = new Browser();
		await signInAs(a, b, 'alice');
		const good = b.jar.get(a.cookieName) ?? '';
		// Same value presented under the other instance's cookie name: different secret.
		assert.strictEqual(
			await b.request((ctx) => other.auth.getCurrentUser(ctx), b.context(`${other.cookieName}=${good}`)),
			null,
		);
	});
});
