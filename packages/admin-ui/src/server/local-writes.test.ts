// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { BlockKeySchema } from '../contract/v1.js';
import { readLocalData } from './bb-data.js';
import type { LocalDevServerStatus } from './detect.js';
import { deleteLocalRecord, type LocalWriteContext, putLocalRecord } from './local-writes.js';

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
	tempRoots.length = 0;
});

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), 'local-writes-test-'));
	tempRoots.push(root);
	return root;
}

/** Writes `<root>/.bb-data/<store>/<file>`. A string `content` is written verbatim. */
function writeStore(root: string, store: string, file: string, content: unknown): string {
	const dir = join(root, '.bb-data', store);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, file);
	// 2-space indent + trailing newline, matching what the dev server writes, so
	// the preservation assertions below are meaningful.
	const body = typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`;
	writeFileSync(path, body, 'utf-8');
	return path;
}

function readPairs(path: string): [string, unknown][] {
	return JSON.parse(readFileSync(path, 'utf-8')) as [string, unknown][];
}

const COMPOSITE: BlockKeySchema = { partitionKey: 'userId', sortKey: 'todoId' };
const SINGLE: BlockKeySchema = { partitionKey: 'id' };

/** A stopped dev server. Never opens a socket. */
function serverDown(): LocalDevServerStatus {
	return {
		serverUp: false,
		serverUrl: 'http://localhost:3000',
		port: 3000,
		portSource: 'default',
		namespaces: [],
		bbDataPresent: true,
	};
}

function serverUp(): LocalDevServerStatus {
	return { ...serverDown(), serverUp: true, namespaces: ['api'] };
}

/** A probe seam that records whether it ran. */
function probe(status: LocalDevServerStatus): { fn: LocalWriteContext['detectDevServer']; calls: () => number } {
	let calls = 0;
	return {
		fn: async () => {
			calls += 1;
			return status;
		},
		calls: () => calls,
	};
}

function contextFor(root: string, keySchema?: BlockKeySchema, store?: string): LocalWriteContext {
	const context: LocalWriteContext = {
		projectRoot: root,
		blockFullId: 'app-todos',
		detectDevServer: probe(serverDown()).fn,
	};
	if (keySchema !== undefined) context.keySchema = keySchema;
	if (store !== undefined) context.store = store;
	return context;
}

describe('putLocalRecord — create', () => {
	it('appends a new record after the existing ones', async () => {
		const root = makeRoot();
		const path = writeStore(root, 'app-todos', 'data.json', [
			[JSON.stringify(['u1', 't1']), { title: 'first' }],
			[JSON.stringify(['u1', 't2']), { title: 'second' }],
		]);

		const result = await putLocalRecord(
			contextFor(root, COMPOSITE),
			{ userId: 'u1', todoId: 't3', title: 'third' },
			'create',
		);

		assert.strictEqual(result.ok, true, result.message);
		assert.strictEqual(result.refusalCode, undefined);
		const pairs = readPairs(path);
		assert.strictEqual(pairs.length, 3);
		assert.strictEqual(pairs[2][0], JSON.stringify(['u1', 't3']));
		assert.deepStrictEqual(pairs[2][1], { userId: 'u1', todoId: 't3', title: 'third' });
		// Appended, not reordered.
		assert.deepStrictEqual(
			pairs.map(([key]) => key),
			[JSON.stringify(['u1', 't1']), JSON.stringify(['u1', 't2']), JSON.stringify(['u1', 't3'])],
		);
	});

	it('creates the first record in an empty store', async () => {
		const root = makeRoot();
		const path = writeStore(root, 'app-todos', 'data.json', []);

		const result = await putLocalRecord(contextFor(root, SINGLE), { id: 'a', title: 'only' }, 'create');

		assert.strictEqual(result.ok, true, result.message);
		assert.deepStrictEqual(readPairs(path), [[JSON.stringify(['a']), { id: 'a', title: 'only' }]]);
	});

	it('refuses a duplicate key with ALREADY_EXISTS and leaves the file untouched', async () => {
		const root = makeRoot();
		const path = writeStore(root, 'app-todos', 'data.json', [[JSON.stringify(['u1', 't1']), { title: 'first' }]]);
		const before = readFileSync(path, 'utf-8');

		const result = await putLocalRecord(
			contextFor(root, COMPOSITE),
			{ userId: 'u1', todoId: 't1', title: 'again' },
			'create',
		);

		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.refusalCode, 'ALREADY_EXISTS');
		assert.strictEqual(readFileSync(path, 'utf-8'), before);
	});

	it('matches an existing key regardless of its on-disk spacing', async () => {
		const root = makeRoot();
		// Same key, hand-formatted with a space — one canonical form, so this is
		// still a duplicate rather than a second record under a lookalike key.
		writeStore(root, 'app-todos', 'data.json', [['["u1", "t1"]', { title: 'first' }]]);

		const result = await putLocalRecord(
			contextFor(root, COMPOSITE),
			{ userId: 'u1', todoId: 't1', title: 'again' },
			'create',
		);

		assert.strictEqual(result.refusalCode, 'ALREADY_EXISTS');
	});
});

describe('putLocalRecord — edit', () => {
	it('replaces in place without reordering the other records', async () => {
		const root = makeRoot();
		const path = writeStore(root, 'app-todos', 'data.json', [
			[JSON.stringify(['u1', 't1']), { title: 'first' }],
			[JSON.stringify(['u1', 't2']), { title: 'second' }],
			[JSON.stringify(['u1', 't3']), { title: 'third' }],
		]);

		const result = await putLocalRecord(
			contextFor(root, COMPOSITE),
			{ userId: 'u1', todoId: 't2', title: 'second edited', done: true },
			'edit',
		);

		assert.strictEqual(result.ok, true, result.message);
		const pairs = readPairs(path);
		assert.deepStrictEqual(
			pairs.map(([key]) => key),
			[JSON.stringify(['u1', 't1']), JSON.stringify(['u1', 't2']), JSON.stringify(['u1', 't3'])],
		);
		assert.deepStrictEqual(pairs[1][1], { userId: 'u1', todoId: 't2', title: 'second edited', done: true });
		assert.deepStrictEqual(pairs[0][1], { title: 'first' });
		assert.deepStrictEqual(pairs[2][1], { title: 'third' });
	});

	it('preserves the original key bytes, so a numeric sort key is not restringified', async () => {
		const root = makeRoot();
		const path = writeStore(root, 'app-todos', 'data.json', [[JSON.stringify(['u1', 9]), { title: 'first' }]]);

		const result = await putLocalRecord(
			contextFor(root, COMPOSITE),
			{ userId: 'u1', todoId: '9', title: 'edited' },
			'edit',
		);

		assert.strictEqual(result.ok, true, result.message);
		assert.strictEqual(readPairs(path)[0][0], JSON.stringify(['u1', 9]));
	});

	it('refuses a missing key with NOT_FOUND and leaves the file untouched', async () => {
		const root = makeRoot();
		const path = writeStore(root, 'app-todos', 'data.json', [[JSON.stringify(['u1', 't1']), { title: 'first' }]]);
		const before = readFileSync(path, 'utf-8');

		const result = await putLocalRecord(
			contextFor(root, COMPOSITE),
			{ userId: 'u1', todoId: 'nope', title: 'x' },
			'edit',
		);

		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.refusalCode, 'NOT_FOUND');
		assert.strictEqual(readFileSync(path, 'utf-8'), before);
	});
});

describe('deleteLocalRecord', () => {
	it('removes exactly one record', async () => {
		const root = makeRoot();
		const path = writeStore(root, 'app-todos', 'data.json', [
			[JSON.stringify(['u1', 't1']), { title: 'first' }],
			[JSON.stringify(['u1', 't2']), { title: 'second' }],
			[JSON.stringify(['u1', 't3']), { title: 'third' }],
		]);

		const result = await deleteLocalRecord(contextFor(root, COMPOSITE), { userId: 'u1', todoId: 't2' });

		assert.strictEqual(result.ok, true, result.message);
		assert.deepStrictEqual(
			readPairs(path).map(([key]) => key),
			[JSON.stringify(['u1', 't1']), JSON.stringify(['u1', 't3'])],
		);
	});

	it('refuses a missing key with NOT_FOUND and leaves the file untouched', async () => {
		const root = makeRoot();
		const path = writeStore(root, 'app-todos', 'data.json', [[JSON.stringify(['u1', 't1']), { title: 'first' }]]);
		const before = readFileSync(path, 'utf-8');

		const result = await deleteLocalRecord(contextFor(root, COMPOSITE), { userId: 'u1', todoId: 'gone' });

		assert.strictEqual(result.refusalCode, 'NOT_FOUND');
		assert.strictEqual(readFileSync(path, 'utf-8'), before);
	});

	it('refuses when a key field has no value', async () => {
		const root = makeRoot();
		writeStore(root, 'app-todos', 'data.json', [[JSON.stringify(['u1', 't1']), { title: 'first' }]]);

		const result = await deleteLocalRecord(contextFor(root, COMPOSITE), { userId: 'u1' });

		assert.strictEqual(result.refusalCode, 'VALIDATION_FAILED');
	});
});

describe('the dev-server refusal', () => {
	it('refuses a put with LOCAL_SERVER_RUNNING, leaving the file byte-identical', async () => {
		const root = makeRoot();
		const path = writeStore(root, 'app-todos', 'data.json', [[JSON.stringify(['u1', 't1']), { title: 'first' }]]);
		const before = readFileSync(path, 'utf-8');

		const result = await putLocalRecord(
			{ ...contextFor(root, COMPOSITE), detectDevServer: probe(serverUp()).fn },
			{ userId: 'u1', todoId: 't9', title: 'new' },
			'create',
		);

		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.refusalCode, 'LOCAL_SERVER_RUNNING');
		// Guidance, not a failure: it must say what to do instead.
		assert.match(result.message, /Stop the dev server/);
		assert.strictEqual(readFileSync(path, 'utf-8'), before);
	});

	it('refuses a delete with LOCAL_SERVER_RUNNING, leaving the file byte-identical', async () => {
		const root = makeRoot();
		const path = writeStore(root, 'app-todos', 'data.json', [[JSON.stringify(['u1', 't1']), { title: 'first' }]]);
		const before = readFileSync(path, 'utf-8');

		const result = await deleteLocalRecord(
			{ ...contextFor(root, COMPOSITE), detectDevServer: probe(serverUp()).fn },
			{ userId: 'u1', todoId: 't1' },
		);

		assert.strictEqual(result.refusalCode, 'LOCAL_SERVER_RUNNING');
		assert.match(result.message, /RPC playground/);
		assert.strictEqual(readFileSync(path, 'utf-8'), before);
	});
});

describe('refusals that precede any write', () => {
	it('rejects a traversal-shaped blockFullId before any filesystem access', async () => {
		const root = makeRoot();
		// The probe is the first thing that would touch the filesystem, so a
		// probe that never ran proves the id guard came first.
		const guard = probe(serverDown());
		const context: LocalWriteContext = {
			projectRoot: root,
			blockFullId: '../../etc',
			keySchema: COMPOSITE,
			detectDevServer: guard.fn,
		};

		const put = await putLocalRecord(context, { userId: 'u1', todoId: 't1' }, 'create');
		const removed = await deleteLocalRecord(context, { userId: 'u1', todoId: 't1' });

		assert.strictEqual(put.refusalCode, 'VALIDATION_FAILED');
		assert.strictEqual(removed.refusalCode, 'VALIDATION_FAILED');
		assert.strictEqual(guard.calls(), 0);
		// The hostile value is not echoed back into the message.
		assert.ok(!put.message.includes('../../etc'));
	});

	it('refuses a block with no discovered key schema', async () => {
		const root = makeRoot();
		writeStore(root, 'app-todos', 'data.json', []);

		const put = await putLocalRecord(contextFor(root), { id: 'a' }, 'create');
		const removed = await deleteLocalRecord(contextFor(root), { id: 'a' });

		assert.strictEqual(put.ok, false);
		assert.strictEqual(put.refusalCode, 'VALIDATION_FAILED');
		assert.match(put.message, /key schema/);
		assert.strictEqual(removed.refusalCode, 'VALIDATION_FAILED');
	});

	it('reports VALIDATION_FAILED for an item the validator rejects', async () => {
		const root = makeRoot();
		const path = writeStore(root, 'app-todos', 'data.json', []);
		const before = readFileSync(path, 'utf-8');

		const notAnObject = await putLocalRecord(contextFor(root, SINGLE), null, 'create');
		const missingKey = await putLocalRecord(contextFor(root, SINGLE), { title: 'no id' }, 'create');

		assert.strictEqual(notAnObject.refusalCode, 'VALIDATION_FAILED');
		assert.strictEqual(missingKey.refusalCode, 'VALIDATION_FAILED');
		assert.strictEqual(readFileSync(path, 'utf-8'), before);
	});

	it('refuses a non-pair store with UNSUPPORTED_STORE naming the file it found', async () => {
		const root = makeRoot();
		// An object-map store.json — readable, but with no key model to address.
		writeStore(root, 'app-todos', 'store.json', { 'sess-1': { userId: 'u1' } });

		const result = await putLocalRecord(contextFor(root, SINGLE), { id: 'a' }, 'create');

		assert.strictEqual(result.refusalCode, 'UNSUPPORTED_STORE');
		assert.match(result.message, /store\.json/);
	});

	it('refuses a data.json that is an object map rather than pairs', async () => {
		const root = makeRoot();
		writeStore(root, 'app-todos', 'data.json', { 'sess-1': { userId: 'u1' } });

		const result = await putLocalRecord(contextFor(root, SINGLE), { id: 'a' }, 'create');

		assert.strictEqual(result.refusalCode, 'UNSUPPORTED_STORE');
	});

	it('refuses an unknown store with STORE_NOT_FOUND', async () => {
		const root = makeRoot();
		writeStore(root, 'app-todos', 'data.json', []);

		const result = await putLocalRecord(contextFor(root, SINGLE, 'app-todos-nope'), { id: 'a' }, 'create');

		assert.strictEqual(result.refusalCode, 'STORE_NOT_FOUND');
	});

	it('refuses a block with no .bb-data store at all with STORE_NOT_FOUND', async () => {
		const root = makeRoot();

		const result = await putLocalRecord(contextFor(root, SINGLE), { id: 'a' }, 'create');

		assert.strictEqual(result.refusalCode, 'STORE_NOT_FOUND');
	});
});

describe('on-disk shape', () => {
	it('leaves valid JSON with 2-space indentation and the original trailing newline', async () => {
		const root = makeRoot();
		const path = writeStore(root, 'app-todos', 'data.json', [[JSON.stringify(['u1', 't1']), { title: 'first' }]]);

		await putLocalRecord(contextFor(root, COMPOSITE), { userId: 'u1', todoId: 't2', title: 'second' }, 'create');

		const raw = readFileSync(path, 'utf-8');
		const parsed = JSON.parse(raw);
		assert.strictEqual(raw, `${JSON.stringify(parsed, null, 2)}\n`);
		assert.ok(raw.includes('\n  ['), 'expected 2-space indented entries');
	});

	it('does not add a trailing newline to a file that had none', async () => {
		const root = makeRoot();
		const path = writeStore(
			root,
			'app-todos',
			'data.json',
			JSON.stringify([[JSON.stringify(['u1', 't1']), { title: 'first' }]], null, 2),
		);

		await putLocalRecord(contextFor(root, COMPOSITE), { userId: 'u1', todoId: 't2', title: 'second' }, 'create');

		assert.strictEqual(readFileSync(path, 'utf-8').endsWith('\n'), false);
	});

	it('does not leave a temp file behind', async () => {
		const root = makeRoot();
		writeStore(root, 'app-todos', 'data.json', []);

		await putLocalRecord(contextFor(root, SINGLE), { id: 'a' }, 'create');

		// A leftover temp file would show up as a second store candidate.
		const page = readLocalData({ projectRoot: root, blockFullId: 'app-todos' });
		assert.deepStrictEqual(
			page.stores.map((store) => store.id),
			['app-todos'],
		);
		assert.match(page.stores[0].label, /data\.json/);
	});
});

describe('key round-trips through the reader', () => {
	it('writes a composite key the reader decodes back to the same key values', async () => {
		const root = makeRoot();
		writeStore(root, 'app-todos', 'data.json', []);

		await putLocalRecord(
			contextFor(root, COMPOSITE),
			{ userId: 'u1', todoId: 't9', title: 'round trip' },
			'create',
		);

		const page = readLocalData({ projectRoot: root, blockFullId: 'app-todos', keySchema: COMPOSITE });
		assert.deepStrictEqual(page.keyFields, ['userId', 'todoId']);
		assert.deepStrictEqual(page.records[0]?.keyValues, { userId: 'u1', todoId: 't9' });
		assert.strictEqual(page.totalRecords, 1);
	});

	it('writes a single key the reader decodes back to the same key values', async () => {
		const root = makeRoot();
		writeStore(root, 'app-todos', 'data.json', []);

		await putLocalRecord(contextFor(root, SINGLE), { id: 'only', title: 'round trip' }, 'create');

		const page = readLocalData({ projectRoot: root, blockFullId: 'app-todos', keySchema: SINGLE });
		assert.deepStrictEqual(page.keyFields, ['id']);
		assert.deepStrictEqual(page.records[0]?.keyValues, { id: 'only' });
	});

	it('survives a create, edit and delete cycle', async () => {
		const root = makeRoot();
		const path = writeStore(root, 'app-todos', 'data.json', []);
		const context = contextFor(root, SINGLE);

		assert.strictEqual((await putLocalRecord(context, { id: 'a', n: 1 }, 'create')).ok, true);
		assert.strictEqual((await putLocalRecord(context, { id: 'b', n: 2 }, 'create')).ok, true);
		assert.strictEqual((await putLocalRecord(context, { id: 'a', n: 99 }, 'edit')).ok, true);
		assert.strictEqual((await deleteLocalRecord(context, { id: 'b' })).ok, true);

		assert.deepStrictEqual(readPairs(path), [[JSON.stringify(['a']), { id: 'a', n: 99 }]]);
	});
});
