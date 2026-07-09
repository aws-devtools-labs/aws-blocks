// Step "Render summary": read every bench-result-*/result.json downloaded as
// artifacts and render a markdown report to $GITHUB_STEP_SUMMARY — the result
// lives in the Actions run summary, NOT a PR comment (the commenting step is
// intentionally disabled; see agent-bench.yml).
//
// The report has TWO tables built from the SAME rows (lib/overview.mjs):
//   1. Overview — colors ONLY (🟢/🟡/🔴 per metric vs baseline), at-a-glance.
//   2. Detailed results — the same rows widened WITH numbers (baseline -> pr).
// A collapsible Glossary (scoring, colors, the ±5% margin) sits at the very top;
// the executive summary, potential issues, and per-cell analysis are appended
// AFTER these by the separate best-effort roll-up step (steps/analyze.mjs).
//
// The bench runs N=1 (a single rep) per cell: each cell artifact holds exactly
// one result.json, read directly here.
//
// Scoring model — the formulas live in ONE place, ./lib/scoring.mjs, and are
// also stamped onto each result.json by finalize-result.mjs, so the published
// artifact and this report can't diverge:
//   - COMPOSITE (0..100) = round(60*tr + 4*j*min(1, 4*tr), 1) — 60% objective
//     pass-rate + 40% judge (judge gated below a 25% pass-rate). A judge error
//     drops only the judge term, never the test-driven portion.
//   - COST = builder token spend priced at Bedrock Sonnet rates (BUILDER_PRICING).
//   - SCORE = composite / cost — composite points per dollar (higher = better).
//   - COLOR vs baseline, per metric: 🟢 same-or-better · 🟡 worse within ±5% ·
//     🔴 worse beyond. Single tunable MARGIN_PCT; see the glossary + overview.mjs.
//
// The BASELINE a PR diffs against is the MOST RECENT main-branch bench
// (bench/runs/latest-main.json), fetched by the job's "Fetch baseline" step —
// never the PR's (possibly stale) base commit. With no baseline the tables show
// absolute PR values (every metric 🆕), never an error.
//
// The headline is the MEAN composite over SCORED cells (harness_error AND
// no-test-result cells excluded). Scoring is OBSERVATIONAL by default; set
// `BENCH_MIN_SCORE` to gate: the job exits non-zero when the mean composite
// falls below it.
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cellCost, compositeBand, isScoredCell, scorePerDollar, testRate, testStats, verdictOf } from './lib/scoring.mjs';
import { buildAggregate, cellComposite, deltaArrow, diffAgainstBaseline, renderDetailed, renderOverview } from './lib/overview.mjs';

const RESULTS_DIR = process.env.RESULTS_DIR ?? 'results';

// The bench matrix is skipped when the gating label is absent, so the results
// directory may never be created. Treat a missing dir as "no results" instead
// of hard-crashing — the empty-run path below renders a benign note and exits 0.
let dirs = [];
try {
	dirs = readdirSync(RESULTS_DIR).filter((d) => d.startsWith('bench-result-'));
} catch (err) {
	if (err?.code !== 'ENOENT') throw err;
}

// One row per cell, read from the single result.json the cell artifact holds.
const cells = dirs.map((d) => {
	const file = join(RESULTS_DIR, d, 'result.json');
	try {
		return JSON.parse(readFileSync(file, 'utf-8'));
	} catch {
		// No parseable result.json — surface the raw artifact suffix
		// (<task>-<template>); can't split it reliably (both names have dashes).
		return { task: d.replace('bench-result-', ''), template: '', error: 'unreadable' };
	}
});

// ── Buckets ──────────────────────────────────────────────────────────────────
const dataCells = cells.filter((c) => !c.error);
const errorCells = cells.filter((c) => c.error);
// A cell enters the composite mean iff gradeable (not harness_error) AND it
// produced test results — single-sourced via isScoredCell.
const compositeCells = dataCells.filter((c) => isScoredCell(c));
const judgeScoredCells = dataCells.filter((c) => c.klass !== 'harness_error' && typeof c.judge_score === 'number');
const harnessErrors = dataCells.filter((c) => c.klass === 'harness_error');

