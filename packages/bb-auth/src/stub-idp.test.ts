// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The stub IdP end to end on the mock entry, over real HTTP and through the
 * real routes: `emailPassword: false` + a `stubIdp()` provider signs in
 * offline (sign-in route → stub `/authorize` → account picker → callback →
 * session → `requireAuth` / `requireRole` → `getAuthState` → sign-out via the
 * IdP's end-session redirect), plus the stub's own protocol checks.
 */

import assert from 'node:assert';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AuthActionInput, AuthState, AuthStateApi } from '@aws-blocks/auth-common';
import { ApiError, type BlocksContext, clearRouteRegistry, isBlocksError } from '@aws-blocks/core';
import { getMockDataDir } from '@aws-blocks/core/bb-utils';
import { pkceChallenge } from './engines/federation-direct.js';
import { decodePendingAuth, encodePendingAuth } from './engines/pending-auth.js';
import { stubValueMatches } from './engines/stub-idp.js';
import { AuthErrors } from './errors.js';
import { Auth, stubIdp } from './index.mock.js';
import { readMockSessionSecret } from './sessions.js';
import { location, type RouteServer, startRouteServer, TestBrowser } from './test-support/route-server.js';
import type { StubUser } from './types.js';

const ALICE: StubUser = { sub: 'u-1', email: 'alice@example.com', name: 'Alice', extra: { groups: ['admin'] } };
const BOB: StubUser = { sub: 'u-2', email: 'bob@example.com', name: 'Bob' };

let server: RouteServer;
let counter = 0;
const unique = () => ({ id: `stub${process.pid}x${++counter}` });

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

function bind(api: AuthStateApi, ctx: BlocksContext): AuthStateApi {
	const target: unknown = api;
	assert.ok(typeof target === 'function');
	const handler: unknown = Reflect.apply(target, undefined, [ctx]);
	assert.ok(typeof handler === 'object' && handler !== null);
	const getAuthState: unknown = Reflect.get(handler, 'getAuthState');
	const setAuthState: unknown = Reflect.get(handler, 'setAuthState');
	assert.ok(typeof getAuthState === 'function' && typeof setAuthState === 'function');
	return {
		getAuthState: () => Reflect.apply(getAuthState, handler, []),
		setAuthState: (input: AuthActionInput) => Reflect.apply(setAuthState, handler, [input]),
	};
}

function makeStubAuth() {
	return new Auth(unique(), 'auth', {
		emailPassword: false,
		oidcProviders: { corp: stubIdp({ users: [ALICE, BOB] }) },
		users: { groups: ['admin'] },
	});
}

/** Walk the server-initiated flow for `sub` through the picker; returns the final landing response. */
async function signInThroughPicker(b: TestBrowser, sub: string, signInPath = '/aws-blocks/auth/signin/corp') {
	const start = await b.fetch(`${server.origin}${signInPath}`);
	return continueThroughPicker(b, start, sub);
}

/** {@link signInThroughPicker} from the sign-in route's response on. */
async function continueThroughPicker(b: TestBrowser, start: Response, sub: string) {
	assert.strictEqual(start.status, 302, 'the sign-in route redirects to the IdP');
	const authorize = location(start, server.origin);
	assert.ok(authorize.startsWith(`${server.origin}/aws-blocks/auth/idp/corp/authorize?`), authorize);

	const picker = await b.fetch(authorize);
	assert.strictEqual(picker.status, 200);
	const html = await picker.text();
	assert.match(html, /AWS Blocks stub IdP/);
	assert.match(html, /Alice/);
	assert.match(html, /Bob/);

	// Submit the picker the way the browser does: its hidden fields are the authorize parameters.
	const form = new URLSearchParams(new URL(authorize).searchParams);
	form.set('sub', sub);
	const submitted = await b.fetch(`${server.origin}/aws-blocks/auth/idp/corp/authorize`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: form.toString(),
	});
	assert.strictEqual(submitted.status, 302);
	const callback = location(submitted, server.origin);
	assert.ok(callback.startsWith(`${server.origin}/aws-blocks/auth/callback?code=`), callback);
	return b.fetch(callback);
}

