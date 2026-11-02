// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The PGlite process helpers are first-party plumbing for `bb-data` and
 * `bb-distributed-data`, so they live on the `./internal` entry, not the
 * package root (PR #850 review, B4).
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as root from './index.js';
import * as internal from './internal.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('data-common internal entry', () => {
	it('exports the two helpers the SQL blocks import', () => {
		assert.strictEqual(typeof internal.closeOnProcessExit, 'function');
		assert.strictEqual(typeof internal.pgliteUnrefTimersExtension, 'object');
		assert.strictEqual(typeof internal.pgliteUnrefTimersExtension.setup, 'function');
	});

	it('the package root no longer exports the PGlite process helpers', () => {
		for (const name of ['closeOnProcessExit', 'pgliteUnrefTimersExtension', 'runWithUnrefTimers']) {
			assert.ok(!(name in root), `${name} is still exported from the package root`);
		}
	});

	it('runWithUnrefTimers stays module-private (not on the internal entry either)', () => {
		assert.ok(!('runWithUnrefTimers' in internal));
	});

	it('package.json maps ./internal to the built entry', () => {
		const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
			exports: Record<string, { types: string; default: string }>;
		};
		assert.deepStrictEqual(pkg.exports['./internal'], {
			types: './dist/internal.d.ts',
			default: './dist/internal.js',
		});
	});
});
