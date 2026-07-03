// PR-vs-baseline overview helpers, kept as PURE functions (no fs / env / process
// side effects) so the diff math is unit-testable under bare `node --test`, the
// same way lib/scoring.mjs is. summary.mjs does the I/O (read the downloaded
// baseline, write the new aggregate, append markdown to $GITHUB_STEP_SUMMARY)
// and calls these to build the at-a-glance overview rendered at the TOP of the
// run summary.
//
// The baseline is a small commit-keyed aggregate (built by buildAggregate and
// persisted to S3 under bench/runs/<sha>/results.json): per-cell composites
// plus the mean. A PR run fetches the aggregate for its base commit and renders
// the delta so the PR's effect is obvious at first glance. No baseline → the
// overview falls back to absolute composites with a note (never an error).
//
// Composite + inclusion rules come from lib/scoring.mjs — the ONE source of
// truth — so the aggregate's numbers can't drift from the rendered table.
import { composite, isScoredCell, testRate, testStats, verdictOf } from './scoring.mjs';

// Stable identity for a cell across runs: a baseline cell is matched to the
// current cell by this key. Both task + template are part of it because a task
// can in principle run on more than one template.
export const cellKey = (c) => `${c?.task ?? ''}/${c?.template ?? ''}`;

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Composite (0..100) for a cell from the shared scoring formula, or `null` when
 * the cell isn't a scored cell (a harness_error, or a gradeable cell that ran
 * no tests). A `null` composite is rendered as "—" and excluded from the mean.
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
	// cellComposite re-checks isScoredCell, but every `c` here already passed the
	// filter above, so that guard is a defensive no-op on this path (never null).
	const sum = scored.reduce((acc, c) => acc + cellComposite(c), 0);
	return round1(sum / scored.length);
}

/**
 * Build the compact, self-describing aggregate that is persisted to S3 as the
 * commit-keyed baseline. Holds exactly what the overview diff needs: per-cell
 * composites + the mean, plus provenance (sha / base_sha / event) for auditing.
 * Artifact-unreadable cells (those carrying an `error` field) are dropped — they
 * have no gradeable signal to baseline against.
 * @param {object[]} cells finalized result.json cells for this run
 * @param {{sha?: string, base_sha?: string, pr_number?: string, event?: string, generated_at?: string}} [meta]
 * @returns {object}
 */
export function buildAggregate(cells, meta = {}) {
	const data = (cells ?? []).filter((c) => c && !c.error);
	return {
		schema: 1,
		sha: meta.sha ?? null,
		base_sha: meta.base_sha ?? null,
		pr_number: meta.pr_number ?? null,
		event: meta.event ?? null,
		generated_at: meta.generated_at ?? null,
		mean_composite: meanComposite(data),
		scored_cells: data.filter((c) => isScoredCell(c)).length,
		cells: data
			.map((c) => ({
				task: c.task ?? null,
				template: c.template ?? null,
				composite: cellComposite(c),
				verdict: verdictOf(c),
				klass: c.klass ?? null,
				judge_score: typeof c.judge_score === 'number' ? c.judge_score : null,
				test_rate: round1(testRate(testStats(c)) * 100) / 100,
			}))
			.sort((a, b) => cellKey(a).localeCompare(cellKey(b))),
	};
}

/**
 * Direction marker for a composite delta. The near-equal band is ±5 (wide on
 * purpose): the bench is N=1 per cell, so a small delta is as likely to be
 * model variance as a real change. Within ±5 we render `≈` (still showing the
 * signed number) rather than a confident ▲/▼, reserving the arrows for moves
 * large enough to plausibly be real. `''` for a missing/NaN delta.
 * @param {number|null} delta
 * @returns {'▲'|'▼'|'≈'|''}
 */
export function deltaArrow(delta) {
	if (delta === null || delta === undefined || Number.isNaN(delta)) return '';
	if (delta > 5) return '▲';
	if (delta < -5) return '▼';
	return '≈';
}

