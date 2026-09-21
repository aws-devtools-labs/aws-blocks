// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Scope } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { KVStore } from './index.aws.js';
import { BB_NAME, BB_VERSION } from './version.js';
import { CORE_VERSION } from '@aws-blocks/core/version';

/**
 * Integration tests that instantiate the REAL KVStore class and verify
 * the DynamoDB client's customUserAgent is configured correctly.
 *
 * We access the private `docClient` property to inspect the resolved
 * AWS SDK config. This directly tests the production code path:
 * KVStore constructor → buildUserAgentChain() → DynamoDBClient config.
 */

/** Helper: extract customUserAgent from a real KVStore instance */
function getCustomUserAgent(store: KVStore): [string, string][] {
	return (store as any).docClient.config.customUserAgent;
}

/** A parent Building Block (simulates AuthBasic composing KVStore) */
class ParentAuthBB extends Scope {
	constructor(parent: ScopeParent, id: string) {
		super(id, { parent, bbName: 'AuthBasic', bbVersion: '1.0.1' });
	}
}

/** An official grandparent Building Block (in OFFICIAL_BB_NAMES) for deep nesting tests */
class GrandparentAgentBB extends Scope {
	constructor(parent: ScopeParent, id: string) {
		super(id, { parent, bbName: 'Agent', bbVersion: '2.0.0' });
	}
}

/** A custom (non-official) grandparent BB — its name must never appear in user-agent telemetry */
class GrandparentCustomBB extends Scope {
	constructor(parent: ScopeParent, id: string) {
		super(id, { parent, bbName: 'Platform', bbVersion: '2.0.0' });
	}
}

/** A plain scope (not a BB — no bbName/bbVersion) */
class PlainScope extends Scope {
	constructor(parent: ScopeParent, id: string) {
		super(id, { parent });
	}
}

describe('KVStore user-agent integration (real KVStore)', () => {
	test('standalone KVStore configures DynamoDB client with correct customUserAgent', () => {
		const root = { id: 'my-app' };
		const store = new KVStore(root, 'user-prefs');

		const ua = getCustomUserAgent(store);
		assert.deepStrictEqual(ua, [
			['aws-blocks', CORE_VERSION],
			['bb', `${BB_NAME}/${BB_VERSION}`],
		]);
	});

	test('KVStore nested under AuthBasic includes parent BB in customUserAgent', () => {
		const root = { id: 'my-app' };
		const auth = new ParentAuthBB(root, 'auth');
		const store = new KVStore(auth, 'session-store');

		const ua = getCustomUserAgent(store);
		assert.deepStrictEqual(ua, [
			['aws-blocks', CORE_VERSION],
			['bb', 'AuthBasic/1.0.1'],
			['bb', `${BB_NAME}/${BB_VERSION}`],
		]);
	});

	test('KVStore deeply nested under two official BBs (Agent > AuthBasic > KVStore) includes full chain', () => {
		const root = { id: 'my-app' };
		const agent = new GrandparentAgentBB(root, 'agent');
		const auth = new ParentAuthBB(agent, 'auth');
		const store = new KVStore(auth, 'deep-store');

		const ua = getCustomUserAgent(store);
		assert.deepStrictEqual(ua, [
			['aws-blocks', CORE_VERSION],
			['bb', 'Agent/2.0.0'],
			['bb', 'AuthBasic/1.0.1'],
			['bb', `${BB_NAME}/${BB_VERSION}`],
		]);
	});

	test('custom (non-official) ancestor BB is excluded from the user-agent chain', () => {
		// buildUserAgentChain only reports BBs whose name is in OFFICIAL_BB_NAMES,
		// so customer-chosen names never leak into user-agent telemetry. A custom
		// "Platform" BB wraps an official AuthBasic which wraps KVStore — only the
		// official BBs (AuthBasic, KVStore) should appear; "Platform" is dropped.
		const root = { id: 'my-app' };
		const custom = new GrandparentCustomBB(root, 'platform');
		const auth = new ParentAuthBB(custom, 'auth');
		const store = new KVStore(auth, 'deep-store');

		const ua = getCustomUserAgent(store);
		assert.deepStrictEqual(ua, [
			['aws-blocks', CORE_VERSION],
			['bb', 'AuthBasic/1.0.1'],
			['bb', `${BB_NAME}/${BB_VERSION}`],
		]);
	});

	test('KVStore with non-BB parent scope only includes itself in chain', () => {
		const root = { id: 'my-app' };
		const plain = new PlainScope(root, 'middleware');
		const store = new KVStore(plain, 'cache');

		const ua = getCustomUserAgent(store);
		assert.deepStrictEqual(ua, [
			['aws-blocks', CORE_VERSION],
			['bb', `${BB_NAME}/${BB_VERSION}`],
		]);
	});

	test('non-BB scope between two BBs is skipped in user-agent chain', () => {
		const root = { id: 'my-app' };
		const auth = new ParentAuthBB(root, 'auth');
		const middle = new PlainScope(auth, 'internal-scope');
		const store = new KVStore(middle, 'store');

		const ua = getCustomUserAgent(store);
		assert.deepStrictEqual(ua, [
			['aws-blocks', CORE_VERSION],
			['bb', 'AuthBasic/1.0.1'],
			['bb', `${BB_NAME}/${BB_VERSION}`],
		]);
	});

	test('customUserAgent values match the generated version constants', () => {
		const root = { id: 'root' };
		const store = new KVStore(root, 'test');

		const ua = getCustomUserAgent(store);
		const [awsBlocksEntry, bbEntry] = ua;

		assert.strictEqual(awsBlocksEntry[0], 'aws-blocks');
		assert.strictEqual(awsBlocksEntry[1], CORE_VERSION);
		assert.strictEqual(bbEntry[0], 'bb');
		assert.strictEqual(bbEntry[1], `KVStore/${BB_VERSION}`);

		// Verify these are real semver strings (not empty or undefined)
		assert.match(CORE_VERSION, /^\d+\.\d+\.\d+/);
		assert.match(BB_VERSION, /^\d+\.\d+\.\d+/);
		assert.strictEqual(BB_NAME, 'KVStore');
	});

	test('each KVStore instance gets its own client with correct user-agent', () => {
		const root = { id: 'my-app' };
		const store1 = new KVStore(root, 'store-a');
		const auth = new ParentAuthBB(root, 'auth');
		const store2 = new KVStore(auth, 'store-b');

		const ua1 = getCustomUserAgent(store1);
		const ua2 = getCustomUserAgent(store2);

		// Standalone: only self
		assert.strictEqual(ua1.length, 2);
		assert.deepStrictEqual(ua1[0], ['aws-blocks', CORE_VERSION]);
		assert.deepStrictEqual(ua1[1], ['bb', `${BB_NAME}/${BB_VERSION}`]);

		// Nested under AuthBasic: parent + self
		assert.strictEqual(ua2.length, 3);
		assert.deepStrictEqual(ua2[0], ['aws-blocks', CORE_VERSION]);
		assert.deepStrictEqual(ua2[1], ['bb', 'AuthBasic/1.0.1']);
		assert.deepStrictEqual(ua2[2], ['bb', `${BB_NAME}/${BB_VERSION}`]);
	});
});

