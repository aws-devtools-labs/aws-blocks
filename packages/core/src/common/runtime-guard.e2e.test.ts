// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Package-level test for {@link assertNotMockInDeployedEnv}: instead of calling
 * the guard directly (see `runtime-guard.test.ts`), it imports a real, built
 * Building Block (`@aws-blocks/bb-kv-store`) in a child `node` process and
 * lets npm conditional-export resolution pick the entry, exactly as a
 * deployed artifact would.
 *
 * Requires a prior workspace build: `bb-kv-store`'s `dist/` must exist (the
 * repo's `npm run build` builds every package before tests run). The package
 * is resolved through the workspace symlink in the repo-root `node_modules`.
 * If it cannot be resolved at all, the cases are skipped rather than failed —
 * unless `BLOCKS_REQUIRE_RUNTIME_GUARD_E2E=1` is set (CI sets it), in which
 * case an unresolvable or unloadable package fails the suite so a rename
 * cannot silently drop this test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const BB_PACKAGE = '@aws-blocks/bb-kv-store';
const IMPORT_SCRIPT = `await import('${BB_PACKAGE}');`;

// Run children from this package so resolution walks up to the repo-root
// node_modules, independent of the test runner's cwd.
const CHILD_CWD = dirname(fileURLToPath(import.meta.url));

/** Base env for children: the parent env minus the deployed-env signal. */
function baseEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.BLOCKS_CONFIG_BUCKET;
	delete env.BLOCKS_CONFIG_KEY;
	// Keep NODE_OPTIONS from injecting a different --conditions set.
	delete env.NODE_OPTIONS;
	return env;
}

const DEPLOYED_ENV: NodeJS.ProcessEnv = {
	...baseEnv(),
	BLOCKS_CONFIG_BUCKET: 'test-bucket',
	BLOCKS_CONFIG_KEY: 'test-key',
};

/** Import the BB in a fresh `node` process with the given conditions and env. */
function importInChild(conditions: string[], env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
	return spawnSync(
		process.execPath,
		[...conditions.map((c) => `--conditions=${c}`), '--input-type=module', '-e', IMPORT_SCRIPT],
		{ cwd: CHILD_CWD, env, encoding: 'utf8', timeout: 30_000 },
	);
}

/** Skip reason when the package itself is not resolvable / not built. */
function unresolvableReason(): string | undefined {
	const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `import.meta.resolve('${BB_PACKAGE}');`], {
		cwd: CHILD_CWD,
		env: baseEnv(),
		encoding: 'utf8',
		timeout: 30_000,
	});
	if (probe.status !== 0) {
		return `${BB_PACKAGE} is not resolvable from ${CHILD_CWD}; build the workspace first (npm run build).`;
	}
	const load = importInChild([], baseEnv());
	if (load.status !== 0 && /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(load.stderr)) {
		return `${BB_PACKAGE} could not be loaded (module not found); build the workspace first (npm run build).`;
	}
	return undefined;
}

/** CI sets this so an unresolvable BB fails the suite instead of skipping it. */
const REQUIRE_E2E = process.env.BLOCKS_REQUIRE_RUNTIME_GUARD_E2E === '1';

const unresolvable = unresolvableReason();
const skipReason = REQUIRE_E2E ? undefined : unresolvable;

describe('runtime guard through a built BB entry', { concurrency: 1, skip: skipReason }, () => {
	if (REQUIRE_E2E) {
		it('the BB entry is resolvable and loadable (BLOCKS_REQUIRE_RUNTIME_GUARD_E2E=1)', () => {
			assert.equal(unresolvable, undefined, unresolvable);
		});
	}

	it('mock entry fails to load in a deployed env without the aws-runtime condition', () => {
		const result = importInChild([], DEPLOYED_ENV);
		assert.notEqual(result.status, 0, `expected non-zero exit; stderr:\n${result.stderr}`);
		// The hard assertion is the name-independent `deployed environment` text.
		// The specific BB name is intentionally not asserted: bb-kv-store's mock
		// entry statically imports @aws-blocks/bb-logger, and ESM evaluates that
		// import first, so a nested BB's guard can fire before bb-kv-store's (see
		// the load-order note on assertNotMockInDeployedEnv).
		assert.ok(
			result.stderr.includes('deployed environment'),
			`expected guard message; stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes('mock entry'),
			`expected mock-guard message; stderr:\n${result.stderr}`,
		);
		// Informational only: report which BB's guard surfaced first.
		const firedBb = /Error: A Building Block mock entry \(first detected: ([^)]+)\)/.exec(result.stderr)?.[1];
		console.log(`runtime guard fired for: ${firedBb ?? 'unknown'}`);
	});

	it('aws-runtime entry loads in a deployed env with --conditions=aws-runtime', () => {
		const result = importInChild(['aws-runtime'], DEPLOYED_ENV);
		assert.equal(result.status, 0, `expected exit 0; stderr:\n${result.stderr}`);
	});

	it('esbuild bundle built without the aws-runtime condition fails in a deployed env', async () => {
		// Same mis-bundle as above, but through esbuild's resolver (default
		// conditions) rather than Node's, mirroring a customer-owned build.
		const out = await build({
			stdin: {
				contents: `import { KVStore } from '${BB_PACKAGE}'; globalThis.__bb = KVStore;`,
				resolveDir: CHILD_CWD,
				loader: 'js',
			},
			bundle: true,
			platform: 'node',
			format: 'esm',
			write: false,
			logLevel: 'silent',
			// Bundled CJS deps may call require(); give the ESM bundle one.
			banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
		});
		const dir = mkdtempSync(join(tmpdir(), 'runtime-guard-e2e-'));
		try {
			const bundle = join(dir, 'bundle.mjs');
			writeFileSync(bundle, out.outputFiles[0].text);
			const result = spawnSync(process.execPath, [bundle], {
				cwd: dir,
				env: DEPLOYED_ENV,
				encoding: 'utf8',
				timeout: 30_000,
			});
			assert.notEqual(result.status, 0, `expected non-zero exit; stderr:\n${result.stderr}`);
			assert.ok(
				result.stderr.includes('mock entry') && result.stderr.includes('deployed environment'),
				`expected mock-guard message; stderr:\n${result.stderr}`,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('mock entry loads in local dev (no deployed-env variables, no conditions)', () => {
		const result = importInChild([], baseEnv());
		assert.equal(result.status, 0, `expected exit 0; stderr:\n${result.stderr}`);
	});
});
