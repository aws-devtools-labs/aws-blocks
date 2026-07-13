// PR-vs-baseline results helpers, kept as PURE functions (no fs/env/process) so the diff math +
// coloring are unit-testable under `node --test`. summary.mjs does the I/O and calls these to render
// ONE results table: renderDetailed. Each metric cell shows the CURRENT value plus a color for the
// SIGNIFICANCE + DIRECTION of its change vs the baseline, with the signed delta on a second line.
// Baseline = most recent main bench (bench/runs/latest-main.json); a missing baseline VALUE for a
// field renders ⚪ + the current value + "(new)". Composite/cost/score all come from lib/scoring.mjs.
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
export const WHITE = '⚪'; // no baseline value for this field/cell — current value still shown, tagged "(new)"
export const GONE = '🗑️';
export const NONE = '—';

// SCORE is higher-better iff scoring.mjs computes composite-per-$ (default); imported so one knob drives both.
export const SCORE_HIGHER_BETTER = SCORE_PER_DOLLAR;
const SCORE_DIR = SCORE_HIGHER_BETTER ? 'up' : 'down';

// Per-metric significance thresholds for the delta coloring — the ONE place they live. A change within
// ±threshold reads as 🟡 (noise, since N=1); beyond it, 🟢 (improved) / 🔴 (regressed) by direction.
// Absolute units unless the key ends in `Pct` (then it's a fraction of |baseline|).
export const DELTA_THRESHOLDS = {
	composite: 5, // composite points — also the headline mean-delta band (deltaBall)
	score: 5, // composite-per-$ points
	judge: 0.3, // judge score (0-10)
	tests: 1, // test pass count (a ±1 nudge is noise)
	costPct: 0.1, // cost: ±10% of the baseline cost
	tokensPct: 0.1, // tokens (in+out combined): ±10% of the baseline total
};

/**
 * Color a metric by the SIGNIFICANCE + DIRECTION of its delta vs baseline (NOT absolute quality).
 * `direction` 'up' = higher-is-better (tests/judge/score), 'down' = lower-is-better (cost/tokens).
 * A change beyond `threshold` in the improving direction → 🟢; beyond it in the worsening direction →
 * 🔴; within ±threshold (either way) → 🟡. Missing either side → ⚪.
 * @param {number|null|undefined} baseline
 * @param {number|null|undefined} pr
 * @param {number} threshold absolute tolerance in the metric's own units
 * @param {'up'|'down'} direction
 * @returns {'🟢'|'🟡'|'🔴'|'⚪'}
 */
export function deltaColor(baseline, pr, threshold, direction = 'up') {
	if (baseline === null || baseline === undefined || Number.isNaN(baseline)) return WHITE;
	if (pr === null || pr === undefined || Number.isNaN(pr)) return WHITE;
	const raw = pr - baseline; // signed change in the metric's units
	const improvement = direction === 'up' ? raw : -raw; // > 0 means "better"
	if (improvement > threshold) return GREEN;
	if (improvement < -threshold) return RED;
	return YELLOW;
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
 * plus mean + provenance. Artifact-unreadable cells dropped. An older baseline that lacks some
 * per-metric fields still diffs per-field: fields it carries color, fields it lacks render ⚪ "(new)".
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
 * Status ball for a COMPOSITE delta (headline mean-delta), over the ±{@link DELTA_THRESHOLDS}.composite
 * band: improved beyond it 🟢, regressed beyond it 🔴, within it (flat / noise) 🟡. `''` for a
 * missing/NaN delta.
 * @param {number|null} delta
 * @returns {'🟢'|'🟡'|'🔴'|''}
 */
export function deltaBall(delta) {
	if (delta === null || delta === undefined || Number.isNaN(delta)) return '';
	if (delta > DELTA_THRESHOLDS.composite) return GREEN;
	if (delta < -DELTA_THRESHOLDS.composite) return RED;
	return YELLOW;
}

// The per-cell metric fields the table reads, defaulted to null so any field an older baseline lacks
// degrades to ⚪ "(new)" for THAT metric only (never forcing the whole row).
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
 * Diff the current run's aggregate against a baseline (or `null`). Cells matched by {@link cellKey}.
 * Each row carries the COMPOSITE delta plus `pr`/`base` metric objects the table colors. `base` is
 * populated for ANY matched baseline cell (per-field: fields it lacks simply read null → ⚪ "(new)").
 * A baseline-only cell surfaces as a `removed` row.
 * @param {object} current aggregate from {@link buildAggregate} for this run
 * @param {object|null} baseline aggregate fetched for the base commit, or null
 * @returns {{rows: object[], meanCurrent: number|null, meanBaseline: number|null, meanDelta: number|null, hasBaseline: boolean}}
 */
export function diffAgainstBaseline(current, baseline) {
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
			// Per-field diff against whatever the baseline cell carries (missing fields → ⚪ "(new)").
			base: base ? cellMetrics(base) : null,
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
			base: cellMetrics(base),
		});
	}
	rows.sort((a, b) => a.key.localeCompare(b.key));
	const meanCurrent = numOrNull(current?.mean_composite);
	const meanBaseline = baseline ? numOrNull(baseline.mean_composite) : null;
	const meanDelta = meanCurrent !== null && meanBaseline !== null ? round1(meanCurrent - meanBaseline) : null;
	return { rows, meanCurrent, meanBaseline, meanDelta, hasBaseline: !!baseline };
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

