// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * setAuthState error-name propagation tests for AuthBasic (issue #81). The
 * recommended client path catches the thrown ApiError and must surface its
 * structured `name` as `AuthState.errorName` so clients can branch with
 * `hasAuthError` instead of string-matching the human-facing message.
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import type { BlocksContext } from '@aws-blocks/core';
import { Scope, hasAuthError } from '@aws-blocks/core';
import type { AuthStateApi } from '@aws-blocks/auth-common';
import { AuthBasic, AuthBasicErrors, type AuthBasicOptions } from './index.js';
import { BB_NAME, BB_VERSION } from './version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function ctx(origin?: string): BlocksContext {
	const headers = new Headers();
	if (origin) headers.set('origin', origin);
	return {
		request: { headers },
		response: { headers: new Headers() },
	} as unknown as BlocksContext;
}

let counter = 0;
function makeAuth(options?: AuthBasicOptions): AuthBasic {
	const scope = new Scope(`basic-errname-${++counter}-${Math.random().toString(36).slice(2, 6)}`);
	return new AuthBasic(scope, 'auth', options);
}

// `createApi()` returns a context-bound `ApiNamespace` callable; narrow it to
// the public `AuthStateApi` surface the test exercises instead of `as any`.
function apiFor(auth: AuthBasic, context: BlocksContext): AuthStateApi {
	return (auth.createApi() as unknown as (c: BlocksContext) => AuthStateApi)(context);
}

describe('AuthBasic setAuthState errorName', () => {
	test('signIn for an unknown user surfaces errorName = InvalidCredentials', async () => {
		const auth = makeAuth();
		const api = apiFor(auth, ctx());

		const next = await api.setAuthState({ action: 'signIn', username: 'nobody', password: 'whatever1' });

		assert.strictEqual(next.state, 'signedOut');
		assert.strictEqual(next.errorName, AuthBasicErrors.InvalidCredentials);
		// The documented client idiom now reaches this path.
		assert.ok(hasAuthError(next, AuthBasicErrors.InvalidCredentials));
	});

	test('signIn with a wrong password surfaces errorName = InvalidCredentials', async () => {
		const auth = makeAuth();
		await auth.signUp('alice', 'password123');
		const api = apiFor(auth, ctx());

		const next = await api.setAuthState({ action: 'signIn', username: 'alice', password: 'wrong-password' });

		assert.strictEqual(next.state, 'signedOut');
		assert.strictEqual(next.errorName, AuthBasicErrors.InvalidCredentials);
	});

	test('a nameless ApiError surfaces its own message but no errorName', async () => {
		// resetPassword throws a plain ApiError('Password reset not configured')
		// with no `name` when codeDelivery is unset — `.name` defaults to
		// DEFAULT_API_ERROR_NAME, which must not leak as a meaningful errorName.
		// But the message IS an intentional, wire-safe ApiError message, so it
		// must still reach the client (not be masked to the generic fallback).
		const auth = makeAuth();
		const api = apiFor(auth, ctx());

		const next = await api.setAuthState({ action: 'resetPassword', username: 'alice' });

		assert.strictEqual(next.state, 'signedOut');
		assert.strictEqual(next.error, 'Password reset not configured');
		assert.strictEqual(next.errorName, undefined);
	});

	test('a raw SDK error is masked to a generic message (no metadata leak)', async () => {
		// A non-wire-safe error (raw Error with SDK-shaped metadata) must be
		// reported generically — its message can carry ARNs/account ids.
		const auth = makeAuth();
		await auth.signUp('alice', 'password123');
		const store = (auth as unknown as { users: { get: (...a: unknown[]) => Promise<unknown> } }).users;
		const realGet = store.get.bind(store);
		store.get = async () => {
			throw new Error('arn:aws:sts::123456789012:assumed-role/x dynamodb:GetItem denied');
		};
		try {
			const api = apiFor(auth, ctx());
			const next = await api.setAuthState({ action: 'signIn', username: 'alice', password: 'password123' });
			assert.strictEqual(next.error, 'An unexpected error occurred');
			assert.strictEqual(next.errorName, undefined);
		} finally {
			store.get = realGet;
		}
	});
});

describe('AuthBasic confirm forms echo the username (no blank retype)', () => {
	test('signUp → confirmingSignUp carries the username as a hidden, prefilled field', async () => {
		const auth = makeAuth({ codeDelivery: async () => {} });
		const api = apiFor(auth, ctx());

		const next = await api.setAuthState({ action: 'signUp', username: 'alice@example.com', password: 'password123' });

		assert.strictEqual(next.state, 'confirmingSignUp');
		const field = next.actions?.[0]?.fields?.find((f) => f.name === 'username');
		assert.ok(field, 'confirmSignUp exposes a username field');
		assert.strictEqual(field!.type, 'hidden', 'username is hidden (echoed, not a blank retype box)');
		assert.strictEqual(field!.defaultValue, 'alice@example.com', 'username is prefilled with the just-entered value');
	});

	test('resetPassword → confirmingPasswordReset carries the username as a hidden, prefilled field', async () => {
		const auth = makeAuth({ codeDelivery: async () => {} });
		await auth.signUp('bob@example.com', 'password123');
		const api = apiFor(auth, ctx());

		const next = await api.setAuthState({ action: 'resetPassword', username: 'bob@example.com' });

		assert.strictEqual(next.state, 'confirmingPasswordReset');
		const field = next.actions?.[0]?.fields?.find((f) => f.name === 'username');
		assert.ok(field, 'confirmResetPassword exposes a username field');
		assert.strictEqual(field!.type, 'hidden');
		assert.strictEqual(field!.defaultValue, 'bob@example.com');
	});
});

/**
 * Server-side session revocation on sign-out (issue #766). A signed JWT stays
 * cryptographically valid until its `exp`; clearing the browser cookie does not
 * stop a copied/stolen token from being replayed. These tests prove sign-out
 * records the token's `jti` so a replay of the same token is rejected, while an
 * unrevoked session keeps working.
 */

/** Pull the auth token out of a response's `Set-Cookie`, or null if none/cleared. */
function tokenFromResponse(context: BlocksContext): string | null {
	const setCookie = context.response.headers.get('set-cookie');
	if (!setCookie) return null;
	const m = setCookie.match(/auth_[^=]+=([^;]+)/);
	// A cleared cookie is `auth_...=; Max-Age=0`, i.e. an empty value.
	return m && m[1] ? m[1] : null;
}

