// Single source of truth for bench scoring: cell classification (`klass`), the test pass-rate, the
// verdict tiers, the composite formula + band, and the inclusion/exclusion rule for the headline mean.
// Imported by finalize-result.mjs (stamps these onto each result.json) and summary.mjs (recomputes
// the table), so the two can't drift. Plain .mjs so both run under bare `node` in CI.

// The judge rubric's shared dimensions, scored 0-10 and averaged equally. Here (not prompts.ts) so
// the `node --test` suite can pin it without a TS loader; prompts.ts re-exports it (one source).
export const COMMON_DIMENSIONS = [
	'functional_completeness',
	'selector_contract',
	'persistence',
	'code_quality',
	'blocks_fidelity',
];

// Pre-grade steps whose failure means no gradeable artifact AND the fault is the harness's, not the
// agent's → classed `harness_error`, EXCLUDED from the mean. Value = short reason for the summary.
export const HARNESS_FAIL_REASONS = {
	'pre-oidc': 'preflight_failed',
	'0-oidc': 'oidc_failed',
	'1-init': 'init_abort',
};

// The agent step (2-agent) failing is the thing under test failing (timed out / produced no app), so
// it's a GENUINE failure (verdict 'fail', composite 0) and IS counted. (A CI cancellation here is
// still an infra abort — see classifyCell.)
export const AGENT_FAIL_AT = '2-agent';
export const AGENT_FAIL_REASON = 'agent_timeout';

// An ungraceful 2-agent death that tore down the harness itself (isUngracefulStepTwoDeath) is infra,
// not a gradeable failure → reclassified harness_error, EXCLUDED under this (distinct) reason.
export const AGENT_HARNESS_TEARDOWN_REASON = 'agent_harness_teardown';

// The NON-terminal stop_reason 2-agent-run.ts stamps on its running checkpoint (lib/partial-envelope.mjs).
// A checkpoint surviving to finalize means no terminal exit path overwrote it (the process died
// ungracefully). Single-sourced here so the harness (writes it) and classifyCell (reads it) agree.
export const CHECKPOINT_STOP_REASON = 'in_progress';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Did 2-agent-run.ts reach a terminal exit path (SIGTERM/SIGINT flush, invoke-exhausted sentinel, or
 * normal finish)? Those stamp a terminal `stop_reason`; the step-0 baseline leaves it '' and the
 * running checkpoint leaves {@link CHECKPOINT_STOP_REASON} + `checkpoint:true`. Graceful = NOT a
 * surviving checkpoint AND a non-empty, non-checkpoint stop_reason. Separates a genuine agent timeout
 * (which flushed) from an ungraceful harness teardown (which did not).
 * @param {{stop_reason?: unknown, checkpoint?: unknown}} result
 * @returns {boolean}
 */
function reachedGracefulExit(result) {
	if (result?.checkpoint === true) return false;
	const sr = result?.stop_reason;
	return typeof sr === 'string' && sr !== '' && sr !== CHECKPOINT_STOP_REASON;
}

/**
 * Detect the harness-integrity signature: a 2-agent death whose bash process-group/pkill storm tore
 * down the parent harness, bypassing the SIGTERM flush — so result.json has the step-0 baseline or a
 * surviving non-terminal checkpoint (no terminal exit ran). This detects the SIGNATURE only; whether
 * it is EXCLUDED (harness_error) or counted (agent_fail) is gated by the caller on `isolation_active`
 * (classifyCell) — the reclassification is sound only when isolation was active. A genuine timeout /
 * invoke-exhaustion reaches a terminal stop_reason (reachedGracefulExit) and is not this signature;
 * a cancellation is handled in classifyCell.
 * @param {{failed_at?: string|null, status?: string, stop_reason?: unknown, checkpoint?: unknown}} result
 * @returns {boolean}
 */
export function isUngracefulStepTwoDeath(result) {
	if ((result?.failed_at ?? null) !== AGENT_FAIL_AT) return false;
	if (result?.status === 'cancelled') return false;
	return !reachedGracefulExit(result);
}

