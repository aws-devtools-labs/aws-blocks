// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The federation route layer: the exact route table (the paths the native
 * SDKs call — no wildcard, no root route), the relay `state` envelope's wire
 * format, every branch of the callback dispatcher with its wire error code,
 * per-provider engine selection (a mixed configuration reaches every
 * provider — the `cognitoFederated()` bug), and the actionable "unavailable"
 * answers for hosted-UI providers locally and stub providers deployed.
 */

import assert from 'node:assert';
import { createHmac } from 'node:crypto';
import { rmSync } from 'node:fs';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import type { AuthState } from '@aws-blocks/auth-common';
import { ApiError, clearRouteRegistry, getRegisteredRoutes } from '@aws-blocks/core';
import { getMockDataDir } from '@aws-blocks/core/bb-utils';
import { AuthErrors } from './errors.js';
import { Auth, github, relayOrigin, stubIdp } from './index.mock.js';
import { validateRelay } from './relay.js';
import { readMockSessionSecret } from './sessions.js';
import { decodeState, encodeState, relayStateKey } from './state-envelope.js';
import { FakeIdp } from './test-support/fake-idp.js';
import { location, type RouteServer, startRouteServer, TestBrowser } from './test-support/route-server.js';
import { encodeTriggerRejection } from './trigger-rejection.js';
import type { AppSettingRef, AuthOptions } from './types.js';

const secret: AppSettingRef = { fullId: 'provider-secret', get: async () => 's3cret' };
let counter = 0;
const unique = () => ({ id: `routes${process.pid}x${++counter}` });

let server: RouteServer;
const idp = new FakeIdp();
before(async () => {
	server = await startRouteServer();
	await idp.start();
});
after(async () => {
	await server.close();
	await idp.close();
});
beforeEach(() => {
	clearRouteRegistry();
	rmSync('.bb-data', { recursive: true, force: true });
});
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

/** Every configured kind of provider at once. */
function mixed(): AuthOptions {
	return {
		emailPassword: false,
		allowBearerAuth: true,
		socialProviders: { google: { clientId: 'g', clientSecret: secret } },
		oidcProviders: {
			corp: stubIdp(),
			okta: { issuer: idp.issuer, clientId: 'okta-client' },
			gh: github({ clientId: 'gh-client', clientSecret: secret }),
			entra: { issuer: 'https://login.example.com', clientId: 'e', clientSecret: secret, federateVia: 'cognito' },
			'my idp': { issuer: idp.issuer, clientId: 'okta-client' },
		},
		samlProviders: { acme: { metadataUrl: 'https://acme.example.com/metadata.xml' } },
	};
}

const table = () =>
	getRegisteredRoutes()
		.map((r) => `${r.method} ${r.path}`)
		.sort();

