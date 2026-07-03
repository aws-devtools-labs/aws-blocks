/**
 * Judge step: grade the agent's implementation on the source code only.
 *
 * Fairness moves:
 *   - Different model from the builder by default (Opus 4.8 vs builder's
 *     Sonnet 4.6) to limit same-model self-evaluation bias.
 *   - Judge determinism rests on the structured-output schema + deterministic
 *     hard caps (the judge model rejects `temperature`); the builder pins
 *     temperature=0.
 *   - Evidence (build/test/scaffold pass-fail) is NOT shown to the judge —
 *     it would anchor the qualitative dimensions. The orchestrator applies
 *     those signals as deterministic hard caps after the model returns.
 *
 * Inputs (env):
 *   WORKSPACE         absolute path to the implemented bench-app (read-only at this point)
 *   TASK_PROMPT       path to PROMPT.md
 *   BUILDER_RESULT    path to the builder's output JSON
 *   EVIDENCE          JSON of objective signals — used by the orchestrator for caps; never sent to the judge
 *   OUTPUT            path to write the merged result envelope
 *   BENCH_JUDGE_MODEL judge model ID (default us.anthropic.claude-opus-4-8)
 */
import { execSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import {
	Agent,
	type AgentResult,
	BedrockModel,
	ContextWindowOverflowError,
	MaxTokensError,
	ModelError,
	ModelThrottledError,
	StructuredOutputError,
} from '@strands-agents/sdk';
import { makeBash } from '@strands-agents/sdk/vended-tools/bash';
import { z } from 'zod';
import { COMMON_DIMENSIONS, JUDGE_SYSTEM, judgeRubric } from '../prompts.ts';
import { WorkspaceSandbox, describeError, required, shellQuote } from './lib/run-shell.ts';
import { hardCapPlan } from './lib/scoring.mjs';

// Physical spec-blinding: the judge grades a SOURCE-ONLY COPY of the workspace
// (staged below into JUDGE_SRC) with these excluded, so the objective test can't
// anchor the score — blinding is by ABSENCE, robust against any cat/grep/find.
//   - STAGE_EXCLUDE_DIRS: dependencies (node_modules) + VCS (.git) + build output
//     (dist) + the copied objective spec dir (`bench-tests/`, where step 3 stages
//     the Playwright spec) + `.blocks-sandbox` (a build-time source-artifact dir,
//     never the agent's work). Also the grep exclude-dirs in collectBlocksImports.
//   - EXCLUDED_FILE_RE: the objective PLAYWRIGHT/test-spec CODE files
//     (*.spec.{js,ts,jsx,tsx,cjs,mjs}) the agent (or step 3) left in the tree. It
//     deliberately does NOT match framework-generated `*.spec.json` manifests
//     (e.g. aws-blocks/blocks.spec.json — the OpenRPC contract @aws-blocks/core
//     emits at build/dev time); those are legit app source the judge SHOULD see.
const STAGE_EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'bench-tests', '.blocks-sandbox']);
const EXCLUDED_FILE_RE = /\.spec\.[cm]?[jt]sx?$/;

const WORKSPACE = required('WORKSPACE', '[judge]');
const TASK_PROMPT_PATH = required('TASK_PROMPT', '[judge]');
const BUILDER_RESULT = required('BUILDER_RESULT', '[judge]');
const EVIDENCE = parseJsonEnv('EVIDENCE');
const OUTPUT = required('OUTPUT', '[judge]');
const MODEL_ID = process.env.BENCH_JUDGE_MODEL ?? 'us.anthropic.claude-opus-4-8';

// Equal-weighted dimensions: the fixed shared set (prompts.ts
// COMMON_DIMENSIONS) — every task is graded on the same uniform rubric, with no
// per-task dimension. Listing them in one place keeps the cap logic and the
// average honest. (We deliberately avoid weights — they invite anchoring bias
// and are hard to justify scientifically.)
const DIMENSIONS = COMMON_DIMENSIONS;