describe('stub IdP — emailPassword: false, end to end on the mock', () => {
	test('sign in via the routes → session → requireAuth / requireRole → getAuthState → sign-out', async () => {
		const auth = makeStubAuth();
		const api = auth.createApi();
		const b = new TestBrowser();

		const landing = await signInThroughPicker(b, 'u-1');
		assert.strictEqual(landing.status, 302);
		assert.strictEqual(landing.headers.get('location'), '/', 'lands on postSignInPath');
		assert.ok(b.jar.has(`auth_${auth.fullId}`), 'the session cookie is set');
		assert.ok(!b.jar.has(`authpending_${auth.fullId}`), 'the pending cookie is consumed');

		const issuer = `${server.origin}/aws-blocks/auth/idp/corp`;
		const user = await auth.requireAuth(b.context(server.origin));
		assert.strictEqual(user.userId, `${issuer}:u-1`, 'Q1: userId is <iss>:<sub>');
		assert.strictEqual(user.userSub, user.userId);
		assert.strictEqual(user.username, 'Alice');
		assert.strictEqual(user.signInProvider, 'corp');
		assert.strictEqual(user.attributes.email, 'alice@example.com');
		assert.ok(!('nonce' in user.attributes), 'protocol claims are not profile attributes');
		assert.deepStrictEqual(user.groups, ['admin'], 'groups from the groupsClaim');
		assert.strictEqual((await auth.requireRole(b.context(server.origin), 'admin')).userId, user.userId);
		// The verified ID-token claims, as AuthOIDC's user carried them: the raw, unprefixed `sub`.
		assert.strictEqual(user.claims?.sub, 'u-1', 'claims.sub is the IdP subject, not the prefixed userId');
		assert.strictEqual(user.claims?.iss, issuer);
		assert.strictEqual(user.claims?.email, 'alice@example.com');
		assert.ok(Object.isFrozen(user.claims));

		const state: AuthState = await bind(api, b.context(server.origin)).getAuthState();
		assert.strictEqual(state.state, 'signedIn');
		assert.ok(state.user && !('claims' in state.user), 'claims stay server-side: not in AuthState.user');
		const signOut = state.actions.find((a) => a.name === 'signOut');
		assert.deepStrictEqual(
			{ url: signOut?.url, method: signOut?.method },
			{ url: '/aws-blocks/auth/signout', method: 'POST' },
			'a federated session signs out through the route (so the IdP logout is followed)',
		);

		// The <Authenticator> submits a real form: the route follows the IdP's end-session endpoint.
		const out = await b.fetch(`${server.origin}/aws-blocks/auth/signout`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: '',
		});
		assert.strictEqual(out.status, 303);
		const logout = new URL(location(out, server.origin));
		assert.strictEqual(`${logout.origin}${logout.pathname}`, `${issuer}/logout`);
		assert.ok(logout.searchParams.get('id_token_hint'));
		assert.strictEqual(logout.searchParams.get('post_logout_redirect_uri'), `${server.origin}/`);
		assert.ok(!b.jar.has(`auth_${auth.fullId}`), 'the session cookie is cleared');
		const back = await b.fetch(logout.toString());
		assert.strictEqual(back.status, 302);
		assert.strictEqual(back.headers.get('location'), `${server.origin}/`);

		await assert.rejects(auth.requireAuth(b.context(server.origin)), (e: unknown) => {
			assert.ok(e instanceof ApiError && isBlocksError(e, AuthErrors.NotAuthenticated));
			return true;
		});
	});

	test('a user outside the role is refused by requireRole (403)', async () => {
		const auth = makeStubAuth();
		const b = new TestBrowser();
		await signInThroughPicker(b, 'u-2');
		const user = await auth.requireAuth(b.context(server.origin));
		assert.strictEqual(user.username, 'Bob');
		assert.deepStrictEqual(user.groups, []);
		await assert.rejects(auth.requireRole(b.context(server.origin), 'admin'), { status: 403 });
	});

	test('redirectPath round-trips through the pending cookie', async () => {
		makeStubAuth();
		const b = new TestBrowser();
		const landing = await signInThroughPicker(
			b,
			'u-1',
			'/aws-blocks/auth/signin/corp?redirectPath=%2Fdashboard%3Ftab%3D2',
		);
		assert.strictEqual(landing.headers.get('location'), '/dashboard?tab=2');
	});

	test('the sign-in route refuses a redirectPath a browser would resolve to another origin', async () => {
		makeStubAuth();
		const b = new TestBrowser();
		// Each value is the query value as sent: `%09` / `%0A` / `%0D` decode to
		// TAB / LF / CR, which a browser strips while parsing `Location`, so
		// `/\t/evil.example.com` would land on `https://evil.example.com/`.
		for (const raw of [
			'%2F%09%2Fevil.example.com',
			'/%09/evil.example.com',
			'/%0A/evil.example.com',
			'/%0D/evil.example.com',
			'/%00/evil.example.com',
			'/%5Cevil.example.com',
			'%2F%2Fevil.example.com',
			'/.//evil.example.com',
			'/a/..//evil.example.com',
			'%09/evil.example.com',
			'https://evil.example.com/',
			'javascript:alert(1)',
		]) {
			const res = await b.fetch(`${server.origin}/aws-blocks/auth/signin/corp?redirectPath=${raw}`);
			assert.strictEqual(res.status, 400, raw);
			assert.strictEqual(res.headers.get('location'), null, raw);
			const body: unknown = await res.json();
			assert.strictEqual(Reflect.get(Object(body), 'name'), AuthErrors.InvalidParameter, raw);
		}
		assert.ok(![...b.jar.keys()].some((k) => k.startsWith('authpending_')), 'no sign-in was started');
	});

	test('the landing Location is the re-serialised same-origin path (query and hash kept)', async () => {
		makeStubAuth();
		for (const [raw, expected] of [
			['%2Fdashboard%3Ftab%3D2%23top', '/dashboard?tab=2#top'],
			['%2Fa%20b%3Fq%3Dx%20y', '/a%20b?q=x%20y'],
			// A space is not a control character: it stays in the path, escaped.
			['%2F%20%2Fevil.example.com', '/%20/evil.example.com'],
			['%2F%2520%2Fx', '/%20/x'],
		]) {
			const landing = await signInThroughPicker(
				new TestBrowser(),
				'u-1',
				`/aws-blocks/auth/signin/corp?redirectPath=${raw}`,
			);
			assert.strictEqual(landing.status, 302, raw);
			assert.strictEqual(landing.headers.get('location'), expected, raw);
		}
	});

	test('a pending cookie carrying an unsafe redirectPath lands on postSignInPath instead', async () => {
		// Defense in depth: a cookie signed before the stricter check (or by any
		// future writer) is re-validated where it becomes a `Location`.
		const auth = new Auth(unique(), 'auth', {
			emailPassword: false,
			oidcProviders: { corp: stubIdp({ users: [ALICE, BOB] }) },
			redirects: { postSignInPath: '/home' },
		});
		const b = new TestBrowser();
		const start = await b.fetch(`${server.origin}/aws-blocks/auth/signin/corp?redirectPath=%2Fok`);
		const name = `authpending_${auth.fullId}`;
		const secret = readMockSessionSecret(getMockDataDir(auth));
		const pending = decodePendingAuth(b.jar.get(name) ?? '', secret);
		assert.ok(pending, 'the sign-in route set a pending cookie');
		assert.strictEqual(pending.redirectPath, '/ok');
		b.jar.set(name, encodePendingAuth({ ...pending, redirectPath: '/\t/evil.example.com' }, secret));
		const landing = await continueThroughPicker(b, start, 'u-1');
		assert.strictEqual(landing.status, 302);
		assert.strictEqual(landing.headers.get('location'), '/home');
	});

	test('a JSON (native) sign-out gets 204, not a redirect', async () => {
		const auth = makeStubAuth();
		const b = new TestBrowser();
		await signInThroughPicker(b, 'u-1');
		const out = await b.fetch(`${server.origin}/aws-blocks/auth/signout`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		});
		assert.strictEqual(out.status, 204);
		assert.ok(!b.jar.has(`auth_${auth.fullId}`));
	});

	test('onAuthorize picks the user without the picker; a throw denies (access_denied)', async () => {
		let allow = true;
		new Auth(unique(), 'auth', {
			emailPassword: false,
			oidcProviders: {
				corp: stubIdp({
					users: [ALICE, BOB],
					onAuthorize: (req) => {
						if (!allow) throw new Error('denied');
						return req.users.find((u) => u.sub === 'u-2');
					},
				}),
			},
		});
		const b = new TestBrowser();
		const start = await b.fetch(`${server.origin}/aws-blocks/auth/signin/corp`);
		const authorized = await b.fetch(location(start, server.origin));
		assert.strictEqual(authorized.status, 302, 'no picker');
		const landing = await b.fetch(location(authorized, server.origin));
		assert.strictEqual(landing.status, 302);

		allow = false;
		const b2 = new TestBrowser();
		const start2 = await b2.fetch(`${server.origin}/aws-blocks/auth/signin/corp`);
		const denied = await b2.fetch(location(start2, server.origin));
		const cb = new URL(location(denied, server.origin));
		assert.strictEqual(cb.searchParams.get('error'), 'access_denied');
		const res = await b2.fetch(cb.toString());
		assert.strictEqual(res.status, 400);
		assert.strictEqual((await res.json()).name, AuthErrors.IdpError);
	});

	test('users.json in .bb-data/<fullId>/ is the directory when no inline users are given', async () => {
		const auth = new Auth(unique(), 'auth', { emailPassword: false, oidcProviders: { corp: stubIdp() } });
		const dir = join('.bb-data', auth.fullId);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, 'users.json'),
			JSON.stringify([{ sub: 'f-1', email: 'f@example.com', name: 'Fixture' }]),
		);
		const b = new TestBrowser();
		const start = await b.fetch(`${server.origin}/aws-blocks/auth/signin/corp`);
		const html = await (await b.fetch(location(start, server.origin))).text();
		assert.match(html, /Fixture/);
		assert.doesNotMatch(html, /Stub corp User/);
	});
});

