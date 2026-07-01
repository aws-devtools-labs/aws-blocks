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
import { execSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
	Agent,
	type AgentResult,
	BedrockModel,
	ContextWindowOverflowError,
	type ExecuteOptions,
	type ExecutionResult,
	MaxTokensError,
	ModelError,
	ModelThrottledError,
	PosixShellSandbox,
	SandboxAbortError,
	SandboxTimeoutError,
	type StreamChunk,
	StructuredOutputError,
} from '@strands-agents/sdk';
import { makeBash } from '@strands-agents/sdk/vended-tools/bash';
import { z } from 'zod';
import { COMMON_DIMENSIONS, JUDGE_SYSTEM, judgeRubric } from '../prompts.ts';
import { buildCapDecision } from './lib/scoring.mjs';

// Physical spec-blinding: the judge grades a SOURCE-ONLY COPY of the workspace
// (staged below into JUDGE_SRC) with these excluded, so the objective test can't
// anchor the score — blinding is by ABSENCE, robust against any cat/grep/find.
//   - IGNORED_DIRS: dependencies + build output + the copied objective spec dir.
//     `bench-tests/` holds the Playwright spec copied in by step 3.
//   - `.blocks-sandbox`: a build-time source-artifact dir, never the agent's work.
//   - EXCLUDED_FILE_RE: any *.spec.* the agent (or step 3) left in the tree.
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'bench-tests']);
const EXCLUDED_FILE_RE = /\.spec\.[cm]?[jt]sx?$/;
const STAGE_EXCLUDE_DIRS = new Set([...IGNORED_DIRS, '.blocks-sandbox']);

const WORKSPACE = required('WORKSPACE');
const TASK_PROMPT_PATH = required('TASK_PROMPT');
const BUILDER_RESULT = required('BUILDER_RESULT');
const EVIDENCE = parseJsonEnv('EVIDENCE');
const OUTPUT = required('OUTPUT');
const MODEL_ID = process.env.BENCH_JUDGE_MODEL ?? 'us.anthropic.claude-opus-4-8';

// Equal-weighted dimensions: the fixed shared set (prompts.ts
// COMMON_DIMENSIONS) — every task is graded on the same uniform rubric, with no
// per-task dimension. Listing them in one place keeps the cap logic and the
// average honest. (We deliberately avoid weights — they invite anchoring bias
// and are hard to justify scientifically.)
const TASK_DIR = dirname(TASK_PROMPT_PATH);
const DIMENSIONS: string[] = [...COMMON_DIMENSIONS];

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

// Physical spec-blinding: stage a SOURCE-ONLY COPY of the workspace and point
// the judge's Sandbox at it. The objective test spec and everything that isn't
// the agent's source (deps, build output, .blocks-sandbox, any *.spec.*) is left
// OUT of the copy, so the judge is blinded by ABSENCE — no cat/grep/find can
// reach a spec that physically isn't there. The copy is disposable, so the
// vended bash's write ability can't affect scoring.
const JUDGE_SRC = mkdtempSync(join(tmpdir(), 'bench-judge-src-'));

// cpSync filter: copy everything except the excluded dirs (skipped whole-subtree)
// and any *.spec.* file. `src` is an absolute path under WORKSPACE.
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
	const leaks = execSync(`find ${shellQuote(dir)} \\( -name '*.spec.*' -o -name bench-tests \\) -print`, {
		encoding: 'utf-8',
	}).trim();
	if (leaks) {
		process.stderr.write(`[judge] FATAL: objective spec / bench-tests leaked into the judge source copy:\n${leaks}\n`);
		process.exit(1);
	}
}

// Host-execution Sandbox rooted at a fixed directory (the judge's source-only
// copy). The vended bash tool routes every command through the agent's Sandbox,
// so the judge's shell cwd is the copy root — it reads/greps source there and can
// never reach the excluded spec. PosixShellSandbox implements file ops on top of
// executeStreaming, so rooting the shell roots everything. minTimeoutSec defaults
// to 0, so the vended bash's own 120s per-command default stands — ample for a
// judge that only reads/greps.
class WorkspaceSandbox extends PosixShellSandbox {
	constructor(
		private readonly root: string,
		private readonly minTimeoutSec = 0,
	) {
		super();
	}

	async *executeStreaming(
		command: string,
		options?: ExecuteOptions,
	): AsyncGenerator<StreamChunk | ExecutionResult, void, undefined> {
		const cwd = options?.cwd ?? this.root;
		const timeout = options?.timeout === undefined ? undefined : Math.max(options.timeout, this.minTimeoutSec);
		const result = await runShell(command, cwd, timeout, options?.signal, options?.env);
		if (result.stdout) yield { type: 'streamChunk', data: result.stdout, streamType: 'stdout' };
		if (result.stderr) yield { type: 'streamChunk', data: result.stderr, streamType: 'stderr' };
		yield result;
	}
}