describe('route table', () => {
	test('mock: exactly the AuthOIDC paths per provider, plus the stub IdP; no wildcard, no root', () => {
		new Auth(unique(), 'auth', mixed());
		const perProvider = (id: string) => [
			`GET /aws-blocks/auth/signin/${id}`,
			`GET /aws-blocks/auth/authorize-params/${id}`,
			`POST /aws-blocks/auth/authorize-params/${id}`,
		];
		const stub = [
			'GET /aws-blocks/auth/idp/corp/.well-known/openid-configuration',
			'GET /aws-blocks/auth/idp/corp/jwks.json',
			'GET /aws-blocks/auth/idp/corp/authorize',
			'POST /aws-blocks/auth/idp/corp/authorize',
			'POST /aws-blocks/auth/idp/corp/token',
			'GET /aws-blocks/auth/idp/corp/userinfo',
			'POST /aws-blocks/auth/idp/corp/revoke',
			'GET /aws-blocks/auth/idp/corp/logout',
		];
		const expected = [
			'GET /aws-blocks/auth/callback',
			'POST /aws-blocks/auth/signout',
			// The sign-out landing: Cognito's /logout returns here with a GET (D6b).
			'GET /aws-blocks/auth/signout',
			'POST /aws-blocks/auth/exchange',
			'POST /aws-blocks/auth/refresh',
			'POST /aws-blocks/auth/exchange/refresh',
			...['google', 'corp', 'okta', 'gh', 'entra', 'my%20idp', 'acme'].flatMap(perProvider),
			...stub,
		].sort();
		assert.deepStrictEqual(table(), expected);
		for (const r of getRegisteredRoutes()) {
			assert.ok(!r.path.includes('*') && !r.path.includes('{'), `no wildcard or path parameter: ${r.path}`);
			assert.notStrictEqual(r.path, '/');
			assert.ok(r.path.startsWith('/aws-blocks/auth/'), r.path);
		}
	});

	test('aws-runtime: the same table without the stub IdP', async () => {
		const { Auth: AwsAuth } = await import('./index.aws.js');
		new AwsAuth(unique(), 'auth', mixed());
		const paths = table();
		assert.ok(!paths.some((p) => p.includes('/aws-blocks/auth/idp/')), 'no stub routes when deployed');
		assert.ok(paths.includes('GET /aws-blocks/auth/signin/corp'), 'the stub provider still answers (with a 501)');
		assert.ok(paths.includes('GET /aws-blocks/auth/callback'));
	});

	test('refresh routes only with allowBearerAuth; no routes at all without a provider', () => {
		new Auth(unique(), 'auth', { emailPassword: false, oidcProviders: { corp: stubIdp() } });
		assert.ok(!table().some((p) => p.endsWith('/refresh')));
		clearRouteRegistry();
		new Auth(unique(), 'auth');
		assert.deepStrictEqual(table(), []);
	});

	test('a custom callbackPath moves the whole flow; a path outside /aws-blocks/auth/ is refused', () => {
		new Auth(unique(), 'auth', {
			emailPassword: false,
			oidcProviders: { corp: stubIdp() },
			redirects: { callbackPath: '/aws-blocks/auth/real/callback', signOutPath: '/aws-blocks/auth/real/signout' },
		});
		const paths = table();
		for (const p of [
			'GET /aws-blocks/auth/real/callback',
			'GET /aws-blocks/auth/real/signin/corp',
			'POST /aws-blocks/auth/real/exchange',
			'POST /aws-blocks/auth/real/authorize-params/corp',
			'POST /aws-blocks/auth/real/signout',
			'GET /aws-blocks/auth/real/signout',
		]) {
			assert.ok(paths.includes(p), p);
		}
		clearRouteRegistry();
		assert.throws(
			() =>
				new Auth(unique(), 'auth', {
					emailPassword: false,
					oidcProviders: { corp: stubIdp() },
					redirects: { callbackPath: '/auth/callback' },
				}),
			/must be a path under '\/aws-blocks\/auth\/'/,
		);
	});
});

