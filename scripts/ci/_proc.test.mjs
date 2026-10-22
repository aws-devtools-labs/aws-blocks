// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the teardown helper in scripts/ci/_proc.mjs.
//
// Run: node --test scripts/ci/_proc.test.mjs
//
// CI runs this on Linux only. On Windows (`shell: true`) cmd.exe reports a
// missing command as a non-zero status rather than a spawn error; the status
// check covers both.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runTeardown } from './_proc.mjs';

const ROOT = process.cwd();

describe('runTeardown', () => {
	it('records a command that exits non-zero (a failed destroy must fail the job)', () => {
		const failures = [];
		runTeardown(process.execPath, ['-e', 'process.exit(1)'], {}, ROOT, failures);
		assert.equal(failures.length, 1);
		assert.match(failures[0], /exited with 1/);
	});

	it('records a command that cannot be spawned', () => {
		const failures = [];
		runTeardown('definitely-not-a-real-command-xyz', [], { shell: false }, ROOT, failures);
		assert.equal(failures.length, 1);
		assert.match(failures[0], /ENOENT/);
	});

	it('records nothing when the command succeeds', () => {
		const failures = [];
		runTeardown(process.execPath, ['-e', 'process.exit(0)'], {}, ROOT, failures);
		assert.deepEqual(failures, []);
	});

	it('never throws, so the next teardown still runs', () => {
		const failures = [];
		assert.doesNotThrow(() => runTeardown(process.execPath, ['-e', 'process.exit(2)'], {}, ROOT, failures));
	});
});