/**
 * Diff the current run's aggregate against a baseline aggregate (or `null` when
 * none was found). Cells are matched by {@link cellKey}; a cell present in only
 * one side gets a `null` on the missing side and a `null` delta. The mean delta
 * is computed only when BOTH means exist.
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
		const cur = typeof c.composite === 'number' ? c.composite : null;
		const bas = base && typeof base.composite === 'number' ? base.composite : null;
		const delta = cur !== null && bas !== null ? round1(cur - bas) : null;
		return { key, task: c.task ?? null, template: c.template ?? null, current: cur, baseline: bas, delta, hasBaselineCell: !!base, removed: false };
	});
	// Baseline-only cells (removed or renamed since the baseline — e.g. a task
	// folder rename) get their OWN row so a dropped cell is VISIBLE in the diff
	// instead of silently vanishing. current + delta are null and `removed` flags
	// it for the 'removed' marker; a null current keeps it out of the mean.
	for (const [key, base] of baseCells) {
		if (curKeys.has(key)) continue;
		rows.push({
			key,
			task: base.task ?? null,
			template: base.template ?? null,
			current: null,
			baseline: typeof base.composite === 'number' ? base.composite : null,
			delta: null,
			hasBaselineCell: true,
			removed: true,
		});
	}
	rows.sort((a, b) => a.key.localeCompare(b.key));
	const meanCurrent = typeof current?.mean_composite === 'number' ? current.mean_composite : null;
	const meanBaseline = baseline && typeof baseline.mean_composite === 'number' ? baseline.mean_composite : null;
	const meanDelta = meanCurrent !== null && meanBaseline !== null ? round1(meanCurrent - meanBaseline) : null;
	return { rows, meanCurrent, meanBaseline, meanDelta, hasBaseline: !!baseline };
}

const fmt = (n) => (n === null || n === undefined || Number.isNaN(n) ? '—' : n.toFixed(1));
const signed = (n) => (n === null || n === undefined ? '' : n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1));

/**
 * Render the overview as an array of markdown lines for the TOP of the run
 * summary. With a baseline it's a Baseline | PR | Δ table (▲/▼/= + signed
 * numbers, mean row in bold); without one it's an absolute Composite table.
 * @param {ReturnType<typeof diffAgainstBaseline>} diff
 * @param {{heading?: string, note?: string}} [opts]
 * @returns {string[]}
 */
export function renderOverview(diff, opts = {}) {
	const lines = [opts.heading ?? '## Overview', ''];
	if (opts.note) lines.push(opts.note, '');

	if (diff.hasBaseline) {
		lines.push('| Task | Template | Baseline | PR | Δ |', '|------|----------|----------|----|----|');
		for (const r of diff.rows) {
			let deltaCell;
			if (r.removed) deltaCell = '🗑️ removed'; // baseline-only cell — dropped/renamed since the baseline
			else if (r.delta !== null) deltaCell = `${deltaArrow(r.delta)} ${signed(r.delta)}`;
			else if (r.current === null) deltaCell = '—'; // not scored this run (harness / no-tests) — nothing to diff
			else if (!r.hasBaselineCell) deltaCell = '🆕 new'; // scored now, absent from the baseline
			else deltaCell = '—'; // baseline cell exists but had no composite
			lines.push(`| ${r.task ?? '—'} | ${r.template ?? '—'} | ${fmt(r.baseline)} | ${fmt(r.current)} | ${deltaCell} |`);
		}
		const meanDeltaCell = diff.meanDelta === null ? '—' : `${deltaArrow(diff.meanDelta)} ${signed(diff.meanDelta)}`;
		lines.push(`| **Mean** | | **${fmt(diff.meanBaseline)}** | **${fmt(diff.meanCurrent)}** | **${meanDeltaCell}** |`);
	} else {
		lines.push('| Task | Template | Composite |', '|------|----------|-----------|');
		for (const r of diff.rows) lines.push(`| ${r.task ?? '—'} | ${r.template ?? '—'} | ${fmt(r.current)} |`);
		lines.push(`| **Mean** | | **${fmt(diff.meanCurrent)}** |`);
	}
	lines.push('');
	// N=1 caveat: with a single rep per cell, small deltas are indistinguishable
	// from model variance — hence the ±5 ≈ band above.
	lines.push('_N=1 per cell. Deltas within ±5 may reflect model variance, not a real change — re-run for certainty._', '');
	return lines;
}
