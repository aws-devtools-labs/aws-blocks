// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for the Dashboard Building Block.
 * This file has zero runtime dependencies — types only (the cloudwatch import
 * below is `import type`, erased at compile time).
 *
 * Uses structural interfaces so that the real observability BB instances
 * (Metrics, Logger, Tracer) and computes satisfy these types via duck typing,
 * while tests can pass minimal mock objects.
 */
import type { Compute } from '@aws-blocks/core/cdk/internal';

// ── Observability BB structural interfaces ──────────────────────────────────

/**
 * Structural interface satisfied by `@aws-blocks/bb-metrics` instances.
 * Requires `namespace` which is the resolved CloudWatch namespace
 * (either explicitly configured or defaulting to the Metrics BB's scope fullId).
 */
export interface MetricsBBRef {
	readonly namespace: string;
	/**
	 * Default dimensions applied to every metric emitted by the Metrics BB.
	 * When present, the Dashboard BB merges these into widget queries so that
	 * CloudWatch finds the dimensioned metric stream.
	 */
	readonly defaultDimensions?: Record<string, string>;
}

/**
 * Structural interface satisfied by `@aws-blocks/bb-logger` instances.
 * Only requires `fullId` for identification. The log group name is derived
 * from the shared Lambda handler's function name.
 */
export interface LoggerBBRef {
	readonly fullId: string;
}

/**
 * Structural interface satisfied by `@aws-blocks/bb-tracer` instances.
 * Only requires `fullId` for identification. Presence implies tracing is active.
 */
export interface TracerBBRef {
	readonly fullId: string;
}

// ── Metric configuration types ──────────────────────────────────────────────

/**
 * Configuration for a single CloudWatch metric.
 *
 * @example
 * ```typescript
 * metricConfigs: [
 *   { name: 'RequestCount' },
 *   { name: 'Latency', stat: 'p99', period: 300 },
 * ]
 * ```
 */
export interface MetricConfig {
	/** CloudWatch metric name (required). */
	name: string;

	/**
	 * Aggregation statistic for the metric.
	 * @default 'Sum'
	 */
	stat?: 'Sum' | 'Average' | 'Maximum' | 'Minimum' | 'p99' | 'p95' | 'p50';

	/**
	 * Aggregation period in seconds.
	 * Must be >= 1. Valid values: 1, 5, 10, 30, 60, 120, 300, 900, 3600, etc.
	 * @default 60
	 */
	period?: number;

	/**
	 * Widget title override displayed in the CloudWatch dashboard.
	 * If not provided, defaults to the metric name.
	 * @default metric.name
	 */
	title?: string;

	/**
	 * CloudWatch metric dimensions.
	 * Dimensions narrow the scope of a metric to specific resources.
	 * Example: `{ FunctionName: 'my-handler', Alias: 'live' }`.
	 */
	dimensions?: Record<string, string>;
}

/**
 * A metrics source for the dashboard: a Metrics Building Block paired with the
 * metric names to pre-create widgets for **in that source's namespace**.
 *
 * Configs are per-source (not dashboard-wide) because metric names are specific
 * to a namespace — `OrdersPlaced` lives in the orders namespace, not the billing
 * one. With multiple sources, each renders its own metrics section from its own
 * configs.
 *
 * @example
 * ```typescript
 * metrics: { metrics: ordersMetrics, metricConfigs: [{ name: 'OrdersPlaced' }] }
 * // or several namespaces:
 * metrics: [
 *   { metrics: ordersMetrics,  metricConfigs: [{ name: 'OrdersPlaced' }] },
 *   { metrics: billingMetrics, metricConfigs: [{ name: 'InvoicesSent' }] },
 * ]
 * ```
 */
export interface MetricsSource {
	/** The Metrics Building Block whose resolved `namespace` these widgets query. */
	metrics: MetricsBBRef;
	/**
	 * Metric names to pre-create widgets for, within this source's namespace.
	 *
	 * Because metrics are emitted at runtime (via EMF) while widgets are created
	 * at build time (CDK synth), the construct can't auto-discover them — declare
	 * them here so widgets are pre-created (they show "Insufficient data" until
	 * the first emission). Omit for a single placeholder graph.
	 */
	metricConfigs?: MetricConfig[];
}

