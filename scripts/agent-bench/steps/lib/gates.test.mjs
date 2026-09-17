// Unit tests for the merge gate (gates.mjs): the three opt-in gates (floor / regression / harness),
// each parsed from env, plus the skip/disable branches. Run under bare `node --test`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateGates, parseThreshold } from './gates.mjs';

const gate = (res, name) => res.gates.find((g) => g.name === name);

// A run that scored 3 cells at mean 70, up +4 vs a main baseline, no infra failures. Mirrors the
// object shape summary.mjs constructs (totalCells + benchJobFailed always populated).
const OK_RUN = { meanComposite: 70, scoredCells: 3, meanDelta: 4, hasBaseline: true, harnessErrors: 0, totalCells: 3, benchJobFailed: false };

describe('parseThreshold(raw)', () => {
	it('blank / undefined / non-numeric is disabled', () => {
		assert.deepEqual(parseThreshold(''), { enabled: false, value: NaN });
		assert.deepEqual(parseThreshold(undefined), { enabled: false, value: NaN });
		assert.deepEqual(parseThreshold('  '), { enabled: false, value: NaN });
		assert.deepEqual(parseThreshold('abc'), { enabled: false, value: NaN });
	});
	it('a finite non-negative number is enabled (including 0)', () => {
		assert.deepEqual(parseThreshold('50'), { enabled: true, value: 50 });
		assert.deepEqual(parseThreshold('0'), { enabled: true, value: 0 });
		assert.deepEqual(parseThreshold(' 3.5 '), { enabled: true, value: 3.5 });
	});
	it('a NEGATIVE number is disabled (a negative count/floor would invert the gate)', () => {
		assert.deepEqual(parseThreshold('-1'), { enabled: false, value: NaN });
		assert.deepEqual(parseThreshold('-0.5'), { enabled: false, value: NaN });
	});
	it('with {integer:true} a FRACTIONAL value is disabled; an integer is accepted', () => {
		assert.deepEqual(parseThreshold('1.5', { integer: true }), { enabled: false, value: NaN });
		assert.deepEqual(parseThreshold('2', { integer: true }), { enabled: true, value: 2 });
		assert.deepEqual(parseThreshold('0', { integer: true }), { enabled: true, value: 0 });
	});
	it('without the flag (floor/regression) a fraction is still accepted', () => {
		assert.deepEqual(parseThreshold('72.5'), { enabled: true, value: 72.5 });
	});
});

describe('evaluateGates — nothing configured', () => {
	it('all gates disabled => never fails (observational, today\'s behaviour)', () => {
		const res = evaluateGates(OK_RUN, {});
		assert.equal(res.failed, false);
		for (const g of res.gates) assert.equal(g.enabled, false);
	});
});

describe('FLOOR gate (BENCH_MIN_SCORE)', () => {
	it('passes when mean >= floor', () => {
		const res = evaluateGates(OK_RUN, { minScore: '60' });
		assert.equal(gate(res, 'floor').failed, false);
		assert.equal(res.failed, false);
	});
	it('fails when mean < floor', () => {
		const res = evaluateGates(OK_RUN, { minScore: '80' });
		assert.equal(gate(res, 'floor').failed, true);
		assert.equal(res.failed, true);
	});
	it('is SKIPPED (never fails) when no cell was scored', () => {
		const run = { meanComposite: null, scoredCells: 0, meanDelta: null, hasBaseline: false, harnessErrors: 0 };
		const res = evaluateGates(run, { minScore: '80' });
		assert.equal(gate(res, 'floor').skipped, true);
		assert.equal(gate(res, 'floor').failed, false);
		assert.equal(res.failed, false);
	});
	it('surfaces the parsed threshold as `value` (for the headline to read, not re-parse)', () => {
		assert.equal(gate(evaluateGates(OK_RUN, { minScore: '60' }), 'floor').value, 60);
		assert.equal(gate(evaluateGates(OK_RUN, {}), 'floor').value, null); // disabled => null
		assert.equal(gate(evaluateGates(OK_RUN, { minScore: '-1' }), 'floor').value, null); // negative => disabled
	});
});

