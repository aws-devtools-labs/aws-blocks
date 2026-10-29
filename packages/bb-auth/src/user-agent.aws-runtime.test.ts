// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `Auth`'s session store reports `Auth` as its parent block on the wire.
 *
 * Runs in the package's second test pass, under `--conditions=aws-runtime`, so
 * `@aws-blocks/bb-kv-store` resolves its AWS entry and signs a real request.
 * The first pass (default condition) resolves the mock store, which has no SDK
 * client; there the suite is skipped rather than passing vacuously.
 *
 * These assert on the `user-agent` header the SDK built, not on the pair array
 * `buildUserAgentChain()` returns: the escaping and the join happen on the way to
 * the header, so a chain that never reaches it would still satisfy the pairs.
 * The `AuthOIDC` counterpart is `main`'s #746.
 */

import assert from 'node:assert';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { ScopeParent } from '@aws-blocks/core';
import { clearRouteRegistry, Scope } from '@aws-blocks/core';
import { CORE_VERSION } from '@aws-blocks/core/version';
import { Auth } from './index.aws.js';
import { BB_NAME, BB_VERSION } from './version.js';

type SignedStore = {
	bbName?: string;
	fullId?: string;
	docClient?: { config: { requestHandler: unknown } };
	get(k: string): Promise<unknown>;
};

const ENV_KEYS = [
	'AWS_REGION',
	'AWS_ACCESS_KEY_ID',
	'AWS_SECRET_ACCESS_KEY',
	'AWS_PROFILE',
	'BLOCKS_STACK_NAME',
] as const;
const prevEnv: Record<string, string | undefined> = {};

before(() => {
	for (const key of ENV_KEYS) prevEnv[key] = process.env[key];
	// Region and dummy creds let signing resolve; AWS_PROFILE is cleared because a
	// named profile makes the SDK ignore them. BLOCKS_STACK_NAME would change fullId.
	process.env.AWS_REGION = 'us-east-1';
	process.env.AWS_ACCESS_KEY_ID = 'AKIDTEST';
	process.env.AWS_SECRET_ACCESS_KEY = 'secret';
	delete process.env.AWS_PROFILE;
	delete process.env.BLOCKS_STACK_NAME;
});

after(() => {
	for (const key of ENV_KEYS) {
		if (prevEnv[key] === undefined) delete process.env[key];
		else process.env[key] = prevEnv[key];
	}
});

/** The one `KVStore` under `auth` (its `sessions` child). */
function sessionStore(auth: object): SignedStore {
	const seen = new Set<object>();
	const found: SignedStore[] = [];
	const walk = (node: unknown): void => {
		if (!node || typeof node !== 'object' || seen.has(node)) return;
		seen.add(node);
		const candidate = node as SignedStore;
		if (candidate.bbName === 'KVStore' && typeof candidate.fullId === 'string') found.push(candidate);
		for (const key of Object.keys(node)) walk((node as Record<string, unknown>)[key]);
	};
	walk(auth);
	assert.strictEqual(found.length, 1, `expected exactly one session KVStore, found ${found.length}`);
	return found[0];
}

/** A direct-OIDC-only `Auth`: no user pool, so nothing but the session store signs requests. */
function makeAuth(scope: ScopeParent): Auth {
	return new Auth(scope, 'auth', {
		emailPassword: false,
		oidcProviders: { okta: { issuer: 'https://idp.example.com', clientId: 'cid' } },
	});
}

async function capturedUserAgentFor(scope: ScopeParent): Promise<string> {
	clearRouteRegistry();
	const store = sessionStore(makeAuth(scope));
	assert.ok(store.docClient, 'the session store has no SDK client: the mock entry resolved, not aws-runtime');

	let captured: string | undefined;
	store.docClient.config.requestHandler = {
		handle: async (req: { headers: Record<string, string> }) => {
			captured = req.headers['user-agent'] ?? req.headers['x-amz-user-agent'];
			throw new Error('__captured__');
		},
	};
	try {
		await store.get('probe');
	} catch (err) {
		if (!(err instanceof Error) || err.message !== '__captured__') throw err;
	}
	assert.ok(captured, 'no user-agent header was captured');
	return captured;
}

/** Whether `@aws-blocks/bb-kv-store` resolved its AWS entry (this pass runs under `aws-runtime`). */
function storeIsAws(): boolean {
	clearRouteRegistry();
	return sessionStore(makeAuth({ id: 'probe-app' })).docClient !== undefined;
}

describe('Auth session store attribution on the wire', {
	skip: !storeIsAws() && 'runs under --conditions=aws-runtime',
}, () => {
	beforeEach(() => clearRouteRegistry());

	test('the header carries core, Auth and KVStore, root-to-leaf', async () => {
		const ua = await capturedUserAgentFor({ id: 'my-app' });

		const coreAt = ua.indexOf(`aws-blocks/${CORE_VERSION}`);
		const parentAt = ua.indexOf(`bb/${BB_NAME}-${BB_VERSION}`);
		const selfAt = ua.indexOf('bb/KVStore-');

		assert.ok(coreAt >= 0, `missing core token: ${ua}`);
		assert.ok(parentAt >= 0, `missing Auth token: ${ua}`);
		assert.ok(selfAt >= 0, `missing KVStore token: ${ua}`);
		assert.ok(coreAt < parentAt && parentAt < selfAt, `chain out of root-to-leaf order: ${ua}`);
	});

	// The SDK escapes `/` to `-` inside a pair value, so the token that reaches the
	// header is `bb/Name-version`, not `bb/Name/version`.
	test('the block tokens are escaped the way the SDK renders them', async () => {
		const ua = await capturedUserAgentFor({ id: 'my-app' });

		assert.ok(ua.includes(`bb/${BB_NAME}-${BB_VERSION}`), `expected the escaped form: ${ua}`);
		assert.ok(!ua.includes(`bb/${BB_NAME}/${BB_VERSION}`), `unescaped form reached the wire: ${ua}`);
	});

	test('the app id does not reach the header', async () => {
		const ua = await capturedUserAgentFor(new Scope('customer-app-name'));

		assert.ok(!ua.includes('customer-app-name'), `app id leaked into the header: ${ua}`);
		assert.ok(ua.includes(`bb/${BB_NAME}-${BB_VERSION}`), `chain missing from the header: ${ua}`);
	});
});