// Built from the shared dimension keys so each is required in the structured
// output. All dimensions are 0-10; explanation is free text.
const scoreShape: Record<string, z.ZodTypeAny> = { explanation: z.string() };
for (const d of DIMENSIONS) scoreShape[d] = z.number().min(0).max(10);
const SCORE_SCHEMA = z.object(scoreShape);

interface CapApplied {
	dimension: string;
	cap: number;
	reason: string;
}

const taskPrompt = readFileSync(TASK_PROMPT_PATH, 'utf-8');
let builderResult: Record<string, unknown> = {};
try {
	builderResult = JSON.parse(readFileSync(BUILDER_RESULT, 'utf-8')) as Record<string, unknown>;
} catch (err) {
	process.stderr.write(`[judge] BUILDER_RESULT (${BUILDER_RESULT}) unreadable: ${describeError(err)}\n`);
	// Continue with empty; we still want to produce a graded result.
}

// Persist the objective evidence (and builder fields) up front — BEFORE staging
// the source copy below — so a failure in staging (cpSync throw / spec-leak
// exit) can't roll result.json back to the step-0 baseline zeros and pollute the
// mean. mergeAndWrite is idempotent; the success and error paths re-merge on top.
mergeAndWrite(builderResult, { ...EVIDENCE });

// Physical spec-blinding: stage a SOURCE-ONLY COPY of the workspace and point
// the judge's Sandbox at it. The objective test spec and everything that isn't
// the agent's source (deps, build output, .blocks-sandbox, any *.spec.{js,ts,
// jsx,tsx,cjs,mjs}) is left OUT of the copy, so the judge is blinded by ABSENCE
// — no cat/grep/find can reach a spec that physically isn't there. The copy is
// disposable, so the vended bash's write ability can't affect scoring.
const JUDGE_SRC = mkdtempSync(join(tmpdir(), 'bench-judge-src-'));

// `src` is an absolute path under WORKSPACE; whole excluded subtrees are skipped
// and test-spec CODE files (EXCLUDED_FILE_RE, NOT framework *.spec.json) dropped.
function stageFilter(src: string): boolean {
	const rel = relative(WORKSPACE, src);
	if (rel === '') return true; // the root itself
	const parts = rel.split(sep);
	if (parts.some((seg) => STAGE_EXCLUDE_DIRS.has(seg))) return false;
	return !EXCLUDED_FILE_RE.test(parts[parts.length - 1] ?? '');
}
cpSync(WORKSPACE, JUDGE_SRC, { recursive: true, filter: stageFilter });

// Fail loudly if any spec or the bench-tests dir leaked into the copy — the
// whole point of the copy is that they are absent. This is an INDEPENDENT check
// (a find, not the same filter), so a filter bug can't silently un-blind the judge.
assertNoSpecLeak(JUDGE_SRC);

function assertNoSpecLeak(dir: string): void {
	// INDEPENDENT re-check (a find, not the same JS filter) so a stageFilter bug
	// can't silently un-blind the judge. The -regex MUST mirror EXCLUDED_FILE_RE:
	// only the objective PLAYWRIGHT/test-spec CODE files (*.spec.{js,ts,jsx,tsx,
	// cjs,mjs}) and the staged `bench-tests/` dir count as leaks. It deliberately
	// does NOT flag framework build artifacts like aws-blocks/blocks.spec.json (a
	// generated OpenRPC manifest, not the bench objective) — a broad `*.spec.*`
	// glob false-positived on exactly that file and killed the judge (run
	// 28639226838). posix-extended -regex matches the whole path, so `.*` prefixes.
	const leaks = execSync(
		`find ${shellQuote(dir)} \\( -name bench-tests -o -regextype posix-extended -regex '.*\\.spec\\.[cm]?[jt]sx?' \\) -print`,
		{ encoding: 'utf-8' },
	).trim();
	if (leaks) {
		process.stderr.write(`[judge] FATAL: objective spec / bench-tests leaked into the judge source copy:\n${leaks}\n`);
		process.exit(1);
	}
}

