// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Must run under `--conditions=aws-runtime` so `./index.aws.js` and its
 * dependencies resolve their AWS entries, matching deployed compute.
 *
 * Covers the runtime mount decision for `stubIdp()` providers: the stub IdP
 * routes are registered only when `getDeploymentType()` reports `'sandbox'`.
 * Assertions read the RawRoute registry that deployed compute dispatches from.
 */

import assert from 'node:assert';
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { _resetConfigCache, clearRouteRegistry, getRegisteredRoutes, preloadConfig } from '@aws-blocks/core';
import { AuthOIDC, google, stubIdp } from './index.aws.js';
import { stubIssuerPath } from './engines/stub-idp.js';

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

function construct(stubName = 'dev'): void {
	new AuthOIDC({ id: 'my-app' }, 'auth', {
		providers: [google({ clientId: 'cid', clientSecret: 'secret' }), stubIdp({ name: stubName })],
	});
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