/**
 * Classify a finalized cell:
 *   - `harness_error` — a pre-grade step failed or the run was CANCELLED (EXCLUDED from the mean).
 *   - `agent_fail` — the agent step failed on its own merits AND exited gracefully (verdict 'fail',
 *     composite 0, INCLUDED). An ungraceful 2-agent teardown is reclassified `harness_error`.
 *   - `scored` — reached build/test/judge; its outcome is a real signal.
 * @param {{failed_at?: string|null, status?: string, stop_reason?: unknown, checkpoint?: unknown}} result
 * @returns {{klass: 'scored'|'harness_error'|'agent_fail', reason: string|null}}
 */
export function classifyCell(result) {
	const failedAt = result?.failed_at ?? null;
	// A cancellation is an infra abort wherever it lands → harness_error.
	if (result?.status === 'cancelled') {
		return { klass: 'harness_error', reason: 'cancelled' };
	}
	if (failedAt && Object.prototype.hasOwnProperty.call(HARNESS_FAIL_REASONS, failedAt)) {
		return { klass: 'harness_error', reason: HARNESS_FAIL_REASONS[failedAt] };
	}
	// Agent failure is a real fail — except an ungraceful harness teardown (no terminal envelope) that
	// happened WHILE agent-shell isolation was active, which is reclassified harness_error so a
	// self-inflicted infra kill can't drag the mean. The isolation gate is load-bearing: only WITH
	// isolation on is an ungraceful step-2 death necessarily genuine infra (runner OOM / GHA cancel),
	// because cross-uid EPERM stops the agent from signalling the harness. With isolation OFF (or its
	// state unproven — `isolation_active` absent), the #184 pkill-storm is exactly an ungraceful death
	// the agent inflicted on itself, so it stays agent_fail (composite 0, INCLUDED) rather than being
	// quietly excluded and inflating the headline mean.
	if (failedAt === AGENT_FAIL_AT) {
		if (isUngracefulStepTwoDeath(result) && result?.isolation_active === true) {
			return { klass: 'harness_error', reason: AGENT_HARNESS_TEARDOWN_REASON };
		}
		return { klass: 'agent_fail', reason: AGENT_FAIL_REASON };
	}
	return { klass: 'scored', reason: null };
}

/**
 * Test counts for a cell (missing/non-numeric read as 0). DENOMINATOR = passed + failed, NOT the
 * audit-only `tests_total` (which includes skipped): skipped/interrupted tests never ran, so counting
 * them would dilute the rate. A per-test timeout is an unexpected failure (in `failed`), so penalized.
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
 * Verdict tier from a pass-rate. `harnessHint` 'harness_error' or 'unknown' (no tests ran)
 * short-circuits; otherwise the rate decides. The judge plays no part — tests are the source of truth.
 * @param {number} tr pass-rate in [0,1]
 * @param {('harness_error'|'unknown'|null)} [harnessHint]
 * @returns {'pass'|'partial'|'fail'|'harness_error'|'unknown'}
 */
