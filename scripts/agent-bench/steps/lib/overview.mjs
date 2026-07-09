// PR-vs-baseline overview + detailed-results helpers, kept as PURE functions (no
// fs / env / process side effects) so the diff math + coloring are unit-testable
// under bare `node --test`, the same way lib/scoring.mjs is. summary.mjs does the
// I/O (read the downloaded baseline, write the new aggregate, append markdown to
// $GITHUB_STEP_SUMMARY) and calls these to render the two report tables.
//
// The baseline is a small commit-keyed aggregate (built by buildAggregate and
// persisted to S3 as bench/runs/latest-main.json — the MOST RECENT main-branch
// bench). A PR run fetches that pointer and renders the delta so the PR's effect
// vs the current state of `main` is obvious. No baseline → the tables render the
// PR's absolute numbers, every cell flagged 🆕 (never an error).
//
// TWO tables from the SAME rows:
//   - renderOverview  — colors ONLY (🟢/🟡/🔴), at-a-glance.
//   - renderDetailed  — the same rows widened WITH numbers (baseline -> pr).
//
// COLOR SEMANTICS (per metric, vs baseline): 🟢 same-or-better · 🟡 worse but
// within the margin · 🔴 worse beyond it. The margin is a SINGLE tunable,
// MARGIN_PCT (5%). Directions: tests↑ judge↑ score↑ are better; cost↓ tokens↓
// are better. See metricColor + the glossary in summary.mjs.
//
// Composite, cost, and score-per-$ all come from lib/scoring.mjs — the ONE
// source of truth — so the aggregate's numbers can't drift from the tables.
import {
	SCORE_PER_DOLLAR,
	cellCost,
	composite,
	isScoredCell,
	scorePerDollar,
	testRate,
	testStats,
	verdictOf,
} from './scoring.mjs';

// Stable identity for a cell across runs: a baseline cell is matched to the
// current cell by this key. Both task + template are part of it because a task
// can in principle run on more than one template.
export const cellKey = (c) => `${c?.task ?? ''}/${c?.template ?? ''}`;

const round1 = (n) => Math.round(n * 10) / 10;
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ── Color engine ─────────────────────────────────────────────────────────────
export const GREEN = '🟢';
export const YELLOW = '🟡';
export const RED = '🔴';
export const NEW = '🆕';
export const GONE = '🗑️';
export const NONE = '—';

// The SINGLE tunable that separates 🟡 (worse, but within noise) from 🔴 (worse
// beyond it): a relative margin of 5%. Change ONLY this line to widen/narrow the
// tolerance for EVERY metric.
export const MARGIN_PCT = 0.05;

// DEFAULT boundary policy: a metric that is worse-but-within-margin renders 🟡.
// Set true to treat within-margin as 🟢 (equal-or-better-OR-within-margin = 🟢).
export const MARGIN_IS_GREEN = false;

// SCORE is higher-better iff scoring.mjs computes it as composite-per-$ (the
// default). Imported so the ONE knob in scoring.mjs also drives the color here.
export const SCORE_HIGHER_BETTER = SCORE_PER_DOLLAR;

/**
 * The absolute tolerance around a baseline value below which a WORSE move is
 * still 🟡 (noise) rather than 🔴. `MARGIN_PCT` of |baseline|; for INTEGER
 * metrics (test counts, 0-10 judge dims) it is floored to 1, so a ±1 nudge on a
 * small integer metric always reads as within-margin — 5% of 8 is 0.4, which
 * would otherwise round to 0 and make every single-point drop red.
 * @param {number} baseline
 * @param {boolean} integer
 * @returns {number}
 */
export function marginAbs(baseline, integer) {
	const raw = Math.abs(baseline) * MARGIN_PCT;
	return integer ? Math.max(1, Math.round(raw)) : raw;
}

/**
 * Color one metric vs its baseline. Returns 🟢/🟡/🔴, or `null` when either side
 * is missing (the caller then renders 🆕 for a new cell / — for nothing to diff).
 *   - `direction` 'up'   → higher is better (tests, judge, score)
 *   - `direction` 'down' → lower is better  (cost, tokens)
 * Equal counts as better (🟢). A worse move within {@link marginAbs} is 🟡 (or
 * 🟢 when MARGIN_IS_GREEN); beyond it, 🔴.
 * @param {number|null|undefined} baseline
 * @param {number|null|undefined} pr
 * @param {{direction?: 'up'|'down', integer?: boolean}} [opts]
 * @returns {'🟢'|'🟡'|'🔴'|null}
 */
