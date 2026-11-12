// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as core from './core.js';
import * as root from './index.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('data-common core entry', () => {
	it('exports everything on the package root except the Kysely adapter', () => {
		const expected = Object.keys(root).filter((name) => name !== 'createKyselyAdapter');
		assert.deepStrictEqual(Object.keys(core).sort(), expected.sort());
	});

	it('does not import kysely, directly or through another module', () => {
		const seen = new Set<string>();
		const visit = (file: string): void => {
			if (seen.has(file)) return;
			seen.add(file);
			for (const [, specifier] of readFileSync(file, 'utf8').matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
				assert.notStrictEqual(specifier, 'kysely', `${file} imports kysely`);
				if (specifier.startsWith('./')) visit(join(dirname(file), specifier));
			}
		};
		visit(join(here, 'core.js'));
		assert.ok(seen.size > 1, 'the walk followed no import');
	});

	it('package.json maps ./core to the built entry', () => {
		const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
			exports: Record<string, { types: string; default: string }>;
		};
		assert.deepStrictEqual(pkg.exports['./core'], { types: './dist/core.d.ts', default: './dist/core.js' });
	});
});