describe('relay state envelope — the native SDKs’ wire format', () => {
	test('base64url(JSON {v,csrf,relay,app}) + "." + base64url(HMAC-SHA256(body)), byte for byte', () => {
		const key = 'k';
		const payload = { v: 1, csrf: 'c'.repeat(32), relay: 'myapp://auth/cb', app: 'xyz' } as const;
		const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
		const sig = createHmac('sha256', key).update(body).digest('base64url');
		assert.strictEqual(encodeState(payload, key), `${body}.${sig}`);
		// Optional fields are dropped, never serialized as null.
		assert.strictEqual(
			encodeState({ v: 1, csrf: 'c'.repeat(32) }, key).split('.')[0],
			Buffer.from(JSON.stringify({ v: 1, csrf: 'c'.repeat(32) })).toString('base64url'),
		);
		// What Swift/Kotlin/Dart do: split at the first '.', decode the body, read csrf.
		const decodedByNative = JSON.parse(
			Buffer.from(encodeState(payload, key).split('.')[0], 'base64url').toString(),
		);
		assert.deepStrictEqual(Object.keys(decodedByNative), ['v', 'csrf', 'relay', 'app']);
		assert.deepStrictEqual(decodeState(encodeState(payload, key), key), { ok: true, payload });
	});

	test('decode reasons: signature, version, malformed', () => {
		const key = 'k';
		const good = encodeState({ v: 1, csrf: 'c'.repeat(32) }, key);
		assert.deepStrictEqual(decodeState(good, 'other'), { ok: false, reason: 'signature' });
		const v2body = Buffer.from(JSON.stringify({ v: 2, csrf: 'x' })).toString('base64url');
		const v2 = `${v2body}.${createHmac('sha256', key).update(v2body).digest('base64url')}`;
		assert.deepStrictEqual(decodeState(v2, key), { ok: false, reason: 'version' });
		assert.deepStrictEqual(decodeState('plain-random-state', key), { ok: false, reason: 'malformed' });
	});

	test('relay validation (AuthOIDC’s rules and reasons)', () => {
		const allowList = [relayOrigin('myapp://auth')];
		const same = new URL('https://api.example.com/aws-blocks/auth/authorize-params/x');
		const v = (uri: string) => validateRelay(uri, { allowList, sameOrigin: same });
		assert.deepStrictEqual(v('http://127.0.0.1:5000/cb'), { allowed: true });
		assert.deepStrictEqual(v('http://[::1]:5000/cb'), { allowed: true });
		assert.deepStrictEqual(v('https://api.example.com/done'), { allowed: true });
		assert.deepStrictEqual(v('myapp://auth/callback'), { allowed: true });
		assert.deepStrictEqual(v('otherapp://auth'), { allowed: false, reason: 'unknown-origin' });
		assert.deepStrictEqual(v('http://evil.example.com'), { allowed: false, reason: 'plaintext-non-loopback' });
		assert.deepStrictEqual(v('not a uri'), { allowed: false, reason: 'malformed' });
		assert.throws(() => relayOrigin('myapp://auth/callback'), /path components are not allowed/);
		assert.throws(() => relayOrigin('http://localhost:3000'), /'localhost' is not allowed/);
	});
});

