// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
/**
 * Regression test: conditional export entries must expose the same named exports.
 *
 * TypeScript cannot type-check custom conditions like "cdk" or "aws-runtime" —
 * it always resolves the "types" key, which for every Building Block points at the
 * mock (default) entry. This test actually loads each entry point under each
 * condition and compares its runtime named exports to the default entry's, in BOTH
 * directions:
 *
 *   - missing (in default, absent under the condition): the app module imports a
 *     name the types promise, and the ESM link step fails under that condition —
 *     `cdk synth`, the Lambda cold start, or the browser bundle breaks.
 *   - extra (absent from default, present under the condition): an export the types
 *     never describe and local dev never exercises — drift between layers.
 *
 * The contract (AGENTS.md: "every named export in `index.mock.ts` exists in
 * cdk/aws/browser") is encoded per condition in {@link BB_POLICY}; the umbrella
 * package has its own, documented policy in {@link UMBRELLA_POLICY}. Every known
 * deviation lives in ONE place, {@link KNOWN_GAPS}, so later work can shrink it — and
 * an entry that no longer matches reality fails the test, so the list cannot rot.
 *
 * Packages are discovered automatically: every `packages/bb-*` package with a
 * conditional `exports["."]` map, plus {@link EXTRA_PACKAGES}. All three conditions
 * are checked for each, declared or not — an undeclared condition falls back to
 * `default`, but that file's own imports still resolve under the condition, so the
 * package must still load and expose the same names.
 *
 * Run: node --test dist/conditional-exports.test.js
 */
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// ── Contract ────────────────────────────────────────────────────────────────

const CONDITIONS = ['aws-runtime', 'cdk', 'browser'] as const;
type Condition = (typeof CONDITIONS)[number];

/**
 * - `equal`: condition names === default names (missing and extra both fail).
 * - `superset`: condition names ⊇ default names (only missing fails; extras are intended).
 * - `skip`: the condition entry is a different surface by design; not compared.
 */
type Policy = 'equal' | 'superset' | 'skip';

/**
 * Building Blocks (and {@link EXTRA_PACKAGES}): every condition must match `default` exactly.
 *
 * - `aws-runtime` and `cdk`: the same app module (`aws-blocks/index.ts`) is evaluated under
 *   default (local dev), `cdk` (synth) and `aws-runtime` (Lambda), so a missing name crashes
 *   that stage at import, and an extra name is untyped (types resolve to the mock) and
 *   untested locally.
 * - `browser`: the browser stub keeps every name importable — class stubs whose methods are
 *   server-side, plus the error constants a frontend matches with `isBlocksError`. Browser-only
 *   client helpers belong on a subpath (e.g. `./client`) with their own types, not on the root,
 *   where the `types` key cannot describe them.
 */
const BB_POLICY: Record<Condition, Policy> = { 'aws-runtime': 'equal', cdk: 'equal', browser: 'equal' };

/**
 * `@aws-blocks/blocks`:
 * - `aws-runtime`: no dedicated entry — falls back to default, but each re-exported BB then
 *   resolves to its aws entry, so the names must still match.
 * - `cdk`: intentionally a superset — it re-exports `@aws-blocks/core/cdk` (BlocksStack,
 *   BlocksBackend, registerConfig, synthGuard, …) on top of the BB surface.
 * - `browser`: intentionally `export {}` — browser code imports `@aws-blocks/blocks/client`.
 */
const UMBRELLA_POLICY: Record<Condition, Policy> = { 'aws-runtime': 'equal', cdk: 'superset', browser: 'skip' };

/** Non-`bb-*` packages that ship runtime code consumed by BBs under every condition. */
const EXTRA_PACKAGES = ['auth-common'] as const;

type KnownGap =
	| {
			pkg: string;
			condition: Condition;
			kind: 'missing' | 'extra';
			/** Exact names; every one must still be a gap or the entry is stale. */
			symbols: readonly string[];
			reason: string;
	  }
	| {
			pkg: string;
			condition: Condition;
			/** The entry fails to load at all under the condition. */
			kind: 'unloadable';
			reason: string;
	  };

