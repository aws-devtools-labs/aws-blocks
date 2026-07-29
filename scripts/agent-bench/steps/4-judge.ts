/**
 * Judge step: grade the agent's implementation on the source code only.
 *
 * Fairness: a different model from the builder by default (Opus 4.8 vs Sonnet 4.6); determinism rests
 * on the structured-output schema + deterministic hard caps (the judge rejects `temperature`);
 * evidence (build/test/scaffold) is NOT shown to the judge — the orchestrator applies it as hard caps
 * after the model returns.
 *
 * Inputs (env): WORKSPACE, TASK_PROMPT, BUILDER_RESULT, EVIDENCE (caps only, never sent to judge),
 * OUTPUT, BENCH_JUDGE_MODEL (default us.anthropic.claude-opus-4-8).
 */
import { execSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { Agent, type AgentResult, BedrockModel, StructuredOutputError } from '@strands-agents/sdk';
import { makeBash } from '@strands-agents/sdk/vended-tools/bash';
import { z } from 'zod';
import { COMMON_DIMENSIONS, JUDGE_SYSTEM, judgeRubric } from '../prompts.ts';
import {
	INVOKE_MAX_ATTEMPTS,
	describeModelError,
	isRetryableModelError,
	nextBackoffMs,
	sleep,
} from './lib/bedrock-retry.ts';
import { WorkspaceSandbox, describeError, required, shellQuote } from './lib/run-shell.ts';
import { hardCapPlan } from './lib/scoring.mjs';

// Physical spec-blinding: the judge grades a SOURCE-ONLY COPY (JUDGE_SRC) with these excluded, so the
// objective test can't anchor the score — blinding by ABSENCE.
//   - STAGE_EXCLUDE_DIRS: node_modules, .git, dist, the staged `bench-tests/` spec dir, and
//     `.blocks-sandbox` (a build-time artifact). Also the grep exclude-dirs in collectBlocksImports.
//   - EXCLUDED_FILE_RE: the objective *.spec.{js,ts,jsx,tsx,cjs,mjs} test CODE files — deliberately
//     NOT framework *.spec.json manifests (e.g. blocks.spec.json), which are legit app source.
const STAGE_EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'bench-tests', '.blocks-sandbox']);
const EXCLUDED_FILE_RE = /\.spec\.[cm]?[jt]sx?$/;

const WORKSPACE = required('WORKSPACE', '[judge]');
const TASK_PROMPT_PATH = required('TASK_PROMPT', '[judge]');
const BUILDER_RESULT = required('BUILDER_RESULT', '[judge]');
const EVIDENCE = parseJsonEnv('EVIDENCE');
const OUTPUT = required('OUTPUT', '[judge]');
const MODEL_ID = process.env.BENCH_JUDGE_MODEL ?? 'us.anthropic.claude-opus-4-8';

// Equal-weighted shared dimensions (prompts.ts COMMON_DIMENSIONS) — every task graded on the same
// rubric, no per-task dimension, no weights (they invite anchoring bias).
const DIMENSIONS = COMMON_DIMENSIONS;

// Each dimension is required in the structured output, 0-10; explanation is free text.
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

// Persist objective evidence + builder fields up front, BEFORE staging, so a staging failure can't
// roll result.json back to the step-0 zeros. mergeAndWrite is idempotent; later paths re-merge on top.
mergeAndWrite(builderResult, { ...EVIDENCE });

// Physical spec-blinding: stage a SOURCE-ONLY COPY and point the judge's Sandbox at it. The spec and
// everything that isn't agent source (deps, build output, .blocks-sandbox, *.spec.{js,ts,jsx,tsx,cjs,
// mjs}) is left OUT, so the judge is blinded by ABSENCE. The copy is disposable, so bash writes can't affect scoring.
const JUDGE_SRC = mkdtempSync(join(tmpdir(), 'bench-judge-src-'));

// `src` is an absolute path under WORKSPACE; excluded subtrees skipped, test-spec CODE files dropped.
function stageFilter(src: string): boolean {
	const rel = relative(WORKSPACE, src);
	if (rel === '') return true; // the root itself
	const parts = rel.split(sep);
	if (parts.some((seg) => STAGE_EXCLUDE_DIRS.has(seg))) return false;
	return !EXCLUDED_FILE_RE.test(parts[parts.length - 1] ?? '');
}
cpSync(WORKSPACE, JUDGE_SRC, { recursive: true, filter: stageFilter });

// Fail loudly if any spec or bench-tests leaked into the copy — an INDEPENDENT find, not the filter.
assertNoSpecLeak(JUDGE_SRC);

// Belt-and-suspenders: scrub $WORKSPACE from the env so nothing downstream can reach the non-blinded
// originals. WORKSPACE is only read above (stageFilter/cpSync), never after.
delete process.env.WORKSPACE;

function assertNoSpecLeak(dir: string): void {
	// INDEPENDENT re-check (a find, not the JS filter). The -regex MUST mirror EXCLUDED_FILE_RE:
	// only objective test-spec CODE files count, NOT framework *.spec.json (killed the judge on run
	// 28639226838). posix-extended -regex matches the whole path.
	const leaks = execSync(
		`find ${shellQuote(dir)} \\( -name bench-tests -o -regextype posix-extended -regex '.*\\.spec\\.[cm]?[jt]sx?$' \\) -print`,
		{ encoding: 'utf-8' },
	).trim();
	if (leaks) {
		process.stderr.write(`[judge] FATAL: objective spec / bench-tests leaked into the judge source copy:\n${leaks}\n`);
		process.exit(1);
	}
}

