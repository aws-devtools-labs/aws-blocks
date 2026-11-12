// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The test-support secret is a random value made fresh for each e2e run and
 * passed to everything in the run through `BLOCKS_TEST_SUPPORT_SECRET` — the CI
 * workflow generates it (masked), or the harness does. Nothing reads it back
 * from AWS, so the CI role needs no SSM access for it.
 *
 * Offline proof, no AWS: the harness helpers keep a value CI set and generate
 * one otherwise, and the backend module refuses to load as an e2e build without
 * one. Each case runs in its own process, because the backend reads the
 * environment when it loads.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Run `code` (an ES module body) with tsx in the app root and return its stdout. */
function runModule(code: string, env: NodeJS.ProcessEnv): string {
	return execFileSync('npx', ['tsx', '--input-type=module', '-e', code], {
		cwd: APP_ROOT,
		env: { ...process.env, NODE_OPTIONS: '', ...env },
		encoding: 'utf-8',
	}).trim();
}

const HELPERS = `import { ensureTestSupportSecret, readTestSupportSecret } from './test/test-support.ts';`;

describe('test-support secret: per-run, from the environment', () => {
	test('a value the CI workflow set is kept as is', () => {
		const ci = 'a'.repeat(64);
		const out = runModule(
			`${HELPERS} ensureTestSupportSecret(); console.log((await readTestSupportSecret()) === process.env.EXPECTED);`,
			{ BLOCKS_TEST_SUPPORT_SECRET: ci, EXPECTED: ci },
		);
		assert.strictEqual(out, 'true');
	});

	test('without one, the harness generates 32 random bytes (hex), different each run', () => {
		const shape = (): string =>
			runModule(
				`${HELPERS} ensureTestSupportSecret(); const v = await readTestSupportSecret(); console.log(/^[0-9a-f]{64}$/.test(v) ? v : 'BAD');`,
				{ BLOCKS_TEST_SUPPORT_SECRET: '' },
			);
		const a = shape();
		const b = shape();
		assert.match(a, /^[0-9a-f]{64}$/);
		assert.notStrictEqual(a, b, 'each run gets its own secret');
	});

	test('reading it before it is set fails with the reason, and no secret', () => {
		const out = runModule(
			`${HELPERS} try { await readTestSupportSecret(); console.log('read'); } catch (e) { console.log(e.message); }`,
			{ BLOCKS_TEST_SUPPORT_SECRET: '' },
		);
		assert.match(out, /BLOCKS_TEST_SUPPORT_SECRET is not set/);
	});

	test('the backend refuses to load as an e2e build without a secret', () => {
		const result = spawnSync('npx', ['tsx', '--input-type=module', '-e', `await import('./aws-blocks/index.ts');`], {
			cwd: APP_ROOT,
			env: { ...process.env, NODE_OPTIONS: '', BLOCKS_TEST_ENV: 'local', BLOCKS_TEST_SUPPORT_SECRET: '' },
			encoding: 'utf-8',
		});
		assert.notStrictEqual(result.status, 0, 'the backend loaded without a secret');
		assert.match(result.stderr, /BLOCKS_TEST_SUPPORT_SECRET is\s+missing or shorter than 32 characters/);
	});
});
