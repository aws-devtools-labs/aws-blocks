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
// only what this job deployed. A no-op when the suite already cleaned up.
//
// It issues DeleteStack and does not wait for the delete to finish: GitHub
// force-stops a cancelled job 5 minutes after the cancel, and a production
// stack takes ~12 minutes to delete. A delete that fails later is left to
// cleanup-stacks.yml. Failures it can see (a denied or rejected delete, a stack
// already DELETE_FAILED, a passing job that left a stack) fail the step.
//
// Env: JOB_STATUS (`job.status`), E2E_TEARDOWN_BUDGET_SECONDS (default 150).

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
// Errors that clear on their own: another operation still running on the
// stack, throttling, a network blip.
const RETRYABLE = /_IN_PROGRESS|Throttl|Rate exceeded|RequestLimitExceeded|timed out|Could not connect|\b50\d\b/i;

const appDir = process.argv[2];
if (!appDir) {
	console.error('Usage: node scripts/ci/e2e-teardown.mjs <app-dir>');
	process.exit(2);
}
const jobStatus = process.env.JOB_STATUS ?? '';
const deadline = Date.now() + Number(process.env.E2E_TEARDOWN_BUDGET_SECONDS ?? 150) * 1000;
const pollMs = Number(process.env.E2E_TEARDOWN_POLL_MS ?? 10_000);

const error = (msg) => console.log(`::error title=E2E teardown::${msg}`);

function aws(...args) {
	const r = spawnSync('aws', ['cloudformation', ...args, '--output', 'json', '--cli-read-timeout', '20'], {
		encoding: 'utf8',
		timeout: 60_000,
	});
	const err = (r.error?.message ?? r.stderr ?? '').trim();
	return { ok: r.status === 0, out: r.stdout, err: err || `aws exited ${r.status}` };
}

async function main() {
	const idFile = join(appDir, '.blocks-sandbox', 'sandbox-id.txt');
	if (!existsSync(idFile)) {
		console.log(`No ${idFile}: nothing was deployed.`);
		return 0;
	}
	const id = readFileSync(idFile, 'utf8').trim();
	// Both apps write `<user>-<6 chars>` or 8 hex chars; anything shorter could
	// match another run's stack.
	if (!/^[A-Za-z0-9-]{6,}$/.test(id)) {
		error(`Unexpected sandbox id '${id}' in ${idFile}; not deleting anything.`);
		return 1;
	}

	const list = aws(
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
	for (const { StackName: name, StackStatus: status } of mine) {
		if (status === 'DELETE_IN_PROGRESS') {
			console.log(`${name}: already DELETE_IN_PROGRESS.`);
			continue;
		}
		let res = aws('delete-stack', '--stack-name', name);
		while (!res.ok && RETRYABLE.test(res.err) && Date.now() + pollMs < deadline) {
			console.log(`${name}: delete not accepted yet (${res.err}); retrying.`);
			await sleep(pollMs);
			res = aws('delete-stack', '--stack-name', name);
		}
		if (!res.ok) {
			error(`DeleteStack ${name} (was ${status}) failed: ${res.err}`);
			failed = true;
			continue;
		}
		const after = aws('describe-stacks', '--stack-name', name, '--query', 'Stacks[0].StackStatus');
		const now = after.ok ? JSON.parse(after.out) : 'gone';
		if (now === 'DELETE_FAILED') {
			error(`${name} (was ${status}) is DELETE_FAILED; cleanup-stacks.yml retries it.`);
			failed = true;
			continue;
		}
		console.log(
			`::warning title=E2E teardown::Deleting ${name}, left ${status} by this ${jobStatus || 'unknown'} job (now ${now}).`,
		);
	}
	if (jobStatus === 'success') {
		error("The tests passed but left this job's stacks behind; their own destroy should have removed them.");
		failed = true;
	}
	return failed ? 1 : 0;
}

process.exit(await main());
