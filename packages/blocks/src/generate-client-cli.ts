#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal helper for `npm run generate-client [foundationPath] [outputPath]`.
 * It regenerates the app's typed client (`cdk-blocks/client.js`).
 *
 * Defaults:
 *   foundationPath = ./cdk-blocks/index.ts
 *   outputPath     = ./cdk-blocks/client.js
 *
 * The emitted client is not condition-independent: Building Block constructors
 * register their client middleware when the backend is imported, and which
 * middleware registers depends on the active Node export conditions. Under the
 * default conditions Realtime registers `mock-middleware`; production bundles
 * need `aws-middleware`. The helper therefore always spawns the generator worker
 * in a child process with `--conditions=aws-runtime`, so the emitted
 * `client.js` is correct regardless of how the task was invoked.
 *
 * For a TypeScript foundation the worker is loaded with `--import <tsx loader>`:
 * the app's own `tsx` when it is installed, else the one `aws-cdk-blocks`
 * depends on, by absolute URL, so that the worker finds it from any app.
 */

import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCoreTelemetry, runTracked } from './cli/telemetry.js';

const [foundationArg, outputArg] = process.argv.slice(2).filter((arg) => !arg.startsWith('--telemetry-file='));
const foundationPath = resolvePath(foundationArg ?? './cdk-blocks/index.ts');
const outputPath = resolvePath(outputArg ?? './cdk-blocks/client.js');

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

/**
 * The worker's environment. `tsx` compiles a file with the options of the
 * `tsconfig.json` in the working directory, and a root that only lists project
 * references (the Vite templates) lists no file, so the backend would load without
 * its `jsx` or `paths`. Point `tsx` at the `tsconfig.json` next to the backend entry
 * (`cdk-blocks/tsconfig.json`) when there is one, unless `TSX_TSCONFIG_PATH` is set.
 */
function workerEnv(): NodeJS.ProcessEnv {
	if (process.env.TSX_TSCONFIG_PATH) return process.env;
	const backendTsconfig = resolve(dirname(foundationPath), 'tsconfig.json');
	return existsSync(backendTsconfig) ? { ...process.env, TSX_TSCONFIG_PATH: backendTsconfig } : process.env;
}

/** The signal the worker ended on, which this process then ends on too. */
let endSignal: NodeJS.Signals | undefined;

/** Generate the client; resolves to this process's exit code. */
function generate(): Promise<number> {
	if (!existsSync(foundationPath)) {
		console.error(`generate-client: cannot find ${foundationPath}`);
		return Promise.resolve(2);
	}

	// The worker lives in @aws-cdk-blocks/core; `generate-client-worker.js` runs it through
	// this package's own dependency, so consuming apps don't need a direct core dependency.
	const workerPath = fileURLToPath(new URL('./generate-client-worker.js', import.meta.url));

	const nodeArgs = ['--conditions=aws-runtime'];

	if (/\.(ts|tsx|mts|cts)$/i.test(foundationPath)) {
		const loader = resolveTsxLoader();
		if (!loader) {
			console.error(
				[
					`generate-client: cannot load TypeScript entry "${foundationPath}" — \`tsx\` is not installed.`,
					`Install it as a devDependency:`,
					`    npm install -D tsx`,
				].join('\n'),
			);
			return Promise.resolve(2);
		}
		nodeArgs.push('--import', loader);
	}

	return new Promise((done) => {
		const worker = spawn(process.execPath, [...nodeArgs, workerPath, foundationPath, outputPath], {
			stdio: 'inherit',
			cwd: process.cwd(),
			env: workerEnv(),
		});

		// A signal sent to this process alone (`kill <pid>`, a supervisor, the package task runner
		// forwarding one) goes on to the worker, and this process ends after it, so the
		// worker never outlives it and writes the client after a reported failure.
		const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
		const forward = (signal: NodeJS.Signals) => worker.kill(signal);
		for (const signal of SIGNALS) process.on(signal, forward);

		worker.on('error', (error) => {
			console.error(`generate-client: cannot start the client generator: ${error.message}`);
			done(1);
		});

		worker.on('exit', (code, signal) => {
			for (const name of SIGNALS) process.off(name, forward);
			// End as the worker did: by its signal, so the caller sees the interruption, or with its exit code.
			if (signal) {
				endSignal = signal;
				done(128 + (osConstants.signals[signal] ?? 0));
			} else if (code !== 0) {
				done(code ?? 1);
			} else {
				console.log(`generate-client: wrote ${outputPath}`);
				done(0);
			}
		});
	});
}

// One `generate:client` event per run, here rather than in the CLI, so running this bin
// directly (as apps on vendored scripts do) sends it too. It never changes the result.
const code = await runTracked('generate:client', () => process.cwd(), generate, loadCoreTelemetry);
if (endSignal) process.kill(process.pid, endSignal);
else if (code !== 0) process.exit(code);
