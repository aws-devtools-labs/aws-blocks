// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Tests for scripts/ci/hosting-e2e-sandbox.ts, the Playwright globalSetup of
// the hosting E2E apps, with stub `test/sandbox-deploy.ts` and
// `test/sandbox-destroy.ts` scripts that only log (no AWS).
//
// Run: npx tsx --test scripts/ci/hosting-e2e-sandbox.test.ts

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { FullConfig } from '@playwright/test';
import globalSetup from './hosting-e2e-sandbox.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const setupFile = join(here, 'hosting-e2e-sandbox.ts');
const HOSTING_APPS = [
	'hosting-preview',
	'hosting-spa',
	'hosting-ssr',
	'hosting-ssr-astro',
	'hosting-ssr-astro-default404',
	'hosting-ssr-nuxt',
	'hosting-ssr-sveltekit',
];

const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A stand-in app: stub deploy/destroy scripts that append to `calls.log`. The
 * deploy writes `.blocks-sandbox/outputs.json` like a real deploy, or fails
 * when STUB_DEPLOY_FAIL is set; the destroy fails when STUB_DESTROY_FAIL is set.
 * node_modules links to the repo's, so `npx tsx` and `@playwright/test` resolve.
 */
function stubApp(): string {
	const root = mkdtempSync(join(tmpdir(), 'hosting-e2e-sandbox-'));
	roots.push(root);
	mkdirSync(join(root, 'test'));
	mkdirSync(join(root, 'aws-blocks'));
	symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
	writeFileSync(join(root, 'package.json'), '{ "private": true, "type": "module" }\n');
	writeFileSync(join(root, 'aws-blocks', 'index.cdk.ts'), '');
	writeFileSync(
		join(root, 'test', 'sandbox-deploy.ts'),
		[
			"import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';",
			"appendFileSync('calls.log', `deploy ${process.argv[2]} NODE_OPTIONS=${JSON.stringify(process.env.NODE_OPTIONS)}\\n`);",
			"if (process.env.STUB_DEPLOY_FAIL) { console.error('stub deploy failed'); process.exit(1); }",
			"mkdirSync('.blocks-sandbox', { recursive: true });",
			"writeFileSync('.blocks-sandbox/outputs.json', JSON.stringify({ stack: { HostingHostingUrlABC: 'd123.cloudfront.net' } }));",
		].join('\n'),
	);
	writeFileSync(
		join(root, 'test', 'sandbox-destroy.ts'),
		[
			"import { appendFileSync } from 'node:fs';",
			"appendFileSync('calls.log', 'destroy\\n');",
			"if (process.env.STUB_DESTROY_FAIL) { console.error('stub destroy failed'); process.exit(1); }",
		].join('\n'),
	);
	return root;
}

/** The stub scripts' calls, in order: `deploy`, `destroy`, `beforeAll …`, `test …`. */
function calls(root: string): string[] {
	const file = join(root, 'calls.log');
	return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
}

/** Run `fn` with these environment variables set (undefined deletes), then restore them. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
	const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
	for (const [k, v] of Object.entries(vars)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		return await fn();
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

/** A FullConfig with only the field the setup reads. */
const configFor = (root: string) => ({ configFile: join(root, 'playwright.config.ts') }) as FullConfig;

describe('hosting E2E globalSetup, called directly', () => {
	it('deploys nothing outside sandbox mode', async () => {
		const root = stubApp();
		const teardown = await withEnv({ BLOCKS_TEST_ENV: 'local', BLOCKS_SANDBOX_KEEP: undefined }, () =>
			globalSetup(configFor(root)),
		);
		assert.equal(teardown, undefined);
		assert.deepEqual(calls(root), []);
	});

	it('deploys once with the app backend, and its teardown destroys', async () => {
		const root = stubApp();
		const backend = join(root, 'aws-blocks', 'index.cdk.ts');
		await withEnv({ BLOCKS_TEST_ENV: 'sandbox', BLOCKS_SANDBOX_KEEP: undefined, NODE_OPTIONS: '--no-warnings' }, () => {
			const teardown = globalSetup(configFor(root));
			assert.deepEqual(calls(root), [`deploy ${backend} NODE_OPTIONS=""`], 'one deploy, without the parent NODE_OPTIONS');
			assert.ok(teardown);
			teardown();
		});
		assert.deepEqual(calls(root), [`deploy ${backend} NODE_OPTIONS=""`, 'destroy']);
	});

	it('keeps the stack with BLOCKS_SANDBOX_KEEP', async () => {
		const root = stubApp();
		await withEnv({ BLOCKS_TEST_ENV: 'sandbox', BLOCKS_SANDBOX_KEEP: '1' }, () => globalSetup(configFor(root))?.());
		assert.deepEqual(
			calls(root).map((c) => c.split(' ')[0]),
			['deploy'],
		);
	});

	it('destroys after a failed deploy and rethrows the deploy error', async () => {
		const root = stubApp();
		await withEnv({ BLOCKS_TEST_ENV: 'sandbox', BLOCKS_SANDBOX_KEEP: undefined, STUB_DEPLOY_FAIL: '1' }, () =>
			assert.throws(() => globalSetup(configFor(root)), /Command failed: npx tsx test\/sandbox-deploy\.ts/),
		);
		assert.deepEqual(
			calls(root).map((c) => c.split(' ')[0]),
			['deploy', 'destroy'],
		);
	});

	it('keeps the deploy error when the destroy after it fails too', async () => {
		const root = stubApp();
		await withEnv(
			{ BLOCKS_TEST_ENV: 'sandbox', BLOCKS_SANDBOX_KEEP: undefined, STUB_DEPLOY_FAIL: '1', STUB_DESTROY_FAIL: '1' },
			() => assert.throws(() => globalSetup(configFor(root)), /sandbox-deploy\.ts/),
		);
		assert.deepEqual(
			calls(root).map((c) => c.split(' ')[0]),
			['deploy', 'destroy'],
		);
	});

	it('leaves the stack after a failed deploy with BLOCKS_SANDBOX_KEEP', async () => {
		const root = stubApp();
		await withEnv({ BLOCKS_TEST_ENV: 'sandbox', BLOCKS_SANDBOX_KEEP: '1', STUB_DEPLOY_FAIL: '1' }, () =>
			assert.throws(() => globalSetup(configFor(root))),
		);
		assert.deepEqual(
			calls(root).map((c) => c.split(' ')[0]),
			['deploy'],
		);
	});
});