/**
 * The single allowlist of known parity gaps. Shrink it; never grow it without a reason.
 * A stale entry (the gap is gone, or the package no longer exists) fails the test.
 */
const KNOWN_GAPS: readonly KnownGap[] = [
	// ── Real gaps whose fix is not a trivially-safe re-export. ──
	{
		pkg: '@aws-blocks/bb-data',
		condition: 'browser',
		kind: 'missing',
		symbols: ['PgClientEngine', 'RLSEnabledDatabase', 'createKyselyAdapter', 'sql'],
		reason:
			"Server-only: re-exporting would pull `pg` and '@aws-blocks/data-common' (node:fs migrations, " +
			'PGlite) into browser bundles. Needs purpose-built browser stubs (`sql` is a tagged template ' +
			'with helper properties) — follow-up, not a re-export.',
	},
	{
		pkg: '@aws-blocks/bb-distributed-data',
		condition: 'browser',
		kind: 'missing',
		symbols: ['createKyselyAdapter', 'sql'],
		reason:
			"Server-only: re-exporting would pull '@aws-blocks/data-common' (node:fs migrations, PGlite) " +
			'into browser bundles. Needs purpose-built browser stubs — follow-up, not a re-export.',
	},
	{
		pkg: '@aws-blocks/bb-realtime',
		condition: 'browser',
		kind: 'unloadable',
		reason:
			'No `browser` condition: the root falls back to the mock entry, which imports ' +
			"`registerSdkIdentifiers` from '@aws-blocks/core' (absent from core's browser entry). Clients " +
			'use the `./mock-middleware` / `./aws-middleware` subpaths. Adding a browser entry changes the ' +
			'export map, so it needs maintainer review.',
	},
];

// ── Discovery ───────────────────────────────────────────────────────────────

const packagesDir = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'packages');
const blocksDir = join(packagesDir, 'blocks');

