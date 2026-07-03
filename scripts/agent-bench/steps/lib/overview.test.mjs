// Unit tests for the PR-vs-baseline overview helpers (overview.mjs).
//
// These pin the diff math and the two render modes (with / without a baseline)
// so the at-a-glance overview at the top of the run summary stays correct and
// can't silently drift from lib/scoring.mjs. Run under bare `node --test` (no
// build step): plain .mjs, same as the module under test.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	buildAggregate,
	cellComposite,
	cellKey,
	deltaArrow,
	diffAgainstBaseline,
	meanComposite,
	renderOverview,
} from './overview.mjs';

// composite(tr, j) = round(60*tr + 4*j*min(1, 4*tr), 1) — see scoring.mjs.
const PASS = { task: 'auth-notes', template: 'demo', tests_passed: 4, tests_failed: 0, judge_score: 8 }; // tr=1 → 60 + 32 = 92
const PARTIAL = { task: 'file-gallery', template: 'bare', tests_passed: 3, tests_failed: 1, judge_score: 5 }; // tr=.75 → 45 + 20 = 65
const AGENT_FAIL = { task: 'sql-kb', template: 'nextjs', klass: 'agent_fail', tests_passed: 0, tests_failed: 0 }; // included, composite 0
const HARNESS = { task: 'oidc-dsql', template: 'react', klass: 'harness_error' }; // excluded → null
const UNKNOWN = { task: 'email-digest', template: 'demo', tests_passed: 0, tests_failed: 0 }; // gradeable, no tests → null

describe('cellComposite(r)', () => {
	it('returns the shared composite for a scored cell', () => {
		assert.equal(cellComposite(PASS), 92);
		assert.equal(cellComposite(PARTIAL), 65);
	});

	it('an agent_fail is scored as composite 0 (included)', () => {
		assert.equal(cellComposite(AGENT_FAIL), 0);
	});

	it('a harness_error is null (excluded)', () => {
		assert.equal(cellComposite(HARNESS), null);
	});

	it('a gradeable cell that ran no tests (unknown) is null (excluded)', () => {
		assert.equal(cellComposite(UNKNOWN), null);
	});
});

describe('meanComposite(cells)', () => {
	it('averages only the scored cells (agent_fail counts as 0; harness/unknown excluded)', () => {
		// (92 + 65 + 0) / 3 = 52.333… → 52.3
		assert.equal(meanComposite([PASS, PARTIAL, AGENT_FAIL, HARNESS, UNKNOWN]), 52.3);
	});

	it('is null when no cell was scored', () => {
		assert.equal(meanComposite([HARNESS, UNKNOWN]), null);
		assert.equal(meanComposite([]), null);
	});

	it('rounds to one decimal', () => {
		// (92 + 65) / 2 = 78.5
		assert.equal(meanComposite([PASS, PARTIAL]), 78.5);
	});
});

describe('buildAggregate(cells, meta)', () => {
	const agg = buildAggregate([PARTIAL, PASS, AGENT_FAIL, HARNESS, UNKNOWN, { task: 'x', error: 'unreadable' }], {
		sha: 'abc123',
		base_sha: 'base999',
		pr_number: '31',
		event: 'pull_request',
		generated_at: '2026-06-29T00:00:00Z',
	});

	it('carries provenance + headline numbers', () => {
		assert.equal(agg.schema, 1);
		assert.equal(agg.sha, 'abc123');
		assert.equal(agg.base_sha, 'base999');
		assert.equal(agg.pr_number, '31');
		assert.equal(agg.event, 'pull_request');
		assert.equal(agg.mean_composite, 52.3);
		assert.equal(agg.scored_cells, 3); // PASS, PARTIAL, AGENT_FAIL
	});

	it('drops artifact-unreadable (error) cells, keeps every gradeable/harness cell', () => {
		// 5 real cells in, the {error} cell dropped.
		assert.equal(agg.cells.length, 5);
		assert.ok(!agg.cells.some((c) => c.task === 'x'));
	});

	it('per-cell composites: scored numeric, excluded null', () => {
		const byKey = Object.fromEntries(agg.cells.map((c) => [cellKey(c), c]));
		assert.equal(byKey['auth-notes/demo'].composite, 92);
		assert.equal(byKey['file-gallery/bare'].composite, 65);
		assert.equal(byKey['sql-kb/nextjs'].composite, 0);
		assert.equal(byKey['oidc-dsql/react'].composite, null);
		assert.equal(byKey['email-digest/demo'].composite, null);
	});

	it('cells are sorted by task/template for stable output', () => {
		const keys = agg.cells.map(cellKey);
		assert.deepEqual(keys, [...keys].sort((a, b) => a.localeCompare(b)));
	});

	it('tolerates empty / missing input', () => {
		const empty = buildAggregate([], {});
		assert.equal(empty.mean_composite, null);
		assert.equal(empty.scored_cells, 0);
		assert.deepEqual(empty.cells, []);
	});
});

