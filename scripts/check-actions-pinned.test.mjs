// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for scripts/check-actions-pinned.mjs, plus a check that the repo's
// own .github tree currently passes.
//
// Run: node --test scripts/check-actions-pinned.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findUnpinned, scan } from './check-actions-pinned.mjs';

const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';

describe('findUnpinned', () => {
	it('flags mutable tags and branches, in step and job-level form', () => {
		const yml = [
			'jobs:',
			'  a:',
			'    uses: org/repo/.github/workflows/x.yml@main',
			'    steps:',
			'      - uses: actions/checkout@v7',
			'      - name: creds',
			'        uses: aws-actions/configure-aws-credentials@v6.3.0',
			"      - uses: 'subosito/flutter-action@v2'",
		].join('\n');
		assert.deepEqual(findUnpinned(yml).map((v) => v.ref), [
			'org/repo/.github/workflows/x.yml@main',
			'actions/checkout@v7',
			'aws-actions/configure-aws-credentials@v6.3.0',
			'subosito/flutter-action@v2',
		]);
	});

	it('accepts a full SHA with or without a trailing version comment', () => {
		const yml = `      - uses: actions/checkout@${SHA} # v7.0.1\n      - uses: actions/setup-node@${SHA}`;
		assert.deepEqual(findUnpinned(yml), []);
	});

	it('rejects a short SHA', () => {
		assert.equal(findUnpinned('      - uses: actions/checkout@3d3c42e').length, 1);
	});

	it('ignores local actions and docker images', () => {
		assert.deepEqual(findUnpinned('      - uses: ./.github/actions/seed\n      - uses: docker://alpine:3'), []);
	});

	it('reports 1-based line numbers', () => {
		assert.equal(findUnpinned('a: 1\n      - uses: actions/checkout@v7')[0].line, 2);
	});
});

describe('repo .github tree', () => {
	it('has no unpinned action references', () => {
		const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
		assert.deepEqual(scan(root), []);
	});
});
