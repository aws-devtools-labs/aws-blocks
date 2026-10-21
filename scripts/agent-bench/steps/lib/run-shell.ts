/** Shared shell Sandbox + backgrounded-process-safe runner for the builder and judge steps. */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import {
	type ExecuteOptions,
	type ExecutionResult,
	PosixShellSandbox,
	SandboxAbortError,
	SandboxTimeoutError,
	type StreamChunk,
} from '@strands-agents/sdk';
import { buildAgentSpawn } from './isolation.mjs';
import { buildShellEnv, redactSecrets } from './secrets.mjs';

// Every command runs as the isolated agent user (lib/isolation.mjs): `sudo -n runuser -u benchagent
// -- env -i <shell-env> bash -c`, with the shell env from buildShellEnv (allowlisted, credential-free).
// Cross-uid, the agent's broad kills (pkill/killall/fuser -k) hit EPERM instead of the harness, and it
// cannot read the harness's /proc/<pid>/environ, which still holds the job credentials. UID isolation
// (not a PID namespace) so a `setsid` dev server the agent backgrounds persists across bash calls
// (until the phase-end reap). Without isolation buildAgentSpawn refuses (bare shell: local dev only).

// Bounded grace (ms) before force-resolving if a backgrounded grandchild escaped the
// process group (e.g. via `setsid`) and still holds the inherited pipes open.
export const EXIT_DRAIN_GRACE_MS = 2000;

// Host-execution Sandbox rooted at a fixed dir: the vended bash + fileEditor route every
// op through it, so rooting at `root` makes containment structural. `minTimeoutSec` floors
// the per-command timeout (builder passes BASH_MIN_TIMEOUT_SEC so npm install/build survive).
export class WorkspaceSandbox extends PosixShellSandbox {
	// `isolate` = the phase entered the agent-user boundary (enterAgentPhase). false only in the
	// local-dev bare mode; without either, every command is refused (buildAgentSpawn throws).
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
		// Persist each command's exit code + output — the Strands trace records tool
		// CALLS but not shell OUTPUT. Opt-in via BENCH_CMD_LOG; best-effort so logging can't break a
		// command. The log is uploaded as a public artifact, so every field is redacted BEFORE the
		// 4000-char slice (a secret straddling the cut can't survive as an unmatched prefix).
		const cmdLogPath = process.env.BENCH_CMD_LOG;
		if (cmdLogPath) {
			try {
				appendFileSync(
					cmdLogPath,
					`${JSON.stringify({
						ts: new Date().toISOString(),
						cwd: redactSecrets(cwd),
						command: redactSecrets(command),
						exitCode: result.exitCode,
						stdout: redactSecrets(result.stdout).slice(0, 4000),
						stderr: redactSecrets(result.stderr).slice(0, 4000),
					})}\n`,
				);
			} catch {
				/* best-effort: never let command logging break a command */
			}
		}
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
// `isolate` runs as benchagent via sudo+runuser, so the group kill escalates through `sudo kill`
// (the harness uid can't signal a benchagent-owned group directly).
export function runShell(
	command: string,
	cwd: string,
	timeoutSec: number | undefined,
	signal: AbortSignal | undefined,
	env: Record<string, string> | undefined,
	isolate = false,
): Promise<ExecutionResult> {
	return new Promise<ExecutionResult>((resolve, reject) => {
		// Resolve the shell env ONCE so the spawn and buildAgentSpawn's re-materialization match: the
		// allowlisted, credential-free subset of the harness env (the harness keeps its own creds for
		// the Bedrock calls) plus the per-command overrides. Same env on the isolated and bare paths.
		const shellEnv = buildShellEnv(process.env, { overrides: env });
		const { file, args } = buildAgentSpawn(command, cwd, isolate, shellEnv);
		const proc = spawn(file, args, {
			env: shellEnv,
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
