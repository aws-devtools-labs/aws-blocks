// Top-level ROLL-UP of the per-cell analyses. Runs ONCE in the summary job and is BOTTOM-UP: it
// consumes each cell's `analysis` string + `analysis_issues` array (written by analyze-cell.mjs). It
// appends three sections to $GITHUB_STEP_SUMMARY — Executive summary (one best-effort Bedrock call,
// Opus 4.8), ⚠️ Potential issues (deterministic flags + per-cell issues), Per-cell analysis
// (collapsed) — and writes bench-analysis.json. Additive: wrapped so it can NEVER fail the summary
// job (any error → benign note, exit 0). Runs under bare `node` (no npm ci): Node built-ins + AWS CLI
// (via lib/analysis.mjs, no SDK) + the pure scoring/overview helpers only.
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
import { compositeBand, verdictOf } from './lib/scoring.mjs';
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
		emit(['## Executive summary', '', '_No cell results to roll up._', '']);
		writeAnalysis({ executive_summary: null, potential_issues: [], cells: [], note: 'no cell results' });
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
			klass: c.klass ?? null,
			delta,
			low: composite !== null && composite < LOW_THRESHOLD,
			regressed: delta !== null && delta < REGRESSION_DELTA,
			analysis: c.analysis || null,
			issues: Array.isArray(c.analysis_issues) ? c.analysis_issues.filter((s) => typeof s === 'string' && s.trim()) : [],
		};
	});

	// ── Executive summary: ONE best-effort Bedrock synthesis over the analyses ─
	const execSummary = synthesize(aggregate, verdictCounts, rows);

	// ── Potential issues: deterministic flags + each cell's emitted issues ─────
	const potential = collectPotentialIssues(rows);

	// ── Render: Executive summary → Potential issues → collapsible per-cell ────
	const out = [];
	out.push('## Executive summary', '');
	out.push(execSummary.text, '');

	out.push('## ⚠️ Potential issues', '');
	if (potential.length === 0) {
		out.push('_None surfaced — no low or regressed cells, and no per-cell analysis flagged an issue._', '');
	} else {
		for (const line of potential) out.push(`- ${line}`);
		out.push('');
	}

	// Whole section collapsed; EACH cell also collapsed within it.
	out.push('## Per-cell analysis', '');
	out.push('<details>');
	out.push(
		`<summary>Per-cell analysis — ${rows.length} cell(s), generated in-cell right after each judge · model <code>${MODEL_ID}</code> (click to expand)</summary>`,
	);
	out.push('');
	for (const r of rows) {
		const band = typeof r.composite === 'number' ? compositeBand(r.composite) : '⚪';
		const flags = [r.low ? '🔴 low' : '', r.regressed ? `🔴 regressed Δ${fmt(r.delta)}` : ''].filter(Boolean).join(', ');
		const head = `${band} \`${r.task}/${r.template}\` — composite ${fmt(r.composite)} (${r.verdict})${flags ? ` [${flags}]` : ''}`;
		out.push('<details>');
		out.push(`<summary>${head}</summary>`);
		out.push('');
		out.push(`- ${r.analysis ?? '_no per-cell analysis_'}`);
		if (r.issues.length > 0) {
			out.push('- **Potential issues:**');
			for (const iss of r.issues) out.push(`  - ${iss}`);
		}
		out.push('');
		out.push('</details>');
		out.push('');
	}
	out.push('</details>', '');
	emit(out);

	writeAnalysis({
		mean_composite: aggregate.mean_composite ?? null,
		scored_cells: aggregate.scored_cells ?? 0,
		verdict_counts: verdictCounts,
		executive_summary: execSummary.text,
		executive_summary_error: execSummary.error ?? null,
		potential_issues: potential,
		cells: rows,
	});
}

// Deterministic "Potential issues": harness/agent failures + low/regressed composites first, then
// every per-cell issue, each attributed to its cell.
function collectPotentialIssues(rows) {
	const out = [];
	for (const r of rows) {
		const cell = `\`${r.task}/${r.template}\``;
		if (r.verdict === 'harness_error') {
			out.push(`🧰 ${cell} — harness error (no gradeable app; excluded from the mean)`);
			continue;
		}
		if (r.klass === 'agent_fail') {
			out.push(`🔴 ${cell} — agent produced no app within budget (scored composite 0)`);
			continue;
		}
		const flags = [];
		if (r.low) flags.push(`low composite ${fmt(r.composite)}`);
		if (r.regressed) flags.push(`regressed Δ${fmt(r.delta)} vs \`main\``);
		if (flags.length) out.push(`🔴 ${cell} — ${flags.join('; ')}`);
	}
	for (const r of rows) {
		if (r.issues.length === 0) continue;
		const cell = `\`${r.task}/${r.template}\``;
		for (const iss of r.issues) out.push(`${cell} — ${iss}`);
	}
	return out;
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
	// Keep the model's paragraph structure so it renders as prose, not run-on text.
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
					schema: 3,
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

// TOP-LEVEL ISOLATION: never throw, never non-zero — a roll-up failure must not turn the job red.
try {
	main();
} catch (err) {
	process.stderr.write(`[analyze] best-effort roll-up failed (ignored): ${err?.stack ?? err?.message ?? err}\n`);
}
process.exit(0);
