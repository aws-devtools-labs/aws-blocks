// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What a scaffolded app starts from must be true at HEAD and model the DX we
 * ask customers for. Every file under `templates/` and `resources/`:
 *
 * - names no removed Building Block (`AuthBasic`, `AuthCognito`, `AuthOIDC`,
 *   their `bb-auth-*` packages). One `Auth` block replaced them; a scaffold
 *   that still describes them sends an agent or developer down a dead path.
 *   A `MIGRATION*.md` may name them on purpose.
 * - uses no `: any` / `as any` in source. A template is the first code a
 *   customer copies; a cast there teaches the escape hatch and hides a wrong
 *   public type.
 */

import assert from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['templates', 'resources'].map((d) => join(packageRoot, d));
const SKIP_DIRS = new Set(['node_modules', 'dist', 'cdk.out', '.bb-data', '.blocks-sandbox']);
const TEXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.md', '.json', '.html', '.css', '']);
const SOURCE = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (SKIP_DIRS.has(name)) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path, out);
		else if (TEXT.has(extname(name))) out.push(path);
	}
	return out;
}

const files = ROOTS.flatMap((root) => walk(root));

/** `file:line: text` for every line of `files` matching `pattern`. */
function offenders(pattern: RegExp, include: (file: string) => boolean): string[] {
	const found: string[] = [];
	for (const file of files.filter(include)) {
		readFileSync(file, 'utf8')
			.split('\n')
			.forEach((line, i) => {
				if (pattern.test(line)) found.push(`${relative(packageRoot, file)}:${i + 1}: ${line.trim()}`);
			});
	}
	return found;
}

const REMOVED_BLOCKS = /\bAuth(?:Basic|Cognito|OIDC)\b|bb-auth-(?:basic|cognito|oidc)\b/;
const ANY_CAST = /:\s*any\b|\bas\s+any\b|<any>/;

describe('scaffold templates and resources', () => {
	it('finds the template files (guards the walk itself)', () => {
		assert.ok(
			files.some((f) => f.endsWith(join('resources', 'AGENTS.md'))),
			'resources/AGENTS.md',
		);
		assert.ok(
			files.some((f) => f.endsWith(join('templates', 'react', 'src', 'App.tsx'))),
			'react App.tsx',
		);
	});

	it('name no removed auth Building Block', () => {
		const found = offenders(REMOVED_BLOCKS, (f) => !/^MIGRATION/i.test(basename(f)));
		assert.deepStrictEqual(
			found,
			[],
			`Removed block names (use \`Auth\` from @aws-blocks/bb-auth):\n${found.join('\n')}`,
		);
	});

	it('use no `: any` / `as any` in source', () => {
		const found = offenders(ANY_CAST, (f) => SOURCE.has(extname(f)));
		assert.deepStrictEqual(found, [], `Type the value instead of casting:\n${found.join('\n')}`);
	});

	it('the patterns catch what they are for', () => {
		assert.ok(REMOVED_BLOCKS.test('`AuthBasic` without a `codeDelivery` config'));
		assert.ok(REMOVED_BLOCKS.test("import { AuthCognito } from '@aws-blocks/bb-auth-cognito';"));
		assert.ok(!REMOVED_BLOCKS.test('`--template auth-cognito` still works'), 'the former template name is fine');
		assert.ok(ANY_CAST.test('let sub: any;'));
		assert.ok(ANY_CAST.test('(window as any).addTodo = f;'));
		assert.ok(!ANY_CAST.test('const company = user.attributes.company;'));
	});
});
