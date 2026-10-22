// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `allowBearerAuth` on the mock entry (D6c): the guards accept
 * `Authorization: Bearer` the way `AuthOIDC` does, so the native SDKs work
 * unchanged.
 *
 * - The stub IdP's real ES256 access token, obtained the way the Swift / Dart
 *   SDKs obtain it (relay → `/exchange`), then renewed at `/exchange/refresh`
 *   and used again — over real HTTP, through a route that calls the guards.
 * - Direct-OIDC negative cases against a fake IdP (wrong audience / issuer /
 *   key, expired, `alg: none`, HS256) → 401 `NotAuthenticatedException`.
 * - The local user pool's own access tokens, accepted only while the pool
 *   still recognises them; forged mock-shaped tokens are refused.
 * - Off by default; cookie-before-bearer precedence; bearer outlives `signOut()`.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { ApiError, type BlocksContext, clearRouteRegistry, RawRoute, type ScopeParent } from '@aws-blocks/core';
import { SignJWT } from 'jose';
import { pkceChallenge } from './engines/federation-direct.js';
import { AuthErrors } from './errors.js';
import { Auth, stubIdp } from './index.mock.js';
import { Browser, makeContext } from './test-helpers.js';
import { FakeIdp } from './test-support/fake-idp.js';
import { location, type RouteServer, startRouteServer, TestBrowser } from './test-support/route-server.js';
import type { CodeDeliveryPurpose, StubUser } from './types.js';

const ALICE: StubUser = { sub: 'u-1', email: 'alice@example.com', name: 'Alice', extra: { groups: ['admin'] } };
const PASSWORD = 'Passw0rd!';

let server: RouteServer;
let counter = 0;
const unique = () => ({ id: `bearer${process.pid}x${++counter}` });

before(async () => {
	server = await startRouteServer();
});
after(async () => {
	await server.close();
});
beforeEach(() => {
	clearRouteRegistry();
	rmSync('.bb-data', { recursive: true, force: true });
});
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

/** A request context for `origin` carrying `Authorization: Bearer <token>` (and optionally a cookie). */
function bearerCtx(origin: string, token: string, cookie?: string): BlocksContext {
	const ctx = makeContext(cookie, new URL(origin).host);
	ctx.request.headers.set('authorization', `Bearer ${token}`);
	ctx.request.url = new URL(`${origin}/aws-blocks/api`);
	return ctx;
}

/** What a client observes of a rejection. */
async function observe(p: Promise<unknown>): Promise<{ name: string; status: number; message: string }> {
	try {
		await p;
	} catch (e) {
		assert.ok(e instanceof ApiError, `an ApiError, got ${String(e)}`);
		return { name: e.name, status: e.status, message: e.message };
	}
	assert.fail('expected a rejection');
}

const NOT_AUTHENTICATED = { name: AuthErrors.NotAuthenticated, status: 401, message: 'Authentication required' };

function b64(v: unknown): string {
	return Buffer.from(JSON.stringify(v)).toString('base64url');
}

