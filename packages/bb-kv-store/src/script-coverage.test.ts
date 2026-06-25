// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Regression guard for issue #95.
 *
 * The package.json "test" script enumerates the compiled test files explicitly
 * (rather than using a glob). That list previously drifted from the real
 * sources: it referenced a non-existent `dist/logger-injection.test.js` (a
 * ghost leftover) and omitted `dist/user-agent.test.js`, so the user-agent
 * suite silently never ran in CI (a false green).
 *
 * These tests read the REAL package.json and the REAL src directory from disk
 * (no mocks) and assert the two stay in sync, so any future drift fails CI.
 */

// This file runs compiled as dist/script-coverage.test.js, so the package root
// is one directory up from the test file's location.
const packageRoot = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8')) as { scripts?: { test?: string } };

/** Test files (`src/*.test.ts`) implied by the `dist/*.test.js` args in the "test" script. */
function referencedTestSources(): string[] {
	const script = pkg.scripts?.test ?? '';
	return script
		.split(/\s+/)
		.filter((token) => /^dist\/[^/]+\.test\.js$/.test(token))
		.map((token) => token.replace(/^dist\//, '').replace(/\.js$/, '.ts'));
}

/** The real top-level `src/*.test.ts` files present on disk. */
function actualTestSources(): string[] {
	const srcDir = fileURLToPath(new URL('src/', packageRoot));
	return readdirSync(srcDir).filter((file) => file.endsWith('.test.ts'));
}

describe('package.json "test" script coverage (issue #95)', () => {
	test('does not reference test files that have no src/*.test.ts source (no ghosts)', () => {
		const actual = new Set(actualTestSources());
		const ghosts = referencedTestSources().filter((file) => !actual.has(file));
		assert.deepStrictEqual(
			ghosts,
			[],
			`"test" script references compiled test files with no matching src source: ${ghosts.join(', ')}`,
		);
	});

	test('references every src/*.test.ts file (no silently-skipped suites)', () => {
		const referenced = new Set(referencedTestSources());
		const missing = actualTestSources().filter((file) => !referenced.has(file));
		assert.deepStrictEqual(
			missing,
			[],
			`src/*.test.ts files missing from the "test" script (they would silently never run in CI): ${missing.join(', ')}`,
		);
	});
});
