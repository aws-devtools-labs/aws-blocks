// "Render summary": read every bench-result-*/result.json artifact and render a markdown report to
// $GITHUB_STEP_SUMMARY (ONE results table with a value + colored delta per metric, glossary on top;
// exec summary/analysis appended later by analyze.mjs). N=1 per cell. Formulas live in ./lib/scoring.mjs.
// Baseline = most recent main bench (bench/runs/latest-main.json). Headline = mean composite over
// scored cells; observational unless BENCH_MIN_SCORE gates.
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cellCost, compositeBand, isScoredCell, scorePerDollar, testRate, testStats, verdictOf } from './lib/scoring.mjs';
import { buildAggregate, cellComposite, deltaBall, diffAgainstBaseline, renderDetailed, renderOverview } from './lib/overview.mjs';
import { evaluateGates } from './lib/gates.mjs';

const RESULTS_DIR = process.env.RESULTS_DIR ?? 'results';

// Matrix may be skipped (no gating label) so the dir may never exist — treat missing as "no results".
let dirs = [];
try {
	dirs = readdirSync(RESULTS_DIR).filter((d) => d.startsWith('bench-result-'));
} catch (err) {
	if (err?.code !== 'ENOENT') throw err;
}

// Write a minimal fallback comment NOW, before the risky rendering below, so the always() comment
// step has something to post if summary.mjs throws mid-render: a "failed to render" stub instead of
// silently leaving a red check with no explanation on the PR. The full report overwrites this on the
// normal path. Skip it entirely when the matrix produced ZERO result artifacts AND no gate could
// block (a path-filtered run the bench never ran for) — such a run should leave no PR comment at all;
// the final write below applies the same "something to report" guard.
const anyGateEnv = ['BENCH_MIN_SCORE', 'BENCH_MAX_REGRESSION', 'BENCH_MAX_HARNESS_ERRORS'].some(
	(k) => (process.env[k] ?? '').trim() !== '',
);
const benchJobFailedEnv = ['BENCH_JOB_RESULT', 'BENCH_BUILD_RESULT'].some((k) => {
	const v = (process.env[k] ?? '').trim();
	return v !== '' && v !== 'success' && v !== 'skipped' && v !== 'cancelled';
});
const shouldComment = dirs.length > 0 || anyGateEnv || benchJobFailedEnv;
if (process.env.COMMENT_MD_PATH && shouldComment) {
	try {
		const runId = process.env.GITHUB_RUN_ID;
		const repo = process.env.GITHUB_REPOSITORY;
		const server = process.env.GITHUB_SERVER_URL;
		const link = server && repo && runId ? `${server}/${repo}/actions/runs/${runId}` : 'the Actions run';
		writeFileSync(
			process.env.COMMENT_MD_PATH,
			`## Agent Bench\n\n⚠️ The bench summary failed to render — see [the Actions run](${link}) for logs. This comment is a fallback; the check is red because \`summary.mjs\` did not complete.\n`,
		);
	} catch {
		// Best-effort: if even this write fails, the comment step's own empty-file guard handles it.
	}
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
const harnessErrors = dataCells.filter((c) => c.klass === 'harness_error');

// Judge/test harness errors tracked SEPARATELY so they can't flip a verdict or zero a test_rate.
// A counted failure (agent_fail / dead_server) ran neither, so it's excluded from both.
const testErr = (r) => r.klass !== 'harness_error' && !isCountedFailKlass(r.klass) && testStats(r).denom === 0;
const judgeErr = (r) =>
	r.klass !== 'harness_error' &&
	!isCountedFailKlass(r.klass) &&
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

// ── Headline + gates (floor / regression-vs-main / harness) over the composite mean ──
// The three gates live in lib/gates.mjs (pure, unit-tested); each is opt-in via its own env var, so
// an unconfigured repo stays observational — exactly today's behaviour.
const gateResult = evaluateGates(
	{
		meanComposite: aggregate.mean_composite,
		scoredCells: compositeCells.length,
		meanDelta: diff.hasBaseline ? diff.meanDelta : null,
		hasBaseline: diff.hasBaseline,
		// harness_error cells (infra) PLUS unreadable-artifact cells: a corrupt/unreadable result.json
		// is also a broken measurement, so it counts toward the harness ceiling rather than slipping
		// between both harness checks.
		harnessErrors: harnessErrors.length + errorCells.length,
		totalCells: cells.length,
		// The upstream job results, passed by the workflow (success | failure | cancelled | skipped |
		// ''). benchJobFailed is true when EITHER the bench matrix OR its build-blocks dependency
		// genuinely FAILED. This is load-bearing: `bench` has `needs: build-blocks` with no `if:`, so
		// once the workflow is triggered `bench` is only ever 'skipped' because build-blocks
		// failed/skipped — never a per-cell path filter (the path allowlist gates the whole workflow at
		// the caller, before any job runs). So when build-blocks FAILS, GitHub SKIPS bench and
		// BENCH_JOB_RESULT is 'skipped', not 'failure' — the BUILD result is the only signal that the
		// skip was a failure, which is why a failed build-blocks alone trips the whole-run gate (with
		// zero cells). 'cancelled' is NOT a failure: a user-initiated or superseding-commit cancellation
		// left nothing measured on purpose, and reddening it with "nothing was measured" is misleading
		// (the superseding run re-gates). Computed once as benchJobFailedEnv near the top (also gates
		// the comment write).
		benchJobFailed: benchJobFailedEnv,
	},
	{
		minScore: process.env.BENCH_MIN_SCORE,
		maxRegression: process.env.BENCH_MAX_REGRESSION,
		maxHarnessErrors: process.env.BENCH_MAX_HARNESS_ERRORS,
	},
);
const floorGate = gateResult.gates.find((g) => g.name === 'floor');
const gateFailed = gateResult.failed;
// Read the floor's enabled/threshold from the gate result — the parse lives only in gates.mjs, so
// the headline can't drift from the gate decision (e.g. the negative-is-disabled rule).
const floorEnabled = floorGate.enabled;
const min = floorGate.value;

// Builder + judge model ids for the preword's config line (same env the run steps read).
const builderModel = (process.env.BENCH_MODEL ?? '').trim() || null;
const judgeModel = (process.env.BENCH_JUDGE_MODEL ?? '').trim() || null;

// Deterministic headline under the Overview heading (the LLM exec summary is separate, from analyze.mjs).
function headlineLine() {
	if (compositeCells.length === 0) {
		if (cells.length > 0 && harnessErrors.length === cells.length) {
			return `⚠️ All ${cells.length} cell(s) were harness_error — nothing was scored, no composite headline.`;
		}
		const g = floorEnabled ? ` (\`BENCH_MIN_SCORE=${min}\` set, but with no scored cells the floor is skipped — conservative.)` : '';
		return `_No cells produced test results — no composite headline to report._${g}`;
	}
	const g = gateEnabled ? ` (\`BENCH_MIN_SCORE=${min}\` set, but with no scored cells the gate is skipped — conservative.)` : '';
	return `- _No cells produced test results — no composite headline to report._${g}`;
}

// The merge gate over the composite mean (scored cells only). Sets gateFailed; returns a bullet when
// BENCH_MIN_SCORE is set, else an observational note. Called only when there ARE scored cells.
function gateLine() {
	const mean = aggregate.mean_composite;
	const judgeNote = judgeMean !== null ? ` · judge mean **${judgeMean.toFixed(2)}**/10` : '';
	// Composite mean delta vs the baseline (🟢/🔴/🟡 over the ±5 band), when present.
	const deltaNote =
		diff.hasBaseline && diff.meanDelta !== null
			? ` · ${deltaBall(diff.meanDelta)} ${diff.meanDelta > 0 ? '+' : ''}${diff.meanDelta.toFixed(1)} vs \`main\``
			: '';
	const head = `Mean composite **${mean.toFixed(1)}**/100 ${compositeBand(mean)} across ${compositeCells.length} scored cell(s)${judgeNote}${deltaNote}.`;
	if (!floorEnabled) return `${head} _Observational — \`BENCH_MIN_SCORE\` unset, so the floor does not gate the merge._`;
	// Defensive/unreachable: the early return above already handled compositeCells.length === 0, and
	// the floor gate only skips on scoredCells === 0 — so with scored cells present it never skips.
	// Kept so this doesn't silently render a wrong headline if that early return is ever changed.
	if (floorGate.skipped) return `${head} _\`BENCH_MIN_SCORE=${min}\` set, but no scored cells — floor skipped._`;
	const pass = !floorGate.failed;
	return `${pass ? '✅' : '❌'} ${head} Threshold **${min}** — ${pass ? 'pass' : 'FAIL'}.`;
}

// ── Assemble the report ───────────────────────────────────────────────────────
const md = [];

// 1) Glossary & notes — collapsed, at the very top.
const lastRun = (process.env.GITHUB_RUN_STARTED_AT || new Date().toISOString()).replace(/\.\d{3}Z$/, 'Z');
md.push('<details>');
md.push('<summary>📖 Glossary &amp; notes — scoring, indicators, per-metric thresholds (click to expand)</summary>');
md.push('');
md.push('- **N = 1** — one rep per cell, so a small delta may be model variance, not a real change; re-run for certainty.');
md.push(
	'- **Indicators (change vs baseline, per metric):** ✨ noticeably improved · ✅ OK / no significant change (within noise band) · ⚠️ slight regression (beyond 1× threshold) · ❌ serious regression (beyond 2× threshold) · 🆕 new — no baseline value yet (current value shown, tagged `(new)`) · — nothing to show this run · 🗑️ cell gone since the baseline. Each cell shows `<indicator> <value> (<Δ vs main>)` inline.',
);
md.push(
	'- **Columns:** Tests (pass/denom) · Judge (overall 0-10 score with signed delta; per-dimension breakdown lives in the judge artifact JSON) · Cost · Turns (agent cycles) · Score · Stop reason.',
);
md.push(
	'- **Threshold definitions (per metric, `DELTA_THRESHOLDS` in `overview.mjs`):**',
);
md.push(
	'  - composite/score: **±5 points** — a change ≤5 pts is ✅; >5 improving is ✨; >5 worsening is ⚠️; >10 worsening is ❌.',
);
md.push(
	'  - judge (overall + each dimension): **±0.3** — a shift ≤0.3 is ✅; >0.3 improving is ✨; >0.3 worsening is ⚠️; >0.6 worsening is ❌.',
);
md.push(
	'  - tests: **±1 pass** — a ≤1 pass change is ✅; >1 improving is ✨; >1 worsening is ⚠️; >2 worsening is ❌.',
);
md.push(
	'  - cost: **±10% of baseline** (floor $0.02) — within 10% is ✅; >10% cheaper is ✨; >10% more expensive is ⚠️; >20% more expensive is ❌.',
);
md.push(
	'  - turns: **±3 cycles** — a ≤3 turn change is ✅; >3 fewer is ✨; >3 more is ⚠️; >6 more is ❌.',
);
md.push(
	'- **Directions:** higher is better for tests, judge (+ dimensions), and score; lower is better for cost and turns.',
);
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
	'- **Excluded from the mean:** `harness_error` cells (infra failures) and gradeable cells that ran no tests. `agent_fail` (agent produced no app in budget) and `dead_server` (built app never served / crashed) are BOTH included, as composite 0.',
);
if (logsUrl) md.push(`- [Run artifacts — per-cell source + full agent traces](${logsUrl}) · 🕒 Last run: ${lastRun} · run #${runId}`);
md.push('');
md.push('</details>');
md.push('');

