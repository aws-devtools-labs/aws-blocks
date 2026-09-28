/**
 * Workspace-rooted shell Sandbox for the dependency-remediation agent.
 *
 * A trimmed sibling of scripts/agent-bench/steps/lib/run-shell.ts. The bench harness runs its
 * agent shell as an unprivileged `benchagent` UID because it executes UNTRUSTED, prompt-injectable
 * task input on a shared measurement surface. This remediation agent has NO such threat model — it
 * runs only on our own scheduled/dispatched job over OUR checkout, with an OIDC session already
 * narrowed to Bedrock-only — so we deliberately drop the UID-isolation machinery and keep just the
 * workspace-rooted sandbox with a timeout floor (npm install/build would otherwise hit the vended
 * bash's 120s default and get killed mid-command).
 */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import {
	type ExecuteOptions,
	type ExecutionResult,
	PosixShellSandbox,
	SandboxAbortError,
	SandboxTimeoutError,
	type StreamChunk,
} from '@strands-agents/sdk';

// Bounded grace (ms) before force-resolving if a backgrounded grandchild escaped the process group
// (e.g. via `setsid`) and still holds the inherited pipes open.
export const EXIT_DRAIN_GRACE_MS = 2000;

// Host-execution Sandbox rooted at a fixed dir: the vended bash + fileEditor route every op through
// it, so rooting at `root` makes containment structural. `minTimeoutSec` floors the per-command
// timeout (the remediation loop passes a generous floor so npm install/build survive).
export class WorkspaceSandbox extends PosixShellSandbox {
	constructor(
		private readonly root: string,
		private readonly minTimeoutSec = 0,
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
		const result = await runShell(command, cwd, timeout, options?.signal);
		// Persist each command's exit code + output (the Strands trace records tool CALLS but not
		// shell OUTPUT). Opt-in via DEP_CMD_LOG; best-effort; sliced to 4000 chars/side.
		const cmdLogPath = process.env.DEP_CMD_LOG;
		if (cmdLogPath) {
			try {
				appendFileSync(
					cmdLogPath,
					`${JSON.stringify({
						ts: new Date().toISOString(),
						cwd,
						command,
						exitCode: result.exitCode,
						stdout: result.stdout.slice(0, 4000),
						stderr: result.stderr.slice(0, 4000),
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

// Run one command through a POSIX shell rooted at `cwd`, buffering output and resolving the final
// ExecutionResult (throws the SDK's SandboxTimeoutError/SandboxAbortError). Spawns `detached: true`
// so the process leads its own group and a negative-pid SIGKILL reaps a backgrounded tree whose
// leaked pipe FDs would otherwise keep 'close' from firing; EXIT_DRAIN_GRACE_MS is the fallback.
export function runShell(
	command: string,
	cwd: string,
	timeoutSec: number | undefined,
	signal: AbortSignal | undefined,
): Promise<ExecutionResult> {
	return new Promise<ExecutionResult>((resolve, reject) => {
		const proc = spawn('bash', ['-c', `cd ${shellQuote(cwd)} && ${command}`], {
			env: process.env,
			detached: true,
			// Explicit stdin EOF so an interactive prompt fails fast instead of blocking on a TTY.
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		let settled = false;
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		let drainHandle: ReturnType<typeof setTimeout> | undefined;

		const killGroup = (): void => {
			if (proc.pid === undefined) return;
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

// Read a required env var or exit(1) with a step-scoped log prefix.
export function required(name: string, logPrefix: string): string {
	const v = process.env[name];
	if (!v) {
		process.stderr.write(`${logPrefix} missing env var ${name}\n`);
		process.exit(1);
	}
	return v;
}
