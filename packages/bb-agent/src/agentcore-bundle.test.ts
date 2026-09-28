// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the synth-time AgentCore co-bundle (`bundleAgentCoreAsset`).
 *
 * The CDK tests bypass this path (they pass a pre-built `agentcoreAssetPath`), so without this
 * test the intricate esbuild co-bundle — the CJS banner, the `import.meta.url` shim, the `_deps/`
 * dynamic-require copy, and the `{"type":"commonjs"}` marker — is only ever exercised by a sandbox
 * e2e deploy. This runs the real bundler over a trivial fixture backend and asserts the asset's
 * structure, so regressions in the bundle shape fail in CI rather than silently at deploy time.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleAgentCoreAsset } from './agentcore-bundle.js';

test('bundleAgentCoreAsset co-bundles a backend into a CJS AgentCore asset', () => {
	const workDir = mkdtempSync(join(tmpdir(), 'bb-agent-bundle-'));
	try {
		// A trivial backend module — bundling is static, so it only needs to be a resolvable
		// module the generated entry can `import()` by absolute path.
		const backendPath = join(workDir, 'backend.js');
		writeFileSync(backendPath, 'export const __fixture = true;\n');

		const outDir = join(workDir, 'asset');
		mkdirSync(outDir, { recursive: true });

		const result = bundleAgentCoreAsset(backendPath, outDir);
		assert.strictEqual(result, outDir, 'returns the output directory');

		// main.js — the CJS bundle, with the harness banner (createRequire shim + _resolveFilename patch).
		const mainPath = join(outDir, 'main.js');
		assert.ok(existsSync(mainPath), 'emits main.js');
		const main = readFileSync(mainPath, 'utf-8');
		assert.ok(main.length > 0, 'main.js is non-empty');
		assert.ok(main.includes('_resolveFilename'), 'main.js carries the _deps resolver banner');
		assert.ok(main.includes('importMetaUrl'), 'main.js carries the import.meta.url shim');

		// package.json — forces Node to treat the .js bundle as CommonJS.
		assert.strictEqual(readFileSync(join(outDir, 'package.json'), 'utf-8'), '{"type":"commonjs"}');

		// _deps/ — the harness's dynamic-require closure copied alongside the bundle.
		const depsDir = join(outDir, '_deps');
		assert.ok(existsSync(depsDir), 'emits the _deps/ dynamic-require dir');
		assert.ok(readdirSync(depsDir).length > 0, '_deps/ contains the copied packages');
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
});
