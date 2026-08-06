// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope, registerSdkIdentifiers } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import type { LogLevel, LoggingOptions, ChildLogger } from './types.js';
import { shouldLog, buildEntry } from './serializer.js';
import { BB_NAME, BB_VERSION } from './version.js';

// ── Public types ────────────────────────────────────────────────────────────

export { LoggingErrors } from './errors.js';
export type { LogLevel, LoggingOptions, LogEntry, ChildLogger, RetentionDays } from './types.js';

// ── Logger (AWS runtime) ──────────────────────────────────────────────────────────

/**
 * Structured logging with consistent format, log levels, and contextual metadata.
 *
 * **When to use:** You need structured, queryable application logs with
 * consistent format across your backend. Good for request logging, audit
 * trails, debugging context, and operational visibility.
 *
 * **When NOT to use:** If you need numeric measurements over time, use
 * `Metrics`. If you need distributed request tracing, use `Tracing`.
 *
 * **Best practices:**
 * - Use `child()` to create request-scoped loggers with correlation IDs
 * - Keep context values simple and serializable (strings, numbers, booleans)
 * - Use appropriate log levels: `debug` for development, `info` for normal
 *   operations, `warn` for recoverable issues, `error` for failures
 * - Set `level` to `'warn'` or `'error'` in production to reduce log volume
 *
 * **Scaling:** No throughput limits from the BB itself. CloudWatch Logs
 * ingestion scales with Lambda concurrency. Cost is per GB ingested +
 * per GB stored. Use log level filtering and `retention` to control costs.
 *
 * **⚠️ G4 Exception:** All logging methods (`debug`, `info`, `warn`, `error`)
 * are **synchronous**, not async. Logging writes to stdout/stderr which Lambda
 * captures asynchronously. Returning a Promise would add overhead for zero
 * benefit. Logging should never block.
 */
export class Logger extends Scope implements ChildLogger {
	private level: LogLevel;
	private defaultContext: Record<string, unknown>;
	private loggerName: string;

	constructor(scope: ScopeParent, id: string, options?: LoggingOptions) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.loggerName = id;
		this.level = options?.level
			?? (process.env.LOG_LEVEL as LogLevel | undefined)
			?? 'info';
		this.defaultContext = options?.defaultContext ?? {};
		const logGroupName = `/aws/lambda/${process.env.AWS_LAMBDA_FUNCTION_NAME ?? this.fullId}`;
		registerSdkIdentifiers(this.fullId, { logGroupName });
	}

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
			{ ...this.defaultContext, ...context },
		);
	}

	private emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
		if (!shouldLog(level, this.level)) return;
		const line = buildEntry(level, message, this.loggerName, [
			this.defaultContext,
			context ?? {},
		]);
		if (level === 'error') {
			process.stderr.write(line + '\n');
		} else {
			process.stdout.write(line + '\n');
		}
	}
}

// ── ChildLoggerImpl ────────────────────────────────────────────────────────────

class ChildLoggerImpl implements ChildLogger {
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
		if (!shouldLog(level, this.level)) return;
		const line = buildEntry(level, message, this.loggerName, [
			this.mergedContext,
			context ?? {},
		]);
		if (level === 'error') {
			process.stderr.write(line + '\n');
		} else {
			process.stdout.write(line + '\n');
		}
	}
}
