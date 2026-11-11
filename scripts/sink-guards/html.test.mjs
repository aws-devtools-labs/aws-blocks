// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Repo invariant: a template literal that builds HTML interpolates only
// constants, numbers, nested markup and values passed through an HTML escape
// (`escapeHtml` from `@aws-blocks/core/bb-utils`, or a same-named helper that
// escapes `& < > " '`). That covers scaffolded templates, dev-server pages,
// hosting pages, example apps and test apps alike: a file path, an error
// message or a realtime peer's value placed in markup unescaped is script.
//
// Inside an attribute that HTML escaping doesn't make safe (an `on*=` event
// handler, a URL in `href=`/`src=`/`formaction=`/`action=`, `srcdoc=` or
// `style=`), an escape helper isn't enough: only constants pass, plus
// `encodeURIComponent(...)` in a URL and `jsArg(...)`-style JSON-then-escape
// literals in an event handler. Anything else is allowlisted below.
//
// Escape helpers are trusted by name (`escapeHtml(x)`, `esc(x)`), which is safe
// only because every declaration of those names in the tree is checked to
// escape `& < > " '`. So only a bare call, or one on a namespace import of
// `@aws-blocks/core/bb-utils`, is trusted; `util.esc(x)` is not.
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

const TODO_ID =
	"Event-handler argument '${escape(todo.todoId)}': todoId is a ULID the server generates in createTodo (never a client-chosen value), so it holds no quote or markup.";
const PEER_COLOR =
	'style= value: the peer colour is checked against HEX_COLOR (^#[0-9a-f]{6}$) in getOrCreateCursor, with a constant fallback, before it reaches the attribute.';
const NATIVE_BINDINGS = 'The file is being reworked by open PR #1259, which owns it.';

const ALLOWLIST = [
	{ at: 'scripts/agent-bench/steps/analyze.mjs:127', reason: BENCH_SUMMARY },
	{ at: 'scripts/agent-bench/steps/analyze.mjs:135', reason: BENCH_SUMMARY },
	{
		at: 'scripts/build-tech-design-pdf.mjs:92',
		reason: 'Base64 of a PNG this script rendered, after a constant data:image/png scheme; the base64 alphabet holds no HTML metacharacters.',
	},
	{
		at: 'packages/bb-auth/src/engines/stub-idp.ts:534',
		reason: "Form action is this stub IdP's own authorize URL (stubIssuerUrl: the request's base URL or BLOCKS_API_URL plus a fixed path), so it always has an http(s) scheme.",
	},
	...[41, 43, 45, 50].map((l) => ({ at: `native/kotlin/example/typescript/src/index.ts:${l}`, reason: TODO_ID })),
	...[41, 43, 45, 50].map((l) => ({ at: `native/swift/Demo/typescript-demo/src/index.ts:${l}`, reason: TODO_ID })),
	...[66, 68, 70, 75].map((l) => ({ at: `packages/create-blocks-app/templates/demo/src/index.ts:${l}`, reason: TODO_ID })),
	...[66, 68, 70, 75].map((l) => ({ at: `test-apps/native-bindings/src/index.ts:${l}`, reason: `${TODO_ID} ${NATIVE_BINDINGS}` })),
	{ at: 'native/kotlin/example/typescript/src/index.ts:322', reason: PEER_COLOR },
	{ at: 'native/swift/Demo/typescript-demo/src/index.ts:349', reason: PEER_COLOR },
	{ at: 'test-apps/comprehensive/src/index.ts:229', reason: PEER_COLOR },
	{
		at: 'test-apps/native-bindings/src/index.ts:170',
		reason: `style= value with a realtime peer colour (escaped, not yet validated). ${NATIVE_BINDINGS}`,
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

	it('flags an escaped value inside an event-handler, URL or style attribute', () => {
		assert.deepEqual(find('el.innerHTML = `<b onclick="go(\'${escapeHtml(x)}\')">x</b>`;'), ['onclick=: escapeHtml(x)']);
		assert.deepEqual(find('el.innerHTML = `<a href="${escapeHtml(u)}">x</a>`;'), ['href=: escapeHtml(u)']);
		assert.deepEqual(find('el.innerHTML = `<span style="color:#fff;background:${escapeHtml(c)}">x</span>`;'), ['style=: escapeHtml(c)']);
		assert.deepEqual(find('el.innerHTML = `<iframe srcdoc=\'${esc(d)}\'></iframe>`;'), ['srcdoc=: esc(d)']);
	});

	it('accepts constants, encodeURIComponent in a URL and JSON literals in a handler', () => {
		const src = [
			'const jsArg = (v: unknown) => escapeHtml(JSON.stringify(String(v)));',
			'el.innerHTML = `<a href="/files/${encodeURIComponent(id)}" class="${escapeHtml(cls)}">x</a>`;',
			'el.innerHTML = `<button onclick="del(${jsArg(id)})">x</button><b onclick="go(${escapeHtml(JSON.stringify(id))})">y</b>`;',
			'const BG = "#fff"; el.innerHTML = `<span style="background:${BG}">${esc(name)}</span>`;',
		].join('\n');
		assert.deepEqual(find(src), []);
		// A JSON literal inside quotes the template opened is not a JS literal.
		assert.deepEqual(find("el.innerHTML = `<b onclick=\"go('${jsArg(id)}')\">x</b>`;\nconst jsArg = (v: unknown) => escapeHtml(JSON.stringify(v));"), ['onclick=: jsArg(id)']);
	});

	it('flags a compound assignment, which is not a number', () => {
		assert.deepEqual(find('el.innerHTML = `<p>${(s += x)}</p><p>${(a ||= x)}</p><p>${(a ??= x)}</p>`;'), ['(s += x)', '(a ||= x)', '(a ??= x)']);
		assert.deepEqual(find('el.innerHTML = `<p>${a - b}</p>`;'), []);
	});

	it('trusts an escape helper by name only as a bare call or a bb-utils namespace import', () => {
		assert.deepEqual(find('el.innerHTML = `<p>${util.esc(x)}</p><p>${lib.escapeHtml(y)}</p>`;'), ['util.esc(x)', 'lib.escapeHtml(y)']);
		const viaBbUtils = "import * as u from '@aws-blocks/core/bb-utils';\nel.innerHTML = `<p>${u.escapeHtml(x)}</p>`;";
		assert.deepEqual(find(viaBbUtils), []);
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

	it('checks escape helpers declared as methods, properties and class fields', () => {
		const src = [
			'const util = { esc(s: string) { return s; } };',
			'const lib = { escapeAttr: (s: string) => s };',
			'class U { escapeHtml(s: string) { return s; } }',
			'class V { esc = (s: string) => s; }',
		].join('\n');
		assert.deepEqual(
			findWeakEscapeHelpers('x.ts', src).map((f) => f.line),
			[1, 2, 3, 4],
		);
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
