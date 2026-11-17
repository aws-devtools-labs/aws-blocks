#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Checks that every published artifact carries the repository's LICENSE and
 * NOTICE files:
 *
 * - every non-private `packages/<pkg>/package.json` has LICENSE and NOTICE
 *   files byte-identical to the root copies, and lists both in `files`
 *   (npm adds LICENSE on its own but never NOTICE, so both are listed
 *   explicitly);
 * - `native/kotlin`, `native/swift` and every `native/dart/packages/<pkg>` have
 *   LICENSE and NOTICE files byte-identical to the root copies.
 *
 * Exits 1 and lists every problem when a check fails.
 *
 * Usage: node scripts/check-notice-files.mjs
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const LEGAL_FILES = ['LICENSE', 'NOTICE'];

/** Repo-relative path, for messages. */
const rel = (p) => relative(ROOT, p) || '.';

const rootCopies = new Map(LEGAL_FILES.map((f) => [f, readFileSync(join(ROOT, f))]));
const problems = [];

/** Checks that `dir` holds LICENSE and NOTICE identical to the root copies. */
function checkCopies(dir) {
	for (const [name, expected] of rootCopies) {
		const file = join(dir, name);
		if (!existsSync(file)) {
			problems.push(`${rel(file)} is missing (copy it from the repository root)`);
		} else if (!readFileSync(file).equals(expected)) {
			problems.push(`${rel(file)} differs from the root ${name} (copy it from the repository root)`);
		}
	}
}

/** Subdirectories of `dir`, sorted, or none when `dir` does not exist. */
function subdirs(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => statSync(join(dir, name)).isDirectory())
		.sort()
		.map((name) => join(dir, name));
}

let npmCount = 0;
for (const pkgDir of subdirs(join(ROOT, 'packages'))) {
	const manifestPath = join(pkgDir, 'package.json');
	if (!existsSync(manifestPath)) continue;
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	if (manifest.private === true) continue;
	npmCount++;
	checkCopies(pkgDir);
	const files = Array.isArray(manifest.files) ? manifest.files : [];
	for (const name of LEGAL_FILES) {
		if (!files.includes(name)) {
			problems.push(`${rel(manifestPath)} (${manifest.name}): "files" does not list "${name}"`);
		}
	}
}

const nativeDirs = [
	join(ROOT, 'native', 'kotlin'),
	join(ROOT, 'native', 'swift'),
	...subdirs(join(ROOT, 'native', 'dart', 'packages')),
];
for (const dir of nativeDirs) checkCopies(dir);

if (problems.length > 0) {
	console.error(`LICENSE/NOTICE check failed (${problems.length} problem(s)):`);
	for (const p of problems) console.error(`  - ${p}`);
	process.exit(1);
}
console.log(`✓ LICENSE and NOTICE match the root in ${npmCount} npm package(s) and ${nativeDirs.length} native SDK dir(s)`);
