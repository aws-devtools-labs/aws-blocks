// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for scripts/check-actions-pinned.mjs, plus a check that the repo's
// own .github tree currently passes.
//
// Run: node --test scripts/check-actions-pinned.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findUnpinned, scan } from './check-actions-pinned.mjs';

const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const DIGEST = 'a'.repeat(64);

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

	it('ignores local actions', () => {
		assert.deepEqual(findUnpinned('      - uses: ./.github/actions/seed\n      - uses: ./.github/workflows/x.yml'), []);
	});

	it('flags a docker:// image not pinned by sha256 digest, and accepts one that is', () => {
		const yml = [
			'      - uses: docker://alpine:3',
			'      - uses: docker://ghcr.io/org/img',
			`      - uses: docker://alpine:3@sha256:${DIGEST}`,
			`      - uses: docker://alpine@sha256:${DIGEST}`,
			'      - uses: docker://alpine@sha256:abc123',
		].join('\n');
		assert.deepEqual(findUnpinned(yml).map((v) => v.line), [1, 2, 5]);
	});

	it('flags a quoted `uses` key, double- or single-quoted, with or without escapes', () => {
		const yml = [
			'      - "uses": actions/checkout@v7',
			"      - 'uses': actions/checkout@v7",
			'      - "uses" : "actions/checkout@v7"',
			'      - "u\\x73es": actions/checkout@v7',
			'      - "\\u0075ses": actions/checkout@v7',
			'    "uses": org/repo/.github/workflows/x.yml@main',
		].join('\n');
		assert.deepEqual(findUnpinned(yml).map((v) => v.line), [1, 2, 3, 4, 5, 6]);
	});

	it('decodes a quoted ref before checking it', () => {
		assert.equal(findUnpinned('      - uses: "actions/checkout@\\x76\\x37"')[0].ref, 'actions/checkout@v7');
		assert.deepEqual(findUnpinned(`      - "uses": "actions/checkout@${SHA}" # v7.0.1`), []);
	});

	it('flags `uses` inside a flow mapping or flow sequence', () => {
		const yml = [
			'      - { uses: actions/checkout@v7 }',
			'      - {name: x, uses: actions/checkout@v7}',
			'      - { "uses": "actions/checkout@v7", with: { a: 1 } }',
			'    steps: [ { uses: actions/checkout@v7 }, { uses: actions/setup-node@v7 } ]',
			'    steps: [ uses: actions/checkout@v7 ]',
			'      - {',
			'          name: x,',
			'          uses: actions/checkout@v7',
			'        }',
		].join('\n');
		assert.deepEqual(findUnpinned(yml).map((v) => v.line), [1, 2, 3, 4, 4, 5, 8]);
		assert.deepEqual(findUnpinned(`      - { uses: actions/checkout@${SHA}, with: { a: 1 } }`), []);
	});

	it('fails closed on a `uses` value it cannot read off one line', () => {
		const forms = [
			'      - uses:\n          actions/checkout@v7',
			'      - uses: >-\n          actions/checkout@v7',
			'      - uses: |\n          actions/checkout@v7',
			'      - uses: *ref',
			'      - uses: !!str actions/checkout@v7',
			'      - uses: &a actions/checkout@v7',
			'      - uses: "actions/checkout@\\\n          v7"',
			"      - uses: 'actions/checkout@\n          v7'",
			`      - uses: actions/checkout@${SHA}\n          trailing`,
			'      - { uses:\n          actions/checkout@v7 }',
		];
		for (const yml of forms) assert.equal(findUnpinned(yml).length, 1, yml);
	});

	it('fails closed on keys it cannot resolve: aliases, tags and explicit `?` keys', () => {
		const forms = [
			'      - *k : actions/checkout@v7',
			'      - { *k : actions/checkout@v7 }',
			'      - !!binary dXNlcw==: actions/checkout@v7',
			'      - ? uses\n        : actions/checkout@v7',
			'      - ?\n          uses\n        : actions/checkout@v7',
			'      - !<tag:yaml.org,2002:str> uses: actions/checkout@v7',
		];
		for (const yml of forms) assert.equal(findUnpinned(yml).length, 1, yml);
	});

	it('ignores `uses` text inside block scalars and comments', () => {
		const yml = [
			'      - run: |',
			'          echo "uses: actions/checkout@v7"',
			"          echo '{ uses: actions/checkout@v7 }'",
			'        with:',
			'          a: 1',
			'      # - uses: actions/checkout@v7',
			`      - uses: actions/checkout@${SHA} # was uses: actions/checkout@v7`,
		].join('\n');
		assert.deepEqual(findUnpinned(yml), []);
	});

	it('still checks the step after a block scalar ends', () => {
		const yml = ['      - run: >-', '          echo hi', '        uses: actions/checkout@v7'].join('\n');
		assert.deepEqual(findUnpinned(yml).map((v) => v.line), [3]);
	});

	it('handles CRLF line endings', () => {
		assert.deepEqual(findUnpinned('a: 1\r\n      - uses: actions/checkout@v7\r\n').map((v) => v.line), [2]);
	});

	it('reports 1-based line numbers', () => {
		assert.equal(findUnpinned('a: 1\n      - uses: actions/checkout@v7')[0].line, 2);
	});
});

describe('repo .github tree', () => {
	const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

	it('has no unpinned action references', () => {
		assert.deepEqual(scan(root), []);
	});

	// The guard only protects `main` if it can be a required status check: it must run on
	// every PR to `main` (a path filter leaves a required check pending forever on PRs that
	// skip it) under a stable job name, and fail the job on a violation.
	it('runs the guard on every PR to main under a stable job name', () => {
		const wf = readFileSync(join(root, '.github/workflows/actions-pinned.yml'), 'utf8');
		const pr = /^ {2}pull_request:\n((?: {4}.*\n)+)/m.exec(wf);
		assert.ok(pr, 'pull_request trigger present');
		assert.match(pr[1], /branches: \[main\]/);
		assert.doesNotMatch(pr[1], /paths(-ignore)?:/);
		assert.match(wf, /^ {4}name: Require SHA-pinned actions$/m);
		assert.doesNotMatch(wf, /continue-on-error/);
		assert.match(wf, /run: node scripts\/check-actions-pinned\.mjs$/m);
		assert.match(wf, /run: node --test scripts\/check-actions-pinned\.test\.mjs$/m);
	});
});