// Judge/test harness errors, tracked SEPARATELY from test signals so they can
// never flip a verdict or zero a test_rate (see the long-form note that used to
// live in the removed scoreboard table). An agent_fail ran neither, so it is
// neither — excluded from both.
const testErr = (r) => r.klass !== 'harness_error' && r.klass !== 'agent_fail' && testStats(r).denom === 0;
const judgeErr = (r) =>
	r.klass !== 'harness_error' &&
	r.klass !== 'agent_fail' &&
	!testErr(r) &&
	r.failed_at !== '3-build-test' &&
	typeof r.judge_score !== 'number';

const sortKey = (r) => `${r.task ?? ''}/${r.template ?? ''}`;
const byTask = (a, b) => sortKey(a).localeCompare(sortKey(b));
const cellRef = (r) => `\`${r.task ?? '—'}/${r.template ?? '—'}\``;

// ── Run-logs deep link (for the glossary + Athena/aggregate provenance) ───────
const serverUrl = process.env.GITHUB_SERVER_URL;
const repoSlug = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
const logsUrl = serverUrl && repoSlug && runId ? `${serverUrl}/${repoSlug}/actions/runs/${runId}` : null;

// ── Aggregate + baseline diff ─────────────────────────────────────────────────
const benchSha = (process.env.BENCH_SHA ?? '').trim();
const baseSha = (process.env.BENCH_BASE_SHA ?? '').trim();
const benchEvent = (process.env.BENCH_EVENT ?? '').trim();
const aggregate = buildAggregate(cells, {
	sha: benchSha || null,
	base_sha: baseSha || null,
	pr_number: (process.env.PR_NUMBER ?? '').trim() || null,
	event: benchEvent || null,
	generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
});

let baseline = null;
const baselinePath = process.env.BASELINE_PATH;
if (baselinePath) {
	try {
		baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
	} catch (err) {
		if (err?.code !== 'ENOENT') {
			process.stderr.write(`[summary] baseline at ${baselinePath} unreadable (${err?.message ?? err}); treating as no baseline\n`);
		}
	}
}
const diff = diffAgainstBaseline(aggregate, baseline);

// ── Headline + optional gate over the composite mean (scored cells only) ──────
const minScoreRaw = (process.env.BENCH_MIN_SCORE ?? '').trim();
const min = Number(minScoreRaw);
const gateEnabled = minScoreRaw !== '' && Number.isFinite(min);
let gateFailed = false;

const judgeMean = judgeScoredCells.length
	? judgeScoredCells.reduce((acc, r) => acc + r.judge_score, 0) / judgeScoredCells.length
	: null;

// The deterministic headline line rendered under the Overview heading. (The
// LLM-written executive summary is a SEPARATE section appended by analyze.mjs.)
function headlineLine() {
	if (compositeCells.length === 0) {
		if (cells.length > 0 && harnessErrors.length === cells.length) {
			return `⚠️ All ${cells.length} cell(s) were harness_error — nothing was scored, no composite headline.`;
		}
		const g = gateEnabled ? ` (\`BENCH_MIN_SCORE=${min}\` set, but with no scored cells the gate is skipped — conservative.)` : '';
		return `_No cells produced test results — no composite headline to report._${g}`;
	}
	const mean = aggregate.mean_composite;
	const judgeNote = judgeMean !== null ? ` · judge mean **${judgeMean.toFixed(2)}**/10` : '';
	// Composite mean delta vs the baseline (▲/▼/≈ over the ±5 band), when present.
	const deltaNote =
		diff.hasBaseline && diff.meanDelta !== null
			? ` · ${deltaArrow(diff.meanDelta)} ${diff.meanDelta > 0 ? '+' : ''}${diff.meanDelta.toFixed(1)} vs \`main\``
			: '';
	const head = `Mean composite **${mean.toFixed(1)}**/100 ${compositeBand(mean)} across ${compositeCells.length} scored cell(s)${judgeNote}${deltaNote}.`;
	if (!gateEnabled) return `${head} _Observational — \`BENCH_MIN_SCORE\` unset, so it does not gate the merge._`;
	const pass = mean >= min;
	gateFailed = !pass;
	return `${pass ? '✅' : '❌'} ${head} Threshold **${min}** — ${pass ? 'pass' : 'FAIL'}.`;
}

// ── Assemble the report ───────────────────────────────────────────────────────
const md = [];