/** A fresh request context carrying `token` as the auth cookie. */
function ctxWithToken(auth: AuthBasic, token: string): BlocksContext {
	const headers = new Headers();
	headers.set('cookie', `auth_${auth.fullId}=${token}`);
	return {
		request: { headers },
		response: { headers: new Headers() },
	} as unknown as BlocksContext;
}

describe('AuthBasic session revocation on sign-out', () => {
	test('a token revoked at sign-out is rejected on replay', async () => {
		const auth = makeAuth();
		await auth.signUp('alice', 'password123');

		// Sign in and capture the issued token.
		const signInCtx = ctx();
		await auth.signIn('alice', 'password123', signInCtx);
		const token = tokenFromResponse(signInCtx);
		assert.ok(token, 'signIn issued a session token');

		// The token authenticates before sign-out.
		assert.strictEqual(await auth.checkAuth(ctxWithToken(auth, token!)), true);

		// Sign out WITH the token present, so its jti is revoked.
		await auth.signOut(ctxWithToken(auth, token!));

		// Replaying the exact same (still unexpired, still signature-valid) token
		// now fails — this is the gap #762/#766 names: pre-fix it still worked.
		assert.strictEqual(await auth.checkAuth(ctxWithToken(auth, token!)), false);
		await assert.rejects(
			() => auth.requireAuth(ctxWithToken(auth, token!)),
			(e: Error & { name?: string }) => e.name === AuthBasicErrors.SessionRevoked,
		);
	});

	test('a different, unrevoked session keeps working after another signs out', async () => {
		const auth = makeAuth();
		await auth.signUp('alice', 'password123');

		const firstCtx = ctx();
		await auth.signIn('alice', 'password123', firstCtx);
		const firstToken = tokenFromResponse(firstCtx)!;

		const secondCtx = ctx();
		await auth.signIn('alice', 'password123', secondCtx);
		const secondToken = tokenFromResponse(secondCtx)!;

		// Distinct tokens get distinct jti, so revoking one leaves the other.
		assert.notStrictEqual(firstToken, secondToken, 'each sign-in issues a unique token');

		await auth.signOut(ctxWithToken(auth, firstToken));

		assert.strictEqual(await auth.checkAuth(ctxWithToken(auth, firstToken)), false, 'revoked session rejected');
		assert.strictEqual(await auth.checkAuth(ctxWithToken(auth, secondToken)), true, 'other session still valid');
	});

	test('sign-out with no cookie is a no-op (nothing to revoke, no throw)', async () => {
		const auth = makeAuth();
		await assert.doesNotReject(() => auth.signOut(ctx()));
	});

	test('an absent session reports SessionExpired, not SessionRevoked', async () => {
		const auth = makeAuth();
		// No cookie at all → requireAuth must still throw SessionExpired, so the
		// revoked name is reserved strictly for an actually-revoked token.
		await assert.rejects(
			() => auth.requireAuth(ctx()),
			(e: Error & { name?: string }) => e.name === AuthBasicErrors.SessionExpired,
		);
	});

	test('a failed revocation write clears the cookie and throws a branded error (no SDK leak)', async () => {
		const auth = makeAuth();
		await auth.signUp('alice', 'password123');
		const signInCtx = ctx();
		await auth.signIn('alice', 'password123', signInCtx);
		const token = tokenFromResponse(signInCtx)!;

		// Make the revocation-list write fail like a transient DynamoDB error
		// whose message carries SDK metadata (ARNs/account id).
		const store = (auth as unknown as { codes: { put: (...a: unknown[]) => Promise<void> } }).codes;
		const realPut = store.put.bind(store);
		const rawSdkMessage =
			'User: arn:aws:sts::123456789012:assumed-role/x is not authorized to perform: dynamodb:PutItem';
		store.put = async () => {
			throw new Error(rawSdkMessage);
		};
		try {
			const signOutCtx = ctxWithToken(auth, token);
			// signOut must reject so the caller knows the token was NOT revoked.
			let caught: (Error & { name?: string; status?: number }) | undefined;
			try {
				await auth.signOut(signOutCtx);
			} catch (e) {
				caught = e as Error & { name?: string; status?: number };
			}
			assert.ok(caught, 'signOut rejected when the revocation write failed');
			// ...with the branded name and a STABLE message, never the raw SDK
			// error (no ARN/account-id leak).
			assert.strictEqual(caught.name, AuthBasicErrors.SignOutIncomplete);
			assert.doesNotMatch(caught.message, /arn:aws|123456789012|dynamodb:PutItem/);
			// ...and the local cookie is still cleared (sign-out on this device
			// always succeeds — the user is never left stuck signed in).
			const setCookie = signOutCtx.response.headers.get('set-cookie');
			assert.ok(setCookie, 'signOut sent a Set-Cookie even though the revocation write failed');
			assert.match(setCookie, /auth_[^=]+=;/, 'the Set-Cookie clears the session cookie (empty value)');

			// ...and through the createApi state machine, the reported state is
			// signedOut — not the request cookie's still-valid signedIn — so the
			// Authenticator does not show the user signed in with no session.
			const smCtx = ctxWithToken(auth, token);
			const next = await apiFor(auth, smCtx).setAuthState({ action: 'signOut' });
			assert.strictEqual(next.state, 'signedOut', 'a failed sign-out still reports signedOut');
			assert.strictEqual(next.errorName, AuthBasicErrors.SignOutIncomplete);
			assert.doesNotMatch(next.error ?? '', /arn:aws|123456789012|dynamodb:PutItem/);
		} finally {
			store.put = realPut;
		}
	});

	test('the revocation marker expires exactly at the token exp (self-trims, never earlier)', async () => {
		const auth = makeAuth();
		await auth.signUp('alice', 'password123');
		const signInCtx = ctx();
		await auth.signIn('alice', 'password123', signInCtx);
		const token = tokenFromResponse(signInCtx)!;
		const decodedExp = (jwt.decode(token) as { exp: number }).exp;

		// Capture the expiresAt the revocation write is given.
		const store = (auth as unknown as {
			codes: { put: (key: string, value: string, opts?: { expiresAt?: number }) => Promise<void> };
		}).codes;
		const realPut = store.put.bind(store);
		let capturedExpiresAt: number | undefined;
		store.put = async (key, value, opts) => {
			if (key.startsWith('revoked:')) capturedExpiresAt = opts?.expiresAt;
			return realPut(key, value, opts);
		};
		try {
			await auth.signOut(ctxWithToken(auth, token));
		} finally {
			store.put = realPut;
		}
		// Guards the mutation `expiresAt = exp - 3600` (which would let a revoked
		// token re-authenticate for its last hour): the marker must live exactly
		// as long as the token, not a second less.
		assert.strictEqual(capturedExpiresAt, decodedExp, 'revocation marker expiresAt equals the token exp');
	});

	test('a verified token with no exp is rejected (cannot outlive its revocation marker)', async () => {
		const auth = makeAuth();
		await auth.signUp('alice', 'password123');

		// Forge a token signed with the REAL secret and issuer but carrying no
		// `exp` — the one shape that could survive past its self-expiring
		// revocation marker and re-authenticate. parseSessionToken must treat it
		// as absent so no token can outlive its own revocation entry.
		const secret = await (auth as unknown as { getSecret(): Promise<string> }).getSecret();
		const expLess = jwt.sign({ username: 'alice', jti: 'forged' }, secret, {
			algorithm: 'HS256',
			issuer: `bb-auth-basic:${auth.fullId}`,
			// no expiresIn → no `exp` claim
		});

		assert.strictEqual(await auth.checkAuth(ctxWithToken(auth, expLess)), false);
		await assert.rejects(
			() => auth.requireAuth(ctxWithToken(auth, expLess)),
			(e: Error & { name?: string }) => e.name === AuthBasicErrors.SessionExpired,
		);
	});
});

