#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Runs the teardown command of an E2E job's `if: always()` cleanup step.
//
//   node scripts/ci/e2e-cleanup.mjs -- <command> [args...]
//
// 1. Stops what a cancelled step left running. On cancel the runner signals
//    only the step's shell; its children (npm -> playwright -> tsx -> cdk) keep
//    running until the job ends. A live `cdk deploy` or `cdk destroy` holds the
//    lock on cdk.out, so the cleanup's own `cdk destroy` failed with "Other CLIs
//    are currently reading from cdk.out" / "Another CLI is currently synthing",
//    and an orphaned deploy could still create the stack after the cleanup ran.
//    This stops every process carrying this job's RUNNER_TRACKING_ID, the id
//    the runner itself uses to terminate orphans at job end, except this
//    process and its ancestors. CDK treats a lock held by a dead PID as stale.
// 2. Runs the command. A failure is reported as a ::warning:: annotation and in
//    the step summary, and this exits 0: a teardown failure is not a test
//    result, and the stack-cleanup sweeper reclaims what is left behind.
//
// Tests: node --test scripts/ci/e2e-cleanup.test.mjs

import { spawnSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const TRACKING_VAR = 'RUNNER_TRACKING_ID';

/**
 * List processes as `{ pid, ppid, trackingId }`. Linux reads /proc; macOS
 * reads `ps -E`, which appends each process's environment to its command.
 * Returns [] where neither is available.
 */
export function listProcesses() {
	if (process.platform === 'linux') return listLinuxProcesses();
	if (process.platform === 'darwin') return listDarwinProcesses();
	return [];
}

function listLinuxProcesses() {
	const out = [];
	for (const name of readdirSync('/proc')) {
		if (!/^\d+$/.test(name)) continue;
		try {
			// The command name in field 2 may contain spaces or parens; the fields
			// after its closing paren are space-separated (state, then ppid).
			const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
			const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
			const env = readFileSync(`/proc/${name}/environ`, 'utf8').split('\0');
			const entry = env.find((e) => e.startsWith(`${TRACKING_VAR}=`));
			out.push({ pid: Number(name), ppid, trackingId: entry?.slice(TRACKING_VAR.length + 1) });
		} catch {
			// exited meanwhile, or another user's process
		}
	}
	return out;
}

function listDarwinProcesses() {
	const r = spawnSync('ps', ['-E', '-ww', '-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
	if (r.status !== 0) return [];
	const out = [];
	for (const line of r.stdout.split('\n')) {
		const m = line.match(/^\s*(\d+)\s+(\d+)\s(.*)$/);
		if (!m) continue;
		const id = m[3].match(new RegExp(`(?:^|\\s)${TRACKING_VAR}=(\\S+)`));
		out.push({ pid: Number(m[1]), ppid: Number(m[2]), trackingId: id?.[1] });
	}
	return out;
}

/**
 * The pids to stop: every process with `trackingId`, except `selfPid`, its
 * ancestors (the step's shell, the runner) and its children (e.g. `ps`).
 */
export function findOrphans(processes, { selfPid, trackingId }) {
	if (!trackingId) return [];
	const byPid = new Map(processes.map((p) => [p.pid, p]));
	const keep = new Set([selfPid]);
	for (let p = byPid.get(selfPid); p && !keep.has(p.ppid); p = byPid.get(p.ppid)) keep.add(p.ppid);
	return processes
		.filter((p) => p.trackingId === trackingId && !keep.has(p.pid) && p.ppid !== selfPid)
		.map((p) => p.pid);
}

/** Until its parent reaps it, a killed process still answers kill(0), and CDK reads its lock as held. */
function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function signal(pids, sig) {
	for (const pid of pids) {
		try {
			process.kill(pid, sig);
		} catch {
			// already gone
		}
	}
}

/** SIGTERM the orphans, SIGKILL what is left after `graceMs`, then wait for them to go. */
export async function stopOrphans({ trackingId = process.env[TRACKING_VAR], graceMs = 5000 } = {}) {
	if (!trackingId) {
		console.log(`${TRACKING_VAR} is not set; not looking for processes left by an earlier step.`);
		return { stopped: [], survivors: [] };
	}
	const pids = findOrphans(listProcesses(), { selfPid: process.pid, trackingId });
	if (pids.length === 0) return { stopped: [], survivors: [] };
	console.log(`Stopping ${pids.length} process(es) left by an earlier step: ${pids.join(' ')}`);
	signal(pids, 'SIGTERM');
	for (let waited = 0; waited < graceMs && pids.some(alive); waited += 250) await sleep(250);
	signal(pids.filter(alive), 'SIGKILL');
	for (let waited = 0; waited < 5000 && pids.some(alive); waited += 250) await sleep(250);
	const survivors = pids.filter(alive);
	if (survivors.length > 0) console.log(`Still present after SIGKILL: ${survivors.join(' ')}`);
	return { stopped: pids, survivors };
}

/** Report a failed cleanup where a reviewer sees it: an annotation and the step summary. */
export function reportFailure(command, status, seconds) {
	const what = `\`${command.join(' ')}\` exited with ${status} after ${seconds}s`;
	console.log(
		`::warning title=E2E cleanup failed::${what.replaceAll('`', "'")}. This job's stacks may be left behind.`,
	);
	const summary = process.env.GITHUB_STEP_SUMMARY;
	if (summary) {
		appendFileSync(
			summary,
			`### E2E cleanup failed\n\n${what}. This job's stacks may be left behind; the stack-cleanup sweeper deletes leftover E2E stacks.\n`,
		);
	}
}

async function main(argv) {
	const sep = argv.indexOf('--');
	const command = sep === -1 ? argv : argv.slice(sep + 1);
	if (command.length === 0) {
		console.error('Usage: node scripts/ci/e2e-cleanup.mjs -- <command> [args...]');
		return 2;
	}
	await stopOrphans();
	const start = Date.now();
	const r = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
	const seconds = Math.round((Date.now() - start) / 1000);
	const status = r.error ? r.error.message : (r.status ?? r.signal);
	if (status === 0) {
		console.log(`Cleanup finished in ${seconds}s`);
	} else {
		reportFailure(command, status, seconds);
	}
	return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	process.exitCode = await main(process.argv.slice(2));
}
