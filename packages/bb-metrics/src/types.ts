// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for the Metrics building block.
 * This file has zero runtime dependencies — types only.
 */
import type { ChildLogger } from '@aws-blocks/bb-logger';

/**
 * Units supported by CloudWatch. Using a unit enables automatic conversions
 * in dashboards (e.g., Bytes → Megabytes) and clearer Y-axis labels.
 *
 * Covers the most common use cases. For unlisted units, use 'None'.
 */
export type MetricUnit =
	| 'Count'
	| 'Seconds'
	| 'Milliseconds'
	| 'Microseconds'
	| 'Bytes'
	| 'Kilobytes'
	| 'Megabytes'
	| 'Gigabytes'
	| 'Percent'
	| 'Bits/Second'
	| 'None';

/**
 * Storage resolution for a metric data point.
 * - 'standard' (60s) — default, lower cost, 15-day retention at full resolution
 * - 'high' (1s) — higher cost, 3-hour retention at full resolution then aggregated
 */
export type MetricResolution = 'standard' | 'high';

/**
 * Configuration for the Metrics building block.
 */
export interface MetricsOptions {
	/**
	 * CloudWatch namespace for all metrics emitted by this instance.
	 * Namespaces group related metrics in CloudWatch dashboards and alarms.
	 * Defaults to the scope's `fullId` (e.g., 'myapp-appMetrics').
	 */
	namespace?: string;

	/**
	 * Dimensions applied to every metric emitted by this instance.
	 * Useful for shared context like service name or environment.
	 * Per-emit dimensions are merged on top of these (per-emit wins on conflict).
	 */
	defaultDimensions?: Record<string, string>;

	/**
	 * Wrap an existing CloudWatch namespace instead of creating one.
	 * When set, `namespace` is ignored.
	 */
	metrics?: ExternalMetricsRef;
	/** Optional logger for internal operations. When omitted, a default Logger at error level is created. */
	logger?: ChildLogger;
}

/**
 * Options for a single metric emission.
 */
export interface EmitOptions {
	/** Unit of the metric value. Defaults to 'None'. */
	unit?: MetricUnit;
	/**
	 * Dimensions to attach to this data point (max 30 total including defaults).
	 * Merged with `defaultDimensions` — per-emit dimensions take precedence.
	 */
	dimensions?: Record<string, string>;
	/** Valid timestamp for the data point. Defaults to now. */
	timestamp?: Date;
	/**
	 * Storage resolution. 'standard' = 60-second aggregation (default).
	 * 'high' = 1-second aggregation (higher cost, useful for spike detection).
	 */
	resolution?: MetricResolution;
}

/**
 * A single metric data point for batch emission.
 */
export interface MetricDatum {
	/** Metric name (non-empty, max 1024 characters). */
	name: string;
	/** Finite numeric value between -2^360 and 2^360. */
	value: number;
	/** Unit of the metric value. Defaults to 'None'. */
	unit?: MetricUnit;
	/** Dimensions to attach (max 30 total including defaults). */
	dimensions?: Record<string, string>;
	/** Valid timestamp for the data point. Defaults to now. */
	timestamp?: Date;
	/** Storage resolution. Defaults to 'standard'. */
	resolution?: MetricResolution;
}

/**
 * Reference to an existing CloudWatch namespace not managed by this BB.
 * Created via `Metrics.fromExisting()`.
 */
export interface ExternalMetricsRef {
	readonly __brand: 'ExternalMetricsRef';
	readonly namespace: string;
}

/**
 * A child metrics instance with inherited dimensions and namespace.
 * Provides the same metric emission methods but is not a Scope node.
 */
export interface MetricsEmitter {
	emit(name: string, value: number, options?: EmitOptions): void;
	emitBatch(metrics: MetricDatum[]): void;
	flush(): void;
	child(dimensions: Record<string, string>): MetricsEmitter;
}
