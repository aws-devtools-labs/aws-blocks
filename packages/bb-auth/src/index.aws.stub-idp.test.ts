// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS runtime — the stub IdP on a **sandbox deployment**, offline. `AuthOIDC`
 * serves its stub from a sandbox's deployed Lambda (that is how the
 * comprehensive app's OIDC e2e runs in a sandbox); `Auth` does too, and, like
 * `AuthOIDC`, on no other deployment. Proves, against an in-process API Gateway
 * stage (`test-support/gateway.ts`, HTTPS, stage prefix and all):
 *
 * - unless `getDeploymentType()` is `'sandbox'` (local, production, or a
 *   deployed config that predates `BLOCKS_DEPLOYMENT_TYPE`) nothing is mounted
 *   and sign-in is the actionable `501`;
 * - on a sandbox, discovery, JWKS, authorize (the picker), token and userinfo are
 *   served, the issuer is the HTTPS gateway URL the CDK layer registers, and
 *   the HTTPS-only direct engine signs a user in through it;
 * - **two Lambda instances** built from the same configuration (same session
 *   secret, no shared memory) interoperate: tokens one mints verify on the
 *   other, a code one issues redeems at the other, a refresh token one issues
 *   refreshes at the other, and a sign-in started on one completes on the other.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { _resetConfigCache, ApiError, clearRouteRegistry, getRegisteredRoutes, preloadConfig } from '@aws-blocks/core';
import { S3Client } from '@aws-sdk/client-s3';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { stubIdpConfigKeys } from './cdk/contract.js';
import { pkceChallenge } from './engines/federation-direct.js';
import { Auth, AuthErrors, stubIdp } from './index.aws.js';
import { type FakeGateway, installFakeGateway } from './test-support/gateway.js';
import { location, TestBrowser } from './test-support/route-server.js';
import type { StubUser } from './types.js';

const ALICE: StubUser = { sub: 'u-1', email: 'alice@example.com', name: 'Alice', extra: { groups: ['admin'] } };
const BOB: StubUser = { sub: 'u-2', email: 'bob@example.com', name: 'Bob' };

let gw: FakeGateway;
let n = 0;
let rootId = '';

const ENV_KEYS = ['BLOCKS_DEPLOYMENT_TYPE', 'BLOCKS_CONFIG_BUCKET', 'BLOCKS_CONFIG_KEY'] as const;
const prevEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

beforeEach(() => {
	for (const key of ENV_KEYS) prevEnv[key] = process.env[key];
	// Outside deployed compute, `getDeploymentType()` reads this variable (as the
	// synth process sees what `BlocksStack.create` set): a sandbox by default here.
	process.env.BLOCKS_DEPLOYMENT_TYPE = 'sandbox';
	clearRouteRegistry();
	rmSync('.bb-data', { recursive: true, force: true });
	gw = installFakeGateway();
	rootId = `stubaws${process.pid}x${++n}`;
	// What the CDK layer registers (`registerConfig`) for an opted-in stub.
	process.env[stubIdpConfigKeys(`${rootId}-auth`).API_URL] = gw.apiUrl;
});
afterEach(() => {
	for (const key of ENV_KEYS) {
		if (prevEnv[key] === undefined) delete process.env[key];
		else process.env[key] = prevEnv[key];
	}
	mock.restoreAll();
	_resetConfigCache();
	gw.uninstall();
	delete process.env[stubIdpConfigKeys(`${rootId}-auth`).API_URL];
	rmSync('.bb-data', { recursive: true, force: true });
});

/** One "Lambda instance": a fresh `Auth` (fresh engines, caches and routes) over the same config and secret. */
function lambdaInstance() {
	clearRouteRegistry();
	return new Auth({ id: rootId }, 'auth', {
		emailPassword: false,
		oidcProviders: { corp: stubIdp({ users: [ALICE, BOB] }) },
		users: { groups: ['admin'] },
	});
}

const issuer = () => `${gw.base}/aws-blocks/auth/idp/corp`;

/** Sign-in kickoff → the stub's authorize URL (and the browser now holds the pending cookie). */
async function kickoff(b: TestBrowser): Promise<string> {
	const start = await b.fetch(`${gw.base}/aws-blocks/auth/signin/corp`);
	assert.strictEqual(start.status, 302, `the sign-in route redirects to the stub, got ${start.status}`);
	const authorize = location(start, gw.base);
	assert.ok(authorize.startsWith(`${issuer()}/authorize?`), authorize);
	return authorize;
}

