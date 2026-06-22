// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope, registerSdkIdentifiers } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import type { Logger as OtelApiLogger, LogAttributes } from '@opentelemetry/api-logs';
import { getOrCreateOtelSdk } from '@aws-blocks/otel-common';
import type { LogLevel, OtelLoggingOptions, OtelChildLogger } from './types.js';
import { coerceAttributes } from './serializer.js';

export { OtelLoggingErrors } from './errors.js';
export type { LogLevel, OtelLoggingOptions, OtelChildLogger, OtelApiLogger } from './types.js';

const LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const SEVERITY: Record<LogLevel, SeverityNumber> = {
	debug: SeverityNumber.DEBUG,
	info: SeverityNumber.INFO,
	warn: SeverityNumber.WARN,
	error: SeverityNumber.ERROR,
};

function shouldLog(message: LogLevel, configured: LogLevel): boolean {
	return LEVEL_PRIORITY[message] >= LEVEL_PRIORITY[configured];
}

/**
 * Structured logging via OpenTelemetry, exported to Amazon CloudWatch Logs through
 * the OTLP endpoint (in-process OTel SDK + collector layer).
 *
 * Keeps the `debug/info/warn/error` + `child` surface of the stdout-based `Logger`,
 * and exposes the raw OTel `Logger` (`rawLogger`) for full Logs-Bridge-API access.
 *
 * **When to use:** vendor-neutral OTel logs correlated with OTel traces, or to point
 * logs at a third-party OTLP backend. For the AWS-native stdout path, use `Logger`.
 */
export class OtelLogger extends Scope implements OtelChildLogger {
	private level: LogLevel;
	private defaultContext: Record<string, unknown>;
	private otelLogger: OtelApiLogger;

	constructor(scope: ScopeParent, id: string, options?: OtelLoggingOptions) {
		super(id, { parent: scope });
		this.level = options?.level ?? (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info';
		this.defaultContext = options?.defaultContext ?? {};
		getOrCreateOtelSdk({
			resource: {
				serviceName: options?.serviceName,
				serviceNamespace: options?.serviceNamespace,
				serviceVersion: options?.serviceVersion,
			},
			defaultServiceName: this.fullId,
		});
		this.otelLogger = logs.getLogger(this.fullId);

		// Publish the log group so app code / the Dashboard can locate it at runtime.
		const logGroupName = `/aws/otel/${this.fullId}`;
		registerSdkIdentifiers(this.fullId, { logGroupName });
	}

	debug(message: string, context?: Record<string, unknown>): void { this.emit('debug', message, context); }
	info(message: string, context?: Record<string, unknown>): void { this.emit('info', message, context); }
	warn(message: string, context?: Record<string, unknown>): void { this.emit('warn', message, context); }
	error(message: string, context?: Record<string, unknown>): void { this.emit('error', message, context); }

	child(context: Record<string, unknown>): OtelChildLogger {
		return new ChildOtelLogger(this.otelLogger, this.level, { ...this.defaultContext, ...context });
	}

	/** The underlying OTel Logs-Bridge `Logger` — full escape hatch. */
	get rawLogger(): OtelApiLogger {
		return this.otelLogger;
	}

	private emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
		if (!shouldLog(level, this.level)) return;
		const attributes: LogAttributes = coerceAttributes([this.defaultContext, context ?? {}]);
		this.otelLogger.emit({
			severityNumber: SEVERITY[level],
			severityText: level.toUpperCase(),
			body: message,
			attributes,
		});
	}
}

// ── ChildOtelLogger ────────────────────────────────────────────────────────────

class ChildOtelLogger implements OtelChildLogger {
	constructor(
		private otelLogger: OtelApiLogger,
		private level: LogLevel,
		private mergedContext: Record<string, unknown>,
	) {}

	debug(message: string, context?: Record<string, unknown>): void { this.emit('debug', message, context); }
	info(message: string, context?: Record<string, unknown>): void { this.emit('info', message, context); }
	warn(message: string, context?: Record<string, unknown>): void { this.emit('warn', message, context); }
	error(message: string, context?: Record<string, unknown>): void { this.emit('error', message, context); }

	child(context: Record<string, unknown>): OtelChildLogger {
		return new ChildOtelLogger(this.otelLogger, this.level, { ...this.mergedContext, ...context });
	}

	private emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
		if (!shouldLog(level, this.level)) return;
		this.otelLogger.emit({
			severityNumber: SEVERITY[level],
			severityText: level.toUpperCase(),
			body: message,
			attributes: coerceAttributes([this.mergedContext, context ?? {}]),
		});
	}
}