// ── Dashboard configuration types ───────────────────────────────────────────

/**
 * Configuration options for the Dashboard Building Block.
 *
 * The dashboard is organized **by compute**: it renders a group per compute in
 * {@link computes} (defaulting to the app's single default compute), each with a
 * health section plus logs / traces sections automatically when a Logger /
 * Tracer is attached to that compute (the compute self-reports this). You
 * therefore do **not** pass Logger / Tracer instances here — attaching them to
 * a compute is the signal.
 *
 * **Metrics** are the exception: they are app-scoped (a CloudWatch namespace is
 * not tied to a compute), so they are passed explicitly via {@link metrics} and
 * rendered once app-wide.
 */
export interface DashboardOptions {
	/**
	 * Dashboard display title shown in the CloudWatch console.
	 * @default Derived from scope ID (e.g., 'myapp-dashboard')
	 */
	title?: string;

	// ── Observability BB composition ────────────────────────────────────────

	/**
	 * The compute(s) to render on the dashboard — a single compute or an array.
	 * Each contributes a group: health always, plus logs / traces when a Logger
	 * / Tracer is attached to it.
	 *
	 * When omitted, the app's **default compute** is used, so a single-compute
	 * app needs no argument. Pass this to curate exactly which computes appear
	 * (e.g. one dashboard per compute, or a subset) once your app has more than
	 * one.
	 */
	computes?: Compute | Compute[];

	/**
	 * Metrics source(s) — a Metrics Building Block paired with its metric configs
	 * ({@link MetricsSource}), or an array of them. Each becomes an app-wide
	 * metrics section on the dashboard, one per namespace, built from that
	 * source's own `metricConfigs`.
	 *
	 * Metrics are **app-scoped**, not compute-scoped: a CloudWatch namespace is
	 * a semantic grouping any compute can emit into, so it is rendered once
	 * app-wide rather than per compute. (Logs and traces, by contrast, are
	 * compute-scoped and are rendered automatically for whichever computes have
	 * a Logger / Tracer attached — see the compute-grouped sections.)
	 *
	 * @example
	 * ```typescript
	 * metrics: { metrics, metricConfigs: [{ name: 'OrdersPlaced' }, { name: 'Latency', stat: 'p99' }] }
	 * ```
	 */
	metrics?: MetricsSource | MetricsSource[];

	// ── Dashboard-specific config ──────────────────────────────────────────

	/**
	 * Default time range for the dashboard view.
	 * Uses ISO 8601 duration format.
	 * @default '-PT3H' (last 3 hours)
	 */
	defaultTimeRange?: string;

	/**
	 * CloudWatch Dashboard name override.
	 *
	 * CloudWatch enforces a 255-character maximum on dashboard names.
	 * The resolved name is automatically truncated to 255 characters.
	 *
	 * @default Derived from `scope.fullId` (includes stack name for environment uniqueness).
	 *   Falls back to the construct ID if no parent scope is available.
	 */
	dashboardName?: string;

	/**
	 * Route path for the dashboard redirect endpoint.
	 * When set to a string, registers a RawRoute at that path that 302-redirects
	 * to the CloudWatch Dashboard console URL.
	 * Set to `false` to disable the route entirely (URL is still available via CfnOutput).
	 *
	 * The redirect requires AWS Console login to view the dashboard —
	 * exposing the URL alone grants no data access.
	 *
	 * @default '/aws-blocks/dashboard'
	 */
	routePath?: string | false;
}

/**
 * A single app-wide metrics source resolved from a {@link MetricsSource} — its
 * namespace, default dimensions, and its own metric configs.
 */
export interface ResolvedMetricsSource {
	namespace: string;
	defaultDimensions?: Record<string, string>;
	metricConfigs: MetricConfig[];
}

/**
 * Resolved configuration after normalizing options.
 * Used internally by the CDK construct.
 *
 * Logs / traces are not represented here — they are compute-scoped and resolved
 * per compute at build time from whether each compute has a Logger / Tracer attached.
 */
export interface ResolvedDashboardConfig {
	title: string;
	dashboardName: string;
	/** App-wide metrics sources, one per {@link MetricsSource} passed in. */
	metrics: ResolvedMetricsSource[];
	defaultTimeRange: string;
}
