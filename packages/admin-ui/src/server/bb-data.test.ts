// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { isSafeBlockFullId, listLocalStores, readLocalData } from './bb-data.js';
import { encodeCursor } from './data-cursor.js';
import { REDACTED } from './redact.js';

/** Every temp tree built by a test, torn down after it. */
const tempRoots: string[] = [];

function makeRoot(prefix = 'bb-data-test-'): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

/** Writes `<root>/.bb-data/<storeName>/<fileName>`. A string `content` is written verbatim. */
function writeStore(root: string, storeName: string, fileName: string, content: unknown): void {
	const dir = join(root, '.bb-data', storeName);
	mkdirSync(dir, { recursive: true });
	const body = typeof content === 'string' ? content : JSON.stringify(content);
	writeFileSync(join(dir, fileName), body, 'utf-8');
}

function makeBbData(root: string): string {
	const dir = join(root, '.bb-data');
	mkdirSync(dir, { recursive: true });
	return dir;
}

afterEach(() => {
	for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
	tempRoots.length = 0;
});

describe('isSafeBlockFullId', () => {
	it('accepts ordinary store names', () => {
		assert.strictEqual(isSafeBlockFullId('my-app-users'), true);
		assert.strictEqual(isSafeBlockFullId('Block_1.v2'), true);
	});

	it('rejects separators, traversal, NUL and empty', () => {
		for (const hostile of ['', '..', '../blk', 'blk/../blk', 'a/b', 'a\\b', 'blk\0', '/abs', 'a/..']) {
			assert.strictEqual(isSafeBlockFullId(hostile), false, `expected rejection: ${JSON.stringify(hostile)}`);
		}
	});
});

