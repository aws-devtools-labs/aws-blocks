// Single source of truth for bench scoring: cell classification (`klass`), the
// test pass-rate, the verdict tiers, the composite formula + its band, and the
// inclusion/exclusion rule for the headline mean.
//
// Imported by BOTH:
//   - steps/finalize-result.mjs — stamps klass/test_rate/verdict/composite onto
//     each cell's result.json so the uploaded artifact is self-describing.
//   - steps/summary.mjs — recomputes the table + headline from these same
//     formulas.
//
// Keeping these pure functions in one module is what prevents the two scripts
// from drifting apart on what counts, how it is scored, and what is excluded.
// Plain .mjs (no TS): summary.mjs/finalize-result.mjs run under bare `node` in
// CI, which can't import a .ts module without a loader.

// The judge rubric's shared (task-independent) dimensions, scored 0-10 and
// averaged equally. This lives HERE (plain .mjs) rather than in prompts.ts so
// the bare `node --test` scoring suite can pin it without a TS loader; prompts.ts
// imports + re-exports it, keeping ONE source of truth for the dimension set.
export const COMMON_DIMENSIONS = [
	'functional_completeness',
	'selector_contract',
	'persistence',
	'code_quality',
	'blocks_fidelity',
];

// Steps whose failure means the cell never produced a gradeable artifact AND
// the fault is the harness's, not the agent's. Such cells are classed
// `harness_error` and EXCLUDED from the headline mean — a flaky runner can't
// move the score. The map also gives each a short, stable reason for the
// summary's excluded section.
export const HARNESS_FAIL_REASONS = {
	'pre-oidc': 'preflight_failed',
	'0-oidc': 'oidc_failed',
	'1-init': 'init_abort',
};

// The agent step (2-agent) failing is NOT a harness flake — it's the thing
// under test failing: the agent timed out, or never produced an app within its
// budget. Such a cell is a GENUINE failure (verdict 'fail', composite 0) and IS
// counted in the headline mean, even though it ran no tests. (A CI
// *cancellation* at this step is still an infra abort — see classifyCell.)
export const AGENT_FAIL_AT = '2-agent';
export const AGENT_FAIL_REASON = 'agent_timeout';

// A 2-agent death that tore down the harness itself (see isUngracefulStepTwoDeath)
// is NOT a gradeable agent failure — it's infra — so it is reclassified as a
// harness_error and EXCLUDED from the mean under this reason. Distinct reason
// (vs the generic HARNESS_FAIL_REASONS steps) so the excluded section can name it.
export const AGENT_HARNESS_TEARDOWN_REASON = 'agent_harness_teardown';

// The NON-terminal stop_reason 2-agent-run.ts stamps on its running checkpoint
// (see lib/partial-envelope.mjs). It is deliberately NOT one of the terminal
// stop_reasons ('wall_clock_timeout' / 'cancelled' / 'error' / a real
// result.stopReason): a checkpoint that survives to finalize means NO terminal
// exit path ever overwrote it, i.e. the process died ungracefully. Single-sourced
// here because BOTH the harness (which writes it) and classifyCell (which reads
// it) must agree on the exact sentinel.
export const CHECKPOINT_STOP_REASON = 'in_progress';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Did 2-agent-run.ts reach one of its own terminal exit paths (the SIGTERM/SIGINT
 * partial-envelope flush, the invoke-exhausted sentinel, or a normal finish)
 * before the process ended? Those paths each stamp a real, TERMINAL `stop_reason`
 * onto the envelope; the step-0 baseline leaves it '' and the running checkpoint
 * leaves the non-terminal {@link CHECKPOINT_STOP_REASON} + `checkpoint:true`. So a
 * graceful exit is: NOT a surviving checkpoint AND a non-empty, non-checkpoint
 * stop_reason. This is the marker that separates a genuine agent timeout (which
 * flushed) from an ungraceful harness teardown (which did not).
 * @param {{stop_reason?: unknown, checkpoint?: unknown}} result
 * @returns {boolean}
 */
