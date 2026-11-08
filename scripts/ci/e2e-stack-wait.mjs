#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Waits for the CloudFormation stack deletes an E2E job started with
// scripts/ci/e2e-teardown.mjs, so the job itself doesn't have to.
//
// Usage: node scripts/ci/e2e-stack-wait.mjs <stack>...
//
// E2E Teardown Verify runs it. It waits until every stack is gone. A stack that
// lands in DELETE_FAILED gets its delete re-issued after a backoff (an API
// Gateway throttle, the most common cause, clears on its own). Unlike the
// retries of `destroy` / `sandbox:destroy` it does not empty S3 buckets first:
// cleanup-stacks.yml does that. A stack still DELETE_FAILED after the retries,
// or not gone within the budget, fails the step: it is named in an error
// annotation and in the job summary, with the resources that blocked the
// delete. cleanup-stacks.yml reclaims it later.
//
// Stack names come from e2e-teardown.mjs's `stacks` output; arguments may hold
// several space-separated names.
//
// Env: E2E_WAIT_BUDGET_SECONDS (default 2400), E2E_WAIT_POLL_MS (default 15000),
// E2E_WAIT_RETRY_DELAYS_MS (default "60000,120000"), GITHUB_STEP_SUMMARY.

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const stacks = [...new Set(process.argv.slice(2).flatMap((a) => a.split(/\s+/)).filter(Boolean))];
// CloudFormation stack names; anything else did not come from e2e-teardown.mjs.
const bad = stacks.filter((s) => !/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(s));
if (bad.length) {
	console.error('Usage: node scripts/ci/e2e-stack-wait.mjs <stack>...');
	console.error(`Not a stack name: ${bad.join(', ')}`);
	process.exit(2);
}

const started = Date.now();
const deadline = started + Number(process.env.E2E_WAIT_BUDGET_SECONDS ?? 2400) * 1000;
const pollMs = Number(process.env.E2E_WAIT_POLL_MS ?? 15_000);
const retryDelays = (process.env.E2E_WAIT_RETRY_DELAYS_MS ?? '60000,120000').split(',').filter(Boolean).map(Number);

const error = (msg) => console.log(`::error title=E2E teardown verify::${msg}`);
const minutes = (ms) => (ms / 60_000).toFixed(1);

function aws(...cmd) {
	const timeout = Math.max(10_000, Math.min(60_000, deadline - Date.now()));
	const r = spawnSync('aws', ['cloudformation', ...cmd, '--output', 'json', '--cli-read-timeout', '20'], {
		encoding: 'utf8',
		timeout,
	});
	const err = (r.error?.message ?? r.stderr ?? '').trim();
	return { ok: r.status === 0, out: r.stdout, err: err || `aws exited ${r.status}` };
}

// Status of a stack by name: 'gone' once it no longer exists, `unknown (...)`
// when the call failed (throttling, a blip), which the callers poll through.
function statusOf(name) {
	const r = aws('describe-stacks', '--stack-name', name, '--query', 'Stacks[0].StackStatus');
	if (r.ok) return JSON.parse(r.out);
	return /does not exist/.test(r.err) ? 'gone' : `unknown (${r.err})`;
}

// Errors that won't clear by polling.
const FATAL = /AccessDenied|not authorized|ExpiredToken|InvalidClientTokenId|UnrecognizedClient/;

// Re-issues the delete of a DELETE_FAILED stack, after the next backoff in
// retryDelays. `s` keeps the schedule; returns false once the retries are spent.
function retryDelete(name, s, now) {
	if (s.retries >= retryDelays.length) return false;
	if (!s.retryAt) {
		s.retryAt = now + retryDelays[s.retries];
		console.log(`${name}: DELETE_FAILED, ${blockers(name)}; retrying in ${retryDelays[s.retries] / 1000} s.`);
	} else if (now >= s.retryAt) {
		const r = aws('delete-stack', '--stack-name', name);
		console.log(`${name}: re-issued the delete${r.ok ? '' : ` (failed: ${r.err})`}.`);
		s.retries++;
		s.retryAt = 0;
		// DescribeStacks can lag the accepted delete for a moment.
		s.grace = 2;
	}
	return true;
}

