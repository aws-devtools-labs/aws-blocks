/**
 * Builder step: ask the agent to implement the task in $WORKSPACE.
 *
 * Inputs (env): WORKSPACE (scaffolded bench-app), TASK_PROMPT (PROMPT.md path), OUTPUT (envelope
 * JSON path), BENCH_MODEL (default us.anthropic.claude-opus-4-8), TRACE/METRICS (optional output
 * paths; trace written only on normal completion, none on a wall-clock timeout).
 *
 * Tools: the framework's vended `bash` + `fileEditor`, routed through a WorkspaceSandbox rooted at
 * WORKSPACE (containment enforced by the Sandbox); the bash timeout is floored to BASH_MIN_TIMEOUT_SEC.
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
import {
	BENCH_AGENT_USER,
	WorkspaceSandbox,
	describeError,
	isolationAvailable,
	prepareWorkspaceIsolation,
	required,
} from './lib/run-shell.ts';

const WORKSPACE = required('WORKSPACE', '[bench]');
const TASK_PROMPT_PATH = required('TASK_PROMPT', '[bench]');
const OUTPUT = required('OUTPUT', '[bench]');
const TRACE_PATH = process.env.TRACE;
const METRICS_PATH = process.env.METRICS;
const MODEL_ID = process.env.BENCH_MODEL ?? 'us.anthropic.claude-opus-4-8';
// Opus rejects the `temperature` parameter (like the judge), so only pin temperature=0 for models
// that accept it (e.g. Sonnet); keyed off the model id so BENCH_MODEL stays self-configuring.
const MODEL_ACCEPTS_TEMPERATURE = !/opus/i.test(MODEL_ID);
// Runaway-loop backstop (one turn = one model call + its tool calls); the real bound is the 35-min
// wall-clock timeout, which prior runs used only ~20% of, so 120 leaves ample headroom.
const MAX_TURNS = 120;
// Floor for the vended bash timeout (s): the tool defaults to 120s (kills npm install/build) and has
// no timeout knob, so WorkspaceSandbox raises any provided timeout to at least this. 10 min is ample.
const BASH_MIN_TIMEOUT_SEC = 600;

const taskPrompt = readFileSync(TASK_PROMPT_PATH, 'utf-8');

// Resolve agent-shell UID isolation (issue #184) ONCE (the ACL grant must run a single time, not
// per invoke-retry). Not a hard failure when unavailable — this line records whether containment was
// active for the cell. On the GitHub-hosted runner benchagent has passwordless sudo, so expect ACTIVE.
const ISOLATE = isolationAvailable() && prepareWorkspaceIsolation(WORKSPACE);
process.stderr.write(
	`[bench] agent shell isolation: ${
		ISOLATE
			? `ACTIVE (agent shell runs as ${BENCH_AGENT_USER} — cross-uid EPERM means it cannot signal the harness)`
			: 'DISABLED (no passwordless sudo+runuser for benchagent or ACL grant failed; falling back to bare bash)'
	}\n`,
);

// INTENTIONALLY MINIMAL: a bare agent given only the vended `bash` + `fileEditor` (WORKSPACE-rooted
// Sandbox), no planner/sub-agents/retrieval. Deliberate — DO NOT swap in a richer agent:
//   - Stable measurement surface: a fixed minimal agent keeps score deltas attributable to a
//     FRAMEWORK change, not agent tweaks.
//   - Accounting control: the token hook + SIGTERM envelope flush need direct in-process control of
//     the invoke loop, which a higher-level agent abstraction would hide.
//   - Reproducibility: pinned model + temperature 0 + hard MAX_TURNS; extra tools reintroduce variance.
// The vended bash routes through context.agent.sandbox, so the Sandbox is set on the Agent and the
// timeout floor lives in WorkspaceSandbox. Use makeBash() (sandbox-aware), not the host-only barrel `bash`.
// Best-effort live usage accounting: on a wall-clock timeout the runner SIGTERMs mid-invoke so the
// final envelope never runs; we accumulate usage from the model metadata events and flush a partial
// envelope from the signal handler. Counters at module scope so they survive invoke retries and the handler.
let partialTokensIn = 0;
let partialTokensOut = 0;
let partialCycles = 0;

// Fresh agent per invoke attempt (mirrors the judge): a mid-stream failure can leave a half-built
// conversation, so each attempt gets a clean agent. The token hook is re-attached every build.
function makeBuilderAgent(): Agent {
	const agent = new Agent({
		model: new BedrockModel({
			modelId: MODEL_ID,
			region: process.env.AWS_REGION ?? 'us-east-1',
			...(MODEL_ACCEPTS_TEMPERATURE ? { temperature: 0 } : {}),
			// AWS-SDK-layer adaptive retry — the lower half of the two-layer throttle defense (the
			// app-level loop around invoke() is the upper half); often absorbs a TPM throttle inside invoke.
			clientConfig: { maxAttempts: 8, retryMode: 'adaptive' },
		}),
		systemPrompt: builderSystem(WORKSPACE),
		sandbox: new WorkspaceSandbox(WORKSPACE, BASH_MIN_TIMEOUT_SEC, ISOLATE),
		tools: [makeBash(), fileEditor],
	});
	agent.addHook(ModelStreamUpdateEvent, (event) => {
		const inner = event.event;
		if (inner.type === 'modelMetadataEvent' && inner.usage) {
			partialTokensIn += inner.usage.inputTokens ?? 0;
			partialTokensOut += inner.usage.outputTokens ?? 0;
			partialCycles += 1;
			// Checkpoint the moment usage advances, so an UNGRACEFUL kill (a pkill storm tearing down
			// this harness before the SIGTERM flush) still leaves nonzero tokens + partial cycles on OUTPUT.
			writeCheckpoint();
		}
	});
	return agent;
}

const started = Date.now();
let finished = false;

// Persist a running checkpoint of accumulated spend to OUTPUT (atomically) so an UNGRACEFUL kill
// still leaves nonzero tokens/cycles on disk. Skipped once `finished` is set: the terminal exit paths
// then own the envelope and overwrite this with a terminal stop_reason. Best-effort.
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

// Flush a best-effort partial envelope if the runner kills us: SIGTERM on the wall-clock timeout,
// SIGINT on a cancellation. writeFileSync + exit run synchronously before the SIGKILL grace elapses.
function writePartialEnvelopeAndExit(signal: string): void {
	if (finished) return;
	finished = true;
	// Label by signal so a cancellation isn't mislabeled a timeout. This GRACEFUL terminal stop_reason
	// (and the absence of the checkpoint flag) is what keeps a genuine timeout as agent_fail (INCLUDED).
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
		// Envelope lost — surface the spend in one parseable marker so tokens/cycles stay recoverable from logs.
		process.stderr.write(
			`[bench] partial-spend tokens_in=${partialTokensIn} tokens_out=${partialTokensOut} cycles=${partialCycles}\n`,
		);
	}
	// No trace on the timeout path: the Strands trace/metrics only exist once invoke() RETURNS and the
	// SDK exposes no mid-run accessor, so a timed-out cell emits only this partial envelope.
	// Exit 124 = clean timeout with the envelope flushed; 125 = the envelope write itself failed.
	process.exit(wrote ? 124 : 125);
}
process.on('SIGTERM', () => writePartialEnvelopeAndExit('SIGTERM'));
process.on('SIGINT', () => writePartialEnvelopeAndExit('SIGINT'));

// Startup stagger: spread each wave's FIRST Bedrock call so N cells don't all hit invoke at once and
// trip the account TPM ceiling (the burst that failed 6/10 cells in run 28967475174). Keyed to the
// matrix job index for a deterministic fan-out, staggering by within-wave slot (index % waveSize) so
// the delay stays bounded (~0–28s at STEP=7). Wave size unset (local) ⇒ no wrap; slot 0 ⇒ no delay.
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

// App-level throttle-retry around invoke() — the upper half of the two-layer defense. Only
// throttle/transient failures retry (isRetryableModelError); backoff mirrors the judge. The SIGTERM
// handler stays armed throughout so a cancellation during a backoff sleep still flushes the envelope.
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
	// Sentinel envelope so the judge has something to read; uses the best-effort usage so far, not zeros.
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

// Persist the trace tree + run metrics as SEPARATE artifacts. NEVER serialize `result` directly:
// AgentResult.toJSON() strips traces/metrics, so access the properties (traces need per-item toJSON()).
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

// Explicit success exit: everything is written above. Without this, a stray handle the agent left
// open (e.g. an escaped backgrounded dev server) would idle the step until the 35-min SIGKILL,
// falsely recorded as a timeout. Exiting guarantees prompt teardown.
process.exit(0);

function messageText(msg: import('@strands-agents/sdk').Message | undefined): string {
	if (!msg) return '';
	return msg.content
		.map((b) => ('text' in b && typeof b.text === 'string' ? b.text : ''))
		.filter(Boolean)
		.join('\n');
}
