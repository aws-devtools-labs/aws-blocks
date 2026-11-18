// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The code samples of every shipped doc (the `docs/` folder gen-block-docs.mjs
 * builds, which `npm run build` refreshes), changelogs included, still match
 * the packages: see `test-support/doc-snippets.ts` for what is checked and how
 * a doc marks a block, or a whole file, as not checked.
 */

import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDocs, type DocInput, type Finding, readDoc } from './test-support/doc-snippets.js';

/** `packages/blocks`. */
const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = join(PACKAGE_DIR, 'docs');
/** Inside `dist/`, so `@aws-blocks/*` resolve through the workspace `node_modules` as an app's would. */
const SCRATCH = join(PACKAGE_DIR, 'dist', '.doc-snippets-scratch');

/** The umbrella's entries an app imports from, root first (`./docs/*` holds no code). */
function umbrellaEntries(): string[] {
	const pkg: unknown = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'));
	assert.ok(pkg && typeof pkg === 'object' && 'exports' in pkg && pkg.exports && typeof pkg.exports === 'object');
	return Object.keys(pkg.exports)
		.filter((key) => key !== './docs/*')
		.map((key) => `@aws-blocks/blocks${key.slice(1)}`);
}

/** Every shipped `*.md`, reported by its path in the repo. */
function shippedDocs(): DocInput[] {
	const docs: DocInput[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) walk(abs);
			else if (entry.name.endsWith('.md')) {
				// docs/README.md is packages/blocks/README.md; docs/<pkg>/X.md is packages/<pkg>/X.md.
				const rel = relative(DOCS_DIR, abs).split(sep).join('/');
				const source = rel.includes('/') ? `packages/${rel}` : `packages/blocks/${rel}`;
				docs.push(readDoc(abs, source));
			}
		}
	};
	walk(DOCS_DIR);
	return docs;
}

/** Known-bad (and known-good) samples, checked together with the real docs so both share one compile. */
const FIXTURE: DocInput = {
	source: 'fixture.md',
	text: [
		'## Fragment', // 1
		'```typescript', // 2: a removed block, never imported
		"const auth = new AuthBasic(scope, 'auth');",
		'```',
		'```ts', // 5: a missing export and a missing static member
		"import { NoSuchExport, isBlocksError } from '@aws-blocks/core';",
		"import { KVStore } from '@aws-blocks/bb-kv-store';",
		'KVStore.noSuchStatic();',
		'```',
		'## Fine', // 10
		'```ts', // 11: correct, listing one name from two entries
		"import { KVStore } from '@aws-blocks/bb-kv-store';",
		"import { KVStore } from '@aws-blocks/blocks';",
		"const store = new KVStore(scope, 'cache');",
		'```',
		'## App', // 16
		'```ts', // 17: a complete file with a type error
		'// aws-blocks/index.ts',
		"import { Scope } from '@aws-blocks/blocks';",
		"export const n: number = new Scope('app').fullId;",
		'```',
		'<!-- doc-snippet: skip — "before" code -->',
		'```ts', // 23: skipped
		"import { AuthBasic } from '@aws-blocks/bb-auth-basic';",
		'```',
		'<!-- doc-snippet: skip -->', // 26: no reason
		'```ts',
		'```',
		'<!-- doc-snippet: fragment — uses the scope from above -->',
		'```ts', // 30: light-checked only
		'// aws-blocks/index.ts',
		"import { Auth } from '@aws-blocks/blocks';",
		"const auth = new Auth(scope, 'auth');",
		'Auth.noSuchStatic;',
		'```',
		'## Browser', // 36
		'```ts', // 37: a browser file importing a value from the root, which has none under `browser`
		'// src/main.ts',
		"import { isBlocksError, type ScopeParent } from '@aws-blocks/blocks';",
		"import { ApiError } from '@aws-blocks/blocks/client';",
		"import type { Auth } from '@aws-blocks/blocks';",
		'```',
		'```ts', // 44: the same import in a backend file is fine
		'// aws-blocks/index.ts',
		"import { isBlocksError } from '@aws-blocks/blocks';",
		'```',
		'> **Tip:** a sample inside a blockquote is checked too:', // 47
		'> ```ts', // 48
		"> import { NoSuchQuotedExport } from '@aws-blocks/core';",
		'> ```',
		'```ts', // 51: an annotated file label is still a complete browser file
		'// src/main.ts — the browser',
		"import { isBlocksError } from '@aws-blocks/blocks';",
		"export const n: number = 'x';",
		'```',
	].join('\n'),
};

