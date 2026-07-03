// Step "Render summary": read every bench-result-*/result.json downloaded as
// artifacts and render a markdown scoreboard to $GITHUB_STEP_SUMMARY — the
// result lives in the Actions run summary, NOT a PR comment (the commenting
// step is intentionally disabled; see agent-bench.yml). On a PR it also renders
// an at-a-glance PR-vs-baseline OVERVIEW at the TOP (per-cell composite delta +
// mean delta) from the baseline aggregate the job fetched from S3 for the PR's
// base commit; with no baseline it falls back to absolute composites.
//
// The bench runs N=1 (a single rep) per cell: each cell artifact holds exactly
// one result.json, read directly here.
//
// Scoring model (gradient, not binary) — the formulas live in ONE place,
// ./lib/scoring.mjs, and are also stamped onto each result.json by
// finalize-result.mjs, so the published artifact and this table can't diverge:
//   - VERDICT is pure pass-rate — the judge plays NO part. A judge/LLM failure
//     can never flip a verdict or zero the test_rate (judge & test harness
//     errors are tracked as SEPARATE signals). Tests are the source of truth.
//       harness_error  pre-grade step failed / cancelled — no gradeable artifact (excluded)
//       agent_fail     agent timed out / produced no app at 2-agent — verdict 'fail', composite 0 (INCLUDED)
//       unknown        gradeable but produced no test results (denom 0; excluded)
//       pass           pass_rate >= 0.999
//       partial        0 < pass_rate < 0.999
//       fail           pass_rate == 0 (tests ran)
//   - COMPOSITE (0..100) blends the test rate with the judge score:
//       composite = round(60*tr + 4*j*min(1, 4*tr), 1)
//     A judge error drops only the judge term (composite = 60*tr) — it never
//     zeroes the test-driven portion. Bands: >=80 🟢, >=50 🟡, else 🔴.
//
// The headline is the MEAN composite over SCORED cells (harness_error AND
// no-test-result cells excluded), with the judge mean shown alongside.
//
// Scoring is OBSERVATIONAL by default. Set the optional `BENCH_MIN_SCORE` env
// (wired to the repo/org variable of the same name) to gate: the job exits
// non-zero when the mean composite (0..100) across scored cells falls below it.
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compositeBand, isScoredCell, testRate, testStats, verdictOf } from './lib/scoring.mjs';
import { buildAggregate, cellComposite, diffAgainstBaseline, renderOverview } from './lib/overview.mjs';

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

// Composite for a cell (0..100) comes from overview.mjs's shared `cellComposite`
// (null for non-scored cells — coerced to 0 at the call sites here).

// EVIDENCE boolean signals (build_succeeded, …) are QUOTED in the workflow's
// EVIDENCE JSON (so a non-bool step output can't yield invalid JSON), then
// spread verbatim onto result.json. They reach here as either a real bool or
// its string form, so coerce both — a bare `"false"` string is truthy in JS and
// would otherwise read as a passing build. Mirrors 4-judge.ts's `truthy`.
const truthy = (v) => v === true || v === 'true';

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
// A cell enters the composite mean iff gradeable (not harness_error) AND it
// produced test results — single-sourced via isScoredCell.
const compositeCells = dataCells.filter((c) => isScoredCell(c));
const judgeScoredCells = dataCells.filter((c) => c.klass !== 'harness_error' && typeof c.judge_score === 'number');
const harnessErrors = dataCells.filter((c) => c.klass === 'harness_error');

// Judge error on an otherwise-gradeable cell: tracked SEPARATELY from test
// signals so it can never flip the verdict or zero the test_rate. An agent_fail
// (timeout / no app) ran neither the judge nor the tests, so it is NEITHER a
// judge error NOR a test-harness error — it shows as ❌ fail / composite 0 in
// the table; exclude it from both isolation notes below.
//
// A judge error means the judge actually RAN and failed to yield a numeric
// score (invoke error, schema-validation error, timeout, or missing structured
// output). A cell that failed at 3-build-test SKIPS the judge entirely (step 4
// is gated on step 3 success), so it has no judge_score even though the judge
// never ran — excluding failed_at==='3-build-test' (and testErr cells, whose
// no-test-signal bucket already owns them) prevents miscounting those here and
// double-counting them with the test-harness note below.
const testErr = (r) => r.klass !== 'harness_error' && r.klass !== 'agent_fail' && testStats(r).denom === 0;
const judgeErr = (r) =>
	r.klass !== 'harness_error' &&
	r.klass !== 'agent_fail' &&
	!testErr(r) &&
	r.failed_at !== '3-build-test' &&
	typeof r.judge_score !== 'number';