describe('stub IdP — constant-time binding checks (it can be deployed, so it compares like a real IdP)', () => {
	const CHALLENGE = pkceChallenge('a-verifier-of-reasonable-length-0123456789');

	test('stubValueMatches: equal values match; anything else is a mismatch, never a throw', () => {
		assert.strictEqual(stubValueMatches(CHALLENGE, CHALLENGE), true);
		const sameLength = `${CHALLENGE.slice(0, -1)}${CHALLENGE.endsWith('A') ? 'B' : 'A'}`;
		const candidates: Array<string | null | undefined> = [
			null,
			undefined,
			'',
			sameLength,
			CHALLENGE.slice(0, -1),
			`${CHALLENGE}x`,
			`${CHALLENGE.slice(0, -1)}é`, // same characters, more bytes
		];
		for (const value of candidates) {
			assert.doesNotThrow(() => stubValueMatches(value, CHALLENGE), String(value));
			assert.strictEqual(stubValueMatches(value, CHALLENGE), false, String(value));
		}
		assert.strictEqual(stubValueMatches('', ''), false, 'an empty expected value never matches');
	});

	test('/token and /logout compare the PKCE challenge, client id and redirect URI only through it', () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'engines', 'stub-idp.ts'),
			'utf8',
		);
		for (const field of ['codeChallenge', 'clientId', 'redirectUri']) {
			assert.ok(
				!new RegExp(
					`[!=]==\\s*(?:pending|entry|client)\\.${field}|(?:pending|entry|client)\\.${field}\\s*[!=]==`,
				).test(source),
				`stub-idp.ts compares ${field} directly`,
			);
		}
		assert.ok(!/pkceChallenge\([^)]*\)\s*[!=]==/.test(source), 'the PKCE challenge is compared in constant time');
		assert.match(source, /stubValueMatches\(pkceChallenge\(verifier\), pending\.codeChallenge\)/);
	});

	test('a wrong verifier of the same length, a wrong client id and a wrong redirect URI are refused at /token', async () => {
		makeStubAuth();
		const b = new TestBrowser();
		const start = await b.fetch(`${server.origin}/aws-blocks/auth/signin/corp`);
		const params = new URL(location(start, server.origin)).searchParams;
		const mint = async () => {
			const form = new URLSearchParams(params);
			form.set('sub', 'u-1');
			const submitted = await b.fetch(`${server.origin}/aws-blocks/auth/idp/corp/authorize`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: form.toString(),
			});
			return new URL(location(submitted, server.origin)).searchParams.get('code') ?? '';
		};
		const redeem = async (fields: Record<string, string>) =>
			fetch(`${server.origin}/aws-blocks/auth/idp/corp/token`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'authorization_code',
					client_id: 'stub-client-id',
					redirect_uri: params.get('redirect_uri') ?? '',
					...fields,
				}).toString(),
			});
		// The flow's real verifier lives in the pending cookie; any other value of the same length fails.
		const wrongVerifier = 'w'.repeat(43);
		const pkce = await redeem({ code: await mint(), code_verifier: wrongVerifier });
		assert.strictEqual(pkce.status, 400);
		assert.strictEqual((await pkce.json()).error_description, 'PKCE verification failed');
		const client = await redeem({ code: await mint(), code_verifier: wrongVerifier, client_id: 'stub-client-iD' });
		assert.strictEqual(client.status, 401);
		assert.strictEqual((await client.json()).error, 'invalid_client');
		const redirect = await redeem({
			code: await mint(),
			code_verifier: wrongVerifier,
			redirect_uri: `${params.get('redirect_uri')}x`,
		});
		assert.strictEqual(redirect.status, 400);
		assert.strictEqual((await redirect.json()).error_description, 'redirect_uri mismatch');
	});
});

