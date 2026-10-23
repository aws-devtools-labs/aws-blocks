// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for scripts/ci/install-playwright.mjs, plus a check that every
// workflow step installing Playwright browsers goes through it with a step
// `timeout-minutes`, so an apt hang can't hold a job until its own timeout.
//
// Run: node --test scripts/ci/install-playwright.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { cleanupApt, DEADLINE_MINUTES, parseArgs, recordAttempt, runWatched, withRetry } from './install-playwright.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const quiet = () => {};

/**
 * Collects what runWatched copies from the child, so none of it reaches this file's stdout: under
 * `node --test` that stdout carries the runner's own reports, and stray output there can drop a
 * test's result (a failing one included). Pass as `{ stdout: s, stderr: s }`; read `s.text`.
 */
function sink() {
	const s = { text: '', write: (c) => ((s.text += c), true) };
	return s;
}
const silent = () => {
	const s = sink();
	return { stdout: s, stderr: s };
};
// A regression that stops the kill would otherwise hang the test until the CI job timeout.
const T = { timeout: 15_000 };

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Every step in the workflows and local composite actions, as `[file, job, step, jobDef]`. */
function allSteps() {
	const out = [];
	const wfDir = join(ROOT, '.github/workflows');
	for (const f of readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n))) {
		const doc = parse(readFileSync(join(wfDir, f), 'utf8'));
		for (const [job, def] of Object.entries(doc?.jobs ?? {})) {
			for (const step of def?.steps ?? []) out.push([f, job, step, def]);
		}
	}
	const actDir = join(ROOT, '.github/actions');
	for (const a of readdirSync(actDir)) {
		for (const name of ['action.yml', 'action.yaml']) {
			let text;
			try {
				text = readFileSync(join(actDir, a, name), 'utf8');
			} catch {
				continue;
			}
			for (const step of parse(text)?.runs?.steps ?? []) out.push([`actions/${a}`, '-', step, {}]);
		}
	}
	return out;
}

describe('workflow Playwright installs', () => {
	// Any `playwright install` spelling: playwright@1.2.3, playwright-core, @playwright/test.
	const RAW = /playwright\S*\s+install\b/;
	// Shell lines, with `\` continuations joined and comment lines dropped.
	const commandLines = (run) =>
		run
			.replace(/\\\n/g, ' ')
			.split('\n')
			.filter((l) => !l.trim().startsWith('#'));
	// The wrapper's deadline as the script will read it: from the command line itself, up to any
	// shell operator (parseArgs throws on an option it doesn't know).
	const wrapperDeadline = (run) => {
		const line = commandLines(run).find((l) => /node\s+\S*install-playwright\.mjs/.test(l)) ?? '';
		const rest = /install-playwright\.mjs\s*(.*)/.exec(line)?.[1] ?? '';
		const argv = rest.split(/\s*(?:\|\||&&|[|;>&])/)[0].trim().split(/\s+/).filter(Boolean);
		return parseArgs(argv).deadlineMinutes;
	};
	const steps = allSteps();

	it('finds steps to check', () => {
		assert.ok(steps.length > 50, `parsed only ${steps.length} steps`);
	});

	it('no step runs a raw `playwright install` (unbounded on an apt hang)', () => {
		const raw = steps
			.filter(([, , s]) => typeof s.run === 'string')
			.filter(([, , s]) => commandLines(s.run).some((l) => RAW.test(l)))
			.map(([f, job, s]) => `${f} ${job}: ${s.name ?? s.run.split('\n')[0]}`);
		assert.deepEqual(raw, [], 'use node scripts/ci/install-playwright.mjs instead');
	});

	it('the guard catches every spelling of the install', () => {
		for (const run of [
			'npx playwright install --with-deps chromium',
			'npx playwright@1.60.0 install chromium',
			'npx playwright-core install --with-deps chromium',
			'npx @playwright/test install --with-deps',
			'npx playwright \\\n  install --with-deps chromium',
		]) {
			assert.ok(commandLines(run).some((l) => RAW.test(l)), run);
		}
		assert.ok(!commandLines('node scripts/ci/install-playwright.mjs chromium').some((l) => RAW.test(l)));
		assert.ok(!commandLines('# then `npx playwright install` runs').some((l) => RAW.test(l)));
	});

	it('reads the deadline from the command line the way the shell runs it', () => {
		const cmd = 'node scripts/ci/install-playwright.mjs';
		assert.equal(wrapperDeadline(`# see install-playwright.mjs --deadline-minutes 5 x\n${cmd} --deadline-minutes 40 chromium`), 40);
		assert.equal(wrapperDeadline(`${cmd} \\\n  --deadline-minutes 40 chromium`), 40);
		assert.equal(wrapperDeadline(`${cmd} --deadline-minutes 17 chromium | tee -a log`), 17);
		assert.equal(wrapperDeadline(`${cmd} chromium`), DEADLINE_MINUTES);
	});

	// The wrapper's deadline must end before the step's timeout-minutes (so it cleans up and reports
	// its own error), and the step's bound must leave the job time for the steps around it.
	it('every install-playwright.mjs step is bounded inside its job', () => {
		const wrapped = steps.filter(([, , s]) => typeof s.run === 'string' && s.run.includes('install-playwright.mjs'));
		assert.ok(wrapped.length >= 3, `expected the hosting, Amplify interop and agent-bench installs, got ${wrapped.length}`);
		const bad = [];
		for (const [f, job, s, def] of wrapped) {
			const step = Number(s['timeout-minutes']);
			const deadline = wrapperDeadline(s.run);
			const jobTimeout = Number(def['timeout-minutes'] ?? 360);
			if (!(step > 0)) bad.push(`${f} ${job}: no numeric step timeout-minutes`);
			else if (!(jobTimeout > 0)) bad.push(`${f} ${job}: job timeout-minutes is not a number`);
			else if (deadline + 2 > step) bad.push(`${f} ${job}: --deadline-minutes ${deadline} not 2 below timeout-minutes ${step}`);
			else if (step > jobTimeout - 10) bad.push(`${f} ${job}: timeout-minutes ${step} leaves < 10 of the job's ${jobTimeout}`);
		}
		assert.deepEqual(bad, []);
	});
});

