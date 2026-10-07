// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bundle the `blocks` bin and the generate-client worker into self-contained
 * ESM files, inlining the `@aws-blocks/*` libraries so the published
 * `@aws-blocks/cli` tarball carries no `@aws-blocks/*` runtime dependencies.
 *
 * This mirrors how `aws-cdk` ships: the CLI keeps importing the real library
 * seam (`@aws-blocks/core/runtime`, `@aws-blocks/hosting`, `@aws-blocks/blocks/client`)
 * in source, and the dependency closure is folded into the artifact at publish
 * time rather than installed alongside it. Nothing is forked or duplicated.
 *
 * Run AFTER `tsc --build` has produced the full typed `dist/` (the `.d.ts`
 * files, `dist/index.js` for programmatic consumers, and the compiled test
 * files the node:test runner loads). esbuild then OVERWRITES exactly two of
 * those outputs with bundled equivalents:
 *   - dist/blocks.js                    (the bin; keeps its shebang)
 *   - dist/lib/generate-client-worker.js (spawned by sandbox.ts / deploy.ts
 *                                          at join(__dirname, 'generate-client-worker.js'))
 *
 * The worker's runtime `await import(foundationPath)` of the customer's own
 * backend stays dynamic and external — esbuild cannot (and must not) inline a
 * path only known at runtime, so the customer's `@aws-blocks/*` still resolve
 * in the worker's own process under its spawned `--conditions=aws-runtime`.
 */
import { build } from 'esbuild';

/**
 * Kept external (resolved from the CLI's own real runtime dependencies, not
 * inlined): the AWS SDK (large, peer-shared, must match the host's SDK),
 * yargs/http-proxy/cross-spawn (ordinary runtime deps), typescript and tsx
 * (loaded by spawned workers / type extraction). Everything else — notably the
 * `@aws-blocks/*` packages — is inlined.
 */
const external = [
	'@aws-sdk/*',
	'yargs',
	'yargs/*',
	'cross-spawn',
	'http-proxy',
	'typescript',
	'tsx',
	'tsx/*',
];

/** Shared options for both entrypoints. */
const common = {
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	external,
	logLevel: 'info',
	// `import.meta.url` must survive bundling: cli-version.ts resolves
	// package.json relative to it, and the worker/dev-server resolve sibling
	// paths from it. esbuild keeps it as-is for ESM output.
	//
	// Some inlined dependencies (e.g. hosting's transitive `fast-glob`) are
	// CommonJS and call `require()` on Node builtins. In an ESM output there is
	// no ambient `require`/`__dirname`/`__filename`, so reconstruct them from
	// `import.meta.url`. Without this the bundle throws "Dynamic require of
	// 'os' is not supported" at startup.
	banner: {
		js: [
			"import { createRequire as __blocksCreateRequire } from 'node:module';",
			"import { fileURLToPath as __blocksFileURLToPath } from 'node:url';",
			"import { dirname as __blocksDirname } from 'node:path';",
			'const require = __blocksCreateRequire(import.meta.url);',
			'const __filename = __blocksFileURLToPath(import.meta.url);',
			'const __dirname = __blocksDirname(__filename);',
		].join('\n'),
	},
};

await build({
	...common,
	entryPoints: ['src/blocks.ts'],
	outfile: 'dist/blocks.js',
	// esbuild preserves the entry file's own `#!/usr/bin/env node` shebang, so
	// no banner is needed (adding one would duplicate it and break parsing).
});

await build({
	...common,
	entryPoints: ['src/lib/generate-client-worker.ts'],
	outfile: 'dist/lib/generate-client-worker.js',
});

// The programmatic `.` export (`createMainParser`, path helpers, error
// handlers). Nothing depends on `@aws-blocks/cli` as a library today, but
// bundling it keeps the published package honest: every shipped runtime
// entrypoint is self-contained, so a future programmatic consumer never hits a
// missing `@aws-blocks/*` dependency. The per-file `dist/lib/*.js` that `tsc`
// also emits are only loaded in the dev tree (by the node:test runner, where
// the block packages are present as devDependencies).
await build({
	...common,
	entryPoints: ['src/index.ts'],
	outfile: 'dist/index.js',
});
