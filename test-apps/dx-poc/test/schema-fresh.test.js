// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The generated schema modules are committed, so that a fresh clone typechecks and
 * an editor has types before the dev server has ever run. Committed generated files
 * can drift, which is exactly the failure mode this whole approach is meant to avoid
 * — so drift is a test failure.
 *
 * `syncSchema` only rewrites a file whose content differs, so "nothing was written"
 * is the assertion that the committed files match the migrations.
 *
 * Mirrors how the repo guards `API.md` with `check:api`.
 */

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { syncSchema } from '@aws-blocks/bb-data/schema-sync';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('committed schema types match the migrations', () => {
	it('regenerating changes nothing', async () => {
		const { written, tables } = await syncSchema({
			migrationsPath: join(APP_DIR, 'migrations'),
			outDir: join(APP_DIR, 'lib/schema'),
		});

		assert.deepEqual(
			written,
			[],
			'lib/schema is stale — run the dev server (or syncSchema) and commit the result',
		);
		assert.ok(tables.includes('notes'), `expected a notes table, got ${tables.join(', ')}`);
	});
});
