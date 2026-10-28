// Tests for the agent-user boundary (lib/isolation.mjs) and the components that must refuse to run
// without it: the builder (2-agent-run.ts), the judge (4-judge.ts) and step 3's executor
// (agent-exec.mjs). The fail-closed tests run anywhere (they point BENCH_AGENT_USER at a user that
// does not exist). The tests that need the real boundary skip on a dev box without passwordless
// sudo+runuser for the agent user, but FAIL on a GitHub Actions runner, so the selfcheck job proves
// them on a real hosted runner (including against its real RUNNER_TEMP). Fakes are assembled at runtime.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	BENCH_AGENT_USER,
	bareShellAllowed,
	buildAgentSpawn,
	enterAgentPhase,
	findAgentWritable,
	groupKillArgv,
	harnessUidPids,
	isCI,
	isolationAvailable,
	lockDownExecPaths,
	lockDownRunnerTemp,
	reapAgentProcesses,
	trustedExecPaths,
	verifyAgentIsolation,
} from './isolation.mjs';

const LIB = dirname(fileURLToPath(import.meta.url));
const STEPS = dirname(LIB);
const TSX = import.meta.resolve('tsx');
const NO_SUCH_USER = 'bench-no-such-user-x';
const FAKE_SECRET = `fakeSecret/${'s'.repeat(29)}`;
// Skip the real-boundary tests only off a GitHub Actions runner; there a missing agent user must
// fail them (the selfcheck job creates it).
const onActionsRunner = process.env.GITHUB_ACTIONS === 'true';
const needsBoundary = {
	skip: !isolationAvailable() && !onActionsRunner ? `no passwordless sudo+runuser for ${BENCH_AGENT_USER}` : false,
};

