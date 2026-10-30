// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * How the CLI starts the lifecycle runners.
 *
 * Each lifecycle command runs a small runner in a child process with `tsx`,
 * the runtime of the `aws-blocks/scripts/*.ts` wrappers that the npm scripts
 * ran. The dev server runs under `tsx watch`, which restarts it on a change.
 * The other runners run as `node --import <tsx loader>` (with `--conditions=cdk`
 * for `sandbox destroy`), with no `tsx` process between the CLI and the runner:
 * the `tsx` CLI does not handle SIGHUP, so a closed terminal would end it and
 * the CLI would report a failure while the runner went on. The runner calls one
 * core function with options that the CLI resolved. A runner reads its options
 * as JSON from `process.argv[2]`; the dev server runner reads them from
 * `BLOCKS_DEV_OPTIONS`, because the sandbox starts it from a shell command string.
 *
 * `tsx` resolves from the app first, so the app's own version runs as it did
 * from the npm scripts, then from `@aws-blocks/blocks`, which depends on it.
 * The runners pass the same `tsx` loader to core's client-generation worker
 * through `BLOCKS_TSX_IMPORT`, so an app without its own `tsx` works there too.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CliError } from '../errors.js';

/** The environment variable that carries the dev server runner's options. */
export const DEV_OPTIONS_ENV = 'BLOCKS_DEV_OPTIONS';

/** The environment variable that names the `tsx` loader for core's client-generation worker. */
export const TSX_IMPORT_ENV = 'BLOCKS_TSX_IMPORT';

export type RunnerName = 'dev-server' | 'sandbox' | 'sandbox-destroy' | 'deploy' | 'destroy' | 'generate-spec';

/** The absolute path of a compiled runner. */
export function runnerPath(name: RunnerName): string {
	return fileURLToPath(new URL(`./${name}.js`, import.meta.url));
}

/** The absolute path of a `tsx` entry: the app's own, else the one `@aws-blocks/blocks` depends on. */
function resolveTsx(root: string, entry: 'tsx' | 'tsx/cli'): string {
	for (const from of [join(root, 'package.json'), fileURLToPath(import.meta.url)]) {
		try {
			return createRequire(from).resolve(entry);
		} catch {
			// Not installed there; try the next location.
		}
	}
	throw new CliError('cannot find tsx, which runs the app TypeScript.', { hint: 'npm install -D tsx' });
}

/** The `tsx` CLI entry: the app's own, else the one `@aws-blocks/blocks` depends on. */
export function resolveTsxCli(root: string): string {
	return resolveTsx(root, 'tsx/cli');
}

/** The file URL of the `tsx` loader (`node --import <url>`), from the same install as {@link resolveTsxCli}. */
export function resolveTsxLoader(root: string): string {
	return pathToFileURL(resolveTsx(root, 'tsx')).href;
}

export interface RunnerLaunch {
	/** Run under `tsx watch`, for the dev server. */
	watch?: boolean;
	/** A `--conditions` value for Node, for example `cdk`. */
	conditions?: string;
	/** Arguments after the runner script. */
	args?: string[];
}

/** The `node` arguments that run the runner `script` in the app at `root`; see the module doc. */
export function runnerArgs(root: string, script: string, launch: RunnerLaunch = {}): string[] {
	const node = launch.conditions === undefined ? [] : [`--conditions=${launch.conditions}`];
	const tail = [script, ...(launch.args ?? [])];
	if (launch.watch) return [resolveTsxCli(root), 'watch', ...node, ...tail];
	return [...node, '--import', resolveTsxLoader(root), ...tail];
}

/**
 * Quote one word for the platform shell that `startSandbox` runs its dev command in.
 * cmd.exe has no safe way to quote `"` or `%` (it expands `%VAR%` even inside
 * quotes), so on Windows a word with either is refused rather than mangled.
 */
export function shellQuote(word: string, platform: NodeJS.Platform = process.platform): string {
	if (platform === 'win32') {
		if (/["%]/.test(word)) {
			throw new CliError(`cannot pass ${JSON.stringify(word)} to the Windows shell: it contains " or %.`, {
				hint: 'move the project or Node.js to a path without " or %',
			});
		}
		return `"${word}"`;
	}
	return `'${word.replace(/'/g, `'\\''`)}'`;
}