describe('runWatched', () => {
	it('passes a command that keeps printing, however long it runs', T, async () => {
		// Prints every 50ms for ~0.6s against a 300ms silence bound.
		const r = await runWatched(
			process.execPath,
			['-e', 'let n=0;const t=setInterval(()=>{process.stdout.write(".");if(++n===12){clearInterval(t)}},50)'],
			{ silenceMs: 300, log: quiet, ...silent() },
		);
		assert.deepEqual(r, { code: 0, signal: null, killed: null });
	});

	it('kills a silent command and its whole process group', T, async () => {
		// The child prints its grandchild's pid, then both go silent.
		const out = sink();
		const r = await runWatched(
			process.execPath,
			[
				'-e',
				`const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'inherit'});console.log('grandchild='+c.pid);setTimeout(()=>{},60000)`,
			],
			{ silenceMs: 300, killGraceMs: 200, log: quiet, stdout: out, stderr: out },
		);
		assert.equal(r.killed, 'silence');
		assert.notEqual(r.code, 0);
		const pid = Number(/grandchild=(\d+)/.exec(out.text)?.[1]);
		assert.ok(pid > 0, `no grandchild pid in ${JSON.stringify(out.text)}`);
		await new Promise((res) => setTimeout(res, 100));
		assert.equal(alive(pid), false, 'grandchild survived the kill');
	});

	it('kills a command that never prints at all', T, async () => {
		const r = await runWatched(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
			silenceMs: 200,
			killGraceMs: 200,
			log: quiet,
			...silent(),
		});
		assert.equal(r.killed, 'silence');
	});

	it('kills a command that keeps printing past the deadline', T, async () => {
		const r = await runWatched(process.execPath, ['-e', 'setInterval(()=>process.stdout.write("."),50)'], {
			silenceMs: 5000,
			deadlineAt: Date.now() + 400,
			killGraceMs: 200,
			log: quiet,
			...silent(),
		});
		assert.equal(r.killed, 'deadline');
	});

	it('keeps a clean exit clean while a leftover process holds its output open', T, async () => {
		// The child exits 0 at once, but a detached grandchild keeps stdout open for 12s. Only the drain
		// timer can settle this well before that; without it the call waits for the grandchild.
		const t0 = Date.now();
		const r = await runWatched(
			process.execPath,
			[
				'-e',
				`require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},12000)'],{stdio:'inherit',detached:true}).unref();console.log('done')`,
			],
			{ silenceMs: 300, drainMs: 1000, log: quiet, ...silent() },
		);
		assert.deepEqual(r, { code: 0, signal: null, killed: null });
		assert.ok(Date.now() - t0 < 5000, 'waited for the leftover instead of draining');
	});

	it('kills a group member that ignores SIGTERM and holds the output open', T, async () => {
		// The grandchild shares the child's group and stdout, ignores SIGTERM and prints its pid. The
		// SIGTERM ends the child; the drain then settles the call long before the 10s SIGKILL timer, so
		// only the SIGKILL sent to the group when the stopped child exits takes the grandchild down.
		const out = sink();
		const r = await runWatched(
			process.execPath,
			[
				'-e',
				`require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('grandchild='+process.pid);setInterval(()=>{},1000)"],{stdio:'inherit'});setTimeout(()=>{},60000)`,
			],
			{ silenceMs: 1500, killGraceMs: 10_000, drainMs: 500, log: quiet, stdout: out, stderr: out },
		);
		const pid = Number(/grandchild=(\d+)/.exec(out.text)?.[1]);
		try {
			assert.equal(r.killed, 'silence');
			assert.ok(pid > 0, `no grandchild pid in ${JSON.stringify(out.text)}`);
			for (let i = 0; i < 20 && alive(pid); i++) await new Promise((res) => setTimeout(res, 50));
			assert.equal(alive(pid), false, 'the SIGTERM-ignoring grandchild survived the call');
		} finally {
			if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL');
		}
	});

	it('reports a failing exit code without flagging a kill', T, async () => {
		const r = await runWatched(process.execPath, ['-e', 'process.exit(100)'], { silenceMs: 5000, log: quiet, ...silent() });
		assert.deepEqual(r, { code: 100, signal: null, killed: null });
	});

	it('reports a command that cannot start', T, async () => {
		const r = await runWatched('/nonexistent/command', [], { silenceMs: 5000, log: quiet, ...silent() });
		assert.equal(r.code, null);
		assert.equal(r.killed, null);
	});
});

