// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { BLOCK_CATALOG } from './block-catalog.generated.js';
import { CONFIG_PREVIEW_LIMIT, CONFIG_PREVIEW_TRUNCATION_MARKER, discoverBlocks } from './block-discovery.js';

let tmpDir: string | undefined;

/** A temp project tree. Keys are project-relative paths; dirs are created. */
function makeProject(files: Record<string, string>): string {
	tmpDir = join(tmpdir(), `admin-ui-blocks-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tmpDir, { recursive: true });
	for (const [rel, content] of Object.entries(files)) {
		const full = join(tmpDir, rel);
		mkdirSync(join(full, '..'), { recursive: true });
		writeFileSync(full, content);
	}
	return tmpDir;
}

/**
 * Source built line by line, so a test can assert an exact 1-based line number
 * without counting a template literal's leading whitespace.
 */
function source(...lines: string[]): string {
	return lines.join('\n');
}

afterEach(() => {
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	tmpDir = undefined;
});

describe('discoverBlocks — a simple project', () => {
	it('reports type, id, fullId, category, file and line for each block', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope, KVStore, DistributedTable } from '@aws-blocks/blocks';",
				'',
				"const scope = new Scope('shop');",
				"export const store = new KVStore(scope, 'store', {});",
				"export const orders = new DistributedTable(scope, 'orders');",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.strictEqual(result.blocksSource, 'source-scan');
		assert.strictEqual(result.blocksErrorCode, undefined);
		assert.strictEqual(result.scannedFiles, 1);
		assert.deepStrictEqual(result.scope, { id: 'shop', file: 'aws-blocks/index.ts', line: 3 });
		assert.strictEqual(result.projectName, 'shop');
		assert.deepStrictEqual(result.unknownConstructs, []);
		// Whole-shape assertion on purpose: it is what caught `description` being
		// added. The description itself comes from the catalog rather than a
		// literal sentence, so editing bb-kv-store's README cannot fail this.
		assert.deepStrictEqual(result.blocks, [
			{
				type: 'KVStore',
				id: 'store',
				fullId: 'shop-store',
				category: 'data',
				description: BLOCK_CATALOG.get('KVStore')?.description,
				file: 'aws-blocks/index.ts',
				line: 4,
				configPreview: '{}',
			},
			{
				type: 'DistributedTable',
				id: 'orders',
				fullId: 'shop-orders',
				category: 'data',
				description: BLOCK_CATALOG.get('DistributedTable')?.description,
				file: 'aws-blocks/index.ts',
				line: 5,
			},
		]);
	});
});

describe('discoverBlocks — import-binding resolution (the point of this module)', () => {
	it('finds a block constructed through a namespace import (callee text `blocks.KVStore`)', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import * as blocks from '@aws-blocks/blocks';",
				'',
				"const scope = new blocks.Scope('ns-app');",
				"export const store = new blocks.KVStore(scope, 'store');",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		// Text matching against a name list would see `blocks.KVStore` and miss
		// this block entirely; resolving the namespace binding finds it.
		assert.strictEqual(result.blocks.length, 1);
		assert.strictEqual(result.blocks[0]?.type, 'KVStore');
		assert.strictEqual(result.blocks[0]?.fullId, 'ns-app-store');
		assert.strictEqual(result.scope?.id, 'ns-app');
		assert.deepStrictEqual(result.unknownConstructs, []);
	});

	it('finds an aliased import and reports the EXPORTED name as `type`', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope, KVStore as Store } from '@aws-blocks/blocks';",
				'',
				"const scope = new Scope('aliased');",
				"export const store = new Store(scope, 'cache');",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		// The callee text is `Store`, which is in no name list. The catalog
		// lookup uses the imported name, so the block is found AND typed as the
		// class it really is rather than as its local alias.
		assert.strictEqual(result.blocks.length, 1);
		assert.strictEqual(result.blocks[0]?.type, 'KVStore');
		assert.strictEqual(result.blocks[0]?.id, 'cache');
		assert.strictEqual(result.blocks[0]?.fullId, 'aliased-cache');
		assert.strictEqual(result.blocks[0]?.category, 'data');
		assert.deepStrictEqual(result.unknownConstructs, []);
	});

	it('does NOT report a locally declared class that shares a block name', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope } from '@aws-blocks/blocks';",
				'',
				"const scope = new Scope('local');",
				'',
				'class KVStore {',
				'\tconstructor(_scope: unknown, _id: string) {}',
				'}',
				'',
				"export const mine = new KVStore(scope, 'not-a-block');",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		// `KVStore` has no import binding here, so it is the user's own class.
		// Text matching would invent an AWS resource out of it.
		assert.deepStrictEqual(result.blocks, []);
		assert.deepStrictEqual(result.unknownConstructs, []);
	});

	it('ignores `new` of unrelated classes and of non-@aws-blocks imports', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope, KVStore } from '@aws-blocks/blocks';",
				"import { Client } from 'some-third-party';",
				'',
				"const scope = new Scope('mixed');",
				'export const when = new Date();',
				"export const client = new Client({ region: 'us-east-1' });",
				'export const bytes = new Map<string, number>();',
				"export const store = new KVStore(scope, 'store');",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.strictEqual(result.blocks.length, 1);
		assert.strictEqual(result.blocks[0]?.type, 'KVStore');
		assert.deepStrictEqual(result.unknownConstructs, []);
	});

	it('ignores a type-only import, which cannot be constructed', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope } from '@aws-blocks/blocks';",
				"import type { KVStore } from '@aws-blocks/bb-kv-store';",
				'',
				"const scope = new Scope('typed');",
				'declare const factory: () => KVStore;',
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.deepStrictEqual(result.blocks, []);
		assert.deepStrictEqual(result.unknownConstructs, []);
	});
});

describe('discoverBlocks — nothing block-shaped is dropped', () => {
	it('surfaces an unrecognised @aws-blocks class as unknown-type, absent from blocks', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope } from '@aws-blocks/blocks';",
				"import { VectorIndex } from '@aws-blocks/bb-vector-index';",
				'',
				"const scope = new Scope('gap');",
				"export const index = new VectorIndex(scope, 'embeddings', { dims: 1536 });",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.deepStrictEqual(result.blocks, []);
		assert.deepStrictEqual(result.unknownConstructs, [
			{ text: 'VectorIndex', file: 'aws-blocks/index.ts', line: 5, reason: 'unknown-type' },
		]);
	});

	it('reports an unrecognised class reached through a namespace import by its written text', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import * as blocks from '@aws-blocks/blocks';",
				'',
				"const scope = new blocks.Scope('gap-ns');",
				"export const thing = new blocks.SomeNewBlock(scope, 'thing');",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.deepStrictEqual(result.unknownConstructs, [
			{ text: 'blocks.SomeNewBlock', file: 'aws-blocks/index.ts', line: 4, reason: 'unknown-type' },
		]);
	});

	it('does not report an @aws-blocks construct whose call is not block-shaped', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope } from '@aws-blocks/blocks';",
				"import { DatabaseErrors } from '@aws-blocks/bb-data';",
				'',
				"const scope = new Scope('helpers');",
				"export const err = new DatabaseErrors('boom');",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.deepStrictEqual(result.blocks, []);
		assert.deepStrictEqual(result.unknownConstructs, []);
	});

	it('surfaces a known block whose id is not a string literal as non-literal-id', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope, KVStore, DistributedTable } from '@aws-blocks/blocks';",
				'',
				"const scope = new Scope('dyn');",
				"const name = 'from-variable';",
				'export const a = new KVStore(scope, name);',
				`export const b = new DistributedTable(scope, \`tpl-\${name}\`);`,
				"export const ok = new KVStore(scope, 'literal');",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.deepStrictEqual(
			result.blocks.map((block) => block.id),
			['literal'],
		);
		assert.deepStrictEqual(result.unknownConstructs, [
			{ text: 'KVStore', file: 'aws-blocks/index.ts', line: 5, reason: 'non-literal-id' },
			{ text: 'DistributedTable', file: 'aws-blocks/index.ts', line: 6, reason: 'non-literal-id' },
		]);
	});

	it('emits both blocks of a duplicate fullId rather than deduping the collision away', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope, KVStore } from '@aws-blocks/blocks';",
				'',
				"const scope = new Scope('dup');",
				"export const a = new KVStore(scope, 'store');",
				"export const b = new KVStore(scope, 'store');",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.deepStrictEqual(
			result.blocks.map((block) => `${block.fullId}@${block.line}`),
			['dup-store@4', 'dup-store@5'],
		);
	});
});