describe('callback dispatch — each transport and wire error code', () => {
	function stubAuth(extra: Partial<AuthOptions> = {}) {
		const auth = new Auth(unique(), 'auth', {
			emailPassword: false,
			oidcProviders: { corp: stubIdp() },
			redirects: { allowedRelayOrigins: [relayOrigin('myapp://auth')] },
			...extra,
		});
		const key = relayStateKey(readMockSessionSecret(getMockDataDir(auth)));
		return { auth, key };
	}

	async function callback(query: Record<string, string>) {
		const res = await fetch(`${server.origin}/aws-blocks/auth/callback?${new URLSearchParams(query)}`, {
			redirect: 'manual',
		});
		return res;
	}

	async function errorBody(res: Response) {
		assert.strictEqual(res.status, 400);
		return res.json();
	}

	test('relay: 302 to relayTo with code, state and iss', async () => {
		const { key } = stubAuth();
		const state = encodeState({ v: 1, csrf: 'c'.repeat(32), relay: 'myapp://auth/cb' }, key);
		const res = await callback({ code: 'the-code', state, iss: 'https://idp' });
		assert.strictEqual(res.status, 302);
		const to = new URL(res.headers.get('location') ?? '');
		assert.strictEqual(`${to.protocol}//${to.host}${to.pathname}`, 'myapp://auth/cb');
		assert.deepStrictEqual(Object.fromEntries(to.searchParams), { code: 'the-code', state, iss: 'https://idp' });
	});

	test('a stale pending cookie in the same browser does not break a relay', async () => {
		const { auth, key } = stubAuth();
		const state = encodeState({ v: 1, csrf: 'c'.repeat(32), relay: 'myapp://auth/cb' }, key);
		const res = await fetch(
			`${server.origin}/aws-blocks/auth/callback?${new URLSearchParams({ code: 'k', state })}`,
			{
				redirect: 'manual',
				headers: { cookie: `authpending_${auth.fullId}=v1.stale.cookie` },
			},
		);
		assert.strictEqual(res.status, 302);
		assert.ok((res.headers.get('location') ?? '').startsWith('myapp://auth/cb?'));
	});

	test('POST /exchange accepts JSON only (no cross-site form can reach it: login CSRF)', async () => {
		stubAuth();
		const res = await fetch(`${server.origin}/aws-blocks/auth/exchange`, {
			method: 'POST',
			headers: { 'content-type': 'text/plain' },
			body: JSON.stringify({
				code: 'c',
				verifier: 'v',
				state: 's',
				provider: 'corp',
				callbackUrl: 'https://x/cb',
			}),
		});
		assert.strictEqual(res.status, 415);
	});

	test('relay-error: an IdP error is forwarded to the app, not swallowed', async () => {
		const { key } = stubAuth();
		const state = encodeState({ v: 1, csrf: 'c'.repeat(32), relay: 'http://127.0.0.1:4000/cb' }, key);
		const res = await callback({ error: 'access_denied', error_description: 'user said no', state });
		assert.strictEqual(res.status, 302);
		const to = new URL(location(res, server.origin));
		assert.strictEqual(to.searchParams.get('error'), 'access_denied');
		assert.strictEqual(to.searchParams.get('error_description'), 'user said no');
		assert.strictEqual(to.searchParams.get('state'), state);
		// FX60: the pass-through is the OAuth error response handed back to the
		// native / CLI app that started the sign-in (the relay target the state
		// envelope was signed with), never something a browser renders — the 302
		// body is empty, so the only thing carrying the text is the Location.
		assert.strictEqual(await res.text(), '', 'nothing is rendered to the browser that followed the redirect');
	});

	test('R2-2: a crafted error callback during a pending sign-in is invalid_state, never the attacker’s error', async () => {
		stubAuth();
		const forged = encodeTriggerRejection(
			new ApiError('Your account is suspended. Call +1-555-0100.', 451, { name: 'AccountSuspended' }),
		);
		const extras: Record<string, string>[] = [{}, { state: '' }, { state: 'attacker-chosen' }];
		for (const extra of extras) {
			// The victim's browser holds a pending sign-in …
			const browser = new TestBrowser();
			assert.strictEqual((await browser.fetch(`${server.origin}/aws-blocks/auth/signin/corp`)).status, 302);
			// … and follows the attacker's link.
			const query = new URLSearchParams({
				error: 'access_denied',
				error_description: `PreSignUp failed with error ${forged}.`,
				...extra,
			});
			const res = await browser.fetch(`${server.origin}/aws-blocks/auth/callback?${query}`);
			const body = await errorBody(res);
			assert.strictEqual(body.name, AuthErrors.InvalidState, JSON.stringify(extra));
			assert.ok(!JSON.stringify(body).includes('+1-555'), 'no attacker text');
			assert.ok(!JSON.stringify(body).includes('AccountSuspended'));
		}
	});

	test('invalid_state: missing, not an envelope, or a bad signature', async () => {
		const { key } = stubAuth();
		const queries: Record<string, string>[] = [
			{ code: 'c' },
			{ code: 'c', state: 'random-idp-state' },
			{ code: 'c', state: encodeState({ v: 1, csrf: 'c'.repeat(32), relay: 'myapp://auth' }, `${key}-other`) },
		];
		for (const query of queries) {
			const body = await errorBody(await callback(query));
			assert.strictEqual(body.error, 'invalid_state');
			assert.strictEqual(body.name, AuthErrors.InvalidState);
			assert.ok(typeof body.message === 'string' && body.message.length > 0);
		}
	});

	test('sdk_outdated: a signed envelope of an unknown version', async () => {
		const { key } = stubAuth();
		const v2body = Buffer.from(JSON.stringify({ v: 2, csrf: 'x' })).toString('base64url');
		const state = `${v2body}.${createHmac('sha256', key).update(v2body).digest('base64url')}`;
		const body = await errorBody(await callback({ code: 'c', state }));
		assert.deepStrictEqual([body.error, body.name], ['sdk_outdated', AuthErrors.SdkOutdated]);
	});

	test('invalid_relay: the relay target is no longer allowed', async () => {
		const { key } = stubAuth({ redirects: { allowedRelayOrigins: [] } });
		const state = encodeState({ v: 1, csrf: 'c'.repeat(32), relay: 'myapp://auth/cb' }, key);
		const body = await errorBody(await callback({ code: 'c', state }));
		assert.deepStrictEqual([body.error, body.name], ['invalid_relay', AuthErrors.InvalidRelay]);
	});

	test('invalid_callback: a relay with no code', async () => {
		const { key } = stubAuth();
		const state = encodeState({ v: 1, csrf: 'c'.repeat(32), relay: 'myapp://auth/cb' }, key);
		const body = await errorBody(await callback({ state }));
		assert.deepStrictEqual([body.error, body.name], ['invalid_callback', AuthErrors.InvalidCallback]);
	});

	test('server-exchange without its pending cookie: InvalidCallback, never a 500', async () => {
		const { key } = stubAuth();
		const state = encodeState({ v: 1, csrf: 'c'.repeat(32) }, key);
		const res = await callback({ code: 'c', state });
		const body = await errorBody(res);
		assert.strictEqual(body.name, AuthErrors.InvalidCallback);
	});

	test('authorize-params POST: csrf and relayTo are validated (invalid_relay body shape)', async () => {
		stubAuth();
		const post = (body: unknown) =>
			fetch(`${server.origin}/aws-blocks/auth/authorize-params/corp`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
		assert.strictEqual((await post({ csrf: 'short' })).status, 400);
		const bad = await post({ csrf: 'c'.repeat(32), relayTo: 'otherapp://x' });
		assert.strictEqual(bad.status, 400);
		assert.deepStrictEqual(await bad.json(), {
			error: 'invalid_relay',
			reason: 'unknown-origin',
			allowedOrigins: ['myapp://auth'],
		});
		const ok = await post({ csrf: 'c'.repeat(32), relayTo: 'myapp://auth/cb', appState: 'app-1' });
		assert.strictEqual(ok.status, 200);
		const body = await ok.json();
		assert.deepStrictEqual(Object.keys(body).sort(), [
			'authorizeUrl',
			'clientId',
			'kind',
			'nonce',
			'scopes',
			'state',
		]);
		assert.deepStrictEqual(JSON.parse(Buffer.from(body.state.split('.')[0], 'base64url').toString()), {
			v: 1,
			csrf: 'c'.repeat(32),
			relay: 'myapp://auth/cb',
			app: 'app-1',
		});
	});
});

describe('per-provider engines — a mixed configuration reaches every provider', () => {
	test('mock: direct, stub and OAuth 2.0 redirect to their IdPs; hosted-UI ones answer 501 "unavailable locally"', async () => {
		new Auth(unique(), 'auth', mixed());
		const signIn = (id: string) =>
			fetch(`${server.origin}/aws-blocks/auth/signin/${encodeURIComponent(id)}`, { redirect: 'manual' });

		const okta = await signIn('okta');
		assert.strictEqual(okta.status, 302);
		assert.ok(location(okta, server.origin).startsWith(`${idp.issuer}/authorize?`));
		const spaced = await signIn('my idp');
		assert.strictEqual(spaced.status, 302, 'an id needing encoding is reachable too');

		const corp = await signIn('corp');
		assert.strictEqual(corp.status, 302);
		assert.ok(location(corp, server.origin).startsWith(`${server.origin}/aws-blocks/auth/idp/corp/authorize?`));

		const gh = await signIn('gh');
		assert.strictEqual(gh.status, 302);
		const ghUrl = new URL(location(gh, server.origin));
		assert.strictEqual(`${ghUrl.origin}${ghUrl.pathname}`, 'https://github.com/login/oauth/authorize');
		assert.strictEqual(ghUrl.searchParams.get('code_challenge_method'), 'S256');

		for (const id of ['google', 'entra', 'acme']) {
			const res = await signIn(id);
			assert.strictEqual(res.status, 501, `${id}: never a 404`);
			const body = await res.json();
			assert.strictEqual(body.name, AuthErrors.ProviderMisconfigured);
			assert.match(body.error, /unavailable locally/);
			assert.match(body.error, /stubIdp\(\)/);
		}
	});

	test('the sign-in UI lists every provider, each with its own sign-in URL', async () => {
		const auth = new Auth(unique(), 'auth', mixed());
		const api = auth.createApi();
		const target: unknown = api;
		assert.ok(typeof target === 'function');
		const handler: unknown = Reflect.apply(target, undefined, [
			{
				request: {
					headers: new Headers(),
					body: null,
					json: async () => ({}),
					text: async () => '',
					url: new URL(`${server.origin}/aws-blocks/api`),
					params: {},
				},
				response: { headers: new Headers(), status: 200, send: () => {} },
			},
		]);
		assert.ok(typeof handler === 'object' && handler !== null);
		const getAuthState: unknown = Reflect.get(handler, 'getAuthState');
		assert.ok(typeof getAuthState === 'function');
		const state: AuthState = await Reflect.apply(getAuthState, handler, []);
		const urls = Object.fromEntries(state.actions.map((a) => [a.name, a.url ?? null]));
		assert.deepStrictEqual(urls, {
			'signIn:google': '/aws-blocks/auth/signin/google',
			'signIn:corp': '/aws-blocks/auth/signin/corp',
			'signIn:okta': '/aws-blocks/auth/signin/okta',
			'signIn:gh': '/aws-blocks/auth/signin/gh',
			'signIn:entra': '/aws-blocks/auth/signin/entra',
			'signIn:my idp': '/aws-blocks/auth/signin/my%20idp',
			'signIn:acme': '/aws-blocks/auth/signin/acme',
		});
	});

	test('aws-runtime: a deployed stub IdP answers an actionable 501; a hosted-UI provider without its config keys refuses clearly', async () => {
		const { Auth: AwsAuth } = await import('./index.aws.js');
		new AwsAuth(unique(), 'auth', mixed());
		const corp = await fetch(`${server.origin}/aws-blocks/auth/signin/corp`, { redirect: 'manual' });
		assert.strictEqual(corp.status, 501);
		assert.match((await corp.json()).error, /runs only in local development/);
		// The hosted-UI engine (D6b) is wired; with no deployed domain / client it
		// refuses (federation-hosted-ui.test.ts covers the configured flow).
		const google = await fetch(`${server.origin}/aws-blocks/auth/signin/google`, { redirect: 'manual' });
		assert.strictEqual(google.status, 500);
		const body = await google.json();
		assert.strictEqual(body.name, AuthErrors.ProviderMisconfigured);
		assert.match(body.error, /no Cognito managed-login configuration/);
	});

	test('GET on the sign-out path is the sign-out landing: 302 to postSignOutPath, no state change', async () => {
		new Auth(unique(), 'auth', {
			emailPassword: false,
			oidcProviders: { corp: stubIdp() },
			redirects: { postSignOutPath: '/bye' },
		});
		const res = await fetch(`${server.origin}/aws-blocks/auth/signout`, { redirect: 'manual' });
		assert.strictEqual(res.status, 302);
		assert.strictEqual(res.headers.get('location'), '/bye');
		assert.deepStrictEqual(res.headers.getSetCookie(), [], 'no cookie is touched');
	});
});