/** Judge score 0-10: integer as-is, else 1 decimal. 8 → "8", 7.5 → "7.5". */
export function fmtJudge(j) {
	if (j === null || j === undefined || Number.isNaN(j)) return NONE;
	return Number.isInteger(j) ? String(j) : String(+j.toFixed(1));
}

// Signed-delta formatters for the second line of each cell (no arrows — sign only).
const signOf = (n) => (n > 0 ? '+' : n < 0 ? '-' : '');
const signedInt = (d) => `${d > 0 ? '+' : ''}${Math.round(d)}`;
const signed1 = (d) => {
	const v = Math.round(d * 10) / 10;
	return `${v > 0 ? '+' : ''}${v}`;
};
const signedCost = (d) => `${signOf(d)}$${+Math.abs(d).toFixed(2)}`;
const signedTokens = (d) => `${signOf(d)}${humanTokens(Math.abs(d))}`;

// ── Metric cells ──────────────────────────────────────────────────────────────
// Every cell is two lines joined by <br>: line 1 `<ball> <current value>`, line 2 `(<signed delta>)`.
// No baseline value for the field → `⚪ <current value><br>(new)` (the current value is ALWAYS shown).
// A missing CURRENT value → NONE (nothing this run to show).

// TESTS: "passed/denom", colored by the pass COUNT (higher better, ±1 noise). denom 0 → NONE.
function testsCell(base, pr) {
	const pp = numOrNull(pr?.tests_passed);
	const pd = numOrNull(pr?.tests_denom);
	if (pp === null || pd === null || pd === 0) return NONE;
	const value = `${pp}/${pd}`;
	const bp = numOrNull(base?.tests_passed);
	if (bp === null) return `${WHITE} ${value}<br>(new)`;
	return `${deltaColor(bp, pp, DELTA_THRESHOLDS.tests, 'up')} ${value}<br>(${signedInt(pp - bp)})`;
}

// JUDGE: overall judge score (0-10, higher better, ±0.3 noise).
function judgeCell(base, pr) {
	const pv = numOrNull(pr?.judge_score);
	if (pv === null) return NONE;
	const value = fmtJudge(pv);
	const bv = numOrNull(base?.judge_score);
	if (bv === null) return `${WHITE} ${value}<br>(new)`;
	return `${deltaColor(bv, pv, DELTA_THRESHOLDS.judge, 'up')} ${value}<br>(${signed1(pv - bv)})`;
}

