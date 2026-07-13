// Unit tests for the PR-vs-baseline report helpers (overview.mjs): the diff math, the delta color
// engine, formatters, and the single results table (renderDetailed). Run under bare `node --test`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	DELTA_THRESHOLDS,
	buildAggregate,
	cellComposite,
	cellKey,
	deltaBall,
	deltaColor,
	diffAgainstBaseline,
	fmtCost,
	fmtJudge,
	fmtScore,
	humanTokens,
	meanComposite,
	renderDetailed,
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

describe('DELTA_THRESHOLDS — the one place the bands live', () => {
	it('holds the documented per-metric thresholds', () => {
		assert.equal(DELTA_THRESHOLDS.composite, 5);
		assert.equal(DELTA_THRESHOLDS.score, 5);
		assert.equal(DELTA_THRESHOLDS.judge, 0.3);
		assert.equal(DELTA_THRESHOLDS.tests, 1);
		assert.equal(DELTA_THRESHOLDS.costPct, 0.1);
		assert.equal(DELTA_THRESHOLDS.tokensPct, 0.1);
	});
});

describe('deltaColor(baseline, pr, threshold, direction) — significance + direction of the change', () => {
	it('higher-is-better: 🟢 beyond threshold up, 🔴 beyond threshold down, 🟡 within (either way)', () => {
		assert.equal(deltaColor(5, 11, 5, 'up'), '🟢'); // +6 beyond +5 → improved
		assert.equal(deltaColor(11, 5, 5, 'up'), '🔴'); // -6 beyond -5 → regressed
		assert.equal(deltaColor(10, 13, 5, 'up'), '🟡'); // +3 within → noise
		assert.equal(deltaColor(10, 10, 5, 'up'), '🟡'); // flat → noise
	});
	it('lower-is-better (cost/tokens): a DROP is 🟢, a RISE is 🔴', () => {
		assert.equal(deltaColor(100, 80, 5, 'down'), '🟢'); // -20 → improved (cheaper)
		assert.equal(deltaColor(100, 120, 5, 'down'), '🔴'); // +20 → regressed (pricier)
		assert.equal(deltaColor(100, 103, 5, 'down'), '🟡'); // +3 within → noise
	});
	it('the threshold boundary is inclusive-of-noise (exactly ±threshold is 🟡, not 🟢/🔴)', () => {
		assert.equal(deltaColor(0, 5, 5, 'up'), '🟡'); // exactly +threshold
		assert.equal(deltaColor(0, -5, 5, 'up'), '🟡'); // exactly -threshold
	});
	it('⚪ when either side is missing (no baseline value for the field)', () => {
		assert.equal(deltaColor(null, 5, 5, 'up'), '⚪');
		assert.equal(deltaColor(5, null, 5, 'up'), '⚪');
		assert.equal(deltaColor(undefined, undefined, 5, 'up'), '⚪');
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
	it('fmtJudge: integer as-is, else 1 decimal', () => {
		assert.equal(fmtJudge(8), '8');
		assert.equal(fmtJudge(7.5), '7.5');
		assert.equal(fmtJudge(null), '—');
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

describe('deltaBall(delta) — headline composite mean-delta', () => {
	it('🟢 / 🔴 beyond ±5, 🟡 within (inclusive), empty for null', () => {
		assert.equal(deltaBall(5.2), '🟢');
		assert.equal(deltaBall(-6.4), '🔴');
		assert.equal(deltaBall(0), '🟡');
		assert.equal(deltaBall(5), '🟡');
		assert.equal(deltaBall(null), '');
	});
});

function round1Delta(a, b) {
	return Math.round((a - b) * 10) / 10;
}

describe('diffAgainstBaseline(current, baseline)', () => {
	const current = buildAggregate([PASS, PARTIAL, { task: 'brand-new', template: 'demo', tests_passed: 2, tests_failed: 0, judge_score: 10, tokens_in: 50000, tokens_out: 5000 }], {});
	const baseline = {
		schema: 2,
		mean_composite: 70,
		cells: [
			{ task: 'auth-notes', template: 'demo', composite: 80, judge_score: 7, tests_passed: 4, tests_denom: 4, cost: 2.0, score: 40, tokens_in: 190000, tokens_out: 28000 },
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
	it('attaches pr + base metric objects for the table', () => {
		const r = byKey['auth-notes/demo'];
		assert.equal(r.pr.cost, 1.75);
		assert.equal(r.base.cost, 2.0);
		assert.equal(r.pr.tests_passed, 4);
		assert.equal(r.base.judge_score, 7);
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
	it('attaches base PER-FIELD: an older baseline missing some fields still attaches (fields read null)', () => {
		const partialBase = {
			mean_composite: 80,
			cells: [{ task: 'auth-notes', template: 'demo', composite: 80, judge_score: 7, test_rate: 1 }], // no tests_passed/cost/tokens/score
		};
		const r = diffAgainstBaseline(buildAggregate([PASS], {}), partialBase).rows.find((x) => x.key === 'auth-notes/demo');
		assert.notEqual(r.base, null); // base IS attached (no whole-row gate)
		assert.equal(r.base.judge_score, 7); // a field it HAS
		assert.equal(r.base.cost, null); // a field it LACKS → null (renders ⚪ "(new)")
		assert.equal(r.base.tests_passed, null);
		assert.equal(r.delta, 12); // composite still comparable (92 - 80)
	});
});

describe('renderDetailed(diff) — the single results table', () => {
	const current = buildAggregate([PASS], {});
	const baseline = {
		schema: 2,
		mean_composite: 92,
		cells: [{ task: 'auth-notes', template: 'demo', composite: 92, judge_score: 8, tests_passed: 4, tests_denom: 4, cost: 2.0, score: 46, tokens_in: 190000, tokens_out: 28000 }],
	};
	const md = renderDetailed(diffAgainstBaseline(current, baseline), {}).join('\n');
	const row = md.split('\n').find((l) => l.includes('auth-notes'));

	it('has the single-table header — no separate Overview, no Δ vs base column', () => {
		assert.match(md, /\| Task \| Template \| Tests \| Judge \| Cost \| Tokens \(in\/out\) \| Score \| Stop reason \|/);
		assert.doesNotMatch(md, /Δ vs base/);
		assert.doesNotMatch(md, /->/); // no arrows anywhere
	});
	it('each metric cell is two lines: `<ball> <current value><br>(<signed delta>)`', () => {
		assert.match(row, /🟡 4\/4<br>\(0\)/); // tests 4→4, within ±1 → 🟡, delta 0
		assert.match(row, /🟡 8<br>\(0\)/); // judge 8→8, within ±0.3 → 🟡
		assert.match(row, /🟢 \$1\.75<br>\(-\$0\.25\)/); // cost $2→$1.75 (−12.5% beyond ±10%) → 🟢 improved
		assert.match(row, /🟡 200K\/30K<br>\(\+12K\)/); // tokens 218K→230K total (+5.5% within ±10%) → 🟡
		assert.match(row, /🟢 52\.6<br>\(\+6\.6\)/); // score 46→52.6 (+6.6 beyond ±5) → 🟢 improved
		assert.match(row, /\| end_turn \|$/); // stop reason retained
	});
	it('uses the literal `<br>` HTML break (NOT a newline) so GFM keeps the two lines inside one table cell', () => {
		// A raw \n would break the markdown table row; code fences would show a literal "<br>". Guard both.
		assert.ok(row.includes('<br>'), 'cell must contain the literal <br> separator');
		assert.doesNotMatch(row, /\n/); // the row is a single physical line
		assert.doesNotMatch(row, /`[^`]*<br>[^`]*`/); // <br> is never inside backticks/code span
	});
	it('no baseline at all → ⚪ + the CURRENT value + (new) for every metric (value never hidden)', () => {
		const noBase = renderDetailed(diffAgainstBaseline(current, null), {}).join('\n');
		const r = noBase.split('\n').find((l) => l.includes('auth-notes'));
		assert.match(r, /⚪ 4\/4<br>\(new\)/);
		assert.match(r, /⚪ 8<br>\(new\)/);
		assert.match(r, /⚪ \$1\.75<br>\(new\)/);
		assert.match(r, /⚪ 200K\/30K<br>\(new\)/);
		assert.match(r, /⚪ 52\.6<br>\(new\)/);
	});
	it('PER-FIELD fallback: an older baseline colors the fields it has, ⚪ "(new)" for those it lacks', () => {
		const partialBase = {
			mean_composite: 80,
			cells: [{ task: 'auth-notes', template: 'demo', composite: 80, judge_score: 7, test_rate: 1 }], // judge only
		};
		const r = renderDetailed(diffAgainstBaseline(current, partialBase), {}).join('\n').split('\n').find((l) => l.includes('auth-notes'));
		assert.match(r, /🟢 8<br>\(\+1\)/); // judge 7→8 beyond ±0.3 → colored 🟢
		assert.match(r, /⚪ 4\/4<br>\(new\)/); // tests: baseline lacks the field → ⚪ (new)
		assert.match(r, /⚪ \$1\.75<br>\(new\)/); // cost: ⚪ (new)
		assert.match(r, /⚪ 200K\/30K<br>\(new\)/); // tokens: ⚪ (new)
		assert.match(r, /⚪ 52\.6<br>\(new\)/); // score: ⚪ (new)
	});
	it('a removed cell shows a 🗑️ marker with the last-known test count', () => {
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

describe('renderDetailed — per-metric DIRECTION (improve vs regress colors correctly)', () => {
	// Current: cheaper cost + fewer tokens (both improvements for lower-is-better), fewer tests passed
	// (a regression for higher-is-better), same judge. Verifies each metric's direction independently.
	const current = buildAggregate([{ task: 't', template: 'demo', tests_passed: 2, tests_failed: 2, judge_score: 8, tokens_in: 100000, tokens_out: 10000, stop_reason: 'end_turn' }], {});
	const baseline = {
		schema: 2,
		mean_composite: 90,
		cells: [{ task: 't', template: 'demo', composite: 90, judge_score: 8, tests_passed: 4, tests_denom: 4, cost: 2.0, score: 20, tokens_in: 300000, tokens_out: 40000 }],
	};
	const row = renderDetailed(diffAgainstBaseline(current, baseline), {}).join('\n').split('\n').find((l) => l.includes('| t |'));

	it('tests regressed (4→2 passes) → 🔴; cost/tokens dropped → 🟢; judge flat → 🟡', () => {
		assert.match(row, /🔴 2\/4<br>\(-2\)/); // fewer passes, beyond ±1
		assert.match(row, /🟢 .*<br>\(-\$/); // cost fell beyond 10% → 🟢
		assert.match(row, /🟢 100K\/10K<br>\(-/); // tokens fell (340K→110K) → 🟢
		assert.match(row, /🟡 8<br>\(0\)/); // judge unchanged → 🟡
	});
});
