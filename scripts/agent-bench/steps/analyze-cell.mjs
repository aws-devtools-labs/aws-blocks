// Per-cell analysis: runs INSIDE each matrix cell right after the judge, colocated with that cell's
// fresh trace/metrics. Reads this cell's result.json + trace.json + metrics.json, asks the judge model
// (Opus 4.8) for a concise analysis, and writes it back as `analysis` + `analysis_issues[]`
// (analyze.mjs rolls these up later). Additive & isolated: wrapped so it can NEVER throw (always exits
// 0), only ADDS those two fields, and falls back to a benign string on any error. Runs under bare
// `node`: Node built-ins + AWS CLI via lib/analysis.mjs, no SDK.
import { readFileSync, writeFileSync } from 'node:fs';
import { CELL_MAX_TOKENS, CELL_SYSTEM, DEFAULT_MODEL_ID, FALLBACK_ANALYSIS, bedrockConverse, buildCellUserText, parseCellAnalysis } from './lib/analysis.mjs';

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

// Decide the per-cell analysis — never throws. Only calls Bedrock when there's data; a failure with
// no trace gets a benign note and no model call.
function analyze(result, trace, metrics) {
	const klass = result?.klass ?? null;
	if (klass === 'harness_error') {
		return { analysis: 'Cell failed before producing a gradeable app (harness error) — no agent trace to analyze.', issues: [] };
	}
	if (!trace && !metrics) {
		return {
			analysis:
				klass === 'agent_fail'
					? 'Agent timed out / produced no app within budget — no trace was emitted, so there is nothing to analyze.'
					: 'No trace/metrics artifact available for this cell — nothing to analyze.',
			issues: [],
		};
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
	if (error) return { analysis: `${FALLBACK_ANALYSIS}: ${error}`, issues: [] };
	const parsed = parseCellAnalysis(text);
	return { analysis: parsed.analysis || FALLBACK_ANALYSIS, issues: parsed.issues };
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
	let issues = [];
	try {
		const out = analyze(result, trace, metrics);
		analysis = out.analysis;
		issues = Array.isArray(out.issues) ? out.issues : [];
	} catch (err) {
		analysis = `${FALLBACK_ANALYSIS}: ${err?.message ?? err}`;
	}

	// Add ONLY the analysis fields — never touch score/verdict/klass/etc.
	result.analysis = analysis;
	result.analysis_issues = issues;
	try {
		writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
		process.stderr.write(`[analyze-cell] wrote analysis (${analysis.length} chars, ${issues.length} issue(s)) to ${RESULT_PATH}\n`);
	} catch (err) {
		process.stderr.write(`[analyze-cell] failed to write analysis to ${RESULT_PATH} (ignored): ${err?.message ?? err}\n`);
	}
}

// TOP-LEVEL ISOLATION: never throw, never non-zero — must not block the result upload or red the cell.
try {
	main();
} catch (err) {
	process.stderr.write(`[analyze-cell] best-effort analysis failed (ignored): ${err?.stack ?? err?.message ?? err}\n`);
}
process.exit(0);
