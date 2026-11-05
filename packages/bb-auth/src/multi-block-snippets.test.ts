// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Every documented snippet that constructs two `Auth` blocks loads in the mock
 * runtime, as `npm run dev` would load it. Compiling is not enough: two blocks
 * with `providers` on the default `redirects` type-check, then refuse to load
 * because their sign-in routes collide. Each snippet runs in its own process,
 * so the route registry starts empty.
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import ts from 'typescript';
import { PACKAGE_DIR, REPO_ROOT, removeScratch, scratchDir, typecheck, writeFiles } from './test-support/typecheck.js';

/** The docs that show an app with two `Auth` blocks; pending changesets are scanned too (they are consumed on release). */
const DOCS = [
	join(PACKAGE_DIR, 'README.md'),
	join(PACKAGE_DIR, 'MIGRATION.md'),
	join(REPO_ROOT, 'packages', 'foundations', 'README.md'),
];
const CHANGESETS = join(REPO_ROOT, '.changeset');

/** Names a snippet may use without declaring them (changeset and overview snippets elide the setup). */
const SETUP: Record<string, string> = {
	scope: "const scope = new Scope('docs');",
	googleSecret: "const googleSecret = new AppSetting(scope, 'google-secret', { secret: true });",
	entraSecret: "const entraSecret = new AppSetting(scope, 'entra-secret', { secret: true });",
	githubSecret: "const githubSecret = new AppSetting(scope, 'github-secret', { secret: true });",
};
const UMBRELLA_NAMES = ['AppSetting', 'Auth', 'Scope', 'github', 'stubIdp', 'getDeploymentType'];

interface Snippet {
	readonly label: string;
	readonly code: string;
}

function multiBlockSnippets(): Snippet[] {
	const changesets = existsSync(CHANGESETS)
		? readdirSync(CHANGESETS)
				.filter((f) => f.endsWith('.md'))
				.map((f) => join(CHANGESETS, f))
		: [];
	return [...DOCS, ...changesets].flatMap((file) => {
		const md = readFileSync(file, 'utf8');
		return [...md.matchAll(/```(?:ts|typescript)\n([\s\S]*?)```/g)]
			.filter((m) => (m[1] ?? '').split('new Auth(').length > 2)
			.map((m) => ({
				label: `${file.slice(REPO_ROOT.length + 1)}:${md.slice(0, m.index).split('\n').length}`,
				code: m[1] ?? '',
			}));
	});
}

/** The snippet as a module: the setup it elides, without the request-handler lines that need a context. */
function asModule(code: string): string {
	const body = code.split(/^\/\/ Inside a request handler/m)[0] ?? code;
	const imported = new Set(
		[...body.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}/g)]
			.flatMap((m) => (m[1] ?? '').split(','))
			.map((n) => n.trim()),
	);
	const declared = (name: string) => new RegExp(`\\b(?:const|let)\\s+${name}\\b`).test(body);
	const uses = (name: string) => new RegExp(`\\b${name}\\b`).test(body);
	const setup = Object.entries(SETUP)
		.filter(([name]) => uses(name) && !declared(name))
		.map(([, line]) => line);
	const needed = new Set(
		UMBRELLA_NAMES.filter((n) => !imported.has(n) && (uses(n) || setup.some((l) => l.includes(`new ${n}(`)))),
	);
	const header = needed.size > 0 ? [`import { ${[...needed].join(', ')} } from '@aws-blocks/blocks';`] : [];
	// Imports are hoisted, so the setup may precede the snippet's own imports.
	return [...header, ...setup, body, 'export {};', ''].join('\n');
}

describe('two-block snippets load in the mock runtime', () => {
	const dirs: string[] = [];
	after(() => {
		for (const d of dirs) removeScratch(d);
	});

	const snippets = multiBlockSnippets();

	test('the docs show two-block apps', () => {
		const inPackages = snippets.filter((s) => s.label.startsWith('packages/'));
		assert.ok(inPackages.length >= 4, `found ${snippets.map((s) => s.label).join(', ')}`);
	});

	for (const s of snippets) {
		test(s.label, () => {
			const dir = scratchDir('two-blocks');
			dirs.push(dir);
			const source = asModule(s.code);
			const [file] = writeFiles(dir, { 'index.ts': source });
			assert.ok(file);
			assert.deepStrictEqual(typecheck([file]), [], 'compiles');
			const js = join(dir, 'index.mjs');
			writeFileSync(
				js,
				ts.transpileModule(source, {
					compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
				}).outputText,
			);
			const run = spawnSync(process.execPath, [js], { cwd: dir, encoding: 'utf8' });
			assert.strictEqual(run.status, 0, `loads without throwing:\n${run.stderr}`);
		});
	}
});