// Judge-call robustness. The judge's own Bedrock calls throttle under the ~8
// concurrent matrix cells (each an Opus judge hitting the same inference
// profile). Two retry layers cover that:
//   1. SDK layer (here): `adaptive` retry mode adds a client-side rate limiter
//      (token bucket) on top of a higher attempt count, so a transient
//      ThrottlingException / ServiceUnavailableException is absorbed inside a
//      single invoke() before it ever surfaces to us.
//   2. invoke layer (the loop below): re-invokes on a throttle/transient failure
//      that still exhausts the SDK's retries (or a mid-stream ModelStreamError),
//      with a much longer exponential backoff than the SDK's millisecond spacing.
// A fresh agent is built per attempt so a mid-stream throw can't leave a
// half-built conversation that pollutes the retry.
//
// TEMPERATURE GOTCHA: Opus 4.8 (the judge) REJECTS `temperature` — do not
// re-add it here. Judge determinism rests on the structured-output schema + the
// deterministic hard caps instead. (The builder/Sonnet 4.6 still pins
// temperature=0; that is a different model on a different step.)
function makeJudgeAgent(): Agent {
	return new Agent({
		model: new BedrockModel({
			modelId: MODEL_ID,
			region: process.env.AWS_REGION ?? 'us-east-1',
			clientConfig: { maxAttempts: 8, retryMode: 'adaptive' },
		}),
		systemPrompt: JUDGE_SYSTEM,
		// Vended bash rooted at the spec-blinded source-only copy (JUDGE_SRC). The
		// judge only reads/greps, so the default 120s per-command timeout is ample;
		// its write ability is harmless because JUDGE_SRC is a disposable copy.
		sandbox: new WorkspaceSandbox(JUDGE_SRC),
		tools: [makeBash()],
	});
}

// invoke-layer retry budget: the initial attempt + up to 4 retries (5 tries
// total), only on throttle/transient model failures (never a schema-validation
// failure — that is a real grading outcome). Backoff is exponential with jitter;
// the values are sized to sit comfortably inside the judge step's wall-clock cap.
const JUDGE_MAX_ATTEMPTS = 5;
const JUDGE_BACKOFF_MS = [5_000, 15_000, 40_000, 90_000];

// Evidence is intentionally omitted from the prompt — the orchestrator applies
// the objective hard caps (build/test/scaffold) after the model returns.
// blocks_fidelity input (deterministic): a mechanical grep of the agent's own
// source is ground truth for which @aws-blocks Building Blocks were actually
// imported — a behavioral anti-gaming signal so a faked/absent block can't read
// as a real one. Injected before the rubric/task sections.
const blocksImports = collectBlocksImports(JUDGE_SRC);
const judgeSections: string[] = [];
judgeSections.push(
	`<imports>\nMechanical grep of the agent's workspace source for @aws-blocks imports (node_modules/.git/dist/bench-tests excluded) — ground truth for which blocks were actually imported:\n\n${blocksImports}\n</imports>`,
);
judgeSections.push(`<rubric>\n${judgeRubric()}\n</rubric>`);
judgeSections.push(`<task>\n${taskPrompt}\n</task>`);
const userText = `${judgeSections.join('\n\n')}\n\nInspect the workspace and score it.`;

const started = Date.now();
let result: AgentResult | undefined;
let lastErr: unknown;
let attemptsUsed = 0;
for (let attempt = 1; attempt <= JUDGE_MAX_ATTEMPTS; attempt++) {
	attemptsUsed = attempt;
	try {
		// structuredOutputSchema is the recommended Strands pattern (per
		// strandsagents.com/docs/.../structured-output/). The schema is
		// converted into a tool spec internally; the validated object lands
		// on result.structuredOutput. On validation failure Strands throws
		// StructuredOutputError, which we record distinctly and never retry.
		result = await makeJudgeAgent().invoke(userText, { structuredOutputSchema: SCORE_SCHEMA });
		break;
	} catch (err) {
		lastErr = err;
		const retryable = isRetryableJudgeError(err);
		process.stderr.write(
			`[judge] agent.invoke attempt ${attempt}/${JUDGE_MAX_ATTEMPTS} failed (${retryable ? 'throttle/transient' : 'non-retryable'}): ${describeJudgeError(err)}\n`,
		);
		if (!retryable || attempt >= JUDGE_MAX_ATTEMPTS) break;
		const base = JUDGE_BACKOFF_MS[attempt - 1] ?? JUDGE_BACKOFF_MS[JUDGE_BACKOFF_MS.length - 1] ?? 5_000;
		const delayMs = base + Math.floor(Math.random() * base * 0.25);
		process.stderr.write(`[judge] backing off ${Math.round(delayMs / 1000)}s before attempt ${attempt + 1}\n`);
		await sleep(delayMs);
	}
}