describe('stub IdP — protocol checks', () => {
	async function authorizeParams(b: TestBrowser) {
		const start = await b.fetch(`${server.origin}/aws-blocks/auth/signin/corp`);
		return new URL(location(start, server.origin)).searchParams;
	}

	test('PKCE S256 is required, and the verifier is really checked at /token', async () => {
		makeStubAuth();
		const b = new TestBrowser();
		const params = await authorizeParams(b);
		const plain = new URLSearchParams(params);
		plain.set('code_challenge_method', 'plain');
		const refused = await b.fetch(`${server.origin}/aws-blocks/auth/idp/corp/authorize?${plain}`);
		assert.strictEqual(refused.status, 400);

		// A code minted for one challenge does not redeem with another verifier.
		const form = new URLSearchParams(params);
		form.set('sub', 'u-1');
		const submitted = await b.fetch(`${server.origin}/aws-blocks/auth/idp/corp/authorize`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: form.toString(),
		});
		const code = new URL(location(submitted, server.origin)).searchParams.get('code') ?? '';
		const token = await fetch(`${server.origin}/aws-blocks/auth/idp/corp/token`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				redirect_uri: params.get('redirect_uri') ?? '',
				client_id: 'stub-client-id',
				code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier',
			}).toString(),
		});
		assert.strictEqual(token.status, 400);
		assert.deepStrictEqual(await token.json(), {
			error: 'invalid_grant',
			error_description: 'PKCE verification failed',
		});
	});

	test('a custom-scheme redirect_uri is refused, as real IdPs do (forces native apps onto the relay)', async () => {
		makeStubAuth();
		const b = new TestBrowser();
		const params = await authorizeParams(b);
		params.set('redirect_uri', 'myapp://callback');
		const res = await b.fetch(`${server.origin}/aws-blocks/auth/idp/corp/authorize?${params}`);
		assert.strictEqual(res.status, 400);
		assert.strictEqual((await res.json()).error, 'invalid_request');
	});

	test('discovery, JWKS and userinfo are real', async () => {
		makeStubAuth();
		const issuer = `${server.origin}/aws-blocks/auth/idp/corp`;
		const doc = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json();
		assert.strictEqual(doc.issuer, issuer);
		assert.deepStrictEqual(doc.code_challenge_methods_supported, ['S256']);
		const jwks = await (await fetch(doc.jwks_uri)).json();
		// ES256: a P-256 key derives deterministically from the session secret
		// (an RSA key cannot), so every process serving the stub signs with it.
		assert.strictEqual(jwks.keys[0].alg, 'ES256');
		assert.deepStrictEqual(doc.id_token_signing_alg_values_supported, ['ES256']);
		assert.strictEqual((await fetch(`${issuer}/userinfo`)).status, 401, 'userinfo needs a bearer token');
	});

	/** `GET <issuer>/logout` with these query parameters (no redirect following). */
	function stubLogout(params: Record<string, string>): Promise<Response> {
		const query = new URLSearchParams(params);
		return fetch(`${server.origin}/aws-blocks/auth/idp/corp/logout?${query}`, { redirect: 'manual' });
	}

	test('/logout redirects only to a registered post_logout_redirect_uri (the app origin + its sign-out paths)', async () => {
		new Auth(unique(), 'auth', {
			emailPassword: false,
			oidcProviders: { corp: stubIdp() },
			redirects: { postSignOutPath: '/goodbye' },
		});
		for (const target of [`${server.origin}/goodbye`, `${server.origin}/aws-blocks/auth/signout`]) {
			const res = await stubLogout({ client_id: 'stub-client-id', post_logout_redirect_uri: target });
			assert.strictEqual(res.status, 302, target);
			assert.strictEqual(res.headers.get('location'), target);
		}
	});

	test('/logout refuses an unregistered post_logout_redirect_uri with 400 and no redirect (RP-Initiated Logout §3)', async () => {
		new Auth(unique(), 'auth', {
			emailPassword: false,
			oidcProviders: { corp: stubIdp() },
			redirects: { postSignOutPath: '/goodbye' },
		});
		const port = new URL(server.origin).port;
		for (const target of [
			'https://evil.example.com/',
			'https://evil.example.com/goodbye',
			`${server.origin}/`,
			`${server.origin}/other`,
			`${server.origin}/goodbye/`,
			`${server.origin}/goodbye?next=x`,
			`${server.origin}/goodbye#x`,
			`${server.origin}/\t/goodbye`,
			`${server.origin}//evil.example.com`,
			`http://localhost:${port}/goodbye`,
			`https://127.0.0.1:${port}/goodbye`,
			`http://127.0.0.1:1/goodbye`,
			`http://127.0.0.1:${port}@evil.example.com/goodbye`,
			'/goodbye',
			'javascript:alert(1)',
		]) {
			const res = await stubLogout({ client_id: 'stub-client-id', post_logout_redirect_uri: target });
			assert.strictEqual(res.status, 400, JSON.stringify(target));
			assert.strictEqual(res.headers.get('location'), null, JSON.stringify(target));
			assert.match(await res.text(), /post_logout_redirect_uri/, JSON.stringify(target));
		}
	});

	test('/logout: a client_id other than the stub client is refused; no target is the signed-out page', async () => {
		makeStubAuth();
		const wrongClient = await stubLogout({
			client_id: 'someone-else',
			post_logout_redirect_uri: `${server.origin}/`,
		});
		assert.strictEqual(wrongClient.status, 400);
		assert.strictEqual(wrongClient.headers.get('location'), null);

		const page = await stubLogout({});
		assert.strictEqual(page.status, 200);
		assert.match(await page.text(), /Signed out of the AWS Blocks stub IdP/);
	});
});