// COST: $ builder spend (lower better, ±10% of baseline noise).
function costCell(base, pr) {
	const pv = numOrNull(pr?.cost);
	if (pv === null) return NONE;
	const value = fmtCost(pv);
	const bv = numOrNull(base?.cost);
	if (bv === null) return `${WHITE} ${value}<br>(new)`;
	const threshold = DELTA_THRESHOLDS.costPct * Math.abs(bv);
	return `${deltaColor(bv, pv, threshold, 'down')} ${value}<br>(${signedCost(pv - bv)})`;
}

// TOKENS (in/out): value shows both; colored by the COMBINED total (lower better, ±10% noise).
function tokensCell(base, pr) {
	const pin = numOrNull(pr?.tokens_in);
	const pout = numOrNull(pr?.tokens_out);
	if (pin === null && pout === null) return NONE;
	const value = `${humanTokens(pr?.tokens_in)}/${humanTokens(pr?.tokens_out)}`;
	const prTotal = (pin ?? 0) + (pout ?? 0);
	const bin = numOrNull(base?.tokens_in);
	const bout = numOrNull(base?.tokens_out);
	if (bin === null && bout === null) return `${WHITE} ${value}<br>(new)`;
	const baseTotal = (bin ?? 0) + (bout ?? 0);
	const threshold = DELTA_THRESHOLDS.tokensPct * Math.abs(baseTotal);
	return `${deltaColor(baseTotal, prTotal, threshold, 'down')} ${value}<br>(${signedTokens(prTotal - baseTotal)})`;
}

// SCORE: composite-per-$ (direction from SCORE_HIGHER_BETTER, ±5 noise).
function scoreCell(base, pr) {
	const pv = numOrNull(pr?.score);
	if (pv === null) return NONE;
	const value = fmtScore(pv);
	const bv = numOrNull(base?.score);
	if (bv === null) return `${WHITE} ${value}<br>(new)`;
	return `${deltaColor(bv, pv, DELTA_THRESHOLDS.score, SCORE_DIR)} ${value}<br>(${signed1(pv - bv)})`;
}

// ── Render: single results table ──────────────────────────────────────────────
/**
 * The one results table: TASK | TEMPLATE | TESTS | JUDGE | COST | TOKENS (in/out) | SCORE | STOP REASON.
 * Every metric cell is a two-line `<ball> <current value><br>(<signed delta vs main>)` (⚪ "(new)" when
 * the baseline has no value for it). Color = significance + direction of the change (see {@link deltaColor}).
 * @param {ReturnType<typeof diffAgainstBaseline>} diff
 * @param {{heading?: string, note?: string}} [opts]
 * @returns {string[]}
 */
export function renderDetailed(diff, opts = {}) {
	const lines = [];
	if (opts.heading) lines.push(opts.heading, '');
	if (opts.note) lines.push(opts.note, '');
	lines.push(
		'| Task | Template | Tests | Judge | Cost | Tokens (in/out) | Score | Stop reason |',
		'|------|----------|-------|-------|------|-----------------|-------|-------------|',
	);
	for (const r of diff.rows) {
		if (r.removed) {
			const was =
				r.base && r.base.tests_passed !== null && r.base.tests_passed !== undefined
					? ` (was ${r.base.tests_passed}/${r.base.tests_denom})`
					: '';
			lines.push(
				`| ${r.task ?? NONE} | ${r.template ?? NONE} | ${GONE} removed${was} | ${NONE} | ${NONE} | ${NONE} | ${NONE} | ${NONE} |`,
			);
			continue;
		}
		const b = r.base;
		const p = r.pr ?? {};
		const stop = p.stop_reason || NONE;
		// Guarantee the 8-column invariant: coerce any empty metric cell to NONE so a crashed/null-metric
		// cell (no tokens/score/composite) can never drop a column and misalign the row.
		const cell = (v) => (typeof v === 'string' && v.trim() ? v : NONE);
		const cells = [testsCell(b, p), judgeCell(b, p), costCell(b, p), tokensCell(b, p), scoreCell(b, p)].map(cell);
		lines.push(`| ${r.task ?? NONE} | ${r.template ?? NONE} | ${cells.join(' | ')} | ${cell(stop)} |`);
	}
	lines.push('');
	return lines;
}
