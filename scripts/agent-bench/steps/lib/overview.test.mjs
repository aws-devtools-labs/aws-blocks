// Unit tests for the PR-vs-baseline report helpers (overview.mjs): the diff math, margin/color engine,
// formatters, and the two render modes (Overview = colors, Detailed = numbers). Run under bare `node --test`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	MARGIN_PCT,
	baselineHasMetrics,
	buildAggregate,
	cellComposite,
	cellKey,
	deltaBall,
	diffAgainstBaseline,
	fmtCost,
	fmtScore,
	humanTokens,
	marginAbs,
	meanComposite,
	metricColor,
	renderDetailed,
	renderOverview,
} from './overview.mjs';

const DIMS = { functional_completeness: 8, selector_contract: 8, persistence: 8, code_quality: 8, blocks_fidelity: 8 };
// composite(tr, j) = round(60*tr + 4*j*min(1, 4*tr), 1) — see scoring.mjs.
// cost = (in*5 + out*25)/1e6 ; score = composite/cost (score per $).
const PASS = { task: 'auth-notes', template: 'demo', tests_passed: 4, tests_failed: 0, judge_score: 8, judge_dimensions: DIMS, tokens_in: 200000, tokens_out: 30000, stop_reason: 'end_turn' }; // comp 92 · cost 1.75 · score 52.6
const PARTIAL = { task: 'file-gallery', template: 'bare', tests_passed: 3, tests_failed: 1, judge_score: 5, tokens_in: 100000, tokens_out: 20000, stop_reason: 'end_turn' }; // comp 65 · cost 1.0 · score 65
const AGENT_FAIL = { task: 'sql-kb', template: 'nextjs', klass: 'agent_fail', tests_passed: 0, tests_failed: 0 }; // comp 0 · no tokens → cost/score null
const HARNESS = { task: 'oidc-dsql', template: 'react', klass: 'harness_error' }; // excluded → null
const UNKNOWN = { task: 'email-digest', template: 'demo', tests_passed: 0, tests_failed: 0 }; // gradeable, no tests → null

describe('cellComposite(r)', () => {
	it('returns the shared composite for a scored cell', () => {
		assert.equal(cellComposite(PASS), 92);
		assert.equal(cellComposite(PARTIAL), 65);
	});
	it('an agent_fail is scored 0 (included); harness/unknown are null (excluded)', () => {
		assert.equal(cellComposite(AGENT_FAIL), 0);
		assert.equal(cellComposite(HARNESS), null);
		assert.equal(cellComposite(UNKNOWN), null);
	});
});

describe('meanComposite(cells)', () => {
	it('averages only the scored cells (agent_fail 0; harness/unknown excluded)', () => {
		assert.equal(meanComposite([PASS, PARTIAL, AGENT_FAIL, HARNESS, UNKNOWN]), 52.3); // (92+65+0)/3
		assert.equal(meanComposite([PASS, PARTIAL]), 78.5);
	});
	it('is null when no cell was scored', () => {
		assert.equal(meanComposite([HARNESS, UNKNOWN]), null);
		assert.equal(meanComposite([]), null);
	});
});

describe('marginAbs(baseline, integer) — one tunable, MARGIN_PCT', () => {
	it('MARGIN_PCT is the documented 5%', () => {
		assert.equal(MARGIN_PCT, 0.05);
	});
	it('integer metrics floor the margin to 1 (a ±1 nudge is always within-margin)', () => {
		assert.equal(marginAbs(8, true), 1); // round(0.4)=0 → floored to 1
		assert.equal(marginAbs(11, true), 1); // round(0.55)=1
		assert.equal(marginAbs(40, true), 2); // round(2.0)=2
		assert.equal(marginAbs(0, true), 1);
	});
	it('continuous metrics use exact 5% of |baseline| (no floor)', () => {
		assert.equal(marginAbs(100, false), 5);
		assert.equal(marginAbs(2, false), 0.1);
		assert.equal(marginAbs(0, false), 0);
	});
});

