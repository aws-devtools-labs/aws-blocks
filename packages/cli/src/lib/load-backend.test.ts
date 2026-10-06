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
});