const VERDICT_LABEL = {
	pass: '✅ pass',
	partial: '🟡 partial',
	fail: '❌ fail',
	unknown: '❔ unknown',
	harness_error: '🧰 harness',
};
const sortKey = (r) => `${r.task ?? ''}/${r.template ?? ''}`;
const byTask = (a, b) => sortKey(a).localeCompare(sortKey(b));

// ── Table ───────────────────────────────────────────────────────────────────
// Run-logs deep-link, hoisted ABOVE the table so the artifacts pointer can sit
// right under it (the footer's "last run" line reuses these same vars). GitHub
// Actions exposes no per-artifact deep link, so we name the deterministic
// artifacts and link the run page where they're listed.
const serverUrl = process.env.GITHUB_SERVER_URL;
const repoSlug = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
const logsUrl = serverUrl && repoSlug && runId ? `${serverUrl}/${repoSlug}/actions/runs/${runId}` : null;

const out = ['## Bench results', ''];
out.push(
	'| Task | Template | Verdict | Tests | Build | Judge | Composite | Stop reason |',
	'|------|----------|---------|-------|-------|-------|-----------|-------------|',
);
for (const r of cells.slice().sort(byTask)) {
	if (r.error) {
		out.push(`| ${r.task} | — | (artifact ${r.error}) | — | — | — | — | — |`);
		continue;
	}
	const { passed, denom } = testStats(r);
	const tests = denom > 0 ? `${passed}/${denom}` : '—';
	const build =
		r.build_status === 'na'
			? '∅'
			: r.build_status === 'ok'
				? '✅'
				: r.build_status === 'failed'
					? '❌'
					: truthy(r.build_succeeded)
						? '✅'
						: '❌';
	const judge =
		typeof r.judge_score === 'number'
			? String(r.judge_score)
			: r.klass === 'harness_error' || r.klass === 'agent_fail'
				? '—'
				: 'err';
	let compositeCell = '—';
	if (isScoredCell(r)) {
		const c = cellComposite(r) ?? 0;
		compositeCell = `${c.toFixed(1)} ${compositeBand(c)}`;
	}
	out.push(
		`| ${r.task ?? '—'} | ${r.template ?? '—'} | ${VERDICT_LABEL[verdictOf(r)]} | ${tests} | ${build} | ${judge} | ${compositeCell} | ${r.stop_reason || '—'} |`,
	);
}
out.push('');
if (logsUrl) {
	out.push(
		`📦 Per-cell source & full agent traces (tool calls, tokens): see this run's Artifacts — \`bench-source-<task>-<template>\`, \`bench-trace-<task>-<template>\` → [run artifacts](${logsUrl})`,
		'',
	);
}

// ── Harness-error section (excluded from the headline & the gate) ────────────
if (harnessErrors.length > 0) {
	const counts = {};
	for (const r of harnessErrors) {
		const reason = r.klass_reason ?? r.failed_at ?? 'unknown';
		counts[reason] = (counts[reason] ?? 0) + 1;
	}
	const reasonSummary = Object.entries(counts)
		.sort((a, b) => b[1] - a[1])
		.map(([reason, n]) => `${n}× ${reason}`)
		.join(', ');
	out.push(`### Excluded as harness_error (${harnessErrors.length}: ${reasonSummary})`);
	out.push('');
	out.push('_These cells never produced a gradeable artifact and are NOT in the headline below._');
	out.push('');
	for (const r of harnessErrors.slice().sort(byTask)) {
		const where = r.failed_at ? ` — failed at \`${r.failed_at}\`` : '';
		out.push(`- \`${r.task ?? '—'}/${r.template ?? '—'}\`: ${r.klass_reason ?? 'harness_error'}${where}`);
	}
	out.push('');
}