if (!result) {
	// Record the failure honestly so the cell lands with a 0 judge term rather
	// than rolling back to the step-0 baseline. judge_error carries the deep
	// (cause-chain) description so the real AWS throttle class is visible next run.
	const isValidation = lastErr instanceof StructuredOutputError;
	mergeAndWrite(
		{},
		{
			judge_error: describeJudgeError(lastErr),
			judge_error_type: isValidation ? 'schema_validation' : 'invoke_failed',
			judge_error_attempts: attemptsUsed,
		},
	);
	process.exit(1);
}
const judge_duration_sec = Math.round((Date.now() - started) / 1000);

const out = result.structuredOutput as Record<string, unknown> | undefined;
if (!out) {
	process.stderr.write(
		`[judge] WARNING: structured output missing. stop=${result.stopReason}. The cell will land with null scores.\n`,
	);
}

// Raw scores kept alongside the capped scores so we can audit how often caps fire.
const rawScores: Partial<Record<string, number>> = {};
if (out) for (const d of DIMENSIONS) if (typeof out[d] === 'number') rawScores[d] = out[d] as number;
const { capped, applied, notes } = applyHardCaps(rawScores, EVIDENCE);
const overall = DIMENSIONS.every((d) => typeof capped[d] === 'number')
	? Math.round((DIMENSIONS.reduce((acc, d) => acc + (capped[d] ?? 0), 0) / DIMENSIONS.length) * 100) / 100
	: null;

const usage = result.metrics?.accumulatedUsage;
mergeAndWrite(builderResult, {
	...EVIDENCE,
	judge_score: overall,
	judge_dimensions_raw: rawScores,
	judge_dimensions: capped,
	judge_caps_applied: applied,
	judge_notes: notes,
	judge_explanation: typeof out?.explanation === 'string' ? out.explanation : '',
	judge_stop_reason: result.stopReason,
	judge_duration_sec,
	judge_tokens_in: usage?.inputTokens ?? 0,
	judge_tokens_out: usage?.outputTokens ?? 0,
	judge_model: MODEL_ID,
});
process.stderr.write(
	`[judge] done: score=${overall ?? 'null'} caps=${applied.length} stop=${result.stopReason} ${judge_duration_sec}s\n`,
);

// Explicit success exit (mirrors the process.exit(1) error paths above). The
// merged result.json is fully written, so nothing remains. Without this, a stray
// handle left open by a command the judge ran (the same backgrounded-process risk
// the per-command process-group reap guards against) could keep Node's loop
// ref'd and idle the step until its wall-clock timeout. Exit cleanly instead.
process.exit(0);

// Mechanically grep the (read-only) workspace for @aws-blocks imports. The inner
// grep finds every line mentioning the scope; the outer grep keeps only genuine
// import/from/require lines, so scaffold comments that merely reference a path
// don't read as imports. grep exits 1 (no error, no output) when nothing matches
// — that clean "none found" is the enforce-able score-0 signal for the judge.
function collectBlocksImports(workspace: string): string {
	try {
		// The --exclude-dir set MUST stay in sync with STAGE_EXCLUDE_DIRS above —
		// the grep runs over the staged source-only copy, so blinding by absence
		// and this scan must agree on what's off-limits. Globs are quoted so the
		// shell can't expand them against the cwd before grep sees them.
		const out = execSync(
			'grep -rn "@aws-blocks/" . --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.mjs" --include="*.cjs" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=.blocks-sandbox --exclude-dir=bench-tests | grep -Ew "import|from|require"',
			{ cwd: workspace, encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 },
		).trim();
		if (!out) return '(no @aws-blocks imports found in the workspace source)';
		return out.length > 6000 ? `${out.slice(0, 6000)}\n… (truncated)` : out;
	} catch (err) {
		if ((err as { status?: number }).status === 1) {
			return '(no @aws-blocks imports found in the workspace source)';
		}
		return `(import scan failed: ${describeError(err)})`;
	}
}

