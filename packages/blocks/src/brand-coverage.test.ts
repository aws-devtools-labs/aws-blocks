// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard: every Building Block error PRODUCER must be wire-safe.
 *
 * BB error names cross the RPC wire only when the thrown error carries the
 * non-enumerable brand (D-003). The brand is opt-in at ~40 producer sites, and
 * nothing at the type level goes red when one is missed — the branding sweep
 * took several passes and STILL missed class-field errors (`BatchSubmitFailedError`,
 * `InvalidRelayError`), because a `.name =` grep never touches an
 * `override readonly name =` class field. Those regress ONLY on the deployed AWS
 * path (the mock never throws them), so a unit test on the mock stays green.
 *
 * This source-scan closes that gap in two tiers:
 *
 *  1. CLASS granularity (the exact recurrence class): every `class … extends Error`
 *     whose body declares `override readonly name = <BB constant | *Exception>`
 *     MUST brand itself — `brandBlocksError(this)` in its constructor. This is
 *     checked per-class, so an unbranded class-field error is caught even when the
 *     same file also contains other, branded producers (which is exactly why the
 *     original `BatchSubmitFailedError` / `InvalidRelayError` misses slipped a
 *     file-level check).
 *
 *  2. FILE granularity: a file that assigns a BB `*Exception` / `*Errors.*` name to
 *     an error object's `.name` must contain at least one wire-safe marker
 *     (`brandBlocksError` / `blocksError(` / `new ApiError`). This is coarse (it
 *     cannot prove every `.name =` site is individually branded), but it catches a
 *     file that mints BB error names with NO wire-safe path at all.
 *
 * It is intentionally a TEXT scan, not a runtime import: it must catch a
 * never-instantiated class-field error, and must not need every BB's runtime deps
 * installed. Genuinely-intentional unbranded producers are named in ALLOWLIST with
 * a reason, so they are explicit rather than silent.
 *
 * Run: node --test dist/brand-coverage.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packagesDir = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'packages');

/**
 * Sites the scan would flag but which are intentionally NOT branded, each with a
 * reason. Keyed by `<package>/<relative src path>`. Keep this list SHORT — every
 * entry is a documented exception, not a place to hide a real miss.
 */
const FILE_ALLOWLIST: Record<string, string> = {
	// Host-side migration step (D-009): runs as a pre-`cdk deploy` subprocess, its
	// errors surface to the operator's terminal, never through the RPC serializer,
	// so the wire-safe brand is irrelevant here.
	'bb-data/src/migrations/external-migrations.ts': 'host-side migration CLI — errors go to the operator, not the RPC wire',
};

/** Recursively collect `*.ts` sources under `dir`, skipping tests, `.d.ts`, `dist`. */
function collectSources(dir: string): string[] {
	const out: string[] = [];
	let entries: ReturnType<typeof readdirSync>;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === 'dist' || e.name === 'node_modules') continue;
			out.push(...collectSources(p));
		} else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts')) {
			out.push(p);
		}
	}
	return out;
}

function discoverBBSrcDirs(): { pkg: string; srcDir: string }[] {
	const dirs = readdirSync(packagesDir, { withFileTypes: true })
		.filter(d => d.isDirectory() && d.name.startsWith('bb-'));
	const result: { pkg: string; srcDir: string }[] = [];
	for (const d of dirs) {
		const srcDir = join(packagesDir, d.name, 'src');
		try {
			if (statSync(srcDir).isDirectory()) result.push({ pkg: d.name, srcDir });
		} catch {}
	}
	return result;
}

const rel = (pkg: string, file: string) => `${pkg}/${file.slice(join(packagesDir, pkg).length + 1)}`;

// ── Tier 1: class-field error producers must brand themselves ────────────────

const CLASS_FIELD_NAME = /class\s+(\w+)\s+extends\s+(?:\w+\.)?Error\b[\s\S]*?override\s+readonly\s+name\s*=/;
const CLASS_HEADER = /class\s+\w+\s+extends\s+(?:\w+\.)?Error\b/g;

