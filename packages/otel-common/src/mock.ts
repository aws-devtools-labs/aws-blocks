// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local-development exporters for the OTel blocks. There is no collector locally,
 * so the in-process SDK exports to stdout (metrics/logs) and a `.bb-data` file
 * (traces), matching the existing `bb-metrics`/`bb-logger`/`bb-tracer` mock conventions.
 *
 * The OTel SDK call path and escape-hatch handles are identical to production — only
 * the exporter destination differs.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ConsoleMetricExporter } from '@opentelemetry/sdk-metrics';
import { ConsoleLogRecordExporter } from '@opentelemetry/sdk-logs';
import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { ExportResultCode } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import type { OtelExporters } from './sdk.js';

/**
 * A minimal file-backed SpanExporter that appends finished spans to a JSON file
 * (capped), mirroring the `bb-tracer` mock's `.bb-data/{fullId}/traces.json`.
 */
export class FileSpanExporter implements SpanExporter {
	constructor(private readonly filePath: string, private readonly cap = 100) {}

	export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
		try {
			let existing: unknown[] = [];
			if (existsSync(this.filePath)) {
				try { existing = JSON.parse(readFileSync(this.filePath, 'utf8')); } catch { /* start fresh */ }
			}
			for (const s of spans) {
				existing.push({
					traceId: s.spanContext().traceId,
					spanId: s.spanContext().spanId,
					name: s.name,
					kind: s.kind,
					startTime: s.startTime,
					endTime: s.endTime,
					attributes: s.attributes,
					status: s.status,
					events: s.events,
				});
			}
			if (existing.length > this.cap) existing = existing.slice(-this.cap);
			mkdirSync(dirname(this.filePath), { recursive: true });
			writeFileSync(this.filePath, JSON.stringify(existing, null, 2));
			resultCallback({ code: ExportResultCode.SUCCESS });
		} catch (err) {
			resultCallback({ code: ExportResultCode.FAILED, error: err as Error });
		}
	}

	async shutdown(): Promise<void> {}
	async forceFlush(): Promise<void> {}
}

/**
 * Exporters for local dev: traces → `tracesFilePath` (JSON file), metrics & logs →
 * stdout (`ConsoleMetricExporter` / `ConsoleLogRecordExporter`).
 */
export function mockExporters(tracesFilePath: string): OtelExporters {
	return {
		traceExporter: () => new FileSpanExporter(tracesFilePath),
		metricExporter: () => new ConsoleMetricExporter(),
		logExporter: () => new ConsoleLogRecordExporter(),
	};
}
