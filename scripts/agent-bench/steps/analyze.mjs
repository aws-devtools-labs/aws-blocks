// Top-level ROLL-UP of the per-cell analyses. This runs ONCE in the summary job
// and is BOTTOM-UP: it CONSUMES the `analysis` string each cell already wrote
// into its own result.json (steps/analyze-cell.mjs, right after that cell's
// judge) — it no longer re-reads raw traces centrally. It produces:
//   - an `## Executive summary` that SYNTHESIZES the per-cell analyses via ONE
//     Bedrock call (Opus 4.8) over the collected analyses + the run aggregate
//     (mean, verdict mix, low/regressed flags), and
//   - a per-cell one-liner list (cell → composite/verdict → its analysis),
// appended to $GITHUB_STEP_SUMMARY, plus a run-level bench-analysis.json
// artifact assembled from the per-cell analyses.
//
// The scoreboard table + PR-vs-baseline overview are rendered separately by
// steps/summary.mjs and are unchanged.
//
// ISOLATION CONTRACT — purely additive, must NEVER fail the summary job:
//   - The whole run is wrapped so it can NEVER throw; on any failure it exits 0.
//   - The executive-summary Bedrock call is best-effort: on any error (no creds /
//     permission / throttled out) it emits a benign note and still exits 0.
// It runs under bare `node` in the summary job, which does NOT `npm ci`, so it
// uses ONLY Node built-ins + the runner's AWS CLI (via lib/analysis.mjs, no SDK)
// and the pure .mjs scoring/overview helpers.
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	DEFAULT_MODEL_ID,
	LOW_THRESHOLD,
	REGRESSION_DELTA,
	ROLLUP_MAX_TOKENS,
	ROLLUP_SYSTEM,
	bedrockConverse,
	buildRollupUserText,
	fmt,
} from './lib/analysis.mjs';
import { verdictOf } from './lib/scoring.mjs';
import { buildAggregate, diffAgainstBaseline } from './lib/overview.mjs';

const RESULTS_DIR = process.env.RESULTS_DIR ?? 'results';
const BASELINE_PATH = process.env.BASELINE_PATH;
const ANALYSIS_PATH = process.env.ANALYSIS_PATH;
const MODEL_ID = process.env.BENCH_JUDGE_MODEL ?? DEFAULT_MODEL_ID;
const REGION = process.env.AWS_REGION ?? 'us-east-1';

function main() {
	// ── Load cells (one result.json per bench-result-* artifact dir) ──────────
	let dirs = [];
	try {
		dirs = readdirSync(RESULTS_DIR).filter((d) => d.startsWith('bench-result-'));
	} catch {
		return; // no results dir — nothing to roll up (mirrors summary.mjs)
	}
	const cells = [];
	for (const d of dirs) {
		try {
			cells.push(JSON.parse(readFileSync(join(RESULTS_DIR, d, 'result.json'), 'utf-8')));
		} catch {
			// unreadable cell — skip
		}
	}
	if (cells.length === 0) {
		emit(['## Agent analysis', '', '_No cell results to roll up._', '']);
		writeAnalysis({ executive_summary: null, cells: [], note: 'no cell results' });
		return;
	}

	// ── Baseline diff (optional) → per-cell composite + delta + flags ─────────
	let baseline = null;
	if (BASELINE_PATH) {
		try {
			baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
		} catch {
			baseline = null; // no baseline — regression flag is simply skipped
		}
	}
	const aggregate = buildAggregate(cells, {});
	const diff = diffAgainstBaseline(aggregate, baseline);
	const rowByKey = new Map(diff.rows.map((r) => [`${r.task ?? ''}/${r.template ?? ''}`, r]));

	// ── Assemble per-cell rows (consuming each cell's own `analysis`) ─────────
	const sorted = cells
		.filter((c) => !c.error)
		.sort((a, b) => `${a.task ?? ''}/${a.template ?? ''}`.localeCompare(`${b.task ?? ''}/${b.template ?? ''}`));
	const verdictCounts = {};
	const rows = sorted.map((c) => {
		const row = rowByKey.get(`${c.task ?? ''}/${c.template ?? ''}`);
		const composite = row && typeof row.current === 'number' ? row.current : null;
		const delta = row && typeof row.delta === 'number' ? row.delta : null;
		const verdict = verdictOf(c);
		verdictCounts[verdict] = (verdictCounts[verdict] ?? 0) + 1;
		return {
			task: c.task ?? '—',
			template: c.template ?? '—',
			composite,
			verdict,
			delta,
			low: composite !== null && composite < LOW_THRESHOLD,
			regressed: delta !== null && delta < REGRESSION_DELTA,
			analysis: c.analysis || null,
		};
	});

	// ── Executive summary: ONE best-effort Bedrock synthesis over the analyses ─
	const execSummary = synthesize(aggregate, verdictCounts, rows);

	// ── Render ────────────────────────────────────────────────────────────────
	const out = ['## Agent analysis', ''];
	out.push('### Executive summary', '');
	out.push(execSummary.text, '');
	out.push('### Per-cell analysis', '');
	out.push(`_Each cell's analysis was generated in-cell right after its judge. Model: \`${MODEL_ID}\`._`, '');
	for (const r of rows) {
		const flags = [r.low ? '🔴 low' : '', r.regressed ? `▼ regressed Δ${fmt(r.delta)}` : ''].filter(Boolean).join(', ');
		const head = `\`${r.task}/${r.template}\` — composite ${fmt(r.composite)} (${r.verdict})${flags ? ` [${flags}]` : ''}`;
		out.push(`- ${head}: ${r.analysis ?? '_no per-cell analysis_'}`);
	}
	out.push('');
	emit(out);

	writeAnalysis({
		mean_composite: aggregate.mean_composite ?? null,
		scored_cells: aggregate.scored_cells ?? 0,
		verdict_counts: verdictCounts,
		executive_summary: execSummary.text,
		executive_summary_error: execSummary.error ?? null,
		cells: rows,
	});
}

// One Bedrock call synthesizing the per-cell analyses into an executive summary.
// Best-effort: returns a benign note on any error. Never throws.
function synthesize(aggregate, verdictCounts, rows) {
	const userText = buildRollupUserText({
		meanComposite: aggregate.mean_composite ?? null,
		scoredCount: aggregate.scored_cells ?? 0,
		verdictCounts,
		cells: rows,
	});
	const { text, error } = bedrockConverse({
		system: ROLLUP_SYSTEM,
		userText,
		modelId: MODEL_ID,
		region: REGION,
		maxTokens: ROLLUP_MAX_TOKENS,
	});
	if (error) return { text: `_Executive summary unavailable: ${error}_`, error };
	// Keep the model's paragraph structure (don't collapse to one line) so the
	// executive summary renders as prose, not a wall of run-on text.
	const clean = text.trim();
	return clean ? { text: clean } : { text: '_Executive summary unavailable: empty completion_', error: 'empty completion' };
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
					schema: 2,
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

// TOP-LEVEL ISOLATION: never throw, never non-zero. A roll-up failure must never
// turn the summary job red or block the green-regardless bench.
try {
	main();
} catch (err) {
	process.stderr.write(`[analyze] best-effort roll-up failed (ignored): ${err?.stack ?? err?.message ?? err}\n`);
}
process.exit(0);