export function metricColor(baseline, pr, opts = {}) {
	const direction = opts.direction ?? 'up';
	const integer = opts.integer ?? false;
	if (baseline === null || baseline === undefined || Number.isNaN(baseline)) return null;
	if (pr === null || pr === undefined || Number.isNaN(pr)) return null;
	const better = direction === 'up' ? pr >= baseline : pr <= baseline;
	if (better) return GREEN;
	const worseBy = direction === 'up' ? baseline - pr : pr - baseline; // > 0
	return worseBy <= marginAbs(baseline, integer) ? (MARGIN_IS_GREEN ? GREEN : YELLOW) : RED;
}

// ── Cell scoring (shared with the mean/headline) ─────────────────────────────
/**
 * Composite (0..100) for a cell from the shared scoring formula, or `null` when
 * the cell isn't scored (a harness_error, or a gradeable cell that ran no tests).
 * @param {object} r a finalized result.json cell
 * @returns {number|null}
 */
export function cellComposite(r) {
	if (!isScoredCell(r)) return null;
	return composite(testRate(testStats(r)), typeof r?.judge_score === 'number' ? r.judge_score : 0);
}

/**
 * Mean composite over the SCORED cells only (same inclusion rule as the
 * headline), rounded to 1 decimal; `null` when no cell was scored.
 * @param {object[]} cells
 * @returns {number|null}
 */
export function meanComposite(cells) {
	const scored = (cells ?? []).filter((c) => isScoredCell(c));
	if (scored.length === 0) return null;
	const sum = scored.reduce((acc, c) => acc + cellComposite(c), 0);
	return round1(sum / scored.length);
}

// ── Aggregate (schema 2) ─────────────────────────────────────────────────────
/**
 * Build the compact, self-describing aggregate persisted to S3 as the
 * commit-keyed baseline. Schema 2 holds everything the two report tables diff
 * against — per cell: the base composite + verdict/klass, the test counts, the
 * judge overall + per-dimension scores, the builder token spend, its $ cost, and
 * the score-per-$ — plus the mean and provenance (sha / event) for auditing.
 * Artifact-unreadable cells (carrying an `error` field) are dropped.
 *
 * Back-compat: a schema-1 baseline (composite/judge_score/test_rate only) still
 * diffs — the fields it lacks simply render 🆕/— on the baseline side until a
 * `main` bench records a schema-2 baseline.
 * @param {object[]} cells finalized result.json cells for this run
 * @param {{sha?: string, base_sha?: string, pr_number?: string, event?: string, generated_at?: string}} [meta]
 * @returns {object}
 */
export function buildAggregate(cells, meta = {}) {
	const data = (cells ?? []).filter((c) => c && !c.error);
	return {
		schema: 2,
		sha: meta.sha ?? null,
		base_sha: meta.base_sha ?? null,
		pr_number: meta.pr_number ?? null,
		event: meta.event ?? null,
		generated_at: meta.generated_at ?? null,
		mean_composite: meanComposite(data),
		scored_cells: data.filter((c) => isScoredCell(c)).length,
		cells: data
			.map((c) => {
				const comp = cellComposite(c);
				const cost = cellCost(c);
				const { passed, denom } = testStats(c);
				return {
					task: c.task ?? null,
					template: c.template ?? null,
					composite: comp,
					verdict: verdictOf(c),
					klass: c.klass ?? null,
					judge_score: numOrNull(c.judge_score),
					test_rate: round1(testRate(testStats(c)) * 100) / 100,
					tests_passed: passed,
					tests_denom: denom,
					judge_dimensions:
						c.judge_dimensions && typeof c.judge_dimensions === 'object' ? c.judge_dimensions : null,
					tokens_in: numOrNull(c.tokens_in),
					tokens_out: numOrNull(c.tokens_out),
					cost,
					score: scorePerDollar(comp, cost),
					stop_reason: typeof c.stop_reason === 'string' && c.stop_reason ? c.stop_reason : null,
				};
			})
			.sort((a, b) => cellKey(a).localeCompare(cellKey(b))),
	};
}

/**
 * Direction marker for a COMPOSITE delta (used by the headline + the roll-up).
 * ±5 near-equal band (wide on purpose: N=1, so a small delta is as likely model
 * variance as a real change). `''` for a missing/NaN delta.
 * @param {number|null} delta
 * @returns {'▲'|'▼'|'≈'|''}
 */
export function deltaArrow(delta) {
	if (delta === null || delta === undefined || Number.isNaN(delta)) return '';
	if (delta > 5) return '▲';
	if (delta < -5) return '▼';
	return '≈';
}