describe('discoverBlocks — which files are scanned', () => {
	it('finds blocks in a second file and excludes scripts/, the shims and .d.ts', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope, KVStore } from '@aws-blocks/blocks';",
				"const scope = new Scope('multi');",
				"export const store = new KVStore(scope, 'store');",
			),
			// Blocks may be declared in a factory helper, not just the entry file.
			'aws-blocks/tables/orders.ts': source(
				"import { DistributedTable } from '@aws-blocks/bb-distributed-table';",
				'export function makeOrders(scope: unknown) {',
				"\treturn new DistributedTable(scope, 'orders');",
				'}',
			),
			'aws-blocks/scripts/sandbox.ts': source(
				"import { KVStore } from '@aws-blocks/bb-kv-store';",
				"export const ignored = new KVStore({} as never, 'from-scripts');",
			),
			'aws-blocks/index.cdk.ts': source(
				"import { KVStore } from '@aws-blocks/bb-kv-store';",
				"export const ignored = new KVStore({} as never, 'from-cdk');",
			),
			'aws-blocks/index.handler.ts': source(
				"import { KVStore } from '@aws-blocks/bb-kv-store';",
				"export const ignored = new KVStore({} as never, 'from-handler');",
			),
			'aws-blocks/generated.d.ts': source(
				"import { KVStore } from '@aws-blocks/bb-kv-store';",
				"export const ignored = new KVStore({} as never, 'from-dts');",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.strictEqual(result.scannedFiles, 2);
		assert.deepStrictEqual(
			result.blocks.map((block) => `${block.file}:${block.id}`),
			['aws-blocks/index.ts:store', 'aws-blocks/tables/orders.ts:orders'],
		);
	});

	it('caps the scan at maxFiles and says so', () => {
		const root = makeProject({
			'aws-blocks/a.ts': source(
				"import { Scope, KVStore } from '@aws-blocks/blocks';",
				"export const scope = new Scope('capped');",
				"export const a = new KVStore(scope, 'a');",
			),
			'aws-blocks/b.ts': source(
				"import { KVStore } from '@aws-blocks/bb-kv-store';",
				"export const b = new KVStore({} as never, 'b');",
			),
			'aws-blocks/c.ts': source(
				"import { KVStore } from '@aws-blocks/bb-kv-store';",
				"export const c = new KVStore({} as never, 'c');",
			),
		});

		const uncapped = discoverBlocks({ projectRoot: root });
		assert.strictEqual(uncapped.scannedFiles, 3);
		assert.strictEqual(uncapped.blocks.length, 3);

		const capped = discoverBlocks({ projectRoot: root, maxFiles: 1 });
		assert.strictEqual(capped.scannedFiles, 1);
		assert.deepStrictEqual(
			capped.blocks.map((block) => block.id),
			['a'],
		);
		assert.match(String(capped.blocksError), /Stopped after 1 of 3 file/);
	});
});

