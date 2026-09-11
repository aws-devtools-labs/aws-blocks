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
import { AGENT_FAIL_AT, AGENT_MAX_TOKENS_REASON, HARNESS_FAIL_REASONS } from './scoring.mjs';

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

// Deterministic per-cell analysis for a cell with NO agent trace (the wall-clock-timeout / ungraceful-
// teardown path emits none). Without a trace the model has nothing to ground "what the agent built /
// where it struggled" on, so it would CONFABULATE a root cause/owner from stray metrics — record an
// explicit "undetermined" note and skip the model call instead. Exported + pure so analyze-cell.mjs and
// the unit test share one source.
export const NO_TRACE_ANALYSIS =
	'No agent trace was emitted (e.g. a wall-clock timeout or ungraceful teardown) — the failure root cause is undetermined; nothing to analyze.';

/**
 * Decide the deterministic (no Bedrock call) per-cell analysis when one applies, else null (→ ask the
 * model). Fires for a harness_error cell (it failed before producing a gradeable app) and for ANY cell
 * with no trace — an ungrounded model would confabulate an owner/category, so we record the
 * {@link NO_TRACE_ANALYSIS} "undetermined" note instead. Pure.
 * @param {{klass?: string|null}} result finalized cell result
 * @param {unknown} trace parsed trace.json (any shape) or null
 * @returns {{analysis: string, issues: string[]}|null} deterministic result, or null to call the model
 */
export function deterministicCellAnalysis(result, trace) {
	const klass = result?.klass ?? null;
	if (klass === 'harness_error') {
		return { analysis: 'Cell failed before producing a gradeable app (harness error) — no agent trace to analyze.', issues: [] };
	}
	if (!trace) {
		return { analysis: NO_TRACE_ANALYSIS, issues: [] };
	}
	return null;
}

/**
 * Was the cell's build / dev-server signal actually OBSERVED, or is it a seeded pessimistic default?
 * 0-init-result.mjs seeds build_succeeded=false / build_status='failed' / dev_server_started=false;
 * when step 3 (build-and-test) is SKIPPED — because the agent step didn't succeed — those seeds are
 * never overwritten, so they are DEFAULTS, not observations. Treat build evidence as observed only
 * when the cell actually reached grading: not an agent_fail / harness_error, and not failed_at a
 * pre-grade step. Mirrors the "build evidence absent" intent of scoring.mjs buildCapDecision. Pure.
 * @param {{failed_at?: unknown, klass?: unknown}} result finalized cell result
 * @returns {boolean}
 */
export function buildEvidenceObserved(result) {
	const failedAt = result?.failed_at ?? null;
	if (failedAt === AGENT_FAIL_AT) return false;
	if (typeof failedAt === 'string' && Object.prototype.hasOwnProperty.call(HARNESS_FAIL_REASONS, failedAt)) {
		return false;
	}
	const klass = result?.klass ?? null;
	if (klass === 'agent_fail' || klass === 'harness_error') return false;
	return true;
}

/**
 * Deterministic short-circuit for the DEEP failure pass — the analog of {@link deterministicCellAnalysis}
 * for analyzeFailure(). Without it an ungrounded model confabulates a root cause/owner (the kb-chat
 * cell's fabricated category='build' / owner='agent' "build FAILED", contradicting its own
 * wall_clock_timeout reason). Returns `{ failure_analysis: obj|null }` when a deterministic answer
 * applies (caller returns it, skipping the model), or null to fall through to the model.
 *   - harness_error     → { failure_analysis: null } (excluded cell — emit no root-cause block)
 *   - failed_at 2-agent → honest agent-owned analysis (max_tokens vs generic budget); build/test never ran
 *   - no trace          → undetermined; owner null
 * Ordered harness_error → 2-agent → no-trace so the most specific honest answer wins. Pure.
 * @param {{klass?: string|null, klass_reason?: string|null, failed_at?: unknown, tokens_in?: unknown, duration_sec?: unknown}} result
 * @param {unknown} trace parsed trace.json (any shape) or null
 * @returns {{failure_analysis: object|null}|null} deterministic result, or null to call the model
 */