function reachedGracefulExit(result) {
	// A surviving running-checkpoint is definitionally non-terminal: it is only
	// ever overwritten by a terminal exit path, so if it's still here, none ran.
	if (result?.checkpoint === true) return false;
	const sr = result?.stop_reason;
	return typeof sr === 'string' && sr !== '' && sr !== CHECKPOINT_STOP_REASON;
}

/**
 * Detect the harness-integrity signature: a 2-agent death whose vended `bash`
 * process-group/pkill storm tore down the parent harness (npx tsx) itself,
 * producing an ungraceful exit (e.g. 143/137) that BYPASSED 2-agent-run's SIGTERM
 * partial-envelope flush — so result.json carries the step-0 baseline (stop_reason
 * '', tokens 0) or, thanks to the incremental checkpoint, a non-terminal
 * `checkpoint:true` envelope (nonzero tokens, stop_reason {@link CHECKPOINT_STOP_REASON}).
 * Either way NO terminal exit path ran. Such a self-inflicted infra kill is a
 * harness_error (EXCLUDED from the mean), NOT an `agent_fail`: it must neither
 * drag the headline nor mask spend.
 *
 * The boundary is deliberately explicit: a GENUINE agent timeout reaches the
 * SIGTERM flush and stamps a terminal stop_reason ('wall_clock_timeout' /
 * 'cancelled'), and a real invoke-exhaustion stamps 'error' — both satisfy
 * reachedGracefulExit and therefore stay `agent_fail` (INCLUDED). A cancellation
 * is already handled upstream in classifyCell (harness_error), so it is excluded
 * here to keep this predicate about UNGRACEFUL deaths only.
 * @param {{failed_at?: string|null, status?: string, stop_reason?: unknown, checkpoint?: unknown}} result
 * @returns {boolean}
 */
export function isUngracefulStepTwoDeath(result) {
	if ((result?.failed_at ?? null) !== AGENT_FAIL_AT) return false;
	if (result?.status === 'cancelled') return false;
	return !reachedGracefulExit(result);
}

/**
 * Classify a finalized cell into one of three classes:
 *   - `harness_error` — a pre-grade step (pre-OIDC, OIDC, scaffold) failed, or
 *     the run was CANCELLED: the cell never produced a gradeable artifact, so
 *     it is EXCLUDED from the headline mean (a flaky runner can't move the score).
 *   - `agent_fail` — the agent step (2-agent) failed on its own merits (timeout
 *     / produced no app in budget) AND reached a graceful terminal exit. A REAL
 *     failure: verdict 'fail', composite 0, and INCLUDED in the mean even though
 *     no tests ran. An UNGRACEFUL 2-agent death that tore down the harness
 *     (isUngracefulStepTwoDeath) is instead reclassified `harness_error`.
 *   - `scored` — reached build/test/judge; its outcome is a real signal (even a 0).
 * Reads `result.failed_at` / `result.status` (stamped by finalize-result) plus
 * `result.stop_reason` / `result.checkpoint` (from 2-agent-run's envelope) to tell
 * a graceful agent timeout from an ungraceful harness teardown.
 * @param {{failed_at?: string|null, status?: string, stop_reason?: unknown, checkpoint?: unknown}} result
 * @returns {{klass: 'scored'|'harness_error'|'agent_fail', reason: string|null}}
 */
