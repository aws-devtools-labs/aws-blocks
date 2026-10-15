// Per-cell analysis: runs INSIDE each matrix cell right after the judge, colocated with that cell's
// fresh trace/metrics. Reads this cell's result.json + trace.json + metrics.json, asks the judge model
// (Opus 4.8) for a concise analysis, and writes it back as `analysis` + `analysis_issues[]`
// (analyze.mjs rolls these up later). For cells that actually FAILED (see isFailureCell) it then runs
// a second, DEEPER pass that ingests the quoted failing-test output + dev/build log tails and writes a
// structured `failure_analysis` root cause. Additive & isolated: wrapped so it can NEVER throw (always
// exits 0), only ADDS those fields, and falls back to a benign string on any error. Runs under bare
// `node`: Node built-ins + AWS CLI via lib/analysis.mjs, no SDK.
import { readFileSync, writeFileSync } from 'node:fs';
import {
	CELL_MAX_TOKENS,
	CELL_SYSTEM,
	DEFAULT_MODEL_ID,
	FALLBACK_ANALYSIS,
	FAILURE_MAX_TOKENS,
	FAILURE_SYSTEM,
	bedrockConverse,
	buildCellUserText,
	buildFailureUserText,
	deterministicCellAnalysis,
	extractFailingTests,
	isFailureCell,
	parseCellAnalysis,
	parseFailureAnalysis,
	redactSecrets,
	trimTrace,
	truthy,
} from './lib/analysis.mjs';

const RESULT_PATH = process.env.RESULT_PATH ?? '/tmp/result.json';
const TRACE_PATH = process.env.TRACE ?? '/tmp/trace.json';
const METRICS_PATH = process.env.METRICS ?? '/tmp/metrics.json';
// Deep-failure evidence, staged to STABLE paths by 3-build-and-test.sh (its own CELL_TMP uses $$ and is
// gone by the time this step runs). Missing files degrade to null — the deep pass simply has less data.
const PW_RESULTS_PATH = process.env.PW_RESULTS ?? '/tmp/pw-results.json';
const DEV_LOG_PATH = process.env.DEV_LOG ?? '/tmp/dev.log';
const BUILD_LOG_PATH = process.env.BUILD_LOG ?? '/tmp/build.log';
const MODEL_ID = process.env.BENCH_JUDGE_MODEL ?? DEFAULT_MODEL_ID;
const REGION = process.env.AWS_REGION ?? 'us-east-1';

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf-8'));
	} catch {
		return null;
	}
}

function readText(path) {
	try {
		return readFileSync(path, 'utf-8');
	} catch {
		return '';
	}
}

// Decide the per-cell analysis — never throws. A harness_error, or ANY cell with no agent trace, gets a
// deterministic note and NO model call (without a trace an ungrounded model would confabulate a root
// cause/owner from stray metrics — see deterministicCellAnalysis); only a traced cell is sent to Bedrock.
function analyze(result, trace, metrics) {
	const deterministic = deterministicCellAnalysis(result, trace);
	if (deterministic) return deterministic;

	const klass = result?.klass ?? null;

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

// Deeper, structured root-cause pass — ONLY for failing cells. Reads the quoted failing tests + dev/
// build log tails and asks the model for strict JSON. Returns a normalized object or null (no usable
// diagnosis / model error / no evidence). Never throws — the caller also guards it.
function analyzeFailure(result, trace) {
	const failingTests = extractFailingTests(readJson(PW_RESULTS_PATH));
	const buildFailed = result?.build_succeeded != null && !truthy(result.build_succeeded);
	// If there's genuinely nothing to look at (no failing tests, no logs), skip the model call.
	// Scrub any credential material the dev/build logs may have echoed before it reaches the model.
	const devLogTail = redactSecrets(readText(DEV_LOG_PATH));
	const buildLogTail = buildFailed ? redactSecrets(readText(BUILD_LOG_PATH)) : '';
	if (failingTests.totalFailing === 0 && !devLogTail && !buildLogTail) return null;

	const userText = buildFailureUserText({
		task: result?.task,
		template: result?.template,
		verdict: result?.verdict,
		klass: result?.klass ?? null,
		testsFailed: typeof result?.tests_failed === 'number' ? result.tests_failed : null,
		testsTotal: typeof result?.tests_total === 'number' ? result.tests_total : null,
		buildSucceeded: result?.build_succeeded == null ? null : truthy(result.build_succeeded),
		devServerStarted: result?.dev_server_started == null ? null : truthy(result.dev_server_started),
		judgeExplanation: result?.judge_explanation,
		failingTests,
		devLogTail,
		buildLogTail,
		traceTail: trace ? trimTrace(trace).tail : '',
	});
	const { text, error } = bedrockConverse({
		system: FAILURE_SYSTEM,
		userText,
		modelId: MODEL_ID,
		region: REGION,
		maxTokens: FAILURE_MAX_TOKENS,
	});
	if (error) return null;
	return parseFailureAnalysis(text);
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

	// Deeper root-cause pass for failing cells only — passing/partial-clean cells stay on the cheap
	// path above (no extra model call). Fully guarded: any error → no failure_analysis, cell unaffected.
	if (isFailureCell(result)) {
		try {
			const fa = analyzeFailure(result, trace);
			if (fa) {
				result.failure_analysis = fa;
				process.stderr.write(`[analyze-cell] deep failure analysis: category=${fa.category ?? '?'} owner=${fa.owner ?? '?'}\n`);
			} else {
				process.stderr.write('[analyze-cell] deep failure analysis produced no usable diagnosis (skipped/ignored)\n');
			}
		} catch (err) {
			process.stderr.write(`[analyze-cell] deep failure analysis failed (ignored): ${err?.message ?? err}\n`);
		}
	}

	try {
		writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
		process.stderr.write(`[analyze-cell] wrote analysis (${analysis.length} chars, ${issues.length} issue(s)${result.failure_analysis ? ', +failure_analysis' : ''}) to ${RESULT_PATH}\n`);
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