// 2) Results — one table: current value + colored delta per metric, headline underneath the heading.
if (cells.length > 0) {
	let heading = '## Results — PR vs `main` baseline';
	let note;
	const legend = '✨ improved · ✅ within noise · ⚠️ slight regression · ❌ serious regression · 🆕 no baseline yet (value shown, tagged `(new)`).';
	const baseLabel = baseline?.sha ? `\`${String(baseline.sha).slice(0, 7)}\`` : 'the recorded baseline';
	if (benchEvent === 'push') {
		// A push-to-main run IS the new baseline; diffs against the previous main bench, else absolute.
		heading = '## Results — baseline run';
		const rec = `Baseline run (push to \`main\`): recorded as the new \`main\` baseline for \`${benchSha.slice(0, 7) || '(unknown)'}\`.`;
		note = baseline
			? `${rec} Each metric colored vs the PREVIOUS \`main\` baseline ${baseLabel}. ${legend}`
			: `${rec} No earlier baseline to diff — current values only (every metric 🆕).`;
	} else if (baseline) {
		note = `Each metric shows its current value colored by the change vs the latest \`main\` baseline ${baseLabel}. ${legend}`;
	} else {
		note = 'No `main` baseline recorded yet — showing current values only (every metric 🆕). Deltas vs `main` appear once a `main` bench has stored one.';
	}
	md.push(heading, '');
	md.push(note, '');
	// Bulleted aggregated summary (preword) directly under the heading, above the table.
	if (compositeCells.length === 0) {
		md.push(noScoreMessage(), '');
	} else {
		md.push(...renderPreword(diff, aggregate, { builderModel, judgeModel, baselineSha: baseline?.sha }));
		md.push(`- ${gateLine()}`);
		md.push('');
	}
	md.push(...renderDetailed(diff, {}));
}