describe('REGRESSION gate (BENCH_MAX_REGRESSION)', () => {
	it('passes when the drop is within the limit', () => {
		const run = { ...OK_RUN, meanDelta: -3 };
		const res = evaluateGates(run, { maxRegression: '5' });
		assert.equal(gate(res, 'regression').failed, false);
	});
	it('passes when the mean improved', () => {
		const res = evaluateGates({ ...OK_RUN, meanDelta: 7 }, { maxRegression: '5' });
		assert.equal(gate(res, 'regression').failed, false);
	});
	it('fails when the drop exceeds the limit', () => {
		const run = { ...OK_RUN, meanDelta: -6 };
		const res = evaluateGates(run, { maxRegression: '5' });
		assert.equal(gate(res, 'regression').failed, true);
		assert.equal(res.failed, true);
	});
	it('a 0-pt limit means any drop fails, exact-flat passes', () => {
		assert.equal(gate(evaluateGates({ ...OK_RUN, meanDelta: -0.1 }, { maxRegression: '0' }), 'regression').failed, true);
		assert.equal(gate(evaluateGates({ ...OK_RUN, meanDelta: 0 }, { maxRegression: '0' }), 'regression').failed, false);
	});
	it('is SKIPPED (never fails) with no main baseline', () => {
		const run = { ...OK_RUN, hasBaseline: false, meanDelta: null };
		const res = evaluateGates(run, { maxRegression: '5' });
		assert.equal(gate(res, 'regression').skipped, true);
		assert.equal(gate(res, 'regression').failed, false);
	});
});

describe('HARNESS gate (BENCH_MAX_HARNESS_ERRORS)', () => {
	it('passes when infra failures are within the limit', () => {
		const res = evaluateGates({ ...OK_RUN, harnessErrors: 1 }, { maxHarnessErrors: '1' });
		assert.equal(gate(res, 'harness').failed, false);
	});
	it('fails when infra failures exceed the limit', () => {
		const res = evaluateGates({ ...OK_RUN, harnessErrors: 2 }, { maxHarnessErrors: '1' });
		assert.equal(gate(res, 'harness').failed, true);
		assert.equal(res.failed, true);
	});
	it('fires even when NOTHING scored (all cells were infra failures)', () => {
		const run = { meanComposite: null, scoredCells: 0, meanDelta: null, hasBaseline: false, harnessErrors: 10, totalCells: 10, benchJobFailed: false };
		const res = evaluateGates(run, { maxHarnessErrors: '0' });
		assert.equal(gate(res, 'harness').failed, true);
		assert.equal(res.failed, true);
	});
	it('a FRACTIONAL threshold disables the per-cell harness gate (a count must be whole)', () => {
		const res = evaluateGates({ ...OK_RUN, harnessErrors: 3 }, { maxHarnessErrors: '1.5' });
		// 1.5 is rejected → the per-cell gate is not enabled → 3 infra errors do not fail it here.
		assert.equal(gate(res, 'harness').failed, false);
		assert.equal(res.failed, false);
	});
});

describe('HARNESS whole-run gate (upstream/build failure, no env needed)', () => {
	const emptyRun = { meanComposite: null, scoredCells: 0, meanDelta: null, hasBaseline: false, harnessErrors: 0, totalCells: 0 };
	it('fails when the bench matrix did not succeed AND produced zero cells — even with no env set', () => {
		const res = evaluateGates({ ...emptyRun, benchJobFailed: true }, {});
		const h = gate(res, 'harness');
		assert.equal(h.enabled, true);
		assert.equal(h.failed, true);
		assert.equal(res.failed, true);
	});
	it('fires for an upstream build-blocks failure that skipped bench (benchJobFailed derived from the build result), zero cells', () => {
		// summary.mjs sets benchJobFailed=true when build-blocks failed even though bench itself was
		// skipped; at the gate level that is benchJobFailed:true + totalCells:0 → block.
		const res = evaluateGates({ ...emptyRun, benchJobFailed: true }, {});
		assert.equal(gate(res, 'harness').failed, true);
		assert.equal(res.failed, true);
	});
	it('does NOT fire when bench succeeded with zero cells (e.g. path-filtered skip)', () => {
		const res = evaluateGates({ ...emptyRun, benchJobFailed: false }, {});
		assert.equal(gate(res, 'harness').enabled, false);
		assert.equal(res.failed, false);
	});
	it('does NOT fire when bench failed but SOME cells came through (per-cell gate handles those)', () => {
		const run = { ...OK_RUN, totalCells: 3, benchJobFailed: true };
		const res = evaluateGates(run, {});
		assert.equal(gate(res, 'harness').failed, false);
	});
});

describe('gates are independent', () => {
	it('a failing regression gate fails the run even if the floor passes', () => {
		const run = { ...OK_RUN, meanComposite: 90, meanDelta: -20 };
		const res = evaluateGates(run, { minScore: '60', maxRegression: '5' });
		assert.equal(gate(res, 'floor').failed, false);
		assert.equal(gate(res, 'regression').failed, true);
		assert.equal(res.failed, true);
	});
});