describe('discoverBlocks — extracted fields', () => {
	/*
	 * These assert PLUMBING against the catalog, never a particular sentence.
	 * The descriptions are generated from each block package's README, so pinning
	 * one here would fail the dashboard's suite for an unrelated docs edit —
	 * a test that breaks on a correct change teaches people to ignore it.
	 */
	it('carries the catalog description onto a discovered block', () => {
		const expected = BLOCK_CATALOG.get('DistributedTable')?.description;
		assert.ok(expected, 'bb-distributed-table exports one class, so it must have a description');

		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope, DistributedTable } from '@aws-blocks/blocks';",
				'',
				"const scope = new Scope('described');",
				"export const todos = new DistributedTable(scope, 'todos');",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.strictEqual(result.blocks[0]?.description, expected);
	});

	it('omits the description for a block whose package exports several classes', () => {
		// @aws-blocks/core exports ApiNamespace and RawRoute, so its README
		// describes neither and the catalog deliberately carries no description.
		assert.strictEqual(BLOCK_CATALOG.get('ApiNamespace')?.description, undefined);

		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope, ApiNamespace } from '@aws-blocks/blocks';",
				'',
				"const scope = new Scope('undescribed');",
				"export const api = new ApiNamespace(scope, 'api', () => ({}));",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.strictEqual(result.blocks.length, 1);
		assert.ok(!('description' in result.blocks[0]), 'the key must be absent, not present-and-undefined');
	});

	it('reads ApiNamespace methods and parameter names for both declaration forms', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope, ApiNamespace } from '@aws-blocks/blocks';",
				'',
				"const scope = new Scope('api-app');",
				"export const api = new ApiNamespace(scope, 'api', (context) => ({",
				'\tasync getPage(slug, options) {',
				'\t\treturn { slug, options };',
				'\t},',
				'\tlistPages: async (limit = 10) => [limit],',
				'\tping: function (a, b) {',
				'\t\treturn [a, b];',
				'\t},',
				'}));',
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.strictEqual(result.blocks.length, 1);
		assert.deepStrictEqual(result.blocks[0]?.methods, [
			{ name: 'getPage', params: [{ name: 'slug' }, { name: 'options' }] },
			{ name: 'listPages', params: [{ name: 'limit', optional: true }] },
			{ name: 'ping', params: [{ name: 'a' }, { name: 'b' }] },
		]);
		// The handler argument is a function, not a config object.
		assert.strictEqual(result.blocks[0]?.configPreview, undefined);
	});

	it('takes the RETURNED literal of a factory handler, not the first literal it contains', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope, ApiNamespace } from '@aws-blocks/blocks';",
				'',
				"const scope = new Scope('factory');",
				"export const api = new ApiNamespace(scope, 'api', (context) => {",
				'\tconst defaults = { pageSize: 10, cache: false };',
				'\treturn {',
				'\t\tgetThing(id) {',
				'\t\t\treturn { id, defaults };',
				'\t\t},',
				'\t};',
				'});',
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		// The first object literal beneath the argument is `defaults`, whose
		// keys are not API methods. `getThing`'s own returned literal is not a
		// candidate either — the scan stops at nested function boundaries.
		assert.deepStrictEqual(result.blocks[0]?.methods, [{ name: 'getThing', params: [{ name: 'id' }] }]);
	});

	it('emits no methods rather than guessing when the returned literal is ambiguous', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope, ApiNamespace } from '@aws-blocks/blocks';",
				'',
				"const scope = new Scope('ambiguous');",
				"export const api = new ApiNamespace(scope, 'api', (context) => {",
				'\tif (context) {',
				'\t\treturn { readOnly(id) { return id; } };',
				'\t}',
				'\treturn { readWrite(id, body) { return [id, body]; } };',
				'});',
				"export const other = new ApiNamespace(scope, 'other', createHandler());",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.strictEqual(result.blocks.length, 2);
		// A guard-clause return and a fallthrough return are two different API
		// surfaces; neither is the whole truth, so no methods are claimed. Nor
		// is a handler built by a call resolvable.
		assert.strictEqual(result.blocks[0]?.methods, undefined);
		assert.strictEqual(result.blocks[1]?.methods, undefined);
	});

	it('extracts keySchema from string literals and omits it when a part is a variable', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope, DistributedTable } from '@aws-blocks/blocks';",
				'',
				"const scope = new Scope('tables');",
				"const pk = 'tenant';",
				"export const orders = new DistributedTable(scope, 'orders', {",
				"\tkey: { partitionKey: 'pk', sortKey: 'sk' },",
				'});',
				"export const users = new DistributedTable(scope, 'users', {",
				"\tkey: { partitionKey: 'pk' },",
				'});',
				"export const events = new DistributedTable(scope, 'events', { key: { partitionKey: pk } });",
				"export const audit = new DistributedTable(scope, 'audit', { key: { partitionKey: 'pk', sortKey: pk } });",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.deepStrictEqual(result.blocks[0]?.keySchema, { partitionKey: 'pk', sortKey: 'sk' });
		assert.deepStrictEqual(result.blocks[1]?.keySchema, { partitionKey: 'pk' });
		assert.strictEqual(result.blocks[2]?.keySchema, undefined);
		// A non-literal sortKey makes the whole schema unreportable — a partial
		// schema would read as "no sort key", which is a different table.
		assert.strictEqual(result.blocks[3]?.keySchema, undefined);
	});

	it('previews the config literal and truncates it at the limit with a marker', () => {
		const filler = 'x'.repeat(CONFIG_PREVIEW_LIMIT + 200);
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope, KVStore } from '@aws-blocks/blocks';",
				'',
				"const scope = new Scope('preview');",
				"export const small = new KVStore(scope, 'small', { ttlSeconds: 60 });",
				`export const big = new KVStore(scope, 'big', { note: '${filler}' });`,
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.strictEqual(result.blocks[0]?.configPreview, '{ ttlSeconds: 60 }');
		const preview = result.blocks[1]?.configPreview ?? '';
		assert.strictEqual(preview.length, CONFIG_PREVIEW_LIMIT + CONFIG_PREVIEW_TRUNCATION_MARKER.length);
		assert.ok(preview.startsWith("{ note: 'xxx"));
		assert.ok(preview.endsWith(CONFIG_PREVIEW_TRUNCATION_MARKER));
	});

	it('reports nothing about what is deployed — that join lives on the resources side', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope, KVStore } from '@aws-blocks/blocks';",
				"const scope = new Scope('declared');",
				"export const store = new KVStore(scope, 'store');",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		// Discovery is a source scan: it cannot know what exists in a stack, and it
		// must not imply otherwise. The contract used to carry a `resourceGroupIds`
		// field for this that nothing ever populated; it was removed, and the join
		// is made from `ResourceGroup.blockFullId` instead. Asserted as an absent
		// property rather than an undefined field so re-adding one is caught.
		const block = result.blocks[0] as unknown as Record<string, unknown> | undefined;
		assert.ok(block !== undefined);
		assert.strictEqual('resourceGroupIds' in (block ?? {}), false);
		assert.strictEqual('deployed' in (block ?? {}), false);
	});
});

