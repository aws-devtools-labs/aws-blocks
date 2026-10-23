// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Installs Playwright browsers and their OS packages
// (`npx playwright install --with-deps <browser...>`) with a silence watchdog
// and a bounded retry, so a stalled apt mirror fails one attempt in minutes
// instead of holding the job until its own timeout.
//
// Why silence and not a wall-clock bound per attempt: on hosted runners the
// apt phase is bimodal. Most installs take well under a minute, but on a
// slow-mirror day about one in ten trickles at ~30 kB/s for 5-14 minutes and
// still succeeds, so any per-attempt wall-clock bound short enough to help
// would kill those. A real hang is different: apt starts a fetch and then
// prints nothing (57 minutes, until the job timeout cancelled it). Across 103
// slow but successful installs the longest gap between two output lines was
// 4.5 minutes, so an attempt is killed after SILENCE_TIMEOUT_MS without output
// and retried. A retry resumes the .deb files the killed attempt already
// downloaded, so it costs little even when it lands on the same slow mirror.
//
// All attempts together stop at --deadline-minutes, so the wrapper always
// cleans up and reports its own error before the step's `timeout-minutes`
// (set it at least 2 minutes higher) cancels it.
//
// Run: node scripts/ci/install-playwright.mjs [--package <spec>] [--deadline-minutes <n>] <browser...>
//   --package           the npx package to run (default `playwright`, the
//                       workspace's own); e.g. `playwright@1.60.0` to pin one
//   --deadline-minutes  budget for all attempts (default 23)

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/** Kill an attempt after this long without any output (1.8x the longest gap seen in a successful install). */
export const SILENCE_TIMEOUT_MS = 8 * 60_000;
/** Total attempts, counting the first. */
export const ATTEMPTS = 3;
/** Default budget for all attempts together. */
export const DEADLINE_MINUTES = 23;
/** Don't start another attempt with less than this left before the deadline. */
const MIN_ATTEMPT_MS = 60_000;
/** After SIGTERM, how long the attempt gets to exit before SIGKILL. */
const KILL_GRACE_MS = 10_000;
/** After the child exits, how long to wait for a leftover holder of its stdio before moving on. */
const DRAIN_MS = 5_000;
/** The root processes `--with-deps` runs through sudo; they hold the apt and dpkg locks. */
const APT_PROCESSES = ['apt-get', 'dpkg'];

/**
 * Run a command, streaming its output through, and kill its process group if
 * it prints nothing for `silenceMs` or is still running at `deadlineAt`.
 *
 * The child is spawned detached so `kill(-pid)` reaches its group: npx and
 * node. `--with-deps` also runs apt-get through sudo; sudo and everything
 * under it run as root, out of this user's reach, and are left to
 * {@link cleanupApt}. The promise settles when the child has exited and its
 * stdio has closed, or {@link DRAIN_MS} after the exit if a survivor (such as
 * that root sudo) still holds the stdio open.
 *
 * @param onSpawn called with the child, so a signal handler can reach it
 * @param stdout where the child's stdout is copied (anything with `write`; default this process's)
 * @param stderr where the child's stderr is copied (default this process's)
 * @returns `{ code, signal, killed }` where `killed` is `'silence'` or
 *   `'deadline'` when this function stopped it, else null. Never rejects; a
 *   spawn error is reported as `code: null`.
 */