export function deterministicFailureAnalysis(result, trace) {
	const klass = result?.klass ?? null;
	if (klass === 'harness_error') {
		return { failure_analysis: null };
	}
	if ((result?.failed_at ?? null) === AGENT_FAIL_AT) {
		const maxTokens = result?.klass_reason === AGENT_MAX_TOKENS_REASON;
		const tokensIn = typeof result?.tokens_in === 'number' ? result.tokens_in : null;
		const durationSec = typeof result?.duration_sec === 'number' ? result.duration_sec : null;
		const evidenceBits = [
			result?.klass_reason ? `reason=${result.klass_reason}` : null,
			tokensIn != null ? `tokens_in=${tokensIn}` : null,
			durationSec != null ? `duration=${durationSec}s` : null,
		].filter(Boolean);
		return {
			failure_analysis: {
				category: maxTokens ? null : 'timeout',
				single_root_cause: true,
				root_cause: maxTokens
					? 'Agent exhausted the model token budget (MaxTokensError) before completing; build and test steps never ran.'
					: 'Agent step did not finish within its budget; build and test steps never ran.',
				evidence: evidenceBits.join(' '),
				likely_fix: '',
				owner: 'agent',
			},
		};
	}
	if (!trace) {
		return {
			failure_analysis: {
				category: null,
				single_root_cause: null,
				root_cause: 'No agent trace was emitted (e.g. an ungraceful teardown); the failure root cause is undetermined.',
				evidence: '',
				likely_fix: '',
				owner: null,
			},
		};
	}
	return null;
}

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

// ---------------------------------------------------------------------------
// DEEP FAILURE ANALYSIS — a second, richer pass that runs ONLY on failing cells
// (see isFailureCell). Motivated by the shallow per-cell pass misdiagnosing an
// auth-notes 0/11 as a "scoring/harness mismatch" because it never saw the
// actual failing-test output. This pass ingests the quoted test failures + dev/
// build logs and emits a STRUCTURED root cause. Best-effort: never gates a cell.
// ---------------------------------------------------------------------------

// Output budget for the deeper pass (a touch larger than CELL_MAX_TOKENS — it emits a small JSON object).
export const FAILURE_MAX_TOKENS = 600;
// Bound the failure evidence fed to the model so a log storm can't blow up the prompt.
export const MAX_FAILING_TESTS = 8; // distinct error groups (after dedup)
export const MAX_FAILURE_ERR_LEN = 300; // per grouped error line
export const MAX_FAILURE_TITLES = 4; // example spec titles listed per error group
export const MAX_FAILURE_TITLE_LEN = 120; // cap per spec title (mirrors the error-line cap so a pathological title can't bloat the prompt)
export const MAX_LOG_TAIL_CHARS = 1500; // dev.log / build.log tail
export const MAX_FAILURE_JUDGE_CHARS = 1500; // full-ish judge explanation (vs the 500 the cheap pass uses)

// Closed vocabularies the model must pick from; parseFailureAnalysis coerces to these (unknowns → null).
export const FAILURE_CATEGORIES = ['build', 'dev-server', 'api-shape', 'auth', 'persistence', 'timeout', 'flake', 'agent-logic'];
export const FAILURE_OWNERS = ['agent', 'framework', 'harness'];

// GITHUB_OUTPUT booleans arrive as the strings "true"/"false" (not real bools) when result.json is
// assembled from step outputs; mirror scoring.mjs so string flags are interpreted correctly.
// truthy('false') === false, so a genuine build/dev-server failure is still caught below.
export function truthy(v) {
	return v === true || v === 'true';
}

/**
 * Should this cell get the deep failure pass? True for any cell that actually failed at some layer:
 * a fail verdict, an agent_fail, any failed test, or a build / dev-server that never came up. A clean
 * pass / partial with all-green tests is left on the cheap path (no extra model call).
 * @param {unknown} result parsed result.json
 * @returns {boolean}
 */
export function isFailureCell(result) {
	if (!result || typeof result !== 'object') return false;
	const r = /** @type {Record<string, unknown>} */ (result);
	if (r.verdict === 'fail') return true;
	if (r.klass === 'agent_fail') return true;
	if (typeof r.tests_failed === 'number' && r.tests_failed > 0) return true;
	if (r.dev_server_started != null && !truthy(r.dev_server_started)) return true;
	if (r.build_succeeded != null && !truthy(r.build_succeeded)) return true;
	return false;
}

/**
 * Scrub AWS / GitHub credential material from free-form log text before it is placed into a model
 * prompt. Defense-in-depth: dev/build log tails can accidentally echo exported env vars or printed
 * tokens. Non-string input → ''. Pure, best-effort — pattern-based, not a completeness guarantee.
 * @param {unknown} text
 * @returns {string}
 */
export function redactSecrets(text) {
	if (typeof text !== 'string') return '';
	return text
		.replace(/\b(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GITHUB_TOKEN)\s*[:=]\s*\S+/gi, '$1=***REDACTED***')
		.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '***REDACTED-AWS-KEY-ID***')
		.replace(/\bgh[oprsu]_[A-Za-z0-9]{20,}\b/g, '***REDACTED-GH-TOKEN***')
		.replace(/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, '***REDACTED-GH-TOKEN***');
}

