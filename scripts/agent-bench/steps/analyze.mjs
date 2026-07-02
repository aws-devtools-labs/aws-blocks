// Step "Analyze low/regressed cells": a MINIMAL, BEST-EFFORT per-run diagnosis
// of ONLY the cells that struggled — those whose composite is LOW (< 50) or
// REGRESSED vs the S3 baseline (Δ < -5, the overview's ±5 noise band). Healthy
// (green) cells are never touched. For each struggling cell it reads that cell's
// uploaded trace.json + metrics.json (downloaded as bench-trace-* into
// TRACES_DIR), feeds a TRIMMED slice (tool/span names + error-like lines + the
// tail — never the whole trace) to the JUDGE Bedrock model, and asks for a 2-4
// sentence diagnosis that flags ONLY failed tool calls, missing-docs hunting, or
// non-inherent trial-and-error (never a restatement of the task). It appends a
// short "## Agent struggles" rollup to $GITHUB_STEP_SUMMARY (one bullet per
// analyzed cell) and writes an analysis.json artifact.
//
// ISOLATION CONTRACT — this step is purely additive and must NEVER affect the
// green-regardless bench:
//   - The whole run is wrapped so it can NEVER throw; on any failure it exits 0.
//   - Each cell (and each Bedrock call) is independently guarded, so one cell's
//     failure never blocks the others.
//   - With no struggling cells, or if Bedrock is unavailable (no creds /
//     permission / throttled out), it emits a benign note and still exits 0.
// It runs under bare `node` in the summary job, which does NOT `npm ci`, so it
// uses ONLY Node built-ins + the runner's AWS CLI (no SDK import) and the pure
// .mjs scoring/overview helpers. Bedrock is called via `aws bedrock-runtime
// converse` (the CLI cannot stream); model id + region + the throttle-retry
// pattern mirror steps/4-judge.ts.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composite, testRate, testStats } from './lib/scoring.mjs';
import { buildAggregate, diffAgainstBaseline } from './lib/overview.mjs';

const RESULTS_DIR = process.env.RESULTS_DIR ?? 'results';
const TRACES_DIR = process.env.TRACES_DIR ?? 'traces';
const BASELINE_PATH = process.env.BASELINE_PATH;
const ANALYSIS_PATH = process.env.ANALYSIS_PATH;
const MODEL_ID = process.env.BENCH_JUDGE_MODEL ?? 'us.anthropic.claude-opus-4-8';
const REGION = process.env.AWS_REGION ?? 'us-east-1';

// A composite (0..100) below this is "low" (matches the red band boundary in
// compositeBand). A drop of more than this many points vs the baseline is a
// "regression" — the same ±5 band the overview uses to separate a real move from
// N=1 model variance.
const LOW_THRESHOLD = 50;
const REGRESSION_DELTA = -5;
// Bound Bedrock spend/time: analyze at most this many struggling cells (worst
// composite first). A run with more than this many low cells is itself the
// signal; we don't need to diagnose every one.
const MAX_CELLS = 8;
const MAX_DIAGNOSIS_TOKENS = 400;

// Token trimming — keep the model input small. Caps on each slice of the trace.
const MAX_TOOL_NAMES = 40;
const MAX_ERROR_LINES = 40;
const MAX_ERROR_LINE_LEN = 200;
const MAX_TAIL_CHARS = 1500;

// Throttle/transient retry, mirrored from steps/4-judge.ts: initial try + up to
// 4 backed-off retries, ONLY on a throttle/transient class (never a hard
// AccessDenied/validation error, which fails fast).
const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [5_000, 15_000, 40_000, 90_000];
const TRANSIENT_RE =
	/throttl|toomanyrequests|serviceunavailable|service_unavailable|internalserver|internalfailure|modelstream|modeltimeout|requesttimeout|timeout|partialresult|503|429|500/i;

const compositeOf = (r) => composite(testRate(testStats(r)), typeof r.judge_score === 'number' ? r.judge_score : 0);

