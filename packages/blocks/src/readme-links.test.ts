// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Every relative link in the package-root README.md must point at a file that
 * is published at the package root — the README is what npm renders and what
 * sits in `node_modules/@aws-blocks/blocks/`, so a target missing from the
 * `files` list is a dead link for consumers.
 */
import assert from 'node:assert';
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
