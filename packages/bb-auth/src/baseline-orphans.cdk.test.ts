// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * RENAMING OR REMOVING AN `Auth` BLOCK (task D4b, later-discussion L16).
 *
 * D4's baseline is keyed by the block's `fullId` and checked by the block that
 * owns it. Rename the block (`'auth'` → `'users'`) or delete it, and nothing
 * reads the old baseline: CloudFormation deletes the pool and every user, with
 * no warning — and the deploy-time guard is removed with the last pool.
 *
 * The stack-level check in `@aws-blocks/core` (on every `BlocksStack` /
 * `BlocksBackend`) closes that: a committed baseline that records an owned
 * pool (`removalGuard`) and that no block in this stack claims fails synth.
 * Real `BlocksStack.create()` synths here, under `--conditions=cdk`, in
 * throwaway app directories.
 */

import assert from 'node:assert';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { baselineDir } from '@aws-blocks/core/cdk';
import { baselinePath } from './cdk/immutability-baseline.js';
import { type BlocksAppSynthResult, synthBlocksApp } from './test-support/blocks-app-synth.js';
import { defaultBaselineFile, freshAppDir } from './test-support/guard-synth.js';

const AUTH = "new Auth(stack, 'auth');";
const TWO = "new Auth(stack, 'auth'); new Auth(stack, 'staff');";
const POOL_LESS =
	"new Auth(stack, 'auth', { emailPassword: false, oidcProviders: { okta: { issuer: 'https://dev-1.okta.com', clientId: '0oa1' } } });";

const tempDirs: string[] = [];
after(() => {
	for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});
function appDir(): string {
	const dir = freshAppDir();
	tempDirs.push(dir);
	return dir;
}

/** Baselines written by a first synth of `build`, cached per (build, stack). */
const deployed = new Map<string, string>();
/** A fresh app dir holding the committed baselines of `build` — the state after it was deployed. */
function deployedAppDir(build: string, stack = 'TestStack'): string {
	const key = `${stack}\u0000${build}`;
	let source = deployed.get(key);
	if (!source) {
		source = appDir();
		const first = synthBlocksApp({ build, appDir: source, stack });
		assert.ok(first.ok, first.stderr);
		deployed.set(key, source);
	}
	const dir = appDir();
	mkdirSync(join(dir, 'aws-blocks'), { recursive: true });
	cpSync(join(source, 'aws-blocks', 'baselines'), join(dir, 'aws-blocks', 'baselines'), { recursive: true });
	return dir;
}

function baselines(dir: string, stack = 'TestStack'): string[] {
	const d = join(dir, 'aws-blocks', 'baselines', stack);
	return existsSync(d) ? readdirSync(d).sort() : [];
}

function assertOrphanError(result: BlocksAppSynthResult, fullId: string): void {
	assert.strictEqual(result.ok, false, 'synth must fail');
	assert.match(result.stderr, new RegExp(`no block with fullId '${fullId}' exists in this app any more`));
	assert.match(
		result.stderr,
		new RegExp(`CloudFormation will delete the Cognito user pool '${fullId}' and every user in it`),
	);
	assert.match(result.stderr, new RegExp(`Restore the old id, so its fullId is '${fullId}' again`));
	assert.match(result.stderr, /removalPolicy: 'retain'/);
	assert.match(result.stderr, new RegExp(`BLOCKS_AUTH_REBASELINE=${fullId} <your synth/deploy command>`));
	assert.match(result.stderr, /"Renaming or removing an Auth block" in the @aws-blocks\/bb-auth DESIGN\.md/);
}

describe('the baseline of a block that owns its pool carries a removal guard', () => {
	test('written next to the backend handler, in the directory core checks', () => {
		const dir = deployedAppDir(AUTH);
		const file = defaultBaselineFile(dir);
		const baseline = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
		assert.strictEqual(baseline.ownsPool, true);
		assert.deepStrictEqual(baseline.removalGuard, {
			deletes: "the Cognito user pool 'TestStack-auth' and every user in it",
			rebaselineEnv: 'BLOCKS_AUTH_REBASELINE',
			runbook: '"Renaming or removing an Auth block" in the @aws-blocks/bb-auth DESIGN.md',
		});
		const handler = join(dir, 'aws-blocks', 'index.handler.ts');
		assert.strictEqual(
			baselinePath(join(dir, 'aws-blocks'), 'TestStack', 'TestStack-auth'),
			join(baselineDir(handler, 'TestStack'), 'TestStack-auth.auth-pool.json'),
		);
	});

	test('an unchanged synth on a real BlocksStack passes (the block claims its own file)', () => {
		const result = synthBlocksApp({ build: AUTH, appDir: deployedAppDir(AUTH) });
		assert.ok(result.ok, result.stderr);
	});

	test('a pool-less block writes none', () => {
		const baseline = JSON.parse(readFileSync(defaultBaselineFile(deployedAppDir(POOL_LESS)), 'utf8')) as Record<
			string,
			unknown
		>;
		assert.strictEqual(baseline.ownsPool, false);
		assert.strictEqual('removalGuard' in baseline, false);
	});
});

