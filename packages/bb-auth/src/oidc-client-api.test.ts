// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `createOidcApi().getClient()`, the native SDKs' `oidc/client` transferable,
 * on the mock entry over real HTTP: the descriptor names the routes the block
 * really mounts, and a relay sign-in driven only by the descriptor (what the
 * Swift, Kotlin and Dart SDKs do) reaches a session and signs out.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { type BlocksContext, clearRouteRegistry } from '@aws-cdk-blocks/core';
import { pkceChallenge } from './engines/federation-direct.js';
import { Auth, stubIdp } from './index.mock.js';
import { location, type RouteServer, startRouteServer, TestBrowser } from './test-support/route-server.js';
import type { AppSettingRef, OidcClientDescriptor, OidcClientHandle, StubUser } from './types.js';

const ALICE: StubUser = { sub: 'u-1', email: 'alice@example.com', name: 'Alice' };
const googleSecret: AppSettingRef = { fullId: 'google-secret', get: async () => 'shh' };

let server: RouteServer;
let counter = 0;
const unique = () => ({ id: `oidcapi${process.pid}x${++counter}` });

before(async () => {
	server = await startRouteServer();
});
after(async () => {
	await server.close();
});
beforeEach(() => {
	clearRouteRegistry();
	rmSync('.cdk-blocks/local/data', { recursive: true, force: true });
	rmSync('.bb-data', { recursive: true, force: true });
});
afterEach(() => rmSync('.cdk-blocks/local/data', { recursive: true, force: true }));

/** Call `getClient()` on the namespace `createOidcApi()` returned, as the RPC dispatcher does. */
async function getClient<P extends string>(api: unknown, ctx: BlocksContext): Promise<OidcClientHandle<P>> {
	assert.ok(typeof api === 'function');
	const handler: unknown = Reflect.apply(api, undefined, [ctx]);
	assert.ok(typeof handler === 'object' && handler !== null);
	const method: unknown = Reflect.get(handler, 'getClient');
	assert.ok(typeof method === 'function');
	return Reflect.apply(method, handler, []);
}

/** The descriptor a native client receives: the handle as JSON-RPC serializes it. */
function wire(handle: OidcClientHandle): OidcClientDescriptor {
	return JSON.parse(JSON.stringify(handle));
}

/** A relay sign-in driven only by the descriptor, as the SDKs run it; returns the exchange's response. */
async function relayExchange(d: OidcClientDescriptor, provider: string, b: TestBrowser): Promise<Response> {
	const relayTo = 'http://127.0.0.1:53682/callback';
	const paramsRes = await fetch(`${server.origin}${d.authorizeParamsBasePath}/${provider}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ csrf: 'c'.repeat(40), relayTo }),
	});
	assert.strictEqual(paramsRes.status, 200);
	const params = await paramsRes.json();
	const verifier = 'native-verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
	const callbackUrl = `${server.origin}${d.callbackPath}`;
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
	return b.fetch(`${server.origin}${d.exchangePath}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ code, verifier, state: params.state, nonce: params.nonce, provider, callbackUrl }),
	});
}

/** The names of the cookies a response sets. */
const setCookieNames = (res: Response) => res.headers.getSetCookie().map((line) => line.slice(0, line.indexOf('=')));

