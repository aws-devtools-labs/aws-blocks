// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Fails when a GitHub Actions `uses:` reference under .github/ isn't pinned to a
// full 40-character commit SHA. A mutable tag or branch (`@v7`, `@main`) lets
// whoever controls that ref run code inside our jobs — including the ones that
// assume an AWS deploy role via OIDC. Pin with a trailing version comment:
//
//   uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
//
// Dependabot (github-actions ecosystem) keeps pinned SHAs current.
// Local actions (`./...`) and `docker://` images are out of scope.
//
// Run: node scripts/check-actions-pinned.mjs   (exit 1 + list on violations)

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const USES = /^[ \t]*-?[ \t]*uses:[ \t]*['"]?([^'"\s#]+)['"]?/;
const PINNED = /@[0-9a-f]{40}$/;

/** Return `{ line, ref }` for every unpinned external `uses:` in a workflow/action file's text. */
export function findUnpinned(text) {
	const out = [];
	text.split('\n').forEach((ln, i) => {
		const m = USES.exec(ln);
		if (!m) return;
		const ref = m[1];
		if (ref.startsWith('./') || ref.startsWith('docker://')) return;
		if (!PINNED.test(ref)) out.push({ line: i + 1, ref });
	});
	return out;
}

function* yamlFiles(dir) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) yield* yamlFiles(p);
		else if (/\.ya?ml$/.test(name)) yield p;
	}
}

/** Scan `<root>/.github` and return every violation as `{ file, line, ref }`. */
export function scan(root) {
	const violations = [];
	for (const file of yamlFiles(join(root, '.github'))) {
		for (const v of findUnpinned(readFileSync(file, 'utf8'))) violations.push({ file: relative(root, file), ...v });
	}
	return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
	const violations = scan(root);
	if (violations.length) {
		console.error(`✗ ${violations.length} GitHub Actions reference(s) not pinned to a commit SHA:\n`);
		for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.ref}`);
		console.error('\nPin each to a full 40-char SHA with a version comment, e.g.\n  uses: actions/checkout@<sha> # v7.0.1');
		process.exit(1);
	}
	console.log('✓ All GitHub Actions references are pinned to commit SHAs.');
}