/** Extract each `class X extends Error { … }` body via brace matching. */
function extractErrorClassBodies(text: string): { name: string; body: string }[] {
	const bodies: { name: string; body: string }[] = [];
	for (const m of text.matchAll(CLASS_HEADER)) {
		const nameMatch = /class\s+(\w+)/.exec(m[0]);
		const braceStart = text.indexOf('{', m.index! + m[0].length);
		if (braceStart === -1) continue;
		let depth = 0;
		let i = braceStart;
		for (; i < text.length; i++) {
			if (text[i] === '{') depth++;
			else if (text[i] === '}') { depth--; if (depth === 0) break; }
		}
		bodies.push({ name: nameMatch?.[1] ?? '<anon>', body: text.slice(braceStart, i + 1) });
	}
	return bodies;
}

test('every class-field Error producer brands itself (brandBlocksError in the class body)', () => {
	const offenders: string[] = [];
	for (const { pkg, srcDir } of discoverBBSrcDirs()) {
		for (const file of collectSources(srcDir)) {
			const text = readFileSync(file, 'utf-8');
			if (!CLASS_FIELD_NAME.test(text)) continue;
			for (const { name, body } of extractErrorClassBodies(text)) {
				if (!/override\s+readonly\s+name\s*=/.test(body)) continue;
				if (/brandBlocksError\s*\(/.test(body)) continue;
				const key = rel(pkg, file);
				if (key in FILE_ALLOWLIST) continue;
				offenders.push(`${key} → class ${name}`);
			}
		}
	}
	assert.deepStrictEqual(
		offenders.sort(),
		[],
		`These Error subclasses set their name via a class field but never call ` +
		`brandBlocksError(this) — their name will collapse to a nameless 500 over ` +
		`the RPC wire and isBlocksError() will stop matching on the client. This is ` +
		`the class-field miss the branding sweep kept hitting.\n  ${offenders.join('\n  ')}\n\n` +
		`Add brandBlocksError(this) to the constructor (see InterruptError / InvalidRelayError).`,
	);
});

// ── Tier 2: a file minting BB error names must have a wire-safe path ──────────

const NAME_ASSIGN = [
	/\.name\s*=\s*['"`][A-Za-z]+Exception['"`]/,
	/\.name\s*=\s*[A-Za-z]+Errors\.[A-Za-z]+/,
];
const WIRE_SAFE_MARKERS = [/\bbrandBlocksError\b/, /\bblocksError\s*\(/, /\bnew\s+ApiError\b/, /\breTagged\b/];

test('every file that mints a BB error name has a wire-safe path', () => {
	const offenders: string[] = [];
	for (const { pkg, srcDir } of discoverBBSrcDirs()) {
		for (const file of collectSources(srcDir)) {
			const text = readFileSync(file, 'utf-8');
			if (!NAME_ASSIGN.some(re => re.test(text))) continue;
			if (WIRE_SAFE_MARKERS.some(re => re.test(text))) continue;
			const key = rel(pkg, file);
			if (key in FILE_ALLOWLIST) continue;
			offenders.push(key);
		}
	}
	assert.deepStrictEqual(
		offenders.sort(),
		[],
		`These files assign a Building Block error name to an error's .name but have ` +
		`no wire-safe path (brandBlocksError / blocksError / ApiError / reTagged), so ` +
		`the name collapses to a nameless 500 over the RPC wire.\n  ${offenders.join('\n  ')}\n\n` +
		`Route the throw through a branded helper, or add a FILE_ALLOWLIST entry with a reason.`,
	);
});

test('brand-coverage discovery sanity check', () => {
	const found = discoverBBSrcDirs().map(d => d.pkg);
	assert.ok(found.length >= 8, `Expected ≥8 BB packages, found ${found.length}`);
});