// 1) Glossary & notes — collapsed, at the very top.
const lastRun = (process.env.GITHUB_RUN_STARTED_AT || new Date().toISOString()).replace(/\.\d{3}Z$/, 'Z');
md.push('<details>');
md.push('<summary>📖 Glossary &amp; notes — scoring, colors, the ±5% margin (click to expand)</summary>');
md.push('');
md.push('- **N = 1** — one rep per cell, so a small delta may be model variance, not a real change; re-run for certainty.');
md.push(
	'- **Colors (vs baseline, per metric):** 🟢 same-or-better · 🟡 worse but within the margin · 🔴 worse beyond it · 🆕 no baseline value (new cell) · — nothing to diff this run · 🗑️ cell gone since the baseline.',
);
md.push(
	'- **Margin = ±5%** (`MARGIN_PCT` in `overview.mjs`) — relative to the baseline value; for integer metrics (test counts, 0-10 judge dims) it is floored to 1, so a single-point nudge is 🟡, never 🔴. Edit that one constant to widen/narrow it.',
);
md.push('- **Directions:** tests ↑, judge ↑, score ↑ are better (higher = 🟢); cost ↓, tokens ↓ are better (lower = 🟢).');
md.push(
	'- **Composite (0-100)** = `round(60·test_rate + 4·judge·min(1, 4·test_rate), 1)` — 60% objective pass-rate + 40% judge, the judge term gated below a 25% pass-rate.',
);
md.push('- **Cost** = builder token spend at Bedrock Claude Sonnet rates ($3 in / $15 out per 1M tokens; `BUILDER_PRICING` in `scoring.mjs`).');
md.push(
	'- **SCORE = composite ÷ cost** — composite points per dollar (higher = better). Cost, not raw token volume, is the denominator, so tokens can\'t dominate; a broken (composite 0) cell scores 0 no matter how cheap. Flip `SCORE_PER_DOLLAR` in `scoring.mjs` for cost-per-point (lower = better).',
);
md.push(
	'- **Baseline** = the most recent `main`-branch bench (`bench/runs/latest-main.json`), NOT the PR base commit — the PR always diffs against the current state of `main`.',
);
md.push(
	'- **Excluded from the mean:** `harness_error` cells (infra failures) and gradeable cells that ran no tests. `agent_fail` (agent produced no app in budget) IS included, as composite 0.',
);
if (logsUrl) md.push(`- [Run artifacts — per-cell source + full agent traces](${logsUrl}) · 🕒 Last run: ${lastRun} · run #${runId}`);
md.push('');
md.push('</details>');
md.push('');

// 2) Overview — colors only.
if (cells.length > 0) {
	let heading = '## Overview — PR vs `main` baseline';
	let note;
	const legend = '🟢 better/equal · 🟡 worse within ±5% · 🔴 worse beyond · 🆕 new cell.';
	const baseLabel = baseline?.sha ? `\`${String(baseline.sha).slice(0, 7)}\`` : 'the recorded baseline';
	if (benchEvent === 'push') {
		// A push-to-main run IS the new baseline; it diffs against the PREVIOUS
		// main bench (fetched pre-persist), or shows absolute values if none.
		heading = '## Overview — baseline run';
		const rec = `Baseline run (push to \`main\`): recorded as the new \`main\` baseline for \`${benchSha.slice(0, 7) || '(unknown)'}\`.`;
		note = baseline
			? `${rec} Colored vs the PREVIOUS \`main\` baseline ${baseLabel}. ${legend}`
			: `${rec} No earlier baseline to diff — absolute values (all 🆕).`;
	} else if (baseline) {
		note = `Each metric colored vs the latest \`main\` baseline ${baseLabel}. ${legend}`;
	} else {
		note = 'No `main` baseline recorded yet — showing absolute values (every metric 🆕). PR-vs-`main` deltas appear once a `main` bench has stored one.';
	}
	md.push(...renderOverview(diff, { heading, note }));
	// Deterministic headline directly under the Overview.
	md.push(headlineLine(), '');
}

// 3) Detailed results — numbers.
if (cells.length > 0) {
	md.push(...renderDetailed(diff, { heading: '## Detailed results', note: 'Same rows, colored `baseline -> pr`.' }));
}

