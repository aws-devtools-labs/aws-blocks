// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Every relative link in the package-root README.md must point at a file that
 * is published at the package root — the README is what npm renders and what
 * sits in `node_modules/@aws-blocks/blocks/`, so a target missing from the
 * `files` list is a dead link for consumers.
 *
 * No tracked Markdown or TypeScript file of the repository may keep a merge
 * conflict marker: a rebase that leaves one in a README ships both sides of the
 * conflict to npm, and nothing else in `npm test` reads the docs.
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Compiled to dist/, so the package root is one level up.
const pkgRoot = fileURLToPath(new URL('..', import.meta.url));

/** Relative link targets (no scheme, no pure anchors) with any `#fragment` stripped. */
function relativeLinkTargets(markdown: string): string[] {
	const targets = new Set<string>();
	for (const [, href] of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
		if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) continue;
		targets.add(href.split('#')[0].replace(/^\.\//, ''));
	}
	return [...targets];
}

/** Whether `path` is covered by an entry of package.json `files` (exact file or directory prefix). */
function isPublished(path: string, files: string[]): boolean {
	return files.some((entry) => path === entry || path.startsWith(`${entry.replace(/\/$/, '')}/`));
}

test('README.md relative links resolve to files published at the package root', () => {
	const readme = readFileSync(join(pkgRoot, 'README.md'), 'utf-8');
	const { files } = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8')) as { files: string[] };
	const targets = relativeLinkTargets(readme);
	assert.ok(targets.length > 0, 'expected README.md to contain relative links');
	for (const target of targets) {
		assert.ok(existsSync(join(pkgRoot, target)), `README.md links to missing file: ${target}`);
		assert.ok(
			isPublished(target, files),
			`README.md links to ${target}, which package.json "files" does not publish`,
		);
	}
});

/** The 1-based line numbers of the merge conflict marker lines in `text`. */
function conflictMarkerLines(text: string): number[] {
	const lines: number[] = [];
	text.split(/\r?\n/).forEach((line, i) => {
		if (/^(<{7}|>{7})/.test(line) || line === '='.repeat(7)) lines.push(i + 1);
	});
	return lines;
}

test('conflictMarkerLines finds the three marker lines of a conflict block', () => {
	const block = [
		'intro',
		`${'<'.repeat(7)} HEAD`,
		'ours',
		'='.repeat(7),
		'theirs',
		`${'>'.repeat(7)} 383255bf (fix: something)`,
		'===',
		'a <<<<<<< inline mention',
	].join('\n');
	assert.deepStrictEqual(conflictMarkerLines(block), [2, 4, 6]);
});

test('no tracked Markdown or TypeScript file keeps a merge conflict marker', (t) => {
	let files: string[];
	let root: string;
	try {
		root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: pkgRoot, encoding: 'utf-8' }).trim();
		files = execFileSync('git', ['ls-files', '-z', '--', '*.md', '*.mdx', '*.ts', '*.mts', '*.cts', '*.tsx'], {
			cwd: root,
			encoding: 'utf-8',
			maxBuffer: 64 * 1024 * 1024,
		})
			.split('\0')
			.filter(Boolean);
	} catch {
		t.skip('not in a git checkout');
		return;
	}
	const found: string[] = [];
	for (const file of files) {
		const path = join(root, file);
		if (!existsSync(path)) continue; // deleted in the working tree, not yet staged
		for (const line of conflictMarkerLines(readFileSync(path, 'utf-8'))) found.push(`${file}:${line}`);
	}
	assert.deepStrictEqual(found, [], `merge conflict markers left in:\n  ${found.join('\n  ')}`);
});