// 3b) Merge verdict — the gate decisions (only shown when at least one gate is enabled).
const enabledGates = gateResult.gates.filter((g) => g.enabled);
if (enabledGates.length > 0) {
	md.push('## Merge verdict', '');
	md.push(gateFailed ? '❌ **This bench run BLOCKS the PR.**' : '✅ **This bench run does not block the PR.**', '');
	for (const g of enabledGates) {
		const icon = g.failed ? '❌' : g.skipped ? '⚪' : '✅';
		const label = g.name === 'floor' ? 'Absolute floor' : g.name === 'regression' ? 'Regression vs `main`' : 'Harness (infra) failures';
		md.push(`- ${icon} **${label}** — ${g.reason}`);
	}
	// The Δ-vs-base ball in the tables is a FIXED ±5-pt cosmetic band; the regression GATE uses the
	// configurable BENCH_MAX_REGRESSION. They can disagree (a 🟡 "flat" ball with a failing gate at a
	// tighter limit) — the ball is display, the gate threshold is what blocks.
	if (enabledGates.some((g) => g.name === 'regression')) {
		md.push('', '_The `Δ vs base` ball above is a fixed ±5-pt display band; the regression gate uses `BENCH_MAX_REGRESSION`. The ball is cosmetic — the gate threshold is what blocks._');
	}
	md.push('');
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

// Write the SAME rendered report to a file the workflow posts as a sticky PR comment. Best-effort:
// a write failure never reds the job — the step summary above already has the report, and the gate
// exit below is what actually blocks. Skipped on a path-filtered no-results run (shouldComment=false)
// so the bench leaves no comment on a PR it never ran for.
if (process.env.COMMENT_MD_PATH && shouldComment) {
	try {
		writeFileSync(process.env.COMMENT_MD_PATH, out);
	} catch (err) {
		process.stderr.write(`[summary] failed to write comment markdown to ${process.env.COMMENT_MD_PATH}: ${err?.message ?? err}\n`);
	}
}

if (gateFailed) {
	const failed = gateResult.gates.filter((g) => g.failed).map((g) => `${g.name}: ${g.reason}`).join(' | ');
	process.stderr.write(`[summary] merge gate FAILED — ${failed}\n`);
	process.exit(1);
}