const JUDGE_SYSTEM = `You are analyzing why an AI coding agent STRUGGLED on a benchmark cell. From the tool-call trace and metrics provided, write a 2-4 sentence diagnosis that flags ONLY these, and only when the evidence actually shows them: (1) failed or errored tool calls — name the tool and the error; (2) time wasted hunting for missing or undocumented APIs/docs; (3) non-inherent trial-and-error — repeated retries or rewrites not intrinsic to the task. Do NOT restate or summarize the task. Do NOT propose fixes or grade the code. If the evidence shows none of these clearly, reply exactly: "No clear struggle signal in the trace." Be concrete and cite tool names or short error snippets.`;

// Block synchronously between retries (bare-node, no async loop to yield to).
function sleepSync(ms) {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms | 0));
	} catch {
		// SharedArrayBuffer unavailable — skip the backoff wait rather than fail.
	}
}

// One Bedrock Converse call via the AWS CLI. Returns { text } on success or
// { error } on failure — NEVER throws. Uses --cli-input-json (a file) so the
// trimmed trace text can't break shell quoting.
function bedrockConverse(userText) {
	let tmpDir;
	try {
		tmpDir = mkdtempSync(join(tmpdir(), 'bench-analyze-'));
	} catch (err) {
		return { error: `tmp dir failed: ${err?.message ?? err}` };
	}
	const inputPath = join(tmpDir, 'converse.json');
	try {
		writeFileSync(
			inputPath,
			JSON.stringify({
				modelId: MODEL_ID,
				system: [{ text: JUDGE_SYSTEM }],
				messages: [{ role: 'user', content: [{ text: userText }] }],
				// No temperature — the judge model (Opus 4.8) rejects it; determinism
				// isn't required for a best-effort diagnosis. maxTokens keeps it short.
				inferenceConfig: { maxTokens: MAX_DIAGNOSIS_TOKENS },
			}),
		);
	} catch (err) {
		return { error: `write input failed: ${err?.message ?? err}` };
	}

	let lastErr = 'unknown error';
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const res = spawnSync(
			'aws',
			['bedrock-runtime', 'converse', '--cli-input-json', `file://${inputPath}`, '--region', REGION, '--output', 'json'],
			{ encoding: 'utf-8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
		);
		if (res.status === 0 && res.stdout) {
			try {
				const parsed = JSON.parse(res.stdout);
				const text = (parsed?.output?.message?.content ?? [])
					.map((b) => (b && typeof b.text === 'string' ? b.text : ''))
					.filter(Boolean)
					.join('\n')
					.trim();
				if (text) return { text };
				lastErr = 'empty completion';
			} catch (err) {
				lastErr = `unparseable response: ${err?.message ?? err}`;
			}
		} else {
			const raw = (res.stderr || res.error?.message || `exit ${res.status}`).toString().trim();
			lastErr = raw.split('\n').slice(-3).join(' ').slice(0, 300);
		}
		if (!TRANSIENT_RE.test(lastErr) || attempt >= MAX_ATTEMPTS) break;
		const base = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
		sleepSync(base + Math.floor(Math.random() * base * 0.25));
	}
	return { error: lastErr };
}

// Read a JSON artifact for a cell (trace.json / metrics.json), or null if absent
// (a timed-out cell uploads no trace; if-no-files-found:ignore means no dir).
function readCellJson(task, template, file) {
	try {
		return JSON.parse(readFileSync(join(TRACES_DIR, `bench-trace-${task}-${template}`, file), 'utf-8'));
	} catch {
		return null;
	}
}

// Compact one-line-ish metrics summary: cycles, tokens, and per-tool call/error
// counts. Defensive about the exact toolUsage shape (Strands aggregate) — reads
// whatever call/error/success fields are present, else stringifies briefly.
function summarizeMetrics(metrics) {
	if (!metrics || typeof metrics !== 'object') return '(no metrics)';
	const parts = [];
	if (typeof metrics.cycleCount === 'number') parts.push(`cycles=${metrics.cycleCount}`);
	const usage = metrics.accumulatedUsage;
	if (usage && typeof usage === 'object') {
		parts.push(`tokens_in=${usage.inputTokens ?? '?'}`, `tokens_out=${usage.outputTokens ?? '?'}`);
	}
	const tu = metrics.toolUsage;
	if (tu && typeof tu === 'object') {
		const rows = [];
		for (const [name, v] of Object.entries(tu)) {
			if (!v || typeof v !== 'object') continue;
			const calls = v.callCount ?? v.calls ?? v.executionCount ?? v.count;
			const errors = v.errorCount ?? v.failedCount ?? v.errors ?? v.failures;
			const rate = typeof v.successRate === 'number' ? `${Math.round(v.successRate * 100)}%ok` : null;
			const bits = [calls !== undefined ? `calls=${calls}` : '', errors !== undefined ? `errors=${errors}` : '', rate]
				.filter(Boolean)
				.join(',');
			rows.push(bits ? `${name}(${bits})` : name);
		}
		if (rows.length) parts.push(`tools: ${rows.join(' ')}`);
	}
	return parts.length ? parts.join(' ') : '(metrics present, no recognizable fields)';
}