describe('listLocalStores', () => {
	it('returns nothing when .bb-data does not exist', () => {
		const root = makeRoot();
		assert.deepStrictEqual(listLocalStores(root, 'blk'), []);
	});

	it('returns nothing for a block that has no store directory', () => {
		const root = makeRoot();
		writeStore(root, 'other-block', 'data.json', [['k', 1]]);
		assert.deepStrictEqual(listLocalStores(root, 'blk'), []);
	});

	it('ignores a directory with no JSON file in it', () => {
		const root = makeRoot();
		const dir = join(root, '.bb-data', 'blk');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'notes.txt'), 'hello', 'utf-8');
		assert.deepStrictEqual(listLocalStores(root, 'blk'), []);
	});

	it('sorts ancillary stores last, then shorter names, then lexicographically', () => {
		const root = makeRoot();
		writeStore(root, 'myblk-codes', 'data.json', {});
		writeStore(root, 'myblk-users', 'data.json', {});
		writeStore(root, 'myblk', 'data.json', {});
		writeStore(root, 'myblk-b', 'data.json', {});
		writeStore(root, 'myblk-a', 'data.json', {});

		const ids = listLocalStores(root, 'myblk').map((store) => store.id);
		assert.deepStrictEqual(ids, ['myblk', 'myblk-a', 'myblk-b', 'myblk-users', 'myblk-codes']);
		// The ancillary store sorts after the primary even though '-codes' is
		// alphabetically first among the shards.
		assert.ok(ids.indexOf('myblk-codes') > ids.indexOf('myblk'));
		assert.strictEqual(listLocalStores(root, 'myblk')[4].ancillary, true);
	});

	it('does not treat a sibling with a different prefix as a shard', () => {
		const root = makeRoot();
		writeStore(root, 'blk', 'data.json', {});
		writeStore(root, 'blkother', 'data.json', {});
		assert.deepStrictEqual(
			listLocalStores(root, 'blk').map((store) => store.id),
			['blk'],
		);
	});

	it('prefers data.json, then store.json, then state.json, then alphabetical', () => {
		const root = makeRoot();
		writeStore(root, 'a', 'zeta.json', {});
		writeStore(root, 'a', 'state.json', {});
		writeStore(root, 'a', 'store.json', {});
		writeStore(root, 'a', 'data.json', {});
		assert.strictEqual(listLocalStores(root, 'a')[0].label, 'a (data.json)');

		const second = makeRoot();
		writeStore(second, 'a', 'state.json', {});
		writeStore(second, 'a', 'store.json', {});
		assert.strictEqual(listLocalStores(second, 'a')[0].label, 'a (store.json)');

		const third = makeRoot();
		writeStore(third, 'a', 'state.json', {});
		writeStore(third, 'a', 'zeta.json', {});
		assert.strictEqual(listLocalStores(third, 'a')[0].label, 'a (state.json)');

		const fourth = makeRoot();
		writeStore(fourth, 'a', 'zeta.json', {});
		writeStore(fourth, 'a', 'alpha.json', {});
		assert.strictEqual(listLocalStores(fourth, 'a')[0].label, 'a (alpha.json)');
	});

	it('rejects a hostile blockFullId before touching the filesystem', () => {
		const root = makeRoot();
		// This store exists and 'blk/../blk' would resolve straight to it, so an
		// empty result proves the id was refused on shape rather than resolved.
		writeStore(root, 'blk', 'data.json', [['k', 1]]);
		assert.deepStrictEqual(listLocalStores(root, 'blk'), listLocalStores(root, 'blk'));
		assert.strictEqual(listLocalStores(root, 'blk').length, 1);

		for (const hostile of ['blk/../blk', '../.bb-data/blk', 'a/b', 'a\\b', '..', 'blk\0']) {
			assert.deepStrictEqual(listLocalStores(root, hostile), [], `expected rejection: ${hostile}`);
		}
	});

	it('rejects a symlinked store that escapes the project, and keeps listing the real ones', () => {
		const root = makeRoot();
		const outside = makeRoot('bb-data-outside-');
		writeStore(root, 'blk', 'data.json', [['inside', 1]]);
		const escapeTarget = join(outside, 'stolen');
		mkdirSync(escapeTarget, { recursive: true });
		writeFileSync(join(escapeTarget, 'data.json'), JSON.stringify([['outside', 1]]), 'utf-8');

		let symlinked = true;
		try {
			symlinkSync(escapeTarget, join(makeBbData(root), 'blk-escape'), 'dir');
		} catch {
			// Platform refuses symlinks (Windows without privilege); skip this assertion.
			symlinked = false;
		}

		const ids = listLocalStores(root, 'blk').map((store) => store.id);
		assert.deepStrictEqual(ids, ['blk'], 'the contained store must still list');
		if (symlinked) assert.ok(!ids.includes('blk-escape'), 'a symlink out of the project is not a store');
	});

	it('ignores a broken symlink instead of throwing', () => {
		const root = makeRoot();
		writeStore(root, 'blk', 'data.json', [['k', 1]]);
		try {
			symlinkSync(join(root, 'does-not-exist'), join(makeBbData(root), 'blk-dangling'), 'dir');
		} catch {
			return;
		}
		assert.deepStrictEqual(
			listLocalStores(root, 'blk').map((store) => store.id),
			['blk'],
		);
	});
});