export function runWatched(
	cmd,
	args,
	{
		silenceMs = SILENCE_TIMEOUT_MS,
		deadlineAt = Number.POSITIVE_INFINITY,
		killGraceMs = KILL_GRACE_MS,
		drainMs = DRAIN_MS,
		env = process.env,
		log = console.log,
		onSpawn = () => {},
		stdout = process.stdout,
		stderr = process.stderr,
	} = {},
) {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env });
		onSpawn(child);
		let killed = null;
		let exit = null;
		let settled = false;
		let openStreams = 2;
		let killTimer;
		let drainTimer;
		let deadlineTimer;
		const stop = (reason, message) => {
			if (killed) return;
			killed = reason;
			clearTimeout(watchdog);
			clearTimeout(deadlineTimer);
			log(`::warning::${message}; stopping this attempt.`);
			killGroup(child, 'SIGTERM');
			killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), killGraceMs);
		};
		const settle = () => {
			if (settled) return;
			settled = true;
			clearTimeout(watchdog);
			clearTimeout(deadlineTimer);
			clearTimeout(killTimer);
			clearTimeout(drainTimer);
			child.stdout.destroy();
			child.stderr.destroy();
			resolve({ ...exit, killed });
		};
		const watchdog = setTimeout(() => stop('silence', `No output for ${Math.round(silenceMs / 1000)}s`), silenceMs);
		if (Number.isFinite(deadlineAt)) {
			deadlineTimer = setTimeout(() => stop('deadline', 'Install deadline reached'), Math.max(0, deadlineAt - Date.now()));
		}
		const onData = (sink) => (chunk) => {
			if (!killed && !exit) watchdog.refresh();
			sink.write(chunk);
		};
		const onClose = () => {
			openStreams--;
			if (openStreams === 0 && exit) settle();
		};
		child.stdout.on('data', onData(stdout));
		child.stderr.on('data', onData(stderr));
		child.stdout.on('close', onClose);
		child.stderr.on('close', onClose);
		child.on('error', (e) => {
			log(`::warning::${cmd} failed to start: ${e.message}`);
			exit = { code: null, signal: null };
			settle();
		});
		child.on('exit', (code, signal) => {
			exit = { code, signal };
			// The verdict is the exit; output a survivor prints while we drain can't turn it into a stall.
			clearTimeout(watchdog);
			clearTimeout(deadlineTimer);
			// The group may outlive its leader; take the rest down with it.
			if (killed) killGroup(child, 'SIGKILL');
			if (openStreams === 0) settle();
			else drainTimer = setTimeout(settle, drainMs);
		});
	});
}

/** Signal a detached child's process group. Never throws: an empty group, or one left with only root members, is normal. */
function killGroup(child, sig) {
	if (!child?.pid) return;
	try {
		process.kill(-child.pid, sig);
	} catch {
		/* already gone, or only root-owned members are left */
	}
}

/**
 * Best-effort recovery after a failed attempt on Linux: stop any apt-get or
 * dpkg a killed attempt left running as root (they hold the apt and dpkg
 * locks a retry needs, and the root sudo above them exits once they do), then
 * finish any interrupted package configuration. A no-op where passwordless
 * sudo is unavailable. Never throws.
 *
 * @param run a `spawnSync`-shaped function (injectable for tests)
 * @param wait a `sleep`-shaped function (injectable for tests)
 */
export async function cleanupApt({ run = spawnSync, wait = sleep, platform = process.platform } = {}) {
	if (platform !== 'linux') return;
	// Bound each root command on the root side: spawnSync's own timeout can't signal the root sudo,
	// so only `timeout` running under sudo stops a wedged dpkg before the wrapper's deadline.
	const sudo = (...a) =>
		run('sudo', ['-n', 'timeout', '-k', '5', '60', ...a], { stdio: 'inherit', timeout: 70_000 });
	if (run('sudo', ['-n', 'true'], { stdio: 'inherit', timeout: 10_000 }).status !== 0) return;
	for (const sig of ['TERM', 'KILL']) {
		const left = APT_PROCESSES.filter((name) => run('pgrep', ['-x', name], { timeout: 10_000 }).status === 0);
		if (left.length === 0) break;
		for (const name of left) sudo('pkill', `-${sig}`, '-x', name);
		await wait(5_000);
	}
	sudo('dpkg', '--configure', '-a');
}

/**
 * Record one attempt's outcome where later runs can be counted: a fixed
 * `install-playwright: attempt=<i>/<n> result=<result>` line in the log, and
 * the same line in the step summary when GITHUB_STEP_SUMMARY is set. A
 * recovered stall leaves the step green, so this is what keeps the stall rate
 * measurable. `result` is `ok`, `silence`, `deadline` or `exit-<code or signal>`.
 * Never throws.
 */
