// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for scripts/ci/amplify-sandbox-teardown.mjs, run against a fake
// `npm` that fails `sandbox:delete` a scripted number of times.
//
// Run: node --test scripts/ci/amplify-sandbox-teardown.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./amplify-sandbox-teardown.mjs', import.meta.url));

// Stands in for npm: logs its cwd and arguments, and exits 1 while the
// scripted failure count lasts.
const FAKE_NPM = `#!/usr/bin/env node
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.FAKE_NPM_STATE, 'utf8'));
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
if (state.failures > 0) {
	state.failures--;
	fs.writeFileSync(process.env.FAKE_NPM_STATE, JSON.stringify(state));
	process.exit(1);
}
`;

function run({ failures, budgetSeconds = 30, args }) {
	const dir = mkdtempSync(join(tmpdir(), 'amplify-teardown-'));
	const bin = join(dir, 'bin');
	const app = join(dir, 'app');
	mkdirSync(bin);
	mkdirSync(app);
	writeFileSync(join(bin, 'npm'), FAKE_NPM);
	chmodSync(join(bin, 'npm'), 0o755);
	const state = join(dir, 'state.json');
	const log = join(dir, 'calls.log');
	writeFileSync(state, JSON.stringify({ failures }));
	writeFileSync(log, '');
	const r = spawnSync(process.execPath, [SCRIPT, ...(args ?? [app, 'amp-1234-1'])], {
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			FAKE_NPM_STATE: state,
			FAKE_NPM_LOG: log,
			AMPLIFY_TEARDOWN_BUDGET_SECONDS: String(budgetSeconds),
			AMPLIFY_TEARDOWN_BACKOFF_MS: '10',
			AMPLIFY_TEARDOWN_JITTER_MS: '10',
		},
	});
	const calls = readFileSync(log, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	return { ...r, calls, app };
}

describe('amplify-sandbox-teardown', () => {
	it('deletes the given sandbox from the app directory', () => {
		const r = run({ failures: 0 });
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual(r.calls, [
			{ cwd: r.app, args: ['run', 'sandbox:delete', '--', '--identifier', 'amp-1234-1'] },
		]);
		assert.doesNotMatch(r.stdout, /::warning/);
	});

	it('retries a failed delete until it succeeds', () => {
		const r = run({ failures: 2 });
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.equal(r.calls.length, 3);
		assert.match(r.stdout, /Deleted Amplify sandbox "amp-1234-1"/);
		assert.doesNotMatch(r.stdout, /::warning/);
	});

	it('warns without failing the step when the budget runs out', () => {
		const r = run({ failures: 1_000, budgetSeconds: 0.2 });
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.ok(r.calls.length >= 1);
		assert.match(r.stdout, /::warning title=Amplify sandbox teardown::sandbox "amp-1234-1" not deleted/);
	});

	it('rejects a call without an app directory and identifier', () => {
		const r = run({ failures: 0, args: ['only-one-arg'] });
		assert.equal(r.status, 2);
		assert.equal(r.calls.length, 0);
	});
});