// The metric fields the two tables read, defaulted to null so a schema-1 (or
// partial) baseline cell degrades gracefully to 🆕/— instead of throwing.
function cellMetrics(c) {
	return {
		composite: numOrNull(c?.composite),
		tests_passed: numOrNull(c?.tests_passed),
		tests_denom: numOrNull(c?.tests_denom),
		judge_score: numOrNull(c?.judge_score),
		judge_dimensions: c?.judge_dimensions && typeof c.judge_dimensions === 'object' ? c.judge_dimensions : null,
		tokens_in: numOrNull(c?.tokens_in),
		tokens_out: numOrNull(c?.tokens_out),
		cost: numOrNull(c?.cost),
		score: numOrNull(c?.score),
		stop_reason: typeof c?.stop_reason === 'string' && c.stop_reason ? c.stop_reason : null,
	};
}

/**
 * True iff the baseline aggregate can supply the schema-2 PER-METRIC set the two
 * tables diff (tests pass-counts, per-dimension judge, tokens, cost, score) —
 * i.e. it is schema 2+.
 *
 * WHY THIS GATE EXISTS: a schema-1 (pre-redesign) baseline persisted only
 * `composite`, `judge_score`, and `test_rate` per cell. Coloring each metric
 * independently against it lights up ONLY the fields it happens to carry
 * (`judge_score` → Judge colors) while every other column has no baseline value
 * (→ 🆕). That produced the inconsistent "Judge colored, Tests/Cost/Tokens/Score
 * all 🆕" row. So Judge must gate on baseline-COMPLETENESS exactly like the other
 * metrics: a partial (schema-1) baseline is treated as "no per-metric baseline"
 * — every column, Judge included, renders 🆕 — until a `main` bench records a
 * schema-2 baseline. The composite mean/delta still uses `composite` (present in
 * schema 1) for the headline + analysis roll-up.
 * @param {object|null|undefined} baseline
 * @returns {boolean}
 */
export function baselineHasMetrics(baseline) {
	return !!baseline && (numOrNull(baseline.schema) ?? 0) >= 2;
}

/**
 * Diff the current run's aggregate against a baseline aggregate (or `null`).
 * Cells are matched by {@link cellKey}. Each row carries the COMPOSITE delta
 * (`current`/`baseline`/`delta`, kept for the headline + the analysis roll-up)
 * PLUS `pr` and `base` metric objects (from {@link cellMetrics}) the two tables
 * color and render. `base` is populated ONLY when the baseline carries the
 * schema-2 per-metric set ({@link baselineHasMetrics}); against a schema-1
 * baseline every metric — Judge included — renders 🆕 for consistency. A
 * baseline-only cell surfaces as a `removed` row.
 * @param {object} current aggregate from {@link buildAggregate} for this run
 * @param {object|null} baseline aggregate fetched for the base commit, or null
 * @returns {{rows: object[], meanCurrent: number|null, meanBaseline: number|null, meanDelta: number|null, hasBaseline: boolean, perMetricBaseline: boolean}}
 */
export function diffAgainstBaseline(current, baseline) {
	const perMetricBaseline = baselineHasMetrics(baseline);
	const baseCells = new Map((baseline?.cells ?? []).map((c) => [cellKey(c), c]));
	const curKeys = new Set((current?.cells ?? []).map((c) => cellKey(c)));
	const rows = (current?.cells ?? []).map((c) => {
		const key = cellKey(c);
		const base = baseCells.get(key);
		const cur = numOrNull(c.composite);
		const bas = base ? numOrNull(base.composite) : null;
		const delta = cur !== null && bas !== null ? round1(cur - bas) : null;
		return {
			key,
			task: c.task ?? null,
			template: c.template ?? null,
			current: cur,
			baseline: bas,
			delta,
			hasBaselineCell: !!base,
			removed: false,
			pr: cellMetrics(c),
			// Only diff per-metric against a schema-2 baseline; a schema-1 baseline
			// (composite/judge_score only) is NOT per-metric-comparable, so every
			// column renders 🆕 rather than lighting up Judge alone.
			base: base && perMetricBaseline ? cellMetrics(base) : null,
		};
	});
	// Baseline-only cells (removed/renamed since the baseline) get their OWN row
	// so a dropped cell is VISIBLE instead of silently vanishing.
	for (const [key, base] of baseCells) {
		if (curKeys.has(key)) continue;
		rows.push({
			key,
			task: base.task ?? null,
			template: base.template ?? null,
			current: null,
			baseline: numOrNull(base.composite),
			delta: null,
			hasBaselineCell: true,
			removed: true,
			pr: null,
			base: perMetricBaseline ? cellMetrics(base) : null,
		});
	}
	rows.sort((a, b) => a.key.localeCompare(b.key));
	const meanCurrent = numOrNull(current?.mean_composite);
	const meanBaseline = baseline ? numOrNull(baseline.mean_composite) : null;
	const meanDelta = meanCurrent !== null && meanBaseline !== null ? round1(meanCurrent - meanBaseline) : null;
	return { rows, meanCurrent, meanBaseline, meanDelta, hasBaseline: !!baseline, perMetricBaseline };
}

