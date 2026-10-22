#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Deletes the CloudFormation stacks an E2E job deployed and did not destroy.
// The suites destroy their stack in test.after, which never runs when the job
// is cancelled (a new push cancels the run), times out or crashes, so the
// stack leaked until the scheduled sweep. Runs in an `if: always()` step.
//
// Usage: node scripts/ci/e2e-teardown.mjs <app-dir>
//
// The app's CDK entry puts a random id, written once per checkout to
// <app-dir>/.blocks-sandbox/sandbox-id.txt, into every stack name. Another run
// of the same PR (same BLOCKS_STACK_SUFFIX) has another id, so this deletes
// only what this job deployed. When the suite cleaned up, it makes one
// ListStacks call and exits.
//
// It waits until each delete has started, not until it finishes: GitHub
// force-stops a cancelled job 5 minutes after the cancel, and a production
// stack takes ~12 minutes to delete. A delete that fails later is left to
// cleanup-stacks.yml. What it can see fails the step: stacks it cannot list,
// a delete that is denied, or one that has not started within the budget.
// A passing job whose suite left a stack (its test.after destroy failed, which
// node:test does not turn into a failed run) gets a warning and a new delete.
//
// Env: JOB_STATUS (`job.status`), E2E_TEARDOWN_BUDGET_SECONDS (default 100, under the
// step's 2-minute timeout).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// Every status but DELETE_COMPLETE, so ListStacks skips the 90 days of deleted ones.
const LIVE_STATUSES = [
	'CREATE_IN_PROGRESS',
	'CREATE_FAILED',
	'CREATE_COMPLETE',
	'ROLLBACK_IN_PROGRESS',
	'ROLLBACK_FAILED',
	'ROLLBACK_COMPLETE',
	'DELETE_IN_PROGRESS',
	'DELETE_FAILED',
	'UPDATE_IN_PROGRESS',
	'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS',
	'UPDATE_COMPLETE',
	'UPDATE_FAILED',
	'UPDATE_ROLLBACK_IN_PROGRESS',
	'UPDATE_ROLLBACK_FAILED',
	'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS',
	'UPDATE_ROLLBACK_COMPLETE',
	'REVIEW_IN_PROGRESS',
	'IMPORT_IN_PROGRESS',
	'IMPORT_COMPLETE',
	'IMPORT_ROLLBACK_IN_PROGRESS',
	'IMPORT_ROLLBACK_FAILED',
	'IMPORT_ROLLBACK_COMPLETE',
];
// Errors that clear on their own: throttling, a service or network blip, and
// CloudFormation refusing the delete while another operation on the stack runs.
function retryable(err) {
	return (
		/\((Throttling|ThrottlingException|RequestLimitExceeded|InternalFailure|ServiceUnavailable)\)/.test(err) ||
		/\(ValidationError\).*_IN_PROGRESS/.test(err) ||
		/Could not connect|Read timeout|Connect timeout|ETIMEDOUT/.test(err)
	);
}

const appDir = process.argv[2];
if (!appDir) {
	console.error('Usage: node scripts/ci/e2e-teardown.mjs <app-dir>');
	process.exit(2);
}
const jobStatus = process.env.JOB_STATUS || 'unknown';
const deadline = Date.now() + Number(process.env.E2E_TEARDOWN_BUDGET_SECONDS ?? 100) * 1000;
const pollMs = Number(process.env.E2E_TEARDOWN_POLL_MS ?? 10_000);

const error = (msg) => console.log(`::error title=E2E teardown::${msg}`);
const warning = (msg) => console.log(`::warning title=E2E teardown::${msg}`);

function aws(...args) {
	// No single call may outlive the budget.
	const timeout = Math.max(1000, Math.min(60_000, deadline - Date.now()));
	const r = spawnSync('aws', ['cloudformation', ...args, '--output', 'json', '--cli-read-timeout', '20'], {
		encoding: 'utf8',
		timeout,
	});
	const err = (r.error?.message ?? r.stderr ?? '').trim();
	return { ok: r.status === 0, out: r.stdout, err: err || `aws exited ${r.status}` };
}

// Repeats a call while it fails with a retryable error and the budget lasts.
async function awsRetry(label, ...args) {
	let res = aws(...args);
	while (!res.ok && retryable(res.err) && Date.now() + pollMs < deadline) {
		console.log(`${label}: ${res.err}; retrying.`);
		await sleep(pollMs);
		res = aws(...args);
	}
	return res;
}

// Status of a stack by name; 'gone' once it no longer exists.
function statusOf(name) {
	const r = aws('describe-stacks', '--stack-name', name, '--query', 'Stacks[0].StackStatus');
	if (r.ok) return JSON.parse(r.out);
	return /does not exist/.test(r.err) ? 'gone' : `unknown (${r.err})`;
}

async function main() {
	const idFile = join(appDir, '.blocks-sandbox', 'sandbox-id.txt');
	if (!existsSync(idFile)) {
		console.log(`No ${idFile}: nothing was deployed.`);
		return 0;
	}
	const id = readFileSync(idFile, 'utf8').trim();
	// The app writes `<user>-<6 base36 chars>`; anything much shorter could
	// match another run's stack.
	if (!/^[A-Za-z0-9-]{6,}$/.test(id)) {
		error(`Unexpected sandbox id '${id}' in ${idFile}; not deleting anything.`);
		return 1;
	}

	const list = await awsRetry(
		'ListStacks',
		'list-stacks',
		'--stack-status-filter',
		...LIVE_STATUSES,
		'--query',
		'StackSummaries[].{StackName: StackName, StackStatus: StackStatus, ParentId: ParentId}',
	);
	if (!list.ok) {
		error(`Could not list stacks: ${list.err}`);
		return 1;
	}
	const token = new RegExp(`(^|-)${id}(-|$)`);
	// Nested stacks go with their root stack.
	const mine = JSON.parse(list.out || '[]').filter((s) => !s.ParentId && token.test(s.StackName));
	if (mine.length === 0) {
		console.log(`No stack with id ${id} is left: nothing left to delete.`);
		return 0;
	}

	let failed = false;
	for (const { StackName: name, StackStatus: was } of mine) {
		if (was !== 'DELETE_IN_PROGRESS') {
			const res = await awsRetry(name, 'delete-stack', '--stack-name', name);
			if (!res.ok) {
				error(`DeleteStack ${name} (was ${was}) failed: ${res.err}`);
				failed = true;
				continue;
			}
		}
		// DeleteStack can be accepted without starting a delete; wait until it has.
		let now = statusOf(name);
		while (now !== 'DELETE_IN_PROGRESS' && now !== 'gone' && Date.now() + pollMs < deadline) {
			await sleep(pollMs);
			now = statusOf(name);
		}
		if (now !== 'DELETE_IN_PROGRESS' && now !== 'gone') {
			error(`${name} (was ${was}) is ${now} after DeleteStack; cleanup-stacks.yml retries it.`);
			failed = true;
			continue;
		}
		const why = jobStatus === 'success' ? "the tests passed but the suite's own destroy left it" : `this ${jobStatus} job left it`;
		warning(`Deleting ${name}: ${why} ${was} (now ${now}).`);
	}
	return failed ? 1 : 0;
}

process.exit(await main());
