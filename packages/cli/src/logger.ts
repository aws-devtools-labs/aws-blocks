// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A tiny, dependency-free logger for the `blocks` CLI.
 *
 * The CLI has one global verbosity level, set from the `--quiet` / `--verbose`
 * / `--debug` flags (see {@link main_parser_factory}). Everything the CLI
 * prints to the user goes through here so a single flag controls the noise —
 * the DX gap the vendored-scripts model could not close (raw `stdio: 'inherit'`
 * with no gating).
 *
 * The chosen level is also exported to the environment (`BLOCKS_LOG_LEVEL`, and
 * `BLOCKS_DEV_QUIET` for the dev server's existing convention) so the command
 * implementations and any child process the CLI spawns observe the same level.
 */

export enum LogLevel {
	/** Only errors. */
	Quiet = 0,
	/** Errors + warnings + normal progress. The default. */
	Normal = 1,
	/** Adds informational detail (resolved paths, spawned commands). */
	Verbose = 2,
	/** Adds debug detail and full stack traces on error. */
	Debug = 3,
}

let currentLevel: LogLevel = LogLevel.Normal;

/** The environment variable other packages / child processes read. */
export const LOG_LEVEL_ENV = 'BLOCKS_LOG_LEVEL';

/**
 * Set the global verbosity level and mirror it into the environment so the
 * command implementations and spawned child processes (cdk/tsx/npm) inherit it.
 */
export function setLogLevel(level: LogLevel): void {
	currentLevel = level;
	process.env[LOG_LEVEL_ENV] = String(level);
	// Honour the dev server's pre-existing quiet convention.
	if (level <= LogLevel.Quiet) {
		process.env.BLOCKS_DEV_QUIET = '1';
	} else {
		delete process.env.BLOCKS_DEV_QUIET;
	}
}

/** Resolve the level from CLI flags (verbose/debug/quiet). Debug wins over verbose wins over quiet. */
export function levelFromFlags(flags: {
	quiet?: boolean;
	verbose?: boolean;
	debug?: boolean;
}): LogLevel {
	if (flags.debug) return LogLevel.Debug;
	if (flags.verbose) return LogLevel.Verbose;
	if (flags.quiet) return LogLevel.Quiet;
	return LogLevel.Normal;
}

/** The current global level (also readable by callers that branch on it). */
export function getLogLevel(): LogLevel {
	return currentLevel;
}

/** True when running at Debug level — used to decide whether to print stack traces. */
export function isDebug(): boolean {
	return currentLevel >= LogLevel.Debug;
}

/** Normal user-facing output (progress, results). Suppressed by `--quiet`. */
export function info(message: string): void {
	if (currentLevel >= LogLevel.Normal) {
		console.log(message);
	}
}

/** Warnings. Suppressed by `--quiet`. */
export function warn(message: string): void {
	if (currentLevel >= LogLevel.Normal) {
		console.warn(`⚠ ${message}`);
	}
}

/** Errors. Always shown, even under `--quiet`. */
export function error(message: string): void {
	console.error(`✖ ${message}`);
}

/** Extra detail shown at `--verbose` and above. */
export function verbose(message: string): void {
	if (currentLevel >= LogLevel.Verbose) {
		console.error(`› ${message}`);
	}
}

/** Debug detail shown only at `--debug`. */
export function debug(message: string): void {
	if (currentLevel >= LogLevel.Debug) {
		console.error(`· ${message}`);
	}
}
