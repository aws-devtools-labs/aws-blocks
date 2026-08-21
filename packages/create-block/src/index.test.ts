// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
	deriveNames,
	findMonorepoRoot,
	insertBetweenMarkers,
	normalizeClassName,
	parseArgs,
	substituteTokens,
	toKebabCase,
	validateClassName,
} from './index.js';

describe('name validation', () => {
	test('accepts PascalCase', () => {
		assert.strictEqual(validateClassName('SearchIndex').ok, true);
		assert.strictEqual(validateClassName('KVStore').ok, true);
	});
	test('rejects non-PascalCase', () => {
		assert.strictEqual(validateClassName('searchIndex').ok, false);
		assert.strictEqual(validateClassName('search-index').ok, false);
		assert.strictEqual(validateClassName('').ok, false);
		assert.strictEqual(validateClassName('9Lives').ok, false);
	});
	test('strips a leading BB prefix', () => {
		assert.strictEqual(normalizeClassName('BBQueue'), 'Queue');
		assert.strictEqual(normalizeClassName('bb-queue'), 'queue');
		assert.strictEqual(normalizeClassName('SearchIndex'), 'SearchIndex');
	});
});

describe('kebab derivation', () => {
	test('converts PascalCase to kebab-case', () => {
		assert.strictEqual(toKebabCase('DemoStore'), 'demo-store');
		assert.strictEqual(toKebabCase('SearchIndex'), 'search-index');
		assert.strictEqual(toKebabCase('Queue'), 'queue');
	});
	test('handles acronyms', () => {
		assert.strictEqual(toKebabCase('SQLCache'), 'sql-cache');
		assert.strictEqual(toKebabCase('HTTPQueue'), 'http-queue');
	});
});

describe('name derivation by mode', () => {
	test('contributor uses @aws-blocks scope', () => {
		const n = deriveNames('SearchIndex', 'contributor', 'ignored');
		assert.strictEqual(n.folder, 'bb-search-index');
		assert.strictEqual(n.pkgName, '@aws-blocks/bb-search-index');
	});
	test('external uses the given scope', () => {
		const n = deriveNames('SearchIndex', 'external', 'acme');
		assert.strictEqual(n.pkgName, '@acme/bb-search-index');
		assert.strictEqual(n.folder, 'bb-search-index');
	});
});

describe('token substitution', () => {
	test('replaces both tokens everywhere', () => {
		const out = substituteTokens('class __BB_CLASS__ {} // from __BB_PKG_NAME__ (__BB_CLASS__)', {
			className: 'Foo',
			pkgName: '@x/bb-foo',
		});
		assert.strictEqual(out, 'class Foo {} // from @x/bb-foo (Foo)');
	});
});

describe('marker insertion', () => {
	test('adds markers when absent and inserts the entry', () => {
		const out = insertBetweenMarkers('export const x = 1;\n', "export { Foo } from '@x/bb-foo';");
		assert.match(out, /BEGIN:generated-block-exports/);
		assert.match(out, /END:generated-block-exports/);
		assert.match(out, /export \{ Foo \} from '@x\/bb-foo';/);
	});
	test('is idempotent — inserting the same entry twice adds it once', () => {
		const entry = "export { Foo } from '@x/bb-foo';";
		const once = insertBetweenMarkers('x\n', entry);
		const twice = insertBetweenMarkers(once, entry);
		assert.strictEqual(once, twice);
		assert.strictEqual(twice.match(/@x\/bb-foo/g)?.length, 1);
	});
	test('keeps existing entries when adding a new one', () => {
		const a = insertBetweenMarkers('x\n', "export { A } from '@x/bb-a';");
		const b = insertBetweenMarkers(a, "export { B } from '@x/bb-b';");
		assert.match(b, /bb-a/);
		assert.match(b, /bb-b/);
	});
});

describe('arg parsing', () => {
	test('parses positional + flags', () => {
		const o = parseArgs(['MyBlock', '--type', 'composite', '--yes', '--dir', './x']);
		assert.strictEqual(o.className, 'MyBlock');
		assert.strictEqual(o.type, 'composite');
		assert.strictEqual(o.yes, true);
		assert.strictEqual(o.dir, './x');
	});
	test('rejects unknown flags and extra positionals', () => {
		assert.throws(() => parseArgs(['--bogus']));
		assert.throws(() => parseArgs(['A', 'B']));
	});
});

describe('mode detection', () => {
	test('detects a monorepo root by workspaces + packages/blocks', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cb-root-'));
		try {
			writeFileSync(join(dir, 'package.json'), JSON.stringify({ workspaces: ['packages/blocks'] }));
			mkdirSync(join(dir, 'packages', 'blocks'), { recursive: true });
			const nested = join(dir, 'packages', 'bb-foo', 'src');
			mkdirSync(nested, { recursive: true });
			assert.strictEqual(await findMonorepoRoot(nested), dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test('returns null outside a monorepo', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cb-ext-'));
		try {
			writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'random-app' }));
			assert.strictEqual(await findMonorepoRoot(dir), null);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