describe('metricColor(baseline, pr, {direction, integer})', () => {
	it('equal or better is 🟢 (both directions)', () => {
		assert.equal(metricColor(8, 8, { direction: 'up' }), '🟢');
		assert.equal(metricColor(8, 9, { direction: 'up' }), '🟢');
		assert.equal(metricColor(2, 2, { direction: 'down' }), '🟢');
		assert.equal(metricColor(2, 1, { direction: 'down' }), '🟢');
	});
	it('worse within the (integer) margin is 🟡, beyond is 🔴 — matches the judge-dim example', () => {
		assert.equal(metricColor(8, 7, { direction: 'up', integer: true }), '🟡'); // 8→7 within 1
		assert.equal(metricColor(9, 5, { direction: 'up', integer: true }), '🔴'); // 9→5 beyond 1
		assert.equal(metricColor(11, 10, { direction: 'up', integer: true }), '🟡'); // 11→10
		assert.equal(metricColor(11, 9, { direction: 'up', integer: true }), '🔴'); // 11→9
	});
	it('worse within/beyond the (continuous) margin for a lower-is-better metric (cost/tokens)', () => {
		assert.equal(metricColor(100, 103, { direction: 'down' }), '🟡'); // +3 within 5
		assert.equal(metricColor(100, 110, { direction: 'down' }), '🔴'); // +10 beyond 5
	});
	it('null when either side is missing (caller renders 🆕 / —)', () => {
		assert.equal(metricColor(null, 5, { direction: 'up' }), null);
		assert.equal(metricColor(5, null, { direction: 'up' }), null);
		assert.equal(metricColor(undefined, undefined), null);
	});
});

describe('formatters', () => {
	it('humanTokens compacts to K', () => {
		assert.equal(humanTokens(3456), '3.5K');
		assert.equal(humanTokens(3000), '3K');
		assert.equal(humanTokens(800), '800');
		assert.equal(humanTokens(null), '—');
	});
	it('fmtCost trims trailing zeros', () => {
		assert.equal(fmtCost(3.5), '$3.5');
		assert.equal(fmtCost(2), '$2');
		assert.equal(fmtCost(1.05), '$1.05');
		assert.equal(fmtCost(null), '—');
	});
	it('fmtScore to 1 decimal', () => {
		assert.equal(fmtScore(66.7), '66.7');
		assert.equal(fmtScore(108.3), '108.3');
		assert.equal(fmtScore(null), '—');
	});
});

describe('buildAggregate(cells, meta) — schema 2', () => {
	const agg = buildAggregate([PARTIAL, PASS, AGENT_FAIL, HARNESS, UNKNOWN, { task: 'x', error: 'unreadable' }], {
		sha: 'abc123',
		event: 'pull_request',
		generated_at: '2026-06-29T00:00:00Z',
	});
	const byKey = Object.fromEntries(agg.cells.map((c) => [cellKey(c), c]));

	it('is schema 2 with headline numbers + provenance', () => {
		assert.equal(agg.schema, 2);
		assert.equal(agg.sha, 'abc123');
		assert.equal(agg.mean_composite, 52.3);
		assert.equal(agg.scored_cells, 3);
	});
	it('drops artifact-unreadable cells, keeps every gradeable/harness cell', () => {
		assert.equal(agg.cells.length, 5);
		assert.ok(!agg.cells.some((c) => c.task === 'x'));
	});
	it('carries the new per-cell metric fields (tokens, cost, score, tests, dims, stop_reason)', () => {
		const p = byKey['auth-notes/demo'];
		assert.equal(p.composite, 92);
		assert.equal(p.tests_passed, 4);
		assert.equal(p.tests_denom, 4);
		assert.equal(p.tokens_in, 200000);
		assert.equal(p.tokens_out, 30000);
		assert.equal(p.cost, 1.75); // (200000*5 + 30000*25)/1e6
		assert.equal(p.score, 52.6); // 92 / 1.75
		assert.equal(p.stop_reason, 'end_turn');
		assert.deepEqual(p.judge_dimensions, DIMS);
	});
	it('a cell with no tokens has cost + score null (never a fake $0)', () => {
		assert.equal(byKey['sql-kb/nextjs'].composite, 0);
		assert.equal(byKey['sql-kb/nextjs'].cost, null);
		assert.equal(byKey['sql-kb/nextjs'].score, null);
	});
	it('cells are sorted by task/template', () => {
		const keys = agg.cells.map(cellKey);
		assert.deepEqual(keys, [...keys].sort((a, b) => a.localeCompare(b)));
	});
});

describe('deltaBall(delta)', () => {
	it('🟢 / 🔴 beyond ±5, 🟡 within (inclusive), empty for null', () => {
		assert.equal(deltaBall(5.2), '🟢');
		assert.equal(deltaBall(-6.4), '🔴');
		assert.equal(deltaBall(0), '🟡');
		assert.equal(deltaBall(5), '🟡');
		assert.equal(deltaBall(null), '');
	});
});