describe('hosting E2E globalSetup, under Playwright', () => {
	/**
	 * Write a suite shaped like the hosting suites (a serial group whose
	 * `beforeAll` reads the deployed URL from outputs.json) whose second test
	 * fails on the first attempt only, then run `playwright test` on it.
	 */
	function runSuite(env: Record<string, string>) {
		const root = stubApp();
		writeFileSync(
			join(root, 'playwright.config.ts'),
			[
				"import { defineConfig } from '@playwright/test';",
				'export default defineConfig({',
				"  testDir: './test',",
				"  testMatch: '**/*.test.ts',",
				`  globalSetup: ${JSON.stringify(setupFile)},`,
				'  retries: 1,',
				'  workers: 1,',
				"  reporter: 'line',",
				'});',
			].join('\n'),
		);
		writeFileSync(
			join(root, 'test', 'e2e.test.ts'),
			[
				"import { test, expect } from '@playwright/test';",
				"import { appendFileSync, readFileSync } from 'node:fs';",
				'let hostingUrl = "";',
				'test.beforeAll(() => {',
				"  const outputs = JSON.parse(readFileSync('.blocks-sandbox/outputs.json', 'utf-8'));",
				'  const stack = Object.values(outputs)[0] as Record<string, string>;',
				"  hostingUrl = `https://${stack[Object.keys(stack).find((k) => k.startsWith('HostingHostingUrl'))!]}`;",
				"  appendFileSync('calls.log', `beforeAll ${hostingUrl}\\n`);",
				'});',
				"test.describe('journey', () => {",
				"  test.describe.configure({ mode: 'serial' });",
				"  test('create', async ({}, testInfo) => { appendFileSync('calls.log', `test create retry=${testInfo.retry}\\n`); });",
				"  test('check', async ({}, testInfo) => {",
				"    appendFileSync('calls.log', `test check retry=${testInfo.retry}\\n`);",
				'    expect(testInfo.retry, "fails on the first attempt only").toBe(1);',
				'  });',
				'});',
			].join('\n'),
		);
		const run = spawnSync('npx', ['playwright', 'test'], {
			cwd: root,
			encoding: 'utf8',
			// No BLOCKS_SANDBOX_KEEP, so the teardown destroys; no NODE_OPTIONS from this tsx runner.
			env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'BLOCKS_SANDBOX_KEEP' && k !== 'NODE_OPTIONS')), ...env },
		});
		return { root, run };
	}

	it('deploys once; the retry runs in a new worker against the same deployed stack', () => {
		const { root, run } = runSuite({ BLOCKS_TEST_ENV: 'sandbox' });
		assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
		assert.match(run.stdout, /1 flaky/);
		const log = calls(root).map((c) => c.replace(/ \S+aws-blocks\/index\.cdk\.ts.*$/, ''));
		assert.deepEqual(log, [
			'deploy',
			'beforeAll https://d123.cloudfront.net',
			'test create retry=0',
			'test check retry=0',
			'beforeAll https://d123.cloudfront.net',
			'test create retry=1',
			'test check retry=1',
			'destroy',
		]);
	});

	it('fails a run whose deploy fails before any test, and destroys what it started', () => {
		const { root, run } = runSuite({ BLOCKS_TEST_ENV: 'sandbox', STUB_DEPLOY_FAIL: '1' });
		assert.notEqual(run.status, 0);
		assert.deepEqual(
			calls(root).map((c) => c.split(' ')[0]),
			['deploy', 'destroy'],
		);
	});
});

describe('hosting E2E apps', () => {
	for (const app of HOSTING_APPS) {
		it(`${app} deploys from this globalSetup`, async () => {
			const configPath = join(repoRoot, 'test-apps', app, 'playwright.config.ts');
			// Dynamic: one config per app in the loop.
			const config = (await import(configPath)).default as { globalSetup?: string };
			assert.equal(join(dirname(configPath), config.globalSetup ?? ''), setupFile);
			// The suites read the deployed stack; none deploys or destroys itself.
			const suite = readFileSync(join(repoRoot, 'test-apps', app, 'test', 'e2e.test.ts'), 'utf8');
			assert.doesNotMatch(suite, /sandbox-(deploy|destroy)\.ts/);
		});
	}
});
