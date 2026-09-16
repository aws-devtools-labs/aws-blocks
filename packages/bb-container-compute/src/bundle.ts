// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Synth-time co-bundle for the container compute's image asset.
 *
 * The container process must run BOTH the developer's backend (which constructs
 * the real Building Blocks and their handler closures) AND core's
 * `runContainer()` entry — from a SINGLE module graph, so every BB's module
 * singletons (the event-handler map, the SDK-identifier registry) are shared.
 * Bundled separately they'd each get their own `@aws-blocks/core` copy, a job's
 * handler would register in one map and the poller would read the other, and no
 * job would ever run.
 *
 * We esbuild-bundle a tiny generated entry that imports both from the same
 * graph, resolving `@aws-blocks/*` to their `aws-runtime` variants exactly as
 * core bundles the Lambda handler. `esbuild.buildSync()` is called directly
 * (not via CDK's `NodejsFunction`) to avoid the `PathNotUnderRoot` failure it
 * hits for npm-installed packages; `buildSync` because CDK synth is synchronous.
 *
 * The output dir is a Docker build context: `main.js` (the CJS bundle),
 * `package.json` (`{"type":"commonjs"}`), and a `Dockerfile` on a slim Node base
 * image that just runs `node main.js`. All JS (including the AWS SDK) is bundled
 * into `main.js`, so the image needs no `npm install` — a single-COPY, single-CMD
 * Dockerfile keeps the build fast and hermetic.
 */
import { buildSync } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** bb-container-compute package root (dist/.. == package dir), esbuild's resolution base. */
const PKG_ROOT = join(__dirname, '..');

/**
 * Node base image for the container. Slim Debian variant of the same Node major
 * the Lambda runtime targets (22), so runtime behavior matches the function path.
 */
const NODE_BASE_IMAGE = 'public.ecr.aws/docker/library/node:22-slim';

/**
 * `import.meta.url` shim for the CJS bundle: any transitively-bundled code that
 * reads `import.meta.url` (e.g. a `fileURLToPath(import.meta.url)`) resolves to a
 * real path instead of throwing under CommonJS output.
 */
const CJS_BANNER = 'const importMetaUrl = require("url").pathToFileURL(__filename).href;';

/**
 * Co-bundle the app backend + `runContainer()` into a self-contained Docker build
 * context directory.
 *
 * @param backendModulePath - absolute path to the app's backend module (the
 *   BlocksStack/BlocksBackend `backendCDKPath`). Imported by absolute PATH (not a
 *   `file://` URL — esbuild resolves paths) so it lands in the SAME module graph
 *   and its `@aws-blocks/*` deps dedupe to one instance.
 * @param outDir - directory to write the build context into (a stable,
 *   synth-scoped path under `cdk.out`).
 * @returns `outDir`, ready to hand to `ecs.ContainerImage.fromAsset`.
 */
export function bundleContainerAsset(backendModulePath: string, outDir: string): string {
	// Generated entry: load config into process.env, import the backend (which
	// constructs + registers every BB and its handlers), then start the container
	// runtime (self-starts owned pollers). Wrapped in an async IIFE because the
	// bundle is emitted as CJS, which has no top-level await.
	const entrySource = [
		"import { loadConfigToProcessEnv, runContainer } from '@aws-blocks/core';",
		'(async () => {',
		'  await loadConfigToProcessEnv();',
		`  await import(${JSON.stringify(backendModulePath)});`,
		'  await runContainer();',
		'})();',
	].join('\n');

	mkdirSync(outDir, { recursive: true });

	buildSync({
		stdin: {
			contents: entrySource,
			resolveDir: PKG_ROOT,
			sourcefile: '__container_entry.mjs',
			loader: 'js',
		},
		outfile: join(outDir, 'main.js'),
		bundle: true,
		platform: 'node',
		target: 'node22',
		format: 'cjs',
		minify: true,
		// Resolve @aws-blocks/* (and the backend's BB constructions) to their
		// AWS-runtime variants, exactly as core bundles the Lambda handler.
		conditions: ['aws-runtime', 'node'],
		banner: { js: CJS_BANNER },
		define: { 'import.meta.url': 'importMetaUrl' },
	});

	// `{"type":"commonjs"}` so Node treats the .js bundle as CJS regardless of any
	// ambient "type":"module" in a parent package.json.
	writeFileSync(join(outDir, 'package.json'), '{"type":"commonjs"}');

	// Minimal Docker build context: copy the bundle + package.json onto a slim
	// Node base and run it. No `npm install` — every dependency is inlined into
	// main.js by esbuild above, so the image build is a single COPY.
	const dockerfile = [
		`FROM ${NODE_BASE_IMAGE}`,
		'WORKDIR /app',
		'COPY main.js package.json ./',
		// Run as the built-in non-root `node` user (present in the official image).
		'USER node',
		'CMD ["node", "main.js"]',
		'',
	].join('\n');
	writeFileSync(join(outDir, 'Dockerfile'), dockerfile);

	return outDir;
}