/**
 * Proves the base-client middleware fires through the DynamoDBDocumentClient
 * wrapper, appending the per-request token to the outgoing DynamoDB user-agent.
 */
describe('KVStore forwards the native client user-agent on outgoing requests', () => {
	const STORE_KEY = '__BLOCKS_REQUEST_CLIENT_USER_AGENT_STORE__';

	// Drive one GetItem, capture the built user-agent at the request handler,
	// then abort before the network. Region and dummy creds let auth resolve.
	async function capturedUserAgentFor(id: string, token: string | undefined): Promise<string | undefined> {
		const prevEnv = { ...process.env };
		process.env.AWS_REGION = 'us-east-1';
		process.env.AWS_ACCESS_KEY_ID = 'AKIDTEST';
		process.env.AWS_SECRET_ACCESS_KEY = 'secret';
		const als = new AsyncLocalStorage<string | undefined>();
		(globalThis as any)[STORE_KEY] = als;
		let captured: string | undefined;
		try {
			const store = new KVStore({ id: 'my-app' }, id);
			(store as any).docClient.config.requestHandler = {
				handle: async (req: any) => {
					captured = req.headers['user-agent'] ?? req.headers['x-amz-user-agent'];
					throw new Error('__captured__');
				},
			};
			await als.run(token, async () => {
				try {
					await store.get('probe');
				} catch (err) {
					if (!(err instanceof Error) || err.message !== '__captured__') throw err;
				}
			});
		} finally {
			delete (globalThis as any)[STORE_KEY];
			process.env = prevEnv;
		}
		return captured;
	}

	test('appends the request-scoped token to the outgoing user-agent header', async () => {
		const ua = await capturedUserAgentFor('ua-store', 'client/swift/9.9.9');
		assert.match(ua ?? '', / client\/swift\/9\.9\.9$/);
	});

	test('does not append a native token when none is set for the request', async () => {
		const ua = await capturedUserAgentFor('ua-store-none', undefined);
		assert.ok(ua && ua.length > 0, 'user-agent header should still be present');
		assert.doesNotMatch(ua ?? '', /client\/[a-z]+\//);
	});
});
