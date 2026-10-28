// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generate the backend's declaration files (`aws-blocks/.types/`).
 *
 * A frontend gets its typed API by importing `aws-blocks`. When the backend
 * workspace's `exports["."].types` points at its source (`./index.ts`), the
 * frontend's TypeScript typechecks the backend source with the frontend's own
 * tsconfig. A frontend tsconfig is set up for the browser: Vite's sets
 * `"types": ["vite/client"]`, which hides Node types, so backend code that uses
 * `process` or `node:crypto` fails the frontend build. Browser-only `lib`
 * settings and stricter flags break it the same way.
 *
 * When `exports["."].types` points at a `.d.ts` file instead, the backend's
 * types are computed once here, under the backend's own `aws-blocks/tsconfig.types.json`
 * (Node types, `lib: ["ESNext"]`), and the frontend only reads the result.
 *
 * Generation is opt-in by the workspace layout, so apps scaffolded before this
 * existed are untouched: it runs only when `exports["."].types` is a `.d.ts`
 * path and `tsconfig.types.json` exists.
 *
 * The app's own `tsc` is run as a child process, like `blocks-generate-client`
 * uses the app's `tsx`. The `tsc` command line is the same on TypeScript 5.x
 * and 7, whereas TypeScript 7's package no longer exposes the in-process
 * compiler API (`ts.createProgram`).
 *
 * @module
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, normalize, resolve } from 'node:path';

/** The backend tsconfig that drives declaration emit, relative to the `aws-blocks/` workspace. */
export const BACKEND_TYPES_TSCONFIG = 'tsconfig.types.json';

/** Outcome of {@link generateBackendTypes}. */
export type BackendTypesResult =
	| { status: 'written'; outFile: string; durationMs: number }
	/** The workspace doesn't use generated types (older layout); nothing to do. */
	| { status: 'skipped'; reason: string }
	/** `tsc` reported errors; nothing was written, so the previous output (if any) is kept. */
	| { status: 'failed'; message: string; diagnostics: string };

/**
 * Returns the `.d.ts` path the workspace's `exports["."].types` points at, or
 * `undefined` when the workspace doesn't use generated types.
 */
export function backendTypesTarget(awsBlocksDir: string): string | undefined {
	const pkgPath = join(awsBlocksDir, 'package.json');
	if (!existsSync(pkgPath) || !existsSync(join(awsBlocksDir, BACKEND_TYPES_TSCONFIG))) return undefined;
	let types: unknown;
	try {
		types = JSON.parse(readFileSync(pkgPath, 'utf-8'))?.exports?.['.']?.types;
	} catch {
		return undefined;
	}
	if (typeof types !== 'string' || !types.endsWith('.d.ts')) return undefined;
	return normalize(resolve(awsBlocksDir, types));
}

/** Resolve the app's `tsc` entry script, looking up from the backend workspace. */
function resolveTsc(awsBlocksDir: string): string | undefined {
	try {
		const pkgJson = createRequire(join(awsBlocksDir, 'package.json')).resolve('typescript/package.json');
		const bin = JSON.parse(readFileSync(pkgJson, 'utf-8')).bin;
		const tsc = typeof bin === 'string' ? bin : bin?.tsc;
		return typeof tsc === 'string' ? resolve(dirname(pkgJson), tsc) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Write `aws-blocks/.types/` from the backend source by running the app's
 * `tsc -p aws-blocks/tsconfig.types.json`.
 *
 * Never throws: the result says whether the types were written, skipped, or
 * failed. On failure nothing is written (`noEmitOnError`), so a previously
 * generated file stays in place rather than being replaced with partial types.
 *
 * @param awsBlocksDir - The backend workspace directory (the folder holding `index.ts`).
 * @param options.signal - Aborts the `tsc` child process, e.g. when the dev server restarts.
 */
export async function generateBackendTypes(
	awsBlocksDir: string,
	options: { signal?: AbortSignal } = {},
): Promise<BackendTypesResult> {
	const outFile = backendTypesTarget(awsBlocksDir);
	if (!outFile) {
		return { status: 'skipped', reason: `no ${BACKEND_TYPES_TSCONFIG} or exports["."].types is not a .d.ts file` };
	}
	const tsc = resolveTsc(awsBlocksDir);
	if (!tsc) {
		return {
			status: 'failed',
			message: 'cannot find the `typescript` package. Install it as a devDependency: npm install -D typescript',
			diagnostics: '',
		};
	}

	const started = Date.now();
	const tsconfig = join(awsBlocksDir, BACKEND_TYPES_TSCONFIG);
	const { code, output } = await new Promise<{ code: number | null; output: string }>((done) => {
		let output = '';
		const child = spawn(process.execPath, [tsc, '-p', tsconfig, '--pretty', 'false'], {
			cwd: awsBlocksDir,
			signal: options.signal,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		child.stdout.on('data', (chunk) => {
			output += chunk;
		});
		child.stderr.on('data', (chunk) => {
			output += chunk;
		});
		child.on('error', (error) => done({ code: null, output: output + error.message }));
		child.on('close', (code) => done({ code, output }));
	});

	if (options.signal?.aborted) return { status: 'skipped', reason: 'aborted' };
	if (code === 0 && existsSync(outFile)) {
		return { status: 'written', outFile, durationMs: Date.now() - started };
	}
	if (code === 0) {
		return {
			status: 'failed',
			message: `tsc succeeded but did not write ${outFile}; check that outDir in ${BACKEND_TYPES_TSCONFIG} matches exports["."].types`,
			diagnostics: output.trim(),
		};
	}
	return {
		status: 'failed',
		message: `type errors in the backend; ${outFile} was not updated`,
		diagnostics: output.trim(),
	};
}
