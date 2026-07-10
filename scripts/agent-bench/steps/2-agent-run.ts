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
import { readFileSync, writeFileSync } from 'node:fs';
import { Agent, type AgentResult, BedrockModel, ModelStreamUpdateEvent } from '@strands-agents/sdk';
import { makeBash } from '@strands-agents/sdk/vended-tools/bash';
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor';
import { builderSystem } from '../prompts.ts';
import {
	INVOKE_MAX_ATTEMPTS,
	describeModelError,
	isRetryableModelError,
	nextBackoffMs,
	sleep,
} from './lib/bedrock-retry.ts';
import { buildCheckpointEnvelope, writeEnvelopeAtomic } from './lib/partial-envelope.mjs';
import { WorkspaceSandbox, describeError, required } from './lib/run-shell.ts';

const WORKSPACE = required('WORKSPACE', '[bench]');
const TASK_PROMPT_PATH = required('TASK_PROMPT', '[bench]');
const OUTPUT = required('OUTPUT', '[bench]');
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

const taskPrompt = readFileSync(TASK_PROMPT_PATH, 'utf-8');

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
// Best-effort live usage accounting. The workflow caps step 2 at a hard
// wall-clock timeout; when it fires, the Actions runner SIGTERMs this process
// mid-invoke, so agent.invoke() never returns and the final envelope below
// never runs — without this the cell is recorded as tokens_in=0, masking the
// (often large) spend that triggered the timeout. We accumulate usage from the
// model metadata events the agent emits after each model call (the same source
// result.metrics.accumulatedUsage is built from) and flush a partial envelope
// from the signal handler. The counters live at module scope so they also
// survive across invoke retries and stay readable from the signal handler.
let partialTokensIn = 0;
let partialTokensOut = 0;
let partialCycles = 0;

// Fresh agent per invoke attempt (mirrors the judge). A throttle/transient
// failure can surface mid-stream and leave a half-built conversation on the
// Agent instance; reusing it on retry could replay a corrupt turn, so each
// attempt gets a clean agent. The ModelStreamUpdateEvent hook is re-attached on
// every build and feeds the module-scope counters above, so tokens burned on a
// failed attempt are still counted.
function makeBuilderAgent(): Agent {
	const agent = new Agent({
		model: new BedrockModel({
			modelId: MODEL_ID,
			region: process.env.AWS_REGION ?? 'us-east-1',
			temperature: 0,
			// AWS-SDK-layer adaptive retry — the lower half of a two-layer throttle
			// defense (the app-level retry loop around invoke() below is the upper
			// half). Mirrors the judge: retryMode 'adaptive' adds client-side rate
			// limiting on top of the 8-attempt budget, so a TPM throttle is often
			// absorbed inside a single invoke before it surfaces as a ModelError.
			clientConfig: { maxAttempts: 8, retryMode: 'adaptive' },
		}),
		systemPrompt: builderSystem(WORKSPACE),
		sandbox: new WorkspaceSandbox(WORKSPACE, BASH_MIN_TIMEOUT_SEC),
		tools: [makeBash(), fileEditor],
	});
	agent.addHook(ModelStreamUpdateEvent, (event) => {
		const inner = event.event;
		if (inner.type === 'modelMetadataEvent' && inner.usage) {
			partialTokensIn += inner.usage.inputTokens ?? 0;
			partialTokensOut += inner.usage.outputTokens ?? 0;
			partialCycles += 1;
			// Persist a running checkpoint the moment usage advances, so an
			// UNGRACEFUL kill (a bash process-group/pkill storm that tears down this
			// harness without running the SIGTERM flush below) still leaves nonzero
			// tokens + a partial cycle count on OUTPUT rather than the step-0 zeros.
			writeCheckpoint();
		}
	});
	return agent;
}

const started = Date.now();
let finished = false;

