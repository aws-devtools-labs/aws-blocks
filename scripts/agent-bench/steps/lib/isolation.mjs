// The uid boundary every agent-controlled process runs behind: the builder and judge shells
// (run-shell.ts) and every process step 3 starts from the agent's app (agent-exec.mjs).
//
// Agent code runs as a dedicated unprivileged user (`benchagent`, no sudo rights) via
// `sudo -n runuser -u benchagent -- env -i <shell-env> …`. The harness keeps the job credentials in
// its own env (it makes the Bedrock calls), so the boundary is what keeps them out of reach: a
// different uid cannot read the harness's /proc/<pid>/environ or signal it. Around it:
//   - FAIL CLOSED: under CI there is no same-uid fallback. A bare shell is only for local dev,
//     behind BENCH_ALLOW_BARE_SHELL=1, and refused when CI/GITHUB_ACTIONS is set.
//   - TRUSTED EXECUTABLES: every later runner-uid step (and sudo, as root) executes from the runner
//     PATH, sudo's secure_path, the node install, the hosted tool cache, the checkout's scripts and
//     node_modules, the downloaded actions and the runner itself. The hosted image ships some of
//     these world-writable (e.g. /usr/local/bin, /opt/hostedtoolcache), which would let the agent
//     plant or replace a binary that later runs with the credentials. Before agent code runs, write
//     access for others is removed (CI only) and the agent user is VERIFIED unable to write or
//     replace any of them or any ancestor. The harness's own tool calls use absolute system paths.
//   - RUNNER TEMP: the runner's file-command files (GITHUB_ENV/OUTPUT/PATH/STATE, and the set_env
//     file configure-aws-credentials writes the AWS keys to) live under RUNNER_TEMP. Before agent
//     code runs, those dirs are made 0700 and the agent user is VERIFIED unable to list/read them
//     or any runner-uid /proc/<pid>/environ.
//   - REAP: every agent-user process is killed (and its crontab removed) at the start and end of
//     each agent phase and before anything is published or the role is re-assumed.
// Plain .mjs (no TS) so bare-node step scripts can use it; unit-tested in isolation.test.mjs.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const BENCH_AGENT_USER = process.env.BENCH_AGENT_USER || 'benchagent';

// System tools by absolute path, never via PATH (and sudo targets too: sudo would otherwise look
// them up in its secure_path, whose /usr/local/* dirs come first).
function sysBin(name) {
	for (const d of ['/usr/bin', '/usr/sbin', '/bin', '/sbin']) {
		const p = join(d, name);
		if (existsSync(p)) return p;
	}
	return `/usr/bin/${name}`;
}
const BIN = Object.fromEntries(
	['sudo', 'runuser', 'env', 'bash', 'pkill', 'pgrep', 'crontab', 'setfacl', 'chmod', 'find', 'getent', 'id'].map((n) => [n, sysBin(n)]),
);

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
		const r = spawnSync(BIN.getent, ['passwd', BENCH_AGENT_USER], { encoding: 'utf8', timeout: 5000 });
		const home = r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim().split(':')[5] : '';
		if (home) return home;
	} catch {
		/* fall through */
	}
	return `/home/${BENCH_AGENT_USER}`;
}

// `sudo -n runuser -u <agent> -- env -i [pairs…] <argv…>`, all by absolute path.
function asAgent(envPairs, argv) {
	return { file: BIN.sudo, args: ['-n', BIN.runuser, '-u', BENCH_AGENT_USER, '--', BIN.env, '-i', ...envPairs, ...argv] };
}

/**
 * Whether commands can run as the agent user via passwordless sudo+runuser (probed once, with the
 * exact transition used for every command). The harness user holds `NOPASSWD:ALL` on the hosted
 * runner, so a passing `runuser` probe implies `sudo -n kill/pkill/crontab/chmod` work too; the agent
 * user holds no sudo rights (agent-bench.yml fails the job otherwise).
 * @returns {boolean}
 */