describe('diffAgainstBaseline(current, baseline)', () => {
	const current = buildAggregate([PASS, PARTIAL, { task: 'brand-new', template: 'demo', tests_passed: 2, tests_failed: 0, judge_score: 10, tokens_in: 50000, tokens_out: 5000 }], {});
	const baseline = {
		schema: 2,
		mean_composite: 70,
		cells: [
			{ task: 'auth-notes', template: 'demo', composite: 80, judge_score: 7, tests_passed: 4, tests_denom: 4, judge_dimensions: { functional_completeness: 9, selector_contract: 8, persistence: 8, code_quality: 7, blocks_fidelity: 8 }, cost: 2.0, score: 40, tokens_in: 190000, tokens_out: 28000 },
			{ task: 'file-gallery', template: 'bare', composite: 70, tests_passed: 3, tests_denom: 4, cost: 0.6, score: 116.7, tokens_in: 100000, tokens_out: 20000 },
			{ task: 'removed', template: 'x', composite: 50, tests_passed: 5, tests_denom: 5 },
		],
	};
	const diff = diffAgainstBaseline(current, baseline);
	const byKey = Object.fromEntries(diff.rows.map((r) => [r.key, r]));

	it('keeps the COMPOSITE delta on each row (used by the headline + analysis roll-up)', () => {
		assert.equal(byKey['auth-notes/demo'].delta, 12); // 92 - 80
		assert.equal(byKey['file-gallery/bare'].delta, -5); // 65 - 70
		assert.equal(diff.meanDelta, round1Delta(diff.meanCurrent, 70));
	});
	it('attaches pr + base metric objects for the tables', () => {
		const r = byKey['auth-notes/demo'];
		assert.equal(r.pr.cost, 1.75);
		assert.equal(r.base.cost, 2.0);
		assert.equal(r.pr.tests_passed, 4);
		assert.equal(r.base.judge_score, 7);
		assert.deepEqual(r.base.judge_dimensions.functional_completeness, 9);
	});
	it('a new cell has base=null; a removed cell surfaces with pr=null', () => {
		assert.equal(byKey['brand-new/demo'].base, null);
		assert.equal(byKey['brand-new/demo'].hasBaselineCell, false);
		const gone = byKey['removed/x'];
		assert.equal(gone.removed, true);
		assert.equal(gone.pr, null);
		assert.equal(gone.baseline, 50);
	});
	it('null baseline → hasBaseline false, every base null', () => {
		const noBase = diffAgainstBaseline(current, null);
		assert.equal(noBase.hasBaseline, false);
		assert.equal(noBase.rows.every((r) => r.base === null), true);
	});
});

function round1Delta(a, b) {
	return Math.round((a - b) * 10) / 10;
}

describe('renderOverview(diff) — colors only', () => {
	const current = buildAggregate([PASS], {});
	const baseline = {
		schema: 2,
		mean_composite: 92,
		cells: [{ task: 'auth-notes', template: 'demo', composite: 92, judge_score: 8, tests_passed: 4, tests_denom: 4, cost: 2.0, score: 46, tokens_in: 190000, tokens_out: 28000 }],
	};
	const md = renderOverview(diffAgainstBaseline(current, baseline), { heading: '## Overview' }).join('\n');

	it('has the colors-only column header incl. the Δ vs base column and no baseline->pr numbers', () => {
		assert.match(md, /\| Task \| Template \| Tests \| Judge \| Cost \| Tokens \(in\/out\) \| Score \| Δ vs base \|/);
		assert.doesNotMatch(md, /->/); // Overview is glyphs only
	});
	it('colors each metric vs baseline + a per-row composite Δ ball', () => {
		// tests 4/4 vs 4/4 → 🟢 ; judge 8 vs 8 → 🟢 ; cost $1.75 vs $2.0 (lower) → 🟢 ;
		// tokens_in 200k vs 190k (higher=worse, beyond 5%) → 🔴 ; score 52.6 vs 46 (higher) → 🟢 ;
		// composite 92 vs 92 → Δ 0 → 🟡 (flat, within the ±5-point band)
		const row = md.split('\n').find((l) => l.includes('auth-notes'));
		assert.match(row, /\| auth-notes \| demo \| 🟢 \| 🟢 \| 🟢 \| 🔴\/🔴 \| 🟢 \| 🟡 \|/);
	});
	it('no-baseline mode flags every metric AND the Δ column 🆕', () => {
		const noBase = renderOverview(diffAgainstBaseline(current, null), {}).join('\n');
		const row = noBase.split('\n').find((l) => l.includes('auth-notes'));
		assert.match(row, /\| auth-notes \| demo \| 🆕 \| 🆕 \| 🆕 \| 🆕\/🆕 \| 🆕 \| 🆕 \|/);
	});
});

