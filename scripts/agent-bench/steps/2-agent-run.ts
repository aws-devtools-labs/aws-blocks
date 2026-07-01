/**
 * Builder step: ask the agent to implement the task in $WORKSPACE.
 *
 * Inputs (env):
 *   WORKSPACE        absolute path to the scaffolded bench-app
 *   TASK_PROMPT      path to PROMPT.md
 *   OUTPUT           path to write the builder envelope JSON
 *   BENCH_MODEL      Bedrock model ID (default: us.anthropic.claude-sonnet-4-6)
 *   TRACE            (optional) path to write the full hierarchical tool-call
 *                    trace tree; on a wall-clock timeout a lightweight transcript
 *                    fallback is flushed here instead
 *   METRICS          (optional) path to write the run metrics (cycleCount,
 *                    totalDuration, accumulatedUsage, per-tool toolUsage, …)
 *
 * Tools: a single `shell` running bash inside WORKSPACE. The runner is the
 * sandbox; no extra isolation needed for our PR-CI threat model.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { Agent, BedrockModel, MessageAddedEvent, ModelStreamUpdateEvent, tool } from '@strands-agents/sdk';
import { z } from 'zod';
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

const taskPrompt = readFileSync(TASK_PROMPT_PATH, 'utf-8');

const shell = tool({
	name: 'shell',
	description: `Run a bash command. Working directory is the bench-app root (${WORKSPACE}). State persists between calls. Use this for everything: reading files, editing files (with sed/heredoc), running curl, running npm. Long-running commands (npm install, npm run build) can take minutes; stdout/stderr are captured and returned along with the exit code.`,
	inputSchema: z.object({ command: z.string().describe('Bash command to run') }),
	callback: async ({ command }) => {
		const r = spawnSync('bash', ['-lc', command], {
			cwd: WORKSPACE,
			encoding: 'utf-8',
			maxBuffer: 8 * 1024 * 1024,
			timeout: 600_000,
		});
		const stdout = (r.stdout ?? '').slice(-50_000);
		const stderr = (r.stderr ?? '').slice(-10_000);
		return `exit=${r.status ?? 'killed'}\n${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ''}`;
	},
});

// INTENTIONALLY MINIMAL: a single-tool (`shell`) agent, no planner, no
// sub-agents, no retrieval, no bespoke scaffolding. This is a deliberate design
// choice, not an unfinished one — DO NOT "helpfully" swap in a richer agent:
//   - Stable measurement surface: the bench measures how the FRAMEWORK (the
//     scaffold + Building Blocks + docs) shapes an agent's output. A fixed,
//     minimal agent keeps that surface constant so a score delta is
//     deterministically attributable to a framework change, not to agent tweaks.
//   - Accounting control: token usage (the ModelStreamUpdateEvent hook) and the
//     SIGTERM wall-clock-timeout envelope flush both need direct, in-process
//     control of the loop — a higher-level "helpful" agent abstraction would hide
//     the model-metadata events and the invoke lifecycle we depend on here.
//   - Reproducibility: a pinned model + temperature 0 + a hard MAX_TURNS bound is
//     what makes a run repeatable; extra tools/heuristics reintroduce variance.
const agent = new Agent({
	model: new BedrockModel({
		modelId: MODEL_ID,
		region: process.env.AWS_REGION ?? 'us-east-1',
		temperature: 0,
	}),
	systemPrompt: builderSystem(),
	tools: [shell],
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

// TIMEOUT-SAFE trace fallback. The full hierarchical trace tree (result.traces,
// written below) only exists once agent.invoke() RETURNS — but a wall-clock
// timeout SIGTERMs us mid-invoke, so a timed-out cell would otherwise produce NO
// trace at all. Mirroring the token hook above, accumulate a lightweight
// transcript of every message the agent loop adds (the user prompt, each
// assistant turn, and tool-result messages) as it happens, so the SIGTERM
// handler can flush this trace-shaped fallback to TRACE_PATH for the timed-out
// cell. On the normal path the real result.traces overwrites it.
const transcript: Array<{ role: string; ts: string; blocks: unknown[] }> = [];
agent.addHook(MessageAddedEvent, (event) => {
	transcript.push({ role: event.message.role, ts: new Date().toISOString(), blocks: summarizeBlocks(event.message) });
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
	// Flush the lightweight transcript as the trace fallback so a timed-out cell
	// still uploads SOMETHING trace-shaped (the real hierarchical result.traces
	// is unavailable — invoke() never returned). Separate try so a trace-write
	// failure never loses the envelope written above.
	if (TRACE_PATH) {
		try {
			writeFileSync(TRACE_PATH, JSON.stringify({ partial: true, reason: signal, messages: transcript }, null, 2));
		} catch (err) {
			process.stderr.write(`[bench] failed to write partial trace on ${signal}: ${describeError(err)}\n`);
		}
	}
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

// Compact per-block summary of a message for the timeout-safe transcript
// fallback: text is truncated, a tool call keeps its name + input keys, a
// tool result keeps its status — enough to reconstruct what happened without
// dragging multi-KB tool stdout into the fallback trace.
function summarizeBlocks(msg: import('@strands-agents/sdk').Message): unknown[] {
	return msg.content.map((b) => {
		if (b.type === 'textBlock') return { type: 'text', text: b.text.slice(0, 2000) };
		if (b.type === 'toolUseBlock')
			return { type: 'toolUse', name: b.name, input: b.input && typeof b.input === 'object' ? Object.keys(b.input) : [] };
		if (b.type === 'toolResultBlock') return { type: 'toolResult', status: b.status };
		return { type: b.type };
	});
}

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
