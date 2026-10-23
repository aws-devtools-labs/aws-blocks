// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the teardown helper in scripts/ci/_proc.mjs.
//
// Run: node --test scripts/ci/_proc.test.mjs
//
// CI runs this on Linux. On Windows the driver spawns with `shell: true`, where
// cmd.exe reports a missing command as a non-zero status (covered by the
// status check) and a node path containing a space would split (see runSpawn).

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
		assert.doesNotThrow(() => {
			runTeardown(process.execPath, ['-e', 'process.exit(2)'], {}, ROOT, failures);
			runTeardown(process.execPath, ['-e', 'process.exit(3)'], {}, ROOT, failures);
		});
		assert.equal(failures.length, 2);
		assert.match(failures[1], /exited with 3/);
	});

	// POSIX only: spawnSync reports a signal kill as status null + signal.
	it('records a command killed by a signal', { skip: process.platform === 'win32' }, () => {
		const failures = [];
		runTeardown(process.execPath, ['-e', "process.kill(process.pid, 'SIGKILL')"], {}, ROOT, failures);
		assert.equal(failures.length, 1);
		assert.match(failures[0], /terminated by signal SIGKILL/);
	});
});
