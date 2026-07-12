// PR-vs-baseline overview + detailed-results helpers, kept as PURE functions (no fs/env/process) so
// the diff math + coloring are unit-testable under `node --test`. summary.mjs does the I/O and calls
// these to render two tables from the same rows: renderOverview (colors only) and renderDetailed
// (colors + numbers). Baseline = commit-keyed aggregate (bench/runs/latest-main.json); no baseline →
// absolute numbers, all 🆕. Composite/cost/score all come from lib/scoring.mjs.
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

// Stable cross-run identity for a cell (task + template, since a task may run on multiple templates).
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

// The single tunable separating 🟡 (worse within noise) from 🔴 (worse beyond): a 5% relative margin.
export const MARGIN_PCT = 0.05;

// Default boundary policy: worse-but-within-margin renders 🟡. Set true to treat within-margin as 🟢.
export const MARGIN_IS_GREEN = false;

// SCORE is higher-better iff scoring.mjs computes composite-per-$ (default); imported so one knob drives both.
export const SCORE_HIGHER_BETTER = SCORE_PER_DOLLAR;

/**
 * Absolute tolerance around a baseline below which a WORSE move stays 🟡. MARGIN_PCT of |baseline|;
 * floored to 1 for integer metrics so a ±1 nudge on a small integer reads as within-margin.
 * @param {number} baseline
 * @param {boolean} integer
 * @returns {number}
 */
export function marginAbs(baseline, integer) {
	const raw = Math.abs(baseline) * MARGIN_PCT;
	return integer ? Math.max(1, Math.round(raw)) : raw;
}

/**
 * Color one metric vs its baseline. Returns 🟢/🟡/🔴, or `null` when either side is missing.
 * `direction` 'up' = higher-better (tests/judge/score), 'down' = lower-better (cost/tokens). Equal = 🟢.
 * A worse move within {@link marginAbs} is 🟡 (or 🟢 when MARGIN_IS_GREEN); beyond it, 🔴.
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
 * Composite (0..100) for a cell, or `null` when unscored (harness_error, or gradeable but ran no tests).
 * @param {object} r a finalized result.json cell
 * @returns {number|null}
 */
export function cellComposite(r) {
	if (!isScoredCell(r)) return null;
	return composite(testRate(testStats(r)), typeof r?.judge_score === 'number' ? r.judge_score : 0);
}

/**
 * Mean composite over SCORED cells only (same rule as the headline), rounded to 1 dp; `null` if none.
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
 * Build the compact schema-2 aggregate persisted to S3 as the commit-keyed baseline: per-cell
 * composite/verdict/klass, test counts, judge overall + per-dimension, tokens, $ cost, score-per-$,
 * plus mean + provenance. Artifact-unreadable cells dropped. Schema-1 baselines still diff (missing
 * fields render 🆕/— until a main bench records schema-2).
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
 * Status ball for a COMPOSITE delta, reusing the report's 🟢/🟡/🔴 convention. ±5 near-equal band
 * (wide: N=1, so a small delta is as likely variance as signal): improved beyond it 🟢, regressed
 * beyond it 🔴, within it (flat / noise) 🟡. `''` for a missing/NaN delta.
 * @param {number|null} delta
 * @returns {'🟢'|'🟡'|'🔴'|''}
 */
export function deltaBall(delta) {
	if (delta === null || delta === undefined || Number.isNaN(delta)) return '';
	if (delta > 5) return GREEN;
	if (delta < -5) return RED;
	return YELLOW;
}

// The metric fields the tables read, defaulted to null so a schema-1/partial baseline degrades to 🆕/—.
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
 * True iff the baseline is schema 2+, i.e. carries the per-metric set the tables diff (test counts,
 * per-dimension judge, tokens, cost, score). A schema-1 baseline is treated as "no per-metric
 * baseline" — every column (Judge included) renders 🆕 — so coloring stays consistent; the composite
 * mean/delta still uses `composite` (present in schema 1) for the headline + analysis roll-up.
 * @param {object|null|undefined} baseline
 * @returns {boolean}
 */
export function baselineHasMetrics(baseline) {
	return !!baseline && (numOrNull(baseline.schema) ?? 0) >= 2;
}

/**
 * Diff the current run's aggregate against a baseline (or `null`). Cells matched by {@link cellKey}.
 * Each row carries the COMPOSITE delta plus `pr`/`base` metric objects the tables color. `base` is
 * populated only for a schema-2 baseline ({@link baselineHasMetrics}); against schema-1 every metric
 * renders 🆕. A baseline-only cell surfaces as a `removed` row.
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
			// Per-metric diff only against a schema-2 baseline; schema-1 → every column 🆕.
			base: base && perMetricBaseline ? cellMetrics(base) : null,
		};
	});
	// Baseline-only cells (removed/renamed) get their OWN row so a dropped cell stays visible.
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

// Metric spec shared by both renderers so a metric is colored/directed identically in both tables.
const SCORE_DIR = SCORE_HIGHER_BETTER ? 'up' : 'down';

// Glyph for the colors-only Overview: metric color, else 🆕 (scored now, no baseline) / — (nothing to diff).
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

// Union of judge-dimension keys across baseline + pr (pr first), stable order for the multi-line cell.
function dimKeys(baseDims, prDims) {
	const keys = [];
	for (const k of Object.keys(prDims ?? {})) if (!keys.includes(k)) keys.push(k);
	for (const k of Object.keys(baseDims ?? {})) if (!keys.includes(k)) keys.push(k);
	return keys;
}

// Multi-line judge cell for the Detailed table: one "<color> <dim> base -> pr" line per dim, <br>-joined.
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
 * Colors-only overview: TASK | TEMPLATE | TESTS | JUDGE | COST | TOKENS (in/out) | SCORE, one glyph
 * per metric vs baseline (🆕 new, — nothing to diff). See {@link renderDetailed} for numbers.
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
 * The Overview rows widened WITH numbers: TESTS (🟡 10/14 -> 9/14) | JUDGE (one colored dim per line)
 * | COST | TOKENS (in/out) | SCORE (base -> pr) | STOP REASON. Colors/directions match the Overview.
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
		// TESTS is "passed/denom" colored by the passed COUNT, built explicitly rather than via detailPair.
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
