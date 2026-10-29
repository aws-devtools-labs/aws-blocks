// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Fixture tests for the `bb-auth migrate` codemod: each directory under
 * `src/__fixtures__/migrate/<case>/` holds an `input/` tree and the `expected/`
 * tree the codemod must produce from it. Files are stored as `<name>.ts.txt`
 * so the compiler and the linter leave the (deliberately old-API) code alone;
 * the `.txt` is dropped when a case is copied into a temp project.
 *
 * Every case also asserts idempotency: a second run changes nothing.
 *
 * Regenerate after an intentional change: `UPDATE_MIGRATE_FIXTURES=1 npm test`
 * (then review the diff of `expected/` by hand).
 */

import assert from 'node:assert';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, test } from 'node:test';
import { FIXTURES, migrate, readTree, SRC_DIR, stageCase } from './test-support/migrate-fixtures.js';

const UPDATE = process.env.UPDATE_MIGRATE_FIXTURES === '1';

const CASES = readdirSync(FIXTURES, { withFileTypes: true })
	.filter((e) => e.isDirectory())
	.map((e) => e.name)
	.sort();

describe('bb-auth migrate — fixtures (input → expected)', () => {
	for (const name of CASES) {
		test(name, async () => {
			const dir = stageCase(name);
			try {
				const before = readTree(dir);
				const first = await migrate(dir);
				const after = readTree(dir);
				const expectedDir = join(FIXTURES, name, 'expected');
				if (UPDATE) {
					rmSync(expectedDir, { recursive: true, force: true });
					for (const [file, text] of Object.entries(after)) {
						const target = join(expectedDir, `${file}.txt`);
						mkdirSync(dirname(target), { recursive: true });
						writeFileSync(target, text);
					}
				}
				assert.ok(
					existsSync(expectedDir),
					`missing ${relative(SRC_DIR, expectedDir)} (run with UPDATE_MIGRATE_FIXTURES=1)`,
				);
				assert.deepStrictEqual(after, readTree(expectedDir));

				// Only files whose content changed are reported (and written).
				const reallyChanged = Object.keys(after).filter((f) => after[f] !== before[f]);
				assert.deepStrictEqual([...first.changed].sort(), reallyChanged.sort());

				// Idempotent: a second run is a no-op.
				const second = await migrate(dir);
				assert.deepStrictEqual(second.changed, [], 'second run changes nothing');
				assert.deepStrictEqual(readTree(dir), after);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}
});
