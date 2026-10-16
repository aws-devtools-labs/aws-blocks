// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import type {
	MetricsOptions,
	EmitOptions,
	MetricDatum,
	MetricUnit,
	MetricResolution,
	ExternalMetricsRef,
	MetricsEmitter,
} from './types.js';
import { MetricsErrors } from './errors.js';
import { BB_NAME, BB_VERSION } from './version.js';
import {
	validateMetricName,
	validateMetricValue,
	validateTimestamp,
	validateDimensions,
	validateBatchSize,
	validateNamespace,
	mergeDimensions,
} from './validation.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';

export { MetricsErrors } from './errors.js';
export type {
	MetricsOptions,
	EmitOptions,
	MetricDatum,
	MetricUnit,
	MetricResolution,
	ExternalMetricsRef,
	MetricsEmitter,
} from './types.js';

// ── Metrics (AWS runtime via EMF) ───────────────────────────────────────────

/**
 * Custom application metrics backed by Amazon CloudWatch (via EMF).
 *
 * Metrics emitted from this Building Block appear in CloudWatch under the
 * configured namespace. Use for dashboards, alarms, and operational visibility.
 *
 * Uses CloudWatch Embedded Metric Format (EMF) — writes metric data as
 * structured JSON to stdout. Lambda captures these and CloudWatch extracts
 * metrics automatically.
 *
 * **When to use:** You need to track numeric measurements over time — request
 * counts, error rates, latency, queue depths, business KPIs.
 *
 * **When NOT to use:** If you need structured log output only, use `Logging`.
 * If you need distributed request tracing, use `Tracing`. If you need to store
 * time-series data for querying, use `Database` or `DistributedTable`.
 *
 * **Best practices:**
 * - Keep dimension cardinality low (avoid user IDs or request IDs as dimensions)
 * - Use consistent metric names across your application
 * - Use `defaultDimensions` for shared context (service name, environment)
 * - Prefer `emitBatch` when recording multiple metrics in a single request
 * - Use units to enable automatic conversions in CloudWatch dashboards
 *
 * **Scaling:** CloudWatch accepts unlimited metrics via EMF. Standard resolution
 * metrics (60s) are retained for 15 days; high-resolution (1s) for 3 hours,
 * then aggregated. Costs scale with unique metric name + dimension combinations.
 *
 * **Local development:** Metrics are written as EMF JSON to stdout (same as AWS).
 * No disk persistence — metrics are ephemeral in local dev.
 *
 * **⚠️ Synchronous:** All metric methods are synchronous (void, not Promise).
 * EMF writes to stdout which Lambda captures asynchronously. Returning a Promise
 * would add overhead for zero benefit.
 *
 * @example
 * ```typescript
 * import { Metrics } from '@aws-blocks/bb-metrics';
 *
 * const metrics = new Metrics(scope, 'appMetrics', {
 *   namespace: 'MyApp/Orders',
 *   defaultDimensions: { service: 'orders' },
 * });
 *
 * metrics.emit('RequestCount', 1, { unit: 'Count' });
 * metrics.emit('Latency', 42, { unit: 'Milliseconds' });
 * ```
 */
