// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for the OTel Metrics building block. Zero runtime dependencies
 * beyond type-only imports from `@opentelemetry/api`.
 *
 * `OtelMetrics` offers an ergonomic `emit`/`child` surface while exposing OpenTelemetry's
 * typed instruments and the raw `Meter` as an escape hatch. Telemetry is exported via the
 * in-process OTel SDK (see `@aws-blocks/otel-common`) to the collector layer.
 */
import type { Counter, Histogram, UpDownCounter, ObservableGauge, Meter } from '@opentelemetry/api';
import type { ChildLogger } from '@aws-blocks/bb-logger';

/**
 * Unit of a metric value, expressed in {@link https://ucum.org/ UCUM} as OpenTelemetry
 * requires. Passed straight through to the OTel instrument's `unit`. Common values:
 * `'1'` (dimensionless/count), `'s'`, `'ms'`, `'us'`, `'By'` (bytes), `'%'`.
 * Any UCUM string is allowed; this union is just the common set for autocomplete.
 */
export type MetricUnit = '1' | 's' | 'ms' | 'us' | 'By' | '%' | (string & {});

/** Options for a single `emit`. */
export interface EmitOptions {
	/** UCUM unit of the metric value. Defaults to `'1'`. */
	unit?: MetricUnit;
	/** Attributes for this data point. Merged over `defaultAttributes` (per-emit wins). */
	attributes?: Record<string, string>;
}

/** Configuration for the OTel Metrics building block. */
export interface OtelMetricsOptions {
	/**
	 * `service.name` resource attribute (OTel semconv). Set once per process via the SDK
	 * Resource. Defaults to `BLOCKS_STACK_NAME`, then the block's scope `fullId`.
	 */
	serviceName?: string;
	/** `service.namespace` resource attribute — a grouping for related services. */
	serviceNamespace?: string;
	/** `service.version` resource attribute. */
	serviceVersion?: string;
	/**
	 * Instrumentation scope name — the OTel Meter name (`@instrumentation.@name` in
	 * CloudWatch PromQL). Identifies the producing module, NOT the service. Defaults to
	 * the block's scope `fullId`.
	 */
	meterName?: string;
	/** Attributes applied to every metric. Per-emit attributes win on conflict. */
	defaultAttributes?: Record<string, string>;
	/** Optional logger for internal operations. Defaults to an error-level Logger. */
	logger?: ChildLogger;
}

/**
 * A child metrics emitter with merged default attributes. Provides the ergonomic
 * emission surface but is not a Scope node.
 */
export interface OtelMetricsEmitter {
	emit(name: string, value: number, options?: EmitOptions): void;
	flush(): void;
	child(attributes: Record<string, string>): OtelMetricsEmitter;
}

// Re-export the OTel instrument handle types for the escape-hatch API surface.
export type { Counter, Histogram, UpDownCounter, ObservableGauge, Meter } from '@opentelemetry/api';
