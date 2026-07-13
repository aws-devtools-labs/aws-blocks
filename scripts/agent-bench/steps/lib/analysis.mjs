// Shared helpers for the agent-bench analysis feature, generated bottom-up in two places: PER-CELL
// (analyze-cell.mjs, right after each judge, writes an `analysis` string into result.json) and
// TOP-LEVEL ROLL-UP (analyze.mjs, synthesizes an exec summary over those). Both are LLM-driven
// (Bedrock Opus 4.8) and BEST-EFFORT — callers wrap everything so a failure never fails a cell/job or
// touches the score. Bedrock via `aws bedrock-runtime converse` (CLI, no SDK) so both run under bare
// `node`. Everything except bedrockConverse/sleepSync is pure and unit-tested in analysis.test.mjs.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Judge model, reused for analysis (Opus 4.8 for both per-cell + synthesis). Same id as 4-judge.ts.
export const DEFAULT_MODEL_ID = 'us.anthropic.claude-opus-4-8';

// Keep the model INPUT small (cost + latency). Caps on each slice of the trace.
export const MAX_TOOL_NAMES = 40;
export const MAX_ERROR_LINES = 40;
export const MAX_ERROR_LINE_LEN = 200;
export const MAX_TAIL_CHARS = 1500;
// The judge explanation grounds "what the agent built"; trim it hard so it can't dominate the prompt.
export const MAX_JUDGE_EXPLANATION_CHARS = 500;

// Small output budgets: per-cell = 2-4 sentences + short issue list, rollup = paragraph + bullets.
export const CELL_MAX_TOKENS = 420;
export const ROLLUP_MAX_TOKENS = 700;

// Caps on the per-cell POTENTIAL ISSUES so one cell can't flood the report section.
export const MAX_CELL_ISSUES = 5;
export const MAX_ISSUE_LEN = 200;

// Composite < LOW is "low"; a drop worse than REGRESSION_DELTA vs baseline is a "regression" (the same
// ±5 band the overview uses). Only FLAGS cells for the rollup, never gates a Bedrock call.
export const LOW_THRESHOLD = 50;
export const REGRESSION_DELTA = -5;

// Benign fallback stored when the per-cell analysis can't be produced.
export const FALLBACK_ANALYSIS = 'analysis unavailable';

// App-level throttle/transient retry (initial + up to 4 backoffs) for the post-run ANALYSIS
// model calls. TRANSIENT_RE is a deliberately BROAD text heuristic matched against stringified
// error output (bare `timeout`, `500`, `503`, etc.) — it is NOT the same classifier as
// bedrock-retry.mjs's `isRetryableModelError`, which inspects typed SDK error classes and now
// short-circuits terminal 4xx. These serve different layers (log-text scan vs SDK error object)
// and intentionally diverge; do not try to keep them identical.
const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [5_000, 15_000, 40_000, 90_000];
const TRANSIENT_RE =
	/throttl|toomanyrequests|too many (tokens|requests)|serviceunavailable|service_unavailable|internalserver|internalfailure|modelstream|modeltimeout|requesttimeout|timeout|partialresult|503|429|500/i;

// Per-cell analysis system prompt: what the agent built + score context + STRUGGLES visible in the
// data (not a task restatement or code re-grade). Emits a strict two-part format parseCellAnalysis reads.
export const CELL_SYSTEM = `You are analyzing ONE benchmark cell where an AI coding agent built an app from a task prompt. Using the score context, the metrics, and the trimmed tool-call trace provided, respond in EXACTLY this two-part format and nothing else:

ANALYSIS: <2-4 sentences: (1) one short clause on WHAT the agent built and its score context; (2) any STRUGGLES visible in the data — failed or errored tool calls (name the tool and the error), time hunting for missing/undocumented APIs, non-inherent trial-and-error such as dev-server wrangling or build-error loops, or disproportionate token/turn cost. Cite concrete tool names or short error snippets. Do NOT restate the task, propose fixes, or re-grade the code. If the trace shows a clean run, say so.>
ISSUES:
- <one concise potential issue worth a maintainer's attention (a recurring failure mode, a missing doc/API, a cost/efficiency concern), max ~15 words>
- <another, if any>

List at most a few issues, most-important first. If there are no notable issues, write exactly "ISSUES: none".`;