// ── Judge/test harness-error isolation note ──────────────────────────────────
// Surfaced as SEPARATE signals so it's clear a judge failure left the verdict
// and test_rate intact, and a missing test run only produced an `unknown`.
const judgeErrs = dataCells.filter(judgeErr);
const testErrs = dataCells.filter(testErr);
if (judgeErrs.length > 0 || testErrs.length > 0) {
	const parts = [];
	if (judgeErrs.length > 0) {
		parts.push(
			`${judgeErrs.length} cell(s) had a **judge error** (composite uses the test rate only; verdict unaffected): ${judgeErrs
				.map((r) => `\`${r.task}/${r.template}\``)
				.join(', ')}`,
		);
	}
	if (testErrs.length > 0) {
		parts.push(
			`${testErrs.length} cell(s) produced **no test results** (verdict \`unknown\`, excluded from the headline): ${testErrs
				.map((r) => `\`${r.task}/${r.template}\``)
				.join(', ')}`,
		);
	}
	out.push(`> **Harness isolation:** ${parts.join('; ')}.`);
	out.push('');
}

// Build this run's compact aggregate (per-cell composites + mean) up-front from
// the shared scoring source of truth. The gate headline below reuses its
// `mean_composite`, and the PR-vs-baseline overview (rendered at the TOP of the
// run summary) diffs it against the baseline the job fetched from S3.
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

// ── Headline + optional gate over the composite mean (scored cells only) ──────
const minScoreRaw = (process.env.BENCH_MIN_SCORE ?? '').trim();
const min = Number(minScoreRaw);
const gateEnabled = minScoreRaw !== '' && Number.isFinite(min);
let gateFailed = false;

if (minScoreRaw !== '' && !Number.isFinite(min)) {
	out.push(`⚠️ \`BENCH_MIN_SCORE\` is set but not a number (\`${minScoreRaw}\`) — ignoring; not gating.`);
}

const judgeMean = judgeScoredCells.length
	? judgeScoredCells.reduce((acc, r) => acc + r.judge_score, 0) / judgeScoredCells.length
	: null;

if (compositeCells.length === 0) {
	// Distinguish "every cell was a harness error" from "no results at all" so a
	// systemic infra failure reads differently from an empty run.
	if (cells.length > 0 && harnessErrors.length === cells.length) {
		out.push(`⚠️ All ${cells.length} cell(s) were harness_error — no composite to report (nothing was scored).`);
	} else {
		out.push('_No cells produced test results — no composite headline to report._');
	}
	if (gateEnabled) {
		out.push(`(\`BENCH_MIN_SCORE=${min}\` is set, but with no scored cells the gate is skipped — conservative.)`);
	}
} else {
	const compositeMean = aggregate.mean_composite;
	const judgeNote = judgeMean !== null ? ` (judge mean **${judgeMean.toFixed(2)}**/10)` : '';
	if (!gateEnabled) {
		out.push(
			`Mean composite **${compositeMean.toFixed(1)}**/100 ${compositeBand(compositeMean)} across ${compositeCells.length} scored cell(s)${judgeNote}. _Observational — \`BENCH_MIN_SCORE\` is unset, so it does not gate the merge._`,
		);
	} else {
		const pass = compositeMean >= min;
		gateFailed = !pass;
		out.push(
			`${pass ? '✅' : '❌'} Mean composite **${compositeMean.toFixed(1)}**/100 ${compositeBand(compositeMean)} across ${compositeCells.length} scored cell(s)${judgeNote} vs threshold **${min}** — ${pass ? 'pass' : 'FAIL'}.`,
		);
	}
}

