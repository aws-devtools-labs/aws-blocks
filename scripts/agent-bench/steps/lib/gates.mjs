// The merge gate: turns the run's headline numbers into a pass/fail verdict + human reasons. PURE (no
// fs/env/process) so `node --test` can pin every branch; summary.mjs reads env + calls this. Three
// independent, opt-in gates — each fires ONLY when its threshold env var is set, so an unconfigured
// repo stays observational (exactly today's behaviour):
//
//   1. FLOOR      (BENCH_MIN_SCORE)          — mean composite must be >= the floor.
//   2. REGRESSION (BENCH_MAX_REGRESSION)     — mean composite must not drop more than N points vs the
//                                              `main` baseline. No baseline => not evaluated (never a
//                                              spurious fail on the first run).
//   3. HARNESS    (BENCH_MAX_HARNESS_ERRORS) — at most N cells may be harness_error (infra failures
//                                              that never scored). This is the "a broken suite must
//                                              red the PR" gate, kept DISTINCT from a low agent score:
//                                              a low score is the signal (gate 1/2), an infra failure
//                                              is a broken measurement (gate 3).
//
// A gate whose env var is unset/blank/non-numeric is `enabled:false` and cannot fail — never a
// fail-by-typo. FLOOR/REGRESSION over the composite mean are conservatively SKIPPED when the run
// produced no scored cell (nothing to average); HARNESS still applies, since "every cell was infra"
// is itself the failure that gate exists to catch.

/**
 * Parse a numeric threshold from a raw env string. Blank/undefined/non-finite => disabled. A NEGATIVE
 * value is also disabled: every threshold here is a floor, a points-drop limit, or a count, none of
 * which is sensible below 0 — and a negative count would INVERT the harness gate (harnessErrors 0 > -1
 * → a clean run fails). So a fat-fingered `-1` disables the gate rather than silently inverting it.
 * When `integer` is true (the harness COUNT gate) a fractional value is also disabled — a count of
 * `1.5` is nonsensical; floor/regression leave it false because they legitimately take fractions.
 * @param {string|undefined|null} raw
 * @param {{integer?: boolean}} [opts]
 * @returns {{enabled: boolean, value: number}}
 */
export function parseThreshold(raw, opts = {}) {
	const s = (raw ?? '').trim();
	if (s === '') return { enabled: false, value: NaN };
	const n = Number(s);
	const ok = Number.isFinite(n) && n >= 0 && (!opts.integer || Number.isInteger(n));
	return ok ? { enabled: true, value: n } : { enabled: false, value: NaN };
}

/**
 * Evaluate all three gates.
 * @param {{
 *   meanComposite: number|null,   // headline mean over scored cells (null => none scored)
 *   scoredCells: number,          // count of cells in the mean
 *   meanDelta: number|null,       // composite mean delta vs main baseline (null => no baseline)
 *   hasBaseline: boolean,         // a main baseline was found
 *   harnessErrors: number,        // count of harness_error (infra) cells this run
 *   totalCells: number,           // count of result.json artifacts received (any klass)
 *   benchJobFailed: boolean,      // the upstream `bench` matrix job did NOT succeed (failure/cancelled)
 * }} run
 * @param {{
 *   minScore?: string, maxRegression?: string, maxHarnessErrors?: string,
 * }} envs raw env strings (parsed here)
 * @returns {{failed: boolean, gates: {name: string, enabled: boolean, failed: boolean, skipped: boolean, reason: string}[]}}
 */
export function evaluateGates(run, envs = {}) {
	const gates = [];

	// 1. FLOOR — mean composite >= min.
	const floor = parseThreshold(envs.minScore);
	{
		// `value` is surfaced so the caller (summary.mjs headline) reads the parsed threshold from
		// here instead of re-parsing BENCH_MIN_SCORE — one source of truth for enabled/threshold.
		const g = { name: 'floor', enabled: floor.enabled, value: floor.enabled ? floor.value : null, failed: false, skipped: false, reason: '' };
		if (floor.enabled) {
			if (run.meanComposite === null || run.scoredCells === 0) {
				g.skipped = true;
				g.reason = `BENCH_MIN_SCORE=${floor.value} set, but no cell was scored — floor skipped (conservative).`;
			} else if (run.meanComposite < floor.value) {
				g.failed = true;
				g.reason = `mean composite ${run.meanComposite.toFixed(1)} is below the floor ${floor.value}.`;
			} else {
				g.reason = `mean composite ${run.meanComposite.toFixed(1)} >= floor ${floor.value}.`;
			}
		}
		gates.push(g);
	}

	// 2. REGRESSION — mean composite must not drop more than N points vs main. A DROP is a negative
	// delta; the gate fires when delta < -threshold. A positive threshold means "tolerate up to N
	// points of drop"; 0 means "no drop at all".
	const regr = parseThreshold(envs.maxRegression);
	{
		const g = { name: 'regression', enabled: regr.enabled, failed: false, skipped: false, reason: '' };
		if (regr.enabled) {
			if (!run.hasBaseline || run.meanDelta === null) {
				g.skipped = true;
				g.reason = `BENCH_MAX_REGRESSION=${regr.value} set, but no main baseline to diff — regression gate skipped.`;
			} else if (run.meanDelta < -Math.abs(regr.value)) {
				g.failed = true;
				g.reason = `mean composite dropped ${Math.abs(run.meanDelta).toFixed(1)} pts vs main (limit ${Math.abs(regr.value)}).`;
			} else {
				const dir = run.meanDelta >= 0 ? `+${run.meanDelta.toFixed(1)}` : run.meanDelta.toFixed(1);
				g.reason = `mean composite delta ${dir} pts vs main is within the ${Math.abs(regr.value)}-pt limit.`;
			}
		}
		gates.push(g);
	}

	// 3. HARNESS — infra failures red the check. Two shapes:
	//   (a) WHOLE-RUN (always on, no env needed): the upstream `bench` matrix did not succeed AND
	//       produced zero result.json artifacts — e.g. build-blocks failed so every cell was skipped.
	//       This is the premise defect ("a failed build still reports green"): nothing scored, nothing
	//       classed harness_error, so the per-cell gate below can't see it. Fire unconditionally.
	//   (b) PER-CELL (opt-in via BENCH_MAX_HARNESS_ERRORS): at most N cells may be harness_error.
	//       Never skipped — "all cells were infra failures" is the case this gate is FOR.
	const harn = parseThreshold(envs.maxHarnessErrors, { integer: true });
	{
		const g = { name: 'harness', enabled: true, failed: false, skipped: false, reason: '' };
		if (run.benchJobFailed && (run.totalCells ?? 0) === 0) {
			// Whole-run failure — always blocks, regardless of the per-cell threshold.
			g.failed = true;
			g.reason = 'the bench matrix did not succeed and produced zero result artifacts (upstream/build failure) — nothing was measured.';
		} else if (harn.enabled) {
			if (run.harnessErrors > harn.value) {
				g.failed = true;
				g.reason = `${run.harnessErrors} harness_error cell(s) — infra failures exceed the allowed ${harn.value}.`;
			} else {
				g.reason = `${run.harnessErrors} harness_error cell(s) within the allowed ${harn.value}.`;
			}
		} else {
			// No per-cell threshold set and the run produced artifacts — nothing to assert here.
			g.enabled = false;
		}
		gates.push(g);
	}

	return { failed: gates.some((g) => g.failed), gates };
}
