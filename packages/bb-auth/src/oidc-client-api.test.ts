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
import { type BlocksContext, clearRouteRegistry } from '@aws-blocks/core';
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
	rmSync('.bb-data', { recursive: true, force: true });
});
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

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
			'signInBasePath',
			'signOutPath',
		]);
		assert.strictEqual(descriptor.__blocks, 'oidc/client');
		assert.deepStrictEqual(descriptor.providers, ['corp']);
		assert.strictEqual(descriptor.callbackPath, '/aws-blocks/auth/callback');
		assert.strictEqual(descriptor.exchangePath, '/aws-blocks/auth/exchange');
		assert.strictEqual(descriptor.signOutPath, '/aws-blocks/auth/signout');
		assert.strictEqual(descriptor.signInBasePath, '/aws-blocks/auth/signin');
		assert.strictEqual(descriptor.authorizeParamsBasePath, '/aws-blocks/auth/authorize-params');
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

		const out = await b.fetch(`${server.origin}${d.signOutPath}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		});
		assert.ok(out.status === 204 || out.status === 200, `sign-out answered ${out.status}`);
		assert.strictEqual(await auth.getCurrentUser(b.context(server.origin)), null);
	});

	test("a block with its own redirects gets its own paths, so two blocks' clients don't collide", async () => {
		const scope = unique();
		const first = new Auth(scope, 'first', { store: 'builtin', providers: { corp: stubIdp() } });
		const second = new Auth(scope, 'second', {
			store: 'builtin',
			providers: { staff: stubIdp() },
			redirects: {
				callbackPath: '/aws-blocks/auth/second/callback',
				signOutPath: '/aws-blocks/auth/second/signout',
			},
		});
		const ctx = new TestBrowser().context(server.origin);
		const a = wire(await getClient(first.createOidcApi(), ctx));
		const b = wire(await getClient(second.createOidcApi(), ctx));

		assert.deepStrictEqual(b.providers, ['staff']);
		assert.strictEqual(b.callbackPath, '/aws-blocks/auth/second/callback');
		assert.strictEqual(b.exchangePath, '/aws-blocks/auth/second/exchange');
		assert.strictEqual(b.signOutPath, '/aws-blocks/auth/second/signout');
		assert.strictEqual(b.authorizeParamsBasePath, '/aws-blocks/auth/second/authorize-params');
		assert.strictEqual(b.signInBasePath, '/aws-blocks/auth/second/signin');
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
		assert.strictEqual(d.exchangePath, '/aws-blocks/auth/exchange');
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
