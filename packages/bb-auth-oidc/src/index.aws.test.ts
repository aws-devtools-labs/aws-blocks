// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Must run under `--conditions=aws-runtime` so `./index.aws.js` and its
 * dependencies resolve their AWS entries, matching deployed compute.
 *
 * Covers the runtime mount decision for `stubIdp()` providers: the stub IdP
 * routes are registered only when `getDeploymentType()` reports `'sandbox'`.
 * Assertions read the RawRoute registry that deployed compute dispatches from.
 *
 * Also covers the engine side of the same decision: outside a sandbox a stub
 * provider is unavailable (sign-in answers ProviderNotConfigured, and a bearer
 * token naming the stub issuer is not matched), and inside a sandbox the
 * mounted routes load the stub IdP engine on first request.
 */

import assert from 'node:assert';
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import {
	_resetConfigCache,
	type BlocksContext,
	clearRouteRegistry,
	getRegisteredRoutes,
	preloadConfig,
} from '@aws-blocks/core';
import { AuthOIDC, google, stubIdp } from './index.aws.js';
import { stubIssuerPath } from './engines/stub-issuer.js';

const ENV_KEYS = [
	'AWS_REGION',
	'BLOCKS_STACK_NAME',
	'BLOCKS_DEPLOYMENT_TYPE',
	'BLOCKS_CONFIG_BUCKET',
	'BLOCKS_CONFIG_KEY',
] as const;
const prevEnv: Record<string, string | undefined> = {};
const prevCurrentStack = (globalThis as { CURRENT_BLOCKS_STACK?: unknown }).CURRENT_BLOCKS_STACK;

before(() => {
	for (const key of ENV_KEYS) prevEnv[key] = process.env[key];
	process.env.AWS_REGION = 'us-east-1';
	delete process.env.BLOCKS_STACK_NAME;
	delete (globalThis as { CURRENT_BLOCKS_STACK?: unknown }).CURRENT_BLOCKS_STACK;
});

after(() => {
	for (const key of ENV_KEYS) {
		if (prevEnv[key] === undefined) delete process.env[key];
		else process.env[key] = prevEnv[key];
	}
	if (prevCurrentStack === undefined) delete (globalThis as { CURRENT_BLOCKS_STACK?: unknown }).CURRENT_BLOCKS_STACK;
	else (globalThis as { CURRENT_BLOCKS_STACK?: unknown }).CURRENT_BLOCKS_STACK = prevCurrentStack;
});

/** Route paths registered for the stub provider named `name`. */
function stubRoutePaths(name: string): string[] {
	const base = stubIssuerPath(name);
	return getRegisteredRoutes()
		.filter((r) => r.path === base || r.path.startsWith(`${base}/`))
		.map((r) => `${r.method} ${r.path}`);
}

// The not-mounted warnings are deduped per provider name for the life of the
// module, so tests that assert a warning use a provider name not used before.
/**
 * Simulate deployed compute whose loaded config is `config`: set the config
 * bucket/key and load the config through core's S3 path, with the S3 GetObject
 * response stubbed (the test runner has no S3). Restored in `afterEach`.
 */
async function loadDeployedConfig(config: Record<string, string>): Promise<void> {
	process.env.BLOCKS_CONFIG_BUCKET = 'bucket';
	process.env.BLOCKS_CONFIG_KEY = 'key';
	mock.method(S3Client.prototype, 'send', async () => ({
		Body: { transformToString: async () => JSON.stringify(config) },
	}));
	await preloadConfig();
}

function construct(stubName = 'dev', allowBearerAuth = false) {
	return new AuthOIDC({ id: 'my-app' }, 'auth', {
		providers: [google({ clientId: 'cid', clientSecret: 'secret' }), stubIdp({ name: stubName })],
		allowBearerAuth,
	});
}

/** Request origin for the engine tests; the stub issuer resolves under it. */
const ORIGIN = 'https://api.example.test';

/** Minimal request context; `sent` captures what a route handler sends. */
function requestCtx(headers: Headers = new Headers()): { ctx: BlocksContext; sent: unknown[] } {
	const sent: unknown[] = [];
	const ctx = {
		request: {
			headers,
			body: null,
			json: async () => ({}),
			text: async () => '',
			url: new URL(`${ORIGIN}/`),
			params: {},
		},
		response: {
			headers: new Headers(),
			status: 200,
			send: (body: unknown) => {
				sent.push(body);
			},
		},
	} as unknown as BlocksContext;
	return { ctx, sent };
}

