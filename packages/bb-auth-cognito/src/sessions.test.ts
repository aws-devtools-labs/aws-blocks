// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, beforeEach, afterEach, after, mock } from 'node:test';
import assert from 'node:assert';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, safeStringArrayClaim, safeStringClaim } from './sessions.js';
import type { SessionRecord } from './sessions.js';

describe('safeStringClaim', () => {
	test('returns the string value when the claim is a string', () => {
		assert.strictEqual(safeStringClaim({ sub: 'abc' }, 'sub'), 'abc');
	});

	test('returns empty string when the claim is missing', () => {
		assert.strictEqual(safeStringClaim({}, 'sub'), '');
	});

	test('returns fallback when the claim is missing', () => {
		assert.strictEqual(safeStringClaim({}, 'sub', 'default'), 'default');
	});

	test('returns fallback when the claim is a number', () => {
		assert.strictEqual(safeStringClaim({ sub: 42 }, 'sub', 'default'), 'default');
	});

	test('returns fallback when the claim is an array', () => {
		assert.strictEqual(safeStringClaim({ sub: ['a'] }, 'sub', 'default'), 'default');
	});

	test('returns fallback when the claim is an object', () => {
		assert.strictEqual(safeStringClaim({ sub: { x: 1 } }, 'sub', 'default'), 'default');
	});

	test('returns fallback when the claim is null', () => {
		assert.strictEqual(safeStringClaim({ sub: null }, 'sub', 'default'), 'default');
	});
});

describe('safeStringArrayClaim', () => {
	test('returns the array when every element is a string', () => {
		assert.deepStrictEqual(
			safeStringArrayClaim({ groups: ['admin', 'editor'] }, 'groups'),
			['admin', 'editor'],
		);
	});

	test('returns empty array when the claim is missing', () => {
		assert.deepStrictEqual(safeStringArrayClaim({}, 'groups'), []);
	});

	test('returns fallback when the claim is missing', () => {
		assert.deepStrictEqual(
			safeStringArrayClaim({}, 'groups', ['default']),
			['default'],
		);
	});

	test('filters non-string entries out of a mixed-type array', () => {
		assert.deepStrictEqual(
			safeStringArrayClaim({ groups: ['admin', 1, 'editor', null, {}] }, 'groups'),
			['admin', 'editor'],
		);
	});

	test('returns fallback when the claim is not an array', () => {
		assert.deepStrictEqual(
			safeStringArrayClaim({ groups: 'admin' }, 'groups', ['fallback']),
			['fallback'],
		);
	});

	test('returns empty array when the array has no string elements', () => {
		assert.deepStrictEqual(
			safeStringArrayClaim({ groups: [1, 2, null] }, 'groups'),
			[],
		);
	});
});

// ── Session record retention (DynamoDB TTL) ─────────────────────────────────

// Session records hold live Cognito refresh tokens. Without a TTL the sessions
// table grows without bound and keeps those credentials at rest indefinitely,
// so every write must stamp an expiry bounded by the session lifetime.

const ROOT = { id: 'sessions-ttl-root' } as any;

function jwtWith(claims: Record<string, unknown>): string {
	const segment = (obj: Record<string, unknown>) =>
		Buffer.from(JSON.stringify(obj)).toString('base64url');
	return `${segment({ alg: 'none', typ: 'JWT' })}.${segment(claims)}.signature`;
}

function recordFor(username: string): SessionRecord {
	return {
		idToken: jwtWith({ sub: `sub-${username}`, 'cognito:username': username, token_use: 'id' }),
		accessToken: jwtWith({ sub: `sub-${username}`, username, token_use: 'access' }),
		refreshToken: `refresh-token-${username}`,
	};
}

/** Raw mock-store contents, so tests assert the persisted attribute directly. */
function storedItems(storeId: string): Record<string, any> {
	return JSON.parse(readFileSync(storePath(storeId), 'utf8'));
}

/** The mock keys its on-disk items by the serialized table key. */
function itemKey(sessionId: string): string {
	return JSON.stringify([sessionId]);
}

/** One persisted item: the flat record plus the block's `_bkv_` attributes. */
function storedItem(storeId: string, sessionId: string): Record<string, any> {
	return storedItems(storeId)[itemKey(sessionId)];
}