// Top-level roll-up system prompt: synthesize the per-cell analyses into a SHORT executive summary.
export const ROLLUP_SYSTEM = `You are writing the EXECUTIVE SUMMARY of an AI coding-agent benchmark run, synthesizing BOTTOM-UP from the PER-CELL analyses provided (each already diagnoses one cell). Format your answer as:
- FIRST, a SHORT lead paragraph (2-3 sentences): the overall outcome — the mean composite and the pass/partial/fail mix — and the single most important takeaway.
- THEN 3-6 concise bullet points (start each line with "- "): CROSS-CELL patterns recurring across multiple cells (dev-server wrangling, shared build friction, missing-docs hunting, repeated failed tool calls), which cells regressed or are low and the likely why, and the obvious areas to improve.
Be concrete and cite cells by name. Do NOT restate the task list or write detailed code fixes — surface patterns and problem areas. Keep it tight.`;

export const fmt = (n) => (n === null || n === undefined || Number.isNaN(n) ? '—' : Number(n).toFixed(1));

/** Collapse whitespace to a single line. Safe on non-strings (→ ''). */
export function oneLine(text) {
	return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Parse the per-cell model output (strict `ANALYSIS: … ISSUES: …` from {@link CELL_SYSTEM}) into a
 * one-line analysis + bounded issue list. Robust to a missing/`none` ISSUES section and to a plain
 * fallback with no labels (whole thing becomes the analysis). Never throws.
 * @param {unknown} text raw model completion (or a fallback sentence)
 * @returns {{analysis: string, issues: string[]}}
 */
export function parseCellAnalysis(text) {
	if (typeof text !== 'string') return { analysis: '', issues: [] };
	// Split on the FIRST "ISSUES:" section header (line-anchored, case-insensitive).
	const m = text.match(/(^|\n)\s*ISSUES:\s*/i);
	let analysisPart = text;
	let issuesPart = '';
	if (m) {
		analysisPart = text.slice(0, m.index);
		issuesPart = text.slice(m.index + m[0].length);
	}
	const analysis = oneLine(analysisPart.replace(/^\s*ANALYSIS:\s*/i, ''));
	let issues = [];
	const trimmed = issuesPart.trim();
	if (trimmed && !/^none\b/i.test(trimmed)) {
		issues = trimmed
			.split('\n')
			.map((l) => oneLine(l.replace(/^\s*[-*•]\s*/, '')))
			.filter((l) => l.length > 0 && !/^none$/i.test(l))
			.slice(0, MAX_CELL_ISSUES)
			.map((l) => l.slice(0, MAX_ISSUE_LEN));
	}
	return { analysis, issues };
}

// Error-like lines to lift out of the trace for the model.
const ERROR_LINE_RE =
	/(error|failed|failure|denied|exception|timed?\s?out|timeout|not found|no such|cannot|refused|traceback|non-zero|exit code|enoent|econnreset)/i;

/**
 * Trim a trace into a small, model-friendly slice: distinct tool/span names,
 * error-like lines, and the tail — never the whole tree. Works on the normalized
 * (2-space) JSON string so it is line-oriented regardless of trace schema.
 * @param {unknown} trace parsed trace.json (any shape) or null
 * @returns {{toolNames: string[], errorLines: string[], tail: string}}
 */
export function trimTrace(trace) {
	if (trace === null || trace === undefined) return { toolNames: [], errorLines: [], tail: '' };
	let str;
	try {
		str = JSON.stringify(trace, null, 2);
	} catch {
		return { toolNames: [], errorLines: [], tail: '' };
	}
	if (typeof str !== 'string') return { toolNames: [], errorLines: [], tail: '' };
	const lines = str.split('\n');
	const names = new Set();
	const errorLines = [];
	for (const line of lines) {
		const m = line.match(/"name":\s*"([^"]+)"/);
		if (m && names.size < MAX_TOOL_NAMES) names.add(m[1]);
		if (errorLines.length < MAX_ERROR_LINES && ERROR_LINE_RE.test(line)) {
			errorLines.push(line.trim().slice(0, MAX_ERROR_LINE_LEN));
		}
	}
	return { toolNames: [...names], errorLines, tail: str.slice(-MAX_TAIL_CHARS) };
}

/**
 * Compact metrics summary: cycles, tokens, per-tool call/error counts. Defensive about the exact
 * toolUsage/toolMetrics shape.
 * @param {unknown} metrics parsed metrics.json (result.metrics) or null
 * @returns {string}
 */
