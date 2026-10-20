// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Synth-time co-bundle for the container compute's code asset.
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
 * ─── No local Docker ────────────────────────────────────────────────────────
 * The output dir is NOT a Docker build context — it is an **S3 asset** directory
 * (`main.js` the CJS parent bundle, `worker.js` the per-job worker bundle,
 * `bootstrap.mjs` the dependency-free fetch-and-run entry). The container runs a
 * stock public Node image directly (`fromRegistry`, no image build), and a task
 * command override runs `bootstrap.mjs`, which downloads `main.js`/`worker.js`
 * from this asset's S3 location at boot and execs them. Nothing here needs the
 * Docker daemon — synth only shells out to esbuild. See `index.cdk.ts` for how
 * the asset + command override are wired, and `bootstrap.mjs` for the fetch.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { buildSync } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** bb-container-compute package root (dist/.. == package dir), esbuild's resolution base. */
const PKG_ROOT = join(__dirname, '..');

/**
 * `import.meta.url` shim for the CJS bundle: any transitively-bundled code that
 * reads `import.meta.url` (e.g. a `fileURLToPath(import.meta.url)`) resolves to a
 * real path instead of throwing under CommonJS output.
 */
const CJS_BANNER = 'const importMetaUrl = require("url").pathToFileURL(__filename).href;';

/**
 * Co-bundle the app backend + `runContainer()` into a self-contained S3 asset
 * directory (not a Docker build context).
 *
 * @param backendModulePath - absolute path to the app's backend module (the
 *   BlocksStack/BlocksBackend `backendCDKPath`). Imported by absolute PATH (not a
 *   `file://` URL — esbuild resolves paths) so it lands in the SAME module graph
 *   and its `@aws-blocks/*` deps dedupe to one instance.
 * @param outDir - directory to write the asset into (a stable, synth-scoped path
 *   under `cdk.out`), uploaded as-is by `aws-s3-assets.Asset`.
 * @returns `outDir`, ready to hand to `new s3assets.Asset({ path: outDir })`.
 */
export function bundleContainerAsset(backendModulePath: string, outDir: string): string {
	mkdirSync(outDir, { recursive: true });

	const shared = {
		bundle: true,
		platform: 'node',
		target: 'node24',
		format: 'cjs',
		minify: true,
		// Resolve @aws-blocks/* (and the backend's BB constructions) to their
		// AWS-runtime variants, exactly as core bundles the Lambda handler.
		conditions: ['aws-runtime', 'node'],
		banner: { js: CJS_BANNER },
		define: { 'import.meta.url': 'importMetaUrl' },
	} satisfies Partial<Parameters<typeof buildSync>[0]>;

	// ── Parent entry (main.js) ──────────────────────────────────────────────
	// Loads config, points the runtime at the worker bundle it will spawn per
	// job, imports the backend (constructs + registers every BB and its pollers),
	// then runs the parent loop. Wrapped in an async IIFE (CJS has no TLA).
	const mainEntry = [
		"import { loadConfigToProcessEnv, runContainer } from '@aws-blocks/core';",
		'(async () => {',
		'  await loadConfigToProcessEnv();',
		// Absolute in-image path to the co-bundled worker; dispatchJobToWorker reads this.
		// bootstrap.mjs writes both bundles here before exec, so the path is stable.
		"  process.env.BLOCKS_JOB_WORKER_ENTRY = '/app/worker.js';",
		`  await import(${JSON.stringify(backendModulePath)});`,
		'  await runContainer();',
		'})();',
	].join('\n');

	buildSync({
		stdin: { contents: mainEntry, resolveDir: PKG_ROOT, sourcefile: '__container_main.mjs', loader: 'js' },
		outfile: join(outDir, 'main.js'),
		...shared,
	});

	// ── Job worker entry (worker.js) ────────────────────────────────────────
	// Spawned per job by the parent. Loads config, re-imports the backend (so the
	// AsyncJob registers itself and its handler closure is reconstructed in this
	// thread), then runs the single job the parent handed it via workerData,
	// resolving the handler by fullId from the AsyncJob registry.
	const workerEntry = [
		"import { loadConfigToProcessEnv, runJobWorker } from '@aws-blocks/core';",
		"import { getAsyncJob } from '@aws-blocks/bb-async-job/job-registry';",
		'(async () => {',
		'  await loadConfigToProcessEnv();',
		`  await import(${JSON.stringify(backendModulePath)});`,
		'  await runJobWorker(getAsyncJob);',
		'})();',
	].join('\n');

	buildSync({
		stdin: { contents: workerEntry, resolveDir: PKG_ROOT, sourcefile: '__container_worker.mjs', loader: 'js' },
		outfile: join(outDir, 'worker.js'),
		...shared,
	});

	// `{"type":"commonjs"}` so Node treats the .js bundles as CJS regardless of any
	// ambient "type":"module" in a parent package.json.
	writeFileSync(join(outDir, 'package.json'), '{"type":"commonjs"}');

	// Ship the fetch-and-run bootstrap alongside the bundles. It is a committed,
	// dependency-free ESM script (see bootstrap.mjs) — copied verbatim so the
	// container's command override can run it from the pulled asset. No esbuild:
	// it must use ONLY Node built-ins (no @aws-blocks/*, no SDK), because it runs
	// before the app bundles exist on disk.
	copyFileSync(join(PKG_ROOT, 'src', 'bootstrap.mjs'), join(outDir, 'bootstrap.mjs'));

	return outDir;
}
