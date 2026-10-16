// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import { Scope } from '@aws-blocks/core/cdk';
import { ChildLoggerImpl, writeLog } from './emitter.js';
import type { ChildLogger, LoggingOptions, LogLevel } from './types.js';

// Re-export public types and errors (no runtime dependencies)
export { LoggingErrors } from './errors.js';
export type { ChildLogger, LogEntry, LoggingOptions, LogLevel } from './types.js';

/**
 * CDK construct for Logger.
 *
 * Logger owns **no** deploy-time infrastructure. Logging is always on — every
 * compute captures stdout to its own log group, and **retention is a
 * compute-level setting** (`compute` `logRetention`, falling back to
 * `defaults.logRetention`). The log **level** is purely **runtime** behavior: a
 * `Logger`'s `level` / `defaultContext` are applied by the logger instance
 * itself (per-instance), and a logger without an explicit `level` defaults to
 * `'info'` — no deploy-time default or env var is involved.
 * So the CDK construct is a no-op placeholder that just lets
 * `new Logger(scope, id)` resolve in a CDK app; multiple Loggers coexist freely.
 *
 * The logging methods still work during synth: a top-level `log.info(...)` in a
 * backend module also runs under `cdk synth`, and it writes the same JSON line
 * (honoring `level` and `defaultContext`) as the runtime Logger does.
 */
export class Logger extends Scope implements ChildLogger {
	private level: LogLevel;
	private defaultContext: Record<string, unknown>;
	private loggerName: string;

	constructor(scope: ScopeParent, id: string, options?: LoggingOptions) {
		super(id, { parent: scope });
		this.loggerName = id;
		this.level = options?.level ?? 'info';
		this.defaultContext = options?.defaultContext ?? {};
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
		writeLog(level, this.level, this.loggerName, message, [this.defaultContext, context ?? {}]);
	}
}
