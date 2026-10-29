// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `AuthBase` against fake engines: the session guards and their truth table,
 * everything tolerated as signed-out, `requireRole`, the runtime mode gates,
 * sign-out, and the sign-in hooks.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ApiError, isBlocksError } from '@aws-blocks/core';
import { resolveProviders } from './auth-base.js';
import { requiresUserPool } from './cdk/contract.js';
import { encryptAutoSignInPayload, signSessionId } from './cookies.js';
import { AuthErrors } from './errors.js';
import { Auth as MockAuth } from './index.mock.js';
import { SessionStore } from './sessions.js';
import {
	Browser,
	jwt,
	makeAuth,
	makeContext,
	poolTokens,
	sdkError,
	setCookieFor,
	TEST_SECRET,
} from './test-helpers.js';
import { mockStateCapture } from './test-support/legacy-fixtures.js';
import type { AppSettingRef } from './types.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const oktaSecret: AppSettingRef = { fullId: 'okta-secret', get: async () => 'shh' };

function isCleared(lines: readonly string[], name: string): boolean {
	return setCookieFor(lines, name)?.includes('Max-Age=0') ?? false;
}

async function signedIn(options?: Parameters<typeof makeAuth>[0]) {
	const h = makeAuth(options);
	h.native.addUser('alice', 'Passw0rd!', ['admins', 'editors', 'undeclared'], { email: 'alice@example.com' });
	const b = new Browser();
	const r = await b.request((ctx) => h.auth.signIn('alice', 'Passw0rd!', ctx));
	assert.strictEqual(r.status, 'signedIn');
	return { h, b };
}

/** HS256 JWT in AuthBasic's shape. */
function authBasicJwt(): string {
	return jwt({ sub: 'alice', username: 'alice', iat: 1, exp: 4102444800 }).replace(/\.sig$/, '.c2lnbmF0dXJl');
}

// ─────────────────────────────────────────────────────────────────────────────

