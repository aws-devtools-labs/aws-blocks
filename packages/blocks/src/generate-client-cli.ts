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
 * For a TypeScript foundation the worker is loaded with `--import <tsx loader>`:
 * the app's own `tsx` when it is installed, else the one `@aws-blocks/blocks`
 * depends on, by absolute URL, so that the worker finds it from any app.
 *
 * After `client.js`, it also writes the backend's declaration files
 * (`aws-blocks/.types/`) when the workspace's `exports["."].types` points at
 * them, using the app's own `typescript`. Type errors in the backend fail the
 * command so a build never continues with stale types. That makes this the
 * authoritative freshness gate; `blocks-generate-types`, wired as `prepare`,
 * only ensures the declarations exist and never fails an install.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateBackendTypes } from '@aws-blocks/core/scripts/generate-types';

const [foundationArg, outputArg] = process.argv.slice(2);
const foundationPath = resolvePath(foundationArg ?? './aws-blocks/index.ts');
const outputPath = resolvePath(outputArg ?? './aws-blocks/client.js');

function resolvePath(p: string): string {
	return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

/** The file URL of the `tsx` loader: the app's (cwd) own, else this package's dependency. */
function resolveTsxLoader(): string | undefined {
	for (const from of [resolve(process.cwd(), 'package.json'), import.meta.url]) {
		try {
			return pathToFileURL(createRequire(from).resolve('tsx')).href;
		} catch {
			// Not installed there; try the next location.
		}
	}
	return undefined;
}

if (!existsSync(foundationPath)) {
	console.error(`blocks-generate-client: cannot find ${foundationPath}`);
	process.exit(2);
}

// The worker lives in @aws-blocks/core; `generate-client-worker.js` runs it through
// this package's own dependency, so consuming apps don't need a direct core dependency.
const workerPath = fileURLToPath(new URL('./generate-client-worker.js', import.meta.url));

const nodeArgs = ['--conditions=aws-runtime'];

if (/\.(ts|tsx|mts|cts)$/i.test(foundationPath)) {
	const loader = resolveTsxLoader();
	if (!loader) {
		console.error(
			[
				`blocks-generate-client: cannot load TypeScript entry "${foundationPath}" — \`tsx\` is not installed.`,
				`Install it as a devDependency:`,
				`    npm install -D tsx`,
			].join('\n'),
		);
		process.exit(2);
	}
	nodeArgs.push('--import', loader);
}

const worker = spawn(process.execPath, [...nodeArgs, workerPath, foundationPath, outputPath], {
	stdio: 'inherit',
	cwd: process.cwd(),
});

// A signal sent to this process alone (`kill <pid>`, a supervisor, the `cdk-blocks` CLI
// forwarding one) goes on to the worker, and this process ends after it, so the
// worker never outlives it and writes the client after a reported failure.
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const forward = (signal: NodeJS.Signals) => worker.kill(signal);
for (const signal of SIGNALS) process.on(signal, forward);

worker.on('error', (error) => {
	console.error(`blocks-generate-client: cannot start the client generator: ${error.message}`);
	process.exit(1);
});

worker.on('exit', async (code, signal) => {
	for (const name of SIGNALS) process.off(name, forward);
	// End as the worker did: by its signal, so the caller sees the interruption, or with its exit code.
	if (signal) return process.kill(process.pid, signal);
	if (code !== 0) return process.exit(code ?? 1);
	console.log(`blocks-generate-client: wrote ${outputPath}`);

	// Backend declaration files for the frontend's typed import (see
	// `generateBackendTypes`). Only after the client succeeded, and a failure
	// exits non-zero: this runs as `prebuild`/`pretypecheck`, and a build must
	// not continue with missing or stale types. That includes a workspace
	// predating generated types — it fails here with the migration steps,
	// rather than building against the backend source.
	const types = await generateBackendTypes(dirname(foundationPath));
	if (types.status === 'failed') {
		console.error(`blocks-generate-client: backend types not written: ${types.message}`);
		if (types.diagnostics) console.error(types.diagnostics);
		process.exit(1);
	}
	if (types.status === 'written') console.log(`blocks-generate-client: wrote ${types.outFile}`);
	if (types.status === 'up-to-date') console.log(`blocks-generate-client: ${types.outFile} is up to date`);
});
