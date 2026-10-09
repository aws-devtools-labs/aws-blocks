// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { Scope } from './index.js';
import type { ScopeParent } from './index.js';
import { CORE_VERSION } from '../version.js';

/**
 * Test subclass that exposes the protected buildUserAgentChain method.
 */
class TestBB extends Scope {
	override readonly bbName?: string;
	override readonly bbVersion?: string;

	constructor(
		id: string,
		opts?: { parent?: ScopeParent; bbName?: string; bbVersion?: string },
	) {
		super(id, { parent: opts?.parent });
		this.bbName = opts?.bbName;
		this.bbVersion = opts?.bbVersion;
	}

	/** Expose protected method for testing */
	public testBuildUserAgentChain(): [string, string][] {
		return this.buildUserAgentChain();
	}
}

// ── buildUserAgentChain: standalone BB (no BB parent) ───────────────────────

describe('buildUserAgentChain', () => {
	test('standalone BB returns [aws-blocks, bb] pair', () => {
		const root = { id: 'my-app' };
		const bb = new TestBB('store', {
			parent: root,
			bbName: 'KVStore',
			bbVersion: '0.4.0',
		});

		const chain = bb.testBuildUserAgentChain();

		assert.deepStrictEqual(chain, [
			['aws-blocks', CORE_VERSION],
			['bb', 'KVStore/0.4.0'],
		]);
	});

	// ── Nested BB (one level) ─────────────────────────────────────────────

	test('BB nested inside another BB includes parent BB in chain', () => {
		const root = { id: 'my-app' };
		const parentBB = new TestBB('auth', {
			parent: root,
			bbName: 'Auth',
			bbVersion: '1.0.1',
		});
		const childBB = new TestBB('store', {
			parent: parentBB,
			bbName: 'KVStore',
			bbVersion: '0.4.0',
		});

		const chain = childBB.testBuildUserAgentChain();

		assert.deepStrictEqual(chain, [
			['aws-blocks', CORE_VERSION],
			['bb', 'Auth/1.0.1'],
			['bb', 'KVStore/0.4.0'],
		]);
	});

	// ── Deeply nested BB (2+ levels) ──────────────────────────────────────

	test('BB nested 2+ levels deep builds the full chain in root-to-leaf order', () => {
		const root = { id: 'my-app' };
		const grandparentBB = new TestBB('dashboard', {
			parent: root,
			bbName: 'Dashboard',
			bbVersion: '2.0.0',
		});
		const parentBB = new TestBB('auth', {
			parent: grandparentBB,
			bbName: 'Auth',
			bbVersion: '1.0.1',
		});
		const childBB = new TestBB('store', {
			parent: parentBB,
			bbName: 'KVStore',
			bbVersion: '0.4.0',
		});

		const chain = childBB.testBuildUserAgentChain();

		assert.deepStrictEqual(chain, [
			['aws-blocks', CORE_VERSION],
			['bb', 'Dashboard/2.0.0'],
			['bb', 'Auth/1.0.1'],
			['bb', 'KVStore/0.4.0'],
		]);
	});

	// ── Parent without BB metadata (non-BB scope in the chain) ────────────

	test('parent scope without bbName/bbVersion is skipped in chain', () => {
		const root = { id: 'my-app' };
		// A plain Scope (not a BB) in between
		const middleScope = new TestBB('middleware', {
			parent: root,
			// no bbName/bbVersion
		});
		const childBB = new TestBB('store', {
			parent: middleScope,
			bbName: 'KVStore',
			bbVersion: '0.4.0',
		});

		const chain = childBB.testBuildUserAgentChain();

		assert.deepStrictEqual(chain, [
			['aws-blocks', CORE_VERSION],
			['bb', 'KVStore/0.4.0'],
		]);
	});

	test('non-BB parent between two BBs is skipped', () => {
		const root = { id: 'my-app' };
		const parentBB = new TestBB('auth', {
			parent: root,
			bbName: 'Auth',
			bbVersion: '1.0.1',
		});
		// Plain scope between parent BB and child BB
		const middleScope = new TestBB('internal', {
			parent: parentBB,
			// no bbName/bbVersion
		});
		const childBB = new TestBB('store', {
			parent: middleScope,
			bbName: 'KVStore',
			bbVersion: '0.4.0',
		});

		const chain = childBB.testBuildUserAgentChain();

		assert.deepStrictEqual(chain, [
			['aws-blocks', CORE_VERSION],
			['bb', 'Auth/1.0.1'],
			['bb', 'KVStore/0.4.0'],
		]);
	});

	// ── Edge case: bbName set but bbVersion missing ───────────────────────

	test('self not added to chain when bbVersion is missing', () => {
		const root = { id: 'my-app' };
		const bb = new TestBB('store', {
			parent: root,
			bbName: 'KVStore',
			// bbVersion missing
		});

		const chain = bb.testBuildUserAgentChain();

		assert.deepStrictEqual(chain, [
			['aws-blocks', CORE_VERSION],
		]);
	});

	// ── Edge case: bbVersion set but bbName missing ───────────────────────

	test('self not added to chain when bbName is missing', () => {
		const root = { id: 'my-app' };
		const bb = new TestBB('store', {
			parent: root,
			// bbName missing
			bbVersion: '0.4.0',
		});

		const chain = bb.testBuildUserAgentChain();

		assert.deepStrictEqual(chain, [
			['aws-blocks', CORE_VERSION],
		]);
	});

	// ── Edge case: neither bbName nor bbVersion set ───────────────────────

	test('self not added to chain when neither bbName nor bbVersion is set', () => {
		const root = { id: 'my-app' };
		const bb = new TestBB('store', {
			parent: root,
		});

		const chain = bb.testBuildUserAgentChain();

		assert.deepStrictEqual(chain, [
			['aws-blocks', CORE_VERSION],
		]);
	});

	// ── Edge case: parent with only bbName (no bbVersion) is skipped ──────

	test('parent with bbName but no bbVersion is skipped', () => {
		const root = { id: 'my-app' };
		const parentPartial = new TestBB('partial', {
			parent: root,
			bbName: 'PartialBB',
			// bbVersion missing
		});
		const childBB = new TestBB('store', {
			parent: parentPartial,
			bbName: 'KVStore',
			bbVersion: '0.4.0',
		});

		const chain = childBB.testBuildUserAgentChain();

		assert.deepStrictEqual(chain, [
			['aws-blocks', CORE_VERSION],
			['bb', 'KVStore/0.4.0'],
		]);
	});

	// ── Verifies CORE_VERSION is used as the aws-blocks version ───────────

	test('CORE_VERSION is used as the aws-blocks version', () => {
		const root = { id: 'my-app' };
		const bb = new TestBB('store', {
			parent: root,
			bbName: 'KVStore',
			bbVersion: '1.0.0',
		});

		const chain = bb.testBuildUserAgentChain();

		assert.strictEqual(chain[0][0], 'aws-blocks');
		assert.strictEqual(chain[0][1], CORE_VERSION);
	});
});

