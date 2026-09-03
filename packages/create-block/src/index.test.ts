// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
	deriveNames,
	findCustomerWorkspaceRoot,
	findMonorepoRoot,
	insertBetweenMarkers,
	normalizeClassName,
	normalizeWorkspaces,
	parseArgs,
	run,
	scopeFromPkgName,
	substituteTokens,
	toKebabCase,
	validateClassName,
	validateScope,
	workspacesCover,
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
	test('does NOT mangle names that merely start with "Bb"', () => {
		assert.strictEqual(normalizeClassName('BBox'), 'BBox');
		assert.strictEqual(normalizeClassName('Bbox'), 'Bbox');
	});
});

describe('scope validation', () => {
	test('accepts valid npm scopes', () => {
		assert.strictEqual(validateScope('acme').ok, true);
		assert.strictEqual(validateScope('my-org').ok, true);
		assert.strictEqual(validateScope('a1._-').ok, true);
	});
	test('rejects invalid scopes', () => {
		assert.strictEqual(validateScope('Acme').ok, false); // uppercase
		assert.strictEqual(validateScope('-bad').ok, false); // leading dash
		assert.strictEqual(validateScope('has space').ok, false);
		assert.strictEqual(validateScope('has"quote').ok, false);
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
	test('rejects a value flag with no value or a flag as its value', () => {
		assert.throws(() => parseArgs(['MyBlock', '--dir', '--yes']), /--dir requires a value/);
		assert.throws(() => parseArgs(['MyBlock', '--scope']), /--scope requires a value/);
		assert.throws(() => parseArgs(['MyBlock', '--type']), /--type requires a value/);
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

describe('workspaces helpers', () => {
	test('normalizeWorkspaces handles array, object, and missing forms', () => {
		assert.deepEqual(normalizeWorkspaces(['packages/*']), ['packages/*']);
		assert.deepEqual(normalizeWorkspaces({ packages: ['apps/*', 'libs/*'] }), ['apps/*', 'libs/*']);
		assert.deepEqual(normalizeWorkspaces(undefined), []);
	});
	test('scopeFromPkgName extracts the npm scope', () => {
		assert.strictEqual(scopeFromPkgName('@acme/app'), 'acme');
		assert.strictEqual(scopeFromPkgName('plain-app'), null);
		assert.strictEqual(scopeFromPkgName(undefined), null);
	});
	test('workspacesCover matches exact entries and parent globs', () => {
		assert.strictEqual(workspacesCover(['packages/*'], 'packages/bb-foo'), true);
		assert.strictEqual(workspacesCover(['packages/**'], 'packages/bb-foo'), true);
		assert.strictEqual(workspacesCover(['packages/bb-foo'], 'packages/bb-foo'), true);
		assert.strictEqual(workspacesCover(['apps/*'], 'packages/bb-foo'), false);
		assert.strictEqual(workspacesCover([], 'packages/bb-foo'), false);
	});
});

describe('customer-mode detection', () => {
	test('detects a customer workspace (workspaces, but not the Blocks repo)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cb-cust-'));
		try {
			writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/app', workspaces: ['packages/*'] }));
			const nested = join(dir, 'src');
			mkdirSync(nested, { recursive: true });
			const found = await findCustomerWorkspaceRoot(nested);
			assert.strictEqual(found?.root, dir);
			assert.strictEqual(found?.pkg.name, '@acme/app');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test('does NOT treat the AWS Blocks monorepo as a customer workspace', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cb-blk-'));
		try {
			writeFileSync(join(dir, 'package.json'), JSON.stringify({ workspaces: ['packages/blocks'] }));
			mkdirSync(join(dir, 'packages', 'blocks'), { recursive: true });
			assert.strictEqual(await findCustomerWorkspaceRoot(dir), null);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test('returns null when there are no workspaces', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cb-none-'));
		try {
			writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'plain-app' }));
			assert.strictEqual(await findCustomerWorkspaceRoot(dir), null);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// End-to-end run() coverage for the file-writing / JSON-mutation paths that the
// pure-helper tests can't reach. Hermetic: CREATE_BLOCK_SKIP_REGISTRY avoids the
// npm-view call, and --skip-install/--skip-verify avoid shelling out.
describe('run() integration — customer mode', () => {
	function withWorkspace(fn: (dir: string) => Promise<void>) {
		return async () => {
			const dir = mkdtempSync(join(tmpdir(), 'cb-run-'));
			const prev = process.env.CREATE_BLOCK_SKIP_REGISTRY;
			process.env.CREATE_BLOCK_SKIP_REGISTRY = '1';
			try {
				await fn(dir);
			} finally {
				if (prev === undefined) delete process.env.CREATE_BLOCK_SKIP_REGISTRY;
				else process.env.CREATE_BLOCK_SKIP_REGISTRY = prev;
				rmSync(dir, { recursive: true, force: true });
			}
		};
	}

	test(
		'scaffolds packages/bb-*, links it into workspaces, substitutes tokens',
		withWorkspace(async (dir) => {
			// workspaces glob does NOT cover packages/ → the entry must be appended.
			writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/app', workspaces: ['apps/*'] }));
			const code = await run(
				['SearchCache', '--type', 'primitive', '--yes', '--skip-install', '--skip-verify'],
				dir,
			);
			assert.strictEqual(code, 0);

			const pkgDir = join(dir, 'packages', 'bb-search-cache');
			const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8'));
			assert.strictEqual(pkg.name, '@acme/bb-search-cache');
			assert.ok(pkg.keywords.includes('aws-blocks'));

			const rootWs = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')).workspaces;
			assert.ok(rootWs.includes('packages/bb-search-cache'));

			const mock = readFileSync(join(pkgDir, 'src', 'index.mock.ts'), 'utf-8');
			assert.match(mock, /class SearchCache extends Scope/);
			assert.doesNotMatch(mock, /__BB_CLASS__|__BB_PKG_NAME__/);

			// standalone build helper written; core-coupled CDK synth test omitted
			assert.ok(existsSync(join(pkgDir, 'scripts', 'generate-version.mjs')));
			assert.ok(!existsSync(join(pkgDir, 'src', 'index.cdk.test.ts')));
		}),
	);

	test(
		'does not touch workspaces when a glob already covers packages/',
		withWorkspace(async (dir) => {
			writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/app', workspaces: ['packages/*'] }));
			const code = await run(['Widget', '--yes', '--skip-install', '--skip-verify'], dir);
			assert.strictEqual(code, 0);
			assert.deepEqual(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')).workspaces, ['packages/*']);
			assert.ok(existsSync(join(dir, 'packages', 'bb-widget', 'package.json')));
		}),
	);

	test(
		'--dry-run writes nothing',
		withWorkspace(async (dir) => {
			writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/app', workspaces: ['apps/*'] }));
			const code = await run(['SearchCache', '--yes', '--dry-run'], dir);
			assert.strictEqual(code, 0);
			assert.ok(!existsSync(join(dir, 'packages')));
			assert.deepEqual(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')).workspaces, ['apps/*']);
		}),
	);
});