describe('createOidcApi().getClient() — the oidc/client transferable', () => {
	test('serializes to the oidc/client descriptor with the default routes and the served provider', async () => {
		const auth = new Auth(unique(), 'auth', { store: 'builtin', providers: { corp: stubIdp({ users: [ALICE] }) } });
		const handle = await getClient<'corp'>(auth.createOidcApi(), new TestBrowser().context(server.origin));
		const descriptor = wire(handle);

		assert.deepStrictEqual(Object.keys(descriptor).sort(), [
			'__blocks',
			'authorizeParamsBasePath',
			'callbackPath',
			'exchangePath',
			'providerConfigs',
			'providers',
			'refreshPath',
			'sessionCookieName',
			'sessionPath',
			'signInBasePath',
			'signOutPath',
		]);
		assert.strictEqual(descriptor.__blocks, 'oidc/client');
		assert.deepStrictEqual(descriptor.providers, ['corp']);
		assert.strictEqual(descriptor.callbackPath, '/cdk-blocks/auth/callback');
		assert.strictEqual(descriptor.exchangePath, '/cdk-blocks/auth/exchange');
		assert.strictEqual(descriptor.signOutPath, '/cdk-blocks/auth/signout');
		assert.strictEqual(descriptor.signInBasePath, '/cdk-blocks/auth/signin');
		assert.strictEqual(descriptor.sessionPath, '/cdk-blocks/auth/session');
		assert.strictEqual(descriptor.refreshPath, '/cdk-blocks/auth/exchange/refresh');
		assert.strictEqual(descriptor.authorizeParamsBasePath, '/cdk-blocks/auth/authorize-params');
		// The handle's own fields are the descriptor's, so a server-side caller reads the same values.
		assert.deepStrictEqual(handle.providers, ['corp']);
		assert.strictEqual(handle.exchangePath, descriptor.exchangePath);

		// providerConfigs is exactly what the block's GET authorize-params route serves.
		const res = await fetch(`${server.origin}${descriptor.authorizeParamsBasePath}/corp`);
		assert.strictEqual(res.status, 200);
		assert.deepStrictEqual(descriptor.providerConfigs, { corp: await res.json() });
	});

	test("a relay sign-in driven only by the descriptor's paths reaches a session, then signs out", async () => {
		const auth = new Auth(unique(), 'auth', {
			store: 'builtin',
			providers: { corp: stubIdp({ users: [ALICE], onAuthorize: (r) => r.users[0] }) },
		});
		const b = new TestBrowser();
		const d = wire(await getClient(auth.createOidcApi(), b.context(server.origin)));

		// What the SDKs do: POST <authorizeParamsBasePath>/<provider> with a csrf and a relayTo.
		const csrf = 'c'.repeat(40);
		const relayTo = 'http://127.0.0.1:53682/callback';
		const paramsRes = await fetch(`${server.origin}${d.authorizeParamsBasePath}/${d.providers[0]}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ csrf, relayTo }),
		});
		assert.strictEqual(paramsRes.status, 200);
		const params = await paramsRes.json();
		assert.strictEqual(params.authorizeUrl, d.providerConfigs.corp.authorizeUrl);
		assert.strictEqual(params.clientId, d.providerConfigs.corp.clientId);

		const verifier = 'native-verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
		const callbackUrl = `${server.origin}${d.callbackPath}`;
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
		assert.strictEqual(relayed.status, 302, 'the callback relays the code to relayTo');
		const code = new URL(location(relayed, server.origin)).searchParams.get('code') ?? '';

		assert.strictEqual((await b.fetch(`${server.origin}${d.sessionPath}`)).status, 401, 'no session yet');

		const exchanged = await b.fetch(`${server.origin}${d.exchangePath}`, {
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
		assert.strictEqual((await exchanged.json()).user.username, 'Alice');
		assert.strictEqual((await auth.requireAuth(b.context(server.origin))).username, 'Alice');
		// What a native app restores on launch from: the session route the descriptor names.
		const restored = await b.fetch(`${server.origin}${d.sessionPath}`);
		assert.strictEqual(restored.status, 200);
		assert.strictEqual((await restored.json()).user.username, 'Alice');

		const out = await b.fetch(`${server.origin}${d.signOutPath}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		});
		assert.ok(out.status === 204 || out.status === 200, `sign-out answered ${out.status}`);
		assert.strictEqual(await auth.getCurrentUser(b.context(server.origin)), null);
		assert.strictEqual((await b.fetch(`${server.origin}${d.sessionPath}`)).status, 401, 'signed out');
	});

	test("a block with its own redirects gets its own paths, so two blocks' clients don't collide", async () => {
		const scope = unique();
		const first = new Auth(scope, 'first', { store: 'builtin', providers: { corp: stubIdp() } });
		const second = new Auth(scope, 'second', {
			store: 'builtin',
			providers: { staff: stubIdp() },
			redirects: {
				// A callback that doesn't end in `/callback`: the descriptor names it as configured.
				callbackPath: '/cdk-blocks/auth/second/return',
				signOutPath: '/cdk-blocks/auth/second/signout',
			},
		});
		const ctx = new TestBrowser().context(server.origin);
		const a = wire(await getClient(first.createOidcApi(), ctx));
		const b = wire(await getClient(second.createOidcApi(), ctx));

		assert.deepStrictEqual(b.providers, ['staff']);
		assert.strictEqual(b.callbackPath, '/cdk-blocks/auth/second/return');
		assert.strictEqual(b.exchangePath, '/cdk-blocks/auth/second/exchange');
		assert.strictEqual(b.signOutPath, '/cdk-blocks/auth/second/signout');
		assert.strictEqual(b.authorizeParamsBasePath, '/cdk-blocks/auth/second/authorize-params');
		assert.strictEqual(b.signInBasePath, '/cdk-blocks/auth/second/signin');
		assert.strictEqual(b.sessionPath, '/cdk-blocks/auth/second/session');
		assert.strictEqual(b.refreshPath, '/cdk-blocks/auth/second/exchange/refresh');
		assert.notStrictEqual(a.exchangePath, b.exchangePath);

		// The second block's descriptor names a route that block really serves.
		const res = await fetch(`${server.origin}${b.authorizeParamsBasePath}/staff`);
		assert.strictEqual(res.status, 200);
		assert.deepStrictEqual(b.providerConfigs, { staff: await res.json() });
	});

	test('a provider unavailable in this runtime (managed login locally) is left out', async () => {
		const auth = new Auth(unique(), 'auth', {
			providers: { google: { type: 'google', clientId: 'g', clientSecret: googleSecret } },
		});
		const d = wire(await getClient(auth.createOidcApi(), new TestBrowser().context(server.origin)));
		assert.deepStrictEqual(d.providers, []);
		assert.deepStrictEqual(d.providerConfigs, {});
		assert.strictEqual(d.exchangePath, '/cdk-blocks/auth/exchange');
	});

	test('a provider whose discovery fails is left out, and the others still sign in', async () => {
		const auth = new Auth(unique(), 'auth', {
			store: 'builtin',
			providers: {
				// Nothing listens on port 9: discovery fails with a connection error.
				broken: { type: 'oidc', issuer: 'http://127.0.0.1:9', clientId: 'broken' },
				corp: stubIdp(),
			},
		});
		const d = wire(await getClient(auth.createOidcApi(), new TestBrowser().context(server.origin)));
		assert.deepStrictEqual(d.providers, ['corp']);
		assert.deepStrictEqual(Object.keys(d.providerConfigs), ['corp']);
	});

	test('every field a native SDK reads is always sent, whatever the block is configured with', async () => {
		// The union of what the SDKs require: Kotlin's OidcClientConfig and ProviderConfig have no
		// defaults, Dart reads providers, signOutPath and each provider's kind without a fallback.
		const PATHS = [
			'callbackPath',
			'exchangePath',
			'signOutPath',
			'signInBasePath',
			'authorizeParamsBasePath',
			'sessionPath',
			'refreshPath',
		] as const;
		const configs = {
			stub: { store: 'builtin', providers: { corp: stubIdp() } },
			ownRedirects: {
				store: 'builtin',
				providers: { corp: stubIdp() },
				redirects: {
					callbackPath: '/cdk-blocks/auth/own/callback',
					signOutPath: '/cdk-blocks/auth/own/signout',
				},
			},
			unavailable: { providers: { google: { type: 'google', clientId: 'g', clientSecret: googleSecret } } },
			failingDiscovery: {
				store: 'builtin',
				providers: { broken: { type: 'oidc', issuer: 'http://127.0.0.1:9', clientId: 'b' } },
			},
			noProviders: {},
		} as const;
		for (const [name, options] of Object.entries(configs)) {
			clearRouteRegistry();
			const auth = new Auth(unique(), 'auth', options);
			const d = wire(await getClient(auth.createOidcApi(), new TestBrowser().context(server.origin)));
			assert.strictEqual(d.__blocks, 'oidc/client', name);
			assert.ok(Array.isArray(d.providers), `${name}: providers is an array`);
			assert.ok(d.providerConfigs && typeof d.providerConfigs === 'object', `${name}: providerConfigs`);
			for (const key of PATHS) {
				assert.ok(typeof d[key] === 'string' && d[key].startsWith('/cdk-blocks/auth/'), `${name}: ${key}`);
			}
			assert.ok(d.sessionCookieName?.startsWith('auth_'), `${name}: sessionCookieName`);
			for (const id of d.providers) {
				const c = d.providerConfigs[id];
				assert.ok(c, `${name}: providerConfigs.${id}`);
				for (const key of ['authorizeUrl', 'clientId', 'kind'] as const) {
					assert.ok(typeof c[key] === 'string' && c[key].length > 0, `${name}: ${id}.${key}`);
				}
				assert.ok(Array.isArray(c.scopes), `${name}: ${id}.scopes`);
			}
		}
	});

	test("sessionCookieName is the cookie each block's exchange sets, so two blocks' sessions are told apart", async () => {
		const scope = unique();
		const first = new Auth(scope, 'first', {
			store: 'builtin',
			providers: { corp: stubIdp({ users: [ALICE], onAuthorize: (r) => r.users[0] }) },
		});
		const second = new Auth(scope, 'second', {
			store: 'builtin',
			providers: { staff: stubIdp({ users: [ALICE], onAuthorize: (r) => r.users[0] }) },
			redirects: {
				callbackPath: '/cdk-blocks/auth/second/callback',
				signOutPath: '/cdk-blocks/auth/second/signout',
			},
		});
		const b = new TestBrowser();
		const a = wire(await getClient(first.createOidcApi(), b.context(server.origin)));
		const c = wire(await getClient(second.createOidcApi(), b.context(server.origin)));
		assert.notStrictEqual(a.sessionCookieName, c.sessionCookieName);

		const signedInA = await relayExchange(a, 'corp', b);
		assert.strictEqual(signedInA.status, 200);
		assert.deepStrictEqual(setCookieNames(signedInA), [a.sessionCookieName]);
		const signedInC = await relayExchange(c, 'staff', b);
		assert.strictEqual(signedInC.status, 200);
		assert.deepStrictEqual(setCookieNames(signedInC), [c.sessionCookieName]);
		// Both sessions live side by side under the names the descriptors gave.
		assert.deepStrictEqual([...b.jar.keys()].sort(), [a.sessionCookieName, c.sessionCookieName].sort());
	});

	test('a block with no providers returns an empty client rather than failing', async () => {
		const auth = new Auth(unique(), 'auth', {});
		const d = wire(await getClient(auth.createOidcApi(), new TestBrowser().context(server.origin)));
		assert.strictEqual(d.__blocks, 'oidc/client');
		assert.deepStrictEqual(d.providers, []);
		assert.deepStrictEqual(d.providerConfigs, {});
	});

	test('createApi() is unchanged: still exactly getAuthState and setAuthState', () => {
		const auth = new Auth(unique(), 'auth', { store: 'builtin', providers: { corp: stubIdp() } });
		const api: unknown = auth.createApi();
		assert.ok(typeof api === 'function');
		const handler: unknown = Reflect.apply(api, undefined, [new TestBrowser().context(server.origin)]);
		assert.ok(typeof handler === 'object' && handler !== null);
		assert.deepStrictEqual(Object.keys(handler).sort(), ['getAuthState', 'setAuthState']);
	});
});