// The resources CloudFormation could not delete, with its reasons.
function blockers(name) {
	const r = aws(
		'list-stack-resources',
		'--stack-name',
		name,
		'--query',
		"StackResourceSummaries[?ResourceStatus=='DELETE_FAILED'].[LogicalResourceId, ResourceType, ResourceStatusReason]",
	);
	if (!r.ok) return `(could not list its resources: ${r.err})`;
	const rows = JSON.parse(r.out || '[]');
	return rows.length ? rows.map(([id, type, why]) => `${id} (${type}): ${why}`).join('; ') : '(no failed resource listed)';
}

// Statuses that end an operation without deleting the stack: the teardown's
// delete never started (or was refused), so issue it again.
const SETTLED = /^(CREATE|UPDATE|IMPORT|ROLLBACK|UPDATE_ROLLBACK|IMPORT_ROLLBACK)_(COMPLETE|FAILED)$/;

async function waitForStacks() {
	const state = new Map(stacks.map((n) => [n, { retries: 0, retryAt: 0, grace: 0, reissued: false }]));
	const pending = () => [...state].filter(([, s]) => s.result === undefined);
	for (let last = false; pending().length; ) {
		// Past the deadline, one more poll, then whatever is left has failed.
		last = Date.now() >= deadline;
		for (const [name, s] of pending()) {
			const now = Date.now();
			s.last = statusOf(name);
			const inGrace = s.grace > 0;
			if (inGrace) s.grace--;
			// A fresh backoff only once the stack left DELETE_FAILED, not on a failed poll.
			if (s.last !== 'DELETE_FAILED' && !s.last.startsWith('unknown')) s.retryAt = 0;
			if (s.last === 'gone') {
				s.result = 'deleted';
				s.ms = now - started;
				console.log(`${name}: deleted (${minutes(s.ms)} min).`);
			} else if (s.last.startsWith('unknown') && FATAL.test(s.last)) {
				s.result = `cannot check it: ${s.last}`;
			} else if (s.last === 'DELETE_FAILED' && !inGrace) {
				if (!retryDelete(name, s, now)) {
					s.result = 'DELETE_FAILED';
					s.blockers = blockers(name);
				}
			} else if (SETTLED.test(s.last) && !s.reissued) {
				const r = aws('delete-stack', '--stack-name', name);
				console.log(`${name}: ${s.last}, no delete running; issued it${r.ok ? '' : ` (failed: ${r.err})`}.`);
				s.reissued = true;
				s.grace = 2;
			} else if (SETTLED.test(s.last) && !inGrace) {
				s.result = `${s.last}, the delete did not start`;
			}
			if (last && s.result === undefined) {
				s.result = `not deleted after ${minutes(Date.now() - started)} min (${s.last})`;
				if (s.last === 'DELETE_FAILED') s.blockers = blockers(name);
			}
		}
		if (pending().length) await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
	}

	const failed = [...state].filter(([, s]) => s.result !== 'deleted');
	for (const [name, s] of failed) error(`${name}: ${s.result}${s.blockers ? `. Blocked by ${s.blockers}` : ''}`);
	if (process.env.GITHUB_STEP_SUMMARY) {
		const rows = [...state].map(([name, s]) => {
			const result = s.result === 'deleted' ? 'deleted' : `**${s.result}**`;
			const waited = s.ms === undefined ? '-' : minutes(s.ms);
			return `| \`${name}\` | ${result} | ${waited} | ${s.retries} | ${(s.blockers || '').replaceAll('|', '\\|')} |`;
		});
		const title = failed.length ? `${failed.length} of ${state.size} stacks not deleted` : `${state.size} stacks deleted`;
		appendFileSync(
			process.env.GITHUB_STEP_SUMMARY,
			[
				`### E2E teardown: ${title}`,
				'',
				'Waited: minutes from the start of this step until the stack was gone.',
				failed.length ? 'cleanup-stacks.yml reclaims the stacks left behind.' : '',
				'',
				'| Stack | Result | Waited | Retries | Blocked by |',
				'|---|---|---|---|---|',
				...rows,
				'',
			].join('\n'),
		);
	}
	return failed.length ? 1 : 0;
}

process.exit(stacks.length === 0 ? 0 : await waitForStacks());
