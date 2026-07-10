// Unit tests for the analysis helpers (analysis.mjs) — the PURE pieces of the
// two-level, bottom-up analysis feature: per-cell trimming + prompt building,
// and the top-level roll-up prompt. These pin the trace-trimming caps and the
// prompt shapes so the LLM input stays small and the roll-up correctly consumes
// the per-cell `analysis` fields + low/regressed flags. Run under bare
// `node --test` (no build step): plain .mjs, same as the module under test. The
// Bedrock call (bedrockConverse) is I/O and intentionally NOT exercised here.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	LOW_THRESHOLD,
	MAX_ERROR_LINES,
	MAX_TAIL_CHARS,
	MAX_TOOL_NAMES,
	REGRESSION_DELTA,
	buildCellUserText,
	buildRollupUserText,
	oneLine,
	summarizeMetrics,
	trimTrace,
} from './analysis.mjs';

describe('constants', () => {
	it('flag thresholds match the overview ±5 band', () => {
		assert.equal(LOW_THRESHOLD, 50);
		assert.equal(REGRESSION_DELTA, -5);
	});
});

describe('oneLine(text)', () => {
	it('collapses whitespace and trims', () => {
		assert.equal(oneLine('  a\n\n b   c \t'), 'a b c');
	});
	it('returns empty string for non-strings', () => {
		assert.equal(oneLine(undefined), '');
		assert.equal(oneLine(null), '');
		assert.equal(oneLine(42), '');
	});
});

describe('trimTrace(trace)', () => {
	it('collects distinct tool/span names, error lines, and a bounded tail', () => {
		const trace = [
			{ name: 'bash', children: [{ name: 'fileEditor' }] },
			{ name: 'bash', note: 'command failed with exit code 1' },
			{ name: 'httpRequest', note: 'ECONNRESET while fetching' },
		];
		const { toolNames, errorLines, tail } = trimTrace(trace);
		assert.ok(toolNames.includes('bash'));
		assert.ok(toolNames.includes('fileEditor'));
		assert.ok(toolNames.includes('httpRequest'));
		// "bash" appears twice in the trace but is de-duped.
		assert.equal(new Set(toolNames).size, toolNames.length);
		assert.ok(errorLines.some((l) => /exit code 1/.test(l)));
		assert.ok(errorLines.some((l) => /ECONNRESET/.test(l)));
		assert.ok(tail.length <= MAX_TAIL_CHARS);
	});

	it('caps tool names and error lines to keep the model input small', () => {
		const nodes = [];
		for (let i = 0; i < 200; i++) nodes.push({ name: `tool_${i}`, note: `error number ${i} failed` });
		const { toolNames, errorLines } = trimTrace(nodes);
		assert.ok(toolNames.length <= MAX_TOOL_NAMES);
		assert.ok(errorLines.length <= MAX_ERROR_LINES);
	});

	it('is defensive: null trace or a circular structure never throws', () => {
		assert.deepEqual(trimTrace(null), { toolNames: [], errorLines: [], tail: '' });
		const circular = {};
		circular.self = circular;
		const out = trimTrace(circular);
		assert.deepEqual(out, { toolNames: [], errorLines: [], tail: '' });
	});
});

describe('summarizeMetrics(metrics)', () => {
	it('summarizes cycles, tokens, and per-tool call/error counts', () => {
		const s = summarizeMetrics({
			cycleCount: 12,
			accumulatedUsage: { inputTokens: 1000, outputTokens: 500 },
			toolUsage: {
				bash: { callCount: 8, errorCount: 3, successRate: 0.625 },
				fileEditor: { callCount: 4, errorCount: 0 },
			},
		});
		assert.match(s, /cycles=12/);
		assert.match(s, /tokens_in=1000/);
		assert.match(s, /tokens_out=500/);
		assert.match(s, /bash\(calls=8,errors=3,63%ok\)/);
		assert.match(s, /fileEditor\(calls=4,errors=0\)/);
	});

	it('accepts the alternate toolMetrics key and totalTime', () => {
		const s = summarizeMetrics({ toolMetrics: { bash: { calls: 2, errors: 1, totalTime: 1500 } } });
		assert.match(s, /bash\(calls=2,errors=1,1500ms\)/);
	});

	it('is defensive about missing / non-object metrics', () => {
		assert.equal(summarizeMetrics(null), '(no metrics)');
		assert.equal(summarizeMetrics(42), '(no metrics)');
		assert.equal(summarizeMetrics({}), '(metrics present, no recognizable fields)');
	});
});

