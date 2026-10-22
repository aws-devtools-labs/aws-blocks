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
//    are currently reading from cdk.out" / "Another CLI is currently synthing".
//    An orphaned deploy that had not yet submitted its stack operation could
//    also submit it after the cleanup ran (an operation CloudFormation already
//    has runs to the end either way; the destroy's retries absorb that).
//    This stops every process carrying this job's RUNNER_TRACKING_ID, the id
//    the runner itself uses to terminate orphans at job end, except this
//    process, its ancestors, and everything the cleanup step itself started.
//    CDK treats a lock held by a dead PID as stale.
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
		let ppid;
		try {
			// The command name in field 2 may contain spaces or parens; the fields
			// after its closing paren are space-separated (state, then ppid).
			const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
			ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
		} catch {
			continue; // exited meanwhile
		}
		let trackingId;
		try {
			const env = readFileSync(`/proc/${name}/environ`, 'utf8').split('\0');
			trackingId = env.find((e) => e.startsWith(`${TRACKING_VAR}=`))?.slice(TRACKING_VAR.length + 1);
		} catch {
			// another user's process: keep it, so the ancestry walk has no gap
		}
		out.push({ pid: Number(name), ppid, trackingId });
	}
	return out;
}

function listDarwinProcesses() {
	const r = spawnSync('ps', ['-E', '-ww', '-A', '-o', 'pid=,ppid=,command='], {
		encoding: 'utf8',
		maxBuffer: 256 * 1024 * 1024,
	});
	if (r.error || r.status !== 0) {
		console.log(`Could not list processes: ${r.error?.message ?? r.stderr}`);
		return [];
	}
	return parsePsLines(r.stdout);
}

/** Parse `ps -E -o pid=,ppid=,command=` output (macOS). */
export function parsePsLines(text) {
	const out = [];
	for (const line of text.split('\n')) {
		const m = line.match(/^\s*(\d+)\s+(\d+)\s(.*)$/);
		if (!m) continue;
		const id = m[3].match(new RegExp(`(?:^|\\s)${TRACKING_VAR}=(\\S+)`));
		out.push({ pid: Number(m[1]), ppid: Number(m[2]), trackingId: id?.[1] });
	}
	return out;
}

/**
 * The pids to stop: every process with `trackingId`, except `selfPid`, its
 * ancestors (the step's shell, the runner) and the processes the cleanup step
 * started (descendants of the step's shell, e.g. a `| tee`). Returns [] when
 * the listing does not show `selfPid` with `trackingId`, rather than guess.
 */
export function findOrphans(processes, { selfPid, trackingId }) {
	const byPid = new Map(processes.map((p) => [p.pid, p]));
	const self = byPid.get(selfPid);
	// This process carries the id; if the listing doesn't show it, it can't see anyone's.
	if (!trackingId || self?.trackingId !== trackingId) return [];
	const keep = new Set([selfPid]);
	for (let p = self; p && !keep.has(p.ppid); p = byPid.get(p.ppid)) keep.add(p.ppid);
	// The parent is the cleanup step's own shell when it carries the job's id;
	// the runner itself does not, and orphans may have been reparented to it.
	const stepShell = byPid.get(self.ppid)?.trackingId === trackingId ? self.ppid : selfPid;
	const startedByStep = (p) => {
		const seen = new Set();
		for (let q = p; q && !seen.has(q.pid); q = byPid.get(q.ppid)) {
			if (q.ppid === stepShell) return true;
			seen.add(q.pid);
		}
		return false;
	};
	return processes
		.filter((p) => p.trackingId === trackingId && !keep.has(p.pid) && !startedByStep(p))
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

async function waitGone(pids, ms) {
	for (let waited = 0; waited < ms && pids.some(alive); waited += 250) await sleep(250);
}

/**
 * SIGTERM the orphans, re-listing so a child started meanwhile is caught too,
 * for up to `graceMs` in all; then SIGKILL what a fresh listing still finds,
 * and wait for them to go.
 */
export async function stopOrphans({ trackingId = process.env[TRACKING_VAR], graceMs = 8000 } = {}) {
	if (!trackingId) {
		console.log(`${TRACKING_VAR} is not set; not looking for processes left by an earlier step.`);
		return { stopped: [], survivors: [] };
	}
	const all = listProcesses();
	if (all.find((p) => p.pid === process.pid)?.trackingId !== trackingId) {
		console.log('Could not read process environments; not stopping leftover processes.');
		return { stopped: [], survivors: [] };
	}
	const find = () => findOrphans(listProcesses(), { selfPid: process.pid, trackingId });
	const stopped = new Set();
	const deadline = Date.now() + graceMs;
	for (let pids = find(); pids.length > 0 && Date.now() < deadline; pids = find()) {
		console.log(`Stopping ${pids.length} process(es) left by an earlier step: ${pids.join(' ')}`);
		for (const pid of pids) stopped.add(pid);
		signal(pids, 'SIGTERM');
		await waitGone(pids, Math.min(2000, deadline - Date.now()));
	}
	const left = find();
	if (left.length > 0) console.log(`SIGKILL: ${left.join(' ')}`);
	signal(left, 'SIGKILL');
	await waitGone(left, 2000);
	const survivors = left.filter(alive);
	if (survivors.length > 0) console.log(`Still present after SIGKILL: ${survivors.join(' ')}`);
	return { stopped: [...stopped], survivors };
}

/** Escape a workflow command's message (`%`, CR, LF). */
function escapeData(s) {
	return s.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/** Report a failed cleanup where a reviewer sees it: an annotation and the step summary. */
export function reportFailure(command, status, seconds) {
	const what = `\`${command.join(' ')}\` exited with ${status} after ${seconds}s`;
	console.log(
		`::warning title=E2E cleanup failed::${escapeData(what.replaceAll('`', "'"))}. This job's stacks may be left behind.`,
	);
	const summary = process.env.GITHUB_STEP_SUMMARY;
	if (!summary) return;
	try {
		appendFileSync(
			summary,
			`### E2E cleanup failed\n\n${what}. This job's stacks may be left behind; the stack-cleanup sweeper deletes leftover E2E stacks.\n`,
		);
	} catch (e) {
		console.log(`Could not write the step summary: ${e.message}`);
	}
}

async function main(argv) {
	const sep = argv.indexOf('--');
	const command = sep === -1 ? argv : argv.slice(sep + 1);
	if (command.length === 0) {
		console.error('Usage: node scripts/ci/e2e-cleanup.mjs -- <command> [args...]');
		return 2;
	}
	// The teardown must run even if the scan fails.
	try {
		await stopOrphans();
	} catch (e) {
		console.log(`::warning title=E2E cleanup::${escapeData(`Could not stop leftover processes: ${e.message}`)}`);
	}
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
