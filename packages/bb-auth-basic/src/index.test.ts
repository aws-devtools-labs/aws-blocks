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
import { inspect } from 'node:util';
import jwt from 'jsonwebtoken';
import type { BlocksContext } from '@aws-blocks/core';
import { ApiError, Scope, blocksError, hasAuthError } from '@aws-blocks/core';
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
			assert.strictEqual(next.error, 'Internal error');
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

describe('AuthBasic setAuthState never returns raw backend error text', () => {
	// What an SES / DynamoDB / SSM failure looks like: the message embeds the
	// account id and resource ARN. It must stay in the server log.
	const RAW_DETAIL = 'User: arn:aws:sts::123456789012:assumed-role/BlocksRole/x is not authorized to perform: ses:SendEmail on arn:aws:ses:us-east-1:123456789012:identity/internal@example.com';

	function recordingLogger(): { logger: NonNullable<AuthBasicOptions['logger']>; errors: unknown[] } {
		const errors: unknown[] = [];
		const logger: NonNullable<AuthBasicOptions['logger']> = {
			debug() {},
			info() {},
			warn() {},
			error(message, context) {
				// inspect() renders an Error's message, as the real logger does; JSON.stringify drops it.
				errors.push(inspect({ message, context }));
			},
			child: () => logger,
		};
		return { logger, errors };
	}

	test('an unbranded error is returned as a generic message and logged server-side', async () => {
		const { logger, errors } = recordingLogger();
		const auth = makeAuth({
			logger,
			codeDelivery: async () => {
				throw new Error(RAW_DETAIL);
			},
		});
		const api = apiFor(auth, ctx());

		const next = await api.setAuthState({ action: 'signUp', username: 'carol@example.com', password: 'password123' });

		assert.strictEqual(next.state, 'signedOut');
		assert.strictEqual(next.error, 'Internal error');
		assert.strictEqual(next.errorName, undefined, 'a raw error carries no structured name');
		assert.ok(!JSON.stringify(next).includes('123456789012'), 'no account id in the returned AuthState');
		assert.ok(JSON.stringify(errors).includes(RAW_DETAIL), 'the original error is logged server-side');
	});

	test('an ApiError thrown by the app keeps its message and name', async () => {
		const auth = makeAuth({
			codeDelivery: async () => {
				throw new ApiError('That address cannot receive email', 400, { name: 'UndeliverableAddressException' });
			},
		});
		const api = apiFor(auth, ctx());

		const next = await api.setAuthState({ action: 'signUp', username: 'dave@example.com', password: 'password123' });

		assert.strictEqual(next.error, 'That address cannot receive email');
		assert.strictEqual(next.errorName, 'UndeliverableAddressException');
	});

	test('a branded Building Block error keeps its message', async () => {
		const branded = blocksError('DeliveryQuotaExceededException', 'Too many codes requested, try again later');
		const auth = makeAuth({
			codeDelivery: async () => {
				throw branded;
			},
		});
		const api = apiFor(auth, ctx());

		const next = await api.setAuthState({ action: 'signUp', username: 'erin@example.com', password: 'password123' });

		assert.strictEqual(next.error, branded.message);
	});

	test('the built-in ApiError messages still reach the client unchanged', async () => {
		const auth = makeAuth();
		const api = apiFor(auth, ctx());

		const next = await api.setAuthState({ action: 'signIn', username: 'nobody', password: 'whatever1' });

		assert.strictEqual(next.error, 'Invalid username or password');
		assert.strictEqual(next.errorName, AuthBasicErrors.InvalidCredentials);
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
 * Sign-in throttling / account lockout (issue #766). AuthBasic can lock an
 * account after too many consecutive failed sign-ins, matching the Cognito-
 * managed lockout the equivalent CDK stack provides. Throttling is opt-in: with
 * no `lockout` option, sign-in behaves exactly as before (no lock, ever).
 */

/** Reach the private `codes` KVStore a lockout counter is stored in (test plumbing). */
function codesStore(auth: AuthBasic): {
	get: (k: string) => Promise<string | null>;
	put: (k: string, v: string, o?: { ttlSeconds?: number }) => Promise<void>;
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