/**
 * Session invalidation on credential change. A password reset is the primary
 * remediation for a compromised account, so every session issued BEFORE the
 * reset must stop authenticating — not just the one token that happens to sign
 * out. AuthBasic stamps the user's session epoch into each token (`ep` claim)
 * and bumps the stored epoch on `confirmResetPassword`; a token whose `ep`
 * predates the stored epoch is rejected as revoked. Unlike the per-`jti`
 * sign-out revocation, this invalidates ALL outstanding sessions at once.
 */
describe('AuthBasic session invalidation on password reset', () => {
	/** makeAuth that captures the delivered verification code so a test can present it. */
	function captureAuth(): { auth: AuthBasic; lastCode: () => string } {
		let code = '';
		const auth = makeAuth({
			codeDelivery: async (_username, c) => {
				code = c;
			},
		});
		return { auth, lastCode: () => code };
	}

	test('a pre-reset token stops authenticating after confirmResetPassword', async () => {
		const { auth, lastCode } = captureAuth();
		await auth.signUp('alice', 'password123');
		await auth.confirmSignUp('alice', lastCode());

		// Sign in BEFORE the reset and capture the token (a "stolen" session).
		const signInCtx = ctx();
		await auth.signIn('alice', 'password123', signInCtx);
		const preResetToken = tokenFromResponse(signInCtx)!;
		assert.strictEqual(await auth.checkAuth(ctxWithToken(auth, preResetToken)), true, 'valid before reset');

		// Complete a password reset.
		await auth.resetPassword('alice');
		await auth.confirmResetPassword('alice', lastCode(), 'newpassword456');

		// The pre-reset token — still unexpired and signature-valid — no longer
		// authenticates: the epoch bump invalidated every session minted before
		// the reset. This is the #912 gap: pre-fix the stolen token kept working.
		assert.strictEqual(await auth.checkAuth(ctxWithToken(auth, preResetToken)), false, 'invalid after reset');
		await assert.rejects(
			() => auth.requireAuth(ctxWithToken(auth, preResetToken)),
			(e: Error & { name?: string }) => e.name === AuthBasicErrors.SessionRevoked,
			'a pre-reset token is reported as revoked',
		);
	});

	test('a token issued AFTER the reset authenticates normally', async () => {
		const { auth, lastCode } = captureAuth();
		await auth.signUp('bob', 'password123');
		await auth.confirmSignUp('bob', lastCode());
		await auth.resetPassword('bob');
		await auth.confirmResetPassword('bob', lastCode(), 'newpassword456');

		// Signing in after the reset carries the bumped epoch, so it is valid.
		const postResetCtx = ctx();
		await auth.signIn('bob', 'newpassword456', postResetCtx);
		const postResetToken = tokenFromResponse(postResetCtx)!;
		assert.strictEqual(await auth.checkAuth(ctxWithToken(auth, postResetToken)), true, 'post-reset token valid');
	});

	test('resetting one user does not invalidate another user’s sessions', async () => {
		const { auth, lastCode } = captureAuth();
		await auth.signUp('carol', 'password123');
		await auth.confirmSignUp('carol', lastCode());
		await auth.signUp('dave', 'password123');
		await auth.confirmSignUp('dave', lastCode());

		const daveCtx = ctx();
		await auth.signIn('dave', 'password123', daveCtx);
		const daveToken = tokenFromResponse(daveCtx)!;

		// Reset carol — the epoch is per-user, so dave's session is untouched.
		await auth.resetPassword('carol');
		await auth.confirmResetPassword('carol', lastCode(), 'newpassword456');

		assert.strictEqual(await auth.checkAuth(ctxWithToken(auth, daveToken)), true, 'dave unaffected by carol reset');
	});

	test('every outstanding session for the user is invalidated, not just one', async () => {
		const { auth, lastCode } = captureAuth();
		await auth.signUp('erin', 'password123');
		await auth.confirmSignUp('erin', lastCode());

		// Two independent sessions (e.g. two devices).
		const laptopCtx = ctx();
		await auth.signIn('erin', 'password123', laptopCtx);
		const laptopToken = tokenFromResponse(laptopCtx)!;
		const phoneCtx = ctx();
		await auth.signIn('erin', 'password123', phoneCtx);
		const phoneToken = tokenFromResponse(phoneCtx)!;
		assert.notStrictEqual(laptopToken, phoneToken, 'two distinct sessions');

		await auth.resetPassword('erin');
		await auth.confirmResetPassword('erin', lastCode(), 'newpassword456');

		// Both pre-reset sessions are gone — the epoch bump is session-wide, not
		// per-jti like sign-out.
		assert.strictEqual(await auth.checkAuth(ctxWithToken(auth, laptopToken)), false, 'laptop session invalidated');
		assert.strictEqual(await auth.checkAuth(ctxWithToken(auth, phoneToken)), false, 'phone session invalidated');
	});

	test('a token with no `ep` claim (issued before the feature) is invalidated by the first reset', async () => {
		const { auth, lastCode } = captureAuth();
		await auth.signUp('frank', 'password123');
		await auth.confirmSignUp('frank', lastCode());

		// Forge a legacy token: real secret + issuer + jti + exp, but NO `ep`
		// claim — the shape of a session issued before this feature shipped.
		const secret = await (auth as unknown as { getSecret(): Promise<string> }).getSecret();
		const legacyToken = jwt.sign({ username: 'frank', jti: 'legacy' }, secret, {
			algorithm: 'HS256',
			issuer: `bb-auth-basic:${auth.fullId}`,
			expiresIn: '1h',
		});
		assert.strictEqual(await auth.checkAuth(ctxWithToken(auth, legacyToken)), true, 'legacy token valid pre-reset');

		// The first reset bumps the epoch to 1; the legacy token reads as epoch 0
		// and is rejected.
		await auth.resetPassword('frank');
		await auth.confirmResetPassword('frank', lastCode(), 'newpassword456');
		assert.strictEqual(await auth.checkAuth(ctxWithToken(auth, legacyToken)), false, 'legacy token invalidated');
	});

	/** Sign up, confirm, and sign in `username`; returns the session token. */
	async function signedInToken(auth: AuthBasic, lastCode: () => string, username: string): Promise<string> {
		await auth.signUp(username, 'password123');
		await auth.confirmSignUp(username, lastCode());
		const signInCtx = ctx();
		await auth.signIn(username, 'password123', signInCtx);
		return tokenFromResponse(signInCtx)!;
	}

	/** Make every `epoch:` put fail like a DynamoDB error carrying SDK metadata. Returns a restore function. */
	function failEpochPuts(auth: AuthBasic, message: string, times = Number.POSITIVE_INFINITY): () => void {
		const store = codesStore(auth);
		const realPut = store.put.bind(store);
		let failures = 0;
		store.put = async (key, value, opts) => {
			if (key.startsWith('epoch:') && failures < times) {
				failures++;
				throw new Error(message);
			}
			return realPut(key, value, opts);
		};
		return () => {
			store.put = realPut;
		};
	}

	const rawSdkMessage = 'User: arn:aws:sts::123456789012:assumed-role/x is not authorized to perform: dynamodb:PutItem';

	test('a failed epoch bump changes nothing, and a fresh reset then invalidates the pre-reset token', async () => {
		const { auth, lastCode } = captureAuth();
		const preResetToken = await signedInToken(auth, lastCode, 'grace');
		await auth.resetPassword('grace');

		const restore = failEpochPuts(auth, rawSdkMessage);
		let caught: Error | undefined;
		try {
			await auth.confirmResetPassword('grace', lastCode(), 'newpassword456');
		} catch (e) {
			if (e instanceof Error) caught = e;
		} finally {
			restore();
		}
		assert.ok(caught, 'confirmResetPassword rejected when the epoch bump failed');
		assert.strictEqual(caught.name, AuthBasicErrors.SignOutIncomplete, 'branded as SignOutIncomplete');
		assert.doesNotMatch(caught.message, /arn:aws|123456789012|dynamodb:PutItem/, 'no SDK metadata leaked');

		// Nothing changed: the old password still works and the new one does not.
		await auth.signIn('grace', 'password123', ctx());
		await assert.rejects(() => auth.signIn('grace', 'newpassword456', ctx()));

		// The documented recovery: request a new code and reset again.
		await auth.resetPassword('grace');
		await auth.confirmResetPassword('grace', lastCode(), 'newpassword456');
		assert.strictEqual(await auth.checkAuth(ctxWithToken(auth, preResetToken)), false, 'pre-reset token rejected');
		await auth.signIn('grace', 'newpassword456', ctx());
	});

	test('a transient epoch write failure is retried inline and the reset succeeds', async () => {
		const { auth, lastCode } = captureAuth();
		const preResetToken = await signedInToken(auth, lastCode, 'heidi');
		await auth.resetPassword('heidi');

		const restore = failEpochPuts(auth, 'ThrottlingException', 1);
		try {
			await auth.confirmResetPassword('heidi', lastCode(), 'newpassword456');
		} finally {
			restore();
		}
		assert.strictEqual(await auth.checkAuth(ctxWithToken(auth, preResetToken)), false, 'pre-reset token rejected');
	});

	test('a failure of the post-write bump still completes the reset and invalidates pre-reset tokens', async () => {
		const { auth, lastCode } = captureAuth();
		const preResetToken = await signedInToken(auth, lastCode, 'ivan');
		await auth.resetPassword('ivan');

		// Let the first bump through, then fail every later epoch write.
		const store = codesStore(auth);
		const realPut = store.put.bind(store);
		let epochWrites = 0;
		store.put = async (key, value, opts) => {
			if (key.startsWith('epoch:') && epochWrites++ > 0) throw new Error(rawSdkMessage);
			return realPut(key, value, opts);
		};
		try {
			await auth.confirmResetPassword('ivan', lastCode(), 'newpassword456');
		} finally {
			store.put = realPut;
		}
		assert.strictEqual(await auth.checkAuth(ctxWithToken(auth, preResetToken)), false, 'pre-reset token rejected');
		await auth.signIn('ivan', 'newpassword456', ctx());
	});

	test('a second reset invalidates a token issued after the first', async () => {
		const { auth, lastCode } = captureAuth();
		await signedInToken(auth, lastCode, 'judy');
		await auth.resetPassword('judy');
		await auth.confirmResetPassword('judy', lastCode(), 'newpassword456');

		const betweenCtx = ctx();
		await auth.signIn('judy', 'newpassword456', betweenCtx);
		const betweenToken = tokenFromResponse(betweenCtx)!;
		assert.strictEqual(await auth.checkAuth(ctxWithToken(auth, betweenToken)), true, 'valid before the second reset');

		await auth.resetPassword('judy');
		await auth.confirmResetPassword('judy', lastCode(), 'newerpassword789');
		assert.strictEqual(await auth.checkAuth(ctxWithToken(auth, betweenToken)), false, 'invalid after the second reset');
	});

	test('a stale epoch read during the bump does not let a token survive the reset', async () => {
		const { auth, lastCode } = captureAuth();
		await signedInToken(auth, lastCode, 'kim');
		await auth.resetPassword('kim');
		await auth.confirmResetPassword('kim', lastCode(), 'newpassword456');
		const signInCtx = ctx();
		await auth.signIn('kim', 'newpassword456', signInCtx);
		const token = tokenFromResponse(signInCtx)!;

		// The first epoch read of EACH bump returns the value from before the
		// first reset, as an eventually consistent replica could. Two stale reads mean the
		// post-write bump cannot mask a plain read-modify-write: only the
		// compare-and-swap moves the epoch past the token's `ep`.
		const store = codesStore(auth);
		const realGet = store.get.bind(store);
		let staleReads = 2;
		store.get = async (key) => {
			if (key === 'epoch:kim' && staleReads > 0) {
				staleReads--;
				return null;
			}
			return realGet(key);
		};
		await auth.resetPassword('kim');
		try {
			await auth.confirmResetPassword('kim', lastCode(), 'newerpassword789');
		} finally {
			store.get = realGet;
		}
		assert.strictEqual(await auth.checkAuth(ctxWithToken(auth, token)), false, 'token rejected after the second reset');
	});

	test('a failed epoch read fails closed for sign-in and for authenticated requests', async () => {
		const { auth, lastCode } = captureAuth();
		const token = await signedInToken(auth, lastCode, 'lena');

		const store = codesStore(auth);
		const realGet = store.get.bind(store);
		store.get = async (key) => {
			if (key.startsWith('epoch:')) throw new Error('ProvisionedThroughputExceededException');
			return realGet(key);
		};
		try {
			await assert.rejects(() => auth.checkAuth(ctxWithToken(auth, token)), 'checkAuth does not succeed');
			await assert.rejects(() => auth.requireAuth(ctxWithToken(auth, token)), 'requireAuth does not succeed');
			const signInCtx = ctx();
			await assert.rejects(() => auth.signIn('lena', 'password123', signInCtx), 'signIn does not succeed');
			assert.strictEqual(tokenFromResponse(signInCtx), null, 'no session cookie issued');
		} finally {
			store.get = realGet;
		}
	});

	test('a corrupt epoch marker reads as 0 and the next reset re-establishes it', async () => {
		const { auth, lastCode } = captureAuth();
		const token = await signedInToken(auth, lastCode, 'mia');
		await codesStore(auth).put('epoch:mia', 'not-a-number');
		assert.strictEqual(await auth.checkAuth(ctxWithToken(auth, token)), true, 'corrupt marker reads as 0');

		await auth.resetPassword('mia');
		await auth.confirmResetPassword('mia', lastCode(), 'newpassword456');
		assert.strictEqual(await auth.checkAuth(ctxWithToken(auth, token)), false, 'token rejected after reset');
	});
});