/** A doc marked `skip-file`: none of its blocks is checked, wherever the marker sits. */
const SKIPPED_FIXTURE: DocInput = {
	source: 'skipped-fixture.md',
	text: [
		'```ts',
		"import { AuthOIDC } from '@aws-blocks/bb-auth-oidc';",
		'```',
		'<!-- doc-snippet: skip-file — release notes show the API of past releases -->',
	].join('\n'),
};

function format(findings: readonly Finding[]): string {
	return findings.map((f) => `  ${f.at}  ${f.message}`).join('\n');
}

describe('shipped doc code samples', () => {
	let all: Finding[] | undefined;
	const run = (): Finding[] => {
		if (all) return all;
		const docs = shippedDocs();
		assert.ok(docs.length > 20, `found the generated docs folder (${docs.length} docs); run npm run build first`);
		all = checkDocs([...docs, FIXTURE, SKIPPED_FIXTURE], SCRATCH, umbrellaEntries());
		return all;
	};

	test('match the exports of the packages they import', () => {
		const stale = run().filter(
			(f) => !f.at.startsWith(`${FIXTURE.source}:`) && !f.at.startsWith(`${SKIPPED_FIXTURE.source}:`),
		);
		assert.strictEqual(
			stale.length,
			0,
			`${stale.length} stale code sample(s). Fix the sample, or mark an intentional one on the line above ` +
				`its fence with <!-- doc-snippet: skip — <reason> --> (not checked) or ` +
				`<!-- doc-snippet: fragment — <reason> --> (names its file but is not complete), ` +
				`or a whole doc with <!-- doc-snippet: skip-file — <reason> -->:\n${format(stale)}`,
		);
	});

	test('the check reports removed names, missing exports and broken complete files', () => {
		const findings = run();
		const at = (line: number) => findings.filter((f) => f.at === `${FIXTURE.source}:${line}`).map((f) => f.message);
		const shown = format(findings.filter((f) => f.at.startsWith(`${FIXTURE.source}:`)));

		assert.ok(
			at(2).some((m) => m.includes('`AuthBasic`')),
			shown,
		);
		assert.ok(
			at(5).some((m) => m.includes("no exported member 'NoSuchExport'")),
			shown,
		);
		assert.ok(
			at(5).some((m) => m.includes("'noSuchStatic' does not exist")),
			shown,
		);
		assert.ok(!at(5).some((m) => m.includes("member 'isBlocksError'")), shown);
		assert.deepStrictEqual(at(11), [], shown);
		assert.ok(
			at(17).some((m) => m.includes("'string' is not assignable to type 'number'")),
			shown,
		);
		assert.deepStrictEqual(at(23), [], shown);
		assert.ok(
			at(26).some((m) => m.includes('without a reason')),
			shown,
		);
		// Light-checked (the bad member), not compiled (no "Cannot find name 'scope'").
		assert.deepStrictEqual(
			at(30).map((m) => m.includes("'noSuchStatic' does not exist")),
			[true],
			shown,
		);
		// Under the `browser` condition only the root's value import fails; type-only imports and /client pass.
		const browser = at(37).filter((m) => m.includes('`browser` condition'));
		assert.deepStrictEqual(
			browser.map((m) => m.includes("no exported member 'isBlocksError'")),
			[true],
			shown,
		);
		assert.deepStrictEqual(at(44), [], shown);
		assert.ok(
			at(48).some((m) => m.includes("no exported member 'NoSuchQuotedExport'")),
			shown,
		);
		const annotated = at(51);
		assert.ok(
			annotated.some((m) => m.includes('`browser` condition') && m.includes("'isBlocksError'")),
			shown,
		);
		assert.ok(
			annotated.some((m) => m.includes("'string' is not assignable to type 'number'")),
			shown,
		);
		assert.deepStrictEqual(
			findings.filter((f) => f.at.startsWith(`${SKIPPED_FIXTURE.source}:`)),
			[],
			'a skip-file doc is not checked',
		);
	});
});