export function recordAttempt(i, attempts, result, { log = console.log, summaryFile = process.env.GITHUB_STEP_SUMMARY } = {}) {
	const line = `install-playwright: attempt=${i}/${attempts} result=${result}`;
	log(line);
	if (!summaryFile) return;
	try {
		appendFileSync(summaryFile, `${line}\n`);
	} catch {
		/* the summary is best-effort */
	}
}

/** The `result` recordAttempt reports for a runWatched result. */
function attemptResult(r) {
	if (r.killed) return r.killed;
	return r.code === 0 ? 'ok' : `exit-${r.code ?? r.signal}`;
}

/**
 * Run `attempt()` up to `attempts` times or until `deadlineAt`, calling
 * `cleanup()` after every failed attempt (the last one too, so nothing it
 * left behind holds the apt locks for the rest of the job).
 *
 * @param attempt `(i) => Promise<runWatched result>`
 * @param record `(i, attempts, result)`, called after every attempt; the script passes {@link recordAttempt}
 * @returns true once an attempt exits 0; false when they all failed or time ran out
 */
export async function withRetry(
	attempt,
	{
		attempts = ATTEMPTS,
		deadlineAt = Number.POSITIVE_INFINITY,
		minAttemptMs = MIN_ATTEMPT_MS,
		cleanup = cleanupApt,
		log = console.log,
		now = Date.now,
		record = () => {},
	} = {},
) {
	for (let i = 1; i <= attempts; i++) {
		const r = await attempt(i);
		record(i, attempts, attemptResult(r));
		if (r.code === 0 && !r.killed) return true;
		const why = r.killed === 'silence' ? 'stalled' : r.killed === 'deadline' ? 'ran out of time' : `exited with ${r.code ?? r.signal}`;
		await cleanup();
		const outOfTime = r.killed === 'deadline' || deadlineAt - now() < minAttemptMs;
		if (i === attempts || outOfTime) {
			log(`::error::Playwright install ${why} on attempt ${i}/${attempts}; giving up.`);
			return false;
		}
		log(`::warning::Playwright install ${why} on attempt ${i}/${attempts}; retrying.`);
	}
	return false;
}

/** Parse `[--package <spec>] [--deadline-minutes <n>] <browser...>`; throws on bad input. */
export function parseArgs(argv) {
	let pkg = 'playwright';
	let deadlineMinutes = DEADLINE_MINUTES;
	const browsers = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--package') {
			pkg = argv[++i];
			if (!pkg) throw new Error('--package needs a value');
		} else if (argv[i] === '--deadline-minutes') {
			deadlineMinutes = Number(argv[++i]);
			if (!(deadlineMinutes > 0)) throw new Error('--deadline-minutes needs a positive number');
		} else if (argv[i].startsWith('-')) {
			throw new Error(`unknown option ${argv[i]}`);
		} else browsers.push(argv[i]);
	}
	if (browsers.length === 0) {
		throw new Error('usage: install-playwright.mjs [--package <spec>] [--deadline-minutes <n>] <browser...>');
	}
	return { pkg, deadlineMinutes, browsers };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { pkg, deadlineMinutes, browsers } = parseArgs(process.argv.slice(2));
	const args = [pkg, 'install', '--with-deps', ...browsers];
	const deadlineAt = Date.now() + deadlineMinutes * 60_000;
	let current;
	// If the step is cancelled anyway, don't leave this attempt (or a root apt-get) running behind it.
	for (const sig of ['SIGINT', 'SIGTERM']) {
		process.on(sig, () => {
			killGroup(current, 'SIGKILL');
			for (const name of APT_PROCESSES) spawnSync('sudo', ['-n', 'pkill', '-KILL', '-x', name], { stdio: 'ignore' });
			process.exit(sig === 'SIGINT' ? 130 : 143);
		});
	}
	const ok = await withRetry(
		(i) => {
			console.log(`\n$ npx ${args.join(' ')}  (attempt ${i}/${ATTEMPTS})`);
			return runWatched('npx', args, { deadlineAt, onSpawn: (c) => (current = c) });
		},
		{ deadlineAt, record: recordAttempt },
	);
	process.exit(ok ? 0 : 1);
}