/** Bearer header carrying an unsigned token whose `iss` is the stub issuer for `name`. */
function stubBearerHeaders(name: string): Headers {
	const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k' })).toString('base64url');
	const now = Math.floor(Date.now() / 1000);
	const payload = Buffer.from(
		JSON.stringify({
			iss: `${ORIGIN}${stubIssuerPath(name)}`,
			sub: 'u',
			aud: 'stub-client-id',
			exp: now + 3600,
			iat: now,
		}),
	).toString('base64url');
	return new Headers({ authorization: `Bearer ${header}.${payload}.sig` });
}

describe('AuthOIDC (aws-runtime): stubIdp route mounting by deployment type', () => {
	let warn: ReturnType<typeof mock.method<Console, 'warn'>>;

	beforeEach(() => {
		clearRouteRegistry();
		_resetConfigCache();
		for (const key of ['BLOCKS_DEPLOYMENT_TYPE', 'BLOCKS_CONFIG_BUCKET', 'BLOCKS_CONFIG_KEY'] as const) {
			delete process.env[key];
		}
		warn = mock.method(console, 'warn', () => {});
	});

	afterEach(() => {
		warn.mock.restore();
		mock.restoreAll();
		clearRouteRegistry();
		_resetConfigCache();
	});

	test('sandbox: all 7 stub IdP routes are registered', () => {
		process.env.BLOCKS_DEPLOYMENT_TYPE = 'sandbox';
		construct();
		assert.strictEqual(stubRoutePaths('dev').length, 7, `routes: ${JSON.stringify(stubRoutePaths('dev'))}`);
		assert.strictEqual(warn.mock.callCount(), 0);
	});

	test('production: no stub IdP routes are registered and a warning names the provider', async () => {
		await loadDeployedConfig({ BLOCKS_DEPLOYMENT_TYPE: 'production' });
		construct();
		assert.deepStrictEqual(stubRoutePaths('dev'), []);
		assert.strictEqual(warn.mock.callCount(), 1);
		assert.match(
			String(warn.mock.calls[0].arguments[0]),
			/stubIdp provider 'dev' is not mounted outside a sandbox deployment/,
		);
	});

	test('deployed compute with a production config: not mounted, warning names the provider', async () => {
		// Both the mount decision and the message selection read the loaded
		// config; a same-named env var that disagrees does not change either.
		await loadDeployedConfig({ BLOCKS_DEPLOYMENT_TYPE: 'production' });
		process.env.BLOCKS_DEPLOYMENT_TYPE = 'sandbox';
		construct('dev-deployed-prod');
		assert.deepStrictEqual(stubRoutePaths('dev-deployed-prod'), []);
		assert.strictEqual(warn.mock.callCount(), 1);
		const message = String(warn.mock.calls[0].arguments[0]);
		assert.match(message, /stubIdp provider 'dev-deployed-prod' is not mounted outside a sandbox deployment/);
		assert.doesNotMatch(message, /predates BLOCKS_DEPLOYMENT_TYPE/);
	});

	test('deployed compute with a config that predates BLOCKS_DEPLOYMENT_TYPE: not mounted, warning says to restart the sandbox', async () => {
		await loadDeployedConfig({ OTHER_KEY: 'value' });
		construct('dev-unset');
		assert.deepStrictEqual(stubRoutePaths('dev-unset'), []);
		assert.strictEqual(warn.mock.callCount(), 1);
		const message = String(warn.mock.calls[0].arguments[0]);
		assert.match(
			message,
			/stubIdp provider 'dev-unset' is not mounted: this deployment's config predates BLOCKS_DEPLOYMENT_TYPE/,
		);
		assert.match(message, /Restart `npm run sandbox`/);
	});

	test('production: the warning is logged once per provider name, not per construction', async () => {
		await loadDeployedConfig({ BLOCKS_DEPLOYMENT_TYPE: 'production' });
		construct('dev-repeat');
		clearRouteRegistry();
		construct('dev-repeat');
		assert.deepStrictEqual(stubRoutePaths('dev-repeat'), []);
		assert.strictEqual(warn.mock.callCount(), 1);
	});

	test('predates-config: the warning is logged once per provider name, not per construction', () => {
		process.env.BLOCKS_CONFIG_BUCKET = 'bucket';
		process.env.BLOCKS_CONFIG_KEY = 'key';
		construct('dev-unset-repeat');
		clearRouteRegistry();
		construct('dev-unset-repeat');
		assert.deepStrictEqual(stubRoutePaths('dev-unset-repeat'), []);
		assert.strictEqual(warn.mock.callCount(), 1);
	});

	test('local (unset, e.g. client codegen): no stub IdP routes and no warning', () => {
		construct();
		assert.deepStrictEqual(stubRoutePaths('dev'), []);
		assert.strictEqual(warn.mock.callCount(), 0);
	});

	test('non-stub routes are still mounted outside sandbox', () => {
		process.env.BLOCKS_DEPLOYMENT_TYPE = 'production';
		construct();
		assert.ok(getRegisteredRoutes().length > 0, 'expected the shared auth routes to be registered');
	});
});