// ── Raw per-dimension scores (collapsible; composite re-derivable from here) ──
// Publishes each scored cell's per-dimension judge scores (capped, with the
// pre-cap raw shown as `capped←raw` when a hard cap fired) alongside the
// pass-rate and overall, so a reader can re-derive — or re-weight — the
// composite without re-running anything. Dimension keys are read from the data
// (they vary per task) rather than imported, since this .mjs runs under bare
// `node` and can't import the .ts rubric.
const dimsCell = (r) => {
	const capped = r.judge_dimensions && typeof r.judge_dimensions === 'object' ? r.judge_dimensions : {};
	const raw = r.judge_dimensions_raw && typeof r.judge_dimensions_raw === 'object' ? r.judge_dimensions_raw : {};
	const keys = Object.keys(capped).length ? Object.keys(capped) : Object.keys(raw);
	if (keys.length === 0) return '_none_';
	return keys
		.map((k) => {
			const c = capped[k];
			const rw = raw[k];
			if (typeof c === 'number' && typeof rw === 'number' && c !== rw) return `${k} ${c}←${rw}`;
			const v = typeof c === 'number' ? c : typeof rw === 'number' ? rw : '—';
			return `${k} ${v}`;
		})
		.join('; ');
};
if (compositeCells.length > 0) {
	out.push('');
	out.push('<details>');
	out.push('<summary>Raw per-dimension scores (judge dims shown <code>capped←raw</code> when a hard cap fired)</summary>');
	out.push('');
	out.push(
		'Composite = `round(60·test_rate + 4·judge·min(1, 4·test_rate), 1)`. Judge dims are 0–10, averaged equally into the overall; objective caps (build/dev-server/scaffold) may lower a dim after the judge. Everything below the composite is re-derivable from these columns.',
	);
	out.push('');
	out.push('| Task | Template | Pass-rate | Judge dims | Judge overall | Composite |');
	out.push('|------|----------|-----------|------------|---------------|-----------|');
	for (const r of compositeCells.slice().sort(byTask)) {
		const { passed, denom } = testStats(r);
		const rate = `${passed}/${denom} (${Math.round(testRate(testStats(r)) * 100)}%)`;
		const overall =
			typeof r.judge_score === 'number' ? r.judge_score.toFixed(2) : r.klass === 'agent_fail' ? '—' : 'err';
		const compCell = (cellComposite(r) ?? 0).toFixed(1);
		out.push(`| ${r.task} | ${r.template} | ${rate} | ${dimsCell(r)} | ${overall} | ${compCell} |`);
	}
	out.push('');
	out.push('</details>');
}

// ── Footer: when the bench last ran + a deep-link back to the workflow run ────
// Uses the default GitHub Actions env vars (always set inside a workflow step)
// so the run summary shows the last-run time and links straight to these logs.
// serverUrl / repoSlug / runId / logsUrl are hoisted above the table (the
// artifacts pointer reuses them). The timestamp prefers GitHub's run start time
// when exported, else falls back to render time (both UTC, ISO 8601).
if (logsUrl) {
	const lastRun = (process.env.GITHUB_RUN_STARTED_AT || new Date().toISOString()).replace(/\.\d{3}Z$/, 'Z');
	out.push('');
	out.push(`🕒 Last run: ${lastRun} · [run #${runId}](${logsUrl})`);
}

// ── PR-vs-baseline overview (rendered at the TOP of the run summary) ─────────
// `aggregate` was built up-front (before the gate). It is diffed against the
// baseline aggregate the job fetched from S3 for the PR's base commit, and is
// also written to AGGREGATE_PATH so the job can persist it under
// bench/runs/<sha>/results.json as the baseline a future PR (or this commit,
// once merged to main) will diff against.
// The baseline is whatever the job's "Fetch baseline" step downloaded (the
// exact base commit's aggregate, or the latest-main fallback). It is ABSENT on
// the first runs, on push-to-main (there's nothing earlier to diff), and when
// the OIDC role can't read S3 — every one of those is a benign "no baseline",
// never an error.
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

const overviewLines = [];
if (cells.length > 0) {
	const diff = diffAgainstBaseline(aggregate, baseline);
	let heading = '## Overview — PR vs baseline';
	let note;
	if (baseline) {
		const baseLabel = baseline.sha ? `\`${String(baseline.sha).slice(0, 7)}\`` : 'the base commit';
		// The fetch step falls back to latest-main when the exact base isn't
		// benched; detect that by comparing the baseline's own sha to the PR base.
		const exact =
			baseline.sha && baseSha && (baseline.sha === baseSha || baseline.sha.startsWith(baseSha) || baseSha.startsWith(baseline.sha));
		const src = exact ? `base ${baseLabel}` : `latest \`main\` ${baseLabel} (PR base not benched)`;
		note = `Per-cell composite **delta** vs ${src}. ▲ better · ▼ worse · ≈ within ±5 (likely noise) · 🆕 new cell.`;
	} else if (benchEvent === 'push') {
		heading = '## Overview — baseline run';
		note = `Baseline run (push to \`main\`): these composites are recorded as the baseline for \`${benchSha.slice(0, 7) || '(unknown)'}\`. No earlier baseline to diff against.`;
	} else {
		note = baseSha
			? `_No baseline found for base \`${baseSha.slice(0, 7)}\` (and no latest-\`main\` baseline). Showing absolute composites — the PR-vs-baseline delta appears once a \`main\` bench run has stored one._`
			: '_No baseline available. Showing absolute composites._';
	}
	overviewLines.push(...renderOverview(diff, { heading, note }));
}