/**
 * Sign-in throttling / account lockout (issue #766). AuthBasic can lock an
 * account after too many consecutive failed sign-ins, matching the Cognito-
 * managed lockout the equivalent CDK stack provides. Throttling is opt-in: with
 * no `lockout` option, sign-in behaves exactly as before (no lock, ever).
 */

/** Reach the private `codes` KVStore a lockout counter is stored in (test plumbing). */
function codesStore(auth: AuthBasic): {
	get: (k: string) => Promise<string | null>;
	put: (
		k: string,
		v: string,
		o?: { ttlSeconds?: number; expiresAt?: number; ifValueEquals?: string; ifNotExists?: boolean },
	) => Promise<void>;
	delete: (k: string, o?: { ifValueEquals?: string }) => Promise<void>;
} {
	return (auth as unknown as { codes: ReturnType<typeof codesStore> }).codes;
}

describe('AuthBasic sign-in throttling / lockout', () => {
	test('locks the account after maxAttempts consecutive failures', async () => {
		const auth = makeAuth({ lockout: { maxAttempts: 3 } });
		await auth.signUp('alice', 'password123');

		// Three wrong-password attempts: each rejects with InvalidCredentials.
		for (let i = 0; i < 3; i++) {
			await assert.rejects(
				auth.signIn('alice', 'wrong-password', ctx()),
				(e: Error & { name?: string }) => e.name === AuthBasicErrors.InvalidCredentials,
			);
		}

		// The next attempt — even with the CORRECT password — is locked out (429).
		await assert.rejects(
			auth.signIn('alice', 'password123', ctx()),
			(e: Error & { name?: string }) => e.name === AuthBasicErrors.AccountLocked,
		);
	});

	test('a lockout error is a 429 with a generic, non-leaking message', async () => {
		const auth = makeAuth({ lockout: { maxAttempts: 1 } });
		await auth.signUp('bob', 'password123');
		await assert.rejects(auth.signIn('bob', 'wrong', ctx())); // trips the lock (maxAttempts=1)

		let caught: (Error & { status?: number; name?: string }) | undefined;
		try {
			await auth.signIn('bob', 'password123', ctx());
		} catch (e) {
			caught = e as Error & { status?: number; name?: string };
		}
		assert.ok(caught, 'locked sign-in throws');
		assert.strictEqual(caught!.name, AuthBasicErrors.AccountLocked);
		assert.strictEqual((caught as unknown as { status: number }).status, 429);
		assert.doesNotMatch(caught!.message, /arn:|password|bob/i, 'message leaks neither the username nor metadata');
	});

	test('a successful sign-in clears the failure counter', async () => {
		const auth = makeAuth({ lockout: { maxAttempts: 3 } });
		await auth.signUp('carol', 'password123');

		// Two failures (below the threshold of 3)…
		await assert.rejects(auth.signIn('carol', 'wrong', ctx()));
		await assert.rejects(auth.signIn('carol', 'wrong', ctx()));
		// …then a success clears the count.
		await auth.signIn('carol', 'password123', ctx());

		// A fresh pair of failures must not trip the lock (counter was reset),
		// so the correct password still works on the very next try.
		await assert.rejects(auth.signIn('carol', 'wrong', ctx()));
		await assert.rejects(auth.signIn('carol', 'wrong', ctx()));
		const user = await auth.signIn('carol', 'password123', ctx());
		assert.strictEqual(user.username, 'carol');
	});

	test('throttling is disabled by default (no lockout option = unlimited attempts)', async () => {
		const auth = makeAuth(); // no lockout option
		await auth.signUp('dave', 'password123');

		// Ten wrong attempts never lock — each is plain InvalidCredentials.
		for (let i = 0; i < 10; i++) {
			await assert.rejects(
				auth.signIn('dave', 'wrong', ctx()),
				(e: Error & { name?: string }) => e.name === AuthBasicErrors.InvalidCredentials,
			);
		}
		// No counter row was ever written.
		assert.strictEqual(await codesStore(auth).get('lockout:dave'), null);
		// And the correct password still works.
		const user = await auth.signIn('dave', 'password123', ctx());
		assert.strictEqual(user.username, 'dave');
	});

	test('the lock self-expires after lockoutSeconds (stale counter does not lock)', async () => {
		const auth = makeAuth({ lockout: { maxAttempts: 2, lockoutSeconds: 1, windowSeconds: 60 } });
		await auth.signUp('erin', 'password123');

		// Simulate a tripped lock whose lockedAt is older than lockoutSeconds:
		// count at threshold but the lock window has already elapsed.
		const staleLockedAt = Date.now() - 5000; // 5s ago, lockoutSeconds=1
		await codesStore(auth).put(
			'lockout:erin',
			JSON.stringify({ count: 2, firstFailAt: staleLockedAt, lockedAt: staleLockedAt }),
		);

		// The stale lock no longer blocks — the correct password signs in.
		const user = await auth.signIn('erin', 'password123', ctx());
		assert.strictEqual(user.username, 'erin');
	});

	test('the lockout window is anchored at the trip, not the first failure', async () => {
		// windowSeconds large (failures still counted) but lockoutSeconds SHORTER
		// than the age of the first failure. A lock anchored on firstFailAt would
		// already be expired at the instant it trips; a lock anchored on lockedAt
		// (the trip moment) holds for the full lockoutSeconds. This is the exact
		// quirk the old firstFailAt-anchored code baked in.
		const auth = makeAuth({ lockout: { maxAttempts: 2, windowSeconds: 600, lockoutSeconds: 60 } });
		await auth.signUp('grace', 'password123');

		// Seed one old failure 300s ago: inside windowSeconds=600 (so the next
		// failure increments to the threshold) but far older than lockoutSeconds=60.
		const oldFailAt = Date.now() - 300_000;
		await codesStore(auth).put('lockout:grace', JSON.stringify({ count: 1, firstFailAt: oldFailAt }));

		// The second failure trips the lock NOW and stamps lockedAt=now.
		await assert.rejects(
			auth.signIn('grace', 'wrong', ctx()),
			(e: Error & { name?: string }) => e.name === AuthBasicErrors.InvalidCredentials,
		);

		// Enforcement: the lock holds. A firstFailAt-anchored expiry (oldFailAt +
		// 60s) is 240s in the PAST — would wrongly let this through. A lockedAt
		// anchor (now + 60s) correctly rejects.
		await assert.rejects(
			auth.signIn('grace', 'password123', ctx()),
			(e: Error & { name?: string }) => e.name === AuthBasicErrors.AccountLocked,
		);
		const raw = await codesStore(auth).get('lockout:grace');
		const parsed = JSON.parse(raw!) as { count: number; firstFailAt: number; lockedAt?: number };
		assert.strictEqual(parsed.count, 2, 'the old failure incremented to the threshold');
		assert.ok(parsed.lockedAt !== undefined, 'the trip stamped lockedAt');
		assert.ok(parsed.lockedAt! - oldFailAt > 200_000, 'lockedAt is the trip time, not the first failure');
	});

	test('a failure older than windowSeconds resets the running count', async () => {
		const auth = makeAuth({ lockout: { maxAttempts: 3, windowSeconds: 1, lockoutSeconds: 1 } });
		await auth.signUp('frank', 'password123');

		// Seed a near-threshold counter whose firstFailAt is older than the
		// window — the next failure must start a FRESH window at count=1, not
		// increment to the lock threshold.
		const staleFirstFailAt = Date.now() - 5000; // older than windowSeconds=1
		await codesStore(auth).put('lockout:frank', JSON.stringify({ count: 2, firstFailAt: staleFirstFailAt }));

		await assert.rejects(
			auth.signIn('frank', 'wrong', ctx()),
			(e: Error & { name?: string }) => e.name === AuthBasicErrors.InvalidCredentials,
		);
		const raw = await codesStore(auth).get('lockout:frank');
		assert.ok(raw, 'a counter row exists');
		const parsed = JSON.parse(raw!) as { count: number };
		assert.strictEqual(parsed.count, 1, 'the stale window was discarded and the count restarted at 1');
	});

	test('a misconfigured lockout policy throws at construction', () => {
		// maxAttempts must be a positive integer; windows must be positive.
		assert.throws(() => makeAuth({ lockout: { maxAttempts: 0 } }), /maxAttempts must be a positive integer/);
		assert.throws(() => makeAuth({ lockout: { maxAttempts: -1 } }), /maxAttempts must be a positive integer/);
		assert.throws(() => makeAuth({ lockout: { maxAttempts: 2.5 } }), /maxAttempts must be a positive integer/);
		assert.throws(() => makeAuth({ lockout: { windowSeconds: 0 } }), /windowSeconds must be a positive number/);
		assert.throws(
			() => makeAuth({ lockout: { lockoutSeconds: -5 } }),
			/lockoutSeconds must be a positive number/,
		);
		// A valid policy (and an empty object = defaults) constructs fine.
		assert.doesNotThrow(() => makeAuth({ lockout: { maxAttempts: 3, windowSeconds: 60, lockoutSeconds: 120 } }));
		assert.doesNotThrow(() => makeAuth({ lockout: {} }));
	});

	test('signUp clears a pre-registration lockout counter for the new username', async () => {
		// Absent usernames are counted (to avoid an existence oracle), so an
		// attacker can trip a lock on a name before it is registered. The real
		// owner must not inherit that lock: signUp clears the counter.
		const auth = makeAuth({ lockout: { maxAttempts: 2 } });

		// Trip the lock for 'heidi' before she exists (two failed sign-ins).
		await assert.rejects(auth.signIn('heidi', 'wrong', ctx()));
		await assert.rejects(auth.signIn('heidi', 'wrong', ctx()));
		assert.ok(await codesStore(auth).get('lockout:heidi'), 'a pre-registration counter exists');

		// Heidi registers the name — the counter must be cleared…
		await auth.signUp('heidi', 'password123');
		assert.strictEqual(await codesStore(auth).get('lockout:heidi'), null, 'signUp cleared the counter');

		// …so her very first real sign-in succeeds instead of hitting the lock.
		const user = await auth.signIn('heidi', 'password123', ctx());
		assert.strictEqual(user.username, 'heidi');
	});
});