describe('deltaArrow(delta)', () => {
	it('▲ for a move larger than the ±5 band, ▼ for a large decrease', () => {
		assert.equal(deltaArrow(5.2), '▲');
		assert.equal(deltaArrow(-6.4), '▼');
	});

	it('≈ for |delta| within the ±5 noise band (incl. zero and the boundary)', () => {
		assert.equal(deltaArrow(0), '≈');
		assert.equal(deltaArrow(3.1), '≈');
		assert.equal(deltaArrow(-4.9), '≈');
		assert.equal(deltaArrow(5), '≈'); // boundary is inclusive: |5| is not > 5
		assert.equal(deltaArrow(-5), '≈');
	});

	it('empty string for a null/NaN delta (no baseline cell)', () => {
		assert.equal(deltaArrow(null), '');
		assert.equal(deltaArrow(undefined), '');
		assert.equal(deltaArrow(Number.NaN), '');
	});
});

describe('diffAgainstBaseline(current, baseline)', () => {
	const current = buildAggregate([PASS, PARTIAL, { task: 'brand-new', template: 'demo', tests_passed: 2, tests_failed: 0, judge_score: 10 }], {});
	// Baseline: auth lower (80), file higher (70), plus a cell that's gone now.
	const baseline = {
		mean_composite: 70,
		cells: [
			{ task: 'auth-notes', template: 'demo', composite: 80 },
			{ task: 'file-gallery', template: 'bare', composite: 70 },
			{ task: 'removed', template: 'x', composite: 50 },
		],
	};
	const diff = diffAgainstBaseline(current, baseline);

	it('matches cells by task/template and computes signed deltas', () => {
		const byKey = Object.fromEntries(diff.rows.map((r) => [r.key, r]));
		assert.equal(byKey['auth-notes/demo'].delta, 12); // 92 - 80
		assert.equal(byKey['file-gallery/bare'].delta, -5); // 65 - 70
	});

	it('a cell with no baseline match has a null delta + hasBaselineCell=false (rendered 🆕)', () => {
		const row = diff.rows.find((r) => r.key === 'brand-new/demo');
		assert.equal(row.baseline, null);
		assert.equal(row.delta, null);
		assert.equal(row.hasBaselineCell, false);
	});

	it('a baseline-only cell (removed/renamed) surfaces as its own row: current+delta null, removed=true', () => {
		// The baseline has `removed/x` (composite 50), absent from `current`. It
		// must NOT silently vanish — it appears as a row flagged `removed`, with a
		// null current + delta so it stays out of the mean, keeping its baseline value.
		const row = diff.rows.find((r) => r.key === 'removed/x');
		assert.ok(row, 'baseline-only cell must appear as a row');
		assert.equal(row.removed, true);
		assert.equal(row.current, null);
		assert.equal(row.delta, null);
		assert.equal(row.baseline, 50);
		assert.equal(row.hasBaselineCell, true);
		// A present-both cell is never flagged removed.
		assert.equal(diff.rows.find((r) => r.key === 'auth-notes/demo').removed, false);
	});

	it('computes the mean delta when both means exist', () => {
		// current mean = (92 + 65 + 100)/3 = 85.7 ; baseline mean = 70 → +15.7
		assert.equal(diff.meanCurrent, 85.7);
		assert.equal(diff.meanBaseline, 70);
		assert.equal(diff.meanDelta, 15.7);
		assert.equal(diff.hasBaseline, true);
	});

	it('rows are sorted by key', () => {
		const keys = diff.rows.map((r) => r.key);
		assert.deepEqual(keys, [...keys].sort((a, b) => a.localeCompare(b)));
	});

	it('null baseline → hasBaseline false, no mean delta, current values intact', () => {
		const noBase = diffAgainstBaseline(current, null);
		assert.equal(noBase.hasBaseline, false);
		assert.equal(noBase.meanBaseline, null);
		assert.equal(noBase.meanDelta, null);
		assert.equal(noBase.meanCurrent, 85.7);
		assert.equal(noBase.rows.every((r) => r.baseline === null && r.delta === null), true);
	});
});