describe('stub IdP — /authorize accepts only the registered client and redirect URI (RFC 6749 §4.1.2.1)', () => {
	const CALLBACK = () => `${server.origin}/aws-blocks/auth/callback`;
	const AUTHORIZE = () => `${server.origin}/aws-blocks/auth/idp/corp/authorize`;

	/** A complete, valid authorize request for the stub client, with `overrides`. */
	function authorizeQuery(overrides: Record<string, string> = {}): URLSearchParams {
		return new URLSearchParams({
			response_type: 'code',
			client_id: 'stub-client-id',
			redirect_uri: CALLBACK(),
			scope: 'openid email profile',
			state: 'st-1',
			nonce: 'n-1',
			code_challenge: pkceChallenge('v'.repeat(43)),
			code_challenge_method: 'S256',
			...overrides,
		});
	}
	const getAuthorize = (q: URLSearchParams) => fetch(`${AUTHORIZE()}?${q}`, { redirect: 'manual' });
	const submitPicker = (q: URLSearchParams) => {
		const form = new URLSearchParams(q);
		form.set('sub', 'u-1');
		return fetch(AUTHORIZE(), {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: form.toString(),
			redirect: 'manual',
		});
	};
	/** A `400` error page: no `Location`, no account picker, the reason in the body. */
	async function assertRefused(res: Response, reason: RegExp, what: string): Promise<void> {
		assert.strictEqual(res.status, 400, what);
		assert.strictEqual(res.headers.get('location'), null, `${what}: never a redirect`);
		const body = await res.text();
		assert.doesNotMatch(body, /<form/, `${what}: no account picker`);
		assert.match(body, reason, what);
	}

	const FOREIGN_REDIRECTS = () => {
		const port = new URL(server.origin).port;
		return [
			'https://evil.example/land',
			'https://evil.example/aws-blocks/auth/callback',
			`${server.origin}/`,
			`${server.origin}/app/callback`,
			`${server.origin}/aws-blocks/auth/callback/`,
			`${server.origin}/aws-blocks/auth/callback?next=x`,
			`${server.origin}/aws-blocks/auth/callbackx`,
			`${server.origin}/aws-blocks/auth/signout`,
			`http://127.0.0.1:1/aws-blocks/auth/callback`,
			`https://localhost:${port}/aws-blocks/auth/callback`,
			`http://localhost:${port}@evil.example/aws-blocks/auth/callback`,
		];
	};

	test('a foreign client_id is a 400 error page: no picker, no redirect (GET and the picker submit)', async () => {
		makeStubAuth();
		for (const clientId of ['anything', 'stub-client-iD', 'stub-client-id ']) {
			const q = authorizeQuery({ client_id: clientId });
			await assertRefused(await getAuthorize(q), /unknown client_id/, `GET client_id=${clientId}`);
			await assertRefused(await submitPicker(q), /unknown client_id/, `POST client_id=${clientId}`);
		}
	});

	test('a foreign redirect_uri without onAuthorize: 400 before the picker renders, and the submit never redirects', async () => {
		makeStubAuth();
		for (const target of FOREIGN_REDIRECTS()) {
			const q = authorizeQuery({ redirect_uri: target });
			await assertRefused(await getAuthorize(q), /redirect_uri/, `GET ${target}`);
			await assertRefused(await submitPicker(q), /redirect_uri/, `POST ${target}`);
		}
	});

	test('a foreign redirect_uri with onAuthorize: 400, and onAuthorize is never asked', async () => {
		let asked = 0;
		new Auth(unique(), 'auth', {
			emailPassword: false,
			oidcProviders: {
				corp: stubIdp({
					users: [ALICE],
					onAuthorize: (r) => {
						asked++;
						return r.users[0];
					},
				}),
			},
		});
		for (const target of FOREIGN_REDIRECTS()) {
			await assertRefused(await getAuthorize(authorizeQuery({ redirect_uri: target })), /redirect_uri/, target);
		}
		// The reviewer's repro, verbatim: any client_id, an attacker's redirect_uri.
		const repro = await fetch(
			`${AUTHORIZE()}?client_id=anything&redirect_uri=https://evil.example/land&response_type=code&code_challenge=abc&code_challenge_method=S256`,
			{ redirect: 'manual' },
		);
		await assertRefused(repro, /client_id/, 'the reported repro');
		assert.strictEqual(asked, 0, 'onAuthorize never sees an unvalidated request');
	});

	test('onAuthorize throwing: access_denied goes only to a registered redirect_uri, a foreign one is a 400', async () => {
		new Auth(unique(), 'auth', {
			emailPassword: false,
			oidcProviders: {
				corp: stubIdp({
					onAuthorize: () => {
						throw new Error('no');
					},
				}),
			},
		});
		for (const target of FOREIGN_REDIRECTS()) {
			await assertRefused(await getAuthorize(authorizeQuery({ redirect_uri: target })), /redirect_uri/, target);
		}
		await assertRefused(
			await getAuthorize(authorizeQuery({ client_id: 'anything' })),
			/unknown client_id/,
			'foreign client',
		);
		const denied = await getAuthorize(authorizeQuery());
		assert.strictEqual(denied.status, 302);
		const back = new URL(location(denied, server.origin));
		assert.strictEqual(`${back.origin}${back.pathname}`, CALLBACK());
		assert.strictEqual(back.searchParams.get('error'), 'access_denied');
		assert.strictEqual(back.searchParams.get('state'), 'st-1');
	});

	test('the legitimate flow still works: the app callback gets the code (onAuthorize, and the picker)', async () => {
		new Auth(unique(), 'auth', {
			emailPassword: false,
			oidcProviders: { corp: stubIdp({ users: [ALICE, BOB], onAuthorize: (r) => r.users[1] }) },
		});
		const direct = await getAuthorize(authorizeQuery());
		assert.strictEqual(direct.status, 302);
		const landed = new URL(location(direct, server.origin));
		assert.strictEqual(`${landed.origin}${landed.pathname}`, CALLBACK());
		assert.ok(landed.searchParams.get('code'));
		assert.strictEqual(landed.searchParams.get('state'), 'st-1');

		clearRouteRegistry();
		makeStubAuth();
		const picker = await getAuthorize(authorizeQuery());
		assert.strictEqual(picker.status, 200);
		assert.match(await picker.text(), /<form method="POST"/);
		const submitted = await submitPicker(authorizeQuery());
		assert.strictEqual(submitted.status, 302);
		const back = new URL(location(submitted, server.origin));
		assert.strictEqual(`${back.origin}${back.pathname}`, CALLBACK());
		assert.ok(back.searchParams.get('code'));
	});

	test('the registered redirect URI follows redirects.callbackPath (the default path is then refused)', async () => {
		new Auth(unique(), 'auth', {
			emailPassword: false,
			oidcProviders: { corp: stubIdp({ onAuthorize: (r) => r.users[0] }) },
			redirects: { callbackPath: '/aws-blocks/auth/extras/callback' },
		});
		const custom = `${server.origin}/aws-blocks/auth/extras/callback`;
		const ok = await getAuthorize(authorizeQuery({ redirect_uri: custom }));
		assert.strictEqual(ok.status, 302);
		assert.ok(location(ok, server.origin).startsWith(`${custom}?code=`));
		const refused = await getAuthorize(authorizeQuery());
		await assertRefused(refused, /extras\/callback/, 'the default callback is not registered here');
	});
});