function storePath(storeId: string): string {
	return join('.bb-data', `${ROOT.id}-${storeId}`, 'store.json');
}

/** Overwrite a stored item's `_bkv_ttl` to simulate the passage of time. */
function rewriteTtl(storeId: string, sessionId: string, ttl: number): void {
	const items = storedItems(storeId);
	items[itemKey(sessionId)] = { ...items[itemKey(sessionId)], _bkv_ttl: ttl };
	writeFileSync(storePath(storeId), JSON.stringify(items));
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

/**
 * These tests assert on the mock store's persisted `_bkv_ttl` attribute, so they
 * wipe its data root between cases. The mock resolves that root from
 * `process.cwd()`, and the test runner executes files concurrently by default —
 * so wiping the shared `.bb-data` would delete directories a sibling test file
 * is actively reading. Run against a private root instead.
 */
const originalCwd = process.cwd();
const dataRoot = mkdtempSync(join(tmpdir(), 'bb-auth-cognito-sessions-'));
process.chdir(dataRoot);

after(() => {
	process.chdir(originalCwd);
	rmSync(dataRoot, { recursive: true, force: true });
});

beforeEach(() => {
	rmSync('.bb-data', { recursive: true, force: true });
});
afterEach(() => {
	rmSync('.bb-data', { recursive: true, force: true });
});

describe('SessionStore TTL', () => {
	test('createSession stamps a ttl within the configured session lifetime', async () => {
		const ttlSeconds = 3600;
		const store = new SessionStore(ROOT, 'create-ttl', ttlSeconds);

		const before = nowSeconds();
		const id = await store.createSession(recordFor('alice'));

		const item = storedItem('create-ttl', id);
		assert.strictEqual(typeof item, 'object', 'expected a stored item');
		assert.strictEqual(typeof item._bkv_ttl, 'number');
		assert.ok(Number.isInteger(item._bkv_ttl), 'DynamoDB TTL must be an integer');
		assert.ok(
			item._bkv_ttl >= before + ttlSeconds && item._bkv_ttl <= nowSeconds() + ttlSeconds + 1,
			`ttl ${item._bkv_ttl} outside [now+${ttlSeconds}] window`,
		);
	});

	test('the stored session is still readable while its ttl is in the future', async () => {
		const store = new SessionStore(ROOT, 'readable', 3600);
		const record = recordFor('alice');
		const id = await store.createSession(record);
		assert.deepStrictEqual(await store.lookupSession(id), record);
	});

	test('refresh (updateSession) slides the ttl forward', async () => {
		const store = new SessionStore(ROOT, 'refresh-ttl', 3600);
		const id = await store.createSession(recordFor('alice'));
		const initial = storedItem('refresh-ttl', id)._bkv_ttl;

		// Rewind the persisted expiry to prove the next write recomputes it
		// rather than leaving the original stamp in place.
		rewriteTtl('refresh-ttl', id, initial - 1200);

		const reopened = new SessionStore(ROOT, 'refresh-ttl', 3600);
		await reopened.updateSession(id, { accessToken: jwtWith({ token_use: 'access', rotated: true }) });

		const updated = storedItem('refresh-ttl', id)._bkv_ttl;
		assert.ok(updated > initial - 1200, `expected the ttl to move forward, got ${updated}`);
		assert.ok(updated >= nowSeconds() + 3600 - 1, `expected ~now+3600, got ${updated}`);
	});

	test('a session whose ttl has passed is no longer returned', async () => {
		const store = new SessionStore(ROOT, 'expired', 3600);
		const id = await store.createSession(recordFor('alice'));

		rewriteTtl('expired', id, nowSeconds() - 1);

		const reopened = new SessionStore(ROOT, 'expired', 3600);
		assert.strictEqual(await reopened.lookupSession(id), null);
	});

	test('the 400-day default keeps records well inside the DynamoDB TTL horizon', async () => {
		const defaultTtl = 400 * 86400;
		const store = new SessionStore(ROOT, 'default-ttl', defaultTtl);
		const id = await store.createSession(recordFor('alice'));

		const ttl = storedItem('default-ttl', id)._bkv_ttl;
		assert.ok(ttl > nowSeconds(), 'ttl must be in the future');
		assert.ok(ttl <= nowSeconds() + defaultTtl + 1, 'ttl must not exceed the session lifetime');
	});

	test('omitting ttlSeconds writes no expiry (unchanged legacy behavior)', async () => {
		const store = new SessionStore(ROOT, 'no-ttl');
		const id = await store.createSession(recordFor('alice'));

		const item = storedItem('no-ttl', id);
		assert.ok(!('_bkv_ttl' in item), 'expected no ttl attribute');
		assert.ok(await store.lookupSession(id));
	});

	test('a non-positive ttlSeconds is treated as no expiry rather than instant deletion', async () => {
		for (const [storeId, ttlSeconds] of [['zero-ttl', 0], ['negative-ttl', -1]] as const) {
			const store = new SessionStore(ROOT, storeId, ttlSeconds);
			const id = await store.createSession(recordFor('alice'));

			assert.ok(!('_bkv_ttl' in storedItem(storeId, id)), `${storeId}: expected no ttl attribute`);
			assert.ok(await store.lookupSession(id), `${storeId}: session must remain readable`);
		}
	});

	test('deleteSession and deleteByUsername still work on TTL-stamped records', async () => {
		const store = new SessionStore(ROOT, 'delete-ttl', 3600);
		const aliceOne = await store.createSession(recordFor('alice'));
		const aliceTwo = await store.createSession(recordFor('alice'));
		const bob = await store.createSession(recordFor('bob'));

		await store.deleteSession(aliceOne);
		assert.strictEqual(await store.lookupSession(aliceOne), null);

		assert.strictEqual(await store.deleteByUsername('alice'), 1);
		assert.strictEqual(await store.lookupSession(aliceTwo), null);
		assert.ok(await store.lookupSession(bob), "bob's session must survive");
	});

	test('deleteByUsername physically deletes a session past its ttl that the reaper has not collected', async () => {
		// The stale session gets a short lifetime and the others a long one. `store`
		// loads all three while they are live. The clock then moves past the stale
		// session's expiry, as when DynamoDB has not reaped an expired row yet. (The
		// mock drops an expired row when it loads its file, so the row must expire
		// while the store holds it.)
		const stale = await new SessionStore(ROOT, 'delete-expired', 60).createSession(recordFor('alice'));
		const store = new SessionStore(ROOT, 'delete-expired', 3600);
		const live = await store.createSession(recordFor('alice'));
		const bob = await store.createSession(recordFor('bob'));

		mock.timers.enable({ apis: ['Date'], now: Date.now() + 120_000 });
		try {
			assert.strictEqual(await store.lookupSession(stale), null, 'the stale session is past its ttl');
			assert.ok(itemKey(stale) in storedItems('delete-expired'), 'row is still on disk — this is the case under test');
			assert.strictEqual(await store.deleteByUsername('alice'), 2, 'revoke must count the expired row too');
		} finally {
			mock.timers.reset();
		}

		const remaining = storedItems('delete-expired');
		assert.ok(!(itemKey(stale) in remaining), 'expired row must be physically deleted, not left holding a refresh token');
		assert.ok(!(itemKey(live) in remaining));
		assert.ok(itemKey(bob) in remaining, "bob's session must survive");
	});
});

describe('SessionStore concurrent writers', () => {
	test('updateSession does not recreate a session deleted between its read and its write', async () => {
		const store = new SessionStore(ROOT, 'update-after-delete', 3600);
		const id = await store.createSession(recordFor('alice'));

		// Test seam: the store keeps its KVStore private; delete the session (as a
		// concurrent signOut would) right before the update's write lands.
		const internals = store as unknown as { kv: { put: (...args: unknown[]) => Promise<void> } };
		const kv = internals.kv;
		const realPut = kv.put.bind(kv);
		kv.put = async (...args: unknown[]) => {
			kv.put = realPut;
			await store.deleteSession(id);
			return realPut(...args);
		};
		await store.updateSession(id, { accessToken: jwtWith({ token_use: 'access', rotated: true }) });

		assert.strictEqual(await store.lookupSession(id), null);
	});
});
