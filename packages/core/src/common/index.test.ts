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

	/** Expose protected method for testing */
	public testFormatUserAgentString(maxBytes?: number): string {
		return maxBytes === undefined
			? this.formatUserAgentString()
			: this.formatUserAgentString(maxBytes);
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
			bbName: 'AuthBasic',
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
			['bb', 'AuthBasic/1.0.1'],
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
			bbName: 'AuthBasic',
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
			['bb', 'AuthBasic/1.0.1'],
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
			bbName: 'AuthBasic',
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
			['bb', 'AuthBasic/1.0.1'],
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

// ── formatUserAgentString: string rendering + Postgres 63-byte limit ────────

describe('formatUserAgentString', () => {
	test('renders the chain as a space-delimited string', () => {
		const root = { id: 'my-app' };
		const bb = new TestBB('db', { parent: root, bbName: 'Database', bbVersion: '0.2.6' });

		assert.strictEqual(
			bb.testFormatUserAgentString(),
			`aws-blocks/${CORE_VERSION} bb/Database/0.2.6`,
		);
	});

	test('empty chain (no official BB) renders as empty string', () => {
		const root = { id: 'my-app' };
		// A Scope with no official bbName produces a chain of just [aws-blocks/x];
		// force the fully-empty case via a subclass whose chain is empty.
		class EmptyChainBB extends TestBB {
			public override testFormatUserAgentString(): string {
				return this.formatUserAgentString();
			}
			protected override buildUserAgentChain(): [string, string][] {
				return [];
			}
		}
		const bb = new EmptyChainBB('x', { parent: root });
		assert.strictEqual(bb.testFormatUserAgentString(), '');
	});

	test('a chain within 63 bytes is returned unchanged', () => {
		const root = { id: 'my-app' };
		const auth = new TestBB('auth', { parent: root, bbName: 'AuthBasic', bbVersion: '1.0.1' });
		const db = new TestBB('db', { parent: auth, bbName: 'Database', bbVersion: '0.2.6' });

		const s = db.testFormatUserAgentString();
		assert.ok(Buffer.byteLength(s, 'utf8') <= 63);
		assert.strictEqual(s, `aws-blocks/${CORE_VERSION} bb/AuthBasic/1.0.1 bb/Database/0.2.6`);
	});

	test('a chain exceeding 63 bytes elides the middle, keeping first and leaf', () => {
		const root = { id: 'my-app' };
		// Build a deep nesting whose full render exceeds 63 bytes.
		const p1 = new TestBB('a', { parent: root, bbName: 'KnowledgeBase', bbVersion: '1.2.3' });
		const p2 = new TestBB('b', { parent: p1, bbName: 'DistributedTable', bbVersion: '4.5.6' });
		const p3 = new TestBB('c', { parent: p2, bbName: 'AuthCognito', bbVersion: '7.8.9' });
		const leaf = new TestBB('db', { parent: p3, bbName: 'Database', bbVersion: '0.2.6' });

		const full = leaf.testBuildUserAgentChain().map(([k, v]) => `${k}/${v}`).join(' ');
		assert.ok(Buffer.byteLength(full, 'utf8') > 63, 'precondition: full string must exceed 63 bytes');

		const s = leaf.testFormatUserAgentString();
		assert.ok(Buffer.byteLength(s, 'utf8') <= 63, `result must fit in 63 bytes, got ${Buffer.byteLength(s, 'utf8')}`);
		assert.strictEqual(s, `aws-blocks/${CORE_VERSION} … bb/Database/0.2.6`);
	});

	test('never truncates mid-token: result is always a fitting subset', () => {
		const root = { id: 'my-app' };
		const p1 = new TestBB('a', { parent: root, bbName: 'KnowledgeBase', bbVersion: '10.20.30' });
		const p2 = new TestBB('b', { parent: p1, bbName: 'DistributedDatabase', bbVersion: '10.20.30' });
		const leaf = new TestBB('db', { parent: p2, bbName: 'Database', bbVersion: '10.20.30' });

		const s = leaf.testFormatUserAgentString();
		assert.ok(Buffer.byteLength(s, 'utf8') <= 63);
		// Every space-separated token is a complete, well-formed entry (no partial tail).
		for (const tok of s.split(' ')) {
			assert.ok(tok === '…' || /^[a-z-]+\/\S+$/.test(tok), `token "${tok}" is malformed`);
		}
	});
});