function applyHardCaps(
	raw: Partial<Record<string, number>>,
	ev: Record<string, unknown>,
): { capped: Partial<Record<string, number>>; applied: CapApplied[]; notes: string[] } {
	const capped: Partial<Record<string, number>> = { ...raw };
	const applied: CapApplied[] = [];
	const notes: string[] = [];
	const cap = (dim: string, ceiling: number, reason: string) => {
		const cur = typeof capped[dim] === 'number' ? capped[dim]! : 0;
		if (cur > ceiling) {
			capped[dim] = ceiling;
			applied.push({ dimension: dim, cap: ceiling, reason });
		}
	};

	// GITHUB_OUTPUT values can reach EVIDENCE as strings ("true"/"3") as well as
	// the JSON bool/number the workflow normally interpolates — coerce both forms
	// so the caps/notes fire either way.
	const truthy = (v: unknown): boolean => v === true || v === 'true';
	const numOf = (v: unknown): number => {
		const n = Number(v);
		return Number.isFinite(n) ? n : 0;
	};
	const tt = numOf(ev.tests_total);
	const tp = numOf(ev.tests_passed);

	// Deterministic hard-cap plan (single-sourced in lib/scoring.mjs). It decides
	// WHICH objective failure caps WHICH dimension: a REAL build failure
	// (build_status=='failed', never 'na') caps functional_completeness to 3, and
	// a not-started dev server caps selector_contract to 2 — plus
	// functional_completeness to 2 ONLY when the build did not itself fail, so one
	// root failure (a broken build that also can't serve a dev server) never
	// stacks two fc caps. cap()'s `cur > ceiling` guard means an already-low dim
	// is never lowered again or recorded twice. None of this weakens
	// "broken app scores low" — a failed build floors the test-rate, so the
	// composite is ~0 regardless of the raw fc dim. See hardCapPlan's docs.
	const plan = hardCapPlan(ev);
	for (const { dimension, ceiling, reason } of plan.caps) cap(dimension, ceiling, reason);
	for (const n of plan.notes) notes.push(n);
	// Test pass-rate is recorded for auditability ONLY — it deliberately does
	// NOT cap functional_completeness (or any dimension). The judge grades the
	// source on its own merits; the test ratio drives the composite headline in
	// the summary step instead, so the qualitative score stays independent of a
	// flaky or partial test run.
	if (tt > 0) {
		const ratio = Math.round((tp / tt) * 1000) / 1000;
		notes.push(`tests ${tp}/${tt} passed (ratio ${ratio}) — recorded for audit; not used to cap judge dimensions`);
	}
	// Playwright failing to install is an infra failure, not the agent's fault,
	// so we don't cap — but record that the functional dimensions went
	// test-unverified so the score isn't silently over-trusted.
	if (!truthy(ev.playwright_installed)) {
		notes.push(
			'playwright failed to install — functional tests did not run; functional_completeness is unverified by tests',
		);
	}
	return { capped, applied, notes };
}

function mergeAndWrite(builder: Record<string, unknown>, judge: Record<string, unknown>): void {
	let existing: Record<string, unknown> = {};
	try {
		existing = JSON.parse(readFileSync(OUTPUT, 'utf-8')) as Record<string, unknown>;
	} catch {
		// baseline missing — proceed with empty
	}
	writeFileSync(OUTPUT, JSON.stringify({ ...existing, ...builder, ...judge }, null, 2));
}

function sleep(ms: number): Promise<void> {
	return new Promise((res) => setTimeout(res, ms));
}