describe('requireAuth truth table', () => {
	test('no cookie → 401 NotAuthenticated, no Set-Cookie', async () => {
		const h = makeAuth();
		const ctx = makeContext();
		await assert.rejects(h.auth.requireAuth(ctx), { name: AuthErrors.NotAuthenticated, status: 401 });
		await assert.rejects(h.auth.requireAuth(ctx, { fresh: true }), { name: AuthErrors.NotAuthenticated });
		assert.deepStrictEqual(ctx.response.headers.getSetCookie(), []);
	});

	test('unknown session (verified cookie, no row) → 401 and the cookie is cleared', async () => {
		const h = makeAuth();
		const ctx = makeContext(`${h.cookieName}=${signSessionId('no-such-session', TEST_SECRET)}`);
		await assert.rejects(h.auth.requireAuth(ctx), { name: AuthErrors.NotAuthenticated });
		assert.ok(isCleared(ctx.response.headers.getSetCookie(), h.cookieName));
	});

	test('valid and recent → the user, with and without { fresh: true }', async () => {
		const { h, b } = await signedIn({ users: { groups: ['admins', 'editors'] } });
		const user = await b.request((ctx) => h.auth.requireAuth(ctx));
		assert.deepStrictEqual(user, {
			userId: 'alice',
			username: 'alice',
			userSub: 'sub-alice',
			groups: ['admins', 'editors'],
			attributes: { email: 'alice@example.com' },
			signInProvider: 'password',
		});
		assert.strictEqual((await b.request((ctx) => h.auth.requireAuth(ctx, { fresh: true }))).username, 'alice');
	});

	test('valid but older than freshAgeSeconds → only { fresh: true } throws 401 ReauthenticationRequired; session kept', async () => {
		const seed = makeAuth();
		const store = new SessionStore(seed.auth, 400 * 86400);
		const sid = await store.create(poolTokens('alice', { authTime: Math.floor(Date.now() / 1000) - 120 }));
		// A fresh instance (as on the next cold start) reads the row from the store.
		const h = makeAuth({ session: { freshAgeSeconds: 60 } }, { rootId: seed.auth.parent.id });
		const cookie = `${h.cookieName}=${signSessionId(sid, TEST_SECRET)}`;
		assert.strictEqual((await h.auth.requireAuth(makeContext(cookie))).username, 'alice');
		const ctx = makeContext(cookie);
		await assert.rejects(h.auth.requireAuth(ctx, { fresh: true }), {
			name: AuthErrors.ReauthenticationRequired,
			status: 401,
		});
		assert.deepStrictEqual(ctx.response.headers.getSetCookie(), [], 'not signed out');
		assert.ok(await store.lookup(sid));
	});

	test('user disabled upstream → 401 and the cookie is cleared (detected at refresh)', async () => {
		const h = makeAuth();
		h.native.addUser('alice');
		h.native.accessTtl = -60; // every minted access token is already expired
		const b = new Browser();
		await b.request((ctx) => h.auth.signIn('alice', 'Passw0rd!', ctx));
		const u = h.native.users.get('alice');
		assert.ok(u);
		u.disabled = true;
		await assert.rejects(
			b.request((ctx) => h.auth.requireAuth(ctx)),
			{ name: AuthErrors.NotAuthenticated, status: 401 },
		);
		assert.ok(isCleared(b.lastSetCookies, h.cookieName));
		assert.ok(!b.jar.has(h.cookieName));
	});

	test('user deleted upstream → 401 + cleared, and the row is deleted', async () => {
		const h = makeAuth();
		h.native.addUser('alice');
		h.native.accessTtl = -60;
		const b = new Browser();
		await b.request((ctx) => h.auth.signIn('alice', 'Passw0rd!', ctx));
		h.native.users.delete('alice');
		await assert.rejects(
			b.request((ctx) => h.auth.requireAuth(ctx, { fresh: true })),
			{
				name: AuthErrors.NotAuthenticated,
			},
		);
		assert.ok(isCleared(b.lastSetCookies, h.cookieName));
	});

	test('expired access token + live user → refreshed, cookie re-issued (sliding), user returned', async () => {
		const h = makeAuth();
		h.native.addUser('alice');
		h.native.accessTtl = -60;
		const b = new Browser();
		await b.request((ctx) => h.auth.signIn('alice', 'Passw0rd!', ctx));
		h.native.accessTtl = 3600;
		const user = await b.request((ctx) => h.auth.requireAuth(ctx));
		assert.strictEqual(user.username, 'alice');
		assert.ok(h.native.calls.includes('refresh'));
		assert.ok(setCookieFor(b.lastSetCookies, h.cookieName)?.includes('Max-Age=34560000'));
	});

	test('a transient refresh failure keeps the session and surfaces a retriable 5xx (no sign-out)', async () => {
		const h = makeAuth();
		h.native.addUser('alice');
		h.native.accessTtl = -60;
		const b = new Browser();
		await b.request((ctx) => h.auth.signIn('alice', 'Passw0rd!', ctx));
		h.native.refreshError = new TypeError('fetch failed');
		await assert.rejects(
			b.request((ctx) => h.auth.requireAuth(ctx)),
			{
				name: AuthErrors.InternalError,
				status: 500,
				retriable: true,
			},
		);
		assert.ok(b.jar.has(h.cookieName), 'cookie kept');
	});
});

