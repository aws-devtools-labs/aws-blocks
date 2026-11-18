// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * IMPORTS.md lists what each app-facing entry exports; it is generated from
 * the built declaration files, so it fails here as soon as an export is added,
 * removed or changes between value and type.
 */

import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { IMPORTS_MD, renderImportsReference } from './test-support/imports-reference.js';

test('IMPORTS.md matches the exports of the built entries', () => {
	assert.ok(existsSync(IMPORTS_MD), 'packages/blocks/IMPORTS.md exists (npm run update:imports writes it)');
	assert.strictEqual(
		readFileSync(IMPORTS_MD, 'utf8'),
		renderImportsReference(),
		'packages/blocks/IMPORTS.md is out of date: run `npm run update:imports` after `npm run build` and commit it',
	);
});
