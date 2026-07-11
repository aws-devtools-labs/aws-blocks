/** Shared shell Sandbox + backgrounded-process-safe runner for the builder and judge steps. */
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import {
	type ExecuteOptions,
	type ExecutionResult,
	PosixShellSandbox,
	SandboxAbortError,
	SandboxTimeoutError,
	type StreamChunk,
} from '@strands-agents/sdk';

// Process-identity isolation for the builder's agent shell (issue #184): run it as a
// dedicated unprivileged user (`benchagent`) via `sudo -n runuser -u benchagent -- env
// <full-env> bash -c`, so the agent's broad by-name/by-user kills (pkill/killall/fuser -k)
// hit a cross-uid EPERM instead of reaping the parent harness. UID isolation (not a PID
// namespace) so a `setsid` dev server the agent backgrounds persists across bash calls.
// runuser isn't a login shell, so the full resolved env is re-materialized via `env
// KEY=VAL … bash -c` (survives sudo's env scrub); HOME points at benchagent's home. Used
// only when passwordless sudo+runuser works AND prepareWorkspaceIsolation's ACL is granted
// (probed once, memoized); otherwise falls back to bare `bash -c`.
export const BENCH_AGENT_USER = process.env.BENCH_AGENT_USER || 'benchagent';

let isolationProbe: boolean | undefined;
let agentHome: string | undefined;

// benchagent's home dir (from its passwd entry) so HOME is writable; falls back to /home/<user>.
function resolveAgentHome(): string {
	try {
		const r = spawnSync('getent', ['passwd', BENCH_AGENT_USER], { encoding: 'utf8', timeout: 5000 });
		if (r.status === 0 && typeof r.stdout === 'string') {
			const home = r.stdout.trim().split(':')[5];
			if (home) return home;
		}
	} catch {
		/* fall through */
	}
	return `/home/${BENCH_AGENT_USER}`;
}

// Probe (once, memoized) whether the agent shell can run as benchagent via passwordless
// sudo+runuser, using the EXACT privilege transition runShell uses; false → caller falls back.
export function isolationAvailable(): boolean {
	if (isolationProbe !== undefined) return isolationProbe;
	try {
		const r = spawnSync('sudo', ['-n', 'runuser', '-u', BENCH_AGENT_USER, '--', 'true'], {
			stdio: 'ignore',
			timeout: 5000,
		});
		isolationProbe = r.status === 0 && !r.error;
		if (isolationProbe) agentHome = resolveAgentHome();
	} catch {
		isolationProbe = false;
	}
	return isolationProbe;
}

// Grant benchagent + the harness user rwx on the workspace (recursive + default ACL, so
// files either creates later stay mutually accessible), AND grant benchagent search (x) on
// every ANCESTOR dir — the kernel checks x on each parent when resolving an ABSOLUTE path,
// and npm/node/tsc resolve modules absolutely, so without it absolute-path opens EACCES
// even though the workspace itself is rwx. Ancestor grant is best-effort per dir. Returns
// true only if the workspace grants succeed; false → caller disables isolation.
export function prepareWorkspaceIsolation(root: string): boolean {
	if (!isolationAvailable()) return false;
	let me = process.env.USER ?? '';
	if (!me) {
		try {
			me = spawnSync('id', ['-un'], { encoding: 'utf8', timeout: 5000 }).stdout?.trim() ?? '';
		} catch {
			me = '';
		}
	}
	const abs = resolve(root);
	const spec = `u:${BENCH_AGENT_USER}:rwx${me ? `,u:${me}:rwx` : ''}`;
	const access = spawnSync('setfacl', ['-R', '-m', spec, abs], { stdio: 'ignore', timeout: 120_000 });
	const dflt = spawnSync('setfacl', ['-R', '-d', '-m', spec, abs], { stdio: 'ignore', timeout: 120_000 });
	if (!(access.status === 0 && !access.error && dflt.status === 0 && !dflt.error)) return false;
	// Grant benchagent search (x) up the ancestor chain so absolute-path opens can traverse.
	let dir = dirname(abs);
	let prev = '';
	while (dir && dir !== prev && dir !== '/') {
		spawnSync('setfacl', ['-m', `u:${BENCH_AGENT_USER}:x`, dir], { stdio: 'ignore', timeout: 10_000 });
		prev = dir;
		dir = dirname(dir);
	}
	return true;
}

