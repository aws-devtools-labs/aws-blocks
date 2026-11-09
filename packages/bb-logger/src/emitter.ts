// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared write path for the Logger building block. The runtime and CDK entries
 * declare their own `Logger` class (each extends a different `Scope`), but both
 * delegate here so logging behaves the same in Lambda, local dev, and `cdk synth`.
 */

import type { ChildLogger, LogLevel } from './types.js';
import { buildEntry, shouldLog } from './serializer.js';

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