// One node of an error's `cause` chain. Strands wraps the underlying AWS SDK
// exception as `cause`, which carries the real name/$metadata we want to see.
interface ErrorNode {
	name?: unknown;
	message?: unknown;
	$fault?: unknown;
	$metadata?: { httpStatusCode?: number; requestId?: string };
	cause?: unknown;
}

// Walk the `cause` chain (bounded + cycle-safe) so both the throttle classifier
// and the deep describer can inspect every wrapped layer, not just the top one.
function errorChain(err: unknown): ErrorNode[] {
	const out: ErrorNode[] = [];
	const seen = new Set<unknown>();
	let cur: unknown = err;
	while (cur && typeof cur === 'object' && !seen.has(cur) && out.length < 6) {
		seen.add(cur);
		out.push(cur as ErrorNode);
		cur = (cur as ErrorNode).cause;
	}
	return out;
}

// AWS exception names / HTTP statuses that mark a Bedrock failure as transient
// (worth retrying) rather than deterministic.
const TRANSIENT_NAME_RE =
	/throttl|toomanyrequests|serviceunavailable|service_unavailable|internalserver|internalfailure|modelstream|modeltimeout|modelnotready|requesttimeout|timeouterror|partialresult|503|429/i;

// True when a judge model-call failure is a throttle/transient class worth
// retrying. A StructuredOutputError (model wouldn't emit a schema-valid grade)
// is a REAL grading failure and is never retried; ContextWindowOverflowError /
// MaxTokensError are deterministic for this input so retrying cannot help.
function isRetryableJudgeError(err: unknown): boolean {
	if (err instanceof StructuredOutputError) return false;
	if (err instanceof ContextWindowOverflowError || err instanceof MaxTokensError) return false;
	if (err instanceof ModelThrottledError) return true;
	// A bare ModelError almost always wraps a transient mid-stream AWS exception
	// (this is the "ModelError: [object Object]" case the deep-dive found).
	if (err instanceof ModelError) return true;
	// Fall back to the AWS exception name / HTTP status on the error or its cause.
	for (const node of errorChain(err)) {
		const name = typeof node.name === 'string' ? node.name : '';
		if (TRANSIENT_NAME_RE.test(name)) return true;
		const status = node.$metadata?.httpStatusCode;
		if (typeof status === 'number' && (status === 429 || status >= 500)) return true;
	}
	return false;
}

// Deep error description for the judge invoke failure. The plain describeError
// only sees the top wrapper, which for a wrapped Bedrock error is often
// "ModelError: [object Object]" — masking the real AWS class. This surfaces each
// layer's name, message, $fault and $metadata (httpStatusCode/requestId) so a
// future run shows the actual throttle/transient class in result.json.
function describeJudgeError(err: unknown): string {
	const nodes = errorChain(err);
	if (nodes.length === 0) return String(err);
	return nodes
		.map((n) => {
			const name = typeof n.name === 'string' && n.name ? n.name : 'Error';
			let msg: string;
			if (typeof n.message === 'string') {
				msg = n.message;
			} else {
				try {
					msg = JSON.stringify(n.message) ?? String(n.message);
				} catch {
					msg = String(n.message);
				}
			}
			const fault = n.$fault ? ` $fault=${String(n.$fault)}` : '';
			const status = n.$metadata?.httpStatusCode;
			const reqId = n.$metadata?.requestId;
			const metaParts = [
				typeof status === 'number' ? `httpStatusCode:${status}` : '',
				reqId ? `requestId:${reqId}` : '',
			].filter(Boolean);
			const meta = metaParts.length ? ` $metadata={${metaParts.join(',')}}` : '';
			return `${name}: ${msg}${fault}${meta}`;
		})
		.join(' ← caused by ');
}

function parseJsonEnv(name: string): Record<string, unknown> {
	const raw = required(name, '[judge]');
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch (err) {
		process.stderr.write(`[judge] env var ${name} is malformed JSON: ${describeError(err)}\n`);
		process.stderr.write(`[judge]   raw: ${raw.slice(0, 500)}\n`);
		process.exit(1);
	}
}