// Judge-call robustness against throttling under ~8 concurrent matrix cells: (1) SDK-layer adaptive
// retry (client-side rate limiter) absorbs a transient throttle inside one invoke(); (2) the invoke
// loop below re-invokes on a throttle/transient that still exhausts the SDK, with longer backoff. A
// fresh agent per attempt avoids a half-built conversation. Opus 4.8 REJECTS `temperature` — don't re-add it.
function makeJudgeAgent(): Agent {
	return new Agent({
		model: new BedrockModel({
			modelId: MODEL_ID,
			region: process.env.AWS_REGION ?? 'us-east-1',
			clientConfig: { maxAttempts: 8, retryMode: 'adaptive' },
		}),
		systemPrompt: JUDGE_SYSTEM,
		// Vended bash rooted at the spec-blinded copy (JUDGE_SRC); read-only grep use, disposable copy.
		sandbox: new WorkspaceSandbox(JUDGE_SRC),
		tools: [makeBash()],
	});
}

// Invoke-retry budget + throttle classifier + error describer are shared with the builder (see
// lib/bedrock-retry.ts). A StructuredOutputError is a real grading outcome and is never retried.

// Evidence is omitted from the prompt (the orchestrator applies objective caps after). blocks_fidelity
// input: a mechanical grep of the agent's source is ground truth for which @aws-blocks blocks were
// actually imported — an anti-gaming signal. Injected before the rubric/task sections.
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
for (let attempt = 1; attempt <= INVOKE_MAX_ATTEMPTS; attempt++) {
	attemptsUsed = attempt;
	try {
		// structuredOutputSchema is the recommended Strands pattern; on validation failure it throws
		// StructuredOutputError, which we record distinctly and never retry.
		result = await makeJudgeAgent().invoke(userText, { structuredOutputSchema: SCORE_SCHEMA });
		break;
	} catch (err) {
		lastErr = err;
		const retryable = isRetryableModelError(err);
		process.stderr.write(
			`[judge] agent.invoke attempt ${attempt}/${INVOKE_MAX_ATTEMPTS} failed (${retryable ? 'throttle/transient' : 'non-retryable'}): ${describeModelError(err)}\n`,
		);
		if (!retryable || attempt >= INVOKE_MAX_ATTEMPTS) break;
		const delayMs = nextBackoffMs(attempt);
		process.stderr.write(`[judge] backing off ${Math.round(delayMs / 1000)}s before attempt ${attempt + 1}\n`);
		await sleep(delayMs);
	}
}

if (!result) {
	// Record the failure honestly so the cell lands with a 0 judge term, not the step-0 baseline.
	// judge_error carries the deep cause-chain so the real AWS throttle class is visible next run.
	const isValidation = lastErr instanceof StructuredOutputError;
	mergeAndWrite(
		{},
		{
			judge_error: describeModelError(lastErr),
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

// Explicit success exit: the merged result.json is fully written. Without it, a stray handle left by
// a command the judge ran could keep Node's loop ref'd and idle the step until its timeout.
process.exit(0);

// Mechanically grep the workspace for @aws-blocks imports. Inner grep finds the scope; outer keeps
// only import/from/require lines. grep exits 1 (clean "none found") when nothing matches.
function collectBlocksImports(workspace: string): string {
	try {
		// --exclude-dir flags derive from STAGE_EXCLUDE_DIRS (one source of truth). Globs quoted so
		// the shell can't expand them before grep sees them.
		const excludeArgs = [...STAGE_EXCLUDE_DIRS].map((d) => `--exclude-dir=${d}`).join(' ');
		const out = execSync(
			`grep -rn "@aws-blocks/" . --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.mjs" --include="*.cjs" ${excludeArgs} | grep -Ew "import|from|require"`,
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

	// GITHUB_OUTPUT values can reach EVIDENCE as strings ("true"/"3") or as JSON bool/number — coerce both.
	const truthy = (v: unknown): boolean => v === true || v === 'true';
	const numOf = (v: unknown): number => {
		const n = Number(v);
		return Number.isFinite(n) ? n : 0;
	};
	const tt = numOf(ev.tests_total);
	const tp = numOf(ev.tests_passed);

	// Deterministic hard-cap plan (single-sourced in lib/scoring.mjs): which objective failure caps
	// which dimension, without stacking two fc caps for one root failure. See hardCapPlan's docs.
	const plan = hardCapPlan(ev);
	for (const { dimension, ceiling, reason } of plan.caps) cap(dimension, ceiling, reason);
	for (const n of plan.notes) notes.push(n);
	// Test pass-rate recorded for audit ONLY — it does NOT cap any dimension; the ratio drives the
	// composite headline in the summary step, keeping the qualitative score independent.
	if (tt > 0) {
		const ratio = Math.round((tp / tt) * 1000) / 1000;
		notes.push(`tests ${tp}/${tt} passed (ratio ${ratio}) — recorded for audit; not used to cap judge dimensions`);
	}
	// Playwright failing to install is infra, not the agent's fault — don't cap, but note the
	// functional dims went test-unverified so the score isn't over-trusted.
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