export class Metrics extends Scope implements MetricsEmitter {
	/** The resolved CloudWatch namespace for metrics emitted by this instance. */
	readonly namespace: string;
	/** Dimensions applied to every metric emitted by this instance. */
	readonly defaultDimensions: Readonly<Record<string, string>>;

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options?: MetricsOptions) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		this.namespace = options?.metrics?.namespace
			?? options?.namespace
			?? this.fullId;
		this.defaultDimensions = options?.defaultDimensions ?? {};
		validateNamespace(this.namespace);
	}

	/**
	 * Record a single metric data point via EMF.
	 *
	 * @param name - Metric name (e.g., 'RequestCount', 'Latency'). Non-empty, max 1024 chars.
	 * @param value - Finite numeric value between -2^360 and 2^360.
	 * @param options - Unit, dimensions, timestamp, and resolution.
	 * @throws {MetricsErrors.InvalidMetricName} If the metric name is empty or exceeds 1024 characters.
	 * @throws {MetricsErrors.InvalidMetricValue} If the metric value is non-finite or outside the CloudWatch-supported range.
	 * @throws {MetricsErrors.InvalidTimestamp} If the timestamp is an invalid Date.
	 * @throws {MetricsErrors.InvalidDimensions} If dimensions exceed 30 entries or contain empty keys/values.
	 *
	 * @example
	 * ```typescript
	 * metrics.emit('RequestCount', 1);
	 * metrics.emit('Latency', 42, { unit: 'Milliseconds' });
	 * metrics.emit('ErrorRate', 0.05, {
	 *   unit: 'Percent',
	 *   dimensions: { endpoint: '/api/orders' },
	 * });
	 * ```
	 */
	emit(name: string, value: number, options?: EmitOptions): void {
		validateMetricName(name);
		validateMetricValue(value);
		validateTimestamp(options?.timestamp);
		const dims = mergeDimensions(this.defaultDimensions, options?.dimensions);
		validateDimensions(dims);

		writeEmf(this.namespace, [{
			name,
			value,
			unit: options?.unit ?? 'None',
			dimensions: dims,
			timestamp: options?.timestamp,
			resolution: options?.resolution ?? 'standard',
		}]);
	}

	/**
	 * Record multiple metric data points in a single EMF document.
	 * Metrics with the same dimension set are grouped into one EMF entry.
	 *
	 * @param metrics - Array of metric data points (max 100 per call).
	 * @throws {MetricsErrors.InvalidMetricName} If any metric name is invalid.
	 * @throws {MetricsErrors.InvalidMetricValue} If any metric value is non-finite or outside the CloudWatch-supported range.
	 * @throws {MetricsErrors.InvalidTimestamp} If any metric timestamp is an invalid Date.
	 * @throws {MetricsErrors.InvalidDimensions} If any metric's dimensions are invalid.
	 * @throws {MetricsErrors.BatchTooLarge} If the batch exceeds 100 metrics.
	 *
	 * @example
	 * ```typescript
	 * metrics.emitBatch([
	 *   { name: 'RequestCount', value: 1, unit: 'Count' },
	 *   { name: 'Latency', value: 42, unit: 'Milliseconds' },
	 *   { name: 'ErrorCount', value: 0, unit: 'Count' },
	 * ]);
	 * ```
	 */
	emitBatch(metrics: MetricDatum[]): void {
		validateBatchSize(metrics.length);

		for (const m of metrics) {
			validateMetricName(m.name);
			validateMetricValue(m.value);
			validateTimestamp(m.timestamp);
			const dims = mergeDimensions(this.defaultDimensions, m.dimensions);
			validateDimensions(dims);
		}

		const resolved = metrics.map(m => ({
			name: m.name,
			value: m.value,
			unit: (m.unit ?? 'None') as MetricUnit,
			dimensions: mergeDimensions(this.defaultDimensions, m.dimensions),
			timestamp: m.timestamp,
			resolution: (m.resolution ?? 'standard') as MetricResolution,
		}));

		writeEmf(this.namespace, resolved);
	}

	/**
	 * No-op. EMF writes are synchronous stdout writes — no buffering to flush.
	 */
	flush(): void {}

	/**
	 * Create a child Metrics emitter with inherited namespace and dimensions.
	 * The child merges the provided dimensions on top of the parent's defaults.
	 *
	 * @param dimensions - Additional dimensions for the child instance.
	 * @returns A MetricsEmitter with merged dimensions.
	 *
	 * @example
	 * ```typescript
	 * const requestMetrics = metrics.child({ endpoint: '/api/users', method: 'GET' });
	 * requestMetrics.emit('RequestCount', 1);
	 * ```
	 */
	child(dimensions: Record<string, string>): MetricsEmitter {
		return new ChildMetrics(
			this.namespace,
			{ ...this.defaultDimensions, ...dimensions },
		);
	}

	/**
	 * Reference an existing CloudWatch namespace not managed by this Building Block.
	 *
	 * @param namespace - The CloudWatch namespace string.
	 *
	 * @example
	 * ```typescript
	 * const metrics = new Metrics(scope, 'legacy', {
	 *   metrics: Metrics.fromExisting('MyOrg/SharedMetrics'),
	 * });
	 * ```
	 */
	static fromExisting(namespace: string): ExternalMetricsRef {
		return { __brand: 'ExternalMetricsRef' as const, namespace };
	}
}