describe('readLocalData — unavailable paths', () => {
	it('reports no store when .bb-data is absent', () => {
		const root = makeRoot();
		const page = readLocalData({ projectRoot: root, blockFullId: 'blk' });
		assert.strictEqual(page.source, 'unavailable');
		assert.deepStrictEqual(page.stores, []);
		assert.strictEqual(page.records.length, 0);
		assert.strictEqual(page.totalRecords, 0);
		assert.strictEqual(page.errorCode, undefined);
		assert.ok(page.error);
	});

	it('reports no store when the block has none', () => {
		const root = makeRoot();
		writeStore(root, 'someone-else', 'data.json', {});
		const page = readLocalData({ projectRoot: root, blockFullId: 'blk' });
		assert.strictEqual(page.source, 'unavailable');
		assert.deepStrictEqual(page.stores, []);
	});

	it('refuses a hostile blockFullId without echoing it back', () => {
		const root = makeRoot();
		writeStore(root, 'blk', 'data.json', [['k', 1]]);
		const page = readLocalData({ projectRoot: root, blockFullId: 'blk/../blk' });
		assert.strictEqual(page.source, 'unavailable');
		assert.deepStrictEqual(page.stores, []);
		assert.strictEqual(page.totalRecordsExact, false);
		assert.ok(!(page.error ?? '').includes('..'));
	});

	it('gives STORE_NOT_FOUND for an unknown store instead of falling back', () => {
		const root = makeRoot();
		writeStore(root, 'blk', 'data.json', [['a', { email: 'a@b.com' }]]);
		writeStore(root, 'blk-users', 'data.json', [['u', { email: 'u@b.com' }]]);

		const page = readLocalData({ projectRoot: root, blockFullId: 'blk', store: 'blk-nope' });
		assert.strictEqual(page.source, 'unavailable');
		assert.strictEqual(page.errorCode, 'STORE_NOT_FOUND');
		assert.strictEqual(page.activeStore, undefined);
		assert.strictEqual(page.records.length, 0);
		// The stores list survives the error so the UI can still offer the real ones.
		assert.deepStrictEqual(
			page.stores.map((store) => store.id),
			['blk', 'blk-users'],
		);
	});

	it('gives UNPARSEABLE while still listing the block’s other stores', () => {
		const root = makeRoot();
		writeStore(root, 'blk', 'data.json', '{ this is not json');
		writeStore(root, 'blk-users', 'data.json', [['u1', { email: 'u@b.com' }]]);

		const page = readLocalData({ projectRoot: root, blockFullId: 'blk' });
		assert.strictEqual(page.source, 'unavailable');
		assert.strictEqual(page.errorCode, 'UNPARSEABLE');
		assert.strictEqual(page.activeStore, 'blk');
		assert.strictEqual(page.totalRecordsExact, false, 'an unread store has no exact count');
		assert.deepStrictEqual(
			page.stores.map((store) => store.id),
			['blk', 'blk-users'],
		);

		// The healthy shard is still readable.
		const healthy = readLocalData({ projectRoot: root, blockFullId: 'blk', store: 'blk-users' });
		assert.strictEqual(healthy.source, 'bb-data');
		assert.strictEqual(healthy.records.length, 1);
	});

	it('gives BAD_CURSOR for a malformed cursor', () => {
		const root = makeRoot();
		writeStore(root, 'blk', 'data.json', [['a', 1]]);
		const page = readLocalData({ projectRoot: root, blockFullId: 'blk', cursor: 'not a cursor!!' });
		assert.strictEqual(page.source, 'unavailable');
		assert.strictEqual(page.errorCode, 'BAD_CURSOR');
		assert.strictEqual(page.activeStore, 'blk');
		assert.ok(page.error);
	});

	it('rejects a cursor minted for another store', () => {
		const root = makeRoot();
		writeStore(root, 'blk', 'data.json', [['a', 1]]);
		writeStore(root, 'blk-users', 'data.json', [['u', 1]]);
		const foreign = encodeCursor({ kind: 'offset', store: 'blk-users', offset: 1 });

		const page = readLocalData({ projectRoot: root, blockFullId: 'blk', store: 'blk', cursor: foreign });
		assert.strictEqual(page.errorCode, 'BAD_CURSOR');
		assert.ok((page.error ?? '').includes('blk-users'));
	});

	it('rejects a non-offset cursor for a local store', () => {
		const root = makeRoot();
		writeStore(root, 'blk', 'data.json', [['a', 1]]);
		const wrongKind = encodeCursor({ kind: 'dynamodb', store: 'blk', lastKey: { pk: 'a' } });
		const page = readLocalData({ projectRoot: root, blockFullId: 'blk', cursor: wrongKind });
		assert.strictEqual(page.errorCode, 'BAD_CURSOR');
	});
});

