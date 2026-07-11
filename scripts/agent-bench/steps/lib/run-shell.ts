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
// The fix: run the agent's shell as a DEDICATED UNPRIVILEGED USER (`benchagent`)
// via `sudo -n runuser -u benchagent -- env <full-env> bash -c '<cmd>'`. The
// kernel forbids signalling a process owned by a different uid (EPERM), so the
// agent's `pkill`/`killall`/`fuser -k`/`kill -1` cannot reach the harness — a
// kernel boundary, not a convention.
//
// Why UID isolation rather than a PID namespace (`unshare --pid --fork`): a
// per-command PID namespace SIGKILLs every process in it when the command's
// PID-1 bash exits, which tears down a `setsid`/`nohup` dev server the agent
// started to keep alive ACROSS bash calls — the exact web-app workflow the bench
// must support. UID isolation has no per-command lifetime: a `setsid` server the
// agent backgrounds keeps running as `benchagent` across calls, so cross-call
// server persistence is preserved (the pre-existing behavior) while the harness
// stays unsignalable.
//
// Env / fairness: `runuser` does not run a login shell (no `-l`), so we hand it
// the agent's FULL resolved env explicitly via `env KEY=VAL … bash -c` (built
// from the same env object the bare spawn uses) — this survives sudo's env scrub,
// so PATH (incl. the mise node), AWS/Bedrock creds, npm config and the bench vars
// all reach the agent unchanged. HOME is pointed at benchagent's home so npm/mise
// caches are writable. The workspace is granted to benchagent (and back to the
// harness user) with a recursive + default ACL by prepareWorkspaceIsolation, so
// the agent keeps a full shell — installs deps, runs a dev server, runs tests,
// reads/writes every workspace file exactly as before.
//
// Used ONLY when `sudo -n runuser -u benchagent` works (passwordless, user
// present — probed once, memoized) AND the workspace ACL is granted. Otherwise
// (local dev without the user, no passwordless sudo) we fall back to the bare
// `bash -c` spawn so the bench stays green regardless; the builder logs the mode.
export const BENCH_AGENT_USER = process.env.BENCH_AGENT_USER || 'benchagent';

let isolationProbe: boolean | undefined;
let agentHome: string | undefined;

// benchagent's home dir (from its passwd entry) so HOME points somewhere the
// agent can write (npm/mise caches). Falls back to the conventional path.
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

// Probe (once, memoized) whether the agent shell can be run as benchagent via
// passwordless sudo+runuser. Runs the EXACT privilege transition runShell uses
// against a trivial `true`, so a green probe guarantees the real spawn's sudo
// policy + user lookup succeed. Any failure — sudo needs a password, user
// absent, runuser missing — yields false and the caller falls back to bare bash.
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

// Grant benchagent (and, symmetrically, the harness user) rwx on the workspace
// with a recursive ACL for the files the harness already scaffolded and a default
// ACL so files EITHER user creates later stay accessible to the other — the agent
// (benchagent) edits/builds harness-scaffolded files, and the later verify/judge
// steps (harness user) must read/write the dist/test outputs the agent produced.
// Returns true only if both setfacl calls succeed; the caller disables isolation
// (falls back to bare bash) when it returns false so the agent can never be left
// unable to write its own workspace.
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
	const spec = `u:${BENCH_AGENT_USER}:rwx${me ? `,u:${me}:rwx` : ''}`;
	const access = spawnSync('setfacl', ['-R', '-m', spec, root], { stdio: 'ignore', timeout: 120_000 });
	const dflt = spawnSync('setfacl', ['-R', '-d', '-m', spec, root], { stdio: 'ignore', timeout: 120_000 });
	return access.status === 0 && !access.error && dflt.status === 0 && !dflt.error;
}

// Build the argv for one agent shell command: `cd <cwd> && <command>` run under a
// POSIX shell, wrapped so it runs as benchagent when isolation is requested AND
// available. Split out (and exported) so the wrap decision is unit-testable
// without spawning. `env` is the fully-resolved environment (process.env merged
// with the per-call overrides); when isolated we re-materialize it AFTER the
// privilege transition via `env KEY=VAL …` so it survives sudo's env scrub.
// `isolate` defaults false so the judge's read-only shell keeps the bare spawn.
export function buildAgentSpawn(
	command: string,
	cwd: string,
	isolate: boolean,
	env: Record<string, string>,
): { file: string; args: string[]; isolated: boolean } {
	const inner = `cd ${shellQuote(cwd)} && ${command}`;
	if (isolate && isolationAvailable()) {
		const forwarded: Record<string, string> = { ...env, HOME: agentHome ?? `/home/${BENCH_AGENT_USER}` };
		// Only forward valid shell identifier names (drops exported-function keys
		// like `BASH_FUNC_x%%`); values are passed as argv so they need no quoting.
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
	// `isolate` runs each command as the dedicated unprivileged user benchagent
	// (see buildAgentSpawn / runShell) so the agent's shell cannot signal the
	// parent harness (cross-uid EPERM). The builder passes true; the judge leaves
	// it false (its shell is a read-only, disposable copy that never issues kills).
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
//   1. Spawn `detached: true` so the spawned process (bash, or `sudo` when
//      isolated) leads its OWN process group (pgid == pid). Under non-interactive
//      job control a `&` child stays in that group, so a negative-pid signal
//      reaps the whole tree in one shot. A `setsid`-detached server the agent
//      starts to persist ACROSS calls escapes this group by design, so the group
//      kill reaps only the foreground tree and leaves that server running.
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
// `isolate` (builder only) runs the command as benchagent via sudo+runuser (see
// buildAgentSpawn) so the agent's shell cannot signal the harness. Because that
// group is owned by benchagent, the harness (a different uid) cannot signal it
// directly, so the group kill is escalated through `sudo kill` when isolated.
export function runShell(
	command: string,
	cwd: string,
	timeoutSec: number | undefined,
	signal: AbortSignal | undefined,
	env: Record<string, string> | undefined,
	isolate = false,
): Promise<ExecutionResult> {
	return new Promise<ExecutionResult>((resolve, reject) => {
		// Resolve the full environment ONCE (process.env + per-call overrides) so
		// both the spawn and buildAgentSpawn's `env KEY=VAL …` re-materialization
		// (isolated path) see identical values.
		const merged: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) if (v !== undefined) merged[k] = v;
		if (env) for (const [k, v] of Object.entries(env)) merged[k] = v;
		const { file, args } = buildAgentSpawn(command, cwd, isolate, merged);
		const proc = spawn(file, args, {
			env: merged,
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
		// group may already be gone (ESRCH). When isolated the group is owned by
		// benchagent, which the harness uid cannot signal directly, so escalate
		// through `sudo kill`; a `setsid` server escapes this group either way and
		// keeps running (cross-call persistence).
		const killGroup = (): void => {
			if (proc.pid === undefined) return;
			if (isolate) {
				spawnSync('sudo', ['-n', 'kill', '-9', `-${proc.pid}`], { stdio: 'ignore', timeout: 5000 });
				return;
			}
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
