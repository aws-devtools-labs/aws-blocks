// The uid boundary every agent-controlled process runs behind: the builder and judge shells
// (run-shell.ts) and every process step 3 starts from the agent's app (agent-exec.mjs).
//
// Agent code runs as a dedicated unprivileged user (`benchagent`, no sudo rights) via
// `sudo -n runuser -u benchagent -- env <shell-env> …`. The harness keeps the job credentials in its
// own env (it makes the Bedrock calls), so the boundary is what keeps them out of reach: a
// different uid cannot read the harness's /proc/<pid>/environ or signal it. Around it:
//   - FAIL CLOSED: under CI there is no same-uid fallback. A bare shell is only for local dev,
//     behind BENCH_ALLOW_BARE_SHELL=1, and refused when CI/GITHUB_ACTIONS is set.
//   - RUNNER TEMP: the runner's file-command files (GITHUB_ENV/OUTPUT/PATH/STATE, and the set_env
//     file configure-aws-credentials writes the AWS keys to) live under RUNNER_TEMP. Before agent
//     code runs, those dirs are made 0700 and the agent user is VERIFIED unable to list/read them
//     or any runner-uid /proc/<pid>/environ.
//   - REAP: every agent-user process is killed (and its crontab removed) at the start and end of
//     each agent phase and before anything is published or the role is re-assumed.
// Plain .mjs (no TS) so bare-node step scripts can use it; unit-tested in isolation.test.mjs.
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const BENCH_AGENT_USER = process.env.BENCH_AGENT_USER || 'benchagent';

/** True on a CI runner, where a same-uid fallback is never allowed. */
export function isCI(env = process.env) {
	const ci = (env.CI ?? '').toLowerCase();
	return (ci !== '' && ci !== 'false' && ci !== '0') || env.GITHUB_ACTIONS === 'true';
}

/** Local-dev-only escape hatch: run agent commands as the harness uid. Refused under CI. */
export function bareShellAllowed(env = process.env) {
	return env.BENCH_ALLOW_BARE_SHELL === '1' && !isCI(env);
}

let isolationProbe;
let agentHome;

// The agent user's home (passwd entry) so HOME is writable; falls back to /home/<user>.
function resolveAgentHome() {
	try {
		const r = spawnSync('getent', ['passwd', BENCH_AGENT_USER], { encoding: 'utf8', timeout: 5000 });
		const home = r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim().split(':')[5] : '';
		if (home) return home;
	} catch {
		/* fall through */
	}
	return `/home/${BENCH_AGENT_USER}`;
}

/**
 * Whether commands can run as the agent user via passwordless sudo+runuser (probed once, with the
 * exact transition used for every command). The harness user holds `NOPASSWD:ALL` on the hosted
 * runner, so a passing `runuser` probe implies `sudo -n kill/pkill/crontab` work too; the agent user
 * holds no sudo rights (agent-bench.yml fails the job otherwise).
 * @returns {boolean}
 */
export function isolationAvailable() {
	if (isolationProbe !== undefined) return isolationProbe;
	try {
		const r = spawnSync('sudo', ['-n', 'runuser', '-u', BENCH_AGENT_USER, '--', 'true'], {
			stdio: 'ignore',
			timeout: 5000,
		});
		isolationProbe = r.status === 0 && !r.error;
	} catch {
		isolationProbe = false;
	}
	if (isolationProbe) agentHome = resolveAgentHome();
	return isolationProbe;
}

/**
 * Grant the agent user + the harness user rwx on `root` (recursive + default ACL, so files either
 * creates stay mutually accessible) and the agent user search (x) on every ancestor: absolute-path
 * opens (npm/node/tsc) need x on each parent. x only traverses; it lists or reads nothing.
 * @param {string} root
 * @returns {boolean} true only if the workspace grants succeeded
 */