describe('AuthOIDC (aws-runtime): stub providers are served only in a sandbox deployment', () => {
	let warn: ReturnType<typeof mock.method<Console, 'warn'>>;
	let fetchMock: ReturnType<typeof mock.method<typeof globalThis, 'fetch'>>;
	const prevApiUrl = process.env.BLOCKS_API_URL;

	beforeEach(() => {
		clearRouteRegistry();
		_resetConfigCache();
		for (const key of ['BLOCKS_DEPLOYMENT_TYPE', 'BLOCKS_CONFIG_BUCKET', 'BLOCKS_CONFIG_KEY'] as const) {
			delete process.env[key];
		}
		// The stub issuer then resolves from the request origin.
		delete process.env.BLOCKS_API_URL;
		warn = mock.method(console, 'warn', () => {});
		// Issuer discovery is the first network call a trusted stub makes; answer
		// it 404 so nothing leaves the process and verification fails closed.
		fetchMock = mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
	});

	afterEach(() => {
		warn.mock.restore();
		mock.restoreAll();
		clearRouteRegistry();
		_resetConfigCache();
		if (prevApiUrl === undefined) delete process.env.BLOCKS_API_URL;
		else process.env.BLOCKS_API_URL = prevApiUrl;
	});

	test('production: authorize-params for the stub provider answers ProviderNotConfigured', async () => {
		await loadDeployedConfig({ BLOCKS_DEPLOYMENT_TYPE: 'production' });
		const auth = construct('dev-trust-prod');
		await assert.rejects(auth.getAuthorizeParams(requestCtx().ctx, 'dev-trust-prod'), {
			name: 'ProviderNotConfiguredException',
		});
		assert.strictEqual(fetchMock.mock.callCount(), 0, 'no issuer discovery outside a sandbox');
	});

	test('production: a bearer token naming the stub issuer is not accepted and not discovered', async () => {
		await loadDeployedConfig({ BLOCKS_DEPLOYMENT_TYPE: 'production' });
		const auth = construct('dev-bearer-prod', true);
		const user = await auth.getCurrentUser(requestCtx(stubBearerHeaders('dev-bearer-prod')).ctx);
		assert.strictEqual(user, null);
		assert.strictEqual(fetchMock.mock.callCount(), 0, 'the stub issuer must not be discovered outside a sandbox');
	});

	test('local (unset): a bearer token naming the stub issuer is not accepted', async () => {
		const auth = construct('dev-bearer-local', true);
		const user = await auth.getCurrentUser(requestCtx(stubBearerHeaders('dev-bearer-local')).ctx);
		assert.strictEqual(user, null);
		assert.strictEqual(fetchMock.mock.callCount(), 0);
	});

	test('sandbox: a bearer token naming the stub issuer is matched (discovery runs against it)', async () => {
		process.env.BLOCKS_DEPLOYMENT_TYPE = 'sandbox';
		const auth = construct('dev-bearer-sandbox', true);
		// Discovery is answered 404, so the token is still not accepted; this
		// pins that the stub provider IS trusted in a sandbox.
		const user = await auth.getCurrentUser(requestCtx(stubBearerHeaders('dev-bearer-sandbox')).ctx);
		assert.strictEqual(user, null);
		assert.ok(fetchMock.mock.callCount() > 0, 'expected issuer discovery for a sandbox stub');
		const firstUrl = String(fetchMock.mock.calls[0].arguments[0]);
		assert.ok(
			firstUrl.startsWith(`${ORIGIN}${stubIssuerPath('dev-bearer-sandbox')}/.well-known/openid-configuration`),
			firstUrl,
		);
	});

	test('sandbox: a mounted stub route loads the engine on first request and answers', async () => {
		process.env.BLOCKS_DEPLOYMENT_TYPE = 'sandbox';
		construct('dev-lazy');
		const discoveryPath = `${stubIssuerPath('dev-lazy')}/.well-known/openid-configuration`;
		const route = getRegisteredRoutes().find((r) => r.method === 'GET' && r.path === discoveryPath);
		assert.ok(route, `expected GET ${discoveryPath} to be registered`);
		const { ctx, sent } = requestCtx();
		await route.handler(ctx);
		assert.strictEqual(sent.length, 1);
		const body = (typeof sent[0] === 'string' ? JSON.parse(sent[0]) : sent[0]) as { issuer?: string };
		assert.strictEqual(body.issuer, `${ORIGIN}${stubIssuerPath('dev-lazy')}`);
	});
});
