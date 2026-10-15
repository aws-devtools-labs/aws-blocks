// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression test: conditional export entries must not drop named exports.
 *
 * TypeScript cannot type-check custom conditions like "cdk" or "aws-runtime" —
 * it always resolves the "types" key. This test actually loads entry points
 * under each condition and compares their named exports to catch drift.
 *
 * Every BB is checked under both "aws-runtime" (the Lambda bundle) and "cdk"
 * (`cdk synth` loads the backend module under it, so a missing export crashes
 * synth at import time).
 *
 * BB packages are discovered automatically — any package under packages/ whose
 * exports["."] has an "aws-runtime" condition is treated as a Building Block.
 *
 * Run: node --test dist/conditional-exports.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Discovery ───────────────────────────────────────────────────────────────

const packagesDir = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'packages');

function discoverBBPackages(): string[] {
	const dirs = readdirSync(packagesDir, { withFileTypes: true })
		.filter(d => d.isDirectory() && d.name.startsWith('bb-'));
	const result: string[] = [];
	for (const dir of dirs) {
		try {
			const pkg = JSON.parse(readFileSync(join(packagesDir, dir.name, 'package.json'), 'utf-8'));
			if (pkg.exports?.['.']?.['aws-runtime']) result.push(pkg.name);
		} catch {}
	}
	return result.sort();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const getExports = (pkg: string, conditions: string[]) => {
	const flags = conditions.flatMap(c => ['--conditions', c]);
	const script = `import('${pkg}').then(m => console.log(JSON.stringify(Object.keys(m))))`;
	const out = execFileSync('node', [...flags, '--input-type=module', '-e', script], { encoding: 'utf-8' });
	return new Set(JSON.parse(out.trim()) as string[]);
};

const assertSuperset = (pkg: string, condition: string) => {
	const defaultNames = getExports(pkg, []);
	const conditionNames = getExports(pkg, [condition]);

	defaultNames.delete('default');
	conditionNames.delete('default');

	const missing = [...defaultNames].filter(n => !conditionNames.has(n));

	assert.deepStrictEqual(
		missing,
		[],
		`${pkg} "${condition}" entry is missing exports:\n  ${missing.join(', ')}\n\n` +
		`Add these to the ${condition} entry file.`,
	);
};

// ── Umbrella package ────────────────────────────────────────────────────────

test('umbrella: cdk exports match default', () => {
	assertSuperset('@aws-blocks/blocks', 'cdk');
});

// ── BB packages: aws-runtime (auto-discovered) ─────────────────────────────

const bbPackages = discoverBBPackages();

test('discovery sanity check', () => {
	assert.ok(bbPackages.length >= 8, `Expected ≥8 BB packages, found ${bbPackages.length}: ${bbPackages.join(', ')}`);
	for (const expected of ['@aws-blocks/bb-kv-store', '@aws-blocks/bb-distributed-table', '@aws-blocks/bb-data']) {
		assert.ok(bbPackages.includes(expected), `Expected to discover ${expected}`);
	}
});

for (const pkg of bbPackages) {
	test(`${pkg}: aws-runtime exports match default`, () => {
		assertSuperset(pkg, 'aws-runtime');
	});
}

// ── BB packages: cdk (auto-discovered) ──────────────────────────────────────
// `cdk synth` loads the whole backend module under --conditions=cdk, so an export
// the default entry has but the cdk entry lacks crashes synth at import time.

for (const pkg of bbPackages) {
	test(`${pkg}: cdk exports match default`, () => {
		assertSuperset(pkg, 'cdk');
	});
}