/** Submit the picker for `sub`; returns the callback URL the stub redirects to. */
async function pick(b: TestBrowser, authorize: string, sub: string): Promise<string> {
	const form = new URLSearchParams(new URL(authorize).searchParams);
	form.set('sub', sub);
	const submitted = await b.fetch(`${issuer()}/authorize`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: form.toString(),
	});
	assert.strictEqual(submitted.status, 302);
	const callback = location(submitted, gw.base);
	assert.ok(callback.startsWith(`${gw.base}/aws-blocks/auth/callback?code=`), callback);
	return callback;
}

/** A code for `sub` minted through the picker, plus what redeeming it needs. */
async function mintCode(sub: string) {
	const verifier = 'v'.repeat(64);
	// The app's own callback on the gateway: the stub's only registered redirect URI.
	const redirectUri = `${gw.base}/aws-blocks/auth/callback`;
	const params = new URLSearchParams({
		response_type: 'code',
		client_id: 'stub-client-id',
		redirect_uri: redirectUri,
		code_challenge: pkceChallenge(verifier),
		code_challenge_method: 'S256',
		state: 's',
		nonce: 'nonce-1',
		scope: 'openid email profile',
		sub,
	});
	const res = await fetch(`${issuer()}/authorize`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: params.toString(),
		redirect: 'manual',
	});
	assert.strictEqual(res.status, 302);
	const code = new URL(location(res, gw.base)).searchParams.get('code') ?? '';
	assert.ok(code);
	return { code, verifier, redirectUri };
}

