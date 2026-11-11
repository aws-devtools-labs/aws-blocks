// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Repo invariant: a template literal that builds HTML interpolates only
// constants, numbers, nested markup and values passed through an HTML escape
// (`escapeHtml` from `@aws-blocks/core/bb-utils`, or a same-named helper that
// escapes `& < > " '`). That covers scaffolded templates, dev-server pages,
// hosting pages, example apps and test apps alike: a file path, an error
// message or a realtime peer's value placed in markup unescaped is script.
//
// Scans every tracked production TypeScript/JavaScript file (tests excluded) on
// the TypeScript AST. A template counts as HTML when its text has an HTML
// element tag, comment or doctype. Allowlist entries are exact file:line with a
// reason; an entry that stops matching a site fails the test, so the list only
// shrinks.
//
// Run: node --test scripts/sink-guards/html.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	compareWithAllowlist,
	findHtmlSinks,
	findWeakEscapeHelpers,
	listSourceFiles,
	report,
	scan,
} from './sinks.mjs';

const BENCH_SUMMARY =
	'GitHub-flavoured Markdown for the bench job summary/PR comment, which GitHub sanitises when it renders; the values are bench task metadata and scores.';

const ALLOWLIST = [
	{ at: 'scripts/agent-bench/steps/analyze.mjs:127', reason: BENCH_SUMMARY },
	{ at: 'scripts/agent-bench/steps/analyze.mjs:135', reason: BENCH_SUMMARY },
	{
		at: 'scripts/build-tech-design-pdf.mjs:92',
		reason: 'Base64 of a PNG this script rendered; the base64 alphabet holds no HTML metacharacters.',
	},
];

// Escape helpers that miss a character, with where they are used.
const WEAK_HELPER_ALLOWLIST = [
	{
		at: 'test-apps/native-bindings/src/index.ts:4',
		reason: "esc() misses `'`; every use is element text or a double-quoted attribute. The file is being reworked by open PR #1259.",
	},
];

describe('HTML sink detector', () => {
	const find = (src) => findHtmlSinks('sample.ts', src).map((f) => f.text);

	it('flags a raw value in element text or an attribute', () => {
		assert.deepEqual(find('el.innerHTML = `<span class="error">${error.message}</span>`;'), ['error.message']);
		assert.deepEqual(find('const svg = (c: string) => `<svg fill="${c}"></svg>`;'), ['c']);
		assert.deepEqual(find('send(`<!DOCTYPE html><p>${path}</p>`);'), ['path']);
	});

	it('accepts escaped values, numbers, constants and nested markup', () => {
		const src = [
			'const TITLE = "Settings";',
			'const row = (x: string) => `<li>${escapeHtml(x)}</li>`;',
			'el.innerHTML = `<h1>${TITLE}</h1><ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;',
			'el.innerHTML = `<p>${items.length} items, ${row(name)}, ${n * 2} px</p>`;',
			'const btn = ok ? `<button>${esc(label)}</button>` : "";',
			'el.innerHTML = `<div>${btn}</div>`;',
		].join('\n');
		assert.deepEqual(find(src), []);
	});

	it('does not read CLI usage text or prompt markup as HTML', () => {
		assert.deepEqual(find('console.log(`Usage: ${bin} set <KEY> [--prefix <path>] (default: ${prefix})`);'), []);
		assert.deepEqual(find('return `<untrusted-data id="${nonce}">${body}</untrusted-data>`;'), []);
	});

	it('flags an escape helper that misses a character', () => {
		const weak = findWeakEscapeHelpers(
			'x.ts',
			"function escapeHtml(s: string) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }",
		);
		assert.equal(weak.length, 1);
		const strong = findWeakEscapeHelpers(
			'x.ts',
			"function escapeHtml(s: string) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&#39;'); }\nconst jsArg = (v: unknown) => escapeHtml(JSON.stringify(v));",
		);
		assert.deepEqual(strong, []);
	});
});

describe('repo: HTML templates interpolate only escaped values', () => {
	it('every interpolation is safe, or allowlisted with a reason', () => {
		const result = compareWithAllowlist(scan(listSourceFiles(), findHtmlSinks), ALLOWLIST);
		assert.ok(result.unexpected.length === 0 && result.stale.length === 0, report('html', result));
	});

	it('every function named escapeHtml/escapeAttr/esc escapes & < > " \'', () => {
		const weak = scan(listSourceFiles(), findWeakEscapeHelpers).filter((f) => !/^escapeReg/.test(f.text));
		const result = compareWithAllowlist(weak, WEAK_HELPER_ALLOWLIST);
		assert.ok(result.unexpected.length === 0 && result.stale.length === 0, report('html escape helpers', result));
	});
});