// Trim a trace into a small, model-friendly slice: distinct tool/span names,
// error-like lines, and the tail — never the whole tree. Works on the normalized
// (2-space) JSON string so it is line-oriented regardless of trace schema.
const ERROR_LINE_RE = /(error|failed|failure|denied|exception|timed?\s?out|timeout|not found|no such|cannot|refused|traceback|non-zero|exit code|enoent|econnreset)/i;

function trimTrace(trace) {
	let str;
	try {
		str = JSON.stringify(trace, null, 2);
	} catch {
		return { toolNames: [], errorLines: [], tail: '' };
	}
	if (typeof str !== 'string') return { toolNames: [], errorLines: [], tail: '' };
	const lines = str.split('\n');
	const names = new Set();
	const errorLines = [];
	for (const line of lines) {
		const m = line.match(/"name":\s*"([^"]+)"/);
		if (m && names.size < MAX_TOOL_NAMES) names.add(m[1]);
		if (errorLines.length < MAX_ERROR_LINES && ERROR_LINE_RE.test(line)) {
			errorLines.push(line.trim().slice(0, MAX_ERROR_LINE_LEN));
		}
	}
	return { toolNames: [...names], errorLines, tail: str.slice(-MAX_TAIL_CHARS) };
}

// Why this cell qualifies + a short marker for the bullet.
function reasonOf(row) {
	const low = row.current !== null && row.current < LOW_THRESHOLD;
	const regressed = row.delta !== null && row.delta < REGRESSION_DELTA;
	if (low && regressed) return { kind: 'both', label: `low (${row.current}) & regressed (Δ${row.delta})` };
	if (regressed) return { kind: 'regressed', label: `regressed Δ${row.delta} vs baseline ${fmt(row.baseline)}` };
	return { kind: 'low', label: `low (${row.current} < ${LOW_THRESHOLD})` };
}

const fmt = (n) => (n === null || n === undefined || Number.isNaN(n) ? '—' : n.toFixed(1));

function main() {
	// ── Load cells (one result.json per bench-result-* artifact dir) ──────────
	let dirs = [];
	try {
		dirs = readdirSync(RESULTS_DIR).filter((d) => d.startsWith('bench-result-'));
	} catch {
		return; // no results dir — nothing to analyze (mirrors summary.mjs)
	}
	const cells = [];
	for (const d of dirs) {
		try {
			cells.push(JSON.parse(readFileSync(join(RESULTS_DIR, d, 'result.json'), 'utf-8')));
		} catch {
			// unreadable cell — skip
		}
	}
	if (cells.length === 0) return;

	// ── Baseline diff (optional) → per-cell composite + delta ─────────────────
	let baseline = null;
	if (BASELINE_PATH) {
		try {
			baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
		} catch {
			baseline = null; // no baseline — regression check is simply skipped
		}
	}
	const diff = diffAgainstBaseline(buildAggregate(cells, {}), baseline);

	// ── Select struggling cells: low OR regressed, worst composite first ──────
	const candidates = diff.rows
		.filter((row) => row.current !== null && (row.current < LOW_THRESHOLD || (row.delta !== null && row.delta < REGRESSION_DELTA)))
		.sort((a, b) => (a.current ?? 0) - (b.current ?? 0));

	const heading = '## Agent struggles (low/regressed cells)';
	const outLines = [heading, ''];
	if (candidates.length === 0) {
		outLines.push('_No low or regressed cells this run — nothing to analyze._', '');
		emit(outLines);
		writeAnalysis({ analyzed: [], note: 'no low or regressed cells' });
		return;
	}
	outLines.push(
		`_Best-effort per-run diagnosis of only the ${candidates.length} low (< ${LOW_THRESHOLD}) or regressed (Δ < ${REGRESSION_DELTA}) cell(s), from each cell's tool-call trace. Green cells are not analyzed. Model: \`${MODEL_ID}\`._`,
		'',
	);

	const analyzed = [];
	const selected = candidates.slice(0, MAX_CELLS);
	for (const row of selected) {
		const rec = analyzeCell(row, cells);
		analyzed.push(rec);
		outLines.push(`- \`${rec.task}/${rec.template}\` (composite ${fmt(row.current)}, ${rec.reason_label}): ${rec.bullet}`);
	}
	if (candidates.length > selected.length) {
		outLines.push('', `_+${candidates.length - selected.length} more low/regressed cell(s) not analyzed (cap ${MAX_CELLS})._`);
	}
	outLines.push('');
	emit(outLines);
	writeAnalysis({ analyzed });
}

