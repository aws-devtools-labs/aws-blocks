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
 * Resolve a configured level to a valid {@link LogLevel}.
 *
 * The `LogLevel` type only guards literals; a level read from an env var or a
 * JSON config reaches the constructor unchecked. Matching is case-insensitive
 * (`'WARN'` → `'warn'`). `undefined`, `null` and an empty string mean "not set"
 * and use {@link DEFAULT_LOG_LEVEL} silently. Any other unknown value falls back
 * to {@link DEFAULT_LOG_LEVEL} and writes one `warn` line per Logger, instead of
 * throwing (logging should never break the app) or silently dropping every line
 * (an unknown level matches nothing).
 */
export function resolveLevel(configured: unknown, loggerName: string): LogLevel {
	if (configured === undefined || configured === null) return DEFAULT_LOG_LEVEL;
	const normalized = typeof configured === 'string' ? configured.trim().toLowerCase() : configured;
	// An empty string is how an unset env var usually arrives; treat it as "not set".
	if (normalized === '') return DEFAULT_LOG_LEVEL;
	if (isLogLevel(normalized)) return normalized;
	writeLog('warn', 'warn', loggerName, `Unknown log level; using '${DEFAULT_LOG_LEVEL}'`, [
		{ configuredLevel: configured, effectiveLevel: DEFAULT_LOG_LEVEL },
	]);
	return DEFAULT_LOG_LEVEL;
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