export function classifyCell(result) {
	const failedAt = result?.failed_at ?? null;
	// A cancellation is an infra abort wherever it lands (including mid-agent) —
	// never a gradeable signal, so it is a harness_error, not an agent failure.
	if (result?.status === 'cancelled') {
		return { klass: 'harness_error', reason: 'cancelled' };
	}
	if (failedAt && Object.prototype.hasOwnProperty.call(HARNESS_FAIL_REASONS, failedAt)) {
		return { klass: 'harness_error', reason: HARNESS_FAIL_REASONS[failedAt] };
	}
	// The agent failing to produce a gradeable app is a real fail, not a flake —
	// EXCEPT when the death was an ungraceful harness teardown (the agent's bash
	// process-group/pkill storm killed the parent harness, bypassing the SIGTERM
	// flush). That leaves no terminal envelope (baseline zeros, or a surviving
	// non-terminal checkpoint), which isUngracefulStepTwoDeath detects → reclassify
	// as harness_error (EXCLUDED) so a self-inflicted infra kill can't drag the
	// mean or mask spend. A GENUINE timeout DID flush a terminal stop_reason and
	// stays agent_fail (composite 0, INCLUDED) — the boundary is exactly whether a
	// terminal exit path ran (reachedGracefulExit), not the raw exit code (which
	// GHA's step context does not even expose).
	if (failedAt === AGENT_FAIL_AT) {
		if (isUngracefulStepTwoDeath(result)) {
			return { klass: 'harness_error', reason: AGENT_HARNESS_TEARDOWN_REASON };
		}
		return { klass: 'agent_fail', reason: AGENT_FAIL_REASON };
	}
	return { klass: 'scored', reason: null };
}

/**
 * Test counts for a cell. Missing / non-numeric fields read as 0.
 *
 * DENOMINATOR = passed + failed (NOT the audit-only `tests_total`). `tests_total`
 * (passed + failed + skipped) is recorded on result.json for auditing only and
 * is deliberately NOT the scoring divisor: skipped/interrupted tests never ran,
 * so counting them would dilute the rate with cases that produced no signal. A
 * per-test TIMEOUT is not "skipped" — Playwright records it as an unexpected
 * failure, so it already lands in `failed` and IS penalized here. Net effect:
 * the rate rewards passes and penalizes real failures/timeouts, while genuinely
 * un-run (skipped/interrupted) tests are excluded rather than counted as losses.
 * @param {{tests_passed?: number, tests_failed?: number}} result
 * @returns {{passed: number, failed: number, denom: number}}
 */
export function testStats(result) {
	const passed = num(result?.tests_passed);
	const failed = num(result?.tests_failed);
	return { passed, failed, denom: passed + failed };
}

/**
 * Pass-rate in [0,1]; 0 when no tests ran (denom 0). Takes a stats object
 * (from {@link testStats}) so the divisor is computed in exactly one place.
 * @param {{passed: number, denom: number}} stats
 * @returns {number}
 */
export function testRate(stats) {
	return stats && stats.denom > 0 ? stats.passed / stats.denom : 0;
}

/**
 * Verdict tier from a pass-rate, with a hint for the two non-rate states.
 * `harnessHint` of 'harness_error' (never gradeable) or 'unknown' (no tests
 * ran) short-circuits; otherwise the rate alone decides pass/partial/fail. The
 * judge plays NO part in the verdict — tests are the source of truth.
 * @param {number} tr pass-rate in [0,1]
 * @param {('harness_error'|'unknown'|null)} [harnessHint]
 * @returns {'pass'|'partial'|'fail'|'harness_error'|'unknown'}
 */
export function verdict(tr, harnessHint) {
	if (harnessHint === 'harness_error') return 'harness_error';
	if (harnessHint === 'unknown') return 'unknown';
	// `>= 0.999` (not `=== 1`) is a floating-point guard: a full pass computed as
	// e.g. 7/7 can land a hair under 1.0, and this keeps it a 'pass'. It is a
	// float-equality guard, NOT intentional leniency — no real partial pass-rate
	// on a small-N suite reaches 0.999 (the nearest, 1 failure in a large suite,
	// is far below it).
	if (tr >= 0.999) return 'pass';
	if (tr > 0) return 'partial';
	return 'fail';
}

/**
 * Verdict for a whole cell: derives the hint (harness_error / unknown) from the
 * cell, then defers to {@link verdict}. Uses a stamped `klass` when present,
 * else classifies on the fly — so finalize-result and summary always agree.
 * @param {object} result
 * @returns {'pass'|'partial'|'fail'|'harness_error'|'unknown'}
 */