describe('discoverBlocks — scope and project name', () => {
	it('degrades fullId to the bare id when no Scope is declared', () => {
		const root = makeProject({
			'package.json': JSON.stringify({ name: 'from-package-json' }),
			'aws-blocks/index.ts': source(
				"import { KVStore } from '@aws-blocks/bb-kv-store';",
				"export const store = new KVStore({} as never, 'store');",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.strictEqual(result.scope, undefined);
		assert.strictEqual(result.blocks[0]?.fullId, 'store');
		assert.strictEqual(result.projectName, 'from-package-json');
	});

	it('takes the first Scope deterministically when several exist', () => {
		const root = makeProject({
			'aws-blocks/a-first.ts': source(
				"import { Scope } from '@aws-blocks/core';",
				"export const one = new Scope('first');",
			),
			'aws-blocks/z-second.ts': source(
				"import { Scope } from '@aws-blocks/core';",
				"export const two = new Scope('second');",
			),
		});

		const first = discoverBlocks({ projectRoot: root });
		const again = discoverBlocks({ projectRoot: root });

		assert.strictEqual(first.scope?.id, 'first');
		assert.strictEqual(first.scope?.file, 'aws-blocks/a-first.ts');
		assert.deepStrictEqual(again.scope, first.scope);
	});

	it('falls back to the directory basename when there is no scope and no package name', () => {
		const root = makeProject({
			'aws-blocks/index.ts': 'export const nothing = 1;\n',
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.strictEqual(result.projectName, join(root).split(/[/\\]/).pop());
		assert.deepStrictEqual(result.blocks, []);
	});
});

describe('discoverBlocks — failure modes never throw', () => {
	it('reports a missing aws-blocks/ directory as unavailable', () => {
		const root = makeProject({ 'package.json': JSON.stringify({ name: 'not-blocks' }) });

		const result = discoverBlocks({ projectRoot: root });

		assert.strictEqual(result.blocksSource, 'unavailable');
		assert.strictEqual(result.blocksErrorCode, 'NOT_A_BLOCKS_PROJECT');
		assert.match(String(result.blocksError), /aws-blocks\//);
		assert.strictEqual(result.projectName, 'not-blocks');
		assert.deepStrictEqual(result.blocks, []);
		assert.deepStrictEqual(result.unknownConstructs, []);
		assert.strictEqual(result.scannedFiles, 0);
	});

	it('treats an aws-blocks FILE as not a blocks project', () => {
		const root = makeProject({ 'aws-blocks': 'not a directory\n' });

		const result = discoverBlocks({ projectRoot: root });

		assert.strictEqual(result.blocksSource, 'unavailable');
		assert.strictEqual(result.blocksErrorCode, 'NOT_A_BLOCKS_PROJECT');
	});

	it('reports PARSE_FAILED for a broken file but still returns what the others declare', () => {
		const root = makeProject({
			'aws-blocks/broken.ts': source(
				"import { KVStore } from '@aws-blocks/bb-kv-store';",
				'export const oops = new KVStore(',
			),
			'aws-blocks/index.ts': source(
				"import { Scope, KVStore } from '@aws-blocks/blocks';",
				"const scope = new Scope('resilient');",
				"export const store = new KVStore(scope, 'store');",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.strictEqual(result.blocksSource, 'source-scan');
		assert.strictEqual(result.blocksErrorCode, 'PARSE_FAILED');
		assert.match(String(result.blocksError), /aws-blocks\/broken\.ts/);
		assert.deepStrictEqual(
			result.blocks.map((block) => block.fullId),
			['resilient-store'],
		);
		assert.strictEqual(result.scannedFiles, 2);
	});

	it('does not throw for a nonexistent root, an empty tree, or maxFiles 0', () => {
		const missing = join(tmpdir(), `admin-ui-blocks-missing-${Date.now()}`);
		assert.doesNotThrow(() => discoverBlocks({ projectRoot: missing }));
		assert.strictEqual(discoverBlocks({ projectRoot: missing }).blocksErrorCode, 'NOT_A_BLOCKS_PROJECT');

		const empty = makeProject({ 'aws-blocks/.keep': '' });
		const emptyResult = discoverBlocks({ projectRoot: empty });
		assert.strictEqual(emptyResult.blocksSource, 'source-scan');
		assert.strictEqual(emptyResult.scannedFiles, 0);
		assert.deepStrictEqual(emptyResult.blocks, []);

		const zero = discoverBlocks({ projectRoot: empty, maxFiles: 0 });
		assert.strictEqual(zero.scannedFiles, 0);
		assert.deepStrictEqual(zero.blocks, []);
	});

	it('does not mutate the options object it is given', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope, KVStore } from '@aws-blocks/blocks';",
				"const scope = new Scope('pure');",
				"export const store = new KVStore(scope, 'store');",
			),
		});
		const options = { projectRoot: root, maxFiles: 50 };

		discoverBlocks(options);

		assert.deepStrictEqual(options, { projectRoot: root, maxFiles: 50 });
	});
});

describe('discoverBlocks — an AppSetting declaration', () => {
	it('derives the framework default parameter path from the scope and id', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope, AppSetting } from '@aws-blocks/blocks';",
				"const scope = new Scope('shop');",
				"export const retries = new AppSetting(scope, 'max-retries', { value: '3' });",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.deepStrictEqual(result.blocks[0]?.setting, {
			parameterName: '/shop-max-retries',
			nameSource: 'derived',
			secret: false,
			hasSchema: false,
			external: false,
		});
	});

	it('keeps an explicitly named parameter path instead of deriving one', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope, AppSetting } from '@aws-blocks/blocks';",
				"const scope = new Scope('shop');",
				"export const flag = new AppSetting(scope, 'flag', { name: '/shared/flag', value: 'on' });",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.strictEqual(result.blocks[0]?.setting?.parameterName, '/shared/flag');
		assert.strictEqual(result.blocks[0]?.setting?.nameSource, 'explicit');
	});

	/**
	 * The case that decides the editor's addressing: `fromExisting` REQUIRES an
	 * explicit name and the documented form passes a variable, so the settings
	 * that matter most are the ones a source scan cannot address. Guessing
	 * `/${fullId}` here would point the editor at a parameter that does not
	 * exist while the real one went unedited.
	 */
	it('reports a non-literal parameter name as unresolved rather than guessing', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope, AppSetting } from '@aws-blocks/blocks';",
				"const scope = new Scope('shop');",
				'const seeded = process.env.DB_PARAM as string;',
				"export const dbUrl = new AppSetting(scope, 'db-url', { name: seeded, secret: true });",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.strictEqual(result.blocks[0]?.setting?.nameSource, 'unresolved');
		assert.strictEqual(result.blocks[0]?.setting?.parameterName, undefined);
		// The flag that decides whether a value may be displayed survives an
		// unresolvable name: the two facts are read independently.
		assert.strictEqual(result.blocks[0]?.setting?.secret, true);
	});

	it('treats a secret flag it cannot evaluate as a secret', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope, AppSetting } from '@aws-blocks/blocks';",
				"const scope = new Scope('shop');",
				'const hide = true;',
				"export const a = new AppSetting(scope, 'a', { secret: hide });",
				"export const b = new AppSetting(scope, 'b', { secret: false, value: 'plain' });",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		// Fails closed: an undecidable flag masks a plain value, where the other
		// way round puts a real secret on screen.
		assert.strictEqual(result.blocks[0]?.setting?.secret, true);
		assert.strictEqual(result.blocks[1]?.setting?.secret, false);
	});

	it('records that the app validates writes against a schema', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope, AppSetting } from '@aws-blocks/blocks';",
				"import { z } from 'zod';",
				"const scope = new Scope('shop');",
				"export const limits = new AppSetting(scope, 'limits', { schema: z.object({}), value: {} });",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.strictEqual(result.blocks[0]?.setting?.hasSchema, true);
	});

	it('reports a setting declared with no options at all', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope, AppSetting } from '@aws-blocks/blocks';",
				"const scope = new Scope('shop');",
				"export const bare = new AppSetting(scope, 'bare');",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		// An absent config literal is a declaration too, so the field is set
		// with its defaults. An omitted `setting` would read as "not a setting".
		assert.deepStrictEqual(result.blocks[0]?.setting, {
			parameterName: '/shop-bare',
			nameSource: 'derived',
			secret: false,
			hasSchema: false,
			external: false,
		});
	});

	it('leaves the field off a block that is not a setting', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope, KVStore } from '@aws-blocks/blocks';",
				"const scope = new Scope('shop');",
				"export const store = new KVStore(scope, 'store', {});",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.strictEqual(result.blocks[0]?.setting, undefined);
	});
});

