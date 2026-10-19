// Tests for the agent-user boundary (lib/isolation.mjs) and the components that must refuse to run
// without it: the builder (2-agent-run.ts), the judge (4-judge.ts) and step 3's executor
// (agent-exec.mjs). The fail-closed tests run anywhere (they point BENCH_AGENT_USER at a user that
// does not exist). The tests that need the real boundary skip on a dev box without passwordless
// sudo+runuser for the agent user, but FAIL on a GitHub Actions runner, so the selfcheck job proves
// them on a real hosted runner (including against its real RUNNER_TEMP). Fakes are assembled at runtime.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	BENCH_AGENT_USER,
	bareShellAllowed,
	buildAgentSpawn,
	enterAgentPhase,
	harnessUidPids,
	isCI,
	isolationAvailable,
	lockDownRunnerTemp,
	reapAgentProcesses,
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
			assert.deepEqual(buildAgentSpawn('true', '/tmp', false, {}), { file: 'bash', args: ['-c', "cd '/tmp' && true"], isolated: false });
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

	it('enterAgentPhase grants the workspace and verifies the boundary', needsBoundary, () => {
		const ws = mkdtempSync(join(tmpdir(), 'bench-ws-'));
		try {
			writeFileSync(join(ws, 'app.ts'), 'export {};\n');
			assert.deepEqual(enterAgentPhase(ws), { isolated: true });
			const { file, args } = buildAgentSpawn('id -un; cat app.ts', ws, true, { PATH: '/usr/bin:/bin' });
			const r = spawnSync(file, args, { encoding: 'utf-8' });
			assert.equal(r.status, 0, r.stderr);
			assert.match(r.stdout, new RegExp(`^${BENCH_AGENT_USER}\\nexport \\{\\};`));
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});
});
