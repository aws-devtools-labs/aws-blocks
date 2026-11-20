// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Templates with a Vite frontend typecheck it and their backend as separate
// TypeScript projects: `cdk-blocks/tsconfig.json` sees Node types, the browser
// code in `src/` does not, and reads the backend through a project reference that
// `tsc -b` builds. These tests keep every Vite template on that layout, and keep
// `nextjs` off it: `next build` ignores project references when it type-checks.

import assert from 'node:assert';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(__dirname, '..', 'templates');

interface Tsconfig {
	compilerOptions?: Record<string, unknown>;
	files?: string[];
	include?: string[];
	references?: { path: string }[];
}

/** A tsconfig parsed the way `tsc` reads it, comments included. */
function readTsconfig(path: string): Tsconfig {
	const { config, error } = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf-8'));
	assert.ok(!error, `${path}: ${error && ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
	return config;
}

const templates = readdirSync(templatesDir, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name);
const viteTemplates = templates.filter((name) => existsSync(join(templatesDir, name, 'vite.config.ts')));

/** The TypeScript sources a template ships (not declarations, not node_modules). */
function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts'))
		.map((entry) => resolve(entry.parentPath, entry.name))
		.filter((path) => !relative(dir, path).split(sep).includes('node_modules'));
}

describe('template TypeScript projects', () => {
	it('every Vite template typechecks its browser code and its backend as separate projects', () => {
		assert.ok(viteTemplates.includes('default'), `Vite templates: ${viteTemplates.join(', ')}`);
		for (const name of viteTemplates) {
			const dir = join(templatesDir, name);
			const root = readTsconfig(join(dir, 'tsconfig.json'));
			assert.deepStrictEqual(root.files, [], name);
			assert.deepStrictEqual(
				root.references,
				[{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }],
				name,
			);
			for (const leaf of ['tsconfig.app.json', 'tsconfig.node.json']) {
				const config = readTsconfig(join(dir, leaf));
				assert.deepStrictEqual(config.references, [{ path: './cdk-blocks' }], `${name}/${leaf}`);
				// In the leaf config, because `tsc -b --noEmit` fails with TS6310 on the composite backend.
				assert.strictEqual(config.compilerOptions?.noEmit, true, `${name}/${leaf}`);
			}
			const app = readTsconfig(join(dir, 'tsconfig.app.json'));
			assert.deepStrictEqual(
				app.compilerOptions?.types,
				['vite/client'],
				`${name}: src/ must not see Node types`,
			);
			assert.ok(existsSync(join(dir, 'cdk-blocks', 'tsconfig.json')), `${name}: no cdk-blocks/tsconfig.json`);
			// Build mode builds the backend's declarations first; plain `tsc` would fail with TS6305 without them.
			// `--force`, because TypeScript 5.x build mode does not notice a changed dependency's declarations.
			const { scripts } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
			assert.strictEqual(scripts.typecheck, 'tsc -b --force', name);
			assert.strictEqual(scripts.build, 'tsc -b --force && vite build', name);
			// tsx reads the root tsconfig.json otherwise, which lists no file, so the tests would run without options.
			assert.match(scripts['test:e2e'], /^tsx --tsconfig tsconfig\.node\.json /, name);
		}
	});

	it('every TypeScript file of a Vite template is in exactly one project, and src/ in the browser one', () => {
		const projects = { app: 'tsconfig.app.json', node: 'tsconfig.node.json', backend: 'cdk-blocks/tsconfig.json' };
		for (const name of viteTemplates) {
			const dir = join(templatesDir, name);
			const owners = new Map<string, string[]>();
			for (const [project, file] of Object.entries(projects)) {
				const path = join(dir, file);
				const config = readTsconfig(path);
				const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dirname(path));
				for (const listed of parsed.fileNames) {
					owners.set(resolve(listed), [...(owners.get(resolve(listed)) ?? []), project]);
				}
				// The getConfig()/getSecret() key types that the dev task generates into .cdk-blocks/.
				const blocksTypes = project === 'backend' ? '../.cdk-blocks/**/*.d.ts' : '.cdk-blocks/**/*.d.ts';
				assert.ok(config.include?.includes(blocksTypes), `${name}/${file} does not include ${blocksTypes}`);
			}
			const files = sourceFiles(dir);
			assert.ok(
				files.some((file) => relative(dir, file).startsWith(`test${sep}`)),
				`${name}: no test/ sources`,
			);
			for (const file of files) {
				const rel = relative(dir, file);
				const of = owners.get(file) ?? [];
				assert.strictEqual(of.length, 1, `${name}/${rel} is in ${of.join(' and ') || 'no project'}`);
				if (rel.startsWith(`src${sep}`)) assert.deepStrictEqual(of, ['app'], `${name}/${rel}`);
			}
		}
	});

	it('every cdk-blocks/tsconfig.json is the same Node project of every backend file', () => {
		const defaultPath = join(templatesDir, 'default', 'cdk-blocks', 'tsconfig.json');
		const backend = readTsconfig(defaultPath);
		assert.strictEqual(backend.compilerOptions?.composite, true);
		assert.deepStrictEqual(backend.compilerOptions?.types, ['node']);
		// Every backend file, not only index.ts, so `tsc -b` rebuilds when an imported module changes;
		// plus the getConfig()/getSecret() key types that the dev task generates into .cdk-blocks/.
		assert.deepStrictEqual(backend.include, ['**/*', '../.cdk-blocks/**/*.d.ts']);
		// Adding CDK Blocks to an existing project, or to an Amplify app, copies the default template's
		// file when a template has none, and the upgrade guide links to it.
		const expected = readFileSync(defaultPath, 'utf-8');
		const copies = templates.filter((name) => existsSync(join(templatesDir, name, 'cdk-blocks', 'tsconfig.json')));
		assert.deepStrictEqual(copies.sort(), [...viteTemplates].sort());
		const guide = readFileSync(
			join(__dirname, '..', '..', '..', 'docs', 'guides', 'upgrading-older-apps.md'),
			'utf-8',
		);
		assert.ok(guide.includes('](../../packages/create-blocks-app/templates/default/cdk-blocks/tsconfig.json)'));
		for (const name of copies) {
			const path = join(templatesDir, name, 'cdk-blocks', 'tsconfig.json');
			assert.strictEqual(
				readFileSync(path, 'utf-8'),
				expected,
				`${name}/cdk-blocks/tsconfig.json differs from default's`,
			);
		}
	});

	it('every tsconfig that type-checks a backend has the library types of Array.fromAsync', () => {
		// The Building Block docs list items with `Array.fromAsync(store.query(...))`; a backend whose
		// `lib` stops at ES2022 fails its type-check with TS2550 on it. nextjs checks cdk-blocks/ with its
		// root tsconfig.json, every other template with cdk-blocks/tsconfig.json.
		const configs = templates
			.map((name) =>
				name === 'nextjs' ? join(templatesDir, name, 'tsconfig.json') : join(templatesDir, name, 'cdk-blocks', 'tsconfig.json'),
			)
			.filter((path) => existsSync(path));
		assert.ok(configs.some((path) => path.includes(`${sep}nextjs${sep}`)), 'the nextjs tsconfig is checked');
		const dir = mkdtempSync(join(tmpdir(), 'cba-fromasync-'));
		try {
			const file = join(dir, 'list.ts');
			writeFileSync(file, 'export const items: Promise<number[]> = Array.fromAsync([1, 2]);\n');
			const failing: string[] = [];
			for (const path of configs) {
				const { options } = ts.parseJsonConfigFileContent(readTsconfig(path), ts.sys, dirname(path));
				// Only the library matters here: no ambient types, no plugins, no emit.
				const program = ts.createProgram([file], { lib: options.lib, target: options.target, types: [], noEmit: true });
				const errors = ts.getPreEmitDiagnostics(program);
				if (errors.length > 0) {
					failing.push(
						`${relative(templatesDir, path)}: ${errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, ' ')).join('; ')}`,
					);
				}
			}
			assert.deepStrictEqual(failing, []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('nextjs keeps one tsconfig with global Node types', () => {
		// `next build` ignores project references when it type-checks (vercel/next.js#67372), so it
		// checks cdk-blocks/ with this tsconfig.json either way, and that needs Node types.
		const config = readTsconfig(join(templatesDir, 'nextjs', 'tsconfig.json'));
		assert.strictEqual(config.references, undefined);
		assert.strictEqual(config.compilerOptions?.types, undefined);
		assert.ok(!existsSync(join(templatesDir, 'nextjs', 'cdk-blocks', 'tsconfig.json')));
	});
});