export function summarizeMetrics(metrics) {
	if (!metrics || typeof metrics !== 'object') return '(no metrics)';
	const parts = [];
	if (typeof metrics.cycleCount === 'number') parts.push(`cycles=${metrics.cycleCount}`);
	const usage = metrics.accumulatedUsage;
	if (usage && typeof usage === 'object') {
		parts.push(`tokens_in=${usage.inputTokens ?? '?'}`, `tokens_out=${usage.outputTokens ?? '?'}`);
	}
	// Strands names this `toolUsage`; accept `toolMetrics` too (defensive).
	const tu = metrics.toolUsage ?? metrics.toolMetrics;
	if (tu && typeof tu === 'object') {
		const rows = [];
		for (const [name, v] of Object.entries(tu)) {
			if (!v || typeof v !== 'object') continue;
			const calls = v.callCount ?? v.calls ?? v.executionCount ?? v.count;
			const errors = v.errorCount ?? v.failedCount ?? v.errors ?? v.failures;
			const rate = typeof v.successRate === 'number' ? `${Math.round(v.successRate * 100)}%ok` : null;
			const time = typeof v.totalTime === 'number' ? `${Math.round(v.totalTime)}ms` : null;
			const bits = [
				calls !== undefined ? `calls=${calls}` : '',
				errors !== undefined ? `errors=${errors}` : '',
				rate,
				time,
			]
				.filter(Boolean)
				.join(',');
			rows.push(bits ? `${name}(${bits})` : name);
		}
		if (rows.length) parts.push(`tools: ${rows.join(' ')}`);
	}
	return parts.length ? parts.join(' ') : '(metrics present, no recognizable fields)';
}

/**
 * Build the per-cell analysis prompt user text from a cell's own data. Pure.
 * @param {{task?: string, template?: string, composite?: number|null, verdict?: string,
 *   judgeScore?: number|null, judgeExplanation?: string, klass?: string|null,
 *   metrics?: unknown, trace?: unknown}} input
 * @returns {string}
 */
export function buildCellUserText(input) {
	const task = input.task ?? '—';
	const template = input.template ?? '—';
	const { toolNames, errorLines, tail } = input.trace
		? trimTrace(input.trace)
		: { toolNames: [], errorLines: [], tail: '' };
	const scoreCtx = [
		typeof input.composite === 'number' ? `composite ${fmt(input.composite)}/100` : null,
		input.verdict ? `verdict ${input.verdict}` : null,
		typeof input.judgeScore === 'number' ? `judge ${input.judgeScore}/10` : null,
		input.klass ? `klass ${input.klass}` : null,
	]
		.filter(Boolean)
		.join(', ');
	const explanation = oneLine(input.judgeExplanation).slice(0, MAX_JUDGE_EXPLANATION_CHARS);
	return [
		`Cell: ${task}/${template}`,
		`Score context: ${scoreCtx || '(none)'}`,
		explanation ? `Judge notes (what was built): ${explanation}` : 'Judge notes: (none)',
		`Metrics: ${summarizeMetrics(input.metrics)}`,
		`Tool/span names seen: ${toolNames.length ? toolNames.join(', ') : '(none captured)'}`,
		'Error-like lines from trace:',
		errorLines.length ? errorLines.join('\n') : '(none)',
		'Trace tail:',
		tail || '(no trace tail)',
	].join('\n');
}

/**
 * Build the top-level roll-up prompt from the collected per-cell analyses +
 * aggregate. Pure. `cells` rows carry the per-cell `analysis` string plus the
 * low/regressed flags computed from the baseline diff.
 * @param {{meanComposite?: number|null, scoredCount?: number, verdictCounts?: Record<string, number>,
 *   cells: Array<{task?: string, template?: string, composite?: number|null, verdict?: string,
 *     delta?: number|null, low?: boolean, regressed?: boolean, analysis?: string}>}} input
 * @returns {string}
 */
