// PR-vs-baseline results helpers, kept as PURE functions (no fs/env/process) so the diff math +
// coloring are unit-testable under `node --test`. summary.mjs does the I/O and calls these to render
// ONE results table: renderDetailed. Each metric cell shows the CURRENT value plus a color for the
// SIGNIFICANCE + DIRECTION of its change vs the baseline, with the signed delta shown inline.
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
	judge: 0.3, // judge score (0-10) — applied per-dimension too
	tests: 1, // test pass count (a ±1 nudge is noise)
	costPct: 0.1, // cost: ±10% of the baseline cost
	turns: 3, // cycle_count (lower-better): ±3 turns is within run-to-run noise at N=1
	costAbs: 0.02, // absolute $ floor for the cost band — a near-zero baseline mustn't make pct·|bv|≈0 over-color
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
					// Newer per-cell signals persisted into the baseline: cycle_count feeds the Turns column;
					// the token/cache/LOC/file counts are retained for historical baselines and offline
					// analysis (the results table no longer renders them, but dropping them loses the series).
					cycle_count: numOrNull(c.cycle_count),
					cache_read_tokens: numOrNull(c.cache_read_tokens),
					cache_write_tokens: numOrNull(c.cache_write_tokens),
					loc_created: numOrNull(c.loc_created),
					loc_edited: numOrNull(c.loc_edited),
					files_created: numOrNull(c.files_created),
					files_edited: numOrNull(c.files_edited),
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
		// Per-dimension judge scores (capped), retained on the metric object for parity with the persisted
		// aggregate + offline analysis. NOT rendered in the table — the Judge cell shows only the overall
		// score; the per-dim breakdown lives in the judge artifact JSON (progressive disclosure).
		judge_dimensions: c?.judge_dimensions && typeof c.judge_dimensions === 'object' ? c.judge_dimensions : null,
		cycle_count: numOrNull(c?.cycle_count),
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
	if (!Number.isFinite(n)) return NONE;
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) return `${+(n / 1000).toFixed(1)}K`;
	return `${+(n / 1_000_000).toFixed(1)}M`;
}

/** USD, trailing zeros trimmed: 3.5 → "$3.5", 2 → "$2", 1.05 → "$1.05", null → "—". */
export function fmtCost(c) {
	if (c === null || c === undefined || Number.isNaN(c)) return NONE;
	if (!Number.isFinite(c)) return NONE;
	return `$${+c.toFixed(2)}`;
}

/** Score-per-$ to 1 decimal: 66.7 → "66.7", null → "—". */
export function fmtScore(s) {
	if (s === null || s === undefined || Number.isNaN(s)) return NONE;
	if (!Number.isFinite(s)) return NONE;
	return String(+s.toFixed(1));
}

/** Judge score 0-10: integer as-is, else 1 decimal. 8 → "8", 7.5 → "7.5". */
export function fmtJudge(j) {
	if (j === null || j === undefined || Number.isNaN(j)) return NONE;
	return Number.isInteger(j) ? String(j) : String(+j.toFixed(1));
}

// Signed-delta formatters for the delta suffix of each cell (no arrows — sign only).
const signOf = (n) => (n > 0 ? '+' : n < 0 ? '-' : '');
const signedInt = (d) => `${d > 0 ? '+' : ''}${Math.round(d)}`;
const signed1 = (d) => {
	const v = Math.round(d * 10) / 10;
	return `${v > 0 ? '+' : ''}${v}`;
};
const signedCost = (d) => `${signOf(d)}${fmtCost(Math.abs(d))}`;
const wholeNum = (v) => String(Math.round(v));

// ── Metric cells ──────────────────────────────────────────────────────────────
// Every metric cell — scalars AND judge — is ONE inline line: `<ball> <value> (<Δ>)`. The current value
// is ALWAYS shown; a metric the baseline lacks reads `⚪ … (new)`; no current value at all → NONE.

// One INLINE scalar cell: `<ball> <value> (<Δ>)`; `⚪ <value> (new)` with no baseline; NONE with no
// current value. `threshold` may be a number or fn(baseline); `dir` sets the improving direction.
function scalarCell(base, pr, { threshold, dir, fmtVal, fmtDelta }) {
	const pv = numOrNull(pr);
	if (pv === null) return NONE;
	const value = fmtVal(pv);
	const bv = numOrNull(base);
	if (bv === null) return `${WHITE} ${value} (new)`;
	const t = typeof threshold === 'function' ? threshold(bv) : threshold;
	return `${deltaColor(bv, pv, t, dir)} ${value} (${fmtDelta(pv - bv)})`;
}