// Persist a running checkpoint of the accumulated token/cycle spend to OUTPUT
// (atomically) so an UNGRACEFUL kill — the agent's vended bash issuing a broad
// process-group / `pkill` storm that tears down this harness (npx tsx) without
// running the SIGTERM flush below — still leaves nonzero tokens + a partial cycle
// count on disk instead of the step-0 zeros. Skipped once `finished` is set: the
// terminal exit paths (SIGTERM flush / invoke-exhausted sentinel / normal finish)
// then OWN the envelope and overwrite this checkpoint with a real, TERMINAL
// stop_reason, so a genuine timeout stays agent_fail (INCLUDED). Best-effort: a
// failed checkpoint never disrupts the run — the next cycle retries and the
// terminal writes remain the source of truth.
function writeCheckpoint(): void {
	if (finished) return;
	try {
		writeEnvelopeAtomic(
			OUTPUT,
			buildCheckpointEnvelope({
				model: MODEL_ID,
				startedMs: started,
				tokensIn: partialTokensIn,
				tokensOut: partialTokensOut,
				cycles: partialCycles,
			}),
		);
	} catch (err) {
		process.stderr.write(`[bench] checkpoint write failed (non-fatal): ${describeError(err)}\n`);
	}
}

// Flush a best-effort partial envelope if the runner kills us: SIGTERM on the
// hard wall-clock timeout (`timeout-minutes`), or SIGINT on a cancellation
// (concurrency cancel-in-progress fired by the next push). writeFileSync + exit
// run synchronously inside the handler, before the SIGKILL grace period elapses.
function writePartialEnvelopeAndExit(signal: string): void {
	if (finished) return;
	finished = true;
	// Label the archived envelope by signal so a cancellation isn't mislabeled a
	// timeout. This is a GRACEFUL terminal exit: the TERMINAL stop_reason written
	// here (and the ABSENCE of the checkpoint flag) is what scoring.classifyCell
	// uses to keep a genuine timeout as agent_fail (INCLUDED) — as opposed to an
	// ungraceful teardown that never reaches this handler and leaves the baseline
	// zeros or a surviving non-terminal checkpoint (→ harness_error, EXCLUDED).
	// summary.mjs additionally DISPLAYS stop_reason in a column.
	const isCancel = signal === 'SIGINT';
	const stopReason = isCancel ? 'cancelled' : 'wall_clock_timeout';
	const cause = isCancel ? 'cancellation' : 'workflow wall-clock timeout';
	let wrote = false;
	try {
		writeFileSync(
			OUTPUT,
			JSON.stringify(
				{
					model: MODEL_ID,
					duration_sec: Math.round((Date.now() - started) / 1000),
					tokens_in: partialTokensIn,
					tokens_out: partialTokensOut,
					stop_reason: stopReason,
					cycle_count: partialCycles,
					final_message: '',
					partial: true,
					builder_error: `killed by ${signal} (${cause}) after ${partialCycles} model call(s)`,
				},
				null,
				2,
			),
		);
		wrote = true;
		process.stderr.write(
			`[bench] ${signal}: wrote partial envelope tokens=${partialTokensIn}/${partialTokensOut} cycles=${partialCycles}\n`,
		);
	} catch (err) {
		process.stderr.write(`[bench] failed to write partial envelope on ${signal}: ${describeError(err)}\n`);
		// Envelope lost — still surface the spend in ONE parseable marker so the
		// tokens/cycles remain recoverable from the CI logs despite the failed flush.
		process.stderr.write(
			`[bench] partial-spend tokens_in=${partialTokensIn} tokens_out=${partialTokensOut} cycles=${partialCycles}\n`,
		);
	}
	// No trace on the timeout path: the Strands built-in trace/metrics
	// (result.traces / result.metrics) only exist once agent.invoke() RETURNS,
	// and the SDK exposes no public mid-run accessor for them on the Agent
	// instance (its `_tracer`/`_meter` are private) — so a timed-out cell emits
	// only this partial envelope (tokens/cycles from the ModelStreamUpdateEvent
	// hook). We deliberately do NOT hand-build a trace.
	//
	// Always terminate. Exit 124 = clean timeout with the partial envelope
	// flushed; exit 125 = the envelope write itself FAILED, so downstream sees no
	// spend from this run. The distinct code (plus the stderr marker above) keeps
	// a lost-envelope flush from looking identical to a clean timeout in the logs.
	process.exit(wrote ? 124 : 125);
}
process.on('SIGTERM', () => writePartialEnvelopeAndExit('SIGTERM'));
process.on('SIGINT', () => writePartialEnvelopeAndExit('SIGINT'));