describe('readLocalData — formats', () => {
	it('normalises an array of [key, item] pairs', () => {
		const root = makeRoot();
		writeStore(root, 'blk', 'data.json', [
			['["u1","t9"]', { email: 'a@b.com', visits: 2 }],
			['u2', { email: 'c@d.com', visits: 5 }],
		]);

		const page = readLocalData({ projectRoot: root, blockFullId: 'blk' });
		assert.strictEqual(page.source, 'bb-data');
		assert.strictEqual(page.activeStore, 'blk');
		assert.deepStrictEqual(
			page.records.map((record) => record.key),
			['["u1","t9"]', 'u2'],
		);
		assert.deepStrictEqual(page.records[0].value, { email: 'a@b.com', visits: 2 });
		// No key schema is available here, so no field names are invented.
		assert.deepStrictEqual(page.keyFields, []);
		assert.strictEqual(page.records[0].keyValues, undefined);
	});

	it('normalises a plain object map and names its single key field', () => {
		const root = makeRoot();
		writeStore(root, 'blk', 'store.json', { 'user-1': { visits: 1 }, 'user-2': { visits: 9 } });

		const page = readLocalData({ projectRoot: root, blockFullId: 'blk' });
		assert.deepStrictEqual(page.keyFields, ['key']);
		assert.deepStrictEqual(
			page.records.map((record) => record.key),
			['user-1', 'user-2'],
		);
		assert.deepStrictEqual(page.records[0].keyValues, { key: 'user-1' });
		assert.deepStrictEqual(page.records[1].value, { visits: 9 });
	});

	it('normalises a scalar into one record', () => {
		const root = makeRoot();
		writeStore(root, 'blk', 'data.json', 42);
		const page = readLocalData({ projectRoot: root, blockFullId: 'blk' });
		assert.strictEqual(page.records.length, 1);
		assert.strictEqual(page.records[0].key, 'value');
		assert.strictEqual(page.records[0].value, 42);
		assert.deepStrictEqual(page.keyFields, []);
	});

	it('normalises an array of non-pairs by index', () => {
		const root = makeRoot();
		writeStore(root, 'blk', 'data.json', [{ visits: 1 }, { visits: 2 }, { visits: 3 }]);
		const page = readLocalData({ projectRoot: root, blockFullId: 'blk' });
		assert.deepStrictEqual(
			page.records.map((record) => record.key),
			['0', '1', '2'],
		);
		assert.strictEqual(page.totalRecords, 3);
	});

	it('reads an empty array as zero records rather than as an error', () => {
		const root = makeRoot();
		writeStore(root, 'blk', 'data.json', []);
		const page = readLocalData({ projectRoot: root, blockFullId: 'blk' });
		assert.strictEqual(page.source, 'bb-data');
		assert.strictEqual(page.totalRecords, 0);
		assert.strictEqual(page.totalRecordsExact, true);
		assert.strictEqual(page.nextCursor, undefined);
	});

	it('unwraps JSON-in-string one level only', () => {
		const root = makeRoot();
		writeStore(root, 'blk', 'data.json', [
			[
				'u1',
				{
					profile: JSON.stringify({ nested: JSON.stringify({ deep: 1 }) }),
					list: '[1,2]',
					plain: 'not json',
					broken: '{ nope',
					padded: '  {"ok":true}  ',
				},
			],
		]);

		const page = readLocalData({ projectRoot: root, blockFullId: 'blk' });
		const value = page.records[0].value as Record<string, unknown>;
		// One level: the outer string parsed...
		assert.deepStrictEqual(value.profile, { nested: '{"deep":1}' });
		// ...and the inner one is left as a string, not parsed again.
		assert.strictEqual(typeof (value.profile as Record<string, unknown>).nested, 'string');
		assert.deepStrictEqual(value.list, [1, 2]);
		assert.strictEqual(value.plain, 'not json');
		assert.strictEqual(value.broken, '{ nope', 'unparseable JSON-in-string falls back to the raw string');
		assert.deepStrictEqual(value.padded, { ok: true });
	});

	it('honours an explicitly selected store', () => {
		const root = makeRoot();
		writeStore(root, 'blk', 'data.json', [['primary', { visits: 1 }]]);
		writeStore(root, 'blk-users', 'data.json', [['shard', { visits: 2 }]]);

		const page = readLocalData({ projectRoot: root, blockFullId: 'blk', store: 'blk-users' });
		assert.strictEqual(page.activeStore, 'blk-users');
		assert.deepStrictEqual(
			page.records.map((record) => record.key),
			['shard'],
		);
	});

	it('defaults to the first store, which is never the ancillary one', () => {
		const root = makeRoot();
		writeStore(root, 'blk-codes', 'data.json', {});
		writeStore(root, 'blk', 'data.json', [['primary', { visits: 1 }]]);
		const page = readLocalData({ projectRoot: root, blockFullId: 'blk' });
		assert.strictEqual(page.activeStore, 'blk');
		assert.strictEqual(page.records.length, 1);
	});
});