describe('renderOverview(diff, opts)', () => {
	const current = buildAggregate([PASS, PARTIAL], {});

	it('baseline mode renders a Baseline | PR | Δ table with arrows + a bold mean row', () => {
		const baseline = { mean_composite: 70, cells: [{ task: 'auth-notes', template: 'demo', composite: 80 }] };
		const md = renderOverview(diffAgainstBaseline(current, baseline), { heading: '## Overview — PR vs baseline' }).join('\n');
		assert.match(md, /## Overview — PR vs baseline/);
		assert.match(md, /\| Task \| Template \| Baseline \| PR \| Δ \|/);
		assert.match(md, /auth-notes \| demo \| 80\.0 \| 92\.0 \| ▲ \+12\.0/);
		// file-gallery has no baseline cell → 🆕 new
		assert.match(md, /file-gallery \| bare \| — \| 65\.0 \| 🆕 new/);
		assert.match(md, /\*\*Mean\*\* \| \| \*\*70\.0\*\* \| \*\*78\.5\*\*/);
	});

	it('no-baseline mode renders an absolute Composite table + the note', () => {
		const md = renderOverview(diffAgainstBaseline(current, null), { note: '_No baseline found._' }).join('\n');
		assert.match(md, /_No baseline found\._/);
		assert.match(md, /\| Task \| Template \| Composite \|/);
		assert.match(md, /auth-notes \| demo \| 92\.0/);
		assert.match(md, /\*\*Mean\*\* \| \| \*\*78\.5\*\*/);
		// no Δ column when there's no baseline
		assert.doesNotMatch(md, /Baseline \| PR \| Δ/);
	});

	it('a cell not scored THIS run (harness/unknown) renders Δ "—", not "🆕 new"', () => {
		// HARNESS has a null composite this run and is absent from the baseline:
		// it must read as "—" (nothing to diff), never as a new cell.
		const withHarness = buildAggregate([PASS, HARNESS], {});
		const baseline = { mean_composite: 80, cells: [{ task: 'auth-notes', template: 'demo', composite: 80 }] };
		const md = renderOverview(diffAgainstBaseline(withHarness, baseline), {}).join('\n');
		assert.match(md, /oidc-dsql \| react \| — \| — \| — \|/);
		assert.doesNotMatch(md, /oidc-dsql \| react \| — \| — \| 🆕 new \|/);
	});

	it('a baseline-only (removed) cell renders a "removed" marker with a "—" PR column', () => {
		// current has only auth-notes; the baseline additionally has a gone cell.
		const baseline = {
			mean_composite: 75,
			cells: [
				{ task: 'auth-notes', template: 'demo', composite: 80 },
				{ task: 'gone-task', template: 'demo', composite: 40 },
			],
		};
		const md = renderOverview(diffAgainstBaseline(current, baseline), {}).join('\n');
		// baseline 40.0, PR "—", Δ removed marker.
		assert.match(md, /gone-task \| demo \| 40\.0 \| — \| 🗑️ removed \|/);
	});
});