// Startup stagger: spread each concurrent wave's FIRST Bedrock call so N cells
// don't all hit InvokeModelWithResponseStream in the same instant and trip the
// account-wide Bedrock tokens-per-minute (TPM) ceiling — the burst that surfaced
// as "ModelError: Too many tokens" across 6/10 cells in run 28967475174. Keyed to
// the matrix job index (BENCH_CELL_INDEX = strategy.job-index in the workflow) so
// the fan-out is DETERMINISTIC and reproducible, not random.
//
// We stagger by the WITHIN-WAVE slot — cellIndex mod wave size — not the raw
// 0..N-1 index. With max-parallel=5, raw-index staggering would make the second
// wave (indices 5–9) sleep 35–63s ON TOP of already having waited for a runner
// slot; keying to (index % waveSize) instead bounds every cell to slots 0..4 ⇒
// 0,STEP,2·STEP,3·STEP,4·STEP = ~0–28s at the default STEP=7, and every wave
// reuses that same bounded window. BENCH_STAGGER_WAVE_SIZE mirrors the workflow's
// max-parallel (GitHub Actions expressions can't do modulo, so the wrap happens
// here). Wave size unset (local runs) ⇒ no wrap; index 0 ⇒ slot 0 ⇒ no delay.
const STAGGER_STEP_SEC = Number(process.env.BENCH_STAGGER_STEP_SEC ?? '7');
const STAGGER_WAVE_SIZE = Number(process.env.BENCH_STAGGER_WAVE_SIZE ?? '0');
const cellIndex = Number.parseInt(process.env.BENCH_CELL_INDEX ?? '0', 10);
const staggerSlot =
	Number.isFinite(cellIndex) && cellIndex > 0 && STAGGER_WAVE_SIZE > 0 ? cellIndex % STAGGER_WAVE_SIZE : cellIndex;
const staggerMs =
	Number.isFinite(staggerSlot) && staggerSlot > 0 && STAGGER_STEP_SEC > 0 ? staggerSlot * STAGGER_STEP_SEC * 1000 : 0;
if (staggerMs > 0) {
	process.stderr.write(
		`[bench] startup stagger: cell index ${cellIndex} (wave slot ${staggerSlot}/${STAGGER_WAVE_SIZE || '∞'}) → sleeping ${Math.round(staggerMs / 1000)}s before first model call\n`,
	);
	await sleep(staggerMs);
}

// App-level throttle-retry around invoke() — the upper half of the two-layer
// defense (clientConfig adaptive retry is the lower half, inside each invoke).
// Only throttle/transient failures are retried (isRetryableModelError); a
// non-retryable error breaks immediately. Backoff mirrors the judge. On every
// path the SIGTERM handler stays armed, so a cancellation during a backoff sleep
// still flushes the partial envelope.
let result: AgentResult | undefined;
let lastErr: unknown;
for (let attempt = 1; attempt <= INVOKE_MAX_ATTEMPTS; attempt++) {
	try {
		result = await makeBuilderAgent().invoke(taskPrompt, { limits: { turns: MAX_TURNS } });
		break;
	} catch (err) {
		lastErr = err;
		const retryable = isRetryableModelError(err);
		process.stderr.write(
			`[bench] agent.invoke attempt ${attempt}/${INVOKE_MAX_ATTEMPTS} failed (${retryable ? 'throttle/transient' : 'non-retryable'}): ${describeModelError(err)}\n`,
		);
		if (!retryable || attempt >= INVOKE_MAX_ATTEMPTS) break;
		const delayMs = nextBackoffMs(attempt);
		process.stderr.write(`[bench] backing off ${Math.round(delayMs / 1000)}s before attempt ${attempt + 1}\n`);
		await sleep(delayMs);
	}
}

if (!result) {
	finished = true;
	const desc = describeModelError(lastErr);
	process.stderr.write(`[bench] agent.invoke failed after ${INVOKE_MAX_ATTEMPTS} attempt(s): ${desc}\n`);
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

// Explicit success exit (mirrors the process.exit(124/125) timeout / process.exit(1)
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
