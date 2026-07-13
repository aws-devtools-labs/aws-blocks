// "Render summary": read every bench-result-*/result.json artifact and render a markdown report to
// $GITHUB_STEP_SUMMARY (ONE results table with a value + colored delta per metric, glossary on top;
// exec summary/analysis appended later by analyze.mjs). N=1 per cell. Formulas live in ./lib/scoring.mjs.
// Baseline = most recent main bench (bench/runs/latest-main.json). Headline = mean composite over
// scored cells; observational unless BENCH_MIN_SCORE gates.
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cellCost, compositeBand, isScoredCell, scorePerDollar, testRate, testStats, verdictOf } from './lib/scoring.mjs';
import { buildAggregate, cellComposite, deltaBall, diffAgainstBaseline, renderDetailed } from './lib/overview.mjs';

const RESULTS_DIR = process.env.RESULTS_DIR ?? 'results';

// Matrix may be skipped (no gating label) so the dir may never exist — treat missing as "no results".
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
		// No parseable result.json — surface the raw artifact suffix (names can't be split reliably).
		return { task: d.replace('bench-result-', ''), template: '', error: 'unreadable' };
	}
});

// ── Buckets ──────────────────────────────────────────────────────────────────
const dataCells = cells.filter((c) => !c.error);
const errorCells = cells.filter((c) => c.error);
// A cell enters the composite mean iff gradeable AND it produced test results (via isScoredCell).
const compositeCells = dataCells.filter((c) => isScoredCell(c));
const judgeScoredCells = dataCells.filter((c) => c.klass !== 'harness_error' && typeof c.judge_score === 'number');
const harnessErrors = dataCells.filter((c) => c.klass === 'harness_error');

// Judge/test harness errors tracked SEPARATELY so they can't flip a verdict or zero a test_rate.
// An agent_fail ran neither, so it's excluded from both.
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

// Deterministic headline under the Overview heading (the LLM exec summary is separate, from analyze.mjs).
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
	// Composite mean delta vs the baseline (🟢/🔴/🟡 over the ±5 band), when present.
	const deltaNote =
		diff.hasBaseline && diff.meanDelta !== null
			? ` · ${deltaBall(diff.meanDelta)} ${diff.meanDelta > 0 ? '+' : ''}${diff.meanDelta.toFixed(1)} vs \`main\``
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
md.push('<summary>📖 Glossary &amp; notes — scoring, colors, per-metric thresholds (click to expand)</summary>');
md.push('');
md.push('- **N = 1** — one rep per cell, so a small delta may be model variance, not a real change; re-run for certainty.');
md.push(
	'- **Colors (change vs baseline, per metric):** 🟢 meaningful improvement · 🟡 change within the noise band · 🔴 meaningful regression · ⚪ no baseline value yet (a new cell, or a metric the baseline predates) — the current value is still shown, tagged `(new)` · — nothing to show this run · 🗑️ cell gone since the baseline. Each cell shows the current value on top and the signed delta vs `main` below it.',
);
md.push(
	'- **Thresholds (per metric, `DELTA_THRESHOLDS` in `overview.mjs`):** composite/score ±5 points · judge ±0.3 · tests ±1 pass · cost ±10% · tokens ±10% (in+out combined). A change within the threshold is 🟡 (noise, since N=1); beyond it, 🟢/🔴 by direction. Edit that one map to tune them.',
);
md.push('- **Directions:** higher is better for tests, judge, and score; lower is better for cost and tokens.');
md.push(
	'- **Composite (0-100)** = `round(60·test_rate + 4·judge·min(1, 4·test_rate), 1)` — 60% objective pass-rate + 40% judge, the judge term gated below a 25% pass-rate.',
);
md.push('- **Cost** = builder token spend at Bedrock Claude Opus 4.8 rates ($5 in / $25 out per 1M tokens; `BUILDER_PRICING` in `scoring.mjs`).');
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

// 2) Results — one table: current value + colored delta per metric, headline underneath the heading.
if (cells.length > 0) {
	let heading = '## Results — PR vs `main` baseline';
	let note;
	const legend = '🟢 improved · 🟡 within noise · 🔴 regressed · ⚪ no baseline yet (value shown, tagged `(new)`).';
	const baseLabel = baseline?.sha ? `\`${String(baseline.sha).slice(0, 7)}\`` : 'the recorded baseline';
	if (benchEvent === 'push') {
		// A push-to-main run IS the new baseline; diffs against the previous main bench, else absolute.
		heading = '## Results — baseline run';
		const rec = `Baseline run (push to \`main\`): recorded as the new \`main\` baseline for \`${benchSha.slice(0, 7) || '(unknown)'}\`.`;
		note = baseline
			? `${rec} Each metric colored vs the PREVIOUS \`main\` baseline ${baseLabel}. ${legend}`
			: `${rec} No earlier baseline to diff — current values only (every metric ⚪).`;
	} else if (baseline) {
		note = `Each metric shows its current value colored by the change vs the latest \`main\` baseline ${baseLabel}. ${legend}`;
	} else {
		note = 'No `main` baseline recorded yet — showing current values only (every metric ⚪). Colored deltas vs `main` appear once a `main` bench has stored one.';
	}
	md.push(heading, '');
	md.push(note, '');
	// Deterministic headline directly under the heading, above the table.
	md.push(headlineLine(), '');
	md.push(...renderDetailed(diff, {}));
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

// Persist aggregate (S3 baseline) + Athena NDJSON. Only when ≥1 cell produced a result, so an empty
// run never clobbers a real baseline.
if (process.env.AGGREGATE_PATH && cells.length > 0) {
	try {
		writeFileSync(process.env.AGGREGATE_PATH, `${JSON.stringify(aggregate, null, 2)}\n`);
	} catch (err) {
		process.stderr.write(`[summary] failed to write aggregate to ${process.env.AGGREGATE_PATH}: ${err?.message ?? err}\n`);
	}
}

// One flat NDJSON line per SCORED cell for the Athena prefix. Best-effort: warn and carry on.
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
	// A >1MB step summary or any IO error must NOT turn the check red — fall back to stdout.
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