export function verdictOf(result) {
	const klass = result?.klass ?? classifyCell(result).klass;
	if (klass === 'harness_error') return verdict(0, 'harness_error');
	// An agent failure is a real 'fail' even though it ran no tests — it must NOT
	// read as 'unknown' (the denom-0 path below), which would exclude it.
	if (klass === 'agent_fail') return 'fail';
	const stats = testStats(result);
	if (stats.denom === 0) return verdict(0, 'unknown');
	return verdict(testRate(stats), null);
}

/**
 * Composite score 0..100: 60% objective pass-rate + 40% judge, with the judge
 * term gated by min(1, 4*tr) so a 0-test cell floors to 0 and a judge failure
 * (j=0) only drops the judge term, never the test-driven portion.
 *   composite = round(60*tr + 4*j*min(1, 4*tr), 1)
 * @param {number} tr pass-rate in [0,1]
 * @param {number} j judge overall in [0,10] (0 if the judge errored)
 * @returns {number} rounded to 1 decimal
 */
export function composite(tr, j) {
	const rate = num(tr);
	const judge = num(j);
	// The min(1, 4*rate) gate ramps the judge term from 0 (at rate 0) to its
	// FULL weight at rate 0.25, and holds full above that. Rationale: a 25%
	// pass-rate is the minimum objective evidence that the agent produced
	// genuinely runnable code, so below it the qualitative (judge) score is
	// discounted proportionally — a polished-looking app that almost nothing
	// passes can't ride the judge to a high composite — and at/above 25% the
	// judge counts in full. At rate 0 the whole judge term is gated off, so a
	// zero-test cell floors to 0 regardless of the judge.
	const c = 60 * rate + 4 * judge * Math.min(1, 4 * rate);
	return Math.round(c * 10) / 10;
}

/**
 * Band emoji for a composite: >=80 🟢, >=50 🟡, else 🔴.
 * @param {number} c
 * @returns {string}
 */
export function compositeBand(c) {
	return c >= 80 ? '🟢' : c >= 50 ? '🟡' : '🔴';
}

/**
 * The single inclusion rule for the headline mean. A cell counts iff:
 *   - it is an `agent_fail` (a genuine failure that ran no tests — included as
 *     a composite 0, because the agent is exactly what's under test), OR
 *   - it is gradeable (not a `harness_error`) AND actually produced test
 *     results (denom>0).
 * `harness_error` cells are always excluded.
 * @param {object} result
 * @returns {boolean}
 */
export function isScoredCell(result) {
	const klass = result?.klass ?? classifyCell(result).klass;
	if (klass === 'harness_error') return false;
	if (klass === 'agent_fail') return true;
	return testStats(result).denom > 0;
}

/**
 * Interpret the objective build signal for the judge's `functional_completeness`
 * hard cap. Some templates (e.g. backend/tsx) ship NO `build` script, so a bare
 * `npm run build` prints `npm error Missing script: "build"` and exits non-zero —
 * which is NOT a build failure and must NOT cap the qualitative score (this is
 * what unfairly capped observability-api to 3 despite 18/18 tests). Step 3
 * therefore reports a tri-state `build_status`:
 *   - `na`     → no `build` script in the template → build is not applicable →
 *                NO cap (a run is never penalised for a script that never existed).
 *   - `ok`     → a `build` script exists and exited 0 → NO cap.
 *   - `failed` → a `build` script exists and exited non-zero → a REAL build
 *                failure (e.g. file-gallery's `tsc` failing on the agent's type
 *                errors) → cap. This legitimate penalty is preserved.
 * Back-compat: when `build_status` is absent (older evidence), fall back to the
 * boolean `build_succeeded` flag — a non-truthy value is treated as a failure,
 * preserving the original cap behaviour for any caller that predates the tri-state.
 * @param {{build_status?: unknown, build_succeeded?: unknown}} ev objective evidence
 * @returns {{status: ('na'|'ok'|'failed'), cap: boolean, note: (string|null)}}
 *   `cap` true ⇒ functional_completeness should be capped for a build failure;
 *   `note` is a non-null audit line only for the N/A case.
 */
