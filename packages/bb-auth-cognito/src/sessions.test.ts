// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function storePath(storeId: string): string {
	return join('.bb-data', `${ROOT.id}-${storeId}`, 'store.json');
}

/** Overwrite a stored item's `ttl` to simulate the passage of time. */
function rewriteTtl(storeId: string, sessionId: string, ttl: number): void {
	const items = storedItems(storeId);
	items[sessionId] = { ...items[sessionId], ttl };
	writeFileSync(storePath(storeId), JSON.stringify(items));
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

beforeEach(() => {
	try { rmSync('.bb-data', { recursive: true, force: true }); } catch { /* ignore */ }
});
afterEach(() => {
	try { rmSync('.bb-data', { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('SessionStore TTL', () => {
	test('createSession stamps a ttl within the configured session lifetime', async () => {
		const ttlSeconds = 3600;
		const store = new SessionStore(ROOT, 'create-ttl', ttlSeconds);

		const before = nowSeconds();
		const id = await store.createSession(recordFor('alice'));

		const item = storedItems('create-ttl')[id];
		assert.strictEqual(typeof item, 'object', 'expected a TTL-bearing entry, not a bare value');
		assert.strictEqual(typeof item.ttl, 'number');
		assert.ok(Number.isInteger(item.ttl), 'DynamoDB TTL must be an integer');
		assert.ok(
			item.ttl >= before + ttlSeconds && item.ttl <= nowSeconds() + ttlSeconds + 1,
			`ttl ${item.ttl} outside [now+${ttlSeconds}] window`,
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
		const initial = storedItems('refresh-ttl')[id].ttl;

		// Rewind the persisted expiry to prove the next write recomputes it
		// rather than leaving the original stamp in place.
		rewriteTtl('refresh-ttl', id, initial - 1200);

		const reopened = new SessionStore(ROOT, 'refresh-ttl', 3600);
		await reopened.updateSession(id, { accessToken: jwtWith({ token_use: 'access', rotated: true }) });

		const updated = storedItems('refresh-ttl')[id].ttl;
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

		const ttl = storedItems('default-ttl')[id].ttl;
		assert.ok(ttl > nowSeconds(), 'ttl must be in the future');
		assert.ok(ttl <= nowSeconds() + defaultTtl + 1, 'ttl must not exceed the session lifetime');
	});

	test('omitting ttlSeconds writes no expiry (unchanged legacy behavior)', async () => {
		const store = new SessionStore(ROOT, 'no-ttl');
		const id = await store.createSession(recordFor('alice'));

		const item = storedItems('no-ttl')[id];
		assert.strictEqual(typeof item, 'string', 'expected the bare serialized value, with no ttl attribute');
		assert.ok(await store.lookupSession(id));
	});

	test('a non-positive ttlSeconds is treated as no expiry rather than instant deletion', async () => {
		for (const [storeId, ttlSeconds] of [['zero-ttl', 0], ['negative-ttl', -1]] as const) {
			const store = new SessionStore(ROOT, storeId, ttlSeconds);
			const id = await store.createSession(recordFor('alice'));

			assert.strictEqual(typeof storedItems(storeId)[id], 'string', `${storeId}: expected no ttl attribute`);
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
});