async function token(form: Record<string, string>): Promise<Response> {
	return fetch(`${issuer()}/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ client_id: 'stub-client-id', ...form }).toString(),
	});
}

/**
 * Simulate deployed compute whose loaded config is `config`: set the config
 * bucket/key and load the config through core's S3 path, with the S3 GetObject
 * response stubbed (the test runner has no S3). Restored in `afterEach`.
 */
async function loadDeployedConfig(config: Record<string, string>): Promise<void> {
	process.env.BLOCKS_CONFIG_BUCKET = 'bucket';
	process.env.BLOCKS_CONFIG_KEY = 'key';
	_resetConfigCache();
	mock.method(S3Client.prototype, 'send', async () => ({
		Body: { transformToString: async () => JSON.stringify(config) },
	}));
	await preloadConfig();
}

/** No stub route is mounted, discovery is a 404, and sign-in is the actionable 501. */
async function assertStubNotServed(): Promise<void> {
	const auth = lambdaInstance();
	const idpRoutes = getRegisteredRoutes().filter((r) => r.path.startsWith('/aws-blocks/auth/idp/'));
	assert.deepStrictEqual(idpRoutes, [], 'no stub IdP routes outside a sandbox deployment');
	const discovery = await fetch(`${issuer()}/.well-known/openid-configuration`);
	assert.strictEqual(discovery.status, 404);
	await assert.rejects(
		auth.getSignInUrl(new TestBrowser().context(gw.base), 'corp'),
		(e: unknown) =>
			e instanceof ApiError &&
			e.status === 501 &&
			e.name === AuthErrors.ProviderMisconfigured &&
			/runs only in local development \(npm run dev\) and sandbox deployments/.test(e.message) &&
			/getDeploymentType\(\)/.test(e.message) &&
			/restart `npm run sandbox`/.test(e.message),
	);
}

describe('AWS runtime — stubIdp() outside a sandbox deployment', () => {
	test("'production' (BLOCKS_DEPLOYMENT_TYPE outside deployed compute): not served", async () => {
		process.env.BLOCKS_DEPLOYMENT_TYPE = 'production';
		await assertStubNotServed();
	});

	test("'local' (no deployment type, not deployed compute — e.g. client code generation): not served", async () => {
		delete process.env.BLOCKS_DEPLOYMENT_TYPE;
		await assertStubNotServed();
	});

	test("deployed compute whose loaded config says 'production': not served", async () => {
		await loadDeployedConfig({ BLOCKS_DEPLOYMENT_TYPE: 'production' });
		await assertStubNotServed();
	});

	test('deployed compute whose config predates BLOCKS_DEPLOYMENT_TYPE (a `cdk watch` hotswap): not served', async () => {
		await loadDeployedConfig({});
		await assertStubNotServed();
	});

	test("on deployed compute a BLOCKS_DEPLOYMENT_TYPE='sandbox' environment variable does not override the config", async () => {
		process.env.BLOCKS_DEPLOYMENT_TYPE = 'sandbox';
		await loadDeployedConfig({ BLOCKS_DEPLOYMENT_TYPE: 'production' });
		await assertStubNotServed();
	});

	test("deployed compute whose loaded config says 'sandbox': served", async () => {
		delete process.env.BLOCKS_DEPLOYMENT_TYPE;
		await loadDeployedConfig({ BLOCKS_DEPLOYMENT_TYPE: 'sandbox' });
		lambdaInstance();
		const discovery = await fetch(`${issuer()}/.well-known/openid-configuration`);
		assert.strictEqual(discovery.status, 200);
	});
});

describe('AWS runtime — stubIdp() on a sandbox deployment', () => {
	test('discovery, JWKS, authorize, token and userinfo are served; the issuer is the HTTPS gateway URL', async () => {
		lambdaInstance();
		const doc = await (await fetch(`${issuer()}/.well-known/openid-configuration`)).json();
		assert.strictEqual(doc.issuer, issuer());
		assert.strictEqual(doc.token_endpoint, `${issuer()}/token`);
		assert.ok(String(doc.issuer).startsWith('https://'), 'HTTPS, so the AWS direct engine accepts it');
		const jwks = await (await fetch(doc.jwks_uri)).json();
		assert.strictEqual(jwks.keys.length, 1);
		assert.strictEqual(jwks.keys[0].alg, 'ES256');
		assert.strictEqual(jwks.keys[0].d, undefined, 'the JWKS never carries the private key');

		// GET /authorize renders the picker, posting back to the stage-aware issuer.
		const b = new TestBrowser();
		const authorize = await kickoff(b);
		const picker = await b.fetch(authorize);
		assert.strictEqual(picker.status, 200);
		const html = await picker.text();
		assert.match(html, /Alice/);
		assert.ok(html.includes(`action="${issuer()}/authorize"`), 'the picker posts to the gateway stage');

		const { code, verifier, redirectUri } = await mintCode('u-2');
		const res = await token({
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirectUri,
			code_verifier: verifier,
		});
		assert.strictEqual(res.status, 200);
		const tokens = await res.json();
		const { payload } = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), {
			issuer: issuer(),
			audience: 'stub-client-id',
		});
		assert.strictEqual(payload.sub, 'u-2');
		assert.strictEqual(payload.nonce, 'nonce-1');

		const userinfo = await fetch(`${issuer()}/userinfo`, {
			headers: { authorization: `Bearer ${tokens.access_token}` },
		});
		assert.strictEqual(userinfo.status, 200);
		assert.deepStrictEqual(await userinfo.json(), {
			sub: 'u-2',
			email: 'bob@example.com',
			email_verified: true,
			name: 'Bob',
		});
	});

	test('the HTTPS-only direct engine signs a user in through it (picker → callback → session → requireRole)', async () => {
		const auth = lambdaInstance();
		const b = new TestBrowser();
		const callback = await pick(b, await kickoff(b), 'u-1');
		const landing = await b.fetch(callback);
		assert.strictEqual(
			landing.status,
			302,
			`the callback lands, got ${landing.status}: ${await landing.clone().text()}`,
		);
		const user = await auth.requireRole(b.context(gw.base), 'admin');
		assert.strictEqual(user.userId, `${issuer()}:u-1`, 'Q1: <iss>:<sub>, with the gateway issuer');
		assert.strictEqual(user.signInProvider, 'corp');
		assert.strictEqual(user.attributes.email, 'alice@example.com');
	});

	test('two Lambda instances with the same secret interoperate (keys, codes, refresh tokens, a split sign-in)', async () => {
		// Instance A mints.
		lambdaInstance();
		const jwksA = await (await fetch(`${issuer()}/jwks.json`)).json();
		const fromA = await mintCode('u-1');
		const second = await mintCode('u-2');
		const tokensA = await (
			await token({
				grant_type: 'authorization_code',
				code: fromA.code,
				redirect_uri: fromA.redirectUri,
				code_verifier: fromA.verifier,
			})
		).json();
		const b = new TestBrowser();
		const callback = await pick(b, await kickoff(b), 'u-1');

		// Instance B: a cold start — nothing in memory from A, same session secret.
		const authB = lambdaInstance();
		const jwksB = await (await fetch(`${issuer()}/jwks.json`)).json();
		assert.deepStrictEqual(jwksB, jwksA, 'every instance publishes the same key');
		const { payload } = await jwtVerify(tokensA.id_token, createLocalJWKSet(jwksB), {
			issuer: issuer(),
			audience: 'stub-client-id',
		});
		assert.strictEqual(payload.sub, 'u-1', "A's ID token verifies against B's JWKS");

		const userinfo = await fetch(`${issuer()}/userinfo`, {
			headers: { authorization: `Bearer ${tokensA.access_token}` },
		});
		assert.strictEqual(userinfo.status, 200, "B's userinfo accepts A's access token");

		const redeemed = await token({
			grant_type: 'authorization_code',
			code: second.code,
			redirect_uri: second.redirectUri,
			code_verifier: second.verifier,
		});
		assert.strictEqual(redeemed.status, 200, "a code A issued redeems at B's /token");

		const refreshed = await token({ grant_type: 'refresh_token', refresh_token: tokensA.refresh_token });
		assert.strictEqual(refreshed.status, 200, 'a refresh token A issued refreshes at B');
		const rotated = await token({ grant_type: 'refresh_token', refresh_token: tokensA.refresh_token });
		assert.strictEqual(rotated.status, 400, 'and is spent on the instance that rotated it');

		// The sign-in A started (pending cookie, authorize) completes on B.
		const landing = await b.fetch(callback);
		assert.strictEqual(landing.status, 302, `B completes A's sign-in, got ${landing.status}`);
		const user = await authB.requireAuth(b.context(gw.base));
		assert.strictEqual(user.userId, `${issuer()}:u-1`);
	});

	test('/authorize accepts only the registered client and redirect URI: anything else is a 400, never a redirect', async () => {
		lambdaInstance();
		const query = (overrides: Record<string, string>) =>
			new URLSearchParams({
				response_type: 'code',
				client_id: 'stub-client-id',
				redirect_uri: `${gw.base}/aws-blocks/auth/callback`,
				code_challenge: pkceChallenge('v'.repeat(64)),
				code_challenge_method: 'S256',
				state: 's',
				sub: 'u-1',
				...overrides,
			});
		const refused: Record<string, string>[] = [
			{ client_id: 'anything' },
			{ redirect_uri: 'https://evil.example/land' },
			{ redirect_uri: `${gw.base}/aws-blocks/auth/callback/x` },
			// The gateway origin without its stage is not where the app's callback lives.
			{ redirect_uri: `${new URL(gw.base).origin}/aws-blocks/auth/callback` },
		];
		for (const overrides of refused) {
			const what = JSON.stringify(overrides);
			const get = await fetch(`${issuer()}/authorize?${query(overrides)}`, { redirect: 'manual' });
			assert.strictEqual(get.status, 400, what);
			assert.strictEqual(get.headers.get('location'), null, what);
			const post = await fetch(`${issuer()}/authorize`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: query(overrides).toString(),
				redirect: 'manual',
			});
			assert.strictEqual(post.status, 400, what);
			assert.strictEqual(post.headers.get('location'), null, what);
		}
	});

	test('behind Hosting (BLOCKS_PUBLIC_ORIGIN) both front doors are registered: the public origin and the gateway', async () => {
		const publicOrigin = 'https://app.example.com';
		process.env.BLOCKS_PUBLIC_ORIGIN = publicOrigin;
		try {
			lambdaInstance();
			const b = new TestBrowser();
			// The direct engine sends the public-origin callback (`computeCallbackUrl`).
			const authorize = await kickoff(b);
			assert.strictEqual(
				new URL(authorize).searchParams.get('redirect_uri'),
				`${publicOrigin}/aws-blocks/auth/callback`,
			);
			// A native SDK pointed at the gateway sends the gateway callback.
			for (const redirectUri of [
				`${publicOrigin}/aws-blocks/auth/callback`,
				`${gw.base}/aws-blocks/auth/callback`,
			]) {
				const form = new URLSearchParams(new URL(authorize).searchParams);
				form.set('redirect_uri', redirectUri);
				form.set('sub', 'u-1');
				const res = await fetch(`${issuer()}/authorize`, {
					method: 'POST',
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					body: form.toString(),
					redirect: 'manual',
				});
				assert.strictEqual(res.status, 302, redirectUri);
				assert.ok(location(res, gw.base).startsWith(`${redirectUri}?code=`), redirectUri);
			}
		} finally {
			delete process.env.BLOCKS_PUBLIC_ORIGIN;
		}
	});

	test("a forged code (signed with any key but this deployment's secret) is refused", async () => {
		lambdaInstance();
		const { code, verifier, redirectUri } = await mintCode('u-2');
		const [body] = code.split('.');
		const claims = JSON.parse(Buffer.from(body ?? '', 'base64url').toString('utf8'));
		claims.user = { sub: 'root', email: 'root@example.com', name: 'Root', extra: { groups: ['admin'] } };
		const tampered = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${code.split('.')[1]}`;
		const res = await token({
			grant_type: 'authorization_code',
			code: tampered,
			redirect_uri: redirectUri,
			code_verifier: verifier,
		});
		assert.strictEqual(res.status, 400);
		assert.strictEqual((await res.json()).error, 'invalid_grant');
	});
});