describe('readLocalData — redaction', () => {
	it('reports redacted true and masks the value when a record holds a credential', () => {
		const root = makeRoot();
		writeStore(root, 'blk', 'data.json', [
			['u1', { email: 'a@b.com', password: 'hunter2' }],
			['u2', { email: 'c@d.com' }],
		]);

		const page = readLocalData({ projectRoot: root, blockFullId: 'blk' });
		assert.strictEqual(page.redacted, true);
		assert.strictEqual(page.records[0].redacted, true);
		assert.strictEqual((page.records[0].value as Record<string, unknown>).password, REDACTED);
		assert.strictEqual((page.records[0].value as Record<string, unknown>).email, 'a@b.com');
		// Per-record flags are independent: the clean record is not marked.
		assert.strictEqual(page.records[1].redacted, false);
	});

	it('reports redacted false for a clean store', () => {
		const root = makeRoot();
		writeStore(root, 'blk', 'data.json', [['u1', { email: 'a@b.com', visits: 3 }]]);
		const page = readLocalData({ projectRoot: root, blockFullId: 'blk' });
		assert.strictEqual(page.redacted, false);
		assert.strictEqual(page.records[0].redacted, false);
	});

	it('redacts a credential hidden inside an unwrapped JSON string', () => {
		const root = makeRoot();
		writeStore(root, 'blk', 'data.json', [['u1', { profile: JSON.stringify({ secretKey: 'abc' }) }]]);
		const page = readLocalData({ projectRoot: root, blockFullId: 'blk' });
		const profile = (page.records[0].value as Record<string, unknown>).profile as Record<string, unknown>;
		assert.strictEqual(profile.secretKey, REDACTED);
		assert.strictEqual(page.redacted, true);
	});
});

describe('readLocalData — pagination', () => {
	function sevenRecords(root: string): void {
		const pairs = Array.from({ length: 7 }, (_unused, index) => [`k${index}`, { visits: index }]);
		writeStore(root, 'blk', 'data.json', pairs);
	}

	it('pages through a store in three pages, the last with no nextCursor', () => {
		const root = makeRoot();
		sevenRecords(root);

		const first = readLocalData({ projectRoot: root, blockFullId: 'blk', limit: 3 });
		assert.deepStrictEqual(
			first.records.map((record) => record.key),
			['k0', 'k1', 'k2'],
		);
		assert.ok(first.nextCursor);

		const second = readLocalData({ projectRoot: root, blockFullId: 'blk', limit: 3, cursor: first.nextCursor });
		assert.deepStrictEqual(
			second.records.map((record) => record.key),
			['k3', 'k4', 'k5'],
		);
		assert.ok(second.nextCursor);

		const third = readLocalData({ projectRoot: root, blockFullId: 'blk', limit: 3, cursor: second.nextCursor });
		assert.deepStrictEqual(
			third.records.map((record) => record.key),
			['k6'],
		);
		assert.strictEqual(third.nextCursor, undefined, 'the last page must not advertise another');
	});

	it('reports an exact total unaffected by limit', () => {
		const root = makeRoot();
		sevenRecords(root);

		for (const limit of [1, 3, 7, 100, undefined]) {
			const page = readLocalData({ projectRoot: root, blockFullId: 'blk', limit });
			assert.strictEqual(page.totalRecords, 7, `total changed at limit ${String(limit)}`);
			// We parse the whole file, so the count is a fact, not a page size.
			assert.strictEqual(page.totalRecordsExact, true);
		}
	});

	it('emits no nextCursor when the page exactly exhausts the store', () => {
		const root = makeRoot();
		sevenRecords(root);
		const page = readLocalData({ projectRoot: root, blockFullId: 'blk', limit: 7 });
		assert.strictEqual(page.records.length, 7);
		assert.strictEqual(page.nextCursor, undefined);
	});

	it('returns an empty page for an offset past the end without minting a cursor', () => {
		const root = makeRoot();
		sevenRecords(root);
		const beyond = encodeCursor({ kind: 'offset', store: 'blk', offset: 99 });
		const page = readLocalData({ projectRoot: root, blockFullId: 'blk', cursor: beyond });
		assert.strictEqual(page.source, 'bb-data');
		assert.strictEqual(page.records.length, 0);
		assert.strictEqual(page.totalRecords, 7);
		assert.strictEqual(page.nextCursor, undefined);
	});
});

