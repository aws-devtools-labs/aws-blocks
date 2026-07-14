// Unit tests for the PR-vs-baseline report helpers (overview.mjs): the diff math, the delta color
// engine, formatters, and the single results table (renderDetailed) + preword. Run under bare `node --test`.

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
	renderPreword,
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
		assert.equal(DELTA_THRESHOLDS.turns, 3);
		assert.equal(DELTA_THRESHOLDS.cacheReadPct, 0.2);
		assert.equal(DELTA_THRESHOLDS.cacheWritePct, 0.2);
		assert.equal(DELTA_THRESHOLDS.costAbs, 0.02);
		assert.equal(DELTA_THRESHOLDS.tokensAbs, 1000);
	});
	it('LOC & Files have NO threshold (rendered neutral, never colored)', () => {
		assert.equal('loc' in DELTA_THRESHOLDS, false);
		assert.equal('files' in DELTA_THRESHOLDS, false);
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
		assert.equal(humanTokens(2396400), '2.4M');
		assert.equal(humanTokens(13835800), '13.8M');
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
	it('non-finite numbers render as the em-dash (never Infinity / NaN leaking into the table)', () => {
		assert.equal(humanTokens(Infinity), '—');
		assert.equal(humanTokens(-Infinity), '—');
		assert.equal(humanTokens(NaN), '—');
		assert.equal(fmtCost(Infinity), '—');
		assert.equal(fmtScore(Infinity), '—');
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
	it('persists the newer per-cell signals (cycle_count, cache, loc, files) for future baselines', () => {
		const full = buildAggregate([{ ...PASS, cycle_count: 22, cache_read_tokens: 150000, cache_write_tokens: 12000, loc_created: 300, loc_edited: 40, files_created: 8, files_edited: 3 }], {});
		const c = full.cells[0];
		assert.equal(c.cycle_count, 22);
		assert.equal(c.cache_read_tokens, 150000);
		assert.equal(c.cache_write_tokens, 12000);
		assert.equal(c.loc_created, 300);
		assert.equal(c.loc_edited, 40);
		assert.equal(c.files_created, 8);
		assert.equal(c.files_edited, 3);
	});
	it('newer signals are null when the cell lacks them (older artifacts)', () => {
		const c = byKey['auth-notes/demo'];
		assert.equal(c.cycle_count, null);
		assert.equal(c.cache_read_tokens, null);
		assert.equal(c.loc_created, null);
		assert.equal(c.files_created, null);
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

// A full-feature cell exercising every column: per-dim judge, cache tokens, turns, LOC, files.
const FULL = {
	task: 'auth-notes',
	template: 'demo',
	tests_passed: 4,
	tests_failed: 0,
	judge_score: 8,
	judge_dimensions: { functional_completeness: 9, selector_contract: 8, persistence: 7, code_quality: 8, blocks_fidelity: 8 },
	tokens_in: 200000,
	tokens_out: 30000,
	cache_read_tokens: 150000,
	cache_write_tokens: 12000,
	cycle_count: 22,
	loc_created: 300,
	loc_edited: 40,
	files_created: 8,
	files_edited: 3,
	stop_reason: 'end_turn',
}; // comp 92 · cost 1.75 · score 52.6

// A baseline that carries ALL of FULL's metrics, so each column has a real delta to color.
const BASE_FULL = {
	schema: 2,
	mean_composite: 90,
	cells: [
		{
			task: 'auth-notes',
			template: 'demo',
			composite: 90,
			judge_score: 7,
			judge_dimensions: { functional_completeness: 7, selector_contract: 8, persistence: 9, code_quality: 8, blocks_fidelity: 8 },
			tests_passed: 4,
			tests_denom: 4,
			cost: 2.0,
			score: 40,
			tokens_in: 190000,
			tokens_out: 28000,
			cache_read_tokens: 100000,
			cache_write_tokens: 10000,
			cycle_count: 18,
			loc_created: 250,
			loc_edited: 30,
			files_created: 6,
			files_edited: 2,
		},
	],
};

describe('renderDetailed(diff) — the expanded single results table', () => {
	const rowFor = (diff) => renderDetailed(diff, {}).join('\n').split('\n').find((l) => l.includes('auth-notes'));

	it('has the expanded 11-column header — Tests|Judge|Cost|Tokens|Turns|LOC|Files|Score|Stop reason', () => {
		const md = renderDetailed(diffAgainstBaseline(buildAggregate([FULL], {}), BASE_FULL), {}).join('\n');
		assert.match(md, /\| Task \| Template \| Tests \| Judge \| Cost \| Tokens \| Turns \| LOC \| Files \| Score \| Stop reason \|/);
		assert.doesNotMatch(md, /Δ vs base/);
		assert.doesNotMatch(md, /->/); // no arrows anywhere
	});

	it('scalar cells are INLINE `<ball> <value> (<Δ>)` (tests/cost/turns/score)', () => {
		const row = rowFor(diffAgainstBaseline(buildAggregate([FULL], {}), BASE_FULL));
		assert.match(row, /🟡 4\/4 \(0\)/); // tests 4→4, ±1 → 🟡
		assert.match(row, /🟢 \$1\.75 \(-\$0\.25\)/); // cost $2→$1.75 (−12.5% beyond ±10%) → 🟢
		assert.match(row, /🔴 22 \(\+4\)/); // turns 18→22 (+4 beyond ±3, lower-better) → 🔴
		assert.match(row, /🟢 52\.6 \(\+12\.6\)/); // score 40→52.6 (+12.6 beyond ±5) → 🟢
		assert.match(row, /\| end_turn \|$/); // stop reason retained, last column
	});

	it('JUDGE stacks one <br>-joined line per rubric dimension with per-dim deltas', () => {
		const row = rowFor(diffAgainstBaseline(buildAggregate([FULL], {}), BASE_FULL));
		assert.match(row, /functional 🟢 9 \(\+2\)/); // 7→9 beyond ±0.3 → 🟢
		assert.match(row, /selectors 🟡 8 \(0\)/); // flat → 🟡
		assert.match(row, /persistence 🔴 7 \(-2\)/); // 9→7 → 🔴
		assert.match(row, /code 🟡 8 \(0\)/);
		assert.match(row, /blocks 🟡 8 \(0\)/);
		assert.match(row, /functional[^|]*<br>[^|]*selectors/); // dims are <br>-stacked in one cell
	});

	it('TOKENS stacks in / out / cached in / cached out', () => {
		const row = rowFor(diffAgainstBaseline(buildAggregate([FULL], {}), BASE_FULL));
		assert.match(row, /in 🟡 200K \(\+10K\)/); // +10K within ±10% of 190K → 🟡
		assert.match(row, /out 🟡 30K \(\+2K\)/); // +2K within ±10% of 28K → 🟡
		assert.match(row, /cached in 🔴 150K \(\+50K\)/); // +50K beyond ±20% of 100K, lower-better → 🔴
		assert.match(row, /cached out 🟡 12K \(\+2K\)/); // +2K exactly ±20% of 10K (inclusive) → 🟡
	});

	it('LOC & Files are NEUTRAL — always ⚪, value + signed delta, NEVER 🟢/🔴', () => {
		const row = rowFor(diffAgainstBaseline(buildAggregate([FULL], {}), BASE_FULL));
		assert.match(row, /created ⚪ 300 \(\+50\)<br>edited ⚪ 40 \(\+10\)/); // LOC neutral despite +50 lines
		assert.match(row, /created ⚪ 8 \(\+2\)<br>edited ⚪ 3 \(\+1\)/); // Files neutral
	});

	it('uses the literal `<br>` HTML break (NOT a newline) so GFM keeps stacked lines in one cell', () => {
		const row = rowFor(diffAgainstBaseline(buildAggregate([FULL], {}), BASE_FULL));
		assert.ok(row.includes('<br>'), 'multi-line cells must use the literal <br> separator');
		assert.doesNotMatch(row, /\n/); // the row is a single physical line
		assert.doesNotMatch(row, /`[^`]*<br>[^`]*`/); // <br> never inside backticks/code span
	});

	it('no baseline at all → ⚪ + the CURRENT value + (new) for every metric (value never hidden)', () => {
		const row = rowFor(diffAgainstBaseline(buildAggregate([FULL], {}), null));
		assert.match(row, /⚪ 4\/4 \(new\)/); // tests
		assert.match(row, /functional ⚪ 9 \(new\)/); // per-dim judge
		assert.match(row, /⚪ \$1\.75 \(new\)/); // cost
		assert.match(row, /in ⚪ 200K \(new\)/); // tokens in
		assert.match(row, /cached in ⚪ 150K \(new\)/); // cache read
		assert.match(row, /⚪ 22 \(new\)/); // turns
		assert.match(row, /created ⚪ 300 \(new\)/); // loc created
		assert.match(row, /created ⚪ 8 \(new\)/); // files created
		assert.match(row, /⚪ 52\.6 \(new\)/); // score
	});

	it('a run that predates cache/turns/LOC/files: those read ⚪ "(new)" or — while in/out still color', () => {
		// PASS has tokens_in/out + judge_dimensions but NO cache/turns/loc/files.
		const row = rowFor(diffAgainstBaseline(buildAggregate([PASS], {}), BASE_FULL));
		assert.match(row, /in 🟡 200K/); // in/out present → colored
		assert.match(row, /cached in ⚪ — \(new\)/); // cache absent this run → ⚪ — (new)
		// turns/loc/files entirely absent this run → their cells collapse to the NONE placeholder.
		const inner = row.split('|').slice(1, -1).map((c) => c.trim());
		assert.equal(inner.length, 11);
		assert.equal(inner[6], '—'); // Turns column (index: Task,Template,Tests,Judge,Cost,Tokens,Turns)
		assert.equal(inner[7], '—'); // LOC
		assert.equal(inner[8], '—'); // Files
	});

	it('EVERY row emits exactly 11 columns — even a crashed cell with null everything', () => {
		const CRASH = { task: 'crash', template: 'nextjs', klass: 'agent_fail', tests_passed: 0, tests_failed: 0 };
		const cmd = renderDetailed(diffAgainstBaseline(buildAggregate([FULL, CRASH], {}), null), {}).join('\n');
		const dataRows = cmd.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Task') && !l.startsWith('|--') && !l.startsWith('|---'));
		assert.equal(dataRows.length, 2);
		for (const line of dataRows) {
			const inner = line.split('|').slice(1, -1);
			assert.equal(inner.length, 11, `row must have 11 columns, got ${inner.length}: ${line}`);
			assert.ok(inner.every((c) => c.trim().length > 0), `no column may be empty: ${line}`);
		}
		const crashRow = dataRows.find((l) => l.includes('| crash |'));
		assert.match(crashRow, /\| crash \| nextjs \| — \| — \| — \| — \| — \| — \| — \| — \| — \|/); // 9 placeholder metric cols
	});

	it('a removed cell shows a 🗑️ marker with the last-known test count, still 11 columns', () => {
		const withRemoved = diffAgainstBaseline(buildAggregate([FULL], {}), {
			schema: 2,
			mean_composite: 80,
			cells: [
				{ task: 'auth-notes', template: 'demo', composite: 92, tests_passed: 4, tests_denom: 4 },
				{ task: 'gone', template: 'demo', composite: 40, tests_passed: 2, tests_denom: 5 },
			],
		});
		const dmd = renderDetailed(withRemoved, {}).join('\n');
		const goneRow = dmd.split('\n').find((l) => l.includes('| gone |'));
		assert.match(goneRow, /\| gone \| demo \| 🗑️ removed \(was 2\/5\)/);
		assert.equal(goneRow.split('|').slice(1, -1).length, 11);
	});

	it('judge column renders ALL common dimensions (missing ones as ⚪ —) so stacked rows stay aligned', () => {
		const partialDims = { ...FULL, judge_dimensions: { functional_completeness: 9, selector_contract: 8, code_quality: 7 } };
		const row = rowFor(diffAgainstBaseline(buildAggregate([partialDims], {}), null));
		const judge = row.split('|').slice(1, -1).map((c) => c.trim())[3];
		assert.equal(judge.split('<br>').length, 5); // all 5 dims stacked, none skipped
		assert.match(judge, /functional ⚪ 9 \(new\)/); // present dim renders its score
		assert.match(judge, /persistence ⚪ — \(new\)/); // missing dim renders — (not dropped)
		assert.match(judge, /blocks ⚪ — \(new\)/);
	});

	it('cache delta floors the noise band at an absolute threshold when the baseline is ~0', () => {
		const cur = buildAggregate([{ ...FULL, cache_read_tokens: 800 }], {});
		const base = { schema: 2, mean_composite: 90, cells: [{ ...BASE_FULL.cells[0], cache_read_tokens: 0 }] };
		const row = rowFor(diffAgainstBaseline(cur, base));
		assert.match(row, /cached in 🟡 800/); // +800 within the 1000 floor → 🟡, NOT 🔴
	});

	it('a removed cell whose baseline lacks a test denom omits the "(was …)" suffix (never prints /null)', () => {
		const withRemoved = diffAgainstBaseline(buildAggregate([FULL], {}), {
			schema: 2,
			mean_composite: 80,
			cells: [
				{ task: 'auth-notes', template: 'demo', composite: 92, tests_passed: 4, tests_denom: 4 },
				{ task: 'gone', template: 'demo', composite: 40, tests_passed: 2, tests_denom: null },
			],
		});
		const goneRow = renderDetailed(withRemoved, {}).join('\n').split('\n').find((l) => l.includes('| gone |'));
		assert.match(goneRow, /🗑️ removed/);
		assert.doesNotMatch(goneRow, /\(was/);
		assert.doesNotMatch(goneRow, /null/);
	});
});

describe('renderPreword(diff, aggregate, opts) — bulleted run summary', () => {
	const current = buildAggregate([FULL, PARTIAL, AGENT_FAIL, HARNESS], { sha: 'deadbeef' });
	const diff = diffAgainstBaseline(current, BASE_FULL);
	const bullets = renderPreword(diff, current, { builderModel: 'claude-opus-4-8', judgeModel: 'claude-opus-4-8', baselineSha: '6853382abc' });
	const md = bullets.join('\n');

	it('every line is a markdown bullet', () => {
		assert.ok(bullets.length > 0);
		assert.ok(bullets.every((b) => b.startsWith('- ')));
	});
	it('leads with mean composite + Δ vs main + judge mean', () => {
		assert.match(md, /Mean composite [\d.]+\/100/);
		assert.match(md, /vs `main`/);
		assert.match(md, /judge mean [\d.]+\/10/);
	});
	it('tallies verdicts (pass/partial/fail/harness_error)', () => {
		assert.match(md, /\*\*Verdicts:\*\* \d+ pass · \d+ partial · \d+ fail · \d+ harness_error/);
	});
	it('reports totals (cost, tokens in/out, turns)', () => {
		assert.match(md, /\*\*Totals:\*\*/);
		assert.match(md, /tokens .*in .*out/);
		assert.match(md, /turns/);
	});
	it('lists biggest gains / drops by composite Δ when a baseline exists', () => {
		assert.match(md, /\*\*Biggest gains:\*\*/);
		assert.match(md, /\*\*Biggest drops:\*\*/);
	});
	it('carries the run config (builder + judge model, baseline sha)', () => {
		assert.match(md, /\*\*Config:\*\*/);
		assert.match(md, /builder `claude-opus-4-8`/);
		assert.match(md, /judge `claude-opus-4-8`/);
		assert.match(md, /baseline `6853382`/); // truncated to 7 chars
	});
	it('with no baseline: no gains/drops bullets, says "no `main` baseline yet"', () => {
		const noBase = renderPreword(diffAgainstBaseline(current, null), current, {});
		const nmd = noBase.join('\n');
		assert.match(nmd, /no `main` baseline yet/);
		assert.doesNotMatch(nmd, /Biggest gains/);
	});
	it('an all-failed run (no token data) shows "tokens —" in totals, not "0 in / 0 out"', () => {
		const failedOnly = buildAggregate([AGENT_FAIL, HARNESS], { sha: 'deadfeed' });
		const fmd = renderPreword(diffAgainstBaseline(failedOnly, null), failedOnly, {}).join('\n');
		assert.match(fmd, /tokens —/);
		assert.doesNotMatch(fmd, /0 in \/ 0 out/);
	});
});