describe('withRetry', () => {
	const results = (...rs) => {
		const calls = [];
		return { calls, attempt: async (i) => (calls.push(i), rs[i - 1]) };
	};
	const ok = { code: 0, signal: null, killed: null };
	const stalled = { code: null, signal: 'SIGTERM', killed: 'silence' };
	const failed = { code: 100, signal: null, killed: null };

	it('stops at the first success', async () => {
		let cleanups = 0;
		const { calls, attempt } = results(ok);
		assert.equal(await withRetry(attempt, { cleanup: async () => cleanups++, log: quiet }), true);
		assert.deepEqual(calls, [1]);
		assert.equal(cleanups, 0);
	});

	it('cleans up and retries after a stall or a failure', async () => {
		let cleanups = 0;
		const { calls, attempt } = results(stalled, failed, ok);
		assert.equal(await withRetry(attempt, { cleanup: async () => cleanups++, log: quiet }), true);
		assert.deepEqual(calls, [1, 2, 3]);
		assert.equal(cleanups, 2);
	});

	it('gives up after the bounded number of attempts, cleaning up after the last one too', async () => {
		let cleanups = 0;
		const { calls, attempt } = results(stalled, stalled, stalled, ok);
		const lines = [];
		assert.equal(await withRetry(attempt, { cleanup: async () => cleanups++, log: (l) => lines.push(l) }), false);
		assert.deepEqual(calls, [1, 2, 3]);
		assert.equal(cleanups, 3);
		assert.match(lines.at(-1), /^::error::.*attempt 3\/3/);
	});

	it('does not retry once the deadline killed an attempt', async () => {
		let cleanups = 0;
		const { calls, attempt } = results({ code: null, signal: 'SIGTERM', killed: 'deadline' }, ok);
		const lines = [];
		assert.equal(await withRetry(attempt, { cleanup: async () => cleanups++, log: (l) => lines.push(l) }), false);
		assert.deepEqual(calls, [1]);
		assert.equal(cleanups, 1);
		assert.match(lines.at(-1), /^::error::.*ran out of time/);
	});

	it('does not start an attempt too close to the deadline', async () => {
		const { calls, attempt } = results(failed, ok);
		const opts = { deadlineAt: 100_000, minAttemptMs: 60_000, now: () => 50_000, cleanup: async () => {}, log: quiet };
		assert.equal(await withRetry(attempt, opts), false);
		assert.deepEqual(calls, [1]);
	});

	it('treats a stalled attempt that exited 0 after SIGTERM as a failure', async () => {
		const { calls, attempt } = results({ code: 0, signal: null, killed: 'silence' }, ok);
		assert.equal(await withRetry(attempt, { cleanup: async () => {}, log: quiet }), true);
		assert.deepEqual(calls, [1, 2]);
	});

	it('records every attempt, including the one that succeeds', async () => {
		const { attempt } = results(stalled, failed, { code: null, signal: 'SIGKILL', killed: null }, ok);
		const recorded = [];
		const opts = { attempts: 4, cleanup: async () => {}, log: quiet, record: (...a) => recorded.push(a.join(' ')) };
		assert.equal(await withRetry(attempt, opts), true);
		assert.deepEqual(recorded, ['1 4 silence', '2 4 exit-100', '3 4 exit-SIGKILL', '4 4 ok']);
	});
});