// Bounded grace (ms) between the direct bash process exiting and force-resolving
// the shell result — see runShell. Only fires if a backgrounded grandchild
// escaped the process group and still holds the inherited pipes open.
const EXIT_DRAIN_GRACE_MS = 2000;

// Run one command through a POSIX shell rooted at `cwd`, buffering output and
// resolving the final ExecutionResult. Throws the SDK's SandboxTimeoutError /
// SandboxAbortError so the vended bash surfaces a timeout as BashTimeoutError.
//
// Backgrounded-process containment (the post-invoke-hang fix, shared with the
// builder step): the graded command may background a process. Two safeguards
// keep that from wedging the harness:
//   1. Spawn `detached: true` so bash leads its OWN process group (pgid == pid);
//      a `&` child stays in that group, so a negative-pid signal reaps the tree.
//   2. Resolve on 'close' (all stdio drained to EOF) so the buffered stdout is
//      COMPLETE — the vended fileEditor / PosixShellSandbox reads files via
//      `base64 < file` and decodes result.stdout, so a truncated capture would
//      corrupt reads. But 'close' alone BLOCKS for the full timeout when a
//      backgrounded child inherits the stdout/stderr pipes (their write-ends
//      never close). So the moment BASH ITSELF exits we SIGKILL the process
//      group: that reaps the child and closes the leaked FDs, letting 'close'
//      fire promptly with the foreground output intact. A bounded post-exit
//      grace (EXIT_DRAIN_GRACE_MS) resolves anyway if a child escaped the group
//      (e.g. via `setsid`) and still holds the pipes, so we never hang.
function runShell(
	command: string,
	cwd: string,
	timeoutSec: number | undefined,
	signal: AbortSignal | undefined,
	env: Record<string, string> | undefined,
): Promise<ExecutionResult> {
	return new Promise<ExecutionResult>((resolve, reject) => {
		const proc = spawn('bash', ['-c', `cd ${shellQuote(cwd)} && ${command}`], {
			env: env ? { ...process.env, ...env } : process.env,
			detached: true,
		});
		let stdout = '';
		let stderr = '';
		let settled = false;
		let exited = false;
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		let drainHandle: ReturnType<typeof setTimeout> | undefined;

		// SIGKILL the whole process group (negative pid). This reaps any process
		// the command backgrounded — whose inherited stdout/stderr pipe write-ends
		// are exactly what keeps 'close' from firing (blocking the tool call for
		// the full timeout) and holds libuv's loop open so Node never exits after
		// invoke() returns. Guarded: pid is undefined if spawn failed, and the
		// group may already be gone (ESRCH).
		const killGroup = (): void => {
			if (proc.pid === undefined) return;
			try {
				process.kill(-proc.pid, 'SIGKILL');
			} catch {
				// group already reaped — nothing to do
			}
		};

		const settle = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (drainHandle) clearTimeout(drainHandle);
			if (signal) signal.removeEventListener('abort', onAbort);
			killGroup();
			fn();
		};
		const resolveResult = (code: number | null, sig: NodeJS.Signals | null): void =>
			settle(() =>
				resolve({ type: 'executionResult', exitCode: code ?? (sig ? 128 : 1), stdout, stderr, outputFiles: [] }),
			);
		const terminate = (err: Error): void => settle(() => reject(err));
		const onAbort = (): void => terminate(new SandboxAbortError());

		proc.stdout?.on('data', (d) => {
			stdout += String(d);
		});
		proc.stderr?.on('data', (d) => {
			stderr += String(d);
		});
		proc.on('error', (err) => settle(() => reject(err)));
		// The direct bash process has terminated (its foreground pipeline is done);
		// only `&`-backgrounded children can still be alive. Reap the group so their
		// leaked pipe FDs close and 'close' can fire, and arm the grace fallback for
		// a child that escaped the group.
		proc.on('exit', (code, sig) => {
			if (settled || exited) return;
			exited = true;
			killGroup();
			drainHandle = setTimeout(() => resolveResult(code, sig), EXIT_DRAIN_GRACE_MS);
			drainHandle.unref();
		});
		proc.on('close', (code, sig) => resolveResult(code, sig));

		if (timeoutSec !== undefined) {
			timeoutHandle = setTimeout(() => terminate(new SandboxTimeoutError(timeoutSec)), timeoutSec * 1000);
		}
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener('abort', onAbort, { once: true });
		}
	});
}

