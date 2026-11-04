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
 * Generated types are the only supported layout. A backend workspace that still
 * points `exports["."].types` at its source, or that has no
 * `tsconfig.types.json`, is a hard error naming the migration — not a silent
 * skip. Silently skipping would leave the frontend typechecking backend source,
 * which is the bug this exists to fix, and it would do so without saying so.
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
	/** `tsc --build` found the output newer than every input, so it rebuilt nothing. */
	| { status: 'up-to-date'; outFile: string; durationMs: number }
	/** `mode: 'check'` only: the output is missing or older than an input. */
	| { status: 'stale'; outFile: string }
	/** `mode: 'clean'` only: the declarations and build state were removed. */
	| { status: 'cleaned' }
	/** The run was aborted (e.g. the dev server restarted). */
	| { status: 'skipped'; reason: string }
	/** `tsc` reported errors; nothing was written, so the previous output (if any) is kept. */
	| { status: 'failed'; message: string; diagnostics: string };

/** How to bring a workspace predating generated types onto the supported layout. */
const MIGRATION = [
	`copy aws-blocks/${BACKEND_TYPES_TSCONFIG} from a newly created app`,
	'set exports["."].types in aws-blocks/package.json to "./.types/index.d.ts"',
	'add aws-blocks/.types/ to .gitignore',
]
	.map((step, i) => `  ${i + 1}. ${step}`)
	.join('\n');

/**
 * Returns the `.d.ts` path the workspace's `exports["."].types` points at, or
 * the reason this workspace is not on the generated-types layout.
 */
export function backendTypesTarget(awsBlocksDir: string): { outFile: string } | { error: string } {
	const pkgPath = join(awsBlocksDir, 'package.json');
	if (!existsSync(pkgPath)) return { error: `no package.json in ${awsBlocksDir}` };
	if (!existsSync(join(awsBlocksDir, BACKEND_TYPES_TSCONFIG))) {
		return { error: `aws-blocks/${BACKEND_TYPES_TSCONFIG} is missing. To migrate:\n${MIGRATION}` };
	}
	let types: unknown;
	try {
		types = JSON.parse(readFileSync(pkgPath, 'utf-8'))?.exports?.['.']?.types;
	} catch {
		return { error: 'aws-blocks/package.json is not valid JSON' };
	}
	if (typeof types !== 'string' || !types.endsWith('.d.ts')) {
		return {
			error:
				`exports["."].types in aws-blocks/package.json is ${JSON.stringify(types)}, not a .d.ts path, so the ` +
				`frontend would typecheck the backend source. To migrate:\n${MIGRATION}`,
		};
	}
	return { outFile: normalize(resolve(awsBlocksDir, types)) };
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
 * `tsc --build aws-blocks/tsconfig.types.json`.
 *
 * `--build` rather than `-p` so `tsc` keeps its own incremental state (a
 * `tsbuildinfo` beside the declarations, inside the gitignored `.types/`) and
 * skips the work when every output is newer than every input. It compares
 * against the real outputs, not just that state, so deleting `.types/` is
 * correctly seen as out of date — which is what makes `mode: 'check'` a usable
 * freshness gate rather than a guess.
 *
 * Never throws: the result says whether the types were written, were already
 * current, skipped, or failed. On failure nothing is written (`noEmitOnError`),
 * so a previously generated file stays in place rather than being replaced with
 * partial types.
 *
 * @param awsBlocksDir - The backend workspace directory (the folder holding `index.ts`).
 * @param options.signal - Aborts the `tsc` child process, e.g. when the dev server restarts.
 * @param options.mode - `'build'` (default) writes them; `'check'` reports
 *   `up-to-date` or `stale` without writing (`--dry`); `'clean'` removes the
 *   declarations and the build state (`--clean`).
 */
export async function generateBackendTypes(
	awsBlocksDir: string,
	options: { signal?: AbortSignal; mode?: 'build' | 'check' | 'clean' } = {},
): Promise<BackendTypesResult> {
	const mode = options.mode ?? 'build';
	const target = backendTypesTarget(awsBlocksDir);
	if ('error' in target) {
		return { status: 'failed', message: target.error, diagnostics: '' };
	}
	const { outFile } = target;
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
		// `--build` must come first. `--verbose` is what makes the up-to-date
		// decision observable: a plain `--build` prints nothing when it skips.
		// It cannot be combined with `--clean` (TS6370), which needs no such
		// reporting anyway.
		const buildArgs = ['--build', tsconfig, '--pretty', 'false'];
		if (mode === 'clean') buildArgs.push('--clean');
		else buildArgs.push('--verbose');
		if (mode === 'check') buildArgs.push('--dry');

		const child = spawn(process.execPath, [tsc, ...buildArgs], {
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

	if (code === 0 && mode === 'clean') return { status: 'cleaned' };

	if (code === 0 && mode === 'check') {
		// `--dry` says either "is up to date" or "A non-dry build would build project".
		return /would build project/i.test(output)
			? { status: 'stale', outFile }
			: { status: 'up-to-date', outFile, durationMs: Date.now() - started };
	}

	if (code === 0 && existsSync(outFile)) {
		// `--verbose` logs "Building project" only when it actually compiled.
		const status = /building project/i.test(output) ? 'written' : 'up-to-date';
		return { status, outFile, durationMs: Date.now() - started };
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