// TESTS: "passed/denom", colored by the pass COUNT (higher better, ±1 noise). denom 0 → NONE.
function testsCell(base, pr) {
	const pp = numOrNull(pr?.tests_passed);
	const pd = numOrNull(pr?.tests_denom);
	if (pp === null || pd === null || pd === 0) return NONE;
	const value = `${pp}/${pd}`;
	const bp = numOrNull(base?.tests_passed);
	if (bp === null) return `${WHITE} ${value} (new)`;
	return `${deltaColor(bp, pp, DELTA_THRESHOLDS.tests, 'up')} ${value} (${signedInt(pp - bp)})`;
}

// JUDGE: ONE inline cell — the overall judge score `<ball> <score> (<Δ>)`, colored by the overall judge
// delta over ±{@link DELTA_THRESHOLDS}.judge. `⚪ <score> (new)` with no baseline; NONE with no judge
// score. Per-dimension scores are NOT rendered here — the breakdown lives in the judge artifact JSON
// (progressive disclosure). Overall judge mean also appears in the preword.
function judgeCell(base, pr) {
	return scalarCell(base?.judge_score, pr?.judge_score, {
		threshold: DELTA_THRESHOLDS.judge,
		dir: 'up',
		fmtVal: fmtJudge,
		fmtDelta: signed1,
	});
}

// COST: $ builder spend (lower better, ±10% of baseline noise).
function costCell(base, pr) {
	return scalarCell(base?.cost, pr?.cost, {
		threshold: (bv) => Math.max(DELTA_THRESHOLDS.costAbs, DELTA_THRESHOLDS.costPct * Math.abs(bv)),
		dir: 'down',
		fmtVal: fmtCost,
		fmtDelta: signedCost,
	});
}

// TURNS: agent cycle_count (lower better, ±3 noise).
function turnsCell(base, pr) {
	return scalarCell(base?.cycle_count, pr?.cycle_count, {
		threshold: DELTA_THRESHOLDS.turns,
		dir: 'down',
		fmtVal: wholeNum,
		fmtDelta: signedInt,
	});
}

// SCORE: composite-per-$ (direction from SCORE_HIGHER_BETTER, ±5 noise).
function scoreCell(base, pr) {
	return scalarCell(base?.score, pr?.score, {
		threshold: DELTA_THRESHOLDS.score,
		dir: SCORE_DIR,
		fmtVal: fmtScore,
		fmtDelta: signed1,
	});
}

// The metric columns after Task|Template, in render order. Kept as one list so the header, the
// separator, the per-row cells, and the removed-row padding can't drift out of sync.
const METRIC_COLUMNS = ['Tests', 'Judge', 'Cost', 'Turns', 'Score', 'Stop reason'];

// ── Render: single results table ──────────────────────────────────────────────
/**
 * The one results table: TASK | TEMPLATE | TESTS | JUDGE | COST | TURNS | SCORE | STOP REASON. Every
 * metric cell — tests/judge/cost/turns/score — is inline `<ball> <value> (<Δ>)`; the JUDGE cell shows
 * only the overall judge score (per-dimension breakdown lives in the judge artifact JSON). ⚪ "(new)"
 * where the baseline lacks a metric. Every row emits ALL columns.
 * @param {ReturnType<typeof diffAgainstBaseline>} diff
 * @param {{heading?: string, note?: string}} [opts]
 * @returns {string[]}
 */
export function renderDetailed(diff, opts = {}) {
	const lines = [];
	if (opts.heading) lines.push(opts.heading, '');
	if (opts.note) lines.push(opts.note, '');
	lines.push(
		`| Task | Template | ${METRIC_COLUMNS.join(' | ')} |`,
		`|${Array(2 + METRIC_COLUMNS.length).fill('---').join('|')}|`,
	);
	const cell = (v) => (typeof v === 'string' && v.trim() ? v : NONE);
	for (const r of diff.rows) {
		if (r.removed) {
			const was =
				r.base && r.base.tests_passed != null && r.base.tests_denom != null
					? ` (was ${r.base.tests_passed}/${r.base.tests_denom})`
					: '';
			// Tests column carries the 🗑️ marker; the remaining metric columns pad with NONE so the
			// removed row keeps the full column count.
			const pad = Array(METRIC_COLUMNS.length - 1).fill(NONE).join(' | ');
			lines.push(`| ${r.task ?? NONE} | ${r.template ?? NONE} | ${GONE} removed${was} | ${pad} |`);
			continue;
		}
		const b = r.base;
		const p = r.pr ?? {};
		// Coerce any empty metric cell to NONE so a crashed/null-metric cell can never drop a column and
		// misalign the row (the all-columns invariant, guarded in the tests).
		const cells = [
			testsCell(b, p),
			judgeCell(b, p),
			costCell(b, p),
			turnsCell(b, p),
			scoreCell(b, p),
			p.stop_reason || NONE,
		].map(cell);
		lines.push(`| ${r.task ?? NONE} | ${r.template ?? NONE} | ${cells.join(' | ')} |`);
	}
	lines.push('');
	return lines;
}