// Single-quote a path for safe interpolation into a shell command.
function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
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
function makeJudgeAgent(): Agent {
	return new Agent({
		model: new BedrockModel({
			modelId: MODEL_ID,
			region: process.env.AWS_REGION ?? 'us-east-1',
			// Opus 4.8 (judge) rejects `temperature`; determinism rests on the structured-output schema + deterministic hard caps. Do not re-add. (Builder/Sonnet 4.6 still pins temperature=0.)
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
// blocks_fidelity inputs (deterministic): tasks/<task>/blocks.md (when present)
// lists the @aws-blocks Building Blocks the task requires, and a mechanical grep
// of the agent's own source is ground truth for which blocks were actually
// imported — so a block that was never imported can't slip past the judge (the
// score-0 case). Both are injected before the rubric/task sections.
const requiredBlocks = loadRequiredBlocks(TASK_DIR);
const blocksImports = collectBlocksImports(JUDGE_SRC);
const judgeSections: string[] = [];
if (requiredBlocks) {
	judgeSections.push(
		`<required-blocks>\nThe task requires the following @aws-blocks Building Block(s) (one per line, with the key method to expect). For the blocks_fidelity dimension, score 0 for any required block whose type is never imported in <imports> below.\n\n${requiredBlocks}\n</required-blocks>`,
	);
}
judgeSections.push(
	`<imports>\nMechanical grep of the agent's workspace source for @aws-blocks imports (node_modules/.git/dist/bench-tests excluded) — ground truth for which blocks were actually imported:\n\n${blocksImports}\n</imports>`,
);
judgeSections.push(`<rubric>\n${judgeRubric()}\n</rubric>`);
judgeSections.push(`<task>\n${taskPrompt}\n</task>`);
const userText = `${judgeSections.join('\n\n')}\n\nInspect the workspace and score it.`;

// Persist the objective evidence (and builder fields) up front so a judge
// crash — caught below, or hard-killed by OOM / the step timeout — can't roll
// result.json back to the step-0 baseline. mergeAndWrite is idempotent; the
// success and error paths re-merge on top of this.
mergeAndWrite(builderResult, { ...EVIDENCE });

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
		const delayMs = base + Math.floor(Math.random() * base * 0.25); // exponential base + up to 25% jitter
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

// Apply hard caps mechanically. Raw scores kept alongside the capped scores
// so we can audit how often caps fire.
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

function loadRequiredBlocks(taskDir: string): string | null {
	try {
		const content = readFileSync(resolve(taskDir, 'blocks.md'), 'utf-8').trim();
		return content || null;
	} catch {
		// No blocks.md for this task — the <required-blocks> section is omitted.
		return null;
	}
}

// Mechanically grep the (read-only) workspace for @aws-blocks imports. The inner
// grep finds every line mentioning the scope; the outer grep keeps only genuine
// import/from/require lines, so scaffold comments that merely reference a path
// don't read as imports. grep exits 1 (no error, no output) when nothing matches
// — that clean "none found" is the enforce-able score-0 signal for the judge.
function collectBlocksImports(workspace: string): string {
	try {
		const out = execSync(
			'grep -rn "@aws-blocks/" . --include=*.ts --include=*.tsx --include=*.js --include=*.jsx --include=*.mjs --include=*.cjs --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=.blocks-sandbox --exclude-dir=bench-tests | grep -Ew "import|from|require"',
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
	// so the caps fire either way.
	const truthy = (v: unknown): boolean => v === true || v === 'true';
	const numOf = (v: unknown): number => {
		const n = Number(v);
		return Number.isFinite(n) ? n : 0;
	};
	const devOk = truthy(ev.dev_server_started);
	const tt = numOf(ev.tests_total);
	const tp = numOf(ev.tests_passed);

	// Build cap fires ONLY on a REAL build failure — a `build` script existed and
	// exited non-zero (e.g. file-gallery's `tsc` type errors). Templates that ship
	// no `build` script report build_status="na" (NOT a failure) and must not be
	// capped: an absent script wrongly read as build_succeeded=false is what
	// unfairly capped observability-api to 3 despite 18/18 tests. The tri-state
	// interpretation lives in scoring.mjs so this stays the single source of truth.
	const build = buildCapDecision(ev);
	if (build.cap) cap('functional_completeness', 3, 'build failed');
	if (build.note) notes.push(build.note);
	if (!devOk) {
		cap('functional_completeness', 2, 'dev server not started');
		cap('selector_contract', 2, 'dev server not started');
	}
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

function describeError(err: unknown): string {
	const e = err as { name?: string; message?: string };
	return [e?.name, e?.message].filter(Boolean).join(': ') || String(err);
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
			const msg = typeof n.message === 'string' ? n.message : safeJson(n.message);
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

function safeJson(v: unknown): string {
	try {
		return JSON.stringify(v) ?? String(v);
	} catch {
		return String(v);
	}
}

function parseJsonEnv(name: string): Record<string, unknown> {
	const raw = required(name);
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch (err) {
		process.stderr.write(`[judge] env var ${name} is malformed JSON: ${describeError(err)}\n`);
		process.stderr.write(`[judge]   raw: ${raw.slice(0, 500)}\n`);
		process.exit(1);
	}
}

function required(name: string): string {
	const v = process.env[name];
	if (!v) {
		process.stderr.write(`[judge] missing env var ${name}\n`);
		process.exit(1);
	}
	return v;
}
