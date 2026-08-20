// Regression tests for the agent-bench shell layer (runShell / WorkspaceSandbox in run-shell.ts) and
// the judge's spec-leak `find`. They don't import the TS directly (the step modules self-execute and
// there's no TS loader under bare `node --test`), so they pin the platform SEMANTICS the fixes rely
// on against REAL processes.

import assert from 'node:assert/strict';
import { execSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const EXIT_DRAIN_GRACE_MS = 2000;

// MUST stay in sync with BENCH_AGENT_USER in run-shell.ts — the dedicated
// unprivileged user the agent's shell runs as so it cannot signal the harness.
const BENCH_AGENT_USER = process.env.BENCH_AGENT_USER || 'benchagent';

// Mirror isolationAvailable() in run-shell.ts: can the agent's shell run as benchagent via
// passwordless sudo+runuser here? When not (local dev), the isolation tests skip rather than fail.
function isolationAvailable() {
	try {
		const r = spawnSync('sudo', ['-n', 'runuser', '-u', BENCH_AGENT_USER, '--', 'true'], {
			stdio: 'ignore',
			timeout: 5000,
		});
		return r.status === 0 && !r.error;
	} catch {
		return false;
	}
}

function isAlive(pid) {
	try {
		// signal 0 = existence/permission probe, doesn't actually signal
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// The runShell containment distilled: detached spawn + resolve-on-close + SIGKILL-the-group-on-exit
// (+ bounded grace). If any of those regresses, the ~600s post-invoke hang (run 28549669447) is back.
function runContained(command, graceMs = EXIT_DRAIN_GRACE_MS) {
	return new Promise((resolve, reject) => {
		const proc = spawn('bash', ['-c', command], { detached: true });
		let stdout = '';
		let settled = false;
		let exited = false;
		let drain;
		const killGroup = () => {
			if (proc.pid === undefined) return;
			try {
				process.kill(-proc.pid, 'SIGKILL');
			} catch {
				// group already gone
			}
		};
		const settle = (fn) => {
			if (settled) return;
			settled = true;
			if (drain) clearTimeout(drain);
			killGroup();
			fn();
		};
		proc.stdout.on('data', (d) => {
			stdout += String(d);
		});
		proc.on('error', reject);
		proc.on('exit', () => {
			if (settled || exited) return;
			exited = true;
			killGroup();
			drain = setTimeout(() => settle(() => resolve({ stdout })), graceMs);
			drain.unref();
		});
		proc.on('close', () => settle(() => resolve({ stdout })));
	});
}

// Mirrors assertNoSpecLeak in 4-judge.ts — MUST stay in sync. Only test-spec CODE files + bench-tests/
// are leaks, never a framework *.spec.json manifest.
function findSpecLeaks(dir) {
	const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
	return execSync(
		`find ${shellQuote(dir)} \\( -name bench-tests -o -regextype posix-extended -regex '.*\\.spec\\.[cm]?[jt]sx?' \\) -print`,
		{ encoding: 'utf-8' },
	).trim();
}

describe('agent-bench shell runner — backgrounded-process containment', () => {
	it('resolves promptly, captures foreground output, and reaps the backgrounded child (the fix)', async () => {
		const start = Date.now();
		// Background a 30s sleep; bash echoes its PID then exits immediately.
		const { stdout } = await runContained('sleep 30 & echo $!');
		const elapsed = Date.now() - start;

		assert.ok(
			elapsed < 3000,
			`expected prompt resolution (~0s), but took ${elapsed}ms — a backgrounded child is holding 'close'`,
		);
		const bgPid = Number.parseInt(stdout.trim(), 10);
		assert.ok(Number.isInteger(bgPid) && bgPid > 0, `expected the backgrounded PID on stdout, got ${JSON.stringify(stdout)}`);

		// Allow a beat for the group SIGKILL, then confirm the leaked `sleep 30` is dead.
		await sleep(250);
		assert.equal(isAlive(bgPid), false, `backgrounded child ${bgPid} survived — group-kill did not reap it`);
	});
});

describe('agent-bench judge spec-leak detection', () => {
	it('flags test-spec CODE files + bench-tests/ but NOT the framework blocks.spec.json', () => {
		const dir = mkdtempSync(join(tmpdir(), 'bench-leak-'));
		try {
			mkdirSync(join(dir, 'aws-blocks'), { recursive: true });
			mkdirSync(join(dir, 'bench-tests'), { recursive: true });
			mkdirSync(join(dir, 'src'), { recursive: true });
			writeFileSync(join(dir, 'src', 'foo.spec.ts'), '');
			writeFileSync(join(dir, 'src', 'bar.spec.tsx'), '');
			writeFileSync(join(dir, 'src', 'util.spec.cjs'), '');
			writeFileSync(join(dir, 'aws-blocks', 'blocks.spec.json'), '{}');
			writeFileSync(join(dir, 'bench-tests', 'e2e.spec.ts'), '');
			writeFileSync(join(dir, 'src', 'app.ts'), '');

			const leaks = findSpecLeaks(dir).split('\n').filter(Boolean);

			// Real objective Playwright/test specs and the staged dir ARE leaks.
			assert.ok(leaks.some((l) => l.endsWith('/src/foo.spec.ts')), `foo.spec.ts should be flagged; got ${JSON.stringify(leaks)}`);
			assert.ok(leaks.some((l) => l.endsWith('/src/bar.spec.tsx')), 'bar.spec.tsx should be flagged');
			assert.ok(leaks.some((l) => l.endsWith('/src/util.spec.cjs')), 'util.spec.cjs should be flagged');
			assert.ok(leaks.some((l) => l.endsWith('/bench-tests')), 'bench-tests/ dir should be flagged');

			// The framework-generated OpenRPC manifest is NOT a leak (regression that killed run 28639226838).
			assert.ok(
				!leaks.some((l) => l.includes('blocks.spec.json')),
				`framework blocks.spec.json must NOT be flagged as a spec leak; got ${JSON.stringify(leaks)}`,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// Issue #184 — process-identity isolation. The agent's shell must NOT be able to signal the parent
// harness. Baseline (bare `bash -c`) reproduces the teardown: a broad by-name kill reaches a same-user
// harness process in another group. The fix runs the shell as a dedicated uid (benchagent) via
// `sudo -n runuser`, so the kernel forbids signalling the harness (EPERM) — and a distinct uid has no
// per-command lifetime, so a backgrounded `setsid` server SURVIVES across bash calls (the property pinned here).
// Each test uses a unique random marker so `pkill -f <marker>` only matches its own victim.
describe('agent-bench shell runner — process-identity isolation (issue #184)', () => {
	const isolation = isolationAvailable();

	// Detached, harness-user "harness" stand-in whose argv carries `marker` for `pkill -f`. Owned by
	// the TEST's uid — exactly what the benchagent-uid agent must NOT be able to kill.
	function spawnVictim(marker) {
		const proc = spawn('node', ['-e', 'setInterval(() => {}, 1e9)', marker], {
			detached: true,
			stdio: 'ignore',
		});
		proc.unref();
		return proc;
	}

	// The "agent" shell issuing the broad by-name kill (as in run 29107536283). `isolate` runs it as
	// benchagent via sudo+runuser (the fix), mirroring buildAgentSpawn in run-shell.ts.
	function runAgentKill(marker, isolate) {
		const inner = `pkill -9 -f ${marker}; sleep 0.2`;
		const { file, args } = isolate
			? { file: 'sudo', args: ['-n', 'runuser', '-u', BENCH_AGENT_USER, '--', 'bash', '-c', inner] }
			: { file: 'bash', args: ['-c', inner] };
		return new Promise((resolve) => {
			const proc = spawn(file, args, { detached: true, stdio: 'ignore' });
			proc.on('exit', () => resolve());
			proc.on('error', () => resolve());
		});
	}

	it('BASELINE: a bare-bash agent kill reaches the same-user harness across process groups', async () => {
		const marker = `BENCH_VICTIM_BASE_${process.pid}_${Math.random().toString(36).slice(2)}`;
		const victim = spawnVictim(marker);
		await sleep(300);
		assert.equal(isAlive(victim.pid), true, 'victim should be alive before the attack');
		await runAgentKill(marker, false);
		await sleep(400);
		const survived = isAlive(victim.pid);
		if (survived) {
			try {
				process.kill(victim.pid, 'SIGKILL');
			} catch {}
		}
		assert.equal(survived, false, 'BASELINE must reproduce the teardown: the bare-bash kill should reach the victim');
	});

	it('FIX: the benchagent-isolated agent kill CANNOT reach the harness (it survives)', { skip: !isolation }, async () => {
		const marker = `BENCH_VICTIM_UID_${process.pid}_${Math.random().toString(36).slice(2)}`;
		const victim = spawnVictim(marker);
		try {
			await sleep(300);
			assert.equal(isAlive(victim.pid), true, 'victim should be alive before the attack');
			await runAgentKill(marker, true);
			await sleep(400);
			assert.equal(
				isAlive(victim.pid),
				true,
				'FIX regressed: the benchagent agent kill reached the harness — #184 teardown is back',
			);
		} finally {
			try {
				process.kill(victim.pid, 'SIGKILL');
			} catch {}
		}
	});

	it('FIX preserves fairness: the benchagent shell can build/write in an ACL-granted workspace', { skip: !isolation }, async () => {
		const dir = mkdtempSync(join(tmpdir(), 'bench-uid-'));
		try {
			// Grant benchagent + the harness user rwx, mirroring prepareWorkspaceIsolation.
			const me = spawnSync('id', ['-un'], { encoding: 'utf-8' }).stdout.trim();
			const spec = `u:${BENCH_AGENT_USER}:rwx,u:${me}:rwx`;
			assert.equal(spawnSync('setfacl', ['-R', '-m', spec, dir]).status, 0, 'setfacl access ACL should succeed');
			assert.equal(spawnSync('setfacl', ['-R', '-d', '-m', spec, dir]).status, 0, 'setfacl default ACL should succeed');

			const inner = `cd ${dir} && whoami && echo built > artifact.txt && cat artifact.txt`;
			const r = spawnSync('sudo', ['-n', 'runuser', '-u', BENCH_AGENT_USER, '--', 'bash', '-c', inner], {
				encoding: 'utf-8',
				timeout: 10000,
			});
			assert.equal(r.status, 0, `isolated shell should exit 0; stderr=${r.stderr}`);
			// Runs as benchagent (a distinct uid) — what makes the harness unsignalable; the ACL keeps it writable.
			assert.equal(r.stdout.includes(BENCH_AGENT_USER), true, `expected user ${BENCH_AGENT_USER} in output: ${r.stdout}`);
			assert.equal(r.stdout.includes('built'), true, 'isolated shell should have written+read the workspace file');
			// The artifact is visible to the harness user (bidirectional ACL).
			const outside = execSync(`cat ${join(dir, 'artifact.txt')}`, { encoding: 'utf-8' }).trim();
			assert.equal(outside, 'built', 'workspace write should be readable by the harness user');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('FIX preserves cross-call server persistence: a setsid server started as benchagent survives into a later call', { skip: !isolation }, async () => {
		const srv = `BENCH_SRV_${process.pid}_${Math.random().toString(36).slice(2)}`;
		try {
			// Call #1: agent backgrounds a setsid server (as the web-app cells do), then returns.
			spawnSync(
				'sudo',
				['-n', 'runuser', '-u', BENCH_AGENT_USER, '--', 'bash', '-c', `setsid bash -c 'exec -a ${srv} sleep 30' </dev/null >/dev/null 2>&1 & disown; sleep 0.3`],
				{ timeout: 10000 },
			);
			await sleep(500);
			// Call #2 (separate runuser invocation): the server must still be alive. A per-command PID
			// namespace would have reaped it — this assertion pins the regression fixed here.
			const seen = spawnSync('sudo', ['-n', 'runuser', '-u', BENCH_AGENT_USER, '--', 'pgrep', '-u', BENCH_AGENT_USER, '-f', srv], {
				encoding: 'utf-8',
				timeout: 10000,
			});
			assert.equal(
				seen.stdout.trim().length > 0,
				true,
				'cross-call persistence regressed: the setsid server did not survive into the next call',
			);
		} finally {
			spawnSync('sudo', ['-n', 'runuser', '-u', BENCH_AGENT_USER, '--', 'pkill', '-9', '-f', srv], { timeout: 5000 });
		}
	});

	// The run-1/5 regression: a workspace ACL alone is NOT enough. The CI workspace's parents
	// (/home/runner, 0750) aren't world-searchable, so benchagent could rwx the workspace yet every
	// ABSOLUTE-path open (npm/node/tsc module resolution) failed EACCES. prepareWorkspaceIsolation must
	// ALSO grant benchagent search (x) on every ancestor. Pins both failure and fix via a real build.
	it('FIX: absolute-path module resolution works under a NON-world-searchable parent (run-1/5 regression)', { skip: !isolation }, () => {
		// A restrictive parent chain (0750) mimicking /home/runner, with a real npm project.
		const base = mkdtempSync(join(homedir(), 'bench-trav.'));
		chmodSync(base, 0o750);
		const ws = join(base, 'work', 'repo', 'repo', 'bench-app');
		mkdirSync(join(ws, 'node_modules', 'mydep'), { recursive: true });
		writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'bench-app', private: true, scripts: { build: 'node build.js' } }));
		writeFileSync(join(ws, 'build.js'), "const d=require('mydep');console.log('BUILD_OK '+d());");
		writeFileSync(join(ws, 'node_modules', 'mydep', 'package.json'), JSON.stringify({ name: 'mydep', version: '1.0.0', main: 'index.js' }));
		writeFileSync(join(ws, 'node_modules', 'mydep', 'index.js'), "module.exports=()=>'dep-loaded';");
		const me = spawnSync('id', ['-un'], { encoding: 'utf-8' }).stdout.trim();
		// Mirror buildAgentSpawn: re-materialize PATH/HOME after the privilege drop so npm/node are found.
		const runAs = (cmd) =>
			spawnSync(
				'sudo',
				['-n', 'runuser', '-u', BENCH_AGENT_USER, '--', 'env', `PATH=${process.env.PATH}`, `HOME=/home/${BENCH_AGENT_USER}`, 'bash', '-c', cmd],
				{ encoding: 'utf-8', timeout: 30000 },
			);
		try {
			// Workspace ACL ONLY (no ancestor search) — reproduces the failure.
			spawnSync('setfacl', ['-R', '-m', `u:${BENCH_AGENT_USER}:rwx,u:${me}:rwx`, ws]);
			spawnSync('setfacl', ['-R', '-d', '-m', `u:${BENCH_AGENT_USER}:rwx,u:${me}:rwx`, ws]);
			const before = runAs(`cat ${join(ws, 'package.json')}`);
			assert.notEqual(before.status, 0, 'BASELINE: absolute-path open should FAIL with only the workspace ACL (parent not searchable)');

			// Grant benchagent search (x) on every ancestor — the fix.
			let dir = join(ws, '..');
			let prev = '';
			while (dir && dir !== prev && dir !== '/') {
				spawnSync('setfacl', ['-m', `u:${BENCH_AGENT_USER}:x`, dir]);
				prev = dir;
				dir = join(dir, '..');
			}
			const build = runAs(`cd ${ws} && npm run build 2>&1`);
			assert.equal(build.status, 0, `npm run build should succeed after ancestor grants; out=${build.stdout}`);
			assert.ok(build.stdout.includes('BUILD_OK dep-loaded'), `expected BUILD_OK; got ${build.stdout}`);
		} finally {
			chmodSync(base, 0o755);
			spawnSync('sudo', ['-n', 'pkill', '-9', '-u', BENCH_AGENT_USER], { timeout: 5000 });
			rmSync(base, { recursive: true, force: true });
		}
	});
});
