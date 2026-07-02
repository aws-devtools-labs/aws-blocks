/**
 * Builder step: ask the agent to implement the task in $WORKSPACE.
 *
 * Inputs (env):
 *   WORKSPACE        absolute path to the scaffolded bench-app
 *   TASK_PROMPT      path to PROMPT.md
 *   OUTPUT           path to write the builder envelope JSON
 *   BENCH_MODEL      Bedrock model ID (default: us.anthropic.claude-sonnet-4-6)
 *   TRACE            (optional) path to write the Strands built-in hierarchical
 *                    tool-call trace tree (result.traces). Only written on normal
 *                    completion; on a wall-clock timeout no trace is emitted (the
 *                    SDK exposes no mid-run trace accessor).
 *   METRICS          (optional) path to write the run metrics (cycleCount,
 *                    totalDuration, accumulatedUsage, per-tool toolUsage, …)
 *
 * Tools: the framework's vended `bash` + `fileEditor`, both routed through a
 * Sandbox rooted at WORKSPACE — so containment (cwd = WORKSPACE) is enforced by
 * the Sandbox, not by a cwd+prompt convention. The bash execute timeout is
 * floored to BASH_MIN_TIMEOUT_SEC so npm install/build survive.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import {
	Agent,
	BedrockModel,
	type ExecuteOptions,
	type ExecutionResult,
	ModelStreamUpdateEvent,
	PosixShellSandbox,
	SandboxAbortError,
	SandboxTimeoutError,
	type StreamChunk,
} from '@strands-agents/sdk';
import { makeBash } from '@strands-agents/sdk/vended-tools/bash';
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor';
import { builderSystem } from '../prompts.ts';

const WORKSPACE = required('WORKSPACE');
const TASK_PROMPT_PATH = required('TASK_PROMPT');
const OUTPUT = required('OUTPUT');
const TRACE_PATH = process.env.TRACE;
const METRICS_PATH = process.env.METRICS;
const MODEL_ID = process.env.BENCH_MODEL ?? 'us.anthropic.claude-sonnet-4-6';
// Backstop against runaway tool-call loops (v1's long prompts caused
// over-iteration). The Strands TS SDK enforces this per-invocation; hitting it
// yields stopReason 'limitTurns'. This is only a runaway-loop backstop: the real
// bound is the 35-min wall-clock timeout in the workflow, which prior runs used
// only ~20% of, so 120 leaves ample headroom for a full build without risking a
// runaway. One turn = one model call plus any tool calls it makes.
const MAX_TURNS = 120;
// Floor for the vended bash execute timeout (seconds). The vended bash tool
// defaults to 120s per command — long enough to kill `npm install` / `npm run
// build`. There is no `makeBash({timeout})` knob (the factory only takes
// name/description/inputSchema and the callback hardcodes `input.timeout ?? 120`),
// so we enforce the floor in the Sandbox instead: WorkspaceSandbox raises any
// provided timeout to at least this many seconds. 10 minutes leaves ample room
// for a cold install + build while staying inside the workflow's wall-clock cap.
const BASH_MIN_TIMEOUT_SEC = 600;
// Bounded grace (ms) between the direct bash process exiting and force-resolving
// the shell result. Normal commands resolve earlier on 'close' (all stdio
// drained); this only fires for the pathological case where a backgrounded
// grandchild escaped the process group (e.g. via `setsid`) and still holds the
// inherited stdout/stderr pipes open, so 'close' would otherwise never fire.
const EXIT_DRAIN_GRACE_MS = 2000;

const taskPrompt = readFileSync(TASK_PROMPT_PATH, 'utf-8');

// Host-execution Sandbox rooted at a fixed directory. The vended bash +
// fileEditor tools route every command and file operation through the agent's
// configured Sandbox, so rooting it at WORKSPACE makes containment structural
// (the shell's cwd is the workspace) rather than a prompt convention.
// PosixShellSandbox already implements readFile/writeFile/listFiles on top of
// executeStreaming, so rooting the shell roots the file editor too — the only
// method we must supply is executeStreaming.
class WorkspaceSandbox extends PosixShellSandbox {
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
		// The vended bash callback always passes a timeout (its own 120s default
		// when the model omits one), which would kill npm install/build. Floor it
		// to minTimeoutSec so long commands survive. `undefined` means the caller
		// opted out of a timeout (e.g. the file-editor's internal read/write execs
		// run with none) — leave that untouched.
		const timeout = options?.timeout === undefined ? undefined : Math.max(options.timeout, this.minTimeoutSec);
		const result = await runShell(command, cwd, timeout, options?.signal, options?.env);
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
//   1. Spawn `detached: true` so bash leads its OWN process group (pgid == pid).
//      Under non-interactive job control a `&` child stays in that group, so a
//      negative-pid signal reaps the whole tree in one shot.
//   2. Resolve on 'close' (all stdio drained to EOF) so the buffered stdout is
//      COMPLETE — the vended fileEditor reads files via `base64 < file` and
//      decodes result.stdout, so a truncated capture would corrupt reads/writes.
//      But 'close' alone BLOCKS for the full timeout when a backgrounded child
//      inherits the stdout/stderr pipes (their write-ends never close). So the
//      moment BASH ITSELF exits we SIGKILL the process group: that reaps the
//      backgrounded child and closes the leaked pipe FDs, letting 'close' fire
//      promptly with the foreground output intact (e.g. `npm run dev & sleep 3;
//      echo` returns in ~3s, not the 600s floor). A bounded post-exit grace
//      (EXIT_DRAIN_GRACE_MS) resolves anyway if a child escaped the group (e.g.
//      via `setsid`) and still holds the pipes, so we never hang.
function runShell(
	command: string,
	cwd: string,
	timeoutSec: number | undefined,
	signal: AbortSignal | undefined,
	env: Record<string, string> | undefined,
): Promise<ExecutionResult> {
	return new Promise<ExecutionResult>((resolve, reject) => {
		const proc = spawn('bash', ['-c', `cd ${shellQuote(cwd)} && ${command}`], {
			env: env ? { ...process.env, ...env } : process.env,
			detached: true,
		});
		let stdout = '';
		let stderr = '';
		let settled = false;
		let exited = false;
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
			if (settled || exited) return;
			exited = true;
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

// Single-quote a path for safe interpolation into the `cd <cwd>` shell prefix.
function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

// INTENTIONALLY MINIMAL: a bare agent given only the framework's vended tools
// (`bash` + `fileEditor`, routed through a WORKSPACE-rooted Sandbox), no planner,
// no sub-agents, no retrieval, no bespoke scaffolding. This is a deliberate
// design choice, not an unfinished one — DO NOT "helpfully" swap in a richer
// agent:
//   - Stable measurement surface: the bench measures how the FRAMEWORK (the
//     scaffold + Building Blocks + docs + its own vended tools) shapes an agent's
//     output. A fixed, minimal agent keeps that surface constant so a score delta
//     is deterministically attributable to a framework change, not to agent
//     tweaks.
//   - Accounting control: token usage (the ModelStreamUpdateEvent hook) and the
//     SIGTERM wall-clock-timeout envelope flush both need direct, in-process
//     control of the loop — a higher-level "helpful" agent abstraction would hide
//     the model-metadata events and the invoke lifecycle we depend on here.
//   - Reproducibility: a pinned model + temperature 0 + a hard MAX_TURNS bound is
//     what makes a run repeatable; extra tools/heuristics reintroduce variance.
// The vended bash tool routes through `context.agent.sandbox`, so the Sandbox is
// set on the Agent and the timeout floor lives in WorkspaceSandbox (see above).
// NOTE: the barrel `bash` export is a host-only persistent session that ignores
// the sandbox — `makeBash()` is the sandbox-aware tool, so we use that.
const agent = new Agent({
	model: new BedrockModel({
		modelId: MODEL_ID,
		region: process.env.AWS_REGION ?? 'us-east-1',
		temperature: 0,
	}),
	systemPrompt: builderSystem(),
	sandbox: new WorkspaceSandbox(WORKSPACE, BASH_MIN_TIMEOUT_SEC),
	tools: [makeBash(), fileEditor],
});

// Best-effort live usage accounting. The workflow caps step 2 at a hard
// wall-clock timeout; when it fires, the Actions runner SIGTERMs this process
// mid-invoke, so agent.invoke() never returns and the final envelope below
// never runs — without this the cell is recorded as tokens_in=0, masking the
// (often large) spend that triggered the timeout. We accumulate usage from the
// model metadata events the agent emits after each model call (the same source
// result.metrics.accumulatedUsage is built from) and flush a partial envelope
// from the signal handler.
let partialTokensIn = 0;
let partialTokensOut = 0;
let partialCycles = 0;
agent.addHook(ModelStreamUpdateEvent, (event) => {
	const inner = event.event;
	if (inner.type === 'modelMetadataEvent' && inner.usage) {
		partialTokensIn += inner.usage.inputTokens ?? 0;
		partialTokensOut += inner.usage.outputTokens ?? 0;
		partialCycles += 1;
	}
});

const started = Date.now();
let finished = false;

// Flush a best-effort partial envelope if the runner kills us on the hard
// wall-clock timeout (SIGTERM, or SIGINT on cancellation). writeFileSync + exit
// run synchronously inside the handler, before the SIGKILL grace period elapses.
function writePartialEnvelopeAndExit(signal: string): void {
	if (finished) return;
	finished = true;
	try {
		writeFileSync(
			OUTPUT,
			JSON.stringify(
				{
					model: MODEL_ID,
					duration_sec: Math.round((Date.now() - started) / 1000),
					tokens_in: partialTokensIn,
					tokens_out: partialTokensOut,
					stop_reason: 'wall_clock_timeout',
					cycle_count: partialCycles,
					final_message: '',
					partial: true,
					builder_error: `killed by ${signal} (workflow wall-clock timeout) after ${partialCycles} model call(s)`,
				},
				null,
				2,
			),
		);
		process.stderr.write(
			`[bench] ${signal}: wrote partial envelope tokens=${partialTokensIn}/${partialTokensOut} cycles=${partialCycles}\n`,
		);
	} catch (err) {
		process.stderr.write(`[bench] failed to write partial envelope on ${signal}: ${describeError(err)}\n`);
	}
	// No trace on the timeout path: the Strands built-in trace/metrics
	// (result.traces / result.metrics) only exist once agent.invoke() RETURNS,
	// and the SDK exposes no public mid-run accessor for them on the Agent
	// instance (its `_tracer`/`_meter` are private) — so a timed-out cell emits
	// only this partial envelope (tokens/cycles from the ModelStreamUpdateEvent
	// hook). We deliberately do NOT hand-build a trace.
	process.exit(124);
}
process.on('SIGTERM', () => writePartialEnvelopeAndExit('SIGTERM'));
process.on('SIGINT', () => writePartialEnvelopeAndExit('SIGINT'));

let result;
try {
	result = await agent.invoke(taskPrompt, { limits: { turns: MAX_TURNS } });
} catch (err) {
	finished = true;
	const desc = describeError(err);
	process.stderr.write(`[bench] agent.invoke failed: ${desc}\n`);
	// Write a sentinel envelope so the judge step has something to read and the
	// cell still produces a usable result.json artifact. Use the best-effort
	// usage accumulated so far rather than hardcoded zeros, so a mid-run failure
	// still reflects the tokens it actually spent.
	writeFileSync(
		OUTPUT,
		JSON.stringify(
			{
				model: MODEL_ID,
				duration_sec: Math.round((Date.now() - started) / 1000),
				tokens_in: partialTokensIn,
				tokens_out: partialTokensOut,
				stop_reason: 'error',
				cycle_count: partialCycles,
				final_message: '',
				builder_error: desc,
			},
			null,
			2,
		),
	);
	process.exit(1);
}
finished = true;
const duration_sec = Math.round((Date.now() - started) / 1000);

const usage = result.metrics?.accumulatedUsage;
const tokensIn = usage?.inputTokens ?? 0;
const tokensOut = usage?.outputTokens ?? 0;

writeFileSync(
	OUTPUT,
	JSON.stringify(
		{
			model: MODEL_ID,
			duration_sec,
			tokens_in: tokensIn,
			tokens_out: tokensOut,
			stop_reason: result.stopReason,
			cycle_count: result.metrics?.cycleCount ?? 0,
			final_message: messageText(result.lastMessage),
		},
		null,
		2,
	),
);
process.stderr.write(
	`[bench] done: stop=${result.stopReason} tokens=${tokensIn}/${tokensOut} cycles=${result.metrics?.cycleCount ?? 0} ${duration_sec}s\n`,
);

// Persist the full hierarchical tool-call trace tree and the run metrics as
// SEPARATE artifacts. NEVER serialize `result` directly: AgentResult.toJSON()
// deliberately strips traces/metrics/invocationState to keep the wire payload
// small, so JSON.stringify(result) would silently drop exactly what we want.
// Access the properties instead — traces are JSONSerializable (call toJSON() on
// each), metrics is a plain aggregate object.
if (TRACE_PATH) {
	try {
		writeFileSync(TRACE_PATH, JSON.stringify(result.traces?.map((t) => t.toJSON()) ?? [], null, 2));
	} catch (err) {
		process.stderr.write(`[bench] failed to write trace to ${TRACE_PATH}: ${describeError(err)}\n`);
	}
}
if (METRICS_PATH) {
	try {
		writeFileSync(METRICS_PATH, JSON.stringify(result.metrics ?? {}, null, 2));
	} catch (err) {
		process.stderr.write(`[bench] failed to write metrics to ${METRICS_PATH}: ${describeError(err)}\n`);
	}
}

// Explicit success exit (mirrors the process.exit(124) timeout / process.exit(1)
// error paths). The envelope + trace + metrics are all written above, so there is
// nothing left to do. Without this, Node would wait for the libuv loop to drain
// naturally — and if the agent left a stray handle open (e.g. a dev server it
// backgrounded that somehow escaped the per-command process-group reap), that
// wait never ends and the GHA step idles until the 35-min wall-clock SIGKILL,
// falsely recorded as an agent timeout. Exiting here guarantees prompt teardown.
process.exit(0);

function messageText(msg: import('@strands-agents/sdk').Message | undefined): string {
	if (!msg) return '';
	return msg.content
		.map((b) => ('text' in b && typeof b.text === 'string' ? b.text : ''))
		.filter(Boolean)
		.join('\n');
}

function describeError(err: unknown): string {
	const e = err as { name?: string; message?: string };
	return [e?.name, e?.message].filter(Boolean).join(': ') || String(err);
}

function required(name: string): string {
	const v = process.env[name];
	if (!v) {
		process.stderr.write(`[bench] missing env var ${name}\n`);
		process.exit(1);
	}
	return v;
}
