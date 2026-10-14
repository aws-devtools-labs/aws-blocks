// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { importBackend } from './load-backend.js';

// importBackend must load a TypeScript backend entry regardless of whether the
// current process registered tsx's loader — the sandbox dev server runs as a
// child `npx tsx watch` process with NODE_OPTIONS='' where a bare import() of a
// .ts file throws "Unknown file extension" on Node 20.
describe('load-backend — importBackend', () => {
	let dir: string;

	before(() => {
		dir = mkdtempSync(join(tmpdir(), 'blocks-load-backend-'));
	});
	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('loads a .ts entry (through tsx/esm/api)', async () => {
		const file = join(dir, 'index.ts');
		writeFileSync(file, `export const marker: string = 'ts-backend';\nexport const n: number = 42;\n`);
		const mod = await importBackend(pathToFileURL(file).href, import.meta.url);
		assert.equal(mod.marker, 'ts-backend');
		assert.equal(mod.n, 42);
	});

	it('loads a .js entry (through native import)', async () => {
		const file = join(dir, 'index.js');
		writeFileSync(file, `export const marker = 'js-backend';\n`);
		const mod = await importBackend(pathToFileURL(file).href, import.meta.url);
		assert.equal(mod.marker, 'js-backend');
	});

	it('propagates a load error from a broken .ts entry', async () => {
		const file = join(dir, 'broken.ts');
		writeFileSync(file, `export const x = ;\n`); // syntax error
		await assert.rejects(() => importBackend(pathToFileURL(file).href, import.meta.url));
	});

	it('loads a backend only once per process (second import is cached, not re-executed)', async () => {
		// The dev server imports the backend twice — once to build the API map
		// (before locking the route registry) and again for client-code
		// generation (after locking). A re-execution would re-run top-level route
		// registration against the locked registry and throw. The cache must make
		// the second import a no-op that returns the same module instance.
		const file = join(dir, 'once.ts');
		writeFileSync(
			file,
			`(globalThis as any).__LOAD_BACKEND_ONCE_COUNT__ =\n` +
				`  ((globalThis as any).__LOAD_BACKEND_ONCE_COUNT__ ?? 0) + 1;\n` +
				`export const marker: string = 'once';\n`,
		);
		const url = pathToFileURL(file).href;
		const first = await importBackend(url, import.meta.url);
		const second = await importBackend(url, import.meta.url);
		assert.equal((globalThis as any).__LOAD_BACKEND_ONCE_COUNT__, 1);
		assert.equal(first, second);
	});
});