describe('tolerated as signed-out — never a throw, never a 500, never authenticated', () => {
	async function expectSignedOut(h: ReturnType<typeof makeAuth>, cookie: string, cleared: boolean) {
		const ctx = makeContext(cookie);
		assert.strictEqual(await h.auth.getCurrentUser(ctx), null);
		assert.strictEqual(await h.auth.checkAuth(makeContext(cookie)), false);
		assert.deepStrictEqual(await h.auth.getAuthSession(makeContext(cookie)), { tokens: undefined });
		await assert.rejects(h.auth.requireAuth(makeContext(cookie)), {
			name: AuthErrors.NotAuthenticated,
			status: 401,
		});
		assert.strictEqual(isCleared(ctx.response.headers.getSetCookie(), h.cookieName), cleared);
	}

	test('an AuthBasic HS256 JWT under auth_<fullId> → reject-and-clear', async () => {
		const h = makeAuth();
		await expectSignedOut(h, `${h.cookieName}=${authBasicJwt()}`, true);
	});

	test('the session cookie the real AuthBasic set (captured at the cutover) → reject-and-clear', async (t) => {
		// `legacy-mock-state.json` 'basic-session': AuthBasic (bb-auth-basic@0.1.9) signed alice up and in
		// under the same app and block id. Pinning Date keeps its JWT unexpired, as on the first request
		// after the upgrade — a still-valid AuthBasic session must sign out, not slip through.
		const legacy = mockStateCapture('basic-session');
		t.mock.timers.enable({ apis: ['Date'], now: legacy.capturedAt });
		const h = makeAuth(undefined, { rootId: legacy.rootId });
		const value = legacy.cookies[h.cookieName];
		assert.ok(value?.startsWith('eyJ'), `AuthBasic set its JWT under ${h.cookieName}`);
		await expectSignedOut(h, `${h.cookieName}=${value}`, true);
	});

	test('a tampered signature → reject-and-clear', async () => {
		const { h, b } = await signedIn();
		const value = b.jar.get(h.cookieName) ?? '';
		const tampered = `${value.slice(0, -2)}${value.endsWith('AA') ? 'BB' : 'AA'}`;
		await expectSignedOut(h, `${h.cookieName}=${tampered}`, true);
	});

	test('a tampered session id under the original signature → reject-and-clear', async () => {
		const { h, b } = await signedIn();
		const [sid, sig] = (b.jar.get(h.cookieName) ?? '').split('.');
		await expectSignedOut(h, `${h.cookieName}=${sid}x.${sig}`, true);
	});

	test('a cookie signed with another secret → reject-and-clear', async () => {
		const seed = makeAuth();
		const sid = await new SessionStore(seed.auth).create(poolTokens('alice'));
		const h = makeAuth(undefined, { rootId: seed.auth.parent.id });
		// Control: with the right secret the same row is signed in…
		assert.strictEqual(
			(await h.auth.getCurrentUser(makeContext(`${h.cookieName}=${signSessionId(sid, TEST_SECRET)}`)))?.username,
			'alice',
		);
		// …with another secret it is not.
		await expectSignedOut(h, `${h.cookieName}=${signSessionId(sid, 'some-other-secret')}`, true);
	});

	for (const [label, value] of [
		['no signature', 'abcdef'],
		['empty signature', 'abcdef.'],
		['only a dot', '.'],
		['non-base64 junk', '%%%%.$$$$'],
		['quoted', '"abc.def"'],
	] as const) {
		test(`a malformed cookie (${label}) → reject-and-clear`, async () => {
			const h = makeAuth();
			await expectSignedOut(h, `${h.cookieName}=${value}`, true);
		});
	}

	test('an old AuthOIDC row in the same table, reached by a verified cookie → signed-out, cleared, row untouched', async () => {
		const h = makeAuth();
		const { KVStore } = await import('@aws-blocks/bb-kv-store');
		const table = new KVStore<unknown>(h.auth, 'sessions');
		const oidcRow = {
			userId: 'https://idp.example.com:sub-1',
			refreshToken: 'r',
			expiresAt: Date.now() + 3600_000,
			claims: { sub: 'sub-1', iss: 'https://idp.example.com' },
			state: 'ready',
		};
		await table.put('oidc-session-id', oidcRow);
		const fresh = makeAuth(undefined, { rootId: h.auth.parent.id });
		await expectSignedOut(fresh, `${fresh.cookieName}=${signSessionId('oidc-session-id', TEST_SECRET)}`, true);
		const reread = new KVStore<unknown>(fresh.auth, 'sessions');
		assert.deepStrictEqual(await reread.get('oidc-session-id'), oidcRow, 'a foreign row is never deleted');
	});

	for (const [label, row] of [
		['a pool row whose id token is not a JWT', { idToken: 'garbage', accessToken: 'garbage', refreshToken: '' }],
		[
			'a pool row with no sub',
			{ idToken: jwt({ 'cognito:username': 'x' }), accessToken: jwt({ exp: 1 }), refreshToken: '' },
		],
		['a direct row missing fields', { kind: 'direct', provider: 'okta' }],
		['an unknown discriminator', { kind: 'something-else' }],
		['a string', 'just a string'],
	] as const) {
		test(`${label} → signed-out`, async () => {
			const h = makeAuth();
			const { KVStore } = await import('@aws-blocks/bb-kv-store');
			await new KVStore<unknown>(h.auth, 'sessions').put('bad', row);
			const fresh = makeAuth(undefined, { rootId: h.auth.parent.id });
			await expectSignedOut(fresh, `${fresh.cookieName}=${signSessionId('bad', TEST_SECRET)}`, true);
		});
	}

	test('sibling cookie names never satisfy the lookup (anchored reader)', async () => {
		const { h, b } = await signedIn();
		const value = b.jar.get(h.cookieName) ?? '';
		for (const sibling of [
			`my_${h.cookieName}`,
			`x${h.cookieName}`,
			`${h.cookieName}_old`,
			`${h.cookieName.toUpperCase()}`,
		]) {
			await expectSignedOut(h, `${sibling}=${value}`, false);
		}
		// …but the right cookie among siblings still works.
		const ctx = makeContext(`my_${h.cookieName}=junk; ${h.cookieName}=${value}; other=1`);
		assert.strictEqual((await h.auth.getCurrentUser(ctx))?.username, 'alice');
	});

	test('a fullId with regex metacharacters does not match look-alike cookies', async () => {
		const h = makeAuth(undefined, { rootId: 'my.app', id: 'auth' });
		h.native.addUser('alice');
		const b = new Browser();
		await b.request((ctx) => h.auth.signIn('alice', 'Passw0rd!', ctx));
		const value = b.jar.get('auth_my.app-auth') ?? '';
		await expectSignedOut(h, `auth_myXapp-auth=${value}`, false);
	});
});