describe('recordAttempt', () => {
	it('logs a fixed marker line and appends it to the step summary', () => {
		const dir = mkdtempSync(join(tmpdir(), 'pw-summary-'));
		try {
			const summaryFile = join(dir, 'summary.md');
			const lines = [];
			recordAttempt(2, 3, 'silence', { log: (l) => lines.push(l), summaryFile });
			recordAttempt(3, 3, 'ok', { log: (l) => lines.push(l), summaryFile });
			assert.deepEqual(lines, ['install-playwright: attempt=2/3 result=silence', 'install-playwright: attempt=3/3 result=ok']);
			assert.equal(readFileSync(summaryFile, 'utf8'), `${lines.join('\n')}\n`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('only logs when there is no step summary, and never throws on a bad one', () => {
		const lines = [];
		recordAttempt(1, 3, 'ok', { log: (l) => lines.push(l), summaryFile: undefined });
		recordAttempt(1, 3, 'ok', { log: (l) => lines.push(l), summaryFile: join(tmpdir(), 'no-such-dir', 'x', 'summary.md') });
		assert.equal(lines.length, 2);
	});
});

describe('parseArgs', () => {
	it('defaults to the workspace playwright', () => {
		assert.deepEqual(parseArgs(['chromium']), {
			pkg: 'playwright',
			deadlineMinutes: DEADLINE_MINUTES,
			browsers: ['chromium'],
		});
	});
	it('takes a pinned package', () => {
		assert.deepEqual(parseArgs(['--package', 'playwright@1.60.0', '--deadline-minutes', '17', 'chromium']), {
			pkg: 'playwright@1.60.0',
			deadlineMinutes: 17,
			browsers: ['chromium'],
		});
	});
	it('rejects a missing browser or package value', () => {
		assert.throws(() => parseArgs([]), /usage/);
		assert.throws(() => parseArgs(['chromium', '--package']), /needs a value/);
		assert.throws(() => parseArgs(['--deadline-minutes', 'x', 'chromium']), /positive number/);
		assert.throws(() => parseArgs(['--deadline-minutes=17', 'chromium']), /unknown option/);
	});
});

describe('cleanupApt', () => {
	// A fake spawnSync: `alive` lists the processes pgrep finds, and pkill -KILL removes them;
	// `term` lists the ones a SIGTERM also stops.
	function fake({ sudo = true, alive = [], term = [] } = {}) {
		const calls = [];
		const left = new Set(alive);
		const run = (cmd, args) => {
			calls.push([cmd, ...args].join(' '));
			if (cmd === 'pgrep') return { status: left.has(args.at(-1)) ? 0 : 1 };
			if (args[1] === 'true') return { status: sudo ? 0 : 1 };
			const root = args.slice(5); // after `-n timeout -k 5 60`
			if (root[0] === 'pkill' && (root[1] === '-KILL' || term.includes(root.at(-1)))) left.delete(root.at(-1));
			return { status: 0 };
		};
		return { calls, run, wait: async () => {} };
	}

	it('does nothing without passwordless sudo', async () => {
		const f = fake({ sudo: false, alive: ['apt-get'] });
		await cleanupApt({ ...f, platform: 'linux' });
		assert.deepEqual(f.calls, ['sudo -n true']);
	});

	it('does nothing off Linux', async () => {
		const f = fake({ alive: ['apt-get'] });
		await cleanupApt({ ...f, platform: 'darwin' });
		assert.deepEqual(f.calls, []);
	});

	it('only repairs dpkg when nothing is left running', async () => {
		const f = fake();
		await cleanupApt({ ...f, platform: 'linux' });
		assert.deepEqual(f.calls, ['sudo -n true', 'pgrep -x apt-get', 'pgrep -x dpkg', 'sudo -n timeout -k 5 60 dpkg --configure -a']);
	});

	it('stops at SIGTERM when that is enough', async () => {
		const f = fake({ alive: ['apt-get'], term: ['apt-get'] });
		await cleanupApt({ ...f, platform: 'linux' });
		assert.ok(f.calls.includes('sudo -n timeout -k 5 60 pkill -TERM -x apt-get'));
		assert.ok(!f.calls.some((c) => c.includes('-KILL')));
		assert.equal(f.calls.at(-1), 'sudo -n timeout -k 5 60 dpkg --configure -a');
	});

	it('escalates to SIGKILL for what survives SIGTERM, then repairs dpkg', async () => {
		const f = fake({ alive: ['apt-get', 'dpkg'], term: ['dpkg'] });
		await cleanupApt({ ...f, platform: 'linux' });
		assert.ok(f.calls.includes('sudo -n timeout -k 5 60 pkill -TERM -x apt-get'));
		assert.ok(f.calls.includes('sudo -n timeout -k 5 60 pkill -TERM -x dpkg'));
		assert.ok(f.calls.includes('sudo -n timeout -k 5 60 pkill -KILL -x apt-get'));
		assert.ok(!f.calls.includes('sudo -n timeout -k 5 60 pkill -KILL -x dpkg'));
		assert.equal(f.calls.at(-1), 'sudo -n timeout -k 5 60 dpkg --configure -a');
	});
});

// The script entry, end to end, with fake `npx` and `sudo` first on PATH: npx prints, starts a
// silent grandchild and waits; sudo only logs its arguments (nothing real is installed or killed).
describe('install-playwright.mjs', () => {
	const SCRIPT = fileURLToPath(new URL('./install-playwright.mjs', import.meta.url));
	const dirs = [];
	after(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});
	function fakeBin() {
		const dir = mkdtempSync(join(tmpdir(), 'pw-install-'));
		dirs.push(dir);
		writeFileSync(join(dir, 'npx'), '#!/bin/sh\necho "npx $*"\nsleep 600 &\necho "grandchild=$!"\nwait\n');
		writeFileSync(join(dir, 'sudo'), `#!/bin/sh\necho "$*" >> ${join(dir, 'sudo.log')}\n`);
		chmodSync(join(dir, 'npx'), 0o755);
		chmodSync(join(dir, 'sudo'), 0o755);
		return dir;
	}
	function start(dir, args) {
		const child = spawn(process.execPath, [SCRIPT, ...args], {
			env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_STEP_SUMMARY: join(dir, 'summary.md') },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let out = '';
		child.stdout.on('data', (c) => (out += c));
		child.stderr.on('data', (c) => (out += c));
		const exited = new Promise((res) => child.on('exit', (code) => res(code)));
		const grandchild = () => Number(/grandchild=(\d+)/.exec(out)?.[1]);
		return { child, exited, grandchild, output: () => out };
	}
	const sudoLog = (dir) => {
		try {
			return readFileSync(join(dir, 'sudo.log'), 'utf8');
		} catch {
			return '';
		}
	};

	// Longer bound: on a host where pgrep finds a real apt-get, cleanupApt waits 2 x 5s.
	it('gives up at the deadline, cleans up and exits 1', { timeout: 30_000 }, async () => {
		const dir = fakeBin();
		const run = start(dir, ['--deadline-minutes', '0.03', 'chromium']);
		assert.equal(await run.exited, 1);
		assert.match(run.output(), /npx playwright install --with-deps chromium/);
		assert.match(run.output(), /::error::Playwright install ran out of time on attempt 1\/3/);
		assert.equal(readFileSync(join(dir, 'summary.md'), 'utf8'), 'install-playwright: attempt=1/3 result=deadline\n');
		assert.ok(run.grandchild() > 0, `no grandchild pid in ${JSON.stringify(run.output())}`);
		// cleanupApt is Linux-only.
		if (process.platform === 'linux') assert.match(sudoLog(dir), /dpkg --configure -a/);
		await new Promise((res) => setTimeout(res, 100));
		assert.equal(alive(run.grandchild()), false, 'grandchild survived');
	});

	it('on SIGTERM kills the attempt and any root apt-get/dpkg, and exits 143', T, async () => {
		const dir = fakeBin();
		const run = start(dir, ['chromium']);
		while (!run.grandchild()) await new Promise((res) => setTimeout(res, 20));
		run.child.kill('SIGTERM');
		assert.equal(await run.exited, 143);
		assert.match(sudoLog(dir), /pkill -KILL -x apt-get/);
		assert.ok(run.grandchild() > 0);
		assert.match(sudoLog(dir), /pkill -KILL -x dpkg/);
		await new Promise((res) => setTimeout(res, 100));
		assert.equal(alive(run.grandchild()), false, 'grandchild survived');
	});
});