describe('relay + browser PKCE through the stub (the native / SPA transports)', () => {
	test('relay: authorize-params → stub → callback 302 to relayTo → /exchange (+ bearer) → /refresh', async () => {
		const auth = new Auth(unique(), 'auth', {
			emailPassword: false,
			allowBearerAuth: true,
			oidcProviders: { corp: stubIdp({ users: [ALICE], onAuthorize: (r) => r.users[0] }) },
		});
		const csrf = 'c'.repeat(40);
		const relayTo = 'http://127.0.0.1:53682/callback';
		const paramsRes = await fetch(`${server.origin}/aws-blocks/auth/authorize-params/corp`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ csrf, relayTo }),
		});
		assert.strictEqual(paramsRes.status, 200);
		const params = await paramsRes.json();
		assert.strictEqual(params.kind, 'stub');
		assert.strictEqual(params.clientId, 'stub-client-id');
		assert.ok(params.state && params.nonce);
		// What Kotlin's verifyCsrf does: base64url-decode the part before the first '.'.
		assert.strictEqual(JSON.parse(Buffer.from(params.state.split('.')[0], 'base64url').toString()).csrf, csrf);

		// The SDK builds the authorize URL itself, redirect_uri = the backend's HTTPS callback.
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
		assert.strictEqual(relayed.status, 302, 'the callback relays');
		const back = new URL(location(relayed, server.origin));
		assert.strictEqual(`${back.origin}${back.pathname}`, relayTo);
		assert.strictEqual(back.searchParams.get('state'), params.state);
		const code = back.searchParams.get('code') ?? '';

		const b = new TestBrowser();
		const exchanged = await b.fetch(`${server.origin}/aws-blocks/auth/exchange`, {
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
		assert.strictEqual(body.user.username, 'Alice');
		assert.ok(body.user.userId.endsWith(':u-1'));
		assert.ok(body.accessToken && body.refreshToken && body.expiresIn > 0, 'bearer tokens with allowBearerAuth');
		assert.ok(b.jar.has(`auth_${auth.fullId}`), 'the exchange also issues the session cookie');

		// Swift/Dart refresh: `{ refreshToken }` only, at `<exchange>/refresh`.
		const refreshed = await fetch(`${server.origin}/aws-blocks/auth/exchange/refresh`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ refreshToken: body.refreshToken }),
		});
		assert.strictEqual(refreshed.status, 200);
		const tokens = await refreshed.json();
		assert.ok(tokens.accessToken && tokens.refreshToken && tokens.refreshToken !== body.refreshToken);
		// AuthOIDC's path with `provider`; the rotated-away token is refused.
		const stale = await fetch(`${server.origin}/aws-blocks/auth/refresh`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ refreshToken: body.refreshToken, provider: 'corp' }),
		});
		assert.strictEqual(stale.status, 401);
		assert.strictEqual((await stale.json()).name, AuthErrors.TokenExpired);
	});

	test('browser PKCE: GET authorize-params → client PKCE → stub → POST /exchange (no tokens without allowBearerAuth)', async () => {
		const auth = new Auth(unique(), 'auth', {
			emailPassword: false,
			oidcProviders: { corp: stubIdp({ users: [BOB], onAuthorize: (r) => r.users[0] }) },
		});
		const params = await (await fetch(`${server.origin}/aws-blocks/auth/authorize-params/corp`)).json();
		assert.deepStrictEqual(Object.keys(params).sort(), ['authorizeUrl', 'clientId', 'kind', 'scopes']);
		const verifier = 'spa-verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
		// The stub's registered redirect URI (the app's own callback), as an SPA
		// registers its callback with a real IdP; any other is refused at /authorize.
		const spaCallback = `${server.origin}/aws-blocks/auth/callback`;
		const authorize = new URL(params.authorizeUrl);
		for (const [k, v] of Object.entries({
			response_type: 'code',
			client_id: params.clientId,
			redirect_uri: spaCallback,
			scope: params.scopes.join(' '),
			state: 'spa-state',
			nonce: 'spa-nonce',
			code_challenge: pkceChallenge(verifier),
			code_challenge_method: 'S256',
		})) {
			authorize.searchParams.set(k, v);
		}
		const code = new URL(location(await fetch(authorize, { redirect: 'manual' }), server.origin)).searchParams.get(
			'code',
		);
		const b = new TestBrowser();
		const res = await b.fetch(`${server.origin}/aws-blocks/auth/exchange`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				code,
				verifier,
				state: 'spa-state',
				nonce: 'spa-nonce',
				provider: 'corp',
				callbackUrl: spaCallback,
			}),
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.deepStrictEqual(Object.keys(body), ['user'], 'no tokens without allowBearerAuth');
		assert.ok(!('claims' in body.user), 'claims stay server-side: not in the exchange response');
		assert.strictEqual((await auth.requireAuth(b.context(server.origin))).username, 'Bob');

		const wrongNonce = await fetch(`${server.origin}/aws-blocks/auth/exchange`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				code,
				verifier,
				state: 's',
				nonce: 'x',
				provider: 'nope',
				callbackUrl: spaCallback,
			}),
		});
		assert.strictEqual(wrongNonce.status, 400);
		assert.strictEqual((await wrongNonce.json()).name, AuthErrors.ProviderNotConfigured);
	});
});