describe('renderDetailed(diff) — numbers', () => {
	const current = buildAggregate([PASS], {});
	const baseline = {
		schema: 2,
		mean_composite: 92,
		cells: [{ task: 'auth-notes', template: 'demo', composite: 92, judge_score: 8, tests_passed: 4, tests_denom: 4, judge_dimensions: { functional_completeness: 9, selector_contract: 8, persistence: 8, code_quality: 7, blocks_fidelity: 8 }, cost: 2.0, score: 46, tokens_in: 190000, tokens_out: 28000 }],
	};
	const md = renderDetailed(diffAgainstBaseline(current, baseline), {}).join('\n');
	const row = md.split('\n').find((l) => l.includes('auth-notes'));

	it('has the detailed column header incl. Δ vs base and Stop reason', () => {
		assert.match(md, /\| Task \| Template \| Tests \| Judge \| Cost \| Tokens \| Score \| Δ vs base \| Stop reason \|/);
	});
	it('renders tests as colored baseline->pr counts', () => {
		assert.match(row, /🟢 4\/4 -> 4\/4/);
	});
	it('renders the judge cell multi-line per dimension with color + baseline->pr', () => {
		// functional_completeness 9→8 (down 1, within margin 1) → 🟡 ; code_quality 7→8 (better) → 🟢
		assert.match(row, /🟡 functional_completeness 9 -> 8/);
		assert.match(row, /🟢 code_quality 7 -> 8/);
		assert.match(row, /<br>/); // dimensions on separate lines
	});
	it('renders cost, tokens (in/out), score, Δ vs base, and stop reason with numbers', () => {
		assert.match(row, /🟢 \$2 -> \$1\.75/); // cost lower = better
		assert.match(row, /in 🔴 190K -> 200K<br>out 🔴 28K -> 30K/);
		assert.match(row, /🟢 46 -> 52\.6/); // score higher = better
		assert.match(row, /🟡 0\.0 \| end_turn \|/); // composite 92 vs 92 → Δ 0 → 🟡 flat, ball + signed number
		assert.match(row, /\| end_turn \|/);
	});
	it('a removed cell shows a 🗑️ marker', () => {
		const withRemoved = diffAgainstBaseline(current, {
			schema: 2,
			mean_composite: 80,
			cells: [
				{ task: 'auth-notes', template: 'demo', composite: 92, tests_passed: 4, tests_denom: 4 },
				{ task: 'gone', template: 'demo', composite: 40, tests_passed: 2, tests_denom: 5 },
			],
		});
		const dmd = renderDetailed(withRemoved, {}).join('\n');
		assert.match(dmd, /\| gone \| demo \| 🗑️ removed \(was 2\/5\)/);
	});
});

describe('Δ vs base column — per-row composite delta ball', () => {
	const mk = (task, tp, tf, judge) => ({ task, template: 'demo', tests_passed: tp, tests_failed: tf, judge_score: judge, tokens_in: 100000, tokens_out: 10000, stop_reason: 'end_turn' });
	// composites: imp 4/4·8 → 92 ; reg 1/4·3 → 27 ; flat 4/4·8 → 92 ; fresh 4/4·8 → 92 (no baseline cell)
	const current = buildAggregate([mk('imp', 4, 0, 8), mk('reg', 1, 3, 3), mk('flat', 4, 0, 8), mk('fresh', 4, 0, 8)], {});
	const baseline = {
		schema: 2,
		mean_composite: 80,
		cells: [
			{ task: 'imp', template: 'demo', composite: 60 }, // 92 - 60 = +32 → 🟢 improved
			{ task: 'reg', template: 'demo', composite: 90 }, // 27 - 90 = -63 → 🔴 regressed
			{ task: 'flat', template: 'demo', composite: 90 }, // 92 - 90 = +2 → 🟡 flat (within ±5)
			// 'fresh' has no baseline cell → 🆕
		],
	};
	const ov = renderOverview(diffAgainstBaseline(current, baseline), {}).join('\n');
	const de = renderDetailed(diffAgainstBaseline(current, baseline), {}).join('\n');
	const cellOf = (md, task) => md.split('\n').find((l) => l.includes(`| ${task} |`));

	it('Overview shows 🟢 improved / 🔴 regressed / 🟡 flat / 🆕 no-base as the trailing column', () => {
		assert.match(cellOf(ov, 'imp'), /🟢 \|$/);
		assert.match(cellOf(ov, 'reg'), /🔴 \|$/);
		assert.match(cellOf(ov, 'flat'), /🟡 \|$/);
		assert.match(cellOf(ov, 'fresh'), /🆕 \|$/);
	});
	it('Detailed shows the ball + signed delta (🆕 for a no-base cell)', () => {
		assert.match(cellOf(de, 'imp'), /🟢 \+32\.0 \| end_turn \|/);
		assert.match(cellOf(de, 'reg'), /🔴 -63\.0 \| end_turn \|/);
		assert.match(cellOf(de, 'flat'), /🟡 \+2\.0 \| end_turn \|/);
		assert.match(cellOf(de, 'fresh'), /🆕 \| end_turn \|/);
	});
});