export function buildRollupUserText(input) {
	const verdictCounts = input.verdictCounts ?? {};
	const verdictLine =
		Object.entries(verdictCounts)
			.filter(([, n]) => n > 0)
			.map(([k, n]) => `${n} ${k}`)
			.join(', ') || '(none)';
	const cellLines = (input.cells ?? []).map((c) => {
		const flags = [c.low ? 'LOW' : '', c.regressed ? `REGRESSED Δ${fmt(c.delta)}` : '']
			.filter(Boolean)
			.join(' ');
		const head = `${c.task ?? '—'}/${c.template ?? '—'} — composite ${fmt(c.composite)} (${c.verdict ?? '—'})${flags ? ` [${flags}]` : ''}`;
		return `- ${head}: ${oneLine(c.analysis) || '(no per-cell analysis)'}`;
	});
	const low = (input.cells ?? []).filter((c) => c.low).map((c) => `${c.task}/${c.template}`);
	const regressed = (input.cells ?? []).filter((c) => c.regressed).map((c) => `${c.task}/${c.template}`);
	return [
		`Run: mean composite ${fmt(input.meanComposite)}/100 over ${input.scoredCount ?? 0} scored cell(s). Verdicts: ${verdictLine}.`,
		'',
		'Per-cell analyses (already diagnosed bottom-up — synthesize across them):',
		...(cellLines.length ? cellLines : ['(no per-cell analyses available)']),
		'',
		`Cells flagged low (< ${LOW_THRESHOLD}): ${low.length ? low.join(', ') : '(none)'}`,
		`Cells flagged regressed (Δ < ${REGRESSION_DELTA} vs baseline): ${regressed.length ? regressed.join(', ') : '(none)'}`,
	].join('\n');
}

// Block synchronously between retries (bare-node, no async loop to yield to).
function sleepSync(ms) {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms | 0));
	} catch {
		// SharedArrayBuffer unavailable — skip the backoff wait rather than fail.
	}
}

/**
 * One Bedrock Converse call via the AWS CLI. Returns { text } or { error } — never throws. Uses
 * --cli-input-json so trace text can't break shell quoting. Retries only on a transient class.
 * @param {{system: string, userText: string, modelId?: string, region?: string, maxTokens?: number}} args
 * @returns {{text: string}|{error: string}}
 */
export function bedrockConverse(args) {
	const modelId = args.modelId ?? DEFAULT_MODEL_ID;
	const region = args.region ?? process.env.AWS_REGION ?? 'us-east-1';
	const maxTokens = args.maxTokens ?? CELL_MAX_TOKENS;
	let tmpDir;
	try {
		tmpDir = mkdtempSync(join(tmpdir(), 'bench-analysis-'));
	} catch (err) {
		return { error: `tmp dir failed: ${err?.message ?? err}` };
	}
	const inputPath = join(tmpDir, 'converse.json');
	try {
		try {
			writeFileSync(
				inputPath,
				JSON.stringify({
					modelId,
					system: [{ text: args.system }],
					messages: [{ role: 'user', content: [{ text: args.userText }] }],
					// No temperature — Opus 4.8 rejects it and best-effort analysis needs no determinism.
					inferenceConfig: { maxTokens },
				}),
			);
		} catch (err) {
			return { error: `write input failed: ${err?.message ?? err}` };
		}

		let lastErr = 'unknown error';
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			const res = spawnSync(
				'aws',
				['bedrock-runtime', 'converse', '--cli-input-json', `file://${inputPath}`, '--region', region, '--output', 'json'],
				{
					encoding: 'utf-8',
					timeout: 120_000,
					maxBuffer: 8 * 1024 * 1024,
					// AWS-CLI-layer adaptive retry (the CLI analog of the SDK's adaptive retryMode);
					// absorbs a transient throttle within one converse call before the app loop.
					env: { ...process.env, AWS_RETRY_MODE: 'adaptive', AWS_MAX_ATTEMPTS: '8' },
				},
			);
			if (res.status === 0 && res.stdout) {
				try {
					const parsed = JSON.parse(res.stdout);
					const text = (parsed?.output?.message?.content ?? [])
						.map((b) => (b && typeof b.text === 'string' ? b.text : ''))
						.filter(Boolean)
						.join('\n')
						.trim();
					if (text) return { text };
					lastErr = 'empty completion';
				} catch (err) {
					lastErr = `unparseable response: ${err?.message ?? err}`;
				}
			} else {
				const raw = (res.stderr || res.error?.message || `exit ${res.status}`).toString().trim();
				lastErr = raw.split('\n').slice(-3).join(' ').slice(0, 300);
			}
			if (!TRANSIENT_RE.test(lastErr) || attempt >= MAX_ATTEMPTS) break;
			const base = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
			sleepSync(base + Math.floor(Math.random() * base * 0.25));
		}
		return { error: lastErr };
	} finally {
		// Best-effort cleanup of the per-call tmp dir — never mask the result.
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
}
