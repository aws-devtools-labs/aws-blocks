// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for Logger. Imported by mock, aws, cdk, and browser entry points.
 * This file has zero runtime dependencies — types only.
 */

/** Log severity levels, ordered from most verbose to least. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** CloudWatch Logs retention periods (in days). Matches the AWS API. */
export type RetentionDays =
	| 1 | 3 | 5 | 7 | 14 | 30 | 60 | 90 | 120 | 150 | 180
	| 365 | 400 | 545 | 731 | 1096 | 1827 | 2192 | 2557 | 2922 | 3288 | 3653;

/** Configuration for the Logger building block. */
export interface LoggingOptions {
	/** Minimum log level. Messages below this are silently dropped. Default: 'info'. */
	level?: LogLevel;
	/**
	 * Fields included in every log entry from this logger.
	 *
	 * Note: the reserved structural keys `level`, `message`, `timestamp`,
	 * `logger`, and `traceId` are owned by the logger and cannot be overridden
	 * via context — any such keys in context are ignored so they can't corrupt
	 * the entry's real level/message/etc.
	 */
	defaultContext?: Record<string, unknown>;
	/**
	 * CloudWatch Logs retention period for the shared handler log group. When
	 * set, it overrides the stack-wide `defaults.logRetention` on the single,
	 * framework-owned handler log group (the Logger does not create its own
	 * group). When omitted, the stack-wide default retention applies. Ignored in
	 * local dev.
	 */
	retention?: RetentionDays;
}

/** A structured log entry as emitted to stdout/stderr. */
export interface LogEntry {
	level: LogLevel;
	message: string;
	/** ISO 8601 timestamp. */
	timestamp: string;
	/** The logger's id. */
	logger: string;
	/** X-Ray trace ID. Auto-injected when running in Lambda with X-Ray enabled. */
	traceId?: string;
	[key: string]: unknown;
}

/**
 * A child logger instance. Returned by `Logger.child()`. Provides the same
 * logging methods as the root Logger BB but is not a Scope node.
 */
export interface ChildLogger {
	debug(message: string, context?: Record<string, unknown>): void;
	info(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
	error(message: string, context?: Record<string, unknown>): void;
	child(context: Record<string, unknown>): ChildLogger;
}