export function verdict(tr, harnessHint) {
	if (harnessHint === 'harness_error') return 'harness_error';
	if (harnessHint === 'unknown') return 'unknown';
	// `>= 0.999` (not `=== 1`) is a float-equality guard so a full pass computed as e.g. 7/7 stays 'pass'.
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
	// An agent failure is a real 'fail' even with no tests — must not read as 'unknown' (excluded).
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
	// The min(1, 4*rate) gate ramps the judge term from 0 (rate 0) to full weight at rate 0.25: below
	// 25% passing there's too little objective evidence to let the judge ride a high composite.
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
 * The single inclusion rule for the headline mean. A cell counts iff it is an `agent_fail` (a genuine
 * failure counted as composite 0), OR it is gradeable (not harness_error) and produced tests (denom>0).
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
 * Interpret the objective build signal for the judge's `functional_completeness` cap. Step 3 reports
 * a tri-state `build_status`: `na` (no build script → no cap), `ok` (built → no cap), `failed` (real
 * failure → cap). Back-compat: when absent, fall back to the boolean `build_succeeded`.
 * @param {{build_status?: unknown, build_succeeded?: unknown}} ev objective evidence
 * @returns {{status: ('na'|'ok'|'failed'), cap: boolean, note: (string|null)}}
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
		// Legacy evidence: a truthy build_succeeded (may be the "true"/"false" string) is a pass.
		const ok = ev?.build_succeeded === true || ev?.build_succeeded === 'true';
		status = ok ? 'ok' : 'failed';
		// No tri-state AND no flag → the 'failed' is a pessimistic default, not an observed failure.
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
 * The deterministic hard-cap plan for the judge's qualitative dimensions given the objective evidence.
 * Returns the CEILINGS each affected dimension is clamped to (only ever LOWERS), plus audit notes.
 * Single source of truth for which objective failure caps which dimension, so 4-judge.ts can't drift.
 *
 * FAIRNESS — one root failure must not double-penalize: a real build failure caps
 * functional_completeness to 3; a not-started dev server caps selector_contract to 2 and
 * functional_completeness to 2, but the fc cap fires ONLY if the build didn't already fail (else the
 * not-started server is a downstream symptom the build cap already owns).
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
		// Cap fc for a not-started server only if the build didn't already fail (same root → build cap
		// owns fc). selector_contract is distinct and always applies.
		if (!build.cap) {
			caps.push({ dimension: 'functional_completeness', ceiling: 2, reason: 'dev server not started' });
		}
		caps.push({ dimension: 'selector_contract', ceiling: 2, reason: 'dev server not started' });
	}
	return { caps, notes };
}

// ── Cost & score-per-dollar ──────────────────────────────────────────────────
// Bedrock on-demand pricing, USD per 1M tokens — the single place to edit on a pricing/model change.
// Source: https://aws.amazon.com/bedrock/pricing/ (Anthropic Claude).
export const PRICING = {
	'claude-sonnet': { input: 3.0, output: 15.0 },
	// Claude Opus 4.5+ standard rate (the current default, Opus 4.8); replaced the legacy Opus-4.1 $15/$75.
	'claude-opus': { input: 5.0, output: 25.0 },
};

// The builder (agent under test) runs on Opus 4.8, so a cell's cost is its builder tokens_in/out at
// Opus rates. The judge/analysis also run on Opus but that spend is the harness's, not counted here.
// Point back at PRICING['claude-sonnet'] if the builder model ever reverts to Sonnet.
export const BUILDER_PRICING = PRICING['claude-opus'];

/**
 * USD cost of a cell's builder token spend at {@link BUILDER_PRICING}. Returns `null` (never a fake
 * $0) when the cell has no usable token counts, so the report renders "—". Rounded to 1/100th of a cent.
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

// SCORE direction, the single knob for the headline SCORE metric:
//   true  → SCORE = composite per dollar (higher = better) — the default.
//   false → SCORE = dollars per composite point (lower = better).
// Flipping this swaps the ratio in scorePerDollar AND the green/red direction in overview.mjs.
export const SCORE_PER_DOLLAR = true;

/**
 * The headline SCORE for a cell: the 0..100 composite normalized by its $ cost ("points per dollar",
 * higher = better, by default). Cost (not raw tokens) is the denominator so a cheap-and-good cell
 * beats an expensive one; a composite-0 cell scores 0. `null` when composite or cost is unavailable.
 * @param {number|null} baseComposite the 0..100 composite from {@link composite}
 * @param {number|null} cost USD from {@link cellCost}
 * @returns {number|null}
 */
export function scorePerDollar(baseComposite, cost) {
	if (typeof baseComposite !== 'number' || !Number.isFinite(baseComposite)) return null;
	if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0) return null;
	// Default: points per $. Inverted: $ per point — undefined at composite 0, so null there.
	const s = SCORE_PER_DOLLAR ? baseComposite / cost : baseComposite > 0 ? cost / baseComposite : null;
	if (s === null || !Number.isFinite(s)) return null;
	return Math.round(s * 10) / 10;
}