describe('buildCellUserText(input)', () => {
	it('includes score context, trimmed judge notes, metrics, and trace slices', () => {
		const text = buildCellUserText({
			task: 'auth-notes',
			template: 'demo',
			composite: 92,
			verdict: 'pass',
			judgeScore: 8,
			judgeExplanation: 'The agent built a working notes app with AuthBasic and KVStore.',
			klass: null,
			metrics: { cycleCount: 5, toolUsage: { bash: { callCount: 3, errorCount: 0 } } },
			trace: [{ name: 'bash', note: 'all good' }],
		});
		assert.match(text, /Cell: auth-notes\/demo/);
		assert.match(text, /composite 92\.0\/100/);
		assert.match(text, /verdict pass/);
		assert.match(text, /judge 8\/10/);
		assert.match(text, /notes app with AuthBasic/);
		assert.match(text, /cycles=5/);
		assert.match(text, /Tool\/span names seen: bash/);
	});

	it('degrades cleanly with no trace / no metrics / no judge notes', () => {
		const text = buildCellUserText({ task: 't', template: 'x' });
		assert.match(text, /Score context: \(none\)/);
		assert.match(text, /Judge notes: \(none\)/);
		assert.match(text, /Metrics: \(no metrics\)/);
		assert.match(text, /\(none captured\)/);
		assert.match(text, /\(no trace tail\)/);
	});

	it('trims an over-long judge explanation', () => {
		const long = 'x'.repeat(5000);
		const text = buildCellUserText({ task: 't', template: 'x', judgeExplanation: long });
		const noteLine = text.split('\n').find((l) => l.startsWith('Judge notes'));
		assert.ok(noteLine.length < 700, `judge notes line should be trimmed, got ${noteLine.length}`);
	});
});

describe('buildRollupUserText(input)', () => {
	const rows = [
		{ task: 'auth-notes', template: 'demo', composite: 92, verdict: 'pass', delta: 3, low: false, regressed: false, analysis: 'Clean run — no notable struggle.' },
		{ task: 'file-gallery', template: 'bare', composite: 40, verdict: 'partial', delta: -12, low: true, regressed: true, analysis: 'Struggled with FileBucket API; repeated fileEditor errors.' },
		{ task: 'sql-kb', template: 'nextjs', composite: null, verdict: 'fail', delta: null, low: false, regressed: false, analysis: null },
	];

	it('lists every cell with its composite, verdict, flags, and analysis', () => {
		const text = buildRollupUserText({ meanComposite: 66, scoredCount: 2, verdictCounts: { pass: 1, partial: 1, fail: 1 }, cells: rows });
		assert.match(text, /mean composite 66\.0\/100 over 2 scored cell/);
		assert.match(text, /1 pass, 1 partial, 1 fail/);
		assert.match(text, /auth-notes\/demo — composite 92\.0 \(pass\): Clean run/);
		assert.match(text, /file-gallery\/bare — composite 40\.0 \(partial\) \[LOW REGRESSED Δ-12\.0\]/);
		// a cell with no analysis is surfaced, not dropped
		assert.match(text, /sql-kb\/nextjs — composite — \(fail\): \(no per-cell analysis\)/);
	});

	it('summarizes the flagged low / regressed cells', () => {
		const text = buildRollupUserText({ meanComposite: 66, scoredCount: 2, cells: rows });
		assert.match(text, /Cells flagged low \(< 50\): file-gallery\/bare/);
		assert.match(text, /Cells flagged regressed \(Δ < -5 vs baseline\): file-gallery\/bare/);
	});

	it('handles an empty run', () => {
		const text = buildRollupUserText({ meanComposite: null, scoredCount: 0, cells: [] });
		assert.match(text, /mean composite —\/100 over 0 scored cell/);
		assert.match(text, /\(no per-cell analyses available\)/);
		assert.match(text, /\(none\)/);
	});
});