// Diagnose one cell. Reads its trace/metrics, calls Bedrock on a trimmed slice,
// and returns a record + the markdown bullet text. Never throws.
function analyzeCell(row, cells) {
	const task = row.task ?? '—';
	const template = row.template ?? '—';
	const cell = cells.find((c) => (c.task ?? '') === row.task && (c.template ?? '') === row.template) ?? {};
	const { kind, label } = reasonOf(row);
	const base = { task, template, composite: row.current, baseline: row.baseline, delta: row.delta, reason: kind, reason_label: label, klass: cell.klass ?? null };

	const trace = readCellJson(row.task, row.template, 'trace.json');
	const metrics = readCellJson(row.task, row.template, 'metrics.json');
	if (!trace && !metrics) {
		const bullet =
			cell.klass === 'agent_fail'
				? 'Agent timed out / produced no app within budget — no trace was emitted, so there is nothing to diagnose.'
				: 'No trace/metrics artifact available for this cell — skipped.';
		return { ...base, analyzed: false, bullet, diagnosis: null };
	}

	const { toolNames, errorLines, tail } = trace ? trimTrace(trace) : { toolNames: [], errorLines: [], tail: '' };
	const userText = [
		`Cell: ${task}/${template}`,
		`Composite this run: ${fmt(row.current)}/100 (${label})`,
		`Metrics: ${summarizeMetrics(metrics)}`,
		`Tool/span names seen: ${toolNames.length ? toolNames.join(', ') : '(none captured)'}`,
		'Error-like lines from trace:',
		errorLines.length ? errorLines.join('\n') : '(none)',
		'Trace tail:',
		tail || '(no trace tail)',
	].join('\n');

	const { text, error } = bedrockConverse(userText);
	if (error) {
		return { ...base, analyzed: false, error, bullet: `_(analysis unavailable: ${error})_`, diagnosis: null };
	}
	const diagnosis = text.replace(/\s+/g, ' ').trim();
	return { ...base, analyzed: true, bullet: diagnosis, diagnosis };
}

function emit(lines) {
	const md = `${lines.join('\n')}\n`;
	if (process.env.GITHUB_STEP_SUMMARY) {
		try {
			appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
		} catch (err) {
			process.stderr.write(`[analyze] failed to append step summary: ${err?.message ?? err}\n`);
			process.stdout.write(md);
		}
	} else {
		process.stdout.write(md);
	}
}

function writeAnalysis(extra) {
	if (!ANALYSIS_PATH) return;
	try {
		writeFileSync(
			ANALYSIS_PATH,
			`${JSON.stringify(
				{
					schema: 1,
					generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
					model: MODEL_ID,
					low_threshold: LOW_THRESHOLD,
					regression_delta: REGRESSION_DELTA,
					...extra,
				},
				null,
				2,
			)}\n`,
		);
	} catch (err) {
		process.stderr.write(`[analyze] failed to write analysis to ${ANALYSIS_PATH}: ${err?.message ?? err}\n`);
	}
}

// TOP-LEVEL ISOLATION: never throw, never non-zero. A struggle-analysis failure
// must never turn the summary job red or block the green-regardless bench.
try {
	main();
} catch (err) {
	process.stderr.write(`[analyze] best-effort analysis failed (ignored): ${err?.stack ?? err?.message ?? err}\n`);
}
process.exit(0);
