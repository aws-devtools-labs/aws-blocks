// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for scripts/ci/e2e-stack-wait.mjs, run against a fake `aws` CLI.
//
// Run: node --test scripts/ci/e2e-stack-wait.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./e2e-stack-wait.mjs', import.meta.url));

// A stand-in for the AWS CLI. Each stack plays a script of statuses, one per
// describe-stacks call (the last one repeats; 'gone' = does not exist). A
// delete-stack call switches to the next script in `afterDelete`.
// list-stack-resources (the DELETE_FAILED query) returns `failed`. Each logged
// call ends with its time.
const FAKE_AWS = `#!/usr/bin/env node
const fs = require('node:fs');
const statePath = process.env.FAKE_AWS_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_AWS_LOG, JSON.stringify([...args, Date.now()]) + '\\n');
const name = args[args.indexOf('--stack-name') + 1];
const fail = (msg) => { process.stderr.write(msg + '\\n'); process.exit(254); };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const s = state.stacks[name];
const gone = () => fail('An error occurred (ValidationError) when calling the ' + args[1] + ' operation: Stack with id ' + name + ' does not exist');
const play = (list) => (list.length > 1 ? list.shift() : list[0]);
switch (args[1]) {
	case 'describe-stacks': {
		if (!s) gone();
		const st = play(s.statuses);
		save();
		if (st === 'gone') gone();
		if (st.startsWith('error:')) fail(st.slice(6));
		process.stdout.write(JSON.stringify(st));
		break;
	}
	case 'delete-stack':
		if (!s) gone();
		if (s.afterDelete && s.afterDelete.length) s.statuses = s.afterDelete.shift();
		save();
		break;
	case 'list-stack-resources':
		if (!s || s.statuses[0] === 'gone') gone();
		process.stdout.write(JSON.stringify(s.failed || []));
		break;
	default:
		fail('unexpected call: ' + args.join(' '));
}
`;

function run(argv, { stacks = {}, budget = '30', delays = '0,0' } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'e2e-stack-wait-'));
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'aws'), FAKE_AWS);
	chmodSync(join(bin, 'aws'), 0o755);
	const statePath = join(dir, 'state.json');
	const logPath = join(dir, 'calls.log');
	const summaryPath = join(dir, 'summary.md');
	writeFileSync(statePath, JSON.stringify({ stacks }));
	writeFileSync(logPath, '');
	const r = spawnSync(process.execPath, [SCRIPT, ...argv], {
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			FAKE_AWS_STATE: statePath,
			FAKE_AWS_LOG: logPath,
			E2E_WAIT_BUDGET_SECONDS: budget,
			E2E_WAIT_POLL_MS: '10',
			E2E_WAIT_RETRY_DELAYS_MS: delays,
			GITHUB_STEP_SUMMARY: summaryPath,
		},
	});
	const calls = readFileSync(logPath, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	return {
		...r,
		out: r.stdout + r.stderr,
		calls,
		summary: existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : '',
	};
}

const deletes = (calls) => calls.filter((c) => c[1] === 'delete-stack').map((c) => c[c.indexOf('--stack-name') + 1]);
const A = 'bb-test-runner-k3x9q2-pr-9-1';
const B = 'bb-test-prod-pr-9-1-runner-k3x9q2';