function discoverPackages(): string[] {
	const extra = new Set<string>(EXTRA_PACKAGES);
	const dirs = readdirSync(packagesDir, { withFileTypes: true }).filter(
		(d) => d.isDirectory() && (d.name.startsWith('bb-') || extra.has(d.name)),
	);
	const result: string[] = [];
	for (const dir of dirs) {
		let pkg: { name?: string; exports?: Record<string, unknown> };
		try {
			pkg = JSON.parse(readFileSync(join(packagesDir, dir.name, 'package.json'), 'utf-8'));
		} catch {
			continue;
		}
		const root = pkg.exports?.['.'];
		if (pkg.name && root !== null && typeof root === 'object') result.push(pkg.name);
	}
	return result.sort();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

type LoadResult = { ok: true; names: Set<string> } | { ok: false; error: string };

const cache = new Map<string, LoadResult>();

/** Load `pkg` in a fresh Node process under `condition` (or none) and list its named exports. */
function loadExports(pkg: string, condition: Condition | null): LoadResult {
	const key = `${pkg}|${condition ?? 'default'}`;
	const cached = cache.get(key);
	if (cached) return cached;
	const flags = condition ? ['--conditions', condition] : [];
	const script = `import('${pkg}').then(m => console.log(JSON.stringify(Object.keys(m))))`;
	let result: LoadResult;
	try {
		const out = execFileSync('node', [...flags, '--input-type=module', '-e', script], {
			cwd: blocksDir,
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const names = new Set(JSON.parse(out.trim().split('\n').pop() ?? '[]') as string[]);
		names.delete('default');
		result = { ok: true, names };
	} catch (e) {
		const stderr = String((e as { stderr?: unknown }).stderr ?? e);
		const line = stderr.split('\n').find((l) => /Error/.test(l)) ?? stderr.trim().split('\n')[0];
		result = { ok: false, error: line ?? 'unknown error' };
	}
	cache.set(key, result);
	return result;
}

/** Compare `pkg` under `condition` against its default entry, honoring `policy` and KNOWN_GAPS. */
function assertParity(pkg: string, condition: Condition, policy: Policy) {
	const known = KNOWN_GAPS.filter((g) => g.pkg === pkg && g.condition === condition);
	const knownUnloadable = known.some((g) => g.kind === 'unloadable');
	const allowed = (kind: 'missing' | 'extra') => new Set(known.flatMap((g) => (g.kind === kind ? g.symbols : [])));

	const base = loadExports(pkg, null);
	if (!base.ok) assert.fail(`${pkg} default entry failed to load: ${base.error}`);

	const cond = loadExports(pkg, condition);
	if (!cond.ok) {
		assert.ok(
			knownUnloadable,
			`${pkg} fails to load under --conditions=${condition}:\n  ${cond.error}\n\n` +
				'Fix the entry file, or add a KNOWN_GAPS entry with the reason.',
		);
		return;
	}
	assert.ok(
		!knownUnloadable,
		`${pkg} now loads under --conditions=${condition} — remove its 'unloadable' KNOWN_GAPS entry.`,
	);

	const missing = [...base.names].filter((n) => !cond.names.has(n));
	const extra = policy === 'equal' ? [...cond.names].filter((n) => !base.names.has(n)) : [];
	const allowedMissing = allowed('missing');
	const allowedExtra = allowed('extra');
	const problems: string[] = [];

	const newMissing = missing.filter((n) => !allowedMissing.has(n)).sort();
	if (newMissing.length > 0) {
		problems.push(
			`missing from the "${condition}" entry (exported by default): ${newMissing.join(', ')}\n` +
				`    → add them to the ${condition} entry file (a re-export, or a synthGuard/browser stub).`,
		);
	}
	const newExtra = extra.filter((n) => !allowedExtra.has(n)).sort();
	if (newExtra.length > 0) {
		problems.push(
			`only in the "${condition}" entry (not exported by default): ${newExtra.join(', ')}\n` +
				'    → export them from the default (mock) entry too, or stop exporting them here.',
		);
	}
	const stale = [
		...[...allowedMissing].filter((n) => !missing.includes(n)),
		...[...allowedExtra].filter((n) => !extra.includes(n)),
	];
	if (stale.length > 0) {
		problems.push(
			`KNOWN_GAPS lists gaps that no longer exist: ${stale.join(', ')}\n    → remove them from KNOWN_GAPS.`,
		);
	}

	assert.deepStrictEqual(problems, [], `${pkg} under --conditions=${condition}:\n  ${problems.join('\n  ')}`);
}

// ── Discovery sanity ────────────────────────────────────────────────────────

const packages = discoverPackages();

test('discovery sanity check', () => {
	assert.ok(packages.length >= 8, `Expected ≥8 BB packages, found ${packages.length}: ${packages.join(', ')}`);
	for (const expected of [
		'@aws-blocks/bb-kv-store',
		'@aws-blocks/bb-distributed-table',
		'@aws-blocks/bb-data',
		'@aws-blocks/auth-common',
	]) {
		assert.ok(packages.includes(expected), `Expected to discover ${expected}`);
	}
});

test('KNOWN_GAPS only names checked packages', () => {
	const checked = new Set([...packages, '@aws-blocks/blocks']);
	const stale = [...new Set(KNOWN_GAPS.map((g) => g.pkg))].filter((p) => !checked.has(p));
	assert.deepStrictEqual(stale, [], `KNOWN_GAPS names packages that are no longer checked: ${stale.join(', ')}`);
});

// ── Umbrella package ────────────────────────────────────────────────────────

for (const condition of CONDITIONS) {
	const policy = UMBRELLA_POLICY[condition];
	if (policy === 'skip') {
		test(`@aws-blocks/blocks: ${condition} exports`, {
			skip: 'intentionally a different surface (see UMBRELLA_POLICY)',
		});
		continue;
	}
	test(`@aws-blocks/blocks: ${condition} exports ${policy} default`, () => {
		assertParity('@aws-blocks/blocks', condition, policy);
	});
}

// ── BB packages (auto-discovered) ───────────────────────────────────────────

for (const pkg of packages) {
	for (const condition of CONDITIONS) {
		test(`${pkg}: ${condition} exports ${BB_POLICY[condition]} default`, () => {
			assertParity(pkg, condition, BB_POLICY[condition]);
		});
	}
}