describe('discoverBlocks — AppSetting.fromExisting', () => {
	it('discovers a setting declared by the static factory, marked external', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope, AppSetting } from '@aws-blocks/blocks';",
				"const scope = new Scope('shop');",
				"export const dbUrl = AppSetting.fromExisting(scope, 'db-url', { name: '/seeded/db', secret: true });",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		// Before this, the walk only visited `new` expressions, so an external
		// setting was absent from the inventory entirely.
		assert.strictEqual(result.blocks.length, 1);
		assert.strictEqual(result.blocks[0]?.type, 'AppSetting');
		assert.strictEqual(result.blocks[0]?.fullId, 'shop-db-url');
		assert.deepStrictEqual(result.blocks[0]?.setting, {
			parameterName: '/seeded/db',
			nameSource: 'explicit',
			secret: true,
			hasSchema: false,
			external: true,
		});
	});

	it('discovers it through a namespace import', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import * as blocks from '@aws-blocks/blocks';",
				"const scope = new blocks.Scope('shop');",
				"export const k = blocks.AppSetting.fromExisting(scope, 'k', { name: '/seeded/k' });",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.strictEqual(result.blocks[0]?.setting?.external, true);
	});

	/**
	 * Scoped to AppSetting on purpose. `AuthCognito.fromExisting(userPoolId,
	 * clientId)` takes neither a scope nor an id, so treating every
	 * `fromExisting` as a declaration would invent a block whose id is a user
	 * pool id, or push a spurious `non-literal-id` gap into the UI.
	 */
	it('ignores another block type\u2019s fromExisting, which has a different shape', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope, AuthCognito } from '@aws-blocks/blocks';",
				"const scope = new Scope('shop');",
				"export const auth = AuthCognito.fromExisting('eu-west-1_abc', 'client123');",
			),
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.deepStrictEqual(result.blocks, []);
		assert.deepStrictEqual(result.unknownConstructs, []);
	});

	it('ignores a fromExisting on something that is not a block at all', () => {
		const root = makeProject({
			'aws-blocks/index.ts': source(
				"import { Scope } from '@aws-blocks/blocks';",
				"import { Thing } from './thing.js';",
				"const scope = new Scope('shop');",
				"export const t = Thing.fromExisting(scope, 't', { name: '/x' });",
			),
			'aws-blocks/thing.ts': 'export const Thing = { fromExisting: () => 1 };',
		});

		const result = discoverBlocks({ projectRoot: root });

		assert.deepStrictEqual(result.blocks, []);
		assert.deepStrictEqual(result.unknownConstructs, []);
	});
});