// Build the argv for one agent shell command (`cd <cwd> && <command>`), wrapped to run as
// benchagent when isolation is requested and available. Exported so the wrap decision is
// unit-testable without spawning. `isolate` defaults false so the judge keeps the bare spawn.
export function buildAgentSpawn(
	command: string,
	cwd: string,
	isolate: boolean,
	env: Record<string, string>,
): { file: string; args: string[]; isolated: boolean } {
	const inner = `cd ${shellQuote(cwd)} && ${command}`;
	if (isolate && isolationAvailable()) {
		const forwarded: Record<string, string> = { ...env, HOME: agentHome ?? `/home/${BENCH_AGENT_USER}` };
		// Only forward valid shell identifier names (drops exported-function keys like
		// `BASH_FUNC_x%%`); values pass as argv so need no quoting.
		const envPairs = Object.entries(forwarded)
			.filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
			.map(([k, v]) => `${k}=${v}`);
		return {
			file: 'sudo',
			args: ['-n', 'runuser', '-u', BENCH_AGENT_USER, '--', 'env', ...envPairs, 'bash', '-c', inner],
			isolated: true,
		};
	}
	return { file: 'bash', args: ['-c', inner], isolated: false };
}

// Bounded grace (ms) before force-resolving if a backgrounded grandchild escaped the
// process group (e.g. via `setsid`) and still holds the inherited pipes open.
export const EXIT_DRAIN_GRACE_MS = 2000;

// Host-execution Sandbox rooted at a fixed dir: the vended bash + fileEditor route every
// op through it, so rooting at `root` makes containment structural. `minTimeoutSec` floors
// the per-command timeout (builder passes BASH_MIN_TIMEOUT_SEC so npm install/build survive).
export class WorkspaceSandbox extends PosixShellSandbox {
	// `isolate` runs each command as benchagent (cross-uid EPERM shields the harness); builder
	// passes true, judge leaves false (its shell is read-only and never issues kills).
	constructor(
		private readonly root: string,
		private readonly minTimeoutSec = 0,
		private readonly isolate = false,
	) {
		super();
	}

	async *executeStreaming(
		command: string,
		options?: ExecuteOptions,
	): AsyncGenerator<StreamChunk | ExecutionResult, void, undefined> {
		const cwd = options?.cwd ?? this.root;
		// Floor the vended bash's timeout (its 120s default would kill npm install/build) to
		// minTimeoutSec; `undefined` means the caller opted out of a timeout — leave untouched.
		const timeout = options?.timeout === undefined ? undefined : Math.max(options.timeout, this.minTimeoutSec);
		const result = await runShell(command, cwd, timeout, options?.signal, options?.env, this.isolate);
		if (result.stdout) yield { type: 'streamChunk', data: result.stdout, streamType: 'stdout' };
		if (result.stderr) yield { type: 'streamChunk', data: result.stderr, streamType: 'stderr' };
		yield result;
	}
}