// ── Formatters ───────────────────────────────────────────────────────────────
/** Compact token count: 3456 → "3.5K", 3000 → "3K", 800 → "800", null → "—". */
export function humanTokens(n) {
	if (n === null || n === undefined || Number.isNaN(n)) return NONE;
	if (n < 1000) return String(Math.round(n));
	return `${+(n / 1000).toFixed(1)}K`;
}

/** USD, trailing zeros trimmed: 3.5 → "$3.5", 2 → "$2", 1.05 → "$1.05", null → "—". */
export function fmtCost(c) {
	if (c === null || c === undefined || Number.isNaN(c)) return NONE;
	return `$${+c.toFixed(2)}`;
}

/** Score-per-$ to 1 decimal: 66.7 → "66.7", null → "—". */
export function fmtScore(s) {
	if (s === null || s === undefined || Number.isNaN(s)) return NONE;
	return String(+s.toFixed(1));
}

// The metric spec shared by BOTH renderers so a metric is colored/directed
// identically in the Overview and the Detailed table. `pick` reads the value
// off a cellMetrics object; `format` renders it for the Detailed table.
const SCORE_DIR = SCORE_HIGHER_BETTER ? 'up' : 'down';

// Glyph for the colors-only Overview: the metric color, else 🆕 (scored now, no
// baseline value) / — (nothing to diff this run).
function overviewGlyph(baseVal, prVal, opts) {
	if (prVal === null || prVal === undefined) return NONE;
	const col = metricColor(baseVal, prVal, opts);
	if (col) return col;
	return baseVal === null || baseVal === undefined ? NEW : NONE;
}

// "baseline -> pr" for the Detailed table, colored. `fmtVal` formats each side.
function detailPair(baseVal, prVal, fmtVal, opts) {
	if (prVal === null || prVal === undefined) return NONE;
	const col = metricColor(baseVal, prVal, opts);
	if (col === null) return `${NEW} ${fmtVal(prVal)}`; // scored now, no baseline
	return `${col} ${fmtVal(baseVal)} -> ${fmtVal(prVal)}`;
}

// Union of judge-dimension keys across baseline + pr, in a stable order (pr
// first, then any baseline-only dims), so the multi-line judge cell is consistent.
function dimKeys(baseDims, prDims) {
	const keys = [];
	for (const k of Object.keys(prDims ?? {})) if (!keys.includes(k)) keys.push(k);
	for (const k of Object.keys(baseDims ?? {})) if (!keys.includes(k)) keys.push(k);
	return keys;
}

// Multi-line judge cell for the Detailed table: one "<color> <dim> base -> pr"
// line per dimension, joined with <br> (GitHub renders it as a line break in a
// table cell).
function judgeDetailCell(base, pr) {
	const baseDims = base?.judge_dimensions ?? null;
	const prDims = pr?.judge_dimensions ?? null;
	const keys = dimKeys(baseDims, prDims);
	if (keys.length === 0) return NONE;
	const lines = keys.map((k) => {
		const bv = baseDims ? numOrNull(baseDims[k]) : null;
		const pv = prDims ? numOrNull(prDims[k]) : null;
		if (pv === null) return `${NONE} ${k} ${bv ?? NONE} -> ${NONE}`;
		const col = metricColor(bv, pv, { direction: 'up', integer: true });
		if (col === null) return `${NEW} ${k} ${pv}`;
		return `${col} ${k} ${bv} -> ${pv}`;
	});
	return lines.join('<br>');
}

// ── Render: Overview (colors only) ───────────────────────────────────────────
/**
 * Colors-only, at-a-glance overview: TASK | TEMPLATE | TESTS | JUDGE | COST |
 * TOKENS (in/out) | SCORE, one 🟢/🟡/🔴 glyph per metric vs baseline (🆕 new,
 * — nothing to diff). No numbers — see {@link renderDetailed} for those.
 * @param {ReturnType<typeof diffAgainstBaseline>} diff
 * @param {{heading?: string, note?: string}} [opts]
 * @returns {string[]}
 */