export function buildCapDecision(ev) {
	const raw = ev?.build_status;
	let status;
	let note = null;
	if (raw === 'na' || raw === 'ok' || raw === 'failed') {
		status = raw;
		if (status === 'na') {
			note = 'build N/A — template ships no `build` script; build-cap not applicable';
		}
	} else {
		// Legacy evidence without the tri-state: a truthy build_succeeded (the
		// workflow may pass the GITHUB_OUTPUT strings "true"/"false") is a pass;
		// anything else is a real failure — the original pre-tri-state behaviour.
		const ok = ev?.build_succeeded === true || ev?.build_succeeded === 'true';
		status = ok ? 'ok' : 'failed';
		// When NEITHER the tri-state NOR a build_succeeded flag is present, the
		// resulting 'failed' is a pessimistic default (no evidence either way),
		// not an observed build failure — record that so the cap is explainable.
		const evidenceAbsent =
			(raw === undefined || raw === null) &&
			(ev?.build_succeeded === undefined || ev?.build_succeeded === null);
		if (status === 'failed' && evidenceAbsent) {
			note = 'build evidence absent — pessimistic cap applied';
		}
	}
	return {
		status,
		cap: status === 'failed',
		note,
	};
}

/**
 * The deterministic hard-cap plan for the judge's qualitative dimensions given
 * the objective evidence. Returns the CEILINGS each affected dimension is
 * clamped to (a ceiling only ever LOWERS a dim above it — it never raises one),
 * plus audit reasons and notes. This is the single source of truth for WHICH
 * objective failure caps WHICH dimension and by how much, so 4-judge.ts can't
 * drift from these tests.
 *
 * FAIRNESS — a single root failure must not double-penalize one dimension:
 *   - A REAL build failure (`build_status`=='failed', deterministically NOT the
 *     'na' case where a template ships no `build` script) caps
 *     functional_completeness to 3. buildCapDecision owns that 'failed' vs 'na'
 *     distinction, so an absent build script never triggers a cap.
 *   - A dev server that never started caps selector_contract to 2 (its selectors
 *     were never verifiable at runtime) and functional_completeness to 2 — but
 *     the functional_completeness cap fires ONLY when the build did NOT itself
 *     fail. When the build DID fail, a not-started dev server is a downstream
 *     SYMPTOM of that same root failure, so the build cap already owns
 *     functional_completeness and the dev-server rule does not stack a second,
 *     lower fc ceiling on top of it. (This never weakens "a broken app scores
 *     low": a failed build floors the objective test-rate — no test can pass —
 *     so the composite headline is ~0 regardless of whether fc lands at 2 or 3;
 *     these caps only shape the raw qualitative dims, not the composite.)
 * The caller applies each ceiling through a `cur > ceiling` guard, so a
 * dimension the judge already scored at/below a ceiling is never lowered again
 * nor recorded as a no-op cap — an already-low dim can't be double-counted.
 * @param {{build_status?: unknown, build_succeeded?: unknown, dev_server_started?: unknown}} ev objective evidence
 * @returns {{caps: {dimension: string, ceiling: number, reason: string}[], notes: string[]}}
 */
export function hardCapPlan(ev) {
	const caps = [];
	const notes = [];
	const build = buildCapDecision(ev);
	if (build.cap) caps.push({ dimension: 'functional_completeness', ceiling: 3, reason: 'build failed' });
	if (build.note) notes.push(build.note);
	// dev_server_started reaches us as a real bool or its GITHUB_OUTPUT string.
	const devOk = ev?.dev_server_started === true || ev?.dev_server_started === 'true';
	if (!devOk) {
		// Only cap functional_completeness for a not-started dev server when the
		// build did NOT already fail — otherwise this is the SAME root failure and
		// the build cap already owns fc (see FAIRNESS above). selector_contract is
		// a distinct dimension the build cap never touches, so it always applies.
		if (!build.cap) {
			caps.push({ dimension: 'functional_completeness', ceiling: 2, reason: 'dev server not started' });
		}
		caps.push({ dimension: 'selector_contract', ceiling: 2, reason: 'dev server not started' });
	}
	return { caps, notes };
}