// ── registerLambdaEventHandler: one handler per event key ───────────────────

describe('registerLambdaEventHandler', () => {
	type Handlers = Map<string, (record: unknown) => Promise<void>>;
	const GLOBAL_KEY = '__BLOCKS_LAMBDA_EVENT_HANDLERS__';
	const handlers = (): Handlers => Reflect.get(globalThis, GLOBAL_KEY);

	test('registers under `{eventSource}:{identifier}`', () => {
		Reflect.deleteProperty(globalThis, GLOBAL_KEY);
		const handler = async () => {};
		new TestBB('job', { parent: { id: 'app' } }).registerLambdaEventHandler('aws:sqs', 'queue-a', handler);
		assert.strictEqual(handlers().get('aws:sqs:queue-a'), handler);
		Reflect.deleteProperty(globalThis, GLOBAL_KEY);
	});

	test('a second handler for the same key is refused, and the first stays in place', () => {
		Reflect.deleteProperty(globalThis, GLOBAL_KEY);
		const first = async () => {};
		new TestBB('auth', { parent: { id: 'app' } }).registerLambdaEventHandler(
			'aws:cognito-idp',
			'us-east-1_Pool',
			first,
		);
		const second = new TestBB('adminauth', { parent: { id: 'app' } });
		assert.throws(
			() => second.registerLambdaEventHandler('aws:cognito-idp', 'us-east-1_Pool', async () => {}),
			(e: unknown) => {
				assert.ok(e instanceof Error);
				assert.match(e.message, /'app-adminauth'/, 'names the block that tried to register');
				assert.match(e.message, /"aws:cognito-idp:us-east-1_Pool"/, 'names the event key');
				assert.match(e.message, /already registered/);
				return true;
			},
		);
		assert.strictEqual(handlers().get('aws:cognito-idp:us-east-1_Pool'), first, 'never silently replaced');
		Reflect.deleteProperty(globalThis, GLOBAL_KEY);
	});

	test('the same identifier under another event source, or another identifier, is a different key', () => {
		Reflect.deleteProperty(globalThis, GLOBAL_KEY);
		const bb = new TestBB('multi', { parent: { id: 'app' } });
		bb.registerLambdaEventHandler('aws:sqs', 'x', async () => {});
		bb.registerLambdaEventHandler('blocks.cronjob', 'x', async () => {});
		bb.registerLambdaEventHandler('aws:sqs', 'y', async () => {});
		assert.deepStrictEqual([...handlers().keys()].sort(), ['aws:sqs:x', 'aws:sqs:y', 'blocks.cronjob:x']);
		Reflect.deleteProperty(globalThis, GLOBAL_KEY);
	});
});