describe('requireRole', () => {
	test('reads live groups, narrows the result to the declared set, and dedupes per request', async () => {
		const { h, b } = await signedIn({ users: { groups: ['admins', 'editors'] } });
		const user = await b.request(async (ctx) => {
			const a = await h.auth.requireRole(ctx, 'admins');
			const e = await h.auth.requireRole(ctx, 'editors');
			assert.deepStrictEqual(a.groups, ['admins', 'editors']);
			return e;
		});
		assert.deepStrictEqual(user.groups, ['admins', 'editors'], 'undeclared live group dropped');
		assert.strictEqual(h.native.calls.filter((c) => c.startsWith('listGroups')).length, 1, 'one read per request');
		await b.request((ctx) => h.auth.requireRole(ctx, 'admins'));
		assert.strictEqual(
			h.native.calls.filter((c) => c.startsWith('listGroups')).length,
			2,
			'next request reads again',
		);
	});

	test('membership is live: removal applies on the next request, without re-login', async () => {
		const { h, b } = await signedIn({ users: { groups: ['admins'] } });
		await b.request((ctx) => h.auth.requireRole(ctx, 'admins'));
		h.native.groups.set('alice', []);
		await assert.rejects(
			b.request((ctx) => h.auth.requireRole(ctx, 'admins')),
			{
				name: AuthErrors.NotAuthorized,
				status: 403,
			},
		);
	});

	test('a user deleted upstream → 403 NotAuthorized (fail closed), never a 404', async () => {
		const { h, b } = await signedIn({ users: { groups: ['admins'] } });
		h.native.users.delete('alice');
		await assert.rejects(
			b.request((ctx) => h.auth.requireRole(ctx, 'admins')),
			(e: unknown) => {
				assert.ok(e instanceof ApiError);
				assert.strictEqual(e.status, 403);
				assert.strictEqual(e.name, AuthErrors.NotAuthorized);
				return true;
			},
		);
	});

	test('a rejected read is not cached: a retry in the same request reads again', async () => {
		const { h, b } = await signedIn({ users: { groups: ['admins'] } });
		h.native.listGroupsError = sdkError('TooManyRequestsException', 'Rate exceeded', 429);
		await b.request(async (ctx) => {
			await assert.rejects(h.auth.requireRole(ctx, 'admins'), { name: AuthErrors.TooManyRequests, status: 429 });
			assert.strictEqual((await h.auth.requireRole(ctx, 'admins')).username, 'alice');
		});
	});

	test('signed out → 401; { fresh } is honoured', async () => {
		const h = makeAuth({ users: { groups: ['admins'] } });
		await assert.rejects(h.auth.requireRole(makeContext(), 'admins'), { name: AuthErrors.NotAuthenticated });
	});

	test('a direct-federated session uses its groupsClaim snapshot, narrowed', async () => {
		const h = makeAuth({
			emailPassword: false,
			users: { groups: ['admins'] },
			oidcProviders: { okta: { issuer: 'https://okta.example.com', clientId: 'c' } },
		});
		assert.strictEqual(h.nativeBuilt, false, 'no pool → no native engine (Q6)');
		const okta = h.federation.get('okta');
		assert.ok(okta);
		okta.identity = {
			kind: 'direct',
			issuer: 'https://okta.example.com',
			subject: 'u-1',
			claims: { sub: 'u-1', iss: 'https://okta.example.com', email: 'eve@example.com', groups: ['admins', 'x'] },
			groups: ['admins', 'x'],
			expiresAt: Date.now() + 3600_000,
		};
		const b = new Browser();
		const user = await b.request((ctx) => h.auth.completeFederated(ctx, 'okta'));
		assert.strictEqual(user.userId, 'https://okta.example.com:u-1', 'Q1 identity');
		assert.strictEqual(user.userSub, 'https://okta.example.com:u-1');
		assert.strictEqual(user.username, 'eve@example.com');
		assert.strictEqual(user.signInProvider, 'okta');
		const role = await b.request((ctx) => h.auth.requireRole(ctx, 'admins'));
		assert.deepStrictEqual(role.groups, ['admins']);
	});
});