describe('baselineHasMetrics(baseline) — the per-metric gate', () => {
	it('true only for a schema-2+ baseline (carries the per-metric set)', () => {
		assert.equal(baselineHasMetrics({ schema: 2, cells: [] }), true);
		assert.equal(baselineHasMetrics({ schema: 3, cells: [] }), true);
	});
	it('false for schema-1, a missing schema, or null (NOT per-metric comparable)', () => {
		assert.equal(baselineHasMetrics({ schema: 1, cells: [] }), false);
		assert.equal(baselineHasMetrics({ cells: [] }), false);
		assert.equal(baselineHasMetrics(null), false);
		assert.equal(baselineHasMetrics(undefined), false);
	});
});

// REGRESSION GUARD for the "Judge colored while everything else is 🆕" bug: a schema-1 baseline lacked
// the per-metric fields, so coloring lit up Judge alone. The fix gates all per-metric coloring on
// baseline completeness → schema-1 renders every column 🆕 while the composite mean/delta stays comparable.
describe('schema-1 baseline → every column (Judge included) is 🆕', () => {
	// Exactly what the OLD buildAggregate wrote: composite/judge_score/test_rate only.
	const SCHEMA1 = {
		schema: 1,
		mean_composite: 80,
		cells: [{ task: 'auth-notes', template: 'demo', composite: 80, verdict: 'pass', klass: null, judge_score: 7, test_rate: 1 }],
	};
	const diff = diffAgainstBaseline(buildAggregate([PASS], {}), SCHEMA1);

	it('is recognized as a baseline, but NOT a per-metric one', () => {
		assert.equal(diff.hasBaseline, true); // a baseline WAS found in S3…
		assert.equal(diff.perMetricBaseline, false); // …but it can't diff per-metric
		assert.equal(diff.rows.every((r) => r.base === null), true); // so no base metrics
	});
	it('keeps the composite mean/delta comparable (the headline still works)', () => {
		assert.equal(diff.rows.find((r) => r.key === 'auth-notes/demo').delta, 12); // 92 - 80
		assert.equal(diff.meanDelta, round1Delta(diff.meanCurrent, 80));
	});
	it('Overview: per-METRIC columns render 🆕 (the bug) — but the composite Δ still colors', () => {
		const row = renderOverview(diff, {}).find((l) => l.includes('auth-notes'));
		// metric columns 🆕 (schema-1 has no per-metric baseline), Δ vs base 🟢 (composite 92 vs 80 → +12)
		assert.match(row, /\| auth-notes \| demo \| 🆕 \| 🆕 \| 🆕 \| 🆕\/🆕 \| 🆕 \| 🟢 \|/);
		// The composite Δ is the ONLY colored cell — composite persists in schema 1, so its delta is comparable.
		const metricsOnly = row.replace(/ 🟢 \|$/, ' |');
		assert.doesNotMatch(metricsOnly, /🟢|🟡|🔴/); // no PER-METRIC cell colors against a schema-1 baseline
	});
	it('Detailed: per-metric columns are 🆕 + numbers — only the composite Δ colors', () => {
		const row = renderDetailed(diff, {}).find((l) => l.includes('auth-notes'));
		assert.match(row, /🟢 \+12\.0/); // composite 92 vs 80 → Δ +12 → 🟢 (comparable even for schema-1)
		const metricsOnly = row.replace(/🟢 \+12\.0 \|/, '|');
		assert.doesNotMatch(metricsOnly, /🟢|🟡|🔴/); // no PER-METRIC cell colors against a schema-1 baseline
		assert.doesNotMatch(row, /->/); // 🆕 cells show the pr value only, no baseline->pr
		assert.match(row, /🆕 functional_completeness 8/); // judge dims are 🆕, not colored
	});
});
