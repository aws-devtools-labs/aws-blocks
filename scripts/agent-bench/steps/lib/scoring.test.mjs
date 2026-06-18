// Unit tests for the bench scoring single-source-of-truth (scoring.mjs).
//
// These pin the integrity-critical invariants — the composite formula, the
// verdict tiers, cell classification, and the headline-mean inclusion rule — so
// finalize-result.mjs and summary.mjs can never silently drift from the
// pre-registered scoring methodology documented in the README. Run under bare
// `node --test` (no build step): plain .mjs, same as the module under test.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	AGENT_FAIL_AT,
	AGENT_FAIL_REASON,
	buildCapDecision,
	classifyCell,
	composite,
	compositeBand,
	HARNESS_FAIL_REASONS,
	isScoredCell,
	testRate,
	testStats,
	verdict,
	verdictOf,
} from './scoring.mjs';

describe('composite(tr, j) == round(60*tr + 4*j*min(1, 4*tr), 1)', () => {
	it('tr=0 floors the judge term to 0 regardless of judge score', () => {
		// min(1, 4*0) = 0, so the entire 40% judge term is gated off.
		assert.equal(composite(0, 10), 0);
		assert.equal(composite(0, 0), 0);
	});

	it('tr=0.25 is exactly where the judge term reaches full weight', () => {
		// 4*0.25 = 1, so min(1, 4*tr) = 1: 60*0.25 + 4*10*1 = 15 + 40 = 55.
		assert.equal(composite(0.25, 10), 55);
	});

	it('judge term ramps linearly below tr=0.25 (gate < 1)', () => {
		// 4*0.1 = 0.4, min(1, 0.4) = 0.4: 60*0.1 + 4*10*0.4 = 6 + 16 = 22.
		assert.equal(composite(0.1, 10), 22);
	});

	it('tr=1, j=10 is the perfect 100', () => {
		// 60*1 + 4*10*min(1, 4) = 60 + 40 = 100.
		assert.equal(composite(1, 10), 100);
	});

	it('a mid case scores between the bands', () => {
		// 60*0.5 + 4*5*min(1, 2) = 30 + 20 = 50.
		assert.equal(composite(0.5, 5), 50);
	});

	it('a judge failure (j=0) drops only the 40% judge term, never the test-driven 60%', () => {
		// 60*0.5 + 4*0*1 = 30 — the objective portion survives.
		assert.equal(composite(0.5, 0), 30);
	});

	it('rounds to 1 decimal place', () => {
		// 60*0.1234 = 7.404 → 7.4.
		assert.equal(composite(0.1234, 0), 7.4);
	});

	it('rounding is float-robust (60*(1/3) = 19.999… → 20)', () => {
		assert.equal(composite(1 / 3, 0), 20);
	});

	it('a non-finite / missing judge reads as 0', () => {
		assert.equal(composite(0.5, Number.NaN), 30);
		assert.equal(composite(0.5, undefined), 30);
	});

	it('a non-finite / missing pass-rate reads as 0 (never serializes to null in result.json)', () => {
		assert.equal(composite(Number.NaN, 10), 0);
		assert.equal(composite(undefined, 10), 0);
	});
});

describe('verdict(tr, harnessHint)', () => {
	it("pass-rate >= 0.999 is 'pass'", () => {
		assert.equal(verdict(1, null), 'pass');
		assert.equal(verdict(0.999, null), 'pass');
	});

	it("0 < pass-rate < 0.999 is 'partial'", () => {
		assert.equal(verdict(0.9989, null), 'partial');
		assert.equal(verdict(0.5, null), 'partial');
		assert.equal(verdict(0.0001, null), 'partial');
	});

	it("pass-rate == 0 (with no hint) is 'fail'", () => {
		assert.equal(verdict(0, null), 'fail');
	});

	it("a 'harness_error' hint short-circuits whatever the rate", () => {
		assert.equal(verdict(0, 'harness_error'), 'harness_error');
		assert.equal(verdict(1, 'harness_error'), 'harness_error');
	});

	it("an 'unknown' hint (no tests ran) short-circuits whatever the rate", () => {
		assert.equal(verdict(0, 'unknown'), 'unknown');
		assert.equal(verdict(0.5, 'unknown'), 'unknown');
	});

	it('hint defaults to none when omitted', () => {
		assert.equal(verdict(0.5), 'partial');
		assert.equal(verdict(0), 'fail');
	});
});

