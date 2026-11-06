// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared serialization logic for the Logger building block.
 * Handles safe JSON serialization with circular reference detection,
 * BigInt conversion, Error object extraction, and log level filtering.
 */

import { currentRequestId } from '@aws-blocks/core/bb-utils';
import type { LogLevel } from './types.js';
import { LoggingErrors } from './errors.js';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

/**
 * Check whether a message at `messageLevel` should be emitted given `configuredLevel`.
 */
export function shouldLog(messageLevel: LogLevel, configuredLevel: LogLevel): boolean {
	return LEVEL_PRIORITY[messageLevel] >= LEVEL_PRIORITY[configuredLevel];
}

/**
 * Process a context value for serialization. Extracts Error instances into
 * plain objects with name/message/stack.
 */
export function processValue(value: unknown): unknown {
	if (value instanceof Error) {
		return { name: value.name, message: value.message, stack: value.stack };
	}
	return value;
}

/**
 * Safely stringify an object, handling circular references and BigInt values.
 * Falls back to a degraded entry on unexpected serialization failure.
 */
export function safeStringify(obj: Record<string, unknown>): string {
	const seen = new WeakSet();
	try {
		return JSON.stringify(obj, (_key, value) => {
			if (typeof value === 'bigint') return value.toString();
			if (typeof value === 'object' && value !== null) {
				if (seen.has(value)) return '[Circular]';
				seen.add(value);
			}
			if (typeof value === 'function' || typeof value === 'symbol') {
				return '[unserializable]';
			}
			return value;
		});
	} catch {
		return JSON.stringify({
			level: obj.level,
			message: obj.message,
			timestamp: obj.timestamp,
			logger: obj.logger,
			// Keep the correlation ids: degraded lines are the ones most worth tracing.
			awsRequestId: typeof obj.awsRequestId === 'string' ? obj.awsRequestId : undefined,
			requestId: typeof obj.requestId === 'string' ? obj.requestId : undefined,
			traceId: typeof obj.traceId === 'string' ? obj.traceId : undefined,
			_serializationError: LoggingErrors.SerializationFailed,
		});
	}
}

/**
 * Structural log fields that the logger owns. User context keys that collide
 * with these are NOT allowed to overwrite the real values — otherwise a context
 * key like `{ level: 'debug' }` on an error log would silently corrupt the
 * entry and break level-based CloudWatch filtering/queries.
 */
const RESERVED_FIELDS = new Set(['level', 'message', 'timestamp', 'logger', 'traceId', 'awsRequestId']);

/**
 * Build a serialized log entry string. Structural fields are written first to
 * guarantee consistent JSON property order (`level` always appears first), then
 * user contexts are merged — reserved keys are skipped so user data can never
 * clobber level/message/timestamp/logger/traceId/awsRequestId.
 *
 * @param level - Log severity level.
 * @param message - Log message.
 * @param loggerName - The logger's identifier.
 * @param contexts - Array of context objects to merge (later entries override earlier).
 * @returns A JSON string ready to be written to stdout/stderr.
 */
export function buildEntry(
	level: LogLevel,
	message: string,
	loggerName: string,
	contexts: Record<string, unknown>[],
): string {
	const now = Date.now();
	const entry: Record<string, unknown> = {
		level,
		message,
		timestamp: new Date(now).toISOString(),
		logger: loggerName,
	};

	// The Lambda invocation's awsRequestId, so every line one request logs can be
	// correlated. Reserved, so context can't replace it; an app's own `requestId`
	// context field is a separate key and is left alone.
	const awsRequestId = currentRequestId();
	if (awsRequestId) entry.awsRequestId = awsRequestId;

	// Merge user context — reserved keys are skipped (structural fields already written above).
	for (const ctx of contexts) {
		for (const [key, value] of Object.entries(ctx)) {
			if (RESERVED_FIELDS.has(key)) continue;
			entry[key] = processValue(value);
		}
	}

	const rawTraceId = process.env._X_AMZN_TRACE_ID;
	if (rawTraceId) {
		const rootMatch = rawTraceId.match(/Root=([^;]+)/);
		entry.traceId = rootMatch ? rootMatch[1] : rawTraceId;
	}

	return safeStringify(entry);
}