describe('federated sessions in the same table', () => {
	test('a direct session is a discriminated row; it refreshes and signs out through its provider engine', async () => {
		const h = makeAuth({ oidcProviders: { okta: { issuer: 'https://okta.example.com', clientId: 'c' } } });
		const okta = h.federation.get('okta');
		assert.ok(okta);
		okta.identity = {
			kind: 'direct',
			issuer: 'https://okta.example.com',
			subject: 'u-1',
			claims: { sub: 'u-1', name: 'Eve' },
			groups: [],
			expiresAt: Date.now() - 1,
			idToken: jwt({ sub: 'u-1' }),
			accessToken: jwt({ sub: 'u-1', exp: 1 }),
		};
		okta.logoutUrl = 'https://okta.example.com/logout';
		const b = new Browser();
		await b.request((ctx) => h.auth.completeFederated(ctx, 'okta'));
		const session = await b.request((ctx) => h.auth.getAuthSession(ctx));
		assert.ok(session.tokens);
		assert.ok(okta.calls.includes('refresh:direct'));
		const user = await b.request((ctx) => h.auth.requireAuth(ctx));
		assert.strictEqual(user.username, 'Eve');
		await b.request(async (ctx) => {
			await h.auth.signOut(ctx);
			assert.strictEqual(h.auth.redirectFor(ctx), 'https://okta.example.com/logout');
		});
		assert.ok(!b.jar.has(h.cookieName));
	});

	test('a hosted-UI (pool) session records its provider and refreshes through that provider', async () => {
		const h = makeAuth({
			socialProviders: { google: { clientId: 'g', clientSecret: oktaSecret } },
		});
		const google = h.federation.get('google');
		assert.ok(google);
		google.identity = { kind: 'pool', tokens: poolTokens('google_123', { accessExpIn: -1 }) };
		const b = new Browser();
		const user = await b.request((ctx) => h.auth.completeFederated(ctx, 'google'));
		assert.strictEqual(user.signInProvider, 'google');
		await b.request((ctx) => h.auth.requireAuth(ctx));
		assert.ok(google.calls.includes('refresh:pool'));
		assert.ok(!h.native.calls.includes('refresh'), 'the native engine does not refresh a hosted-UI session');
	});

	test('a session whose provider was removed from the config → signed out', async () => {
		const h = makeAuth({ oidcProviders: { okta: { issuer: 'https://okta.example.com', clientId: 'c' } } });
		const okta = h.federation.get('okta');
		assert.ok(okta);
		okta.identity = {
			kind: 'direct',
			issuer: 'i',
			subject: 's',
			claims: {},
			groups: [],
			expiresAt: Date.now() - 1,
		};
		const b = new Browser();
		await b.request((ctx) => h.auth.completeFederated(ctx, 'okta'));
		const without = makeAuth(undefined, { rootId: h.auth.parent.id });
		const cookie = b.cookieHeader() ?? '';
		assert.strictEqual(await without.auth.getCurrentUser(makeContext(cookie)), null);
	});
});

