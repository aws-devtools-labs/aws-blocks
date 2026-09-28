// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Synth-time co-bundle for the AgentCore Runtime code asset.
 *
 * The AgentCore process must run BOTH the developer's backend (which constructs the real
 * Agent and its tool closures) AND bb-agent's `serve()` — from a SINGLE module graph, so
 * the Agent instance registry (a module singleton in agent.ts) is shared. If the backend
 * and the entrypoint were bundled separately they'd each get their own bb-agent copy, the
 * Agent would register in one registry and the lookup would read the other, and `serve()`
 * would fail with "No Agent registered".
 *
 * We esbuild-bundle a tiny generated entry that imports both from the same graph. We call
 * `esbuild.buildSync()` DIRECTLY (not CDK's `NodejsFunction`) — that avoids the
 * `PathNotUnderRoot` failure `NodejsFunction` hits for npm-installed packages, since direct
 * esbuild has no projectRoot/lockfile requirement. `buildSync` because CDK synth is sync.
 *
 * Packaging mirrors the official `@aws/agentcore` CLI's Node CodeZip packager
 * (lib/packaging/node.js), because the AgentCore direct-deploy base image provides ONLY the
 * Node runtime — every dependency (including the AWS SDK) must be in the asset. Two wrinkles
 * the CLI solves and we copy verbatim:
 *
 *  1. The `bedrock-agentcore` harness does `createRequire(import.meta.url); require('@fastify/sse')`
 *     at module load. esbuild can't statically bundle those dynamic requires. So we emit CJS
 *     (`format: 'cjs'`), shim `import.meta.url` to a real value, and prepend a banner that
 *     patches `Module._resolveFilename` to fall back to a sibling `_deps/` dir. The dynamic
 *     packages are copied into `_deps/` so the fallback finds them at runtime.
 *  2. The `@aws-sdk/*` packages are pure JS and NOT in the base image, so we bundle them
 *     (no `external`).
 */
import { buildSync } from 'esbuild';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** bb-agent package root (dist/.. == package dir), used as esbuild's module-resolution base. */
const PKG_ROOT = join(__dirname, '..');

/** Sibling dir (next to the bundle) holding packages that are loaded via dynamic require(). */
const DEPS_DIR = '_deps';

/**
 * Packages the `bedrock-agentcore` harness (and its Fastify plugins) load via dynamic
 * `require()` at runtime, which esbuild leaves unbundled. Copied into `_deps/` and resolved
 * by the `_resolveFilename` banner below. This list is taken verbatim from the official
 * `@aws/agentcore` CLI so it stays in sync with the harness's runtime require graph.
 */
const DYNAMIC_REQUIRE_PACKAGES = [
	'@fastify/sse',
	'@fastify/websocket',
	'duplexify',
	'end-of-stream',
	'fastify-plugin',
	'inherits',
	'once',
	'readable-stream',
	'safe-buffer',
	'stream-shift',
	'string_decoder',
	'util-deprecate',
	'wrappy',
	'ws',
];

/**
 * Banner prepended to the CJS bundle. First line gives ESM-style `import.meta.url` a real
 * value (the harness calls `createRequire(import.meta.url)`); the IIFE patches Node's module
 * resolver so a failed `require('X')` retries against `__dirname/_deps/X` (reading that
 * package's `main` from its package.json). Byte-for-byte the CLI's banner.
 */
const CJS_BANNER =
	'const importMetaUrl = require("url").pathToFileURL(__filename).href;' +
	'(function(){var M=require("module"),p=require("path"),f=require("fs"),d=p.join(__dirname,"_deps"),o=M._resolveFilename;' +
	'M._resolveFilename=function(r,P,i,O){try{return o.call(this,r,P,i,O)}catch(e){' +
	'var dp=p.join(d,r);if(f.existsSync(dp)){var pk=p.join(dp,"package.json");' +
	'if(f.existsSync(pk)){var m=JSON.parse(f.readFileSync(pk,"utf8")).main||"index.js";return p.resolve(dp,m)}' +
	'return p.resolve(dp,"index.js")}throw e}};})();';

/** Copy each dynamic-require package into `<outDir>/_deps/<pkg>`, resolving via bb-agent's
 * module graph so hoisted (monorepo) and nested installs both work. */
function copyDynamicDeps(outDir: string): void {
	const require = createRequire(join(PKG_ROOT, 'noop.js'));
	for (const pkg of DYNAMIC_REQUIRE_PACKAGES) {
		let pkgDir: string;
		try {
			// Resolve the package's own package.json, then take its directory.
			pkgDir = dirname(require.resolve(`${pkg}/package.json`));
		} catch {
			// Not installed / not resolvable from here — skip; the runtime fallback only
			// needs the packages actually reached by the harness's require graph.
			continue;
		}
		if (existsSync(pkgDir)) {
			cpSync(pkgDir, join(outDir, DEPS_DIR, pkg), { recursive: true });
		}
	}
}

/**
 * Co-bundle the app backend + `serve()` into a self-contained AgentCore asset directory.
 *
 * @param backendModulePath - absolute path to the app's backend module (BlocksStack `backendCDKPath`)
 * @param outDir - directory to write the bundle into (a stable, synth-scoped path under cdk.out)
 * @returns `outDir` (contains `main.js`, `_deps/`, `package.json`), ready for `fromCodeAsset`.
 *   The bundle is named `main.js` (not `agentcore-entry.js`) because AgentCore's entrypoint
 *   validator rejects names it considers to have "multiple dots" / disallowed chars; `main.js`
 *   matches the official @aws/agentcore CLI's convention and passes.
 */
export function bundleAgentCoreAsset(backendModulePath: string, outDir: string): string {
	// Generated entry: load config, import the backend (constructs + registers the Agent),
	// then serve. `resolveDir` = bb-agent package root so `@aws-blocks/*` and this package's
	// own `serve` resolve via node_modules; the backend is imported by absolute PATH (esbuild
	// resolves paths, not file:// URLs) so it's bundled into the SAME graph and its
	// `@aws-blocks/*` deps dedupe to one instance.
	// Wrapped in an async IIFE (not top-level await) because the bundle is emitted as CJS,
	// which does not support top-level await.
	const entrySource = [
		"import { loadConfigToProcessEnv } from '@aws-blocks/core';",
		"import { serve } from '@aws-blocks/bb-agent/agentcore';",
		'(async () => {',
		'  await loadConfigToProcessEnv();',
		`  await import(${JSON.stringify(backendModulePath)});`,
		'  serve();',
		'})();',
	].join('\n');

	mkdirSync(outDir, { recursive: true });

	buildSync({
		stdin: {
			contents: entrySource,
			resolveDir: PKG_ROOT,
			sourcefile: '__agentcore_entry.mjs',
			loader: 'js',
		},
		outfile: join(outDir, 'main.js'),
		bundle: true,
		platform: 'node',
		target: 'node22',
		// CJS (not ESM) so the harness's createRequire + our _resolveFilename patch work.
		format: 'cjs',
		minify: true,
		// Resolve @aws-blocks/* (and the backend's BB constructions) to their AWS-runtime
		// variants, exactly as core bundles the Lambda handler.
		conditions: ['aws-runtime', 'node'],
		banner: { js: CJS_BANNER },
		// Give ESM `import.meta.url` (used by the harness) a real value under CJS output.
		define: { 'import.meta.url': 'importMetaUrl' },
	});

	// `{"type":"commonjs"}` so Node treats the .js bundle as CJS regardless of any ambient
	// "type":"module" in a parent package.json.
	writeFileSync(join(outDir, 'package.json'), '{"type":"commonjs"}');

	// Ship the harness's dynamic-require closure alongside the bundle.
	copyDynamicDeps(outDir);

	return outDir;
}
