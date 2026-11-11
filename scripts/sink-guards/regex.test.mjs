// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Repo invariant: a value reaches `new RegExp(…)` only as a constant or through
// an escape (`escapeRegExp` from `@aws-blocks/core/bb-utils`, or a same-named
// helper that escapes every metacharacter). Unescaped, a configured
// `example.com` also matches `exampleXcom`, and `a|.*` matches everything.
//
// Scans every tracked production TypeScript/JavaScript file (tests excluded) on
// the TypeScript AST. A site that is safe for a reason the scan can't see goes
// in ALLOWLIST by exact file:line with that reason; an entry that stops
// matching a site fails the test, so the list only shrinks.
//
// Run: node --test scripts/sink-guards/regex.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	compareWithAllowlist,
	findRegexSinks,
	findWeakEscapeHelpers,
	listSourceFiles,
	report,
	scan,
} from './sinks.mjs';

const ALLOWLIST = [
	{
		at: 'packages/blocks/src/cli/config.ts:228',
		reason: '`port` is a number (frontendPort ?? DEFAULT_FRONTEND_PORT), so the pattern holds digits only.',
	},
	{
		at: 'packages/core/src/cors.ts:38',
		reason: 'CORS allowlist compilation; plain origins are matched literally by open PR #1413, which owns this file.',
	},
	{
		at: 'packages/core/src/cors.ts:40',
		reason: 'CORS allowlist compilation through escapeOriginToPattern(); reworked by open PR #1413, which owns this file.',
	},
	{
		at: 'packages/core/src/cors.ts:120',
		reason: 'Hosting origins compiled through escapeOriginToPattern(); reworked by open PR #1413, which owns this file.',
	},
	{
		at: 'packages/core/src/raw-route.ts:444',
		reason: 'Built one character at a time: every character in REGEX_SPECIAL is escaped and `{` `}` `*` are parsed as params and the wildcard.',
	},
	{
		at: 'packages/core/src/scripts/cdk-output.ts:451',
		reason: 'Joins the `.source` of a fixed array of regex literals written in this file.',
	},
	{
		at: 'packages/core/src/scripts/credential-guidance.ts:59',
		reason: 'Joins the keys of the NETWORK_ERRORS object literal (Node error codes such as ECONNREFUSED) declared in this file.',
	},
	{
		at: 'packages/hosting/src/adapters/nextjs.ts:1042',
		reason: '`key` is one of the literal OpenNext option names passed by the callers in this file; `value` goes through escapeRegex().',
	},
	{
		at: 'packages/hosting/src/constructs/proxy_limits.ts:66',
		reason: 'Glob compilation: each part between `*` is escaped (the class omits `*` only because the value is split on it), `*` becomes `.*`.',
	},
	{
		at: 'scripts/ci/e2e-teardown.mjs:166',
		reason: 'The sandbox id and stack suffix are checked against /^[A-Za-z0-9-]+$/ before this token is built.',
	},
];

describe('regex sink detector', () => {
	const find = (src) => findRegexSinks('sample.ts', src).map((f) => f.line);

	it('flags a pattern built from a parameter, a property or a call', () => {
		assert.deepEqual(find('function f(o: string) { return new RegExp(`^${o}$`); }'), [1]);
		assert.deepEqual(find('const r = (c: { origin: string }) => RegExp(c.origin, "i");'), [1]);
		assert.deepEqual(find('new RegExp(process.env.ALLOW!);'), [1]);
		assert.deepEqual(find('let p = "a"; p += x; new RegExp(p);'), [1]);
	});

	it('flags a hand-written escape that misses a metacharacter', () => {
		assert.deepEqual(find("function f(o: string) { return new RegExp(o.replace(/[.*+?^${}()|[\\]]/g, '\\\\$&')); }"), [1]);
	});

	it('accepts literals, constants, escapeRegExp() and a complete hand-written escape', () => {
		assert.deepEqual(find('new RegExp("^a+$"); new RegExp(`^b$`, "g"); RegExp(/c/.source);'), []);
		assert.deepEqual(find('const ID = "[a-z]+"; const RE = new RegExp(`^${ID}(?:\\\\.${ID})*$`);'), []);
		assert.deepEqual(find('function f(o: string) { return new RegExp(`^${escapeRegExp(o)}$`); }'), []);
		assert.deepEqual(find("function f(o: string) { const e = o.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'); return new RegExp(e); }"), []);
		assert.deepEqual(find('for (const a of ["br", "gzip"]) new RegExp(`\\\\.includes\\\\("${a}"\\\\)`);'), []);
	});

	it('resolves a name through its own scope, not another declaration of it', () => {
		const src = 'const name = "fixed";\nfunction f(name: string) { return new RegExp(name); }';
		assert.deepEqual(find(src), [2]);
	});
});

describe('repo: no unescaped value reaches new RegExp()', () => {
	it('every site is a constant, escaped, or allowlisted with a reason', () => {
		const result = compareWithAllowlist(scan(listSourceFiles(), findRegexSinks), ALLOWLIST);
		assert.ok(result.unexpected.length === 0 && result.stale.length === 0, report('regex', result));
	});

	it('every function named escapeRegExp/escapeRegex escapes every metacharacter', () => {
		const weak = scan(listSourceFiles(), findWeakEscapeHelpers).filter((f) => /^escapeReg/.test(f.text));
		assert.deepEqual(weak, []);
	});
});