// 4) Compact caveats (deterministic) — excluded / harness / judge-error cells.
const caveats = [];
if (harnessErrors.length > 0) {
	const counts = {};
	for (const r of harnessErrors) {
		const reason = r.klass_reason ?? r.failed_at ?? 'unknown';
		counts[reason] = (counts[reason] ?? 0) + 1;
	}
	const summary = Object.entries(counts)
		.sort((a, b) => b[1] - a[1])
		.map(([reason, n]) => `${n}× ${reason}`)
		.join(', ');
	caveats.push(
		`- 🧰 **Excluded (harness_error, not scored)** — ${harnessErrors.length}: ${summary}. Cells: ${harnessErrors
			.slice()
			.sort(byTask)
			.map(cellRef)
			.join(', ')}`,
	);
}
const judgeErrs = dataCells.filter(judgeErr);
if (judgeErrs.length > 0) {
	caveats.push(
		`- ⚠️ **Judge error** (composite used the test-rate only; verdict intact) — ${judgeErrs.map(cellRef).join(', ')}`,
	);
}
const testErrs = dataCells.filter(testErr);
if (testErrs.length > 0) {
	caveats.push(
		`- ❔ **No test results** (verdict \`unknown\`, excluded from the headline) — ${testErrs.map(cellRef).join(', ')}`,
	);
}
if (errorCells.length > 0) {
	caveats.push(`- 🗂️ **Artifact unreadable** — ${errorCells.map((r) => `\`${r.task}\``).join(', ')}`);
}
if (caveats.length > 0) {
	md.push('### Caveats & exclusions', '', ...caveats, '');
}

// ── Persist the aggregate (S3 baseline) + Athena NDJSON ───────────────────────
// Only when ≥1 cell produced a result, so an empty run never clobbers a real
// baseline for this commit with an empty one.
if (process.env.AGGREGATE_PATH && cells.length > 0) {
	try {
		writeFileSync(process.env.AGGREGATE_PATH, `${JSON.stringify(aggregate, null, 2)}\n`);
	} catch (err) {
		process.stderr.write(`[summary] failed to write aggregate to ${process.env.AGGREGATE_PATH}: ${err?.message ?? err}\n`);
	}
}

// One flat NDJSON line per SCORED cell for the date-partitioned Athena prefix,
// so bench history (incl. cost + score-per-$) is queryable without parsing
// per-cell result.json. Best-effort: warn and carry on, never fail the job.
if (process.env.ATHENA_NDJSON_PATH) {
	try {
		const scored = dataCells.filter((c) => isScoredCell(c));
		const ndjson = scored
			.map((r) => {
				const comp = cellComposite(r) ?? 0;
				const cost = cellCost(r);
				return JSON.stringify({
					sha: benchSha || null,
					timestamp: aggregate.generated_at,
					event: benchEvent || null,
					pr_number: (process.env.PR_NUMBER ?? '').trim() || null,
					task: r.task ?? null,
					template: r.template ?? null,
					composite: comp,
					test_rate: Math.round(testRate(testStats(r)) * 1000) / 1000,
					judge_score: typeof r.judge_score === 'number' ? r.judge_score : null,
					verdict: verdictOf(r),
					klass: r.klass ?? null,
					tokens_in: typeof r.tokens_in === 'number' ? r.tokens_in : null,
					tokens_out: typeof r.tokens_out === 'number' ? r.tokens_out : null,
					cost,
					score: scorePerDollar(comp, cost),
					duration_sec: typeof r.duration_sec === 'number' ? r.duration_sec : null,
				});
			})
			.join('\n');
		if (scored.length > 0) writeFileSync(process.env.ATHENA_NDJSON_PATH, `${ndjson}\n`);
	} catch (err) {
		process.stderr.write(`[summary] failed to write Athena NDJSON to ${process.env.ATHENA_NDJSON_PATH}: ${err?.message ?? err}\n`);
	}
}

// ── Emit ──────────────────────────────────────────────────────────────────────
const out = `${md.join('\n')}\n`;
if (process.env.GITHUB_STEP_SUMMARY) {
	// A >1MB step summary (GitHub's per-step limit) or any IO error here must NOT
	// turn the check red — fall back to stdout so the summary is still visible.
	try {
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, out);
	} catch (err) {
		process.stderr.write(`[summary] failed to append GITHUB_STEP_SUMMARY (${err?.message ?? err}); writing to stdout instead\n`);
		process.stdout.write(out);
	}
} else {
	process.stdout.write(out);
}

if (gateFailed) {
	process.stderr.write(`[summary] mean composite below BENCH_MIN_SCORE=${minScoreRaw}; failing the gate\n`);
	process.exit(1);
}