// ── Preword: aggregated run summary (bullets above the table) ───────────────────
/**
 * Bulleted headline summary rendered ABOVE the table: mean composite + Δ vs main (with the judge mean),
 * the verdict tally, run totals (cost / tokens / turns), the biggest composite movers vs the baseline,
 * and the run config. Pure — derives everything from the diff + aggregate + a small opts bag.
 * @param {ReturnType<typeof diffAgainstBaseline>} diff
 * @param {ReturnType<typeof buildAggregate>} aggregate
 * @param {{builderModel?: string, judgeModel?: string, baselineSha?: string}} [opts]
 * @returns {string[]} markdown bullet lines (each prefixed with "- ")
 */
export function renderPreword(diff, aggregate, opts = {}) {
	const cells = aggregate?.cells ?? [];
	const bullets = [];

	// Mean composite + Δ vs main, with the overall judge mean folded in.
	const mean = numOrNull(aggregate?.mean_composite);
	const meanStr = mean === null ? NONE : mean.toFixed(1);
	const deltaStr =
		diff?.hasBaseline && diff.meanDelta !== null
			? ` — ${deltaBall(diff.meanDelta)} ${diff.meanDelta > 0 ? '+' : ''}${diff.meanDelta.toFixed(1)} vs \`main\``
			: ' — no `main` baseline yet';
	const judged = cells.filter((c) => c.klass !== 'harness_error' && numOrNull(c.judge_score) !== null);
	const judgeMean = judged.length ? judged.reduce((a, c) => a + c.judge_score, 0) / judged.length : null;
	const judgeStr = judgeMean !== null ? ` · judge mean ${judgeMean.toFixed(2)}/10` : '';
	bullets.push(
		`**Mean composite ${meanStr}/100** across ${aggregate?.scored_cells ?? 0} scored cell(s)${deltaStr}${judgeStr}.`,
	);

	// Verdict tally (harness_error read off klass; the rest off the stored verdict).
	const v = { pass: 0, partial: 0, fail: 0, harness_error: 0, unknown: 0 };
	for (const c of cells) {
		const verd = c.klass === 'harness_error' ? 'harness_error' : (c.verdict ?? 'unknown');
		v[verd in v ? verd : 'unknown'] += 1;
	}
	bullets.push(
		`**Verdicts:** ${v.pass} pass · ${v.partial} partial · ${v.fail} fail · ${v.harness_error} harness_error${v.unknown ? ` · ${v.unknown} unknown` : ''}.`,
	);

	// Run totals.
	const anyOf = (k) => cells.some((c) => numOrNull(c[k]) !== null);
	const sumOf = (k) => cells.reduce((a, c) => a + (numOrNull(c[k]) ?? 0), 0);
	const totalsParts = [
		`cost ${anyOf('cost') ? fmtCost(sumOf('cost')) : NONE}`,
		`tokens ${
			anyOf('tokens_in') || anyOf('tokens_out')
				? `${humanTokens(sumOf('tokens_in'))} in / ${humanTokens(sumOf('tokens_out'))} out`
				: NONE
		}`,
	];
	if (anyOf('cycle_count')) totalsParts.push(`${Math.round(sumOf('cycle_count'))} turns`);
	bullets.push(`**Totals:** ${totalsParts.join(' · ')}.`);

	// Biggest composite movers vs the baseline (only when a baseline exists AND there are deltas).
	if (diff?.hasBaseline) {
		const moved = diff.rows.filter((r) => !r.removed && numOrNull(r.delta) !== null && r.delta !== 0);
		if (moved.length > 0) {
			const fmtMove = (r) => `\`${r.task}/${r.template}\` (${r.delta > 0 ? '+' : ''}${r.delta})`;
			const gains = moved.filter((r) => r.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 3);
			const drops = moved.filter((r) => r.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 3);
			bullets.push(`**Biggest gains:** ${gains.length ? gains.map(fmtMove).join(', ') : 'none'}.`);
			bullets.push(`**Biggest drops:** ${drops.length ? drops.map(fmtMove).join(', ') : 'none'}.`);
		}
	}

	// Run config.
	const cfgParts = [];
	if (opts.builderModel) cfgParts.push(`builder \`${opts.builderModel}\``);
	if (opts.judgeModel) cfgParts.push(`judge \`${opts.judgeModel}\``);
	if (opts.baselineSha) cfgParts.push(`baseline \`${String(opts.baselineSha).slice(0, 7)}\``);
	if (cfgParts.length) bullets.push(`**Config:** ${cfgParts.join(' · ')}.`);

	return bullets.map((b) => `- ${b}`);
}