export function isolationAvailable() {
	if (isolationProbe !== undefined) return isolationProbe;
	try {
		const r = spawnSync(BIN.sudo, ['-n', BIN.runuser, '-u', BENCH_AGENT_USER, '--', '/bin/true'], {
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
	if (!me) me = spawnSync(BIN.id, ['-un'], { encoding: 'utf8', timeout: 5000 }).stdout?.trim() ?? '';
	const abs = resolve(root);
	const spec = `u:${BENCH_AGENT_USER}:rwx${me ? `,u:${me}:rwx` : ''}`;
	const access = spawnSync(BIN.setfacl, ['-R', '-m', spec, abs], { stdio: 'ignore', timeout: 120_000 });
	const dflt = spawnSync(BIN.setfacl, ['-R', '-d', '-m', spec, abs], { stdio: 'ignore', timeout: 120_000 });
	if (!(access.status === 0 && !access.error && dflt.status === 0 && !dflt.error)) return false;
	for (let dir = dirname(abs), prev = ''; dir && dir !== prev && dir !== '/'; prev = dir, dir = dirname(dir)) {
		spawnSync(BIN.setfacl, ['-m', `u:${BENCH_AGENT_USER}:x`, dir], { stdio: 'ignore', timeout: 10_000 });
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
		return { ...asAgent(envPairs, [BIN.bash, '-c', inner]), isolated: true };
	}
	if (!bareShellAllowed()) {
		throw new Error(
			`refusing to run an agent command as the harness uid: ${BENCH_AGENT_USER} isolation is ${
				isolated ? 'unavailable' : 'not enabled'
			} (a bare shell needs BENCH_ALLOW_BARE_SHELL=1 and is never allowed under CI)`,
		);
	}
	return { file: BIN.bash, args: ['-c', inner], isolated: false };
}

// ── Trusted executables ──────────────────────────────────────────────────────────────────────
// sudo's secure_path on the hosted image (root resolves sudo targets here).
const SECURE_PATH_DIRS = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin', '/snap/bin'];
// Install trees later runner-uid steps execute from (node/npm/npx, global npm packages, setup-* tools).
const SYSTEM_EXEC_TREES = ['/opt/hostedtoolcache', '/usr/local/lib/node_modules'];

// The runner's own install dir (it runs the later actions' node from <root>/externals).
function runnerInstallRoots() {
	const roots = new Set();
	for (const pid of harnessUidPids()) {
		try {
			const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
			if (comm === 'Runner.Worker' || comm === 'Runner.Listener') roots.add(dirname(dirname(realpathSync(`/proc/${pid}/exe`))));
		} catch {
			/* gone or not ours */
		}
	}
	return [...roots];
}

/**
 * Everything a later runner-uid (or sudo/root) step executes from, split into `flat` dirs (the dir
 * and its direct entries: every PATH dir, sudo's secure_path, and the target dir of each symlinked
 * entry) and `deep` trees (checked recursively: the node install, the hosted tool cache, global npm
 * modules, the checkout with its scripts + node_modules, the downloaded actions, the runner). The
 * agent's own dirs (`agentDirs`: workspace, Playwright cache) and RUNNER_TEMP are excluded. Pure
 * apart from reading the filesystem.
 * @param {Record<string, string | undefined>} [env]
 * @param {string[]} [agentDirs]
 * @returns {{flat: string[], deep: string[], exclude: string[]}}
 */
export function trustedExecPaths(env = process.env, agentDirs = []) {
	const flat = new Set([...SECURE_PATH_DIRS, ...(env.PATH ?? '').split(':').filter((d) => isAbsolute(d))]);
	for (const d of [...flat]) {
		let entries = [];
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (!e.isSymbolicLink()) continue;
			try {
				flat.add(dirname(realpathSync(join(d, e.name))));
			} catch {
				/* dangling */
			}
		}
	}
	const deep = new Set(SYSTEM_EXEC_TREES);
	deep.add(dirname(dirname(realpathSync(process.execPath))));
	if (env.RUNNER_TOOL_CACHE) deep.add(env.RUNNER_TOOL_CACHE);
	if (env.GITHUB_WORKSPACE) deep.add(env.GITHUB_WORKSPACE);
	if (env.RUNNER_WORKSPACE) deep.add(join(dirname(env.RUNNER_WORKSPACE), '_actions'));
	for (const r of runnerInstallRoots()) deep.add(r);
	const exclude = [...agentDirs, env.WORKSPACE, env.PLAYWRIGHT_BROWSERS_PATH, env.RUNNER_TEMP]
		.filter((p) => typeof p === 'string' && p !== '')
		.map((p) => resolve(p));
	const real = (list) => [...new Set(list.filter((p) => existsSync(p)).map((p) => resolve(p)))];
	return { flat: real([...flat]), deep: real([...deep]), exclude: [...new Set(exclude)] };
}

/**
 * As the agent user, list what it could write or replace: writable flat dirs/entries, any writable
 * path in a deep tree (first hit per tree), and any writable non-sticky ancestor (a writable parent
 * lets it rename the child away). Empty = nothing trusted is writable. A probe that could not run
 * is reported as a problem.
 * @param {{flat: string[], deep: string[], exclude: string[]}} targets
 * @returns {{writable: string[], deepRoots: string[], problems: string[]}}
 */
export function findAgentWritable({ flat, deep, exclude }) {
	const script = [
		'prune=(); for a in "$@"; do case "$a" in X:*) prune+=(-path "${a#X:}" -prune -o);; esac; done',
		'for a in "$@"; do case "$a" in',
		'  F:*) find "${a#F:}" -maxdepth 1 -writable -printf "F\\t%p\\n" 2>/dev/null;;',
		'  D:*) d="${a#D:}"; hit=$(find "$d" "${prune[@]}" -writable -print -quit 2>/dev/null); [ -n "$hit" ] && printf "D\\t%s\\t%s\\n" "$d" "$hit";;',
		'esac; done',
		'for a in "$@"; do case "$a" in F:*|D:*) p="${a#?:}"; while [ "$p" != / ]; do p=$(dirname "$p");',
		'  if [ -w "$p" ] && [ ! -k "$p" ]; then printf "A\\t%s\\n" "$p"; fi; done;; esac; done',
		'echo __probe_done__',
	].join('\n');
	const args = [...exclude.map((p) => `X:${p}`), ...flat.map((p) => `F:${p}`), ...deep.map((p) => `D:${p}`)];
	const { file, args: argv } = asAgent(['PATH=/usr/bin:/bin'], [BIN.bash, '-c', script, 'probe', ...args]);
	const r = spawnSync(file, argv, { encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
	const lines = (r.stdout ?? '').split('\n').filter(Boolean);
	if (r.status !== 0 || lines.at(-1) !== '__probe_done__') {
		return { writable: [], deepRoots: [], problems: [`writability probe could not run as ${BENCH_AGENT_USER} (exit ${r.status ?? r.error?.message})`] };
	}
	const writable = new Set();
	const deepRoots = new Set();
	for (const line of lines.slice(0, -1)) {
		const [kind, a, b] = line.split('\t');
		if (kind === 'D') {
			deepRoots.add(a);
			writable.add(b);
		} else writable.add(a);
	}
	const writableList = [...writable];
	return {
		writable: writableList,
		deepRoots: [...deepRoots],
		problems: writableList.map((p) => `${BENCH_AGENT_USER} can write or replace ${p}`),
	};
}

/**
 * Remove group/other write from every trusted executable path the agent user can write (under CI;
 * locally only verify), then verify again as the agent user, until nothing is left (bounded
 * rounds). A writable hit that is a symlink (e.g. a tool-cache entry linking into /usr/lib/jvm) is
 * fixed through the link and its real target tree joins the deep set. Anything still writable
 * (e.g. owned by the agent user, or granted by an ACL) is a problem: the caller must fail closed.
 * @param {{flat: string[], deep: string[], exclude: string[]}} targets
 * @param {{fix?: boolean}} [options] default: fix only under CI
 * @returns {string[]} problems (empty = locked)
 */
export function lockDownExecPaths(targets, options = {}) {
	const fix = options.fix ?? isCI();
	const deep = new Set(targets.deep);
	const prune = targets.exclude.flatMap((p) => ['-path', p, '-prune', '-o']);
	const fixedTrees = new Set();
	for (let round = 0; round < 10; round++) {
		const found = findAgentWritable({ ...targets, deep: [...deep] });
		if (found.problems.length === 0 || !fix) return found.problems;
		// Deep trees (once each): every non-link entry with group/other write, skipping agent dirs.
		for (const root of found.deepRoots) {
			if (fixedTrees.has(root)) continue;
			fixedTrees.add(root);
			spawnSync(BIN.sudo, ['-n', BIN.find, root, ...prune, '!', '-type', 'l', '-perm', '/022', '-exec', BIN.chmod, 'go-w', '{}', '+'], {
				stdio: 'ignore',
				timeout: 600_000,
			});
		}
		// Every reported path explicitly (chmod follows a symlink to its target); a symlinked hit's
		// real target tree is checked (and fixed) as a whole from the next round on.
		for (let i = 0; i < found.writable.length; i += 500) {
			spawnSync(BIN.sudo, ['-n', BIN.chmod, 'go-w', '--', ...found.writable.slice(i, i + 500)], { stdio: 'ignore', timeout: 60_000 });
		}
		for (const p of found.writable) {
			try {
				const real = realpathSync(p);
				if (real !== p && statSync(real).isDirectory() && !targets.exclude.some((x) => real === x || real.startsWith(`${x}/`))) deep.add(real);
			} catch {
				/* vanished */
			}
		}
	}
	return findAgentWritable({ ...targets, deep: [...deep] }).problems;
}

// ── Runner temp ──────────────────────────────────────────────────────────────────────────────
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
			spawnSync(BIN.setfacl, ['-b', dir], { stdio: 'ignore', timeout: 10_000 });
			spawnSync(BIN.chmod, ['0700', dir], { stdio: 'ignore', timeout: 10_000 });
		}
		paths.push(dir, ...entries.map((e) => join(dir, e)));
	}
	return paths;
}

/** PIDs of every process owned by this (harness) uid, the processes whose environ holds the creds. */
export function harnessUidPids() {
	const r = spawnSync(BIN.pgrep, ['-u', String(process.getuid?.() ?? '')], { encoding: 'utf8', timeout: 5000 });
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
	const { file, args: argv } = asAgent(['PATH=/usr/bin:/bin'], [BIN.bash, '-c', script, 'probe', ...args]);
	const r = spawnSync(file, argv, { encoding: 'utf8', timeout: 60_000 });
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
		spawnSync(BIN.sudo, ['-n', BIN.pkill, '-KILL', '-u', BENCH_AGENT_USER], { stdio: 'ignore', timeout: 5000 });
		// After the kill, so no surviving process can re-add a crontab that cron would run later.
		spawnSync(BIN.sudo, ['-n', BIN.crontab, '-r', '-u', BENCH_AGENT_USER], { stdio: 'ignore', timeout: 5000 });
		if (spawnSync(BIN.pgrep, ['-u', BENCH_AGENT_USER], { stdio: 'ignore', timeout: 5000 }).status === 1) return true;
		sleepMs(250);
	}
	return false;
}