/**
 * Verification-code attempt-limiting tests (issue #911). A 6-digit OTP is
 * brute-forceable within its validity window, so `verifyCode` caps the number
 * of wrong guesses per code and invalidates the code on exhaustion. Always on
 * (not gated behind the opt-in sign-in `lockout` policy).
 */
describe('AuthBasic verification-code attempt limiting', () => {
	/** Capture the code `codeDelivery` hands out so a test can present it. */
	function captureAuth(): { auth: AuthBasic; lastCode: () => string } {
		let code = '';
		const auth = makeAuth({
			codeDelivery: async (_username, c) => {
				code = c;
			},
		});
		return { auth, lastCode: () => code };
	}

	test('invalidates a reset code after MAX_CODE_ATTEMPTS wrong guesses', async () => {
		const { auth, lastCode } = captureAuth();
		await auth.signUp('alice', 'password123');
		await auth.resetPassword('alice');
		const realCode = lastCode();

		// Five wrong guesses (the cap): each rejects, and the fifth burns the code.
		for (let i = 0; i < 5; i++) {
			await assert.rejects(
				auth.confirmResetPassword('alice', '000000', 'newpassword123'),
				(e: Error & { name?: string }) => e.name === AuthBasicErrors.InvalidCode,
				`wrong guess #${i + 1} is rejected`,
			);
		}

		// The row remains at the spent cap (it self-reaps at the code TTL rather
		// than being deleted per guess — deleting per guess would open a
		// delete-then-stale-resurrect race under concurrency).
		const spent = await codesStore(auth).get('reset:alice');
		assert.ok(spent, 'the code row persists at the spent cap');
		assert.strictEqual(JSON.parse(spent!).attempts, 5, 'attempts is pinned at the cap');

		// Even the CORRECT code is now rejected: the cap is spent.
		await assert.rejects(
			auth.confirmResetPassword('alice', realCode, 'newpassword123'),
			(e: Error & { name?: string }) => e.name === AuthBasicErrors.InvalidCode,
			'the correct code is rejected after the cap is exhausted',
		);
	});

	test('counts attempts per code and resets the count after a fresh code is issued', async () => {
		const { auth, lastCode } = captureAuth();
		await auth.signUp('bob', 'password123');
		await auth.confirmSignUp('bob', lastCode()); // confirm so the final sign-in can succeed
		await auth.resetPassword('bob');

		// Two wrong guesses — below the cap, so the code survives.
		await assert.rejects(auth.confirmResetPassword('bob', '000000', 'newpassword123'));
		await assert.rejects(auth.confirmResetPassword('bob', '111111', 'newpassword123'));
		const afterTwo = await codesStore(auth).get('reset:bob');
		assert.ok(afterTwo, 'the code survives below the cap');
		assert.strictEqual(JSON.parse(afterTwo!).attempts, 2, 'two failed attempts are recorded on the code');

		// Issuing a fresh code resets the attempt count to 0.
		await auth.resetPassword('bob');
		const fresh = await codesStore(auth).get('reset:bob');
		assert.strictEqual(JSON.parse(fresh!).attempts, 0, 'a freshly issued code starts with zero attempts');

		// The fresh correct code still works (count was not inherited from the old one).
		await auth.confirmResetPassword('bob', lastCode(), 'newpassword123');
		const user = await auth.signIn('bob', 'newpassword123', ctx());
		assert.strictEqual(user.username, 'bob');
	});

	test('a correct guess before the cap succeeds and consumes the code', async () => {
		const { auth, lastCode } = captureAuth();
		await auth.signUp('carol', 'password123');
		await auth.confirmSignUp('carol', lastCode()); // confirm so the final sign-in can succeed
		await auth.resetPassword('carol');

		// One wrong guess, then the right one before hitting the cap.
		await assert.rejects(auth.confirmResetPassword('carol', '000000', 'newpassword123'));
		await auth.confirmResetPassword('carol', lastCode(), 'newpassword123');

		assert.strictEqual(await codesStore(auth).get('reset:carol'), null, 'the code is consumed on success');
		const user = await auth.signIn('carol', 'newpassword123', ctx());
		assert.strictEqual(user.username, 'carol');
	});

	test('attempt limiting also applies to sign-up confirmation codes', async () => {
		const { auth } = captureAuth();
		await auth.signUp('dave', 'password123'); // unconfirmed; a signup code was sent

		for (let i = 0; i < 5; i++) {
			await assert.rejects(
				auth.confirmSignUp('dave', '000000'),
				(e: Error & { name?: string }) => e.name === AuthBasicErrors.InvalidCode,
			);
		}
		const spent = await codesStore(auth).get('signup:dave');
		assert.ok(spent, 'the signup code row persists at the spent cap');
		assert.strictEqual(JSON.parse(spent!).attempts, 5, 'signup attempts pinned at the cap');
	});

	test('concurrent wrong guesses cannot bypass the cap (worst-case interleaving)', async () => {
		const { auth, lastCode } = captureAuth();
		await auth.signUp('erin', 'password123');
		await auth.confirmSignUp('erin', lastCode());
		await auth.resetPassword('erin');
		const realCode = lastCode();

		// Spend 4 of the 5 attempts sequentially, leaving exactly one in the budget.
		for (let i = 0; i < 4; i++) {
			await assert.rejects(auth.confirmResetPassword('erin', '000000', 'newpassword123'));
		}

		// Install a read barrier on the codes store: every `get` in the burst
		// below blocks until ALL of them have read, so each request sees the SAME
		// row (attempts: 4) before any CAS write lands — the exact interleaving a
		// plain Promise.all would NOT force (submitted ≠ consumed budget). A
		// non-atomic read-modify-write would let the whole burst past; the CAS
		// reserve means only ONE request wins the single remaining attempt.
		const store = codesStore(auth);
		const originalGet = store.get.bind(store);
		const BURST = 20; // 19 wrong + the correct code, all submitted together
		let arrived = 0;
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		store.get = async (k: string) => {
			const v = await originalGet(k);
			if (k === 'reset:erin') {
				arrived += 1;
				if (arrived >= BURST) release();
				await gate; // hold until the whole burst has read
			}
			return v;
		};

		// 19 wrong guesses + the correct code, submitted concurrently. With only
		// one attempt left, at most one guess may be evaluated; the rest lose the
		// CAS and are rejected without being evaluated.
		const guesses = [...Array(BURST - 1)].map(() =>
			auth.confirmResetPassword('erin', '000000', 'hijackedpw123').then(
				() => 'ok',
				() => 'rejected',
			),
		);
		guesses.push(
			auth.confirmResetPassword('erin', realCode, 'hijackedpw123').then(
				() => 'ok',
				() => 'rejected',
			),
		);
		const results = await Promise.all(guesses);
		store.get = originalGet; // restore

		// The password must NOT have been reset by the burst: the cap held.
		const succeeded = results.filter((r) => r === 'ok').length;
		assert.strictEqual(succeeded, 0, 'no guess in the over-budget burst succeeded');

		// Sign-in with the attacker password must fail; the original still works.
		await assert.rejects(
			auth.signIn('erin', 'hijackedpw123', ctx()),
			(e: Error & { name?: string }) => e.name === AuthBasicErrors.InvalidCredentials,
			'the attacker password was never set',
		);
		const user = await auth.signIn('erin', 'password123', ctx());
		assert.strictEqual(user.username, 'erin', 'the original password still authenticates');

		// The row ends pinned at the cap, not resurrected or over-counted.
		const after = await codesStore(auth).get('reset:erin');
		assert.ok(after, 'the row persists');
		assert.strictEqual(JSON.parse(after!).attempts, 5, 'attempts ends exactly at the cap');
	});

	test('a correct code is single-use even when a concurrent wrong guess interleaves the delete', async () => {
		const { auth, lastCode } = captureAuth();
		await auth.signUp('frank', 'password123');
		await auth.confirmSignUp('frank', lastCode());
		await auth.resetPassword('frank');
		const realCode = lastCode();

		// Hold the FIRST (correct-code) request's delete until a second request has
		// run, forcing the consume-side interleaving: the correct verifier reserves
		// attempt 1, then a wrong guess reserves attempt 2 before the first delete
		// lands — so the first request's `ifValueEquals: reserved` no longer matches.
		const store = codesStore(auth);
		const originalDelete = store.delete.bind(store);
		let release!: () => void;
		const held = new Promise<void>((r) => {
			release = r;
		});
		let firstDelete = true;
		store.delete = async (k: string, o?: { ifValueEquals?: string }) => {
			if (k === 'reset:frank' && firstDelete) {
				firstDelete = false;
				await held; // stall the correct verifier's delete
			}
			return originalDelete(k, o);
		};

		const correct = auth
			.confirmResetPassword('frank', realCode, 'newpassword123')
			.then(() => 'ok', () => 'rejected');
		// Let the correct verifier reserve + reach its (stalled) delete, then run a
		// wrong guess that advances the row, then release the first delete.
		await new Promise((r) => setTimeout(r, 20));
		const wrong = await auth
			.confirmResetPassword('frank', '000000', 'hijackedpw123')
			.then(() => 'ok', () => 'rejected');
		release();
		const correctResult = await correct;
		store.delete = originalDelete; // restore

		assert.strictEqual(wrong, 'rejected', 'the interleaved wrong guess is rejected');
		assert.strictEqual(correctResult, 'ok', 'the correct code still succeeds (its retry consumed the row)');

		// The code must be single-use: the row is gone and a replay is rejected.
		assert.strictEqual(await codesStore(auth).get('reset:frank'), null, 'the row is consumed, not left behind');
		await assert.rejects(
			auth.confirmResetPassword('frank', realCode, 'replayedpw123'),
			(e: Error & { name?: string }) => e.name === AuthBasicErrors.InvalidCode,
			'replaying the code after a successful reset is rejected',
		);
		// The reset happened exactly once: the first new password works.
		const user = await auth.signIn('frank', 'newpassword123', ctx());
		assert.strictEqual(user.username, 'frank');
	});

	test('two concurrent verifiers of the same correct code yield exactly one success', async () => {
		const { auth, lastCode } = captureAuth();
		await auth.signUp('grace', 'password123');
		await auth.confirmSignUp('grace', lastCode());
		await auth.resetPassword('grace');
		const realCode = lastCode();

		// Hold the first verifier's delete until the second has run to completion,
		// so both evaluate the same correct code against the same row.
		const store = codesStore(auth);
		const originalDelete = store.delete.bind(store);
		let release!: () => void;
		const held = new Promise<void>((r) => {
			release = r;
		});
		let firstDelete = true;
		store.delete = async (k: string, o?: { ifValueEquals?: string }) => {
			if (k === 'reset:grace' && firstDelete) {
				firstDelete = false;
				await held;
			}
			return originalDelete(k, o);
		};

		const first = auth.confirmResetPassword('grace', realCode, 'firstpw12345').then(() => 'ok', () => 'rejected');
		await new Promise((r) => setTimeout(r, 20));
		const second = await auth.confirmResetPassword('grace', realCode, 'secondpw12345').then(() => 'ok', () => 'rejected');
		release();
		const firstResult = await first;
		store.delete = originalDelete;

		const successes = [firstResult, second].filter((r) => r === 'ok').length;
		assert.strictEqual(successes, 1, 'exactly one of the two concurrent correct verifications succeeds');
		assert.strictEqual(await codesStore(auth).get('reset:grace'), null, 'the code is consumed exactly once');
	});
});

