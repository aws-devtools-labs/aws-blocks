// Unit tests for the PURE analysis helpers (analysis.mjs): trace trimming caps + prompt building for
// the per-cell and roll-up prompts. Run under bare `node --test`. bedrockConverse (I/O) is not exercised.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	LOW_THRESHOLD,
	MAX_CELL_ISSUES,
	MAX_ERROR_LINES,
	MAX_FAILING_TESTS,
	MAX_FAILURE_ERR_LEN,
	MAX_FAILURE_TITLES,
	MAX_FAILURE_TITLE_LEN,
	MAX_ISSUE_LEN,
	MAX_TAIL_CHARS,
	MAX_TOOL_NAMES,
	NO_TRACE_ANALYSIS,
	REGRESSION_DELTA,
	buildCellUserText,
	buildFailureUserText,
	buildRollupUserText,
	deterministicCellAnalysis,
	extractFailingTests,
	isFailureCell,
	oneLine,
	parseCellAnalysis,
	parseFailureAnalysis,
	redactSecrets,
	summarizeMetrics,
	trimTrace,
	truthy,
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

describe('parseCellAnalysis(text)', () => {
	it('splits the ANALYSIS + ISSUES contract into a one-line analysis and bullet issues', () => {
		const raw = [
			'ANALYSIS: Built a working notes app with AuthBasic + KVStore; clean pass.',
			'A couple of bash retries early on.',
			'ISSUES:',
			'- Repeated fileEditor errors before finding the KVStore API',
			'- Dev server took 3 restarts to bind a port',
		].join('\n');
		const { analysis, issues } = parseCellAnalysis(raw);
		assert.equal(analysis, 'Built a working notes app with AuthBasic + KVStore; clean pass. A couple of bash retries early on.');
		assert.deepEqual(issues, [
			'Repeated fileEditor errors before finding the KVStore API',
			'Dev server took 3 restarts to bind a port',
		]);
	});

	it('treats "ISSUES: none" as no issues and strips the ANALYSIS label', () => {
		const { analysis, issues } = parseCellAnalysis('ANALYSIS: Clean run — no notable struggle.\nISSUES: none');
		assert.equal(analysis, 'Clean run — no notable struggle.');
		assert.deepEqual(issues, []);
	});

	it('returns the whole text as analysis when there is no ISSUES section', () => {
		const { analysis, issues } = parseCellAnalysis('Agent timed out — no trace to analyze.');
		assert.equal(analysis, 'Agent timed out — no trace to analyze.');
		assert.deepEqual(issues, []);
	});

	it('caps the issue count and the per-issue length', () => {
		const many = ['ANALYSIS: x', 'ISSUES:'];
		for (let i = 0; i < 20; i++) many.push(`- issue ${i} ${'y'.repeat(500)}`);
		const { issues } = parseCellAnalysis(many.join('\n'));
		assert.equal(issues.length, MAX_CELL_ISSUES);
		for (const iss of issues) assert.ok(iss.length <= MAX_ISSUE_LEN);
	});

	it('is defensive about non-strings and empty issue lists', () => {
		assert.deepEqual(parseCellAnalysis(null), { analysis: '', issues: [] });
		assert.deepEqual(parseCellAnalysis(42), { analysis: '', issues: [] });
		const { analysis, issues } = parseCellAnalysis('ANALYSIS: only analysis, blank issues.\nISSUES:\n\n');
		assert.equal(analysis, 'only analysis, blank issues.');
		assert.deepEqual(issues, []);
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

describe('isFailureCell(result)', () => {
	it('triggers on a fail verdict', () => {
		assert.equal(isFailureCell({ verdict: 'fail' }), true);
	});
	it('triggers on an agent_fail klass', () => {
		assert.equal(isFailureCell({ verdict: 'partial', klass: 'agent_fail' }), true);
	});
	it('triggers on any failed test', () => {
		assert.equal(isFailureCell({ verdict: 'partial', tests_failed: 1 }), true);
	});
	it('triggers when the dev-server did not start', () => {
		assert.equal(isFailureCell({ verdict: 'pass', dev_server_started: false }), true);
	});
	it('triggers when the build failed', () => {
		assert.equal(isFailureCell({ verdict: 'pass', build_succeeded: false }), true);
	});
	it('triggers on STRING "false" flags (GITHUB_OUTPUT bools arrive as strings)', () => {
		assert.equal(isFailureCell({ verdict: 'pass', dev_server_started: 'false' }), true);
		assert.equal(isFailureCell({ verdict: 'pass', build_succeeded: 'false' }), true);
	});
	it('does NOT trigger on STRING "true" flags', () => {
		assert.equal(isFailureCell({ verdict: 'pass', klass: null, tests_failed: 0, dev_server_started: 'true', build_succeeded: 'true' }), false);
	});
	it('does NOT trigger on a clean pass', () => {
		assert.equal(isFailureCell({ verdict: 'pass', klass: null, tests_failed: 0, dev_server_started: true, build_succeeded: true }), false);
	});
	it('does NOT trigger on a partial with all-green tests', () => {
		assert.equal(isFailureCell({ verdict: 'partial', tests_failed: 0, dev_server_started: true, build_succeeded: true }), false);
	});
	it('is null-safe', () => {
		assert.equal(isFailureCell(null), false);
		assert.equal(isFailureCell(undefined), false);
		assert.equal(isFailureCell('nope'), false);
		assert.equal(isFailureCell(42), false);
	});
});

describe('truthy(v)', () => {
	it('is true only for boolean true or the string "true"', () => {
		assert.equal(truthy(true), true);
		assert.equal(truthy('true'), true);
	});
	it('is false for false, "false", and every other value', () => {
		assert.equal(truthy(false), false);
		assert.equal(truthy('false'), false);
		assert.equal(truthy(undefined), false);
		assert.equal(truthy(null), false);
		assert.equal(truthy(0), false);
		assert.equal(truthy(1), false);
		assert.equal(truthy('TRUE'), false);
	});
});

describe('redactSecrets(text)', () => {
	it('scrubs KEY=value credential pairs, keeping the key name', () => {
		const t = [
			'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
			'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
			'AWS_SESSION_TOKEN=FwoGZXIvYXdzEabcDEF1234567890',
			'GITHUB_TOKEN=ghp_0123456789abcdefABCDEF0123456789',
		].join('\n');
		const out = redactSecrets(t);
		assert.match(out, /AWS_ACCESS_KEY_ID=\*\*\*REDACTED\*\*\*/);
		assert.match(out, /AWS_SECRET_ACCESS_KEY=\*\*\*REDACTED\*\*\*/);
		assert.match(out, /AWS_SESSION_TOKEN=\*\*\*REDACTED\*\*\*/);
		assert.match(out, /GITHUB_TOKEN=\*\*\*REDACTED\*\*\*/);
		assert.doesNotMatch(out, /AKIAIOSFODNN7EXAMPLE/);
		assert.doesNotMatch(out, /wJalrXUtnFEMI/);
		assert.doesNotMatch(out, /ghp_0123456789/);
	});
	it('scrubs a bare AWS access-key id', () => {
		const out = redactSecrets('token is AKIAIOSFODNN7EXAMPLE here');
		assert.match(out, /\*\*\*REDACTED-AWS-KEY-ID\*\*\*/);
		assert.doesNotMatch(out, /AKIAIOSFODNN7EXAMPLE/);
	});
	it('scrubs a bare GitHub token', () => {
		const out = redactSecrets('using ghp_0123456789abcdefABCDEF0123456789 now');
		assert.match(out, /\*\*\*REDACTED-GH-TOKEN\*\*\*/);
		assert.doesNotMatch(out, /ghp_0123456789/);
	});
	it('leaves ordinary text untouched', () => {
		const clean = 'build failed: cannot find module ./foo at line 42';
		assert.equal(redactSecrets(clean), clean);
	});
	it('is non-string-safe (returns empty string)', () => {
		assert.equal(redactSecrets(null), '');
		assert.equal(redactSecrets(undefined), '');
		assert.equal(redactSecrets(42), '');
	});
});

describe('extractFailingTests(pwResults)', () => {
	// Build a Playwright JSON report with `n` specs that all fail with the SAME error, plus optional extras.
	function pwReport(specs) {
		return { suites: [{ title: 'auth', specs }] };
	}
	function failSpec(title, message) {
		return { title, ok: false, tests: [{ results: [{ status: 'unexpected', error: { message } }] }] };
	}
	function passSpec(title) {
		return { title, ok: true, tests: [{ results: [{ status: 'passed' }] }] };
	}

	it('dedupes N identical errors into ONE group with the right count', () => {
		const specs = [];
		for (let i = 0; i < 11; i++) specs.push(failSpec(`shows username ${i}`, "getByTestId('auth-username') not visible"));
		const out = extractFailingTests(pwReport(specs));
		assert.equal(out.totalFailing, 11);
		assert.equal(out.groups.length, 1);
		assert.equal(out.groups[0].count, 11);
		assert.match(out.groups[0].error, /auth-username/);
		// only a bounded number of example titles are retained
		assert.ok(out.groups[0].titles.length <= MAX_FAILURE_TITLES);
	});

	it('separates distinct errors and caps distinct groups', () => {
		const specs = [];
		for (let i = 0; i < MAX_FAILING_TESTS + 5; i++) specs.push(failSpec(`spec ${i}`, `distinct error number ${i}`));
		const out = extractFailingTests(pwReport(specs));
		assert.equal(out.totalFailing, MAX_FAILING_TESTS + 5);
		assert.equal(out.groups.length, MAX_FAILING_TESTS); // capped
	});

	it('ignores passed and skipped specs', () => {
		const specs = [passSpec('ok one'), failSpec('bad one', 'boom'), { title: 'skipped one', ok: true, tests: [{ results: [{ status: 'skipped' }] }] }];
		const out = extractFailingTests(pwReport(specs));
		assert.equal(out.totalFailing, 1);
		assert.equal(out.groups[0].titles[0], 'bad one');
	});

	it('caps each error line length', () => {
		const long = 'x'.repeat(MAX_FAILURE_ERR_LEN + 200);
		const out = extractFailingTests(pwReport([failSpec('long err', long)]));
		assert.ok(out.groups[0].error.length <= MAX_FAILURE_ERR_LEN);
	});

	it('caps each spec title length', () => {
		const longTitle = 't'.repeat(MAX_FAILURE_TITLE_LEN + 180);
		const out = extractFailingTests(pwReport([failSpec(longTitle, 'boom')]));
		assert.ok(out.groups[0].titles[0].length <= MAX_FAILURE_TITLE_LEN);
	});

	it('walks nested suites', () => {
		const nested = { suites: [{ title: 'outer', suites: [{ title: 'inner', specs: [failSpec('deep fail', 'nested boom')] }] }] };
		const out = extractFailingTests(nested);
		assert.equal(out.totalFailing, 1);
		assert.match(out.groups[0].error, /nested boom/);
	});

	it('is null/shape-safe', () => {
		assert.deepEqual(extractFailingTests(null), { totalFailing: 0, groups: [] });
		assert.deepEqual(extractFailingTests(undefined), { totalFailing: 0, groups: [] });
		assert.deepEqual(extractFailingTests('nope'), { totalFailing: 0, groups: [] });
		assert.deepEqual(extractFailingTests({}), { totalFailing: 0, groups: [] });
		assert.deepEqual(extractFailingTests({ suites: 'bad' }), { totalFailing: 0, groups: [] });
	});
});

describe('buildFailureUserText(input)', () => {
	it('includes signals, deduped failing tests, and log tails', () => {
		const text = buildFailureUserText({
			task: 'auth-notes',
			template: 'demo',
			verdict: 'fail',
			klass: null,
			testsFailed: 11,
			testsTotal: 11,
			buildSucceeded: true,
			devServerStarted: true,
			judgeExplanation: 'App built but never rendered the sign-in form.',
			failingTests: { totalFailing: 11, groups: [{ error: "getByTestId('auth-username') not visible", count: 11, titles: ['a', 'b'] }] },
			devLogTail: 'listening on 3000\nhydrating…',
			buildLogTail: '',
			traceTail: '{"tool":"str_replace"}',
		});
		assert.match(text, /Cell: auth-notes\/demo/);
		assert.match(text, /verdict fail/);
		assert.match(text, /tests_failed 11\/11/);
		assert.match(text, /\[11× \]/);
		assert.match(text, /auth-username/);
		assert.match(text, /Dev-server log tail:/);
		assert.match(text, /Judge notes \(what was built\): App built/);
	});

	it('includes the build log tail ONLY when the build failed', () => {
		const withBuild = buildFailureUserText({ task: 't', template: 'x', buildSucceeded: false, buildLogTail: 'tsc error TS2304', failingTests: { totalFailing: 0, groups: [] } });
		assert.match(withBuild, /Build log tail:/);
		assert.match(withBuild, /tsc error TS2304/);
		const noBuild = buildFailureUserText({ task: 't', template: 'x', buildSucceeded: true, buildLogTail: 'should not appear', failingTests: { totalFailing: 0, groups: [] } });
		assert.doesNotMatch(noBuild, /Build log tail:/);
		assert.doesNotMatch(noBuild, /should not appear/);
	});

	it('caps the log tails and judge explanation', () => {
		const big = 'y'.repeat(5000);
		const text = buildFailureUserText({ task: 't', template: 'x', buildSucceeded: false, judgeExplanation: big, devLogTail: big, buildLogTail: big, failingTests: { totalFailing: 0, groups: [] } });
		// Prompt must stay bounded — nowhere near the 5000-char raw inputs ×3.
		assert.ok(text.length < 6000, `expected bounded prompt, got ${text.length}`);
	});

	it('degrades gracefully with no failing-test detail', () => {
		const text = buildFailureUserText({ task: 't', template: 'x' });
		assert.match(text, /\(no failing-test detail captured\)/);
		assert.match(text, /Signals: \(none\)/);
	});
});

describe('parseFailureAnalysis(text)', () => {
	const valid = JSON.stringify({
		category: 'agent-logic',
		single_root_cause: true,
		root_cause: 'No initial render; UI only paints on onAuthChange which never fires synchronously.',
		evidence: "getByTestId('auth-username') not visible (×11)",
		likely_fix: 'Call renderSignedOut() at module scope on load.',
		owner: 'agent',
	});

	it('parses a bare JSON object', () => {
		const out = parseFailureAnalysis(valid);
		assert.equal(out.category, 'agent-logic');
		assert.equal(out.owner, 'agent');
		assert.equal(out.single_root_cause, true);
		assert.match(out.root_cause, /No initial render/);
		assert.match(out.evidence, /auth-username/);
		assert.match(out.likely_fix, /renderSignedOut/);
	});

	it('parses JSON wrapped in prose', () => {
		const out = parseFailureAnalysis(`Here is my diagnosis:\n${valid}\nHope that helps.`);
		assert.equal(out.category, 'agent-logic');
		assert.equal(out.owner, 'agent');
	});

	it('parses a ```json fenced block', () => {
		const out = parseFailureAnalysis('```json\n' + valid + '\n```');
		assert.equal(out.category, 'agent-logic');
	});

	it('coerces unknown category/owner to null', () => {
		const out = parseFailureAnalysis(JSON.stringify({ category: 'quantum', owner: 'aliens', root_cause: 'x' }));
		assert.equal(out.category, null);
		assert.equal(out.owner, null);
		assert.equal(out.root_cause, 'x');
	});

	it('returns null on malformed JSON', () => {
		assert.equal(parseFailureAnalysis('{not valid json at all'), null);
		assert.equal(parseFailureAnalysis('just some prose, no braces'), null);
	});

	it('returns null when the object carries nothing usable', () => {
		assert.equal(parseFailureAnalysis(JSON.stringify({ single_root_cause: true })), null);
		assert.equal(parseFailureAnalysis(JSON.stringify({ category: 'nonsense' })), null);
	});

	it('is null-safe and never throws on junk input', () => {
		assert.equal(parseFailureAnalysis(null), null);
		assert.equal(parseFailureAnalysis(undefined), null);
		assert.equal(parseFailureAnalysis(''), null);
		assert.equal(parseFailureAnalysis('   '), null);
		assert.equal(parseFailureAnalysis(42), null);
		assert.equal(parseFailureAnalysis(JSON.stringify(['array', 'not', 'object'])), null);
	});
});

describe('deterministicCellAnalysis(result, trace)', () => {
	it('suppresses the model call for a harness_error cell (no gradeable app was produced)', () => {
		const out = deterministicCellAnalysis({ klass: 'harness_error' }, null);
		assert.ok(out, 'a harness_error cell must be deterministic (no model call)');
		assert.match(out.analysis, /harness error/i);
		assert.deepEqual(out.issues, []);
	});

	it('suppresses the model for ANY klass with no trace — records "undetermined", never a confabulated owner', () => {
		// The wall-clock-timeout / teardown path emits no trace; an ungrounded model would guess a root
		// cause/owner. Every non-harness klass must fall back to the deterministic undetermined note.
		for (const klass of ['agent_fail', 'scored', null, undefined]) {
			const out = deterministicCellAnalysis({ klass }, null);
			assert.ok(out, `klass=${klass} with no trace must be deterministic`);
			assert.equal(out.analysis, NO_TRACE_ANALYSIS);
			assert.match(out.analysis, /undetermined/i);
			assert.deepEqual(out.issues, []);
		}
	});

	it('returns null (→ ask the model) only when a trace is present', () => {
		assert.equal(deterministicCellAnalysis({ klass: 'scored' }, [{ name: 'bash' }]), null);
		assert.equal(deterministicCellAnalysis({ klass: 'agent_fail' }, { spans: [] }), null);
	});
});