/**
 * Enter an agent phase: decide isolated vs (local-only) bare, and for isolated, reap leftovers,
 * grant the workspace ACL, lock down + verify the trusted executable paths and the runner temp
 * dirs. Never falls back to the harness uid under CI.
 * @param {string} root the dir the agent works in
 * @param {{agentDirs?: string[]}} [options] other agent-writable dirs (excluded from the exec lockdown)
 * @returns {{isolated: boolean, error?: undefined} | {isolated: false, error: string}}
 */
export function enterAgentPhase(root, options = {}) {
	if (!isolationAvailable() || !prepareWorkspaceIsolation(root)) {
		if (bareShellAllowed()) return { isolated: false };
		return {
			isolated: false,
			error: `isolation unavailable: no passwordless sudo+runuser for ${BENCH_AGENT_USER} or the workspace ACL grant failed`,
		};
	}
	if (!reapAgentProcesses()) return { isolated: false, error: `could not reap leftover ${BENCH_AGENT_USER} processes` };
	const execProblems = lockDownExecPaths(trustedExecPaths(process.env, [root, ...(options.agentDirs ?? [])]));
	if (execProblems.length) {
		return { isolated: false, error: `trusted executable paths are writable by ${BENCH_AGENT_USER}: ${execProblems.slice(0, 5).join('; ')}` };
	}
	const problems = verifyAgentIsolation({ paths: lockDownRunnerTemp(), pids: harnessUidPids() });
	if (problems.length) return { isolated: false, error: `isolation check failed: ${problems.slice(0, 5).join('; ')}` };
	return { isolated: true };
}
