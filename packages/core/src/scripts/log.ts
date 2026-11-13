// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Output verbosity for the lifecycle scripts (`deploy`, `sandbox`, `destroy`,
 * the dev server, …), selected by the `BLOCKS_LOG_LEVEL` environment variable.
 *
 * - `legacy` (unset, empty or unrecognised): today's output, byte for byte.
 *   Generated app scripts that never set the variable see no change.
 * - `quiet`: errors and final results only (URLs, `BLOCKS_DEPLOYED …`, the
 *   deployment-target block). Child output (CDK) is hidden but retained, and
 *   printed if the operation fails.
 * - `normal`: curated progress and results. CDK output is condensed into a few
 *   milestones; failure lines pass through verbatim; the raw output is retained
 *   and printed if the operation fails.
 * - `verbose`: `normal` plus the raw child output — the same lines as `legacy`.
 * - `debug`: `verbose` plus stack traces for errors the scripts catch and
 *   report as warnings.
 *
 * The level is read from the environment on every call, so a caller (the
 * `cdk-blocks` CLI) can set it at any point before invoking a script, and spawned
 * children inherit it.
 */
export type BlocksLogLevel = 'legacy' | 'quiet' | 'normal' | 'verbose' | 'debug';

/** The environment variable that selects the {@link BlocksLogLevel}. */
export const BLOCKS_LOG_LEVEL_ENV = 'BLOCKS_LOG_LEVEL';

const LEVELS: Record<string, BlocksLogLevel> = { quiet: 'quiet', normal: 'normal', verbose: 'verbose', debug: 'debug' };

/**
 * The level selected by `BLOCKS_LOG_LEVEL` (case-insensitive). Anything that is
 * not one of `quiet|normal|verbose|debug` is `legacy`, so a typo can never hide
 * output.
 */
export function resolveLogLevel(env: NodeJS.ProcessEnv = process.env): BlocksLogLevel {
	const raw = env[BLOCKS_LOG_LEVEL_ENV]?.trim().toLowerCase() ?? '';
	return Object.hasOwn(LEVELS, raw) ? LEVELS[raw] : 'legacy';
}

/**
 * Whether child-process output is condensed (and retained for a failure dump)
 * at `level`. Only `quiet` and `normal` filter; every other level shows the raw
 * stream exactly as `legacy` does.
 */
export function isCuratedLevel(level: BlocksLogLevel): boolean {
	return level === 'quiet' || level === 'normal';
}

/** The environment variable that moves progress to stderr: `BLOCKS_LOG_STREAM=stderr`. */
export const BLOCKS_LOG_STREAM_ENV = 'BLOCKS_LOG_STREAM';

/**
 * True when progress goes to stderr. The `cdk-blocks` CLI sets `BLOCKS_LOG_STREAM=stderr`
 * so that stdout carries only results; without it the legacy streams are unchanged.
 * Results (`BLOCKS_DEPLOYED`, final URLs, the deployment target) stay on stdout either way.
 */
export function progressToStderr(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[BLOCKS_LOG_STREAM_ENV] === 'stderr';
}

/**
 * The scripts' logger. Each method keeps the console method (and so the stream)
 * of the line it replaced, and only decides whether the line prints:
 *
 * | method       | stream | legacy | quiet | normal | verbose | debug |
 * |--------------|--------|--------|-------|--------|---------|-------|
 * | `progress`   | stdout | ✓      |       | ✓      | ✓       | ✓     |
 * | `detail`     | stdout | ✓      |       |        | ✓       | ✓     |
 * | `warn`       | stderr | ✓      |       | ✓      | ✓       | ✓     |
 * | `debugError` | stderr |        |       |        |         | ✓     |
 *
 * With `BLOCKS_LOG_STREAM=stderr`, `progress` and `detail` go to stderr.
 *
 * Errors, final results and machine-readable lines are NOT routed through
 * here: they stay plain `console.*` calls so no level can hide them.
 */
export const log = {
	/** A curated progress step (`🚀 Deploying to AWS...`). Hidden at `quiet`. */
	progress(...args: unknown[]): void {
		if (resolveLogLevel() !== 'quiet') (progressToStderr() ? console.error : console.log)(...args);
	},
	/** Supplementary progress detail that is noise once output is curated. Hidden at `quiet` and `normal`. */
	detail(...args: unknown[]): void {
		if (!isCuratedLevel(resolveLogLevel())) (progressToStderr() ? console.error : console.log)(...args);
	},
	/** A warning about a degraded-but-continuing step. Hidden at `quiet`. */
	warn(...args: unknown[]): void {
		if (resolveLogLevel() !== 'quiet') console.warn(...args);
	},
	/**
	 * The stack of an error the caller caught and reported as a warning. Prints
	 * only at `debug` (never at `legacy`, which never printed it).
	 */
	debugError(error: unknown): void {
		if (resolveLogLevel() !== 'debug') return;
		const stack = error instanceof Error ? error.stack : undefined;
		console.error(stack ?? String(error));
	},
};

/**
 * Write errors that mean the reader of stdout/stderr is gone: a closed pipe (`EPIPE`), a hung-up terminal (`EIO`).
 * The `cdk-blocks` CLI keeps its own copy, because it must not load this entry on every command; a test of
 * `@aws-blocks/blocks` fails when the two differ.
 */
export const CLOSED_OUTPUT_CODES: readonly string[] = ['EPIPE', 'EIO', 'ERR_STREAM_DESTROYED'];

const guardedStreams = new WeakSet<NodeJS.EventEmitter>();

/**
 * Keep running when stdout or stderr loses its reader: `… | tee log` after a
 * Ctrl-C (tee exits with the process group), `cmd | head`, a background job
 * whose pipe closed, or a closed terminal (SIGHUP, then `EIO`). Node reports
 * the failed write as an `'error'` event on the stream, and with no listener
 * that event kills the process — before a runner reaps its detached children
 * (`cdk watch`, the dev server) or records a deploy that is still running.
 *
 * Installs one listener per stream that drops those errors, so later output is
 * discarded instead. Any other stream error is rethrown, as without a listener.
 * Idempotent. Every long-running script (deploy, destroy, sandbox, dev server)
 * calls it first.
 */
export function ignoreClosedOutput(
	streams: readonly NodeJS.EventEmitter[] = [process.stdout, process.stderr],
): void {
	for (const stream of streams) {
		if (guardedStreams.has(stream)) continue;
		guardedStreams.add(stream);
		stream.on('error', (error: NodeJS.ErrnoException) => {
			if (!CLOSED_OUTPUT_CODES.includes(error.code ?? '')) throw error;
		});
	}
}
