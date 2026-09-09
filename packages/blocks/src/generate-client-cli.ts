#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI wrapper that regenerates the app's typed client (`aws-blocks/client.js`).
 * Exposed as the `blocks-generate-client` bin on `@aws-blocks/blocks`, so any
 * Blocks app can wire it as a `prebuild` hook:
 *
 *     "prebuild": "blocks-generate-client"
 *
 * Usage:
 *   blocks-generate-client [foundationPath] [outputPath]
 *
 * Defaults:
 *   foundationPath = ./aws-blocks/index.ts
 *   outputPath     = ./aws-blocks/client.js
 *
 * The emitted client is not condition-independent: Building Block constructors
 * register their client middleware when the backend is imported, and which
 * middleware registers depends on the active Node export conditions. Under the
 * default conditions Realtime registers `mock-middleware`; production bundles
 * need `aws-middleware`. This CLI therefore always spawns the generator worker
 * in a child process with `--conditions=aws-runtime`, so the emitted
 * `client.js` is correct regardless of how the hook itself was invoked.
 *
 * For a TypeScript foundation the worker is loaded with `--import tsx`. Like
 * `blocks-generate-spec`, tsx is expected from the consuming app's
 * devDependencies rather than bundled here, keeping the runtime path JS-only.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, isAbsolute } from 'node:path';

const require = createRequire(import.meta.url);

const [foundationArg, outputArg] = process.argv.slice(2);
const foundationPath = resolvePath(foundationArg ?? './aws-blocks/index.ts');
const outputPath = resolvePath(outputArg ?? './aws-blocks/client.js');

function resolvePath(p: string): string {
	return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

if (!existsSync(foundationPath)) {
	console.error(`blocks-generate-client: cannot find ${foundationPath}`);
	process.exit(2);
}

// The worker lives in @aws-blocks/core; resolve it through this package's own
// dependency so consuming apps don't need a direct core dependency.
const workerPath = require.resolve('@aws-blocks/core/scripts/generate-client-worker');

const nodeArgs = ['--conditions=aws-runtime'];

if (/\.(ts|tsx|mts|cts)$/i.test(foundationPath)) {
	try {
		// Resolve tsx from the app's context (cwd), matching blocks-generate-spec:
		// the templates ship it as a devDependency, we don't bundle it.
		createRequire(resolve(process.cwd(), 'package.json')).resolve('tsx');
	} catch {
		console.error(
			[
				`blocks-generate-client: cannot load TypeScript entry "${foundationPath}" — \`tsx\` is not installed.`,
				`Install it as a devDependency:`,
				`    npm install -D tsx`,
			].join('\n'),
		);
		process.exit(2);
	}
	nodeArgs.push('--import', 'tsx');
}

const result = spawnSync(process.execPath, [...nodeArgs, workerPath, foundationPath, outputPath], {
	stdio: 'inherit',
	cwd: process.cwd(),
});

if (result.status !== 0) {
	process.exit(result.status ?? 1);
}

console.log(`blocks-generate-client: wrote ${outputPath}`);