// Strip ANSI color codes Playwright embeds in error messages (they wreck dedup + waste chars).
function stripAnsi(s) {
	// eslint-disable-next-line no-control-regex
	return typeof s === 'string' ? s.replace(/\u001b\[[0-9;]*m/g, '') : '';
}

// Collapse an error message to a single trimmed line, capped — the dedup key.
function normalizeError(msg) {
	return oneLine(stripAnsi(msg)).slice(0, MAX_FAILURE_ERR_LEN);
}

/**
 * Pure parser for the Playwright JSON reporter output. Walks the (recursively nested) suites, finds
 * FAILING specs, lifts each one's first error message, and DEDUPES by identical normalized error so a
 * single root cause hitting all N specs collapses to one group (e.g. auth-notes' 11 identical
 * `getByTestId('auth-username')` failures → one group, count 11). Never throws.
 * @param {unknown} pwResults parsed pw-results.json (any shape) or null
 * @returns {{totalFailing: number, groups: Array<{error: string, count: number, titles: string[]}>}}
 */
export function extractFailingTests(pwResults) {
	const empty = { totalFailing: 0, groups: [] };
	if (!pwResults || typeof pwResults !== 'object') return empty;
	/** @type {Array<{title: string, error: string}>} */
	const failing = [];

	const firstError = (spec) => {
		for (const t of spec?.tests ?? []) {
			for (const res of t?.results ?? []) {
				const status = res?.status;
				if (status && status !== 'passed' && status !== 'skipped') {
					const msg = res?.error?.message || (Array.isArray(res?.errors) ? res.errors[0]?.message : '') || '';
					if (msg) return normalizeError(msg);
				}
			}
		}
		return '';
	};

	const walk = (suite, prefix) => {
		if (!suite || typeof suite !== 'object') return;
		const title = suite.title ? `${prefix}${prefix ? ' › ' : ''}${suite.title}` : prefix;
		for (const spec of suite.specs ?? []) {
			// A spec is failing when ok===false OR any of its tests has a non-passed result.
			const anyBad = spec?.ok === false || (spec?.tests ?? []).some((t) => (t?.results ?? []).some((r) => r?.status && r.status !== 'passed' && r.status !== 'skipped'));
			if (anyBad) {
				failing.push({ title: (oneLine(spec?.title) || '(untitled spec)').slice(0, MAX_FAILURE_TITLE_LEN), error: firstError(spec) || '(no error message captured)' });
			}
		}
		for (const child of suite.suites ?? []) walk(child, title);
	};

	try {
		for (const s of pwResults.suites ?? []) walk(s, '');
	} catch {
		return empty;
	}

	// Dedup by identical normalized error, preserving first-seen order.
	/** @type {Map<string, {error: string, count: number, titles: string[]}>} */
	const byError = new Map();
	for (const f of failing) {
		const g = byError.get(f.error);
		if (g) {
			g.count += 1;
			if (g.titles.length < MAX_FAILURE_TITLES) g.titles.push(f.title);
		} else {
			byError.set(f.error, { error: f.error, count: 1, titles: [f.title] });
		}
	}
	return { totalFailing: failing.length, groups: [...byError.values()].slice(0, MAX_FAILING_TESTS) };
}

// Deep-failure system prompt: force a single, evidence-grounded root cause as STRICT JSON.
export const FAILURE_SYSTEM = `You are the failure triager for ONE benchmark cell where an AI coding agent built an app that then FAILED (tests failed, or the build / dev-server never came up). You are given the failing test names + their error messages, the dev-server log tail, the build log tail (if the build failed), the judge's notes on what was built, and the tool-call trace tail.

Diagnose the SINGLE most likely root cause from the QUOTED evidence. Prefer one shared cause when many tests fail identically. Output ONLY a JSON object (no prose, no markdown fence) with EXACTLY these keys:
{
  "category": one of ["build","dev-server","api-shape","auth","persistence","timeout","flake","agent-logic"],
  "single_root_cause": boolean (true if one cause explains all/most failures),
  "root_cause": string (<=2 sentences; cite the decisive evidence),
  "evidence": string (a quoted failing test name + its error line, or the decisive log line),
  "likely_fix": string (<=1 sentence, concrete and actionable),
  "owner": one of ["agent","framework","harness"] (who must fix it)
}
Base every field on the provided evidence — do not invent file names or errors you were not shown.`;

/**
 * Build the deep-failure prompt user text from a failing cell's data + logs. Pure.
 * @param {{task?: string, template?: string, verdict?: string, klass?: string|null,
 *   testsFailed?: number|null, testsTotal?: number|null, buildSucceeded?: boolean|null,
 *   devServerStarted?: boolean|null, judgeExplanation?: string,
 *   failingTests?: {totalFailing: number, groups: Array<{error: string, count: number, titles: string[]}>},
 *   devLogTail?: string, buildLogTail?: string, traceTail?: string}} input
 * @returns {string}
 */
export function buildFailureUserText(input) {
	const ft = input.failingTests ?? { totalFailing: 0, groups: [] };
	const testLines = ft.groups.length
		? ft.groups.map((g) => {
				const titles = g.titles.join(' | ');
				return `- [${g.count}× ] ${titles}${g.count > g.titles.length ? ' (+more)' : ''}\n    ↳ ${g.error}`;
			})
		: ['(no failing-test detail captured)'];
	const signals = [
		input.verdict ? `verdict ${input.verdict}` : null,
		input.klass ? `klass ${input.klass}` : null,
		typeof input.testsFailed === 'number' ? `tests_failed ${input.testsFailed}${typeof input.testsTotal === 'number' ? `/${input.testsTotal}` : ''}` : null,
		input.buildSucceeded === false ? 'build FAILED' : input.buildSucceeded === true ? 'build ok' : null,
		input.devServerStarted === false ? 'dev-server DID NOT START' : input.devServerStarted === true ? 'dev-server ok' : null,
	]
		.filter(Boolean)
		.join(', ');
	const judge = oneLine(input.judgeExplanation).slice(0, MAX_FAILURE_JUDGE_CHARS);
	const devTail = (input.devLogTail ?? '').slice(-MAX_LOG_TAIL_CHARS);
	const buildTail = (input.buildLogTail ?? '').slice(-MAX_LOG_TAIL_CHARS);
	return [
		`Cell: ${input.task ?? '—'}/${input.template ?? '—'}`,
		`Signals: ${signals || '(none)'}`,
		`Failing tests (${ft.totalFailing} total, deduped by error):`,
		...testLines,
		'',
		'Dev-server log tail:',
		devTail || '(none)',
		...(input.buildSucceeded === false ? ['', 'Build log tail:', buildTail || '(none)'] : []),
		'',
		judge ? `Judge notes (what was built): ${judge}` : 'Judge notes: (none)',
		'',
		'Trace tail:',
		(input.traceTail ?? '').slice(-MAX_TAIL_CHARS) || '(no trace tail)',
	].join('\n');
}

/**
 * Tolerantly parse the deep-failure model output into a normalized object. Accepts a bare JSON object,
 * a ```json fenced block, or JSON embedded in surrounding prose (first `{` … last `}`). Coerces
 * category/owner to their closed vocabularies (unknown → null) and caps string lengths. Returns null
 * on anything unusable. NEVER throws.
 * @param {unknown} text raw model completion
 * @returns {{category: string|null, single_root_cause: boolean|null, root_cause: string, evidence: string, likely_fix: string, owner: string|null}|null}
 */
export function parseFailureAnalysis(text) {
	if (typeof text !== 'string' || !text.trim()) return null;
	let raw = text.trim();
	// Strip a ```json … ``` fence if present.
	const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) raw = fence[1].trim();
	let obj = null;
	try {
		obj = JSON.parse(raw);
	} catch {
		// Fall back to the first {...} span embedded in prose.
		const start = raw.indexOf('{');
		const end = raw.lastIndexOf('}');
		if (start !== -1 && end > start) {
			try {
				obj = JSON.parse(raw.slice(start, end + 1));
			} catch {
				return null;
			}
		} else {
			return null;
		}
	}
	if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
	const str = (v, cap) => (typeof v === 'string' ? oneLine(v).slice(0, cap) : '');
	const category = FAILURE_CATEGORIES.includes(obj.category) ? obj.category : null;
	const owner = FAILURE_OWNERS.includes(obj.owner) ? obj.owner : null;
	const root_cause = str(obj.root_cause, 600);
	const evidence = str(obj.evidence, 600);
	const likely_fix = str(obj.likely_fix, 400);
	// Require at least a category or a root_cause — otherwise the object carried nothing usable.
	if (!category && !root_cause) return null;
	return {
		category,
		single_root_cause: typeof obj.single_root_cause === 'boolean' ? obj.single_root_cause : null,
		root_cause,
		evidence,
		likely_fix,
		owner,
	};
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
