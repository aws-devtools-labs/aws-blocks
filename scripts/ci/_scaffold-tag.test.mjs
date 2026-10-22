// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for scripts/ci/_scaffold-tag.mjs, plus a check that the tag and
// stack prefix the Windows E2E uses are the ones cleanup-stacks.yml reclaims.
//
// Run: node --test scripts/ci/_scaffold-tag.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WINDOWS_E2E_PURPOSE, addPurposeTag } from './_scaffold-tag.mjs';

const repoFile = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const BACKEND_CDK_ENTRY = repoFile('packages/create-blocks-app/templates/backend/aws-blocks/index.cdk.ts');
const CLEANUP_WORKFLOW = readFileSync(repoFile('.github/workflows/cleanup-stacks.yml'), 'utf-8');
const WINDOWS_DRIVER = readFileSync(repoFile('scripts/ci/windows-template-e2e.mjs'), 'utf-8');

const tmpFile = (name) => join(mkdtempSync(join(tmpdir(), 'scaffold-tag-')), name);

describe('addPurposeTag', () => {
	it('tags the backend template stack the Windows E2E scaffolds', () => {
		const file = tmpFile('index.cdk.ts');
		copyFileSync(BACKEND_CDK_ENTRY, file);
		addPurposeTag(file, 'e2e-windows');
		const out = readFileSync(file, 'utf-8');
		assert.ok(out.startsWith(readFileSync(BACKEND_CDK_ENTRY, 'utf-8').trimEnd()), 'original source is kept');
		assert.match(out, /\ncdk\.Tags\.of\(blocksStack\)\.add\('blocks:purpose', 'e2e-windows'\);\n$/);
	});

	it('throws when the entry does not export blocksStack', () => {
		const file = tmpFile('index.cdk.ts');
		writeFileSync(file, "import * as cdk from 'aws-cdk-lib';\nconst stack = 1;\n");
		assert.throws(() => addPurposeTag(file, 'e2e-windows'), /blocks:purpose/);
		assert.doesNotMatch(readFileSync(file, 'utf-8'), /Tags/);
	});

	it('throws when the entry does not import cdk', () => {
		const file = tmpFile('index.cdk.ts');
		writeFileSync(file, 'export const blocksStack = {};\n');
		assert.throws(() => addPurposeTag(file, 'e2e-windows'), /aws-cdk-lib/);
	});
});

describe('Windows E2E stacks are reclaimable by cleanup-stacks.yml', () => {
	it('the purpose tag matches the sweeper e2e marker', () => {
		assert.ok(CLEANUP_WORKFLOW.includes('e2e-* | *-e2e)'), 'sweeper e2e marker pattern changed; update this test');
		assert.match(WINDOWS_E2E_PURPOSE, /^e2e-./);
	});

	it('the app name keeps a stack prefix the sweeper lists', () => {
		assert.match(WINDOWS_DRIVER, /join\(work, 'bb-test-win'\)/);
		assert.match(CLEANUP_WORKFLOW, /for PREFIX in [^;\n]*\bbb-test- /);
	});

	it('the driver tags the scaffold before deploying', () => {
		const tagAt = WINDOWS_DRIVER.indexOf('addPurposeTag(');
		assert.ok(tagAt > 0, 'windows-template-e2e.mjs must call addPurposeTag');
		assert.ok(tagAt < WINDOWS_DRIVER.indexOf("['run', 'sandbox']"), 'tag must be added before the sandbox deploy');
	});
});