// Persist the aggregate so the job can archive it to S3 as the commit-keyed
// baseline. Only when ≥1 cell produced a result, so an empty run never clobbers
// a real baseline for this commit with an empty one.
if (process.env.AGGREGATE_PATH && cells.length > 0) {
	try {
		writeFileSync(process.env.AGGREGATE_PATH, `${JSON.stringify(aggregate, null, 2)}\n`);
	} catch (err) {
		process.stderr.write(`[summary] failed to write aggregate to ${process.env.AGGREGATE_PATH}: ${err?.message ?? err}\n`);
	}
}

// ── Athena NDJSON (one flat line per SCORED cell) ────────────────────────────
// Emit a newline-delimited-JSON file the workflow uploads to a date-partitioned
// Athena prefix (bench/athena/year=YYYY/month=MM/<sha-short>.json), so bench
// history is queryable without parsing per-cell result.json blobs. One line per
// scored cell (same inclusion rule as the headline mean); each line is a FLAT
// record — no nested objects — so it maps cleanly to Athena columns. Best-effort:
// warn and carry on if the write fails, never fail the summary job. The S3 upload
// (and the partition key) live in the workflow step; here we only write the file.
if (process.env.ATHENA_NDJSON_PATH) {
	try {
		const scored = dataCells.filter((c) => isScoredCell(c));
		const ndjson = scored
			.map((r) =>
				JSON.stringify({
					sha: benchSha || null,
					timestamp: aggregate.generated_at,
					event: benchEvent || null,
					pr_number: (process.env.PR_NUMBER ?? '').trim() || null,
					task: r.task ?? null,
					template: r.template ?? null,
					composite: cellComposite(r) ?? 0,
					test_rate: Math.round(testRate(testStats(r)) * 1000) / 1000,
					judge_score: typeof r.judge_score === 'number' ? r.judge_score : null,
					verdict: verdictOf(r),
					klass: r.klass ?? null,
					tokens_in: typeof r.tokens_in === 'number' ? r.tokens_in : null,
					tokens_out: typeof r.tokens_out === 'number' ? r.tokens_out : null,
					duration_sec: typeof r.duration_sec === 'number' ? r.duration_sec : null,
				}),
			)
			.join('\n');
		// Only write when there's at least one scored cell — an empty NDJSON file
		// would upload a 0-row partition object for no reason.
		if (scored.length > 0) writeFileSync(process.env.ATHENA_NDJSON_PATH, `${ndjson}\n`);
	} catch (err) {
		process.stderr.write(`[summary] failed to write Athena NDJSON to ${process.env.ATHENA_NDJSON_PATH}: ${err?.message ?? err}\n`);
	}
}

// Overview first (at-a-glance), then the full scoreboard.
const md = [...overviewLines, ...out].join('\n') + '\n';
if (process.env.GITHUB_STEP_SUMMARY) {
	// A >1MB step summary (GitHub's per-step limit) or any IO error here must NOT
	// turn the check red — fall back to stdout so the summary is still visible.
	try {
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
	} catch (err) {
		process.stderr.write(`[summary] failed to append GITHUB_STEP_SUMMARY (${err?.message ?? err}); writing to stdout instead\n`);
		process.stdout.write(md);
	}
} else {
	process.stdout.write(md);
}

if (gateFailed) {
	process.stderr.write(`[summary] mean composite below BENCH_MIN_SCORE=${minScoreRaw}; failing the gate\n`);
	process.exit(1);
}