describe('classifyCell(result)', () => {
	it("pre-OIDC failure → harness_error (excluded), reason 'preflight_failed'", () => {
		assert.deepEqual(classifyCell({ failed_at: 'pre-oidc' }), {
			klass: 'harness_error',
			reason: 'preflight_failed',
		});
	});

	it("OIDC failure → harness_error (excluded), reason 'oidc_failed'", () => {
		assert.deepEqual(classifyCell({ failed_at: '0-oidc' }), {
			klass: 'harness_error',
			reason: 'oidc_failed',
		});
	});

	it("scaffold (1-init) failure → harness_error (excluded), reason 'init_abort'", () => {
		assert.deepEqual(classifyCell({ failed_at: '1-init' }), {
			klass: 'harness_error',
			reason: 'init_abort',
		});
	});

	it('a CANCELLATION at the agent step → harness_error (cancel is an infra abort wherever it lands), not agent_fail', () => {
		assert.deepEqual(classifyCell({ failed_at: AGENT_FAIL_AT, status: 'cancelled' }), {
			klass: 'harness_error',
			reason: 'cancelled',
		});
	});

	it('a cancellation at any other step is also harness_error', () => {
		assert.equal(classifyCell({ failed_at: '1-init', status: 'cancelled' }).klass, 'harness_error');
		assert.equal(classifyCell({ failed_at: '3-build-test', status: 'cancelled' }).klass, 'harness_error');
	});

	it("an agent (2-agent) failure that is NOT a cancellation → agent_fail (INCLUDED), reason 'agent_timeout'", () => {
		assert.deepEqual(classifyCell({ failed_at: AGENT_FAIL_AT, status: 'error' }), {
			klass: 'agent_fail',
			reason: AGENT_FAIL_REASON,
		});
	});

	it('reaching build/test/judge → scored (a real signal, even a failure there)', () => {
		assert.deepEqual(classifyCell({ failed_at: '3-build-test', status: 'error' }), {
			klass: 'scored',
			reason: null,
		});
		assert.deepEqual(classifyCell({ failed_at: '4-judge', status: 'error' }), {
			klass: 'scored',
			reason: null,
		});
	});

	it('all-green (no failed_at) → scored', () => {
		assert.deepEqual(classifyCell({ failed_at: null, status: 'scored' }), {
			klass: 'scored',
			reason: null,
		});
		assert.deepEqual(classifyCell({}), { klass: 'scored', reason: null });
	});

	it('the harness-fail reason map is the canonical set of excluded pre-grade steps', () => {
		assert.deepEqual(HARNESS_FAIL_REASONS, {
			'pre-oidc': 'preflight_failed',
			'0-oidc': 'oidc_failed',
			'1-init': 'init_abort',
		});
	});
});

describe('isScoredCell(result) — the single inclusion rule for the headline mean', () => {
	it('an agent_fail IS included (the agent is exactly what is under test)', () => {
		assert.equal(isScoredCell({ failed_at: AGENT_FAIL_AT, status: 'error' }), true);
		assert.equal(isScoredCell({ klass: 'agent_fail' }), true);
	});

	it('a harness_error is always EXCLUDED (a flaky runner cannot move the score)', () => {
		assert.equal(isScoredCell({ failed_at: 'pre-oidc' }), false);
		assert.equal(isScoredCell({ failed_at: '0-oidc' }), false);
		assert.equal(isScoredCell({ klass: 'harness_error' }), false);
		assert.equal(isScoredCell({ status: 'cancelled', failed_at: AGENT_FAIL_AT }), false);
	});

	it('a gradeable cell that ran tests (denom>0) IS included', () => {
		assert.equal(isScoredCell({ tests_passed: 3, tests_failed: 1 }), true);
		assert.equal(isScoredCell({ tests_passed: 0, tests_failed: 2 }), true);
	});

	it('a gradeable cell that ran NO tests (denom==0, the "unknown" bucket) is EXCLUDED', () => {
		assert.equal(isScoredCell({ tests_passed: 0, tests_failed: 0 }), false);
		assert.equal(isScoredCell({}), false);
	});

	it('a stamped klass is honoured over on-the-fly classification', () => {
		// No tests, but stamped agent_fail → still counted.
		assert.equal(isScoredCell({ klass: 'agent_fail', tests_passed: 0, tests_failed: 0 }), true);
	});
});

describe('compositeBand(c) thresholds', () => {
	it('>= 80 is green', () => {
		assert.equal(compositeBand(80), '🟢');
		assert.equal(compositeBand(100), '🟢');
	});

	it('>= 50 and < 80 is yellow', () => {
		assert.equal(compositeBand(50), '🟡');
		assert.equal(compositeBand(79.9), '🟡');
	});

	it('< 50 is red', () => {
		assert.equal(compositeBand(49.9), '🔴');
		assert.equal(compositeBand(0), '🔴');
	});
});

describe('testStats / testRate', () => {
	it('counts passed/failed and the denominator', () => {
		assert.deepEqual(testStats({ tests_passed: 3, tests_failed: 1 }), {
			passed: 3,
			failed: 1,
			denom: 4,
		});
	});

	it('missing / non-numeric fields read as 0', () => {
		assert.deepEqual(testStats({}), { passed: 0, failed: 0, denom: 0 });
		assert.deepEqual(testStats({ tests_passed: 'x', tests_failed: null }), {
			passed: 0,
			failed: 0,
			denom: 0,
		});
	});

	it('pass-rate is passed/denom, and 0 when no tests ran', () => {
		assert.equal(testRate({ passed: 3, denom: 4 }), 0.75);
		assert.equal(testRate({ passed: 0, denom: 0 }), 0);
	});
});

