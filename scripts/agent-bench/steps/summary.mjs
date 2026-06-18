// Step "Render summary": read every bench-result-*/result.json downloaded as
// artifacts, render a markdown scoreboard to $GITHUB_STEP_SUMMARY (and a copy
// the workflow posts as a NEW PR comment each run).
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
import { composite, compositeBand, isScoredCell, testRate, testStats, verdictOf } from './lib/scoring.mjs';

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

// Composite for a cell, from the shared formula.
const compositeOf = (r) => composite(testRate(testStats(r)), typeof r.judge_score === 'number' ? r.judge_score : 0);

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
const harnessErrors = cells.filter((c) => c.klass === 'harness_error');

// Judge error on an otherwise-gradeable cell: tracked SEPARATELY from test
// signals so it can never flip the verdict or zero the test_rate. An agent_fail
// (timeout / no app) ran neither the judge nor the tests, so it is NEITHER a
// judge error NOR a test-harness error — it shows as ❌ fail / composite 0 in
// the table; exclude it from both isolation notes below.
const judgeErr = (r) => r.klass !== 'harness_error' && r.klass !== 'agent_fail' && typeof r.judge_score !== 'number';
// Test harness error: tests produced no result on an otherwise-gradeable cell.
const testErr = (r) => r.klass !== 'harness_error' && r.klass !== 'agent_fail' && testStats(r).denom === 0;

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
	const build = truthy(r.build_succeeded) ? '✅' : '❌';
	const judge =
		typeof r.judge_score === 'number'
			? String(r.judge_score)
			: r.klass === 'harness_error' || r.klass === 'agent_fail'
				? '—'
				: 'err';
	let compositeCell = '—';
	if (isScoredCell(r)) {
		const c = compositeOf(r);
		compositeCell = `${c.toFixed(1)} ${compositeBand(c)}`;
	}
	out.push(
		`| ${r.task ?? '—'} | ${r.template ?? '—'} | ${VERDICT_LABEL[verdictOf(r)]} | ${tests} | ${build} | ${judge} | ${compositeCell} | ${r.stop_reason || '—'} |`,
	);
}
out.push('');

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
	const compositeMean = compositeCells.reduce((acc, c) => acc + compositeOf(c), 0) / compositeCells.length;
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
		const compCell = compositeOf(r).toFixed(1);
		out.push(`| ${r.task} | ${r.template} | ${rate} | ${dimsCell(r)} | ${overall} | ${compCell} |`);
	}
	out.push('');
	out.push('</details>');
}

// ── Footer: when the bench last ran + a deep-link back to the workflow run ────
// Uses the default GitHub Actions env vars (always set inside a workflow step)
// so the PR comment shows the last-run time and links straight to these logs.
// It lives in the rendered markdown so it travels with BOTH the job summary and
// the PR comment. The timestamp prefers GitHub's run start time when exported,
// else falls back to render time (both UTC, ISO 8601).
const serverUrl = process.env.GITHUB_SERVER_URL;
const repoSlug = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
if (serverUrl && repoSlug && runId) {
	const lastRun = (process.env.GITHUB_RUN_STARTED_AT || new Date().toISOString()).replace(/\.\d{3}Z$/, 'Z');
	const logsUrl = `${serverUrl}/${repoSlug}/actions/runs/${runId}`;
	out.push('');
	out.push(`🕒 Last run: ${lastRun} · [run #${runId}](${logsUrl})`);
}

const md = out.join('\n') + '\n';
if (process.env.GITHUB_STEP_SUMMARY) {
	appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
} else {
	process.stdout.write(md);
}
// Persist a standalone copy so a later workflow step can post the identical
// table as a NEW PR comment (each step gets its own $GITHUB_STEP_SUMMARY file,
// so it can't be read back across steps).
//
// Only write it when at least one cell actually produced a result. The bench
// matrix is skipped whenever the gating label is absent (e.g. a plain push to
// the PR), in which case zero artifacts are downloaded and `cells` is empty.
// Writing the "no results" table here would make the post step publish a
// spurious empty "no results" comment. Leaving the file unwritten makes that
// step's readFileSync hit ENOENT, which it already treats as "nothing to post"
// (it leaves any prior comment intact), so no empty comment is posted and the
// job still exits 0.
if (process.env.SUMMARY_MD_PATH && cells.length > 0) {
	writeFileSync(process.env.SUMMARY_MD_PATH, md);
}

if (gateFailed) {
	process.stderr.write(`[summary] mean composite below BENCH_MIN_SCORE=${minScoreRaw}; failing the gate\n`);
	process.exit(1);
}
