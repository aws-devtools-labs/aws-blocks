// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { BACKEND_TYPES_TSCONFIG, backendTypesTarget, generateBackendTypes } from './generate-types.js';

// Fixtures live inside the package (not the OS tmpdir) so `typescript` and
// `@types/node` resolve from the workspace's node_modules, as they do in an app.
const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const TSCONFIG = {
	compilerOptions: {
		target: 'ES2022',
		module: 'ES2022',
		moduleResolution: 'bundler',
		lib: ['ESNext'],
		types: ['node'],
		strict: true,
		skipLibCheck: true,
		declaration: true,
		emitDeclarationOnly: true,
		noEmitOnError: true,
		rootDir: '.',
		outDir: '.types',
	},
	files: ['index.ts'],
};

describe('generateBackendTypes', () => {
	let dir: string;

	function workspace(opts: { types?: string; tsconfig?: object | false; source: string }): void {
		writeFileSync(
			join(dir, 'package.json'),
			JSON.stringify({
				name: 'aws-blocks',
				type: 'module',
				exports: { '.': { types: opts.types ?? './.types/index.d.ts', default: './index.ts' } },
			}),
		);
		if (opts.tsconfig !== false) {
			writeFileSync(join(dir, BACKEND_TYPES_TSCONFIG), JSON.stringify(opts.tsconfig ?? TSCONFIG));
		}
		writeFileSync(join(dir, 'index.ts'), opts.source);
	}

	beforeEach(() => {
		dir = mkdtempSync(join(PACKAGE_DIR, '.test-gen-types-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('skips a workspace whose types still point at its source (apps scaffolded before generated types)', async () => {
		workspace({ types: './index.ts', source: 'export const x = 1;\n' });
		assert.strictEqual(backendTypesTarget(dir), undefined);
		const result = await generateBackendTypes(dir);
		assert.strictEqual(result.status, 'skipped');
		assert.ok(!existsSync(join(dir, '.types')));
	});

	it('skips a workspace without the types tsconfig', async () => {
		workspace({ tsconfig: false, source: 'export const x = 1;\n' });
		assert.strictEqual((await generateBackendTypes(dir)).status, 'skipped');
	});

	it('writes declarations for backend code that uses Node APIs, with inferred return types intact', async () => {
		workspace({
			source: [
				"import { randomUUID } from 'node:crypto';",
				'export const api = {',
				"\tasync whoAmI() { return { id: randomUUID(), region: process.env.AWS_REGION ?? 'local', role: 'admin' as 'admin' | 'reader' }; },",
				'};',
				'',
			].join('\n'),
		});
		const result = await generateBackendTypes(dir);
		assert.strictEqual(result.status, 'written', JSON.stringify(result));
		const dts = readFileSync(join(dir, '.types', 'index.d.ts'), 'utf-8');
		assert.match(dts, /whoAmI\(\): Promise<\{/);
		assert.match(dts, /role: "admin" \| "reader"/);
		assert.doesNotMatch(dts, /node:crypto|process/, 'Node-only names must not leak into the frontend-facing types');
	});

	it('fails on a backend type error and keeps the previous declarations', async () => {
		workspace({ source: 'export const ok = 1;\n' });
		assert.strictEqual((await generateBackendTypes(dir)).status, 'written');
		const before = readFileSync(join(dir, '.types', 'index.d.ts'), 'utf-8');

		writeFileSync(join(dir, 'index.ts'), "export const broken: number = 'not a number';\n");
		const result = await generateBackendTypes(dir);
		assert.strictEqual(result.status, 'failed');
		assert.ok(result.status === 'failed' && /TS2322/.test(result.diagnostics), 'reports the tsc diagnostic');
		assert.strictEqual(readFileSync(join(dir, '.types', 'index.d.ts'), 'utf-8'), before);
	});

	it('fails when the tsconfig writes somewhere other than exports["."].types', async () => {
		workspace({
			tsconfig: { ...TSCONFIG, compilerOptions: { ...TSCONFIG.compilerOptions, outDir: 'elsewhere' } },
			source: 'export const x = 1;\n',
		});
		const result = await generateBackendTypes(dir);
		assert.strictEqual(result.status, 'failed');
		assert.ok(result.status === 'failed' && /outDir/.test(result.message));
	});
});
