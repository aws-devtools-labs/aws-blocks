// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The docs ship inside the installed package, so they always describe the
 * version the reader has. A sentence that narrates how something changed
 * ("previously …", "(#123)", "since 0.7", "an earlier revision …") describes
 * nothing the reader has, and points agents at names and behaviour that no
 * longer exist. This test flags such phrasing in every shipped doc: each
 * bundled block's root `*.md` and `docs/` folder, this package's own root
 * `*.md`, the scaffolded app `AGENTS.md` and the template READMEs.
 *
 * Changelogs and migration guides are history by design and are skipped.
 * Fenced code is skipped. A paragraph that needs a marker on purpose (for
 * example an upgrade note for stacks deployed by an earlier release) carries a
 * visible opt-out with a reason. It covers its own line and the rest of the
 * paragraph, up to the next blank line, so put it on the line before:
 *
 *     <!-- docs-history: keep — <reason> -->
 *
 * Run: node --test dist/docs-history.test.js
 */
import assert from 'node:assert';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Compiled to dist/, so the package root is one level up and the repo root three.
const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = join(pkgRoot, '..', '..');
const packagesDir = join(repoRoot, 'packages');

/** History phrasing with few present-tense uses. "no longer" and "now" are left out: they often describe runtime state. */
const MARKERS: readonly RegExp[] = [
	/\b(?:previously|formerly)\b/i,
	/\bused to (?:be|fail|crash|throw|return|carry|have|accept|require|work)\b/i,
	/\(#\d{2,}\)/,
	/\b(?:per|since|see|in|after|before) #\d{2,}\b/i,
	/\bthis PR\b/,
	/\b(?:since|as of) v?\d+\.\d+\b/i,
	/\bin v?\d+\.\d+ and later\b/i,
	/\bearlier (?:revision|release|design)s?\b/i,
	/\bwas renamed\b/i,
];

const OPT_OUT = /<!-- docs-history: keep — \S.*-->/;

/** Changelogs and migration guides narrate history on purpose. */
const HISTORY_DOC = /^(?:CHANGELOG|MIGRATION|MIGRATING)/;

function markdownIn(dir: string, recursive: boolean): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory() && recursive) out.push(...markdownIn(path, true));
		else if (entry.isFile() && entry.name.endsWith('.md') && !HISTORY_DOC.test(entry.name)) out.push(path);
	}
	return out;
}

async function shippedDocs(): Promise<string[]> {
	// The repo-root script is outside this package's compile graph, so it can't be a static import (as in docs-pointers.test.ts).
	const { getBlockPackages } = await import(pathToFileURL(join(repoRoot, 'scripts', 'block-packages.mjs')).href);
	const docs: string[] = [];
	for (const pkg of getBlockPackages() as string[]) {
		docs.push(...markdownIn(join(packagesDir, pkg), false));
		docs.push(...markdownIn(join(packagesDir, pkg, 'docs'), true));
	}
	docs.push(...markdownIn(pkgRoot, false));
	const scaffold = join(packagesDir, 'create-blocks-app');
	docs.push(join(scaffold, 'resources', 'AGENTS.md'));
	const templates = join(scaffold, 'templates');
	for (const name of readdirSync(templates)) {
		const readme = join(templates, name, 'README.md');
		if (statSync(join(templates, name)).isDirectory() && existsSync(readme)) docs.push(readme);
	}
	return docs;
}

/** `file:line: text` for every unfenced line with a history marker outside an opted-out paragraph. */
function findHistory(path: string): string[] {
	const found: string[] = [];
	let fenced = false;
	let optedOut = false;
	for (const [i, line] of readFileSync(path, 'utf-8').split('\n').entries()) {
		if (/^\s*(?:```|~~~)/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (line.trim() === '') optedOut = false;
		if (OPT_OUT.test(line)) optedOut = true;
		if (fenced || optedOut || !MARKERS.some((marker) => marker.test(line))) continue;
		found.push(`${relative(repoRoot, path)}:${i + 1}: ${line.trim()}`);
	}
	return found;
}

test('shipped docs describe the installed version, not how it changed', async () => {
	const docs = await shippedDocs();
	assert.ok(docs.length > 50, `expected the shipped docs, found ${docs.length} files`);
	const found = docs.flatMap(findHistory);
	assert.deepStrictEqual(
		found,
		[],
		'State the present behaviour instead (or add `<!-- docs-history: keep — <reason> -->` on the line or the line before):\n' +
			found.join('\n'),
	);
});

test('the history markers catch the phrasing they target', () => {
	const flagged = [
		'`X` previously threw.',
		'Fixed in core (#912).',
		'superseded per #338',
		'An earlier revision of this PR read the context.',
		'Available since 0.7.',
		'It was renamed from `Foo`.',
	];
	const allowed = [
		'A Delete whose table no longer exists succeeds.',
		'Version history lives under `versions/`.',
		'Read the previous version with `get({ version: "previous" })`.',
		'This lane is skipped while issue #987 is open.',
		'The `api` wiring matches the End-to-End example (#1).',
	];
	for (const line of flagged)
		assert.ok(
			MARKERS.some((m) => m.test(line)),
			`should flag: ${line}`,
		);
	for (const line of allowed) assert.ok(!MARKERS.some((m) => m.test(line)), `should allow: ${line}`);
});