// ── Cost & score-per-dollar ──────────────────────────────────────────────────
// Amazon Bedrock on-demand pricing, USD per 1,000,000 tokens. This is the SINGLE
// place to edit when AWS changes Bedrock pricing or the benchmarked model. The
// COST/SCORE columns in the report are derived from BUILDER_PRICING below.
// Source: https://aws.amazon.com/bedrock/pricing/ (Anthropic Claude).
export const PRICING = {
	// $/1M tokens (input, output).
	'claude-sonnet': { input: 3.0, output: 15.0 },
	'claude-opus': { input: 15.0, output: 75.0 },
};

// The BUILDER (the agent under test in 2-agent-run.ts) runs on Claude Sonnet 4.6,
// so a cell's cost is its builder token spend priced at Sonnet rates. result.json's
// tokens_in/tokens_out are the BUILDER's accumulated usage — the judge and the
// analysis run on Opus but that spend is the harness's, not the agent's, and is
// NOT counted here. Point this at PRICING['claude-opus'] if the builder model
// ever changes.
export const BUILDER_PRICING = PRICING['claude-sonnet'];

/**
 * USD cost of a cell's BUILDER token spend at {@link BUILDER_PRICING}. Returns
 * `null` — never a fake `$0` — when the cell recorded no usable token counts
 * (e.g. a harness_error that died before the agent ran, so tokens are 0/0), so
 * the report renders "—" for it. Rounded to 1/100th of a cent.
 * @param {{tokens_in?: number, tokens_out?: number}} r a finalized result.json cell
 * @param {{input: number, output: number}} [pricing]
 * @returns {number|null}
 */
export function cellCost(r, pricing = BUILDER_PRICING) {
	const tin = typeof r?.tokens_in === 'number' && Number.isFinite(r.tokens_in) ? r.tokens_in : 0;
	const tout = typeof r?.tokens_out === 'number' && Number.isFinite(r.tokens_out) ? r.tokens_out : 0;
	if (tin + tout <= 0) return null;
	const cost = (tin * pricing.input + tout * pricing.output) / 1_000_000;
	return Math.round(cost * 1e4) / 1e4;
}

// SCORE direction, the SINGLE knob for the headline SCORE metric:
//   true  → SCORE = composite per dollar (higher = better) — the default.
//   false → SCORE = dollars per composite point (lower = better).
// Flipping this ONE constant swaps the ratio in scorePerDollar below AND the
// green/red direction in overview.mjs (which imports it), keeping the number and
// its coloring in sync.
export const SCORE_PER_DOLLAR = true;

/**
 * The headline SCORE for a cell: the 0..100 composite (quality) normalized by its
 * $ cost (efficiency) — "composite points per dollar", higher = better, by
 * default. Cost, NOT raw token volume, is the denominator, so token count can
 * never DOMINATE the score: a cheap-and-good cell beats an expensive-and-good
 * one, while a broken (composite 0) cell scores 0 no matter how cheap it was.
 * `null` when the composite or the cost is unavailable (rendered "—"). Rounded
 * to 1 decimal.
 * @param {number|null} baseComposite the 0..100 composite from {@link composite}
 * @param {number|null} cost USD from {@link cellCost}
 * @returns {number|null}
 */
export function scorePerDollar(baseComposite, cost) {
	if (typeof baseComposite !== 'number' || !Number.isFinite(baseComposite)) return null;
	if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0) return null;
	// Default (SCORE_PER_DOLLAR): points per $. Inverted: $ per point — undefined
	// at composite 0 (a free-but-worthless cell), so return null there.
	const s = SCORE_PER_DOLLAR ? baseComposite / cost : baseComposite > 0 ? cost / baseComposite : null;
	if (s === null || !Number.isFinite(s)) return null;
	return Math.round(s * 10) / 10;
}