/**
 * Regression suite from a live run against a real AuthBasic `state.json`: the
 * object-map flattening had moved the field name out of the value, so a short
 * secret under a telling name came back in clear. The scoping matters in both
 * directions — see the pair-format case.
 */
describe('readLocalData — the record key is a field name only for object maps', () => {
	it('masks an object-map property whose NAME looks secret', () => {
		const root = makeRoot();
		writeStore(root, 'app-auth', 'state.json', {
			sessionSecret: 's3cr3t',
			users: { 'ada@example.com': { id: 'u1' } },
		});

		const page = readLocalData({ projectRoot: root, blockFullId: 'app-auth' });
		const secret = page.records.find((record) => record.key === 'sessionSecret');
		const users = page.records.find((record) => record.key === 'users');

		assert.ok(secret, 'expected a sessionSecret record');
		assert.strictEqual(secret.value, REDACTED, 'a short secret is invisible to shape detection');
		assert.strictEqual(secret.redacted, true);
		assert.strictEqual(page.redacted, true);
		// The sibling record must be untouched: this is masking, not blanking.
		assert.ok(users);
		assert.deepStrictEqual(users.value, { 'ada@example.com': { id: 'u1' } });
		assert.strictEqual(users.redacted, false);
	});

	it('does NOT mask a pair-format record whose KEY contains a secret-ish word', () => {
		// A pair key is user data, not a field name. Masking on it would blank
		// real records whose ids happen to contain a word like `token`.
		const root = makeRoot();
		writeStore(root, 'app-store', 'data.json', [
			[JSON.stringify(['tokens', 'row-1']), { label: 'perfectly ordinary' }],
			[JSON.stringify(['sessions', 'row-2']), { label: 'also ordinary' }],
		]);

		const page = readLocalData({ projectRoot: root, blockFullId: 'app-store' });

		assert.strictEqual(page.records.length, 2);
		for (const record of page.records) {
			assert.strictEqual(record.redacted, false, record.key);
			assert.deepStrictEqual(record.value, {
				label: record.key.includes('tokens') ? 'perfectly ordinary' : 'also ordinary',
			});
		}
		assert.strictEqual(page.redacted, false);
	});

	it('resolves a serialized pair key into named fields when the schema is known', () => {
		const root = makeRoot();
		writeStore(root, 'app-todos', 'data.json', [[JSON.stringify(['u1', 't9']), { title: 'task' }]]);

		const withSchema = readLocalData({
			projectRoot: root,
			blockFullId: 'app-todos',
			keySchema: { partitionKey: 'userId', sortKey: 'todoId' },
		});
		assert.deepStrictEqual(withSchema.keyFields, ['userId', 'todoId']);
		assert.deepStrictEqual(withSchema.records[0]?.keyValues, { userId: 'u1', todoId: 't9' });

		// Without a schema nothing is invented — no labels, no keyValues.
		const withoutSchema = readLocalData({ projectRoot: root, blockFullId: 'app-todos' });
		assert.deepStrictEqual(withoutSchema.keyFields, []);
		assert.strictEqual(withoutSchema.records[0]?.keyValues, undefined);
	});

	it('leaves keyValues unset when the key arity disagrees with the schema', () => {
		const root = makeRoot();
		writeStore(root, 'app-todos', 'data.json', [[JSON.stringify(['only-one']), { title: 'task' }]]);

		const page = readLocalData({
			projectRoot: root,
			blockFullId: 'app-todos',
			keySchema: { partitionKey: 'userId', sortKey: 'todoId' },
		});
		// A half-filled key is worse than none: an edit addresses a record by these fields.
		assert.strictEqual(page.records[0]?.keyValues, undefined);
	});
});

