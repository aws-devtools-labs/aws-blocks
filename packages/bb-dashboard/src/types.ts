// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for the Dashboard Building Block.
 * This file has zero runtime dependencies — types only.
 *
 * Uses structural interfaces so that the real observability BB instances
 * (Metrics, Logger, Tracer) satisfy these types via duck typing, while
 * tests can pass minimal mock objects.
 */

// ── Observability BB structural interfaces ──────────────────────────────────

/**
 * Structural interface satisfied by `@aws-blocks/bb-metrics` instances.
 * Requires `namespace` which is the resolved CloudWatch namespace
 * (either explicitly configured or defaulting to the Metrics BB's scope fullId).
 */
export interface MetricsBBRef {
	/**
	 * CloudWatch metric namespace for **classic (EMF) `Metrics`**. OTLP-based `OtelMetrics`
	 * has no namespace (metrics are PromQL-queryable, selected by name) and omits this.
	 */
	readonly namespace?: string;
	/**
	 * Default dimensions applied to every metric emitted by the Metrics BB.
	 * When present, the Dashboard BB merges these into widget queries so that
	 * CloudWatch finds the dimensioned metric stream.
	 */
	readonly defaultDimensions?: Record<string, string>;
	/**
	 * How the metrics reach CloudWatch, which decides the widget type:
	 * - `'cloudwatch'` (default) — classic namespace/dimension metrics (EMF-based
	 *   `Metrics`); rendered as metric `GraphWidget`s.
	 * - `'otlp'` — OpenTelemetry metrics ingested via CloudWatch's OTLP endpoint
	 *   (`OtelMetrics`). These are PromQL-queryable and have NO namespace, so they
	 *   are rendered as PromQL `chart` widgets selecting by metric name.
	 *
	 * The `OtelMetrics` block sets this to `'otlp'`. Omitted/`'cloudwatch'` keeps the
	 * existing behaviour, so EMF-based `Metrics` dashboards are unaffected.
	 */
	readonly metricsKind?: 'cloudwatch' | 'otlp';
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

	/**
	 * For OTLP (PromQL) metrics only: an explicit PromQL query overriding the default
	 * `sum({"<name>"})`. Ignored for classic CloudWatch metrics. Use for rates,
	 * label filters, or aggregations — e.g. `rate({"http.server.duration"}[5m])`.
	 */
	promql?: string;
}

// ── Dashboard configuration types ───────────────────────────────────────────

/**
 * Configuration options for the Dashboard Building Block.
 *
 * Pass real observability BB instances for automatic, type-safe integration.
 * The Dashboard extracts configuration directly from the BB instances:
 * - **Metrics**: uses `namespace` (the resolved CloudWatch namespace)
 * - **Logger**: presence triggers log widgets; log group derived from Lambda handler
 * - **Tracer**: presence implies X-Ray tracing is active
 */
export interface DashboardOptions {
	/**
	 * Dashboard display title shown in the CloudWatch console.
	 * @default Derived from scope ID (e.g., 'myapp-dashboard')
	 */
	title?: string;

	// ── Observability BB composition ────────────────────────────────────────

	/**
	 * Metrics Building Block instance (or any object with `namespace`).
	 * When provided, adds metric widgets using the BB's resolved CloudWatch namespace.
	 */
	metrics?: MetricsBBRef;

	/**
	 * Logger Building Block instance (or any object with `fullId`).
	 * When provided, adds log query widgets using the Lambda handler's log group.
	 */
	logger?: LoggerBBRef;

	/**
	 * Tracer Building Block instance (or any object with `fullId`).
	 * When provided, adds X-Ray trace widgets.
	 */
	tracer?: TracerBBRef;

	// ── Dashboard-specific config ──────────────────────────────────────────

	/**
	 * Metrics to create dashboard widgets for.
	 *
	 * Because metrics are emitted at runtime (via EMF in Lambda) while
	 * dashboard widgets are created at build time (CDK synth), the construct
	 * cannot auto-discover what metrics will exist. You must declare them
	 * here so widgets are pre-created — they will show "Insufficient data"
	 * until the first emission.
	 *
	 * @example
	 * ```typescript
	 * metricConfigs: [
	 *   { name: 'RequestCount' },
	 *   { name: 'Latency', stat: 'p99', period: 300, title: 'P99 Latency' },
	 *   { name: 'ErrorRate', stat: 'Average' }
	 * ]
	 * ```
	 */
	metricConfigs?: MetricConfig[];

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
 * Resolved configuration after merging BB instances with fallbacks.
 * Used internally by the CDK construct.
 */
export interface ResolvedDashboardConfig {
	title: string;
	dashboardName: string;
	/** Whether a Metrics ref was provided (renders the metrics section). */
	metricsEnabled: boolean;
	metricsNamespace: string | undefined;
	metricsDefaultDimensions: Record<string, string> | undefined;
	/** `'otlp'` → render PromQL chart widgets; `'cloudwatch'` (default) → metric GraphWidgets. */
	metricsKind: 'cloudwatch' | 'otlp';
	logGroupName: string | undefined;
	tracingEnabled: boolean;
	metricConfigs: MetricConfig[];
	defaultTimeRange: string;
}