/** An unsigned (`alg: none`) JWT. */
function unsignedJwt(payload: Record<string, unknown>, signature = ''): string {
	return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.${signature}`;
}

/** An HS256 JWT — a symmetric algorithm no bearer verifier may accept. */
function hs256Jwt(payload: Record<string, unknown>): Promise<string> {
	return new SignJWT(payload)
		.setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
		.sign(new TextEncoder().encode('a-shared-secret-anyone-could-guess-0123'));
}

/**
 * A route that calls the guards, so a bearer request travels over real HTTP
 * exactly as a native SDK's would. Replies `{ user }` or `{ error: { status, name, message } }`.
 */
function mountWhoAmI(auth: ReturnType<typeof makeStubAuth>): void {
	new RawRoute(auth, 'whoami', {
		method: 'GET',
		path: '/aws-blocks/test/whoami',
		handler: async (ctx) => {
			try {
				const role = ctx.request.url.searchParams.get('role');
				const user = role === 'admin' ? await auth.requireRole(ctx, 'admin') : await auth.requireAuth(ctx);
				ctx.response.send({ user });
			} catch (e) {
				const err = e instanceof ApiError ? e : new ApiError('unexpected', 500);
				ctx.response.status = err.status;
				ctx.response.send({ error: { status: err.status, name: err.name, message: err.message } });
			}
		},
	});
}

async function whoAmI(
	token: string | undefined,
	query = '',
): Promise<{ status: number; body: Record<string, unknown> }> {
	const res = await fetch(`${server.origin}/aws-blocks/test/whoami${query}`, {
		headers: token ? { authorization: `Bearer ${token}` } : {},
	});
	return { status: res.status, body: await res.json() };
}

/**
 * Sign in the way the Swift / Dart / Kotlin SDKs do: relay `authorize-params`
 * → the IdP → the callback relays the code → `POST /exchange`. Returns the
 * exchange body (`{ user, accessToken, refreshToken, expiresIn }`).
 */
async function nativeSignIn(): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
	const csrf = 'c'.repeat(40);
	const relayTo = 'http://127.0.0.1:53682/callback';
	const params = await (
		await fetch(`${server.origin}/aws-blocks/auth/authorize-params/corp`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ csrf, relayTo }),
		})
	).json();
	const verifier = 'native-verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
	const callbackUrl = `${server.origin}/aws-blocks/auth/callback`;
	const authorize = new URL(params.authorizeUrl);
	for (const [k, v] of Object.entries({
		response_type: 'code',
		client_id: params.clientId,
		redirect_uri: callbackUrl,
		scope: params.scopes.join(' '),
		state: params.state,
		code_challenge: pkceChallenge(verifier),
		code_challenge_method: 'S256',
		nonce: params.nonce,
	})) {
		authorize.searchParams.set(k, v);
	}
	const toCallback = await fetch(authorize, { redirect: 'manual' });
	const relayed = await fetch(location(toCallback, server.origin), { redirect: 'manual' });
	const code = new URL(location(relayed, server.origin)).searchParams.get('code') ?? '';
	// A fresh client with no cookie jar: the SDK keeps only the bearer tokens.
	const exchanged = await fetch(`${server.origin}/aws-blocks/auth/exchange`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			code,
			verifier,
			state: params.state,
			nonce: params.nonce,
			provider: 'corp',
			callbackUrl,
		}),
	});
	assert.strictEqual(exchanged.status, 200);
	const body = await exchanged.json();
	assert.ok(body.accessToken && body.refreshToken, 'the exchange returns bearer tokens');
	return body;
}

function makeStubAuth(allowBearerAuth: boolean, root: ScopeParent = unique()) {
	return new Auth(root, 'auth', {
		emailPassword: false,
		allowBearerAuth,
		oidcProviders: { corp: stubIdp({ users: [ALICE], onAuthorize: (r) => r.users[0] }) },
		users: { groups: ['admin'] },
	});
}

describe('allowBearerAuth — direct OIDC (stub IdP, real ES256) on the mock', () => {
	test('the SDK flow: exchange → bearer → /exchange/refresh → the new token as a bearer', async () => {
		const auth = makeStubAuth(true);
		mountWhoAmI(auth);
		const issuer = `${server.origin}/aws-blocks/auth/idp/corp`;

		const tokens = await nativeSignIn();
		const first = await whoAmI(tokens.accessToken);
		assert.strictEqual(first.status, 200, JSON.stringify(first.body));
		const user = first.body.user as Record<string, unknown>;
		assert.strictEqual(user.userId, `${issuer}:u-1`, 'Q1: <iss>:<sub>, as AuthOIDC');
		assert.strictEqual(user.userSub, user.userId);
		assert.strictEqual(user.username, 'Alice', 'name ?? email ?? sub, as AuthOIDC');
		assert.strictEqual(user.signInProvider, 'corp');
		assert.deepStrictEqual(user.groups, ['admin'], 'groups from groupsClaim in the access token');
		const claims = user.claims;
		assert.ok(claims && typeof claims === 'object', 'a direct bearer user carries claims');
		assert.strictEqual(Reflect.get(claims, 'sub'), 'u-1', 'claims.sub: the verified token’s raw subject');
		assert.strictEqual(Reflect.get(claims, 'iss'), issuer);

		// requireRole with a bearer: the direct user's groups are the token's groupsClaim.
		assert.strictEqual((await whoAmI(tokens.accessToken, '?role=admin')).status, 200);

		// Swift / Dart: refresh with `{ refreshToken }` only, then use the new access token.
		const refreshed = await fetch(`${server.origin}/aws-blocks/auth/exchange/refresh`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ refreshToken: tokens.refreshToken }),
		});
		assert.strictEqual(refreshed.status, 200);
		const renewed = await refreshed.json();
		assert.ok(
			renewed.accessToken && renewed.refreshToken !== tokens.refreshToken,
			'renewed, refresh token rotated',
		);
		const second = await whoAmI(renewed.accessToken);
		assert.strictEqual(second.status, 200, JSON.stringify(second.body));
		assert.strictEqual((second.body.user as Record<string, unknown>).userId, `${issuer}:u-1`);

		// The guards' other faces, with only the bearer header.
		const ctx = bearerCtx(server.origin, renewed.accessToken);
		assert.strictEqual(await auth.checkAuth(ctx), true);
		assert.strictEqual((await auth.getCurrentUser(ctx))?.userId, `${issuer}:u-1`);
		assert.deepStrictEqual(await auth.getAuthSession(ctx), { tokens: undefined, userSub: `${issuer}:u-1` });
		assert.deepStrictEqual(ctx.response.headers.getSetCookie(), [], 'a bearer request sets no cookie');
		// `{ fresh: true }` measures the token's auth_time; the stub's access token carries none.
		assert.deepStrictEqual(
			(await observe(auth.requireAuth(bearerCtx(server.origin, renewed.accessToken), { fresh: true }))).name,
			AuthErrors.ReauthenticationRequired,
		);

		// No token / a garbage token → the AuthOIDC 401.
		const none = await whoAmI(undefined);
		assert.deepStrictEqual([none.status, none.body.error], [401, NOT_AUTHENTICATED]);
		const garbage = await whoAmI('not-a-jwt');
		assert.deepStrictEqual([garbage.status, garbage.body.error], [401, NOT_AUTHENTICATED]);
	});

	test('off by default: the same valid token is ignored, and nothing changes', async () => {
		makeStubAuth(true);
		const tokens = await nativeSignIn();

		clearRouteRegistry();
		const off = makeStubAuth(false);
		mountWhoAmI(off);
		const res = await whoAmI(tokens.accessToken);
		assert.deepStrictEqual([res.status, res.body.error], [401, NOT_AUTHENTICATED]);
		const ctx = bearerCtx(server.origin, tokens.accessToken);
		assert.strictEqual(await off.checkAuth(ctx), false);
		assert.strictEqual(await off.getCurrentUser(ctx), null);
		assert.deepStrictEqual(await off.getAuthSession(ctx), { tokens: undefined });
	});

	test('precedence (AuthOIDC): a valid cookie session wins over a bearer token; a bad cookie falls through', async () => {
		const root = unique();
		const auth = makeStubAuth(true, root);
		const tokens = await nativeSignIn();
		const issuer = `${server.origin}/aws-blocks/auth/idp/corp`;

		// A cookie session for a different user (Bob) through the browser flow.
		// The same block (same fullId, so the same session secret — the stub IdP
		// derives its signing keys from it), rebuilt with Bob as the stub's user.
		clearRouteRegistry();
		const BOB: StubUser = { sub: 'u-2', email: 'bob@example.com', name: 'Bob' };
		const both = new Auth(root, 'auth', {
			emailPassword: false,
			allowBearerAuth: true,
			oidcProviders: { corp: stubIdp({ users: [BOB], onAuthorize: (r) => r.users[0] }) },
			users: { groups: ['admin'] },
		});
		const b = new TestBrowser();
		const start = await b.fetch(`${server.origin}/aws-blocks/auth/signin/corp`);
		const toCallback = await b.fetch(location(start, server.origin));
		await b.fetch(location(toCallback, server.origin));
		const cookie = b.cookieHeader();
		assert.ok(cookie.includes(`auth_${both.fullId}=`), 'Bob has a cookie session');

		const user = await both.requireAuth(bearerCtx(server.origin, tokens.accessToken, cookie));
		assert.strictEqual(user.userId, `${issuer}:u-2`, 'the cookie session wins');

		const tampered = `auth_${both.fullId}=not-a-valid-session.sig`;
		const ctx = bearerCtx(server.origin, tokens.accessToken, tampered);
		assert.strictEqual((await both.requireAuth(ctx)).userId, `${issuer}:u-1`, 'an unreadable cookie → the bearer');
		assert.ok(
			ctx.response.headers
				.getSetCookie()
				.some((l) => l.startsWith(`auth_${both.fullId}=`) && /Max-Age=0/.test(l)),
			'the unreadable cookie is still cleared',
		);
		void auth;
	});
});

describe('allowBearerAuth — direct OIDC rejections (fake IdP) on the mock', () => {
	const idp = new FakeIdp();
	before(async () => {
		await idp.start();
	});
	after(async () => {
		await idp.close();
	});

	function makeOktaAuth() {
		return new Auth(unique(), 'auth', {
			emailPassword: false,
			allowBearerAuth: true,
			oidcProviders: { okta: { issuer: idp.issuer, clientId: 'client-1', groupsClaim: 'groups' } },
			users: { groups: ['admin'] },
		});
	}

	const APP = 'http://127.0.0.1:3999';

	test('a valid access token is accepted; groupsClaim drives requireRole', async () => {
		const auth = makeOktaAuth();
		const token = await idp.accessJwt('user-1', { claims: { groups: ['admin'], email: 'ada@example.com' } });
		const user = await auth.requireRole(bearerCtx(APP, token), 'admin');
		assert.strictEqual(user.userId, `${idp.issuer}:user-1`);
		assert.strictEqual(user.username, 'ada@example.com');
		assert.strictEqual(user.attributes.email, 'ada@example.com');
		assert.strictEqual(user.signInProvider, 'okta');
		const noGroup = await idp.accessJwt('user-2');
		assert.deepStrictEqual(await observe(auth.requireRole(bearerCtx(APP, noGroup), 'admin')), {
			name: AuthErrors.NotAuthorized,
			status: 403,
			message: "Not in group 'admin'",
		});
	});

	test('wrong audience / issuer / key, expired, alg: none and HS256 → 401 NotAuthenticated', async () => {
		const auth = makeOktaAuth();
		const now = Math.floor(Date.now() / 1000);
		const claims = { iss: idp.issuer, sub: 'user-1', aud: 'client-1', iat: now, exp: now + 3600 };
		const cases: Record<string, string> = {
			'wrong audience': await idp.accessJwt('user-1', { audience: 'someone-else' }),
			'wrong issuer': await idp.accessJwt('user-1', { issuer: `${idp.origin}/other` }),
			'unpublished key': await idp.accessJwt('user-1', { foreignKey: true }),
			expired: await idp.accessJwt('user-1', { expiresIn: -120 }),
			'alg: none': unsignedJwt(claims),
			HS256: await hs256Jwt(claims),
		};
		for (const [what, token] of Object.entries(cases)) {
			assert.deepStrictEqual(await observe(auth.requireAuth(bearerCtx(APP, token))), NOT_AUTHENTICATED, what);
			assert.strictEqual(await auth.getCurrentUser(bearerCtx(APP, token)), null, what);
		}
	});
});

describe('allowBearerAuth — the local user pool', () => {
	function makePoolAuth(allowBearerAuth = true) {
		const sent: { code: string; purpose: CodeDeliveryPurpose }[] = [];
		const auth = new Auth(unique(), 'auth', {
			allowBearerAuth,
			admin: {},
			users: { groups: ['admin'] },
			codeDelivery: async (_u: string, code: string, purpose: CodeDeliveryPurpose) => {
				sent.push({ code, purpose });
			},
		});
		return { auth, sent };
	}

	/** Register and sign in `alice`; returns the browser and her pool access token. */
	async function aliceSignedIn(h: ReturnType<typeof makePoolAuth>): Promise<{ b: Browser; accessToken: string }> {
		await h.auth.signUp('alice', PASSWORD, { attributes: { email: 'alice@example.com' } });
		const code = h.sent.find((s) => s.purpose === 'signUp')?.code ?? '';
		await h.auth.confirmSignUp('alice', code);
		const b = new Browser();
		await b.request((ctx) => h.auth.signIn('alice', PASSWORD, ctx));
		const session = await b.request((ctx) => h.auth.getAuthSession(ctx));
		const accessToken = session.tokens?.accessToken.toString() ?? '';
		assert.ok(accessToken, 'a cookie session exposes its access token');
		return { b, accessToken };
	}

	test('the pool access token is accepted; requireRole reads live groups; it outlives signOut()', async () => {
		const h = makePoolAuth();
		const { b, accessToken } = await aliceSignedIn(h);
		const cookieUser = await b.request((ctx) => h.auth.requireAuth(ctx));

		const user = await h.auth.requireAuth(bearerCtx('https://app.example.com', accessToken));
		assert.strictEqual(user.userId, cookieUser.userId, 'the same userId as the cookie session');
		assert.strictEqual(user.userSub, cookieUser.userSub);
		assert.strictEqual(user.signInProvider, 'password');
		assert.deepStrictEqual(user.attributes, {}, 'an access token carries no profile claims');

		// Live groups: added after the token was minted, still seen.
		assert.strictEqual(
			(await observe(h.auth.requireRole(bearerCtx('https://x', accessToken), 'admin'))).status,
			403,
		);
		await h.auth.admin.addUserToGroup('alice', 'admin');
		const admin = await h.auth.requireRole(bearerCtx('https://x', accessToken), 'admin');
		assert.deepStrictEqual(admin.groups, ['admin']);

		// Documented: a bearer token is not checked against the session store.
		await b.request((ctx) => h.auth.signOut(ctx));
		assert.strictEqual((await h.auth.requireAuth(bearerCtx('https://x', accessToken))).userId, 'alice');

		// …but the pool itself stops recognising it once the user is revoked or disabled.
		await h.auth.admin.revokeUserSessions('alice');
		assert.deepStrictEqual(
			await observe(h.auth.requireAuth(bearerCtx('https://x', accessToken))),
			NOT_AUTHENTICATED,
		);
	});

	test('forged mock-shaped tokens and another block’s tokens are refused; off by default', async () => {
		const h = makePoolAuth();
		const { accessToken } = await aliceSignedIn(h);
		const claims = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'));

		const forgedUser = unsignedJwt({ ...claims, username: 'mallory', sub: 'sub-mallory' }, 'mock-signature');
		const otherBlock = unsignedJwt({ ...claims, iss: 'https://mock.bb-auth.local/elsewhere' }, 'mock-signature');
		const idToken = unsignedJwt({ ...claims, token_use: 'id' }, 'mock-signature');
		const expired = unsignedJwt({ ...claims, exp: Math.floor(Date.now() / 1000) - 10 }, 'mock-signature');
		for (const [what, token] of Object.entries({ forgedUser, otherBlock, idToken, expired })) {
			assert.deepStrictEqual(
				await observe(h.auth.requireAuth(bearerCtx('https://x', token))),
				NOT_AUTHENTICATED,
				what,
			);
		}

		const off = makePoolAuth(false);
		const offAlice = await aliceSignedIn(off);
		assert.strictEqual(await off.auth.checkAuth(bearerCtx('https://x', offAlice.accessToken)), false);
	});
});