export function prepareWorkspaceIsolation(root) {
	if (!isolationAvailable()) return false;
	let me = process.env.USER ?? '';
	if (!me) me = spawnSync('id', ['-un'], { encoding: 'utf8', timeout: 5000 }).stdout?.trim() ?? '';
	const abs = resolve(root);
	const spec = `u:${BENCH_AGENT_USER}:rwx${me ? `,u:${me}:rwx` : ''}`;
	const access = spawnSync('setfacl', ['-R', '-m', spec, abs], { stdio: 'ignore', timeout: 120_000 });
	const dflt = spawnSync('setfacl', ['-R', '-d', '-m', spec, abs], { stdio: 'ignore', timeout: 120_000 });
	if (!(access.status === 0 && !access.error && dflt.status === 0 && !dflt.error)) return false;
	for (let dir = dirname(abs), prev = ''; dir && dir !== prev && dir !== '/'; prev = dir, dir = dirname(dir)) {
		spawnSync('setfacl', ['-m', `u:${BENCH_AGENT_USER}:x`, dir], { stdio: 'ignore', timeout: 10_000 });
	}
	return true;
}

/** Single-quote a string for safe interpolation into a shell command. */
export function shellQuote(s) {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The argv for one agent command (`cd <cwd> && <command>`), run as the agent user. `env` must be
 * the scrubbed shell env (secrets.mjs buildShellEnv): it is re-materialized on the `env KEY=VAL`
 * argv because runuser is not a login shell and sudo resets the env. Throws instead of falling back
 * to the harness uid unless `isolated` is false AND bareShellAllowed() (local dev only).
 * @param {string} command
 * @param {string} cwd
 * @param {boolean} isolated
 * @param {Record<string, string>} env
 * @returns {{file: string, args: string[], isolated: boolean}}
 */
export function buildAgentSpawn(command, cwd, isolated, env) {
	const inner = `cd ${shellQuote(cwd)} && ${command}`;
	if (isolated && isolationAvailable()) {
		const home = agentHome ?? `/home/${BENCH_AGENT_USER}`;
		const forwarded = { ...env, HOME: home, USER: BENCH_AGENT_USER, LOGNAME: BENCH_AGENT_USER };
		// Only valid shell identifiers (drops exported-function keys like `BASH_FUNC_x%%`).
		const envPairs = Object.entries(forwarded)
			.filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
			.map(([k, v]) => `${k}=${v}`);
		return {
			file: 'sudo',
			args: ['-n', 'runuser', '-u', BENCH_AGENT_USER, '--', 'env', '-i', ...envPairs, 'bash', '-c', inner],
			isolated: true,
		};
	}
	if (!bareShellAllowed()) {
		throw new Error(
			`refusing to run an agent command as the harness uid: ${BENCH_AGENT_USER} isolation is ${
				isolated ? 'unavailable' : 'not enabled'
			} (a bare shell needs BENCH_ALLOW_BARE_SHELL=1 and is never allowed under CI)`,
		);
	}
	return { file: 'bash', args: ['-c', inner], isolated: false };
}

function owned(path) {
	try {
		return statSync(path).uid === process.getuid?.();
	} catch {
		return false;
	}
}

/**
 * Make the runner's temp + file-command dirs (and the dirs of this step's GITHUB_* file commands)
 * 0700 when this uid owns them, and return every path the agent user must not reach: those dirs
 * and each file in them. Absent vars (local run) → nothing to protect.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
export function lockDownRunnerTemp(env = process.env) {
	const dirs = new Set();
	if (env.RUNNER_TEMP) {
		dirs.add(env.RUNNER_TEMP);
		dirs.add(join(env.RUNNER_TEMP, '_runner_file_commands'));
	}
	for (const k of ['GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_PATH', 'GITHUB_STATE', 'GITHUB_STEP_SUMMARY']) {
		if (env[k]) dirs.add(dirname(env[k]));
	}
	const paths = [];
	for (const dir of dirs) {
		let entries;
		try {
			entries = readdirSync(dir);
		} catch {
			continue; // absent
		}
		if (owned(dir)) {
			spawnSync('setfacl', ['-b', dir], { stdio: 'ignore', timeout: 10_000 });
			spawnSync('chmod', ['0700', dir], { stdio: 'ignore', timeout: 10_000 });
		}
		paths.push(dir, ...entries.map((e) => join(dir, e)));
	}
	return paths;
}

/** PIDs of every process owned by this (harness) uid, the processes whose environ holds the creds. */
export function harnessUidPids() {
	const r = spawnSync('pgrep', ['-u', String(process.getuid?.() ?? '')], { encoding: 'utf8', timeout: 5000 });
	const pids = (r.stdout ?? '').split('\n').map(Number).filter((n) => Number.isInteger(n) && n > 0);
	return [...new Set([process.pid, process.ppid, ...pids])].slice(0, 500);
}

/**
 * As the agent user, try to list each dir / read each file in `paths` and read each pid's
 * /proc/<pid>/environ. Returns one problem per success (empty = the boundary holds), or a problem
 * if the probe could not run as the agent user at all.
 * @param {{paths?: string[], pids?: number[]}} targets
 * @returns {string[]}
 */
export function verifyAgentIsolation({ paths = [], pids = [] }) {
	const script =
		'for p in "$@"; do case "$p" in ' +
		'pid:*) cat "/proc/${p#pid:}/environ" >/dev/null 2>&1 && echo "can read /proc/${p#pid:}/environ";; ' +
		'*) if [ -d "$p" ]; then ls -A -- "$p" >/dev/null 2>&1 && echo "can list $p"; ' +
		'else cat -- "$p" >/dev/null 2>&1 && echo "can read $p"; fi;; esac; done; echo __probe_done__';
	const args = [...paths, ...pids.map((p) => `pid:${p}`)];
	const r = spawnSync(
		'sudo',
		['-n', 'runuser', '-u', BENCH_AGENT_USER, '--', 'env', '-i', 'PATH=/usr/bin:/bin', 'bash', '-c', script, 'probe', ...args],
		{ encoding: 'utf8', timeout: 60_000 },
	);
	const lines = (r.stdout ?? '').split('\n').filter(Boolean);
	if (r.status !== 0 || lines.at(-1) !== '__probe_done__') {
		return [`isolation probe could not run as ${BENCH_AGENT_USER} (exit ${r.status ?? r.error?.message})`];
	}
	return lines.slice(0, -1).map((l) => `${BENCH_AGENT_USER} ${l}`);
}

function sleepMs(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Kill every process of the agent user (incl. setsid/nohup escapees) and drop its crontab, then
 * verify none remain. No-op (true) when isolation is unavailable: then no agent-user process exists.
 * @returns {boolean} true when no agent-user process remains
 */
export function reapAgentProcesses() {
	if (!isolationAvailable()) return true;
	for (let i = 0; i < 20; i++) {
		spawnSync('sudo', ['-n', 'pkill', '-KILL', '-u', BENCH_AGENT_USER], { stdio: 'ignore', timeout: 5000 });
		// After the kill, so no surviving process can re-add a crontab that cron would run later.
		spawnSync('sudo', ['-n', 'crontab', '-r', '-u', BENCH_AGENT_USER], { stdio: 'ignore', timeout: 5000 });
		if (spawnSync('pgrep', ['-u', BENCH_AGENT_USER], { stdio: 'ignore', timeout: 5000 }).status === 1) return true;
		sleepMs(250);
	}
	return false;
}

/**
 * Enter an agent phase: decide isolated vs (local-only) bare, and for isolated, reap leftovers,
 * grant the workspace ACL, lock down the runner temp dirs and verify the boundary. Never falls back
 * to the harness uid under CI.
 * @param {string} root the dir the agent works in
 * @returns {{isolated: boolean, error?: undefined} | {isolated: false, error: string}}
 */
export function enterAgentPhase(root) {
	if (!isolationAvailable() || !prepareWorkspaceIsolation(root)) {
		if (bareShellAllowed()) return { isolated: false };
		return {
			isolated: false,
			error: `isolation unavailable: no passwordless sudo+runuser for ${BENCH_AGENT_USER} or the workspace ACL grant failed`,
		};
	}
	if (!reapAgentProcesses()) return { isolated: false, error: `could not reap leftover ${BENCH_AGENT_USER} processes` };
	const problems = verifyAgentIsolation({ paths: lockDownRunnerTemp(), pids: harnessUidPids() });
	if (problems.length) return { isolated: false, error: `isolation check failed: ${problems.slice(0, 5).join('; ')}` };
	return { isolated: true };
}