describe('renaming or removing a block that owns its pool fails synth', () => {
	test("rename ('auth' → 'users') fails, naming 'TestStack-auth'", () => {
		const result = synthBlocksApp({ build: "new Auth(stack, 'users');", appDir: deployedAppDir(AUTH) });
		assertOrphanError(result, 'TestStack-auth');
	});

	test('…writes no baseline for the new id, so restoring the old id passes cleanly', () => {
		const dir = deployedAppDir(AUTH);
		const renamed = synthBlocksApp({ build: "new Auth(stack, 'users');", appDir: dir });
		assert.strictEqual(renamed.ok, false);
		assert.deepStrictEqual(baselines(dir), ['TestStack-auth.auth-pool.json']);
		const restored = synthBlocksApp({ build: AUTH, appDir: dir });
		assert.ok(restored.ok, restored.stderr);
		assert.deepStrictEqual(baselines(dir), ['TestStack-auth.auth-pool.json']);
	});

	test('removing the only Auth block fails (no Auth left, bb-auth not even imported)', () => {
		const result = synthBlocksApp({ build: '', appDir: deployedAppDir(AUTH) });
		assertOrphanError(result, 'TestStack-auth');
	});

	test('removing one of two blocks fails only for the removed one', () => {
		const result = synthBlocksApp({ build: AUTH, appDir: deployedAppDir(TWO) });
		assertOrphanError(result, 'TestStack-staff');
		assert.doesNotMatch(result.stderr, /fullId 'TestStack-auth'/);
	});

	test("another stack's baseline is ignored", () => {
		const dir = deployedAppDir(AUTH, 'OtherStack');
		assert.deepStrictEqual(baselines(dir, 'OtherStack'), ['OtherStack-auth.auth-pool.json']);
		const result = synthBlocksApp({ build: '', appDir: dir });
		assert.ok(result.ok, result.stderr);
	});

	test('removing a pool-less block (ownsPool: false) is fine', () => {
		const result = synthBlocksApp({ build: '', appDir: deployedAppDir(POOL_LESS) });
		assert.ok(result.ok, result.stderr);
	});
});

describe('the escape hatch names the fullId', () => {
	test('BLOCKS_AUTH_REBASELINE=<fullId> deletes the stale baseline and passes', () => {
		const dir = deployedAppDir(AUTH);
		const result = synthBlocksApp({ build: '', appDir: dir, env: { BLOCKS_AUTH_REBASELINE: 'TestStack-auth' } });
		assert.ok(result.ok, result.stderr);
		assert.deepStrictEqual(baselines(dir), []);
		assert.ok(
			result.infos.some((m) => m.includes("named 'TestStack-auth'") && m.includes('Commit the deletion')),
			result.infos.join('\n'),
		);
		const again = synthBlocksApp({ build: '', appDir: dir });
		assert.ok(again.ok, again.stderr);
	});

	test('…and accepts a rename deliberately: old baseline deleted, new one written', () => {
		const dir = deployedAppDir(AUTH);
		const result = synthBlocksApp({
			build: "new Auth(stack, 'users');",
			appDir: dir,
			env: { BLOCKS_AUTH_REBASELINE: 'TestStack-auth' },
		});
		assert.ok(result.ok, result.stderr);
		assert.deepStrictEqual(baselines(dir), ['TestStack-users.auth-pool.json']);
	});

	for (const value of ['1', 'true', 'TestStack', 'TestStack-users']) {
		test(`BLOCKS_AUTH_REBASELINE=${value} does not`, () => {
			const dir = deployedAppDir(AUTH);
			const result = synthBlocksApp({ build: '', appDir: dir, env: { BLOCKS_AUTH_REBASELINE: value } });
			assertOrphanError(result, 'TestStack-auth');
			assert.deepStrictEqual(baselines(dir), ['TestStack-auth.auth-pool.json']);
		});
	}
});
