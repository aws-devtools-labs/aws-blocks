// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the Amplify sandbox step of .github/workflows/cleanup-stacks.yml,
// run against a stub `aws` on PATH (nothing reaches AWS). The step deletes one
// sandbox at a time: concurrent deletes throttle each other's REST API delete
// until CloudFormation gives up, so it must never start a delete while another
// may still be running.
//
// Run: node --test scripts/ci/amplify-sweep.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKFLOW = readFileSync(fileURLToPath(new URL('../../.github/workflows/cleanup-stacks.yml', import.meta.url)), 'utf8');
const STEP = 'Find and delete stale Amplify sandbox stacks';

const A = 'amplify-amplifygen2-amp1-sandbox-aa';
const B = 'amplify-amplifygen2-amp2-sandbox-bb';
const C = 'amplify-amplifyinteroptest-int3-sandbox-cc';

// A stub `aws` serving the calls the step makes, from its fixture dir:
//   cloudformation list-stacks (names query) -> stacks.txt, tab-separated
//   cloudformation list-stacks (length query) -> 0
//   cloudformation describe-stacks, Tags query -> an old DELETE_FAILED sandbox
//   cloudformation describe-stacks, StackStatus query -> the first line of
//     status-<name>.txt (removed once read unless it is the last line); "gone"
//     answers "does not exist", "throttled" a Throttling error
//   cloudformation delete-stack -> appends the name to deletes.txt
//   cloudformation list-stack-resources -> nothing
const STUB = `#!/usr/bin/env bash
args="$*"
name=""; prev=""
for a in "$@"; do [ "$prev" = "--stack-name" ] && name="$a"; prev="$a"; done
case "$1 $2" in
  "cloudformation list-stacks")
    case "$args" in *length*) echo 0 ;; *) cat "$STUB_DIR/stacks.txt" ;; esac ;;
  "cloudformation list-stack-resources") ;;
  "cloudformation delete-stack") echo "$name" >> "$STUB_DIR/deletes.txt" ;;
  "cloudformation describe-stacks")
    case "$args" in
      *Tags*) printf 'sandbox\\tDELETE_FAILED\\t2020-01-01T00:00:00Z\\n' ;;
      *)
        f="$STUB_DIR/status-$name.txt"
        line=$(head -n 1 "$f")
        [ "$(wc -l < "$f")" -gt 1 ] && sed -i 1d "$f"
        case "$line" in
          gone) echo "An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id $name does not exist" >&2; exit 254 ;;
          throttled) echo "An error occurred (Throttling) when calling the DescribeStacks operation: Rate exceeded" >&2; exit 254 ;;
          *) echo "$line" ;;
        esac ;;
    esac ;;
  *) echo "stub aws: unexpected call: $args" >&2; exit 1 ;;
esac
`;

const dirs = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The step's dedented `run:` script. */
function script() {
	const lines = WORKFLOW.split('\n');
	const start = lines.findIndex((l) => l.trim() === `- name: ${STEP}`);
	assert.notEqual(start, -1, `step "${STEP}" not found in cleanup-stacks.yml`);
	const runAt = lines.findIndex((l, i) => i > start && l.trim() === 'run: |');
	const body = [];
	for (const line of lines.slice(runAt + 1)) {
		if (line.trim() !== '' && !line.startsWith(' '.repeat(10))) break;
		body.push(line.slice(10));
	}
	return body.join('\n');
}

/** Runs the step over `statuses` ({ stack: [poll answers] }) and returns the deletes it started. */
function run(statuses, env = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'amplify-sweep-'));
	dirs.push(dir);
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'aws'), STUB);
	chmodSync(join(bin, 'aws'), 0o755);
	writeFileSync(join(dir, 'stacks.txt'), `${Object.keys(statuses).join('\t')}\n`);
	for (const [name, answers] of Object.entries(statuses)) {
		writeFileSync(join(dir, `status-${name}.txt`), `${answers.join('\n')}\n`);
	}
	const file = join(dir, 'step.sh');
	writeFileSync(file, script());
	const r = spawnSync('bash', [file], {
		cwd: ROOT,
		encoding: 'utf8',
		env: {
			...process.env,
			AMPLIFY_SWEEP_POLL_SECONDS: '0',
			AMPLIFY_SWEEP_STACK_WAIT_SECONDS: '2',
			...env,
			PATH: `${bin}:${process.env.PATH}`,
			STUB_DIR: dir,
			GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
		},
	});
	const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
	return { ...r, deletes: read('deletes.txt').split('\n').filter(Boolean), summary: read('summary.md') };
}

describe('Amplify sandbox sweep step', () => {
	it('deletes the sandboxes one after another once each delete finishes', () => {
		const r = run({ [A]: ['DELETE_IN_PROGRESS', 'gone'], [B]: ['gone'], [C]: ['gone'] });
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual(r.deletes, [A, B, C]);
		assert.match(r.summary, /Deleted \(confirmed\): 3/);
		assert.match(r.summary, /Deferred to the next run: 0/);
	});

	it('starts no further delete while the previous one is still in progress', () => {
		const r = run({ [A]: ['DELETE_IN_PROGRESS'], [B]: ['gone'], [C]: ['gone'] });
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual(r.deletes, [A]);
		assert.match(r.summary, /Deferred to the next run: 2/);
	});

	it('starts no delete once the wait budget is spent', () => {
		const r = run({ [A]: ['gone'], [B]: ['gone'] }, { AMPLIFY_SWEEP_WAIT_BUDGET_SECONDS: '0' });
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual(r.deletes, []);
		assert.match(r.summary, /Deferred to the next run: 2/);
	});

	it('keeps waiting through a throttled poll instead of counting the stack as deleted', () => {
		const r = run({ [A]: ['throttled', 'DELETE_FAILED'], [B]: ['gone'] });
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual(r.deletes, [A, B], 'a finished (failed) delete does not block the next');
		assert.match(r.stdout, /Delete ended DELETE_FAILED for amplify-amplifygen2-amp1-sandbox-aa/);
		assert.match(r.summary, /Deleted \(confirmed\): 1/);
	});
});