// Run one command through a POSIX shell rooted at `cwd`, buffering output and resolving the
// final ExecutionResult (throws the SDK's SandboxTimeoutError/SandboxAbortError).
//
// Backgrounded-process containment (the post-invoke-hang fix): (1) spawn `detached: true` so
// the process leads its own group and a negative-pid signal reaps the whole tree (a `setsid`
// server the agent persists across calls escapes it by design); (2) resolve on 'close' for a
// complete capture, but SIGKILL the group the moment the shell exits so a backgrounded child's
// leaked pipe FDs close and 'close' fires promptly, with EXIT_DRAIN_GRACE_MS as a fallback.
// `isolate` (builder only) runs as benchagent via sudo+runuser, so the group kill escalates
// through `sudo kill` (the harness uid can't signal a benchagent-owned group directly).
export function runShell(
	command: string,
	cwd: string,
	timeoutSec: number | undefined,
	signal: AbortSignal | undefined,
	env: Record<string, string> | undefined,
	isolate = false,
): Promise<ExecutionResult> {
	return new Promise<ExecutionResult>((resolve, reject) => {
		// Resolve the full env ONCE so the spawn and buildAgentSpawn's re-materialization match.
		const merged: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) if (v !== undefined) merged[k] = v;
		if (env) for (const [k, v] of Object.entries(env)) merged[k] = v;
		const { file, args } = buildAgentSpawn(command, cwd, isolate, merged);
		const proc = spawn(file, args, {
			env: merged,
			detached: true,
			// Explicit stdin EOF so an interactive prompt fails fast instead of blocking on a TTY.
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		let settled = false;
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		let drainHandle: ReturnType<typeof setTimeout> | undefined;

		// SIGKILL the whole process group (negative pid) to reap any backgrounded child whose
		// inherited pipe write-ends keep 'close' from firing and hold libuv's loop open. Guarded
		// (pid may be undefined / group already ESRCH). When isolated the group is benchagent-owned,
		// so escalate via `sudo kill`; a `setsid` server escapes the group and keeps running.
		const killGroup = (): void => {
			if (proc.pid === undefined) return;
			if (isolate) {
				spawnSync('sudo', ['-n', 'kill', '-9', `-${proc.pid}`], { stdio: 'ignore', timeout: 5000 });
				return;
			}
			try {
				process.kill(-proc.pid, 'SIGKILL');
			} catch {
				// group already reaped
			}
		};

		const settle = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (drainHandle) clearTimeout(drainHandle);
			if (signal) signal.removeEventListener('abort', onAbort);
			killGroup();
			fn();
		};
		const resolveResult = (code: number | null, sig: NodeJS.Signals | null): void =>
			settle(() =>
				resolve({ type: 'executionResult', exitCode: code ?? (sig ? 128 : 1), stdout, stderr, outputFiles: [] }),
			);
		const terminate = (err: Error): void => settle(() => reject(err));
		const onAbort = (): void => terminate(new SandboxAbortError());

		proc.stdout?.on('data', (d) => {
			stdout += String(d);
		});
		proc.stderr?.on('data', (d) => {
			stderr += String(d);
		});
		proc.on('error', (err) => settle(() => reject(err)));
		// bash's foreground pipeline is done; only `&`-backgrounded children may survive. Reap the
		// group so their leaked pipe FDs close ('close' can fire) and arm the grace fallback.
		proc.on('exit', (code, sig) => {
			if (settled) return;
			killGroup();
			drainHandle = setTimeout(() => resolveResult(code, sig), EXIT_DRAIN_GRACE_MS);
			drainHandle.unref();
		});
		proc.on('close', (code, sig) => resolveResult(code, sig));

		if (timeoutSec !== undefined) {
			timeoutHandle = setTimeout(() => terminate(new SandboxTimeoutError(timeoutSec)), timeoutSec * 1000);
		}
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener('abort', onAbort, { once: true });
		}
	});
}

// Single-quote a path for safe interpolation into a shell command.
export function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function describeError(err: unknown): string {
	const e = err as { name?: string; message?: string };
	return [e?.name, e?.message].filter(Boolean).join(': ') || String(err);
}

// Read a required env var or exit(1) with a step-scoped log prefix ('[bench]' for
// the builder, '[judge]' for the judge).
export function required(name: string, logPrefix: string): string {
	const v = process.env[name];
	if (!v) {
		process.stderr.write(`${logPrefix} missing env var ${name}\n`);
		process.exit(1);
	}
	return v;
}