describe('e2e-stack-wait.mjs', () => {
	it('does nothing when no stack is given', () => {
		const r = run([]);
		assert.equal(r.status, 0, r.out);
		assert.deepEqual(r.calls, []);
	});

	it('refuses an argument that is not a stack name, before any AWS call', () => {
		const r = run([A, 'x; rm -rf /']);
		assert.equal(r.status, 2, r.out);
		assert.deepEqual(r.calls, []);
	});

	it('waits until every stack is gone, and splits space-separated names', () => {
		const r = run([`${A} ${B}`], {
			stacks: {
				[A]: { statuses: ['DELETE_IN_PROGRESS', 'DELETE_IN_PROGRESS', 'gone'] },
				[B]: { statuses: ['DELETE_IN_PROGRESS', 'gone'] },
			},
		});
		assert.equal(r.status, 0, r.out);
		assert.deepEqual(deletes(r.calls), []);
		assert.match(r.out, new RegExp(`${A}: deleted`));
		assert.match(r.out, new RegExp(`${B}: deleted`));
		assert.match(r.summary, /### E2E teardown: 2 stacks deleted/);
		assert.match(r.summary, new RegExp(`\\| \`${A}\` \\| deleted \\|`));
	});

	it('re-issues the delete of a stack that lands in DELETE_FAILED, and passes once it is gone', () => {
		const r = run([A], {
			stacks: { [A]: { statuses: ['DELETE_IN_PROGRESS', 'DELETE_FAILED'], afterDelete: [['DELETE_IN_PROGRESS', 'gone']] } },
		});
		assert.equal(r.status, 0, r.out);
		assert.deepEqual(deletes(r.calls), [A]);
		assert.match(r.summary, new RegExp(`\\| \`${A}\` \\| deleted \\| [0-9.]+ \\| 1 \\|`));
	});

	it('fails, naming the stack and what blocked it, when the delete keeps failing', () => {
		const reason = 'Too Many Requests (Service: ApiGateway, Status Code: 429)';
		const r = run([A, B], {
			stacks: {
				[A]: {
					statuses: ['DELETE_FAILED'],
					afterDelete: [['DELETE_FAILED'], ['DELETE_FAILED']],
					failed: [['DefaultComputeAPI5E5CE44A', 'AWS::ApiGateway::RestApi', reason]],
				},
				[B]: { statuses: ['gone'] },
			},
		});
		assert.equal(r.status, 1, r.out);
		// Two retries (the default delays), then it gives up.
		assert.deepEqual(deletes(r.calls), [A, A]);
		assert.match(r.out, new RegExp(`::error title=E2E teardown verify::${A}: DELETE_FAILED\\. Blocked by DefaultComputeAPI5E5CE44A \\(AWS::ApiGateway::RestApi\\): Too Many Requests`));
		assert.doesNotMatch(r.out, new RegExp(`::error.*${B}`));
		assert.match(r.summary, /### E2E teardown: 1 of 2 stacks not deleted/);
		assert.match(r.summary, new RegExp(`\\| \`${A}\` \\| \\*\\*DELETE_FAILED\\*\\* \\| - \\| 2 \\| DefaultComputeAPI5E5CE44A`));
		assert.match(r.summary, /cleanup-stacks\.yml reclaims/);
	});

	it('fails within its budget when a delete never finishes', () => {
		const started = Date.now();
		const r = run([A], { stacks: { [A]: { statuses: ['DELETE_IN_PROGRESS'] } }, budget: '1' });
		assert.equal(r.status, 1, r.out);
		assert.ok(Date.now() - started < 15_000);
		assert.match(r.out, new RegExp(`::error title=E2E teardown verify::${A}: not deleted after [0-9.]+ min \\(DELETE_IN_PROGRESS\\)`));
	});

	it('issues the delete of a stack whose delete never started', () => {
		const r = run([A], { stacks: { [A]: { statuses: ['CREATE_COMPLETE'], afterDelete: [['DELETE_IN_PROGRESS', 'gone']] } } });
		assert.equal(r.status, 0, r.out);
		assert.deepEqual(deletes(r.calls), [A]);
	});

	it('fails when the delete of a stack does not start even when issued again', () => {
		const r = run([A], { stacks: { [A]: { statuses: ['UPDATE_ROLLBACK_COMPLETE'] } } });
		assert.equal(r.status, 1, r.out);
		assert.deepEqual(deletes(r.calls), [A]);
		assert.match(r.out, /UPDATE_ROLLBACK_COMPLETE, the delete did not start/);
	});

	it('backs off before it re-issues a delete, and does not count the status lagging behind it', () => {
		const started = Date.now();
		const r = run([A], {
			stacks: { [A]: { statuses: ['DELETE_FAILED'], afterDelete: [['DELETE_FAILED', 'DELETE_IN_PROGRESS', 'gone']] } },
			// One retry: a lagging DELETE_FAILED counted as a failure would end it.
			delays: '400',
		});
		assert.equal(r.status, 0, r.out);
		assert.deepEqual(deletes(r.calls), [A]);
		assert.ok(Date.now() - started >= 400, 'waited the backoff');
	});

	it('restarts the backoff when a stack fails again after someone else re-issued its delete', () => {
		const r = run([A], {
			stacks: {
				[A]: {
					statuses: ['DELETE_FAILED', ...Array(10).fill('DELETE_IN_PROGRESS'), 'DELETE_FAILED'],
					afterDelete: [['gone']],
				},
			},
			delays: '400,400',
		});
		assert.equal(r.status, 0, r.out);
		const describes = r.calls.filter((c) => c[1] === 'describe-stacks');
		const del = r.calls.find((c) => c[1] === 'delete-stack');
		// The 12th DescribeStacks saw the second DELETE_FAILED.
		assert.ok(del.at(-1) - describes[11].at(-1) >= 400, 'a fresh backoff after the second failure');
	});

	it('fails at once on an error polling cannot clear', () => {
		const started = Date.now();
		const r = run([A], {
			stacks: { [A]: { statuses: ['error:An error occurred (AccessDenied) when calling the DescribeStacks operation'] } },
			budget: '30',
		});
		assert.equal(r.status, 1, r.out);
		assert.ok(Date.now() - started < 15_000);
		assert.match(r.out, /::error title=E2E teardown verify::.*cannot check it: unknown \(.*AccessDenied/);
	});

	it('keeps its backoff through a throttled DescribeStacks', () => {
		const throttled = 'error:An error occurred (Throttling) when calling the DescribeStacks operation: Rate exceeded';
		const r = run([A], {
			stacks: { [A]: { statuses: ['DELETE_FAILED', ...Array(10).fill(throttled), 'DELETE_FAILED'], afterDelete: [['gone']] } },
			delays: '400,400',
		});
		assert.equal(r.status, 0, r.out);
		const describes = r.calls.filter((c) => c[1] === 'describe-stacks');
		const del = r.calls.find((c) => c[1] === 'delete-stack');
		// Re-issued at the first DELETE_FAILED poll after the backoff, not 400 ms after the 12th.
		assert.ok(del.at(-1) - describes[11].at(-1) < 400, 'the backoff did not restart');
	});

	it('polls through a throttled DescribeStacks', () => {
		const r = run([A], {
			stacks: {
				[A]: {
					statuses: [
						'error:An error occurred (Throttling) when calling the DescribeStacks operation: Rate exceeded',
						'DELETE_IN_PROGRESS',
						'gone',
					],
				},
			},
		});
		assert.equal(r.status, 0, r.out);
	});
});
