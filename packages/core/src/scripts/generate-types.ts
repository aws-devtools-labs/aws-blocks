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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, normalize, resolve } from 'node:path';

/** The backend tsconfig that drives declaration emit, relative to the `aws-blocks/` workspace. */
export const BACKEND_TYPES_TSCONFIG = 'tsconfig.types.json';

/** Outcome of {@link generateBackendTypes}. */
export type BackendTypesResult =
	| { status: 'written'; outFile: string; durationMs: number }
	/** `tsc --build` found the output newer than every input, so it rebuilt nothing. */
	| { status: 'up-to-date'; outFile: string; durationMs: number }
	/** The run was aborted (e.g. the dev server restarted). */
	| { status: 'skipped'; reason: string }
	/** `tsc` reported errors; nothing was written, so the previous output (if any) is kept. */
	| { status: 'failed'; message: string; diagnostics: string };

/**
 * How long `tsc` may run before it is killed. A cold build of a large backend
 * takes a few seconds, so this is generous; it exists so a wedged compiler
 * fails the `prebuild` hook with a message instead of hanging it forever.
 */
export const BACKEND_TYPES_TIMEOUT_MS = 120_000;

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

/** The output's modification time in milliseconds, or `undefined` if it is absent. */
function outputMtimeMs(outFile: string): number | undefined {
	try {
		return statSync(outFile).mtimeMs;
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
 * skips the work when every output is newer than every input. Deciding that is
 * `tsc`'s job, not ours: it compares against the real outputs, so deleting
 * `.types/` is correctly seen as out of date. Nothing here second-guesses it,
 * and there is deliberately no "is it stale?" mode — the hooks that matter
 * (`prepare`, `pretypecheck`, `prebuild`, the dev server) all just run this, and
 * a regenerate is both the check and the fix.
 *
 * Whether `tsc` actually compiled is read from the output file's modification
 * time, not from its console output: `--verbose`/`--dry` report that in prose
 * that is timestamped and localized (`--locale`), so matching on it would be a
 * guess dressed up as a fact. The two `stat` calls cost nothing and are exact.
 *
 * Never throws: the result says whether the types were written, were already
 * current, skipped, or failed. On failure nothing is written (`noEmitOnError`),
 * so a previously generated file stays in place rather than being replaced with
 * partial types.
 *
 * @param awsBlocksDir - The backend workspace directory (the folder holding `index.ts`).
 * @param options.signal - Aborts the `tsc` child process, e.g. when the dev server restarts.
 * @param options.timeoutMs - Kill `tsc` after this long. Default {@link BACKEND_TYPES_TIMEOUT_MS}.
 */
export async function generateBackendTypes(
	awsBlocksDir: string,
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<BackendTypesResult> {
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

	const timeoutMs = options.timeoutMs ?? BACKEND_TYPES_TIMEOUT_MS;
	const started = Date.now();
	const mtimeBefore = outputMtimeMs(outFile);
	const tsconfig = join(awsBlocksDir, BACKEND_TYPES_TSCONFIG);
	const { code, signal, output } = await new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
		output: string;
	}>((done) => {
		let output = '';
		// `--build` must come first. No `--verbose`/`--dry`: the outcome is read
		// from the output file, so the only thing we want on the console is
		// diagnostics for a failure.
		const child = spawn(process.execPath, [tsc, '--build', tsconfig, '--pretty', 'false'], {
			cwd: awsBlocksDir,
			signal: options.signal,
			// Node's own spawn timeout, rather than a timer of ours racing the exit.
			timeout: timeoutMs,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		child.stdout.on('data', (chunk) => {
			output += chunk;
		});
		child.stderr.on('data', (chunk) => {
			output += chunk;
		});
		child.on('error', (error) => done({ code: null, signal: null, output: output + error.message }));
		child.on('close', (code, signal) => done({ code, signal, output }));
	});

	// The caller's abort and the timeout both kill the child; only the caller's
	// is a non-event. Check it first so a dev-server restart is never reported
	// as a type failure.
	if (options.signal?.aborted) return { status: 'skipped', reason: 'aborted' };
	if (code === null) {
		return {
			status: 'failed',
			message: signal
				? `tsc did not finish within ${timeoutMs} ms (killed with ${signal}); ${outFile} was not updated`
				: `could not run tsc; ${outFile} was not updated`,
			diagnostics: output.trim(),
		};
	}

	if (code !== 0) {
		return {
			status: 'failed',
			message: `type errors in the backend; ${outFile} was not updated`,
			diagnostics: output.trim(),
		};
	}

	const mtimeAfter = outputMtimeMs(outFile);
	if (mtimeAfter === undefined) {
		return {
			status: 'failed',
			message: `tsc succeeded but did not write ${outFile}; check that outDir in ${BACKEND_TYPES_TSCONFIG} matches exports["."].types`,
			diagnostics: output.trim(),
		};
	}
	const status = mtimeBefore === undefined || mtimeAfter !== mtimeBefore ? 'written' : 'up-to-date';
	return { status, outFile, durationMs: Date.now() - started };
}