describe('the display unwrap must not round-trip into the store', () => {
	/**
	 * Found by an audit, not by a test: the reader parses a string field that looks
	 * like JSON into a real object one level deep so it renders as a tree. The
	 * record editor seeded its textarea from what it was shown and the writer
	 * persists what it is handed — so saving ANY edit to such a record rewrote that
	 * field from a string to an object on disk. A user changing a title changed the
	 * field's type with it. This is the value-side twin of the key-side hazard D19
	 * names: the record the browser displays and the record an edit writes stop
	 * being the same record.
	 */
	const NESTED = JSON.stringify({ theme: 'dark', tabs: 3 });

	it('still unwraps for display, so the tree stays readable', () => {
		const root = makeRoot();
		writeStore(root, 'my-app-prefs', 'data.json', [['["u1"]', { userId: 'u1', prefs: NESTED }]]);

		const page = readLocalData({ projectRoot: root, blockFullId: 'my-app-prefs' });

		const value = page.records[0].value as Record<string, unknown>;
		assert.deepStrictEqual(value.prefs, { theme: 'dark', tabs: 3 });
	});

	it('also reports the value as stored, so an edit can round-trip it', () => {
		const root = makeRoot();
		writeStore(root, 'my-app-prefs', 'data.json', [['["u1"]', { userId: 'u1', prefs: NESTED }]]);

		const page = readLocalData({ projectRoot: root, blockFullId: 'my-app-prefs' });

		const stored = page.records[0].valueAsStored as Record<string, unknown>;
		// A string on disk stays a string here — that is the whole point.
		assert.strictEqual(stored.prefs, NESTED);
		assert.strictEqual(typeof stored.prefs, 'string');
	});

	it('omits it when the unwrap changed nothing, so the common record carries no extra weight', () => {
		const root = makeRoot();
		writeStore(root, 'my-app-todos', 'data.json', [['["u1"]', { userId: 'u1', title: 'plain' }]]);

		const page = readLocalData({ projectRoot: root, blockFullId: 'my-app-todos' });

		assert.strictEqual(page.records[0].valueAsStored, undefined);
	});

	it('omits it for a string that only LOOKS like JSON but does not parse', () => {
		const root = makeRoot();
		writeStore(root, 'my-app-todos', 'data.json', [['["u1"]', { userId: 'u1', note: '{not json' }]]);

		const page = readLocalData({ projectRoot: root, blockFullId: 'my-app-todos' });

		assert.strictEqual((page.records[0].value as Record<string, unknown>).note, '{not json');
		assert.strictEqual(page.records[0].valueAsStored, undefined);
	});

	it('withholds it when anything was redacted, so it cannot leak the unmasked record', () => {
		// The as-stored value is by definition pre-redaction. Sending it alongside a
		// masked `value` would hand the browser the very secret just masked.
		const root = makeRoot();
		writeStore(root, 'my-app-auth', 'state.json', {
			demo: { profile: JSON.stringify({ tier: 'pro' }), sessionSecret: 'hunter2' },
		});

		const page = readLocalData({ projectRoot: root, blockFullId: 'my-app-auth' });

		assert.strictEqual(page.records[0].redacted, true);
		assert.strictEqual(page.records[0].valueAsStored, undefined);
	});
});