describe('email + password and a stub IdP on the same Auth (mock)', () => {
	/** Call the RPC namespace for one request from `b`, applying its Set-Cookie lines. */
	async function rpc(b: TestBrowser, api: AuthStateApi, fn: (a: AuthStateApi) => Promise<AuthState>) {
		const ctx = b.context(server.origin);
		try {
			return await fn(bind(api, ctx));
		} finally {
			for (const line of ctx.response.headers.getSetCookie()) {
				const [pair] = line.split(';');
				const eq = pair.indexOf('=');
				const name = pair.slice(0, eq);
				const value = pair.slice(eq + 1);
				if (/Max-Age=0(?:;|$)/.test(line) || value === '') b.jar.delete(name);
				else b.jar.set(name, value);
			}
		}
	}

	test('a password user and a stub-IdP user both reach requireAuth; each signOut behaves correctly', async () => {
		const codes: string[] = [];
		const auth = new Auth(unique(), 'auth', {
			codeDelivery: async (_username, code) => {
				codes.push(code);
			},
			oidcProviders: { corp: stubIdp({ users: [ALICE, BOB] }) },
			redirects: { postSignOutPath: '/goodbye' },
		});
		const api = auth.createApi();

		const signedOut = await rpc(new TestBrowser(), api, (a) => a.getAuthState());
		const names = signedOut.actions.map((a) => a.name);
		assert.ok(names.includes('signIn') && names.includes('signUp') && names.includes('signIn:corp'), names.join());

		// ── The password user: sign-up → code → confirm → auto sign-in ──
		const pw = new TestBrowser();
		const up = await rpc(pw, api, (a) =>
			a.setAuthState({
				action: 'signUp',
				username: 'pat',
				password: 'Correct-Horse-9',
				email: 'pat@example.com',
			}),
		);
		assert.strictEqual(up.state, 'confirmingSignUp');
		const code = codes.at(-1) ?? '';
		const confirmed = await rpc(pw, api, (a) => a.setAuthState({ action: 'confirmSignUp', username: 'pat', code }));
		assert.ok(confirmed.actions.some((x) => x.name === 'autoSignIn'));
		const inState = await rpc(pw, api, (a) => a.setAuthState({ action: 'autoSignIn', username: 'pat' }));
		assert.strictEqual(inState.state, 'signedIn');

		// ── The stub-IdP user, through the routes ──
		const fed = new TestBrowser();
		const landing = await signInThroughPicker(fed, 'u-1');
		assert.strictEqual(landing.status, 302);

		const pwUser = await auth.requireAuth(pw.context(server.origin));
		assert.strictEqual(pwUser.username, 'pat');
		assert.strictEqual(pwUser.signInProvider, 'password');
		assert.strictEqual(pwUser.claims, undefined, 'a user-pool user has no claims (RLS keeps seeing userId)');
		const fedUser = await auth.requireAuth(fed.context(server.origin));
		assert.strictEqual(fedUser.signInProvider, 'corp');
		assert.strictEqual(fedUser.claims?.sub, 'u-1');
		assert.strictEqual(fedUser.userId, `${server.origin}/aws-blocks/auth/idp/corp:u-1`);

		// A password session signs out over RPC (no url); a federated one through the route.
		const pwState = await rpc(pw, api, (a) => a.getAuthState());
		assert.strictEqual(pwState.actions.find((x) => x.name === 'signOut')?.url, undefined);
		const fedState = await rpc(fed, api, (a) => a.getAuthState());
		assert.strictEqual(fedState.actions.find((x) => x.name === 'signOut')?.url, '/aws-blocks/auth/signout');

		const pwOut = await rpc(pw, api, (a) => a.setAuthState({ action: 'signOut' }));
		assert.strictEqual(pwOut.state, 'signedOut');
		await assert.rejects(auth.requireAuth(pw.context(server.origin)), { status: 401 });
		assert.strictEqual(
			(await auth.requireAuth(fed.context(server.origin))).userId,
			fedUser.userId,
			'signing the password user out leaves the federated session alone',
		);

		const out = await fed.fetch(`${server.origin}/aws-blocks/auth/signout`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: '',
		});
		assert.strictEqual(out.status, 303);
		const logout = new URL(location(out, server.origin));
		assert.strictEqual(logout.searchParams.get('post_logout_redirect_uri'), `${server.origin}/goodbye`);
		const back = await fed.fetch(logout.toString());
		assert.strictEqual(back.headers.get('location'), `${server.origin}/goodbye`, 'postSignOutPath');
		await assert.rejects(auth.requireAuth(fed.context(server.origin)), { status: 401 });

		// Signing out with no session still lands on postSignOutPath.
		const again = await fed.fetch(`${server.origin}/aws-blocks/auth/signout`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: '',
		});
		assert.strictEqual(again.status, 303);
		assert.strictEqual(again.headers.get('location'), '/goodbye');
	});

	test('redirects.postSignOutPath must be a same-origin path', () => {
		assert.throws(
			() =>
				new Auth(unique(), 'auth', {
					emailPassword: false,
					oidcProviders: { corp: stubIdp() },
					redirects: { postSignOutPath: 'https://evil.example.com' },
				}),
			/postSignOutPath must be an absolute path/,
		);
	});

	test('redirects.postSignInPath / postSignOutPath: anything a browser could resolve off-origin is refused', () => {
		for (const key of ['postSignInPath', 'postSignOutPath'] as const) {
			for (const bad of [
				'https://evil.example.com',
				'//evil.example.com',
				'/\t/evil.example.com',
				'/\n/evil.example.com',
				'/\\evil.example.com',
				'/.//evil.example.com',
				'javascript:alert(1)',
				'home',
			]) {
				clearRouteRegistry();
				assert.throws(
					() =>
						new Auth(unique(), 'auth', {
							emailPassword: false,
							oidcProviders: { corp: stubIdp() },
							redirects: { [key]: bad },
						}),
					new RegExp(`redirects\\.${key} must be an absolute path`),
					`${key}: ${JSON.stringify(bad)}`,
				);
			}
		}
	});

	test('postSignInPath / postSignOutPath are emitted re-serialised', async () => {
		new Auth(unique(), 'auth', {
			emailPassword: false,
			oidcProviders: { corp: stubIdp({ users: [ALICE, BOB] }) },
			redirects: { postSignInPath: '/welcome page?x=1#top', postSignOutPath: '/bye now' },
		});
		const landing = await signInThroughPicker(new TestBrowser(), 'u-1');
		assert.strictEqual(landing.headers.get('location'), '/welcome%20page?x=1#top');
		const out = await fetch(`${server.origin}/aws-blocks/auth/signout`, { redirect: 'manual' });
		assert.strictEqual(out.status, 302);
		assert.strictEqual(out.headers.get('location'), '/bye%20now');
	});
});