/**
 * Telemetry-registration tests for AuthBasic.
 *
 * `Scope.getRegisteredBlocks()` only names a block whose `bbName` is in
 * OFFICIAL_BB_NAMES, and that set is generated from the umbrella's
 * `aws-blocks.vendorize` map. These tests pin the three coupled artifacts to
 * each other: the block's generated BB_NAME, its vendorize entry, and the
 * generated name set. A block that omits `bbMeta` still constructs fine and
 * every other test still passes, so that gap is only visible here.
 */
describe('AuthBasic telemetry registration', () => {
	beforeEach(() => {
		Scope._resetRegistry();
	});

	test('BB_NAME is the name the vendorize map and OFFICIAL_BB_NAMES carry', () => {
		assert.strictEqual(BB_NAME, 'AuthBasic');
	});

	test('BB_VERSION tracks the package version', () => {
		const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
		assert.strictEqual(BB_VERSION, pkg.version);
	});

	test('an instance carries bbName and bbVersion', () => {
		const auth = makeAuth();
		assert.strictEqual(auth.bbName, BB_NAME);
		assert.strictEqual(auth.bbVersion, BB_VERSION);
	});

	test('registers as an official block, so telemetry is allowed to name it', () => {
		makeAuth();
		const { blocks, customBlocksCount } = Scope.getRegisteredBlocks();
		assert.deepStrictEqual(
			blocks.filter(b => b.name === BB_NAME),
			[{ name: BB_NAME, version: BB_VERSION }],
		);
		assert.strictEqual(customBlocksCount, 0, 'must not be filtered out as an unnamed custom block');
	});
});