describe('runtime mode gates (backstop for untyped callers)', () => {
	test('email + password disabled → 409 EmailPasswordNotEnabled on every password method; no engine call', async () => {
		const h = makeAuth({
			emailPassword: false,
			oidcProviders: { okta: { issuer: 'https://okta.example.com', clientId: 'c' } },
		});
		// An untyped JavaScript caller, simulated through the wide type.
		const wide: MockAuth = h.auth;
		const ctx = makeContext();
		const calls: Array<() => Promise<unknown>> = [
			() => wide.signUp('a', 'b'),
			() => wide.confirmSignUp('a', '1'),
			() => wide.resendSignUpCode('a'),
			() => wide.signIn('a', 'b', ctx),
			() => wide.confirmSignIn('s', 'r', ctx),
			() => wide.autoSignIn(ctx),
			() => wide.resetPassword('a'),
			() => wide.confirmResetPassword('a', '1', 'p'),
			() => wide.updatePassword(ctx, 'a', 'b'),
		];
		for (const call of calls) {
			await assert.rejects(call(), { name: AuthErrors.EmailPasswordNotEnabled, status: 409 });
		}
		assert.deepStrictEqual(h.native.calls, []);
	});

	test('no federated provider → 409 NoFederatedProvider; unknown provider → 400 ProviderNotConfigured', async () => {
		const none = makeAuth();
		const wide: { getSignInUrl(ctx: unknown, p: string): Promise<string> } = {
			getSignInUrl: (ctx, p) => Reflect.apply(none.auth.getSignInUrl, none.auth, [ctx, p]),
		};
		await assert.rejects(wide.getSignInUrl(makeContext(), 'okta'), {
			name: AuthErrors.NoFederatedProvider,
			status: 409,
		});
		const some = makeAuth({ oidcProviders: { okta: { issuer: 'https://okta.example.com', clientId: 'c' } } });
		assert.match(await some.auth.getSignInUrl(makeContext(), 'okta'), /^https:\/\/idp\.example\.com\//);
		await assert.rejects(Reflect.apply(some.auth.getSignInUrl, some.auth, [makeContext(), 'github']), {
			name: AuthErrors.ProviderNotConfigured,
			status: 400,
		});
	});

	test('requiresUserPool follows Q6; provider resolution is per provider', () => {
		assert.strictEqual(requiresUserPool({}), true);
		assert.strictEqual(
			requiresUserPool({ emailPassword: false, oidcProviders: { okta: { issuer: 'i', clientId: 'c' } } }),
			false,
		);
		assert.strictEqual(
			requiresUserPool({
				emailPassword: false,
				oidcProviders: {
					okta: { issuer: 'i', clientId: 'c', federateVia: 'cognito', clientSecret: oktaSecret },
				},
			}),
			true,
		);
		assert.strictEqual(
			requiresUserPool({
				emailPassword: false,
				socialProviders: { google: { clientId: 'g', clientSecret: oktaSecret } },
			}),
			true,
		);
		assert.strictEqual(
			requiresUserPool({ emailPassword: false, samlProviders: { corp: { metadataUrl: 'u' } } }),
			true,
		);
		const resolved = resolveProviders({
			socialProviders: { google: { clientId: 'g', clientSecret: oktaSecret } },
			oidcProviders: {
				okta: { issuer: 'i', clientId: 'c' },
				entra: {
					issuer: 'i',
					clientId: 'c',
					federateVia: 'cognito',
					clientSecret: oktaSecret,
					label: 'Work account',
				},
			},
		});
		assert.deepStrictEqual(
			resolved.map((p) => [p.id, p.transport, p.label]),
			[
				['google', 'hosted-ui', 'Sign in with Google'],
				['okta', 'direct', 'Sign in with Okta'],
				['entra', 'hosted-ui', 'Work account'],
			],
		);
	});

	test('duplicate provider ids across records fail at construction', () => {
		assert.throws(
			() =>
				makeAuth({
					socialProviders: { google: { clientId: 'g', clientSecret: oktaSecret } },
					oidcProviders: { google: { issuer: 'i', clientId: 'c' } },
				}),
			/configured more than once/,
		);
	});
});

describe('email + password flows through AuthBase', () => {
	test('sign-in failures are uniform: unknown user, wrong password and disabled user are byte-identical', async () => {
		const h = makeAuth();
		h.native.addUser('alice');
		h.native.addUser('dora');
		const d = h.native.users.get('dora');
		assert.ok(d);
		d.disabled = true;
		const shapes: string[] = [];
		for (const [u, p] of [
			['nobody', 'x'],
			['alice', 'wrong'],
			['dora', 'Passw0rd!'],
		]) {
			try {
				await h.auth.signIn(u, p, makeContext());
				assert.fail('expected a rejection');
			} catch (e) {
				assert.ok(e instanceof ApiError);
				shapes.push(
					JSON.stringify({ name: e.name, status: e.status, message: e.message, retriable: e.retriable }),
				);
			}
		}
		assert.strictEqual(new Set(shapes).size, 1);
		assert.deepStrictEqual(JSON.parse(shapes[0]), {
			name: AuthErrors.NotAuthorized,
			status: 401,
			message: 'Incorrect username or password',
			retriable: false,
		});
	});

	test('reset password and confirm-code flows never reveal an unknown user', async () => {
		const h = makeAuth();
		const r = await h.auth.resetPassword('ghost@example.com');
		assert.deepStrictEqual(r.nextStep?.codeDeliveryDetails, {
			destination: 'g***@e***',
			deliveryMedium: 'EMAIL',
			attributeName: 'email',
		});
		await assert.rejects(h.auth.confirmResetPassword('ghost', '123', 'P@ssw0rd!'), {
			name: AuthErrors.CodeMismatch,
			status: 400,
			retriable: true,
		});
		await assert.rejects(h.auth.confirmSignUp('ghost', '123'), { name: AuthErrors.CodeMismatch });
		await h.auth.resendSignUpCode('ghost');
	});

	test('auto sign-in: signUp sets the bridge, confirmSignUp threads it, autoSignIn signs in and clears it', async () => {
		const h = makeAuth();
		const b = new Browser();
		await b.request((ctx) => h.auth.signUp('newbie', 'Passw0rd!', { attributes: { email: 'n@example.com' } }, ctx));
		const bridge = `autosignin_${h.auth.fullId}`;
		assert.ok(b.jar.has(bridge));
		const confirmed = await b.request((ctx) => h.auth.confirmSignUp('newbie', '123456', ctx));
		assert.strictEqual(confirmed.nextStep.signUpStep, 'COMPLETE_AUTO_SIGN_IN');
		assert.ok(h.native.calls.includes('confirmSignUp:newbie:bridge-from-signup'));
		const r = await b.request((ctx) => h.auth.autoSignIn(ctx));
		assert.strictEqual(r.status, 'signedIn');
		assert.ok(h.native.calls.includes('signIn:newbie:bridge-from-confirm'));
		assert.ok(!b.jar.has(bridge), 'bridge cleared');
		assert.ok(b.jar.has(h.cookieName), 'session issued in the same response (B6: both lines survive)');
		await assert.rejects(
			b.request((ctx) => h.auth.autoSignIn(ctx)),
			{ name: AuthErrors.NotAuthenticated },
		);
	});

	test('autoSignIn with a tampered bridge → 401 and the bridge is cleared', async () => {
		const h = makeAuth();
		const b = new Browser();
		const bridge = `autosignin_${h.auth.fullId}`;
		const good = encryptAutoSignInPayload({ username: 'x', password: 'y', exp: Date.now() + 60_000 }, TEST_SECRET);
		b.jar.set(bridge, `${good.slice(0, -3)}AAA`);
		await assert.rejects(
			b.request((ctx) => h.auth.autoSignIn(ctx)),
			{ name: AuthErrors.NotAuthenticated },
		);
		assert.ok(isCleared(b.lastSetCookies, bridge));
	});

	test('validateUser rejection on sign-in prevents the session and revokes upstream', async () => {
		const h = makeAuth({
			validateUser: async (c) => {
				if (c.phase === 'signIn' && c.username === 'alice') {
					throw new ApiError('Corporate accounts only', 403, { name: AuthErrors.NotAuthorized });
				}
			},
		});
		h.native.addUser('alice');
		const b = new Browser();
		await assert.rejects(
			b.request((ctx) => h.auth.signIn('alice', 'Passw0rd!', ctx)),
			{
				name: AuthErrors.NotAuthorized,
				status: 403,
				message: 'Corporate accounts only',
			},
		);
		assert.ok(!b.jar.has(h.cookieName));
		assert.ok(h.native.calls.includes('signOut:false'));
	});

	test('onSignIn throwing rolls the session back', async () => {
		const h = makeAuth({
			onSignIn: async () => {
				throw new ApiError('nope', 403, { name: AuthErrors.NotAuthorized });
			},
		});
		h.native.addUser('alice');
		const b = new Browser();
		await assert.rejects(
			b.request((ctx) => h.auth.signIn('alice', 'Passw0rd!', ctx)),
			{ status: 403 },
		);
		assert.ok(!b.jar.has(h.cookieName));
	});

	test('signOut: clears the cookie even when signed out; global revokes upstream; onSignOut errors never block', async () => {
		const h = makeAuth({
			onSignOut: async () => {
				throw new Error('hook failed');
			},
		});
		const anon = makeContext();
		await h.auth.signOut(anon);
		assert.ok(isCleared(anon.response.headers.getSetCookie(), h.cookieName));

		h.native.addUser('alice');
		const b = new Browser();
		await b.request((ctx) => h.auth.signIn('alice', 'Passw0rd!', ctx));
		const cookie = b.cookieHeader() ?? '';
		await b.request((ctx) => h.auth.signOut(ctx, { global: true }));
		assert.ok(h.native.calls.includes('signOut:true'));
		assert.ok(!b.jar.has(h.cookieName));
		assert.strictEqual(await h.auth.getCurrentUser(makeContext(cookie)), null, 'the replayed cookie is dead');
	});

	test('getAuthSession never throws, and returns Amplify-shaped tokens when signed in', async () => {
		const { h, b } = await signedIn();
		const s = await b.request((ctx) => h.auth.getAuthSession(ctx));
		assert.strictEqual(s.userSub, 'sub-alice');
		assert.strictEqual(s.tokens?.idToken.payload['cognito:username'], 'alice');
		assert.ok((s.tokens?.accessToken.expiresAt ?? 0) > Date.now());
		h.native.refreshError = new Error('boom');
		const forced = await b.request((ctx) => h.auth.getAuthSession(ctx, { forceRefresh: true }));
		assert.deepStrictEqual(forced, { tokens: undefined });
	});

	test('updatePassword on a federated session is a 400, not a call to the pool', async () => {
		const h = makeAuth({ oidcProviders: { okta: { issuer: 'https://okta.example.com', clientId: 'c' } } });
		const okta = h.federation.get('okta');
		assert.ok(okta);
		okta.identity = {
			kind: 'direct',
			issuer: 'i',
			subject: 's',
			claims: {},
			groups: [],
			expiresAt: Date.now() + 60_000,
		};
		const b = new Browser();
		await b.request((ctx) => h.auth.completeFederated(ctx, 'okta'));
		await assert.rejects(
			b.request((ctx) => h.auth.updatePassword(ctx, 'a', 'b')),
			{
				name: AuthErrors.InvalidParameter,
				status: 400,
			},
		);
		assert.ok(!h.native.calls.some((c) => c.startsWith('updatePassword')));
	});
});

describe('the real entry points construct AuthBase with their engines', () => {
	test('index.mock.ts: guards work; the local user pool answers (D5b), uniform for an unknown user', async () => {
		const auth = new MockAuth({ id: 'placeholder-app' }, 'auth');
		assert.strictEqual(await auth.getCurrentUser(makeContext()), null);
		await assert.rejects(auth.signIn('a', 'b', makeContext()), (e: unknown) => {
			assert.ok(isBlocksError(e, AuthErrors.NotAuthorized));
			assert.ok(e instanceof ApiError);
			assert.strictEqual(e.status, 401);
			assert.strictEqual(e.message, 'Incorrect username or password');
			return true;
		});
	});

	test('index.aws.ts: the Cognito engine is complete (no 501 bridge); only rememberDevice is a 501, saying why', async () => {
		const { Auth: AwsAuth } = await import('./index.aws.js');
		const auth = new AwsAuth({ id: 'aws-complete-app' }, 'auth', { admin: {} });
		const engine: unknown = Reflect.get(auth, 'native');
		assert.ok(typeof engine === 'object' && engine !== null);
		const admin: unknown = Reflect.get(engine, 'admin');
		assert.ok(typeof admin === 'object' && admin !== null);
		for (const key of ['getUserAttributes', 'deleteUser', 'setUpTotp', 'listDevices', 'forgetDevice']) {
			assert.ok(Object.hasOwn(Object.getPrototypeOf(engine), key), `${key} is a real engine method`);
		}
		// No pool ids in this process: a real call fails as "not provisioned" (500), not "not implemented" (501).
		await assert.rejects(auth.admin.getUser('alice'), { status: 500, name: AuthErrors.InternalError });
		const remember: unknown = Reflect.get(engine, 'rememberDevice');
		assert.ok(typeof remember === 'function');
		await assert.rejects(Promise.resolve(Reflect.apply(remember, engine, ['t'])), {
			status: 501,
			message: /ConfirmDevice/,
		});
	});

	test('index.aws.ts loads and constructs without AWS configuration (lazy)', async () => {
		const { Auth: AwsAuth } = await import('./index.aws.js');
		const auth = new AwsAuth({ id: 'aws-placeholder-app' }, 'auth');
		assert.strictEqual(auth.fullId, 'aws-placeholder-app-auth');
		// A hosted-UI provider (D6b) without its deployed config keys refuses
		// clearly — never a 404, and no request is made. The configured flow is in
		// federation-hosted-ui.test.ts; direct providers in federation-direct.test.ts.
		const secret = { fullId: 'okta-secret', get: async () => 's' };
		const fed = new AwsAuth({ id: 'aws-placeholder-app' }, 'fed', {
			oidcProviders: {
				okta: {
					issuer: 'https://okta.example.com',
					clientId: 'c',
					federateVia: 'cognito',
					clientSecret: secret,
				},
			},
		});
		await assert.rejects(fed.getSignInUrl(makeContext(), 'okta'), {
			status: 500,
			name: 'ProviderMisconfiguredException',
			message: /'okta' is not available: this deployment has no Cognito managed-login configuration/,
		});
	});
});
