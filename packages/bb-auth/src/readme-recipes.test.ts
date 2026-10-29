// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Every snippet in the README's "Recipes" section compiles against the real,
 * built packages, as an app would write it. A recipe's snippets are files of
 * one app, named by their first-line comment (`// aws-blocks/index.ts`,
 * `// src/main.ts`); the frontend's `import … from 'aws-blocks'` resolves to
 * that recipe's backend file, as the scaffolded `aws-blocks` workspace does.
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { PACKAGE_DIR, removeScratch, scratchDir, typecheck, writeFiles } from './test-support/typecheck.js';

interface Recipe {
	readonly title: string;
	readonly files: Record<string, string>;
}

/** The `### …` recipes of the README's `## Recipes` section, with their snippets by file path. */
function readRecipes(): Recipe[] {
	const md = readFileSync(join(PACKAGE_DIR, 'README.md'), 'utf8');
	const section = /^## Recipes\n([\s\S]*?)^## /m.exec(md)?.[1];
	assert.ok(section, 'README has a "## Recipes" section');
	return section
		.split(/^### /m)
		.slice(1)
		.map((chunk) => {
			const title = chunk.slice(0, chunk.indexOf('\n'));
			const files: Record<string, string> = {};
			for (const [, code] of chunk.matchAll(/```ts\n([\s\S]*?)```/g)) {
				const path = /^\/\/ (\S+\.ts)\n/.exec(code ?? '')?.[1];
				assert.ok(path, `${title}: each snippet starts with its file path, e.g. "// aws-blocks/index.ts"`);
				files[path] = code ?? '';
			}
			return { title, files };
		});
}

describe('README recipes compile', () => {
	const dirs: string[] = [];
	after(() => {
		for (const d of dirs) removeScratch(d);
	});

	const recipes = readRecipes();

	test('the recipes the README promises are there', () => {
		const titles = recipes.map((r) => r.title);
		for (const want of [/^MFA/, /^Roles/, /first admin/, /^Social sign-in/]) {
			assert.ok(
				titles.some((t) => want.test(t)),
				`a recipe matching ${want} (have: ${titles.join(' | ')})`,
			);
		}
	});

	for (const recipe of recipes) {
		test(recipe.title, () => {
			assert.ok('aws-blocks/index.ts' in recipe.files, 'has a backend file');
			const dir = scratchDir('readme-recipe');
			dirs.push(dir);
			// `export {}` keeps a snippet without imports/exports a module.
			const files = writeFiles(
				dir,
				Object.fromEntries(Object.entries(recipe.files).map(([p, code]) => [p, `${code}\nexport {};\n`])),
			);
			assert.deepStrictEqual(typecheck(files, { 'aws-blocks': [join(dir, 'aws-blocks', 'index.ts')] }), []);
		});
	}
});