export function renderOverview(diff, opts = {}) {
	const lines = [opts.heading ?? '## Overview', ''];
	if (opts.note) lines.push(opts.note, '');
	lines.push(
		'| Task | Template | Tests | Judge | Cost | Tokens (in/out) | Score |',
		'|------|----------|:-----:|:-----:|:----:|:---------------:|:-----:|',
	);
	for (const r of diff.rows) {
		if (r.removed) {
			lines.push(`| ${r.task ?? NONE} | ${r.template ?? NONE} | ${GONE} | ${GONE} | ${GONE} | ${GONE} | ${GONE} |`);
			continue;
		}
		const b = r.base;
		const p = r.pr ?? {};
		const tests = overviewGlyph(b?.tests_passed, p.tests_passed, { direction: 'up', integer: true });
		const judge = overviewGlyph(b?.judge_score, p.judge_score, { direction: 'up' });
		const cost = overviewGlyph(b?.cost, p.cost, { direction: 'down' });
		const tin = overviewGlyph(b?.tokens_in, p.tokens_in, { direction: 'down' });
		const tout = overviewGlyph(b?.tokens_out, p.tokens_out, { direction: 'down' });
		const score = overviewGlyph(b?.score, p.score, { direction: SCORE_DIR });
		lines.push(
			`| ${r.task ?? NONE} | ${r.template ?? NONE} | ${tests} | ${judge} | ${cost} | ${tin}/${tout} | ${score} |`,
		);
	}
	lines.push('');
	return lines;
}

// ── Render: Detailed results (numbers) ───────────────────────────────────────
/**
 * The same rows as {@link renderOverview}, widened WITH numbers: TASK | TEMPLATE
 * | TESTS (🟡 10/14 -> 9/14) | JUDGE (one colored dim per line) | COST (🟢 $3.5
 * -> $2) | TOKENS (in/out, each colored) | SCORE (colored base -> pr) | STOP
 * REASON. Colors + directions are identical to the Overview.
 * @param {ReturnType<typeof diffAgainstBaseline>} diff
 * @param {{heading?: string, note?: string}} [opts]
 * @returns {string[]}
 */
export function renderDetailed(diff, opts = {}) {
	const lines = [opts.heading ?? '## Detailed results', ''];
	if (opts.note) lines.push(opts.note, '');
	lines.push(
		'| Task | Template | Tests | Judge | Cost | Tokens | Score | Stop reason |',
		'|------|----------|-------|-------|------|--------|-------|-------------|',
	);
	for (const r of diff.rows) {
		if (r.removed) {
			const was = r.base && r.base.tests_passed !== null ? ` (was ${r.base.tests_passed}/${r.base.tests_denom})` : '';
			lines.push(`| ${r.task ?? NONE} | ${r.template ?? NONE} | ${GONE} removed${was} | ${NONE} | ${NONE} | ${NONE} | ${NONE} | ${NONE} |`);
			continue;
		}
		const b = r.base;
		const p = r.pr ?? {};
		// TESTS is a "passed/denom" string colored by the passed COUNT (not a
		// scalar), so it's built explicitly rather than via detailPair.
		const fmtTests = (m) => `${m.tests_passed ?? NONE}/${m.tests_denom ?? NONE}`;
		let testsCell;
		if (p.tests_passed === null || p.tests_passed === undefined || p.tests_denom === 0) {
			testsCell = NONE;
		} else if (!b || b.tests_passed === null) {
			testsCell = `${NEW} ${fmtTests(p)}`;
		} else {
			const col = metricColor(b.tests_passed, p.tests_passed, { direction: 'up', integer: true });
			testsCell = `${col} ${fmtTests(b)} -> ${fmtTests(p)}`;
		}
		const judge = judgeDetailCell(b, p);
		const cost = detailPair(b?.cost ?? null, p.cost, fmtCost, { direction: 'down' });
		const tinCell = detailPair(b?.tokens_in ?? null, p.tokens_in, humanTokens, { direction: 'down' });
		const toutCell = detailPair(b?.tokens_out ?? null, p.tokens_out, humanTokens, { direction: 'down' });
		const tokens =
			p.tokens_in === null && p.tokens_out === null ? NONE : `in ${tinCell}<br>out ${toutCell}`;
		const score = detailPair(b?.score ?? null, p.score, fmtScore, { direction: SCORE_DIR });
		const stop = p.stop_reason || NONE;
		lines.push(
			`| ${r.task ?? NONE} | ${r.template ?? NONE} | ${testsCell} | ${judge} | ${cost} | ${tokens} | ${score} | ${stop} |`,
		);
	}
	lines.push('');
	return lines;
}
