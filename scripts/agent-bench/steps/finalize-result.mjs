// Run as the last step of every cell with `if: always()`. Derives the cell's
// overall `status` from each step's GitHub outcome and stamps it onto
// result.json so the summary table can show a precise failed_at — then stamps
// the SCORING fields (klass, test_rate, verdict, composite) using the shared
// scoring module, so the uploaded artifact is self-describing and summary.mjs
// can re-derive the exact same numbers from one source of truth.
import { readFileSync, writeFileSync } from 'node:fs';
import { classifyCell, composite, isScoredCell, testRate, testStats, verdictOf } from './lib/scoring.mjs';

const RESULT_PATH = process.env.RESULT_PATH ?? '/tmp/result.json';

// Each input is a GitHub step outcome ('success' | 'failure' | 'cancelled' | 'skipped' | '').
// Order matters: this is the pipeline order. The first non-success step is
// where we failed; later steps' outcomes are typically 'skipped' as a result.
const ORDERED_STEPS = [
	{ key: '0-oidc', outcome: process.env.OUTCOME_OIDC ?? '' },
	{ key: '1-init', outcome: process.env.OUTCOME_INIT ?? '' },
	{ key: '2-agent', outcome: process.env.OUTCOME_AGENT ?? '' },
	{ key: '3-build-test', outcome: process.env.OUTCOME_TESTS ?? '' },
	{ key: '4-judge', outcome: process.env.OUTCOME_JUDGE ?? '' },
];

let status = 'scored';
let failedAt = null;
let sawSkip = false;
for (const { key, outcome } of ORDERED_STEPS) {
	if (outcome === '' || outcome === 'skipped') {
		// A tracked step never ran. In normal flow an earlier tracked step
		// would already have failed and broken the loop, so reaching a skip
		// without a recorded failure means something *before* the first
		// tracked step (checkout, setup-node, npm ci) failed pre-OIDC.
		sawSkip = true;
		break;
	}
	if (outcome === 'cancelled') {
		status = 'cancelled';
		failedAt = key;
		break;
	}
	if (outcome !== 'success') {
		status = 'error';
		failedAt = key;
		break;
	}
}

// Don't report a never-run cell as 'scored': if the scan hit a skipped/empty
// tracked step without first finding a failure, an untracked pre-OIDC step
// failed (e.g. npm ci) and nothing downstream actually ran.
if (status === 'scored' && sawSkip) {
	status = 'error';
	failedAt = 'pre-oidc';
}

let r;
let resultFileMissing = false;
try {
	r = JSON.parse(readFileSync(RESULT_PATH, 'utf-8'));
} catch (err) {
	// Baseline never written (e.g., 0-init-result itself failed, or npm ci
	// failed before any tracked step ran so result.json was never created).
	// Reconstruct a minimal envelope so the cell still appears in the table.
	resultFileMissing = true;
	r = {
		template: process.env.TEMPLATE ?? '',
		task: process.env.TASK ?? '',
		pr_number: process.env.PR_NUMBER ?? '',
		run_id: process.env.GITHUB_RUN_ID ?? '',
		git_sha: process.env.GITHUB_SHA ?? '',
		notes: [`finalize-result couldn't read ${RESULT_PATH}: ${err?.message ?? err}`],
	};
}

// A cell whose result.json was never written cannot be 'scored' regardless of
// the recorded step outcomes — synthesize a pessimistic status so a missing
// artifact (e.g. npm ci failed pre-OIDC) is never mistaken for a graded run.
if (resultFileMissing && status === 'scored') {
	status = 'error';
	failedAt = failedAt ?? 'pre-oidc';
}

// ── Fold the builder's partial envelope (SIGTERM / wall-clock-timeout path) ──
// On an agent wall-clock timeout the gradeable steps (3-build-test, 4-judge) are
// SKIPPED, so the judge's merge — normally the ONLY place 2-agent-run's envelope
// is folded into result.json — never runs, and this if:always() step is the sole
// survivor. Without this it would upload the step-0 baseline (tokens_in/out=0,
// stop_reason='') and silently drop exactly the spend the SIGTERM handler wrote
// the envelope to preserve. Fold it here, but fill ONLY fields the judge (happy
// path) or earlier steps did NOT already write — a value already present and
// real (non-empty, non-zero) is never overwritten, so the success path is
// unchanged (there the envelope and result.json already agree).
const BUILDER_RESULT = process.env.BUILDER_RESULT;
if (BUILDER_RESULT) {
	try {
		const builder = JSON.parse(readFileSync(BUILDER_RESULT, 'utf-8'));
		for (const [k, v] of Object.entries(builder)) {
			if (v === undefined || v === null) continue;
			const cur = r[k];
			// "Not already written" = missing / null / empty-string / zero. The
			// step-0 baseline seeds tokens_in/out=0 and stop_reason='', so those
			// count as unwritten and take the real partial values from the envelope.
			const unwritten = cur === undefined || cur === null || cur === '' || cur === 0;
			if (unwritten) r[k] = v;
		}
	} catch {
		// No readable envelope: normal on the happy path (judge already folded it)
		// and on pre-agent failures (it was never written). Nothing to fold.
	}
}

r.status = status;
if (failedAt) r.failed_at = failedAt;

// ── Scoring fields, single-sourced in lib/scoring.mjs ────────────────────────
// classifyCell reads r.failed_at / r.status (set just above): a pre-flight,
// OIDC or scaffold (1-init) failure — or a cancellation — is a harness_error
// (never produced a gradeable artifact; excluded from the mean), while the
// agent step (2-agent) failing on its own merits (timeout / no app in budget)
// is an `agent_fail` — a REAL failure scored as composite 0 and INCLUDED in the
// mean. Once a cell reaches build/test/judge its outcome is a real signal, so
// it stays `scored`. The summary averages the scored + agent_fail cells.
const { klass, reason } = classifyCell(r);
r.klass = klass;
if (reason) r.klass_reason = reason;

// Publish the derived scoring fields so a reader can re-derive / re-weight the
// composite from the artifact alone — summary.mjs recomputes these from the
// SAME functions, so the published values and the rendered table can't diverge.
const stats = testStats(r);
const tr = testRate(stats);
const j = typeof r.judge_score === 'number' ? r.judge_score : 0;
// test_rate is ROUNDED to 3 decimals for display/audit only; composite() below
// is fed the EXACT ratio `tr` so the score never inherits the rounding error.
r.test_rate = Math.round(tr * 1000) / 1000;
r.judge_overall = typeof r.judge_score === 'number' ? r.judge_score : null;
r.verdict = verdictOf(r);
// Only scored + agent_fail cells carry a numeric composite; a harness_error cell
// never produced a gradeable artifact, so it gets composite:null (NOT 0) and is
// excluded from the headline mean — isScoredCell reads the klass stamped above.
r.composite = isScoredCell(r) ? composite(tr, j) : null;

writeFileSync(RESULT_PATH, JSON.stringify(r, null, 2));
process.stderr.write(
	`[finalize-result] status=${status}${failedAt ? ` failed_at=${failedAt}` : ''} klass=${klass}${reason ? ` reason=${reason}` : ''} verdict=${r.verdict} composite=${r.composite}\n`,
);
