// Per-cell analysis: runs INSIDE each matrix cell right after the judge +
// finalize, colocated with that cell's fresh trace/metrics. It reads THIS cell's
// result.json (score context stamped by the judge + finalize), trace.json and
// metrics.json (both written locally by step 2 at /tmp), asks the judge Bedrock
// model (Opus 4.8) for a CONCISE 2-4 sentence analysis of what the agent built +
// any struggles visible in the data, and writes that back into result.json as an
// `analysis` string. The top-level summary job later ROLLS UP these per-cell
// analyses (steps/analyze.mjs) — it no longer re-reads raw traces centrally.
//
// ISOLATION CONTRACT — purely additive, must NEVER affect the green-regardless
// bench:
//   - The whole run is wrapped so it can NEVER throw; it always exits 0.
//   - It only ADDS the `analysis` field — it never touches the score, verdict,
//     klass, or any other field finalize-result stamped.
//   - No trace/metrics, a harness/agent failure, or any Bedrock error → it
//     writes a benign fallback string and still exits 0 (never blocks upload).
// Runs under bare `node` in the cell (which DID `npm ci`, but this uses only
// Node built-ins + the runner's AWS CLI via lib/analysis.mjs — no SDK import).
import { readFileSync, writeFileSync } from 'node:fs';
import { CELL_MAX_TOKENS, CELL_SYSTEM, DEFAULT_MODEL_ID, FALLBACK_ANALYSIS, bedrockConverse, buildCellUserText, oneLine } from './lib/analysis.mjs';

const RESULT_PATH = process.env.RESULT_PATH ?? '/tmp/result.json';
const TRACE_PATH = process.env.TRACE ?? '/tmp/trace.json';
const METRICS_PATH = process.env.METRICS ?? '/tmp/metrics.json';
const MODEL_ID = process.env.BENCH_JUDGE_MODEL ?? DEFAULT_MODEL_ID;
const REGION = process.env.AWS_REGION ?? 'us-east-1';

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf-8'));
	} catch {
		return null;
	}
}

// Decide the per-cell analysis text. Returns a string — never throws. Only calls
// Bedrock when there is actual data to analyze; a harness/agent failure with no
// trace gets a benign, self-describing note without spending a model call.
function analyze(result, trace, metrics) {
	const klass = result?.klass ?? null;
	if (klass === 'harness_error') {
		return 'Cell failed before producing a gradeable app (harness error) — no agent trace to analyze.';
	}
	if (!trace && !metrics) {
		return klass === 'agent_fail'
			? 'Agent timed out / produced no app within budget — no trace was emitted, so there is nothing to analyze.'
			: 'No trace/metrics artifact available for this cell — nothing to analyze.';
	}

	const userText = buildCellUserText({
		task: result?.task,
		template: result?.template,
		composite: typeof result?.composite === 'number' ? result.composite : null,
		verdict: result?.verdict,
		judgeScore: typeof result?.judge_score === 'number' ? result.judge_score : null,
		judgeExplanation: result?.judge_explanation,
		klass,
		metrics,
		trace,
	});
	const { text, error } = bedrockConverse({
		system: CELL_SYSTEM,
		userText,
		modelId: MODEL_ID,
		region: REGION,
		maxTokens: CELL_MAX_TOKENS,
	});
	if (error) return `${FALLBACK_ANALYSIS}: ${error}`;
	return oneLine(text) || FALLBACK_ANALYSIS;
}

function main() {
	const result = readJson(RESULT_PATH);
	if (!result || typeof result !== 'object') {
		// No readable result.json to attach the analysis to — nothing to do.
		process.stderr.write(`[analyze-cell] no readable result at ${RESULT_PATH}; skipping\n`);
		return;
	}
	const trace = readJson(TRACE_PATH);
	const metrics = readJson(METRICS_PATH);

	let analysis;
	try {
		analysis = analyze(result, trace, metrics);
	} catch (err) {
		analysis = `${FALLBACK_ANALYSIS}: ${err?.message ?? err}`;
	}

	// Add ONLY the analysis field — never touch score/verdict/klass/etc.
	result.analysis = analysis;
	try {
		writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
		process.stderr.write(`[analyze-cell] wrote analysis (${analysis.length} chars) to ${RESULT_PATH}\n`);
	} catch (err) {
		process.stderr.write(`[analyze-cell] failed to write analysis to ${RESULT_PATH} (ignored): ${err?.message ?? err}\n`);
	}
}

// TOP-LEVEL ISOLATION: never throw, never non-zero. A per-cell analysis failure
// must never block the cell's result upload or turn the cell red.
try {
	main();
} catch (err) {
	process.stderr.write(`[analyze-cell] best-effort analysis failed (ignored): ${err?.stack ?? err?.message ?? err}\n`);
}
process.exit(0);