function withEnv(vars, fn) {
	const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
	for (const [k, v] of Object.entries(vars)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		return fn();
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

function sudo(...args) {
	const r = spawnSync('/usr/bin/sudo', ['-n', ...args], { encoding: 'utf-8' });
	assert.equal(r.status, 0, `sudo ${args.join(' ')}: ${r.stderr}`);
}
function asAgent(script) {
	return spawnSync('/usr/bin/sudo', ['-n', '/usr/sbin/runuser', '-u', BENCH_AGENT_USER, '--', '/bin/bash', '-c', script], { encoding: 'utf-8' });
}

function sleepMs(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A child process env for a CI job whose agent user is missing (isolation can't be entered).
function ciEnvWithoutAgentUser(extra = {}) {
	return {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		CI: 'true',
		GITHUB_ACTIONS: 'true',
		BENCH_AGENT_USER: NO_SUCH_USER,
		AWS_SECRET_ACCESS_KEY: FAKE_SECRET,
		...extra,
	};
}

describe('CI detection + the local-only bare opt-in', () => {
	it('treats CI / GITHUB_ACTIONS as CI and refuses the bare opt-in there', () => {
		assert.equal(isCI({ CI: 'true' }), true);
		assert.equal(isCI({ CI: '1' }), true);
		assert.equal(isCI({ GITHUB_ACTIONS: 'true' }), true);
		assert.equal(isCI({ CI: 'false' }), false);
		assert.equal(isCI({}), false);
		assert.equal(bareShellAllowed({ BENCH_ALLOW_BARE_SHELL: '1' }), true);
		assert.equal(bareShellAllowed({ BENCH_ALLOW_BARE_SHELL: '1', CI: 'true' }), false);
		assert.equal(bareShellAllowed({ BENCH_ALLOW_BARE_SHELL: '1', GITHUB_ACTIONS: 'true' }), false);
		assert.equal(bareShellAllowed({}), false);
	});

	it('buildAgentSpawn refuses a non-isolated command unless bare is explicitly allowed off CI', () => {
		withEnv({ CI: 'true', GITHUB_ACTIONS: undefined, BENCH_ALLOW_BARE_SHELL: '1' }, () => {
			assert.throws(() => buildAgentSpawn('true', '/tmp', false, {}), /refusing to run an agent command as the harness uid/);
		});
		withEnv({ CI: undefined, GITHUB_ACTIONS: undefined, BENCH_ALLOW_BARE_SHELL: undefined }, () => {
			assert.throws(() => buildAgentSpawn('true', '/tmp', false, {}), /refusing/);
		});
		withEnv({ CI: undefined, GITHUB_ACTIONS: undefined, BENCH_ALLOW_BARE_SHELL: '1' }, () => {
			const spec = buildAgentSpawn('true', '/tmp', false, {});
			assert.match(spec.file, /^\/(usr\/)?bin\/bash$/, 'the shell is resolved by absolute system path, never via PATH');
			assert.deepEqual({ ...spec, file: 'bash' }, { file: 'bash', args: ['-c', "cd '/tmp' && true"], isolated: false });
		});
	});
});

describe('fail closed when the agent user is unavailable (CI)', () => {
	it('enterAgentPhase reports an error instead of a same-uid fallback', () => {
		const r = spawnSync(
			process.execPath,
			['--input-type=module', '-e', `import { enterAgentPhase } from ${JSON.stringify(join(LIB, 'isolation.mjs'))}; process.stdout.write(JSON.stringify(enterAgentPhase('/tmp')));`],
			{ env: ciEnvWithoutAgentUser(), encoding: 'utf-8' },
		);
		assert.equal(r.status, 0, r.stderr);
		const phase = JSON.parse(r.stdout);
		assert.equal(phase.isolated, false);
		assert.match(phase.error, /isolation unavailable/);
	});

	it('step 3 executor: `run` refuses (even with the bare opt-in) and never runs the command', () => {
		for (const extra of [{}, { BENCH_ALLOW_BARE_SHELL: '1' }]) {
			const r = spawnSync(process.execPath, [join(LIB, 'agent-exec.mjs'), 'run', '/tmp', '--', 'echo RAN-AS-HARNESS'], {
				env: ciEnvWithoutAgentUser(extra),
				encoding: 'utf-8',
			});
			assert.equal(r.status, 1, r.stderr);
			assert.doesNotMatch(r.stdout, /RAN-AS-HARNESS/);
			assert.match(r.stderr, /refusing to run an agent command as the harness uid/);
		}
		const pre = spawnSync(process.execPath, [join(LIB, 'agent-exec.mjs'), 'preflight', '/tmp'], { env: ciEnvWithoutAgentUser(), encoding: 'utf-8' });
		assert.equal(pre.status, 1);
	});

	it('builder: refuses before any model call and records isolation_failure', () => {
		const dir = mkdtempSync(join(tmpdir(), 'bench-failclosed-'));
		try {
			mkdirSync(join(dir, 'ws'));
			writeFileSync(join(dir, 'PROMPT.md'), 'task');
			const out = join(dir, 'builder-result.json');
			const r = spawnSync(process.execPath, ['--import', TSX, join(STEPS, '2-agent-run.ts')], {
				env: ciEnvWithoutAgentUser({ WORKSPACE: join(dir, 'ws'), TASK_PROMPT: join(dir, 'PROMPT.md'), OUTPUT: out }),
				encoding: 'utf-8',
				timeout: 60_000,
			});
			assert.equal(r.status, 1, r.stderr);
			assert.match(r.stderr, /REFUSING to run the agent/);
			const env = JSON.parse(readFileSync(out, 'utf-8'));
			assert.match(env.isolation_failure, /isolation unavailable/);
			assert.equal(env.stop_reason, 'error');
			assert.equal(env.cycle_count, 0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('judge: refuses before any model call and records isolation_failure', () => {
		const dir = mkdtempSync(join(tmpdir(), 'bench-failclosed-'));
		try {
			mkdirSync(join(dir, 'ws'));
			writeFileSync(join(dir, 'ws', 'app.ts'), 'export {};\n');
			writeFileSync(join(dir, 'PROMPT.md'), 'task');
			const out = join(dir, 'result.json');
			const r = spawnSync(process.execPath, ['--import', TSX, join(STEPS, '4-judge.ts')], {
				env: ciEnvWithoutAgentUser({
					WORKSPACE: join(dir, 'ws'),
					TASK_PROMPT: join(dir, 'PROMPT.md'),
					BUILDER_RESULT: join(dir, 'none.json'),
					EVIDENCE: '{}',
					OUTPUT: out,
				}),
				encoding: 'utf-8',
				timeout: 60_000,
			});
			assert.equal(r.status, 1, r.stderr);
			assert.match(r.stderr, /REFUSING to run the judge/);
			const result = JSON.parse(readFileSync(out, 'utf-8'));
			assert.equal(result.judge_error_type, 'isolation_unavailable');
			assert.match(result.isolation_failure, /isolation unavailable/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// run-shell kills each command's process group as root after the command exits. procps-ng 4.0.4
// (Ubuntu 24.04) turned `kill -9 -<pgid>` into kill(-1) whenever the pgid started with 1, which
// took down every process on the runner once pids passed 100000 (the judge, late in each cell).
describe('process-group kill argv', () => {
	// A pgid starting with 1 that no process group has (checked below), so signal 0 probes it safely.
	const ABSENT_PGID = 1999999;
	const absent = () => {
		try {
			process.kill(-ABSENT_PGID, 0);
			return false;
		} catch {
			return true;
		}
	};

	it('ends option parsing right before the negative pgid', () => {
		const argv = groupKillArgv(123456);
		assert.deepEqual(argv.slice(-2), ['--', '-123456']);
		assert.equal(argv[1], '-9');
	});

	it('reaches only a pgid that exists: signal 0 to an absent group starting with 1 fails', { skip: absent() ? false : 'probe pgid exists' }, (t) => {
		const [kill, ...args] = groupKillArgv(ABSENT_PGID, '-0');
		const r = spawnSync(kill, args, { stdio: 'ignore' });
		assert.notEqual(r.status, 0, `${kill} ${args.join(' ')} succeeded, so it signalled some other group`);
		// Without `--` a buggy kill probes kill(-1, 0) and succeeds. Signal 0 delivers nothing.
		const bare = spawnSync(kill, ['-0', `-${ABSENT_PGID}`], { stdio: 'ignore' });
		t.diagnostic(`${kill} -0 -${ABSENT_PGID} (no --) exit ${bare.status}: ${bare.status === 0 ? 'reads it as kill(-1)' : 'parses the whole pid'}`);
	});

	it('kills the target group and nothing else', async () => {
		const argv = groupKillArgv(1);
		// Never run a real SIGKILL through an argv without `--` (it could be kill(-1)).
		assert.equal(argv.at(-2), '--');
		const target = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
		const bystander = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
		try {
			const exited = new Promise((r) => target.once('exit', (code, sig) => r(sig)));
			const [kill, ...args] = groupKillArgv(target.pid);
			assert.equal(spawnSync(kill, args, { stdio: 'ignore' }).status, 0);
			assert.equal(await exited, 'SIGKILL');
			assert.equal(bystander.exitCode, null, 'the bystander group must survive');
			assert.equal(bystander.signalCode, null, 'the bystander group must survive');
		} finally {
			for (const p of [target, bystander]) {
				try {
					process.kill(-p.pid, 'SIGKILL');
				} catch {
					/* already gone */
				}
			}
		}
	});
});

describe('the agent-user boundary on a real host', () => {
	it('runner temp: readable before the lockdown, unreachable after it (file commands + harness environ)', needsBoundary, () => {
		// A stand-in RUNNER_TEMP with the runner's default modes (0755 dirs, 0644 files) holding a
		// set_env file with a credential, exactly what configure-aws-credentials leaves behind.
		const runnerTemp = mkdtempSync(join(tmpdir(), 'bench-runner-temp-'));
		try {
			chmodSync(runnerTemp, 0o755);
			const fc = join(runnerTemp, '_runner_file_commands');
			mkdirSync(fc, { mode: 0o755 });
			chmodSync(fc, 0o755);
			for (const f of ['set_env_x', 'add_path_x', 'set_output_x']) {
				writeFileSync(join(fc, f), `AWS_SECRET_ACCESS_KEY=${FAKE_SECRET}\n`, { mode: 0o644 });
			}
			const before = verifyAgentIsolation({ paths: [runnerTemp, fc, join(fc, 'set_env_x')] });
			assert.ok(before.some((p) => p.includes('can read') && p.includes('set_env_x')), `baseline must be readable: ${before}`);
			const paths = lockDownRunnerTemp({ RUNNER_TEMP: runnerTemp });
			assert.ok(paths.includes(join(fc, 'set_env_x')) && paths.includes(join(fc, 'add_path_x')));
			assert.deepEqual(verifyAgentIsolation({ paths, pids: harnessUidPids() }), []);
		} finally {
			rmSync(runnerTemp, { recursive: true, force: true });
		}
	});

	it(
		'on a GitHub-hosted runner: the real RUNNER_TEMP file commands and every runner-uid environ are unreachable',
		{ skip: process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_TEMP ? false : 'not on a GitHub Actions runner' },
		() => {
			const paths = lockDownRunnerTemp(process.env);
			assert.ok(paths.length > 0, 'expected RUNNER_TEMP + file-command paths');
			assert.deepEqual(verifyAgentIsolation({ paths, pids: harnessUidPids() }), []);
		},
	);

	it('reap: kills setsid/nohup escapees of the agent user and verifies none remain', needsBoundary, () => {
		const marker = `bench_reap_${process.pid}_${Math.random().toString(36).slice(2)}`;
		const { file, args } = buildAgentSpawn(`setsid nohup bash -c 'exec -a ${marker} sleep 300' </dev/null >/dev/null 2>&1 &`, '/tmp', true, { PATH: '/usr/bin:/bin' });
		assert.equal(spawnSync(file, args, { stdio: 'ignore' }).status, 0);
		assert.equal(spawnSync('pgrep', ['-u', BENCH_AGENT_USER, '-f', marker]).status, 0, 'escapee should be running');
		assert.equal(reapAgentProcesses(), true);
		assert.equal(spawnSync('pgrep', ['-u', BENCH_AGENT_USER]).status, 1, 'no agent-user process may remain');
	});

	// enterAgentPhase reaps before its ACL walks, which a live agent process could redirect with a
	// symlink swap (acl walks by path), so the reap must not lose a process that keeps changing pid.
	// Each link waits 50 ms before it forks the next and exits, so pgrep always has a process to see
	// (a link that forks at once lives too briefly for pgrep's /proc scan), while the pid keeps changing.
	it('reap: kills a fork-and-exit chain and nothing comes back', needsBoundary, () => {
		try {
			const started = asAgent(`setsid nohup bash -c 'r() { sleep 0.05; r & exit; }; r' </dev/null >/dev/null 2>&1 &`);
			assert.equal(started.status, 0, started.stderr);
			let running = false;
			for (let i = 0; i < 10 && !running; i++) {
				sleepMs(100);
				running = spawnSync('pgrep', ['-u', BENCH_AGENT_USER]).status === 0;
			}
			assert.equal(running, true, 'the chain should be running');
			assert.equal(reapAgentProcesses(), true);
			sleepMs(500);
			assert.equal(spawnSync('pgrep', ['-u', BENCH_AGENT_USER]).status, 1, 'no agent-user process may remain');
		} finally {
			reapAgentProcesses();
		}
	});

	it('enterAgentPhase grants the workspace and verifies the boundary', needsBoundary, () => {
		const ws = mkdtempSync(join(tmpdir(), 'bench-ws-'));
		try {
			writeFileSync(join(ws, 'app.ts'), 'export {};\n');
			// Off a runner, use system dirs only: a developer PATH may hold dirs this check (rightly)
			// refuses. On a runner the real PATH is used; the hosted-runner test below covers it too.
			const path = onActionsRunner ? process.env.PATH : '/usr/bin:/bin';
			assert.deepEqual(withEnv({ PATH: path }, () => enterAgentPhase(ws)), { isolated: true });
			const { file, args } = buildAgentSpawn('id -un; cat app.ts', ws, true, { PATH: '/usr/bin:/bin' });
			const r = spawnSync(file, args, { encoding: 'utf-8' });
			assert.equal(r.status, 0, r.stderr);
			assert.match(r.stdout, new RegExp(`^${BENCH_AGENT_USER}\\nexport \\{\\};`));
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	// Step 3 enters a second agent phase on the workspace step 2's agent wrote to. Only a file's
	// owner (or root) may set its ACL, so a runner-uid setfacl failed there on every cell.
	it('enterAgentPhase re-grants a workspace holding files the agent user created', needsBoundary, () => {
		const ws = mkdtempSync(join(tmpdir(), 'bench-ws-'));
		try {
			const path = onActionsRunner ? process.env.PATH : '/usr/bin:/bin';
			assert.deepEqual(withEnv({ PATH: path }, () => enterAgentPhase(ws)), { isolated: true });
			const made = asAgent(`cd '${ws}' && mkdir dist && echo built > dist/out.js && echo notes > notes.md`);
			assert.equal(made.status, 0, made.stderr);
			assert.equal(reapAgentProcesses(), true);
			assert.deepEqual(withEnv({ PATH: path }, () => enterAgentPhase(ws)), { isolated: true });
			const { file, args } = buildAgentSpawn('cat dist/out.js notes.md', ws, true, { PATH: '/usr/bin:/bin' });
			const r = spawnSync(file, args, { encoding: 'utf-8' });
			assert.equal(r.status, 0, r.stderr);
			assert.equal(r.stdout, 'built\nnotes\n');
		} finally {
			spawnSync('/usr/bin/sudo', ['-n', '/usr/bin/rm', '-rf', ws]);
		}
	});

	// The harness-user walk can't set ACLs inside a dir the agent made 0700, but the agent-user walk
	// restores the harness user's access there, so the next round gets through.
	it('enterAgentPhase re-grants a workspace holding a dir the agent made private', needsBoundary, () => {
		const ws = mkdtempSync(join(tmpdir(), 'bench-ws-'));
		try {
			const path = onActionsRunner ? process.env.PATH : '/usr/bin:/bin';
			assert.deepEqual(withEnv({ PATH: path }, () => enterAgentPhase(ws)), { isolated: true });
			const made = asAgent(`cd '${ws}' && mkdir private && echo kept > private/f && chmod 0700 private`);
			assert.equal(made.status, 0, made.stderr);
			assert.equal(reapAgentProcesses(), true);
			assert.deepEqual(withEnv({ PATH: path }, () => enterAgentPhase(ws)), { isolated: true });
			assert.equal(readFileSync(join(ws, 'private', 'f'), 'utf-8'), 'kept\n');
		} finally {
			spawnSync('/usr/bin/sudo', ['-n', '/usr/bin/rm', '-rf', ws]);
		}
	});

	// Each entry is granted by its owner, never by root, so an entry owned by anyone else is left
	// alone and fails the phase closed.
	it('enterAgentPhase fails closed on a workspace entry neither user owns, and leaves its ACL alone', needsBoundary, () => {
		const ws = mkdtempSync(join(tmpdir(), 'bench-ws-'));
		const foreign = join(ws, 'root-owned');
		try {
			const path = onActionsRunner ? process.env.PATH : '/usr/bin:/bin';
			assert.deepEqual(withEnv({ PATH: path }, () => enterAgentPhase(ws)), { isolated: true });
			sudo('/usr/bin/touch', foreign);
			sudo('/usr/bin/setfacl', '-b', foreign); // drop the ACL it inherited from the workspace default
			const phase = withEnv({ PATH: path, BENCH_ALLOW_BARE_SHELL: undefined }, () => enterAgentPhase(ws));
			assert.equal(phase.isolated, false);
			assert.match(phase.error ?? '', /workspace ACL grant failed/);
			const acl = spawnSync('/usr/bin/getfacl', ['--omit-header', foreign], { encoding: 'utf-8' });
			assert.equal(acl.status, 0, acl.stderr);
			assert.doesNotMatch(acl.stdout, new RegExp(`user:${BENCH_AGENT_USER}:`));
		} finally {
			spawnSync('/usr/bin/sudo', ['-n', '/usr/bin/rm', '-rf', ws]);
		}
	});

	// The bench's phase sequence on one runner: the builder (step 2), step 3's re-entry, the judge
	// step's root freeze of the workspace, then the judge on a staged copy with the workspace as an
	// extra agent dir. No CI run got past step 3 before #1037, so the judge never ran after the others.
	it('phase sequence: builder, step 3 re-entry, freeze, then the judge on a staged copy', needsBoundary, () => {
		const ws = mkdtempSync(join(tmpdir(), 'bench-ws-'));
		let judgeSrc;
		try {
			const path = onActionsRunner ? process.env.PATH : '/usr/bin:/bin';
			const detached = `(setsid nohup sleep 300 </dev/null >/dev/null 2>&1 &)`;
			assert.deepEqual(withEnv({ PATH: path }, () => enterAgentPhase(ws)), { isolated: true });
			const built = asAgent(
				`cd '${ws}' && mkdir -p src node_modules/dep && echo app > src/index.ts && echo dep > node_modules/dep/index.js && ${detached}`,
			);
			assert.equal(built.status, 0, built.stderr);
			assert.equal(reapAgentProcesses(), true);
			assert.deepEqual(withEnv({ PATH: path }, () => enterAgentPhase(ws)), { isolated: true });
			const served = asAgent(`cd '${ws}' && ${detached}`);
			assert.equal(served.status, 0, served.stderr);
			assert.equal(reapAgentProcesses(), true);
			sudo('/usr/bin/chmod', '-R', 'a-w', ws);
			judgeSrc = mkdtempSync(join(tmpdir(), 'bench-judge-src-'));
			cpSync(join(ws, 'src'), join(judgeSrc, 'src'), { recursive: true });
			assert.deepEqual(withEnv({ PATH: path }, () => enterAgentPhase(judgeSrc, { agentDirs: [ws] })), { isolated: true });
			const { file, args } = buildAgentSpawn('cat src/index.ts', judgeSrc, true, { PATH: '/usr/bin:/bin' });
			const r = spawnSync(file, args, { encoding: 'utf-8' });
			assert.equal(r.status, 0, r.stderr);
			assert.equal(r.stdout, 'app\n');
			assert.equal(reapAgentProcesses(), true);
		} finally {
			spawnSync('/usr/bin/sudo', ['-n', '/usr/bin/rm', '-rf', ws, ...(judgeSrc ? [judgeSrc] : [])]);
		}
	});

	// The grant must not follow a symlink the agent planted in the workspace.
	it('the workspace grant does not follow an agent-planted symlink out of the workspace', needsBoundary, () => {
		const ws = mkdtempSync(join(tmpdir(), 'bench-ws-'));
		const outside = mkdtempSync(join(tmpdir(), 'bench-outside-'));
		try {
			writeFileSync(join(outside, 'secret'), `${FAKE_SECRET}\n`, { mode: 0o600 });
			const path = onActionsRunner ? process.env.PATH : '/usr/bin:/bin';
			assert.deepEqual(withEnv({ PATH: path }, () => enterAgentPhase(ws)), { isolated: true });
			const planted = asAgent(`cd '${ws}' && ln -s '${outside}' escape`);
			assert.equal(planted.status, 0, planted.stderr);
			assert.equal(reapAgentProcesses(), true);
			assert.deepEqual(withEnv({ PATH: path }, () => enterAgentPhase(ws)), { isolated: true });
			assert.deepEqual(verifyAgentIsolation({ paths: [outside, join(outside, 'secret')] }), []);
		} finally {
			spawnSync('/usr/bin/sudo', ['-n', '/usr/bin/rm', '-rf', ws]);
			rmSync(outside, { recursive: true, force: true });
		}
	});

	// Writable trusted executable paths: the hosted image ships e.g. /usr/local/bin and
	// /opt/hostedtoolcache world-writable, so the agent could plant a binary a later runner-uid step
	// (or sudo, as root) executes. This reproduces that layout in scratch dirs.

	it('exec lockdown: finds what the agent can write or replace, removes it, and leaves agent dirs alone', needsBoundary, () => {
		const base = mkdtempSync(join(tmpdir(), 'bench-exec-'));
		try {
			chmodSync(base, 0o755);
			const bin = join(base, 'bin'); // a root-owned, world-writable PATH dir (like /usr/local/bin)
			mkdirSync(bin);
			writeFileSync(join(bin, 'aws'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
			sudo('/usr/bin/chown', '-R', 'root:root', bin);
			sudo('/usr/bin/chmod', '0777', bin);
			const tree = join(base, 'toolcache'); // a world-writable install tree (like /opt/hostedtoolcache)
			mkdirSync(join(tree, 'node', 'bin'), { recursive: true });
			writeFileSync(join(tree, 'node', 'bin', 'node'), '#!/bin/sh\n', { mode: 0o755 });
			chmodSync(join(tree, 'node', 'bin', 'node'), 0o777);
			chmodSync(join(tree, 'node'), 0o777);
			const agentDir = join(tree, 'agent-cache'); // an agent dir inside a tree: excluded, untouched
			mkdirSync(agentDir);
			chmodSync(agentDir, 0o777);
			const anc = join(base, 'open'); // a writable, non-sticky ancestor of a locked dir
			mkdirSync(join(anc, 'locked'), { recursive: true });
			chmodSync(anc, 0o777);
			const targets = { flat: [bin, join(anc, 'locked')], deep: [tree], exclude: [agentDir] };

			const before = findAgentWritable(targets);
			assert.deepEqual(before.deepRoots, [tree]);
			for (const p of [bin, anc]) assert.ok(before.writable.includes(p), `${p} must be reported: ${before.writable}`);
			assert.ok(!before.writable.some((p) => p.startsWith(agentDir)), 'excluded agent dir must not be reported');
			assert.ok(!before.writable.includes('/tmp'), 'a sticky ancestor (/tmp) is not replaceable and must not be reported');
			assert.match(asAgent(`echo planted > ${bin}/proof && echo ok`).stdout, /ok/, 'baseline: the agent can plant');
			sudo('/usr/bin/rm', '-f', join(bin, 'proof'));

			assert.deepEqual(lockDownExecPaths(targets, { fix: true }), []);
			const plant = asAgent(`echo x > ${bin}/aws2; echo x > ${tree}/node/bin/node; mv ${anc}/locked ${anc}/moved; echo done`);
			assert.match(plant.stdout, /done/);
			assert.equal(existsSync(join(bin, 'aws2')), false, 'no planting in the locked PATH dir');
			assert.equal(readFileSync(join(tree, 'node', 'bin', 'node'), 'utf-8'), '#!/bin/sh\n', 'no replacing a locked binary');
			assert.equal(existsSync(join(anc, 'locked')), true, 'no renaming a locked dir away through its parent');
			assert.match(asAgent(`touch ${agentDir}/still-writable && echo ok`).stdout, /ok/, 'the agent dir keeps its access');
		} finally {
			spawnSync('/usr/bin/sudo', ['-n', '/usr/bin/rm', '-rf', base]);
		}
	});

	it('exec lockdown follows a symlinked tree entry to its writable target (tool cache → /usr/lib/jvm-style)', needsBoundary, () => {
		const base = mkdtempSync(join(tmpdir(), 'bench-exec-'));
		try {
			chmodSync(base, 0o755);
			const target = join(base, 'jvm', 'jdk'); // outside the trusted tree, world-writable, root-owned
			mkdirSync(join(target, 'bin'), { recursive: true });
			writeFileSync(join(target, 'bin', 'java'), '#!/bin/sh\n', { mode: 0o755 });
			sudo('/usr/bin/chown', '-R', 'root:root', join(base, 'jvm'));
			sudo('/usr/bin/chmod', '-R', '0777', join(base, 'jvm'));
			const tree = join(base, 'toolcache', 'Java', '21');
			mkdirSync(tree, { recursive: true });
			spawnSync('/bin/ln', ['-s', target, join(tree, 'x64')]);
			const targets = { flat: [], deep: [join(base, 'toolcache')], exclude: [] };
			assert.ok(findAgentWritable(targets).writable.includes(join(tree, 'x64')), 'the link to a writable target is reported');
			assert.deepEqual(lockDownExecPaths(targets, { fix: true }), []);
			const r = asAgent(`echo x > ${target}/planted; echo x > ${target}/bin/java; echo done`);
			assert.match(r.stdout, /done/);
			assert.equal(existsSync(join(target, 'planted')), false, 'no planting in the linked target');
			assert.equal(readFileSync(join(target, 'bin', 'java'), 'utf-8'), '#!/bin/sh\n', 'no replacing a binary in the linked tree');
		} finally {
			spawnSync('/usr/bin/sudo', ['-n', '/usr/bin/rm', '-rf', base]);
		}
	});

	it('exec lockdown fails closed when the agent already owns a file in a trusted dir', needsBoundary, () => {
		const base = mkdtempSync(join(tmpdir(), 'bench-exec-'));
		try {
			chmodSync(base, 0o755);
			const bin = join(base, 'bin');
			mkdirSync(bin);
			sudo('/usr/bin/chown', 'root:root', bin);
			sudo('/usr/bin/chmod', '0777', bin);
			assert.equal(asAgent(`printf '#!/bin/sh\\n' > ${bin}/aws && chmod 755 ${bin}/aws`).status, 0);
			const problems = lockDownExecPaths({ flat: [bin], deep: [], exclude: [] }, { fix: true });
			assert.ok(problems.some((p) => p.includes(join(bin, 'aws'))), `a planted, agent-owned binary must keep the check failing: ${problems}`);
		} finally {
			spawnSync('/usr/bin/sudo', ['-n', '/usr/bin/rm', '-rf', base]);
		}
	});
});

describe('trusted executable paths (what later runner-uid steps run from)', () => {
	it('covers PATH + sudo secure_path, symlink targets, the node install, checkout, actions and tool cache; excludes agent dirs', () => {
		const base = mkdtempSync(join(tmpdir(), 'bench-trusted-'));
		try {
			const custom = join(base, 'custom-bin');
			const targetDir = join(base, 'real-bin');
			mkdirSync(custom);
			mkdirSync(targetDir);
			writeFileSync(join(targetDir, 'tool'), '');
			spawnSync('/bin/ln', ['-s', join(targetDir, 'tool'), join(custom, 'tool')]);
			const checkout = join(base, 'work', 'repo', 'repo');
			const actions = join(base, 'work', '_actions');
			mkdirSync(join(checkout, 'bench-app'), { recursive: true });
			mkdirSync(join(checkout, '.pw-browsers'));
			mkdirSync(actions);
			const t = trustedExecPaths(
				{
					PATH: `${custom}:/usr/bin:relative`,
					GITHUB_WORKSPACE: checkout,
					RUNNER_WORKSPACE: join(base, 'work', 'repo'),
					WORKSPACE: join(checkout, 'bench-app'),
					PLAYWRIGHT_BROWSERS_PATH: join(checkout, '.pw-browsers'),
					RUNNER_TEMP: join(base, 'temp'),
				},
				['/tmp/judge-src'],
			);
			for (const d of [custom, realpathSync(targetDir), '/usr/bin']) assert.ok(t.flat.includes(d), `flat must include ${d}`);
			for (const d of ['/usr/local/bin', '/usr/sbin', '/bin']) if (existsSync(d)) assert.ok(t.flat.includes(d), `sudo secure_path ${d}`);
			assert.ok(!t.flat.includes('relative'));
			const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
			for (const d of [nodeRoot, checkout, actions]) assert.ok(t.deep.includes(resolve(d)), `deep must include ${d}`);
			for (const d of [join(checkout, 'bench-app'), join(checkout, '.pw-browsers'), join(base, 'temp'), '/tmp/judge-src']) {
				assert.ok(t.exclude.includes(d), `exclude must include ${d}`);
			}
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it(
		'on a GitHub-hosted runner: no runner PATH dir, secure_path dir, node binary or install tree is writable by the agent user',
		{ skip: process.env.GITHUB_ACTIONS === 'true' ? false : 'not on a GitHub Actions runner' },
		() => {
			const targets = trustedExecPaths(process.env);
			assert.deepEqual(lockDownExecPaths(targets), [], 'the lockdown must leave nothing writable');
			// Independent of findAgentWritable: test -w as the agent user, then try to plant/replace.
			const node = realpathSync(process.execPath);
			const dirs = [...new Set([...(process.env.PATH ?? '').split(':').filter((d) => d.startsWith('/')), '/usr/local/bin', '/usr/local/sbin', dirname(node)])];
			const quoted = dirs.filter((d) => existsSync(d)).map((d) => `'${d}'`).join(' ');
			const r = asAgent(
				`for d in ${quoted}; do [ -w "$d" ] && echo "WRITABLE $d"; touch "$d/.bench-plant" 2>/dev/null && echo "PLANTED $d"; done; ` +
					`[ -w '${node}' ] && echo "WRITABLE ${node}"; mv '${node}' '${node}.x' 2>/dev/null && echo "REPLACED ${node}"; echo __done__`,
			);
			assert.match(r.stdout, /__done__/);
			assert.doesNotMatch(r.stdout, /WRITABLE|PLANTED|REPLACED/, r.stdout);
		},
	);
});