describe('verdictOf(result) — derives the hint from the cell then defers to verdict()', () => {
	it("an agent_fail is a real 'fail' (must NOT read as 'unknown' and get excluded)", () => {
		assert.equal(verdictOf({ failed_at: AGENT_FAIL_AT, status: 'error' }), 'fail');
		assert.equal(verdictOf({ klass: 'agent_fail' }), 'fail');
	});

	it("a harness_error verdict is 'harness_error'", () => {
		assert.equal(verdictOf({ failed_at: '0-oidc' }), 'harness_error');
		assert.equal(verdictOf({ klass: 'harness_error' }), 'harness_error');
	});

	it('a scored cell defers to its pass-rate', () => {
		assert.equal(verdictOf({ tests_passed: 4, tests_failed: 0 }), 'pass');
		assert.equal(verdictOf({ tests_passed: 3, tests_failed: 1 }), 'partial');
		assert.equal(verdictOf({ tests_passed: 0, tests_failed: 2 }), 'fail');
	});

	it("a scored cell that ran no tests is 'unknown' (denominator 0)", () => {
		assert.equal(verdictOf({ tests_passed: 0, tests_failed: 0 }), 'unknown');
	});
});

describe('agent_fail end-to-end invariant: verdict fail, composite 0, INCLUDED', () => {
	it('an agent timeout scores composite 0, verdicts fail, and counts toward the mean', () => {
		const cell = { failed_at: AGENT_FAIL_AT, status: 'error' };
		const tr = testRate(testStats(cell)); // no tests ran → 0
		assert.equal(tr, 0);
		assert.equal(composite(tr, 10), 0); // even a generous judge cannot lift it off 0
		assert.equal(verdictOf(cell), 'fail');
		assert.equal(isScoredCell(cell), true);
	});
});

describe('buildCapDecision(ev) — the build-cap is for REAL build failures only', () => {
	it("build_status='na' (no `build` script in the template) does NOT cap, and notes it", () => {
		// The observability-api/backend case: a template with no `build` script
		// must NOT be capped just because `npm run build` printed "Missing script".
		const d = buildCapDecision({ build_status: 'na', build_succeeded: 'true' });
		assert.equal(d.status, 'na');
		assert.equal(d.cap, false);
		assert.match(d.note, /N\/A/);
	});

	it("build_status='ok' (script present, exited 0) does NOT cap, no note", () => {
		const d = buildCapDecision({ build_status: 'ok', build_succeeded: 'true' });
		assert.equal(d.status, 'ok');
		assert.equal(d.cap, false);
		assert.equal(d.note, null);
	});

	it("build_status='failed' (script present, exited non-zero) DOES cap", () => {
		// The file-gallery/bare case: its `tsc` build legitimately fails on the
		// agent's type errors — that penalty must be preserved.
		const d = buildCapDecision({ build_status: 'failed', build_succeeded: 'false' });
		assert.equal(d.status, 'failed');
		assert.equal(d.cap, true);
		assert.equal(d.note, null);
	});

	it('observability-api shape (na) is NOT capped while file-gallery shape (failed) IS', () => {
		assert.equal(buildCapDecision({ build_status: 'na', build_succeeded: 'true' }).cap, false);
		assert.equal(buildCapDecision({ build_status: 'failed', build_succeeded: 'false' }).cap, true);
	});

	it('legacy evidence without build_status falls back to build_succeeded', () => {
		// truthy build_succeeded (bool or the GITHUB_OUTPUT string) → ok, no cap.
		assert.deepEqual(buildCapDecision({ build_succeeded: true }), { status: 'ok', cap: false, note: null });
		assert.deepEqual(buildCapDecision({ build_succeeded: 'true' }), { status: 'ok', cap: false, note: null });
		// non-truthy → treated as a real failure (the original pre-tri-state cap).
		assert.equal(buildCapDecision({ build_succeeded: 'false' }).status, 'failed');
		assert.equal(buildCapDecision({ build_succeeded: 'false' }).cap, true);
		assert.equal(buildCapDecision({ build_succeeded: false }).cap, true);
		assert.equal(buildCapDecision({}).cap, true); // nothing known → pessimistic cap
	});

	it('an unrecognised build_status string is treated as legacy (falls back to build_succeeded)', () => {
		// Defensive: a typo'd status doesn't silently disable the cap; it defers to
		// build_succeeded, so a real failure still caps.
		assert.equal(buildCapDecision({ build_status: 'weird', build_succeeded: 'false' }).cap, true);
		assert.equal(buildCapDecision({ build_status: 'weird', build_succeeded: 'true' }).cap, false);
	});
});
