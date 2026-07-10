/**
 * Shared shell infrastructure for the agent-bench builder (2-agent-run.ts) and
 * judge (4-judge.ts) steps. Both vend the framework's bash/fileEditor tools
 * through a host-execution Sandbox rooted at a fixed directory; this module is
 * the single source of that Sandbox + its backgrounded-process-safe runner, so
 * the containment fix lives in exactly one place.
 *
 * The ONLY behavioral difference between the two callers is WorkspaceSandbox's
 * `minTimeoutSec` (the builder floors bash timeouts to BASH_MIN_TIMEOUT_SEC=600
 * so npm install/build survive; the judge leaves it at 0 so the vended bash's
 * own 120s per-command default stands) — that stays at the call sites.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
	type ExecuteOptions,
	type ExecutionResult,
	PosixShellSandbox,
	SandboxAbortError,
	SandboxTimeoutError,
	type StreamChunk,
} from '@strands-agents/sdk';

// PROCESS-IDENTITY ISOLATION for the builder's agent-vended shell (issue #184).
//
// The problem: the agent's vended `bash`/`fileEditor` run under the SAME OS user
// as the harness (`npx tsx 2-agent-run.ts`). `detached: true` (below) puts each
// command in its OWN process GROUP, which stops a group-scoped signal from the
// harness reaping the agent's tree and stops a backgrounded child from wedging
// the harness — but it does NOT stop the reverse: a broad, BY-NAME/BY-USER kill
// the agent itself issues (`pkill -f node`, `killall node`, `fuser -k`, `kill -1`)
// matches processes across process-group boundaries, so it reaches and kills the
// parent harness. That is exactly what tore down two cells in run 29107536283
// (oidc-dsql-notes SIGKILL/137, file-gallery SIGTERM/143): the agents, thrashing
// on a leftover dev server, ran "kill all node processes" and killed `2-agent-run.ts`.
//
// The fix: run the agent's shell inside an UNPRIVILEGED USER + PID + MOUNT
// namespace via `unshare --map-current-user --pid --fork --mount-proc`. Effects:
//   - `--map-current-user` keeps the agent running as the REAL uid (whoami is
//     unchanged, NOT root/nobody), so file ownership stays seamless for the later
//     build/test step and there is no root-behavior npm breakage — FAIRNESS is
//     preserved: the agent keeps a full shell, installs deps, runs a dev server,
//     runs tests exactly as before.
//   - `--pid --fork` makes the agent's bash PID 1 in a fresh PID namespace; it can
//     only see (and therefore only signal) processes it started. The harness lives
//     in the parent namespace and is INVISIBLE + unsignalable from inside, so
//     `pkill`/`killall`/`fuser -k` are structurally contained — a kernel boundary,
//     not a convention.
//   - `--mount-proc` mounts a fresh /proc so `ps`/`pgrep`/`pkill -f` enumerate only
//     the namespace's own processes (without it they would read the host /proc).
//   - No network namespace, so Bedrock, npm, and localhost dev servers all work.
// When the agent's PID-1 bash exits, the kernel reaps every remaining process in
// the namespace, so a backgrounded dev server is torn down automatically — the
// same wedge the group-kill below guards, handled here by the namespace lifetime.
//
// The wrapper is used ONLY when the kernel supports unprivileged user+PID+mount
// namespaces (probed once, memoized). When unavailable (older/locked-down kernel,
// local dev without unprivileged userns) we fall back to the bare `bash -c` spawn
// so the bench stays green-regardless; the builder logs which mode is active.
export const UNSHARE_ARGS = ['--map-current-user', '--pid', '--fork', '--mount-proc'] as const;

let isolationProbe: boolean | undefined;

// Probe (once, memoized) whether this kernel can create the unprivileged
// user+PID+mount namespace the isolation wrapper needs. Runs the EXACT arg set
// runShell uses against a trivial `true`, so a green probe guarantees the real
// spawn's namespace setup (including the /proc mount, the part most likely to be
// restricted) succeeds. Any failure — `unshare` absent, userns disabled, mount
// denied — yields false and the caller falls back to the bare `bash -c` spawn.
export function isolationAvailable(): boolean {
	if (isolationProbe !== undefined) return isolationProbe;
	try {
		const r = spawnSync('unshare', [...UNSHARE_ARGS, 'true'], { stdio: 'ignore', timeout: 5000 });
		isolationProbe = r.status === 0 && !r.error;
	} catch {
		isolationProbe = false;
	}
	return isolationProbe;
}

// Build the argv for one agent shell command: `cd <cwd> && <command>` run under a
// POSIX shell, wrapped in the unprivileged namespace when isolation is requested
// AND the kernel supports it. Split out (and exported) so the wrap decision is
// unit-testable without spawning. `isolate` defaults false so the judge's
// read-only shell keeps the bare spawn.
export function buildAgentSpawn(
	command: string,
	cwd: string,
	isolate: boolean,
): { file: string; args: string[]; isolated: boolean } {
	const inner = `cd ${shellQuote(cwd)} && ${command}`;
	if (isolate && isolationAvailable()) {
		return { file: 'unshare', args: [...UNSHARE_ARGS, 'bash', '-c', inner], isolated: true };
	}
	return { file: 'bash', args: ['-c', inner], isolated: false };
}

// Bounded grace (ms) between the direct bash process exiting and force-resolving
// the shell result. Normal commands resolve earlier on 'close' (all stdio
// drained); this only fires for the pathological case where a backgrounded
// grandchild escaped the process group (e.g. via `setsid`) and still holds the
// inherited stdout/stderr pipes open, so 'close' would otherwise never fire.
export const EXIT_DRAIN_GRACE_MS = 2000;

// Host-execution Sandbox rooted at a fixed directory. The vended bash +
// fileEditor tools route every command and file operation through the agent's
// configured Sandbox, so rooting it at `root` makes containment structural (the
// shell's cwd is that dir) rather than a prompt convention. PosixShellSandbox
// already implements readFile/writeFile/listFiles on top of executeStreaming, so
// rooting the shell roots the file editor too — the only method we must supply
// is executeStreaming. `minTimeoutSec` floors the per-command timeout (builder
// passes BASH_MIN_TIMEOUT_SEC so npm install/build survive; judge leaves it 0).
export class WorkspaceSandbox extends PosixShellSandbox {
	// `isolate` runs each command inside the unprivileged user+PID+mount namespace
	// (see UNSHARE_ARGS / runShell) so the agent's shell cannot signal the parent
	// harness. The builder passes true; the judge leaves it false (its shell is a
	// read-only, disposable copy that never issues process kills).
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
		// The vended bash callback always passes a timeout (its own 120s default
		// when the model omits one), which would kill npm install/build. Floor it
		// to minTimeoutSec so long commands survive. `undefined` means the caller
		// opted out of a timeout (e.g. the file-editor's internal read/write execs
		// run with none) — leave that untouched.
		const timeout = options?.timeout === undefined ? undefined : Math.max(options.timeout, this.minTimeoutSec);
		const result = await runShell(command, cwd, timeout, options?.signal, options?.env, this.isolate);
		if (result.stdout) yield { type: 'streamChunk', data: result.stdout, streamType: 'stdout' };
		if (result.stderr) yield { type: 'streamChunk', data: result.stderr, streamType: 'stderr' };
		yield result;
	}
}

// Run one command through a POSIX shell rooted at `cwd`, buffering output and
// resolving the final ExecutionResult. Throws the SDK's SandboxTimeoutError /
// SandboxAbortError so the vended bash surfaces a timeout as BashTimeoutError.
// Buffering (rather than incremental streaming) matches the only consumers here
// — Sandbox.execute and the file editor, which need just the final result.
//
// Backgrounded-process containment (the post-invoke-hang fix): the agent may
// background a long-lived process (e.g. `npm run dev &`). Two safeguards keep
// that from wedging the harness:
//   1. Spawn `detached: true` so the shell (or, when isolated, the `unshare`
//      parent) leads its OWN process group (pgid == pid). Under non-interactive
//      job control a `&` child stays in that group, so a negative-pid signal
//      reaps the whole tree in one shot. When isolated, killing the group also
//      kills the PID-namespace init (the forked bash), and the kernel then reaps
//      every remaining process in that namespace — so backgrounded children are
//      torn down by the namespace lifetime as well as by the group signal.
//   2. Resolve on 'close' (all stdio drained to EOF) so the buffered stdout is
//      COMPLETE — the vended fileEditor reads files via `base64 < file` and
//      decodes result.stdout, so a truncated capture would corrupt reads/writes.
//      But 'close' alone BLOCKS for the full timeout when a backgrounded child
//      inherits the stdout/stderr pipes (their write-ends never close). So the
//      moment the shell ITSELF exits we SIGKILL the process group: that reaps the
//      backgrounded child and closes the leaked pipe FDs, letting 'close' fire
//      promptly with the foreground output intact (e.g. `npm run dev & sleep 3;
//      echo` returns in ~3s, not the 600s floor). A bounded post-exit grace
//      (EXIT_DRAIN_GRACE_MS) resolves anyway if a child escaped the group (e.g.
//      via `setsid`) and still holds the pipes, so we never hang.
//
// `isolate` (builder only) wraps the command in the unprivileged user+PID+mount
// namespace (see UNSHARE_ARGS) so the agent's shell cannot signal the harness.
export function runShell(
	command: string,
	cwd: string,
	timeoutSec: number | undefined,
	signal: AbortSignal | undefined,
	env: Record<string, string> | undefined,
	isolate = false,
): Promise<ExecutionResult> {
	return new Promise<ExecutionResult>((resolve, reject) => {
		const { file, args } = buildAgentSpawn(command, cwd, isolate);
		const proc = spawn(file, args, {
			env: env ? { ...process.env, ...env } : process.env,
			detached: true,
			// Give stdin an explicit EOF (ignore) so an interactive prompt (npx
			// install y/n, a bare `read`) fails fast instead of blocking on a TTY
			// that never comes until the timeout floor.
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		let settled = false;
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		let drainHandle: ReturnType<typeof setTimeout> | undefined;

		// SIGKILL the whole process group (negative pid). This reaps any process
		// the command backgrounded — whose inherited stdout/stderr pipe write-ends
		// are exactly what keeps 'close' from firing (blocking the tool call for
		// the full timeout) and holds libuv's loop open so Node never exits after
		// invoke() returns. Guarded: pid is undefined if spawn failed, and the
		// group may already be gone (ESRCH).
		const killGroup = (): void => {
			if (proc.pid === undefined) return;
			try {
				process.kill(-proc.pid, 'SIGKILL');
			} catch {
				// group already reaped — nothing to do
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
		// The direct bash process has terminated (its foreground pipeline is done);
		// only `&`-backgrounded children can still be alive. Reap the group so their
		// leaked pipe FDs close and 'close' can fire, and arm the grace fallback for
		// a child that escaped the group.
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
