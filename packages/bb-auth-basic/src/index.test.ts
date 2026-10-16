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

	test('a generic ApiError (no structured name) yields no errorName', async () => {
		// resetPassword throws a plain ApiError('Password reset not configured')
		// with no `name` when codeDelivery is unset — `.name` defaults to
		// DEFAULT_API_ERROR_NAME, which must not leak as a meaningful errorName.
		const auth = makeAuth();
		const api = apiFor(auth, ctx());

		const next = await api.setAuthState({ action: 'resetPassword', username: 'alice' });

		assert.strictEqual(next.state, 'signedOut');
		assert.ok(next.error);
		assert.strictEqual(next.errorName, undefined);
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

	test('a failed revocation write surfaces from signOut (not swallowed)', async () => {
		const auth = makeAuth();
		await auth.signUp('alice', 'password123');
		const signInCtx = ctx();
		await auth.signIn('alice', 'password123', signInCtx);
		const token = tokenFromResponse(signInCtx)!;

		// Make the revocation-list write fail like a transient DynamoDB error.
		// The security-relevant write must not be silently swallowed: signOut has
		// to reject so the caller knows the token was NOT revoked.
		const store = (auth as unknown as { codes: { put: (...a: unknown[]) => Promise<void> } }).codes;
		const realPut = store.put.bind(store);
		store.put = async () => {
			throw new Error('ProvisionedThroughputExceededException');
		};
		try {
			await assert.rejects(() => auth.signOut(ctxWithToken(auth, token)), /ProvisionedThroughput/);
		} finally {
			store.put = realPut;
		}
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