// ── ChildMetrics ────────────────────────────────────────────────────────────

class ChildMetrics implements MetricsEmitter {
	constructor(
		private namespace: string,
		readonly defaultDimensions: Readonly<Record<string, string>>,
	) {}

	emit(name: string, value: number, options?: EmitOptions): void {
		validateMetricName(name);
		validateMetricValue(value);
		validateTimestamp(options?.timestamp);
		const dims = mergeDimensions(this.defaultDimensions, options?.dimensions);
		validateDimensions(dims);

		writeEmf(this.namespace, [{
			name,
			value,
			unit: options?.unit ?? 'None',
			dimensions: dims,
			timestamp: options?.timestamp,
			resolution: options?.resolution ?? 'standard',
		}]);
	}

	emitBatch(metrics: MetricDatum[]): void {
		validateBatchSize(metrics.length);

		for (const m of metrics) {
			validateMetricName(m.name);
			validateMetricValue(m.value);
			validateTimestamp(m.timestamp);
			const dims = mergeDimensions(this.defaultDimensions, m.dimensions);
			validateDimensions(dims);
		}

		const resolved = metrics.map(m => ({
			name: m.name,
			value: m.value,
			unit: (m.unit ?? 'None') as MetricUnit,
			dimensions: mergeDimensions(this.defaultDimensions, m.dimensions),
			timestamp: m.timestamp,
			resolution: (m.resolution ?? 'standard') as MetricResolution,
		}));

		writeEmf(this.namespace, resolved);
	}

	flush(): void {}

	child(dimensions: Record<string, string>): MetricsEmitter {
		return new ChildMetrics(
			this.namespace,
			{ ...this.defaultDimensions, ...dimensions },
		);
	}
}

// ── EMF Writer ──────────────────────────────────────────────────────────────

interface ResolvedMetric {
	name: string;
	value: number;
	unit: string;
	dimensions: Record<string, string>;
	timestamp?: Date;
	resolution: MetricResolution;
}

interface MetricGroup {
	dimensions: Record<string, string>;
	metrics: ResolvedMetric[];
}

/**
 * Write one or more metrics as EMF-formatted JSON lines to stdout.
 * Groups metrics by dimension set (EMF requires same dimensions per entry).
 */
function writeEmf(namespace: string, metrics: ResolvedMetric[]): void {
	if (metrics.length === 0) return;

	const groups = groupByDimensions(metrics);

	for (const group of groups) {
		const dimKeys = Object.keys(group.dimensions);
		const timestamp = group.metrics[0].timestamp?.getTime() ?? Date.now();

		const emfPayload: Record<string, unknown> = {
			_aws: {
				Timestamp: timestamp,
				CloudWatchMetrics: [{
					Namespace: namespace,
					Dimensions: dimKeys.length > 0 ? [dimKeys] : [[]],
					Metrics: group.metrics.map(m => ({
						Name: m.name,
						Unit: m.unit,
						StorageResolution: m.resolution === 'high' ? 1 : 60,
					})),
				}],
			},
			...group.dimensions,
		};

		for (const m of group.metrics) {
			emfPayload[m.name] = m.value;
		}

		process.stdout.write(JSON.stringify(emfPayload) + '\n');
	}
}

/**
 * Group metrics by their dimension set. EMF requires metrics in the same
 * CloudWatchMetrics entry to share the same dimension keys and values.
 */
function groupByDimensions(metrics: ResolvedMetric[]): MetricGroup[] {
	const groups = new Map<string, MetricGroup>();

	for (const m of metrics) {
		const key = dimensionKey(m.dimensions);
		let group = groups.get(key);
		if (!group) {
			group = { dimensions: m.dimensions, metrics: [] };
			groups.set(key, group);
		}
		group.metrics.push(m);
	}

	return Array.from(groups.values());
}

function dimensionKey(dims: Record<string, string>): string {
	const sorted = Object.entries(dims).sort(([a], [b]) => a.localeCompare(b));
	return sorted.map(([k, v]) => `${k}=${v}`).join('&');
}
