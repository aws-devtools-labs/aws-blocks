// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared write path for the Logger building block. The runtime and CDK entries
 * declare their own `Logger` class (each extends a different `Scope`), but both
 * delegate here so logging behaves the same in Lambda, local dev, and `cdk synth`.
 */

import type { ChildLogger, LogLevel } from './types.js';
import { buildEntry, isLogLevel, shouldLog } from './serializer.js';

/** Level used when `options.level` is omitted or not a known level. */
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/**
 * Common spellings from other logging libraries, mapped to the nearest
 * {@link LogLevel}. Applied after trim + lower-case, and accepted silently.
 * `trace` maps to `debug` (the most verbose level we have) and `fatal` to
 * `error` (the most severe).
 */
const LEVEL_ALIASES: Readonly<Record<string, LogLevel>> = {
	warning: 'warn',
	trace: 'debug',
	fatal: 'error',
};

/** Result of {@link resolveLevel}. */
export interface ResolvedLevel {
	/** The level the Logger uses. */
	level: LogLevel;
	/**
	 * `true` when the configured value was set (not `undefined`, `null` or blank)
	 * but is neither a known level nor an alias, so {@link DEFAULT_LOG_LEVEL} is
	 * used instead. The CDK entry uses this to add a synth warning.
	 */
	unknown: boolean;
}

/**
 * Resolve a configured level to a valid {@link LogLevel}.
 *
 * The `LogLevel` type only guards literals; a level read from an env var or a
 * JSON config reaches the constructor unchecked. Matching is case-insensitive
 * (`'WARN'` → `'warn'`), and the aliases `'warning'`, `'trace'` and `'fatal'`
 * map to `'warn'`, `'debug'` and `'error'`. `undefined`, `null` and an empty
 * string mean "not set" and use {@link DEFAULT_LOG_LEVEL} silently. Any other
 * unknown value falls back to {@link DEFAULT_LOG_LEVEL} and writes one `warn`
 * line per Logger, instead of throwing (logging should never break the app) or
 * silently dropping every line (an unknown level matches nothing).
 *
 * @param defaultContext - The Logger's `defaultContext`, included on the
 *   fallback warning like on every other line the Logger writes.
 */
export function resolveLevel(
	configured: unknown,
	loggerName: string,
	defaultContext?: Record<string, unknown>,
): ResolvedLevel {
	if (configured === undefined || configured === null) return { level: DEFAULT_LOG_LEVEL, unknown: false };
	const normalized = typeof configured === 'string' ? configured.trim().toLowerCase() : configured;
	// An empty string is how an unset env var usually arrives; treat it as "not set".
	if (normalized === '') return { level: DEFAULT_LOG_LEVEL, unknown: false };
	// hasOwn, not `in`, so prototype keys such as 'constructor' are not aliases.
	const aliased =
		typeof normalized === 'string' && Object.hasOwn(LEVEL_ALIASES, normalized)
			? LEVEL_ALIASES[normalized]
			: normalized;
	if (isLogLevel(aliased)) return { level: aliased, unknown: false };
	// defaultContext goes first so buildEntry's reserved-field guard still applies
	// and the two level fields below always win over a same-named context key.
	writeLog('warn', 'warn', loggerName, `Unknown log level; using '${DEFAULT_LOG_LEVEL}'`, [
		defaultContext ?? {},
		{ configuredLevel: configured, effectiveLevel: DEFAULT_LOG_LEVEL },
	]);
	return { level: DEFAULT_LOG_LEVEL, unknown: true };
}

/** Write one JSON log line: `error` to stderr, everything else to stdout. */
export function writeLog(
	level: LogLevel,
	threshold: LogLevel,
	loggerName: string,
	message: string,
	contexts: Record<string, unknown>[],
): void {
	if (!shouldLog(level, threshold)) return;
	const line = buildEntry(level, message, loggerName, contexts);
	if (level === 'error') {
		process.stderr.write(line + '\n');
	} else {
		process.stdout.write(line + '\n');
	}
}

/** A logger with merged context, returned by `child()`. */
export class ChildLoggerImpl implements ChildLogger {
	constructor(
		private loggerName: string,
		private level: LogLevel,
		private mergedContext: Record<string, unknown>,
	) {}

	debug(message: string, context?: Record<string, unknown>): void {
		this.emit('debug', message, context);
	}

	info(message: string, context?: Record<string, unknown>): void {
		this.emit('info', message, context);
	}

	warn(message: string, context?: Record<string, unknown>): void {
		this.emit('warn', message, context);
	}

	error(message: string, context?: Record<string, unknown>): void {
		this.emit('error', message, context);
	}

	child(context: Record<string, unknown>): ChildLogger {
		return new ChildLoggerImpl(
			this.loggerName,
			this.level,
			{ ...this.mergedContext, ...context },
		);
	}

	private emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
		writeLog(level, this.level, this.loggerName, message, [this.mergedContext, context ?? {}]);
	}
}
