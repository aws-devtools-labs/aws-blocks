// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Widget builder utilities for CloudWatch Dashboard L2 constructs.
 * Produces IWidget arrays for the L2 Dashboard construct.
 */
import { Duration } from 'aws-cdk-lib';
import {
	GraphWidget,
	LogQueryWidget,
	Metric,
	TextWidget,
	ConcreteWidget,
} from 'aws-cdk-lib/aws-cloudwatch';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import type { ResolvedDashboardConfig, DashboardOptions, MetricConfig } from './types.js';
import { DashboardErrors } from './errors.js';

// ── Trace widget (no L2 construct exists) ───────────────────────────────────

/**
 * Custom widget that renders an X-Ray trace list in the CloudWatch Dashboard.
 *
 * CloudWatch supports a `"type": "trace"` widget, but CDK does not provide
 * an L2 construct for it. This class extends `ConcreteWidget` to produce
 * the correct JSON.
 *
 * @example
 * ```typescript
 * new TraceWidget({
 *   title: 'Traces',
 *   functionName: 'my-handler',
 *   region: 'us-east-1',
 * });
 * ```
 */
export class TraceWidget extends ConcreteWidget {
	private readonly props: TraceWidgetProps;

	constructor(props: TraceWidgetProps) {
		super(props.width ?? 24, props.height ?? 9);
		this.props = props;
	}

	toJson(): any[] {
		return [
			{
				type: 'trace',
				width: this.width,
				height: this.height,
				x: this.x ?? 0,
				y: this.y ?? 0,
				properties: {
					title: this.props.title ?? 'Traces',
					region: this.props.region,
					filters: {
						query: `service(id(name: "${this.props.functionName}", type: "AWS::Lambda::Function"))`,
						group: 'Default',
					},
				},
			},
		];
	}
}

export interface TraceWidgetProps {
	title?: string;
	functionName: string;
	region: string;
	width?: number;
	height?: number;
}

// ── PromQL widget (for OTLP metrics; no L2 construct exists) ─────────────────

/**
 * Custom widget that renders a PromQL query in the CloudWatch Dashboard.
 *
 * CloudWatch OTLP metrics are PromQL-queryable (they have no namespace), so they
 * cannot be shown with the classic metric `GraphWidget`. CloudWatch supports a newer
 * `"type": "chart"` widget with a `cloudwatch-metrics` / `PromQL` query; CDK has no L2
 * construct for it, so this extends `ConcreteWidget` to emit the JSON directly.
 *
 * @example
 * ```typescript
 * new PromqlWidget({ title: 'Requests', query: 'sum({"http.server.requests"})', region: 'us-east-1' });
 * ```
 */
export class PromqlWidget extends ConcreteWidget {
	private readonly props: PromqlWidgetProps;

	constructor(props: PromqlWidgetProps) {
		super(props.width ?? 12, props.height ?? 6);
		this.props = props;
	}

	toJson(): any[] {
		return [
			{
				type: 'chart',
				width: this.width,
				height: this.height,
				x: this.x ?? 0,
				y: this.y ?? 0,
				properties: {
					title: this.props.title,
					view: this.props.view ?? 'timeSeries',
					region: this.props.region,
					data: {
						queries: [
							{
								id: 'q',
								type: 'cloudwatch-metrics',
								language: 'PromQL',
								query: this.props.query,
								step: this.props.step ?? 60,
								label: this.props.title,
							},
						],
					},
				},
			},
		];
	}
}

export interface PromqlWidgetProps {
	title: string;
	/** The PromQL query string, e.g. `sum({"http.server.requests"})`. */
	query: string;
	region: string;
	/** `'timeSeries'` (default) or `'number'` (single-value). */
	view?: 'timeSeries' | 'number';
	/** Resolution step in seconds. @default 60 */
	step?: number;
	width?: number;
	height?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function blocksError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return err;
}

function validateMetricConfig(metric: MetricConfig): void {
	if (!metric.name || metric.name.trim().length === 0) {
		throw blocksError(DashboardErrors.InvalidMetricConfig, "Metric name cannot be empty");
	}

	const period = metric.period;
	if (period !== undefined && period < 1) {
		throw blocksError(DashboardErrors.InvalidMetricConfig, `Metric period must be >= 1 seconds, got: ${period}`);
	}
}

// ── Lambda health widgets (always included) ─────────────────────────────────

/**
 * Build Lambda health widgets: Invocations, Errors, Duration, ConcurrentExecutions.
 * Returns two rows of two 12-wide GraphWidgets each.
 */
export function buildLambdaWidgets(functionName: string, region: string): IWidget[][] {
	const invocations = new GraphWidget({
		title: 'Lambda Invocations',
		width: 12,
		height: 6,
		region,
		left: [
			new Metric({
				namespace: 'AWS/Lambda',
				metricName: 'Invocations',
				dimensionsMap: { FunctionName: functionName },
				statistic: 'Sum',
				period: Duration.seconds(60),
			}),
		],
	});

	const errors = new GraphWidget({
		title: 'Lambda Errors',
		width: 12,
		height: 6,
		region,
		left: [
			new Metric({
				namespace: 'AWS/Lambda',
				metricName: 'Errors',
				dimensionsMap: { FunctionName: functionName },
				statistic: 'Sum',
				period: Duration.seconds(60),
			}),
		],
	});

	const duration = new GraphWidget({
		title: 'Lambda Duration',
		width: 12,
		height: 6,
		region,
		left: [
			new Metric({
				namespace: 'AWS/Lambda',
				metricName: 'Duration',
				dimensionsMap: { FunctionName: functionName },
				statistic: 'Average',
				period: Duration.seconds(60),
				label: 'Average',
			}),
			new Metric({
				namespace: 'AWS/Lambda',
				metricName: 'Duration',
				dimensionsMap: { FunctionName: functionName },
				statistic: 'p99',
				period: Duration.seconds(60),
				label: 'p99',
			}),
		],
	});

	const concurrency = new GraphWidget({
		title: 'Lambda Concurrent Executions',
		width: 12,
		height: 6,
		region,
		left: [
			new Metric({
				namespace: 'AWS/Lambda',
				metricName: 'ConcurrentExecutions',
				dimensionsMap: { FunctionName: functionName },
				statistic: 'Maximum',
				period: Duration.seconds(60),
			}),
		],
	});

	return [
		[invocations, errors],
		[duration, concurrency],
	];
}

// ── Metrics widgets ─────────────────────────────────────────────────────────

/**
 * Build custom metrics widgets: individual GraphWidget for each metric.
 * Each metric gets its own dedicated widget with the metric name as the title.
 * Widgets are paired into rows of 2 for side-by-side display.
 *
 * Validates metric names and periods before creating widgets.
 * When `defaultDimensions` is provided, merges them with per-metric dimensions
 * (per-metric wins on conflict) so widget queries match the dimensioned metric stream.
 */
export function buildMetricsWidgets(
	namespace: string,
	metricConfigs: MetricConfig[],
	region: string,
	defaultDimensions?: Record<string, string>,
): IWidget[][] {
	if (metricConfigs.length > 0) {
		const widgets: IWidget[] = [];

		// Create an individual widget for each metric
		for (const metric of metricConfigs) {
			// Validate metric configuration
			validateMetricConfig(metric);

			const stat = metric.stat ?? 'Sum';
			const period = metric.period ?? 60;
			const title = metric.title ?? metric.name;

			const mergedDimensions = defaultDimensions
				? { ...defaultDimensions, ...metric.dimensions }
				: metric.dimensions;

			const widget = new GraphWidget({
				title,
				width: 12,
				height: 6,
				region,
				left: [
					new Metric({
						namespace,
						metricName: metric.name,
						dimensionsMap: mergedDimensions,
						statistic: stat,
						period: Duration.seconds(period),
					}),
				],
			});
			widgets.push(widget);
		}

		// Chunk widgets into pairs for side-by-side display
		const rows: IWidget[][] = [];
		for (let i = 0; i < widgets.length; i += 2) {
			rows.push(widgets.slice(i, i + 2));
		}

		return rows;
	}

	// No pre-registered metric names — show a placeholder graph
	const placeholder = new GraphWidget({
		title: `Custom Metrics — ${namespace}`,
		width: 12,
		height: 6,
		region,
		left: [
			new Metric({
				namespace,
				metricName: '',
				dimensionsMap: defaultDimensions,
				statistic: 'Sum',
				period: Duration.seconds(60),
			}),
		],
	});

	return [[placeholder]];
}

/**
 * Build PromQL widgets for OTLP (OpenTelemetry) metrics. Each configured metric gets
 * a `PromqlWidget` selecting by metric name (OTLP metrics have no namespace). When a
 * `metricConfig.promql` override is given it is used verbatim; otherwise the default
 * query is `sum({"<name>"})`, optionally narrowed by `defaultDimensions` as datapoint
 * label matchers. Widgets are paired into rows of two.
 */
export function buildPromqlMetricsWidgets(
	metricConfigs: MetricConfig[],
	region: string,
	defaultDimensions?: Record<string, string>,
): IWidget[][] {
	if (metricConfigs.length === 0) {
		return [[
			new PromqlWidget({
				title: 'OTel Metrics',
				query: 'count({__name__=~".+"})',
				region,
				view: 'number',
				width: 12,
			}),
		]];
	}

	const labelMatchers = defaultDimensions
		? Object.entries(defaultDimensions).map(([k, v]) => `${k}="${v}"`)
		: [];

	const widgets: IWidget[] = metricConfigs.map((metric) => {
		validateMetricConfig(metric);
		const selector = labelMatchers.length > 0
			? `{"${metric.name}", ${labelMatchers.join(', ')}}`
			: `{"${metric.name}"}`;
		const query = metric.promql ?? `sum(${selector})`;
		return new PromqlWidget({
			title: metric.title ?? metric.name,
			query,
			region,
			step: metric.period ?? 60,
			width: 12,
			height: 6,
		});
	});

	const rows: IWidget[][] = [];
	for (let i = 0; i < widgets.length; i += 2) {
		rows.push(widgets.slice(i, i + 2));
	}
	return rows;
}

// ── Logging widgets ─────────────────────────────────────────────────────────

/**
 * Build log widgets: a Log Insights query for recent errors + log volume graph.
 */
export function buildLoggingWidgets(logGroupName: string, region: string): IWidget[][] {
	const logQuery = new LogQueryWidget({
		title: 'Recent Errors',
		width: 24,
		height: 6,
		region,
		logGroupNames: [logGroupName],
		queryLines: [
			'fields @timestamp, @message',
			'filter @message like /ERROR/ or level = "error"',
			'sort @timestamp desc',
			'limit 20',
		],
	});

	const logVolume = new GraphWidget({
		title: 'Log Volume',
		width: 24,
		height: 6,
		region,
		left: [
			new Metric({
				namespace: 'AWS/Logs',
				metricName: 'IncomingLogEvents',
				dimensionsMap: { LogGroupName: logGroupName },
				statistic: 'Sum',
				period: Duration.seconds(300),
			}),
		],
	});

	return [[logQuery], [logVolume]];
}

// ── Tracing widgets ─────────────────────────────────────────────────────────

/**
 * Build trace widget using the custom TraceWidget class.
 */
export function buildTracingWidgets(functionName: string, region: string): IWidget[][] {
	const traceWidget = new TraceWidget({
		title: 'Traces',
		functionName,
		region,
		width: 24,
		height: 9,
	});

	return [[traceWidget]];
}

// ── Section headers ─────────────────────────────────────────────────────

function sectionHeader(text: string): IWidget[] {
	return [
		new TextWidget({
			markdown: text,
			width: 24,
			height: 2,
		}),
	];
}

// ── Main builder ────────────────────────────────────────────────────────

/**
 * Build the complete set of dashboard widget rows from resolved configuration.
 *
 * Returns an array of widget rows (each row is an array of IWidget).
 * Each row will be added to the Dashboard via `addWidgets()`.
 *
 * @param config - Resolved dashboard configuration.
 * @param functionName - Lambda function name for base health widgets.
 * @param region - AWS region string.
 * @returns Array of widget rows for the Dashboard.
 */
export function buildDashboardWidgets(config: ResolvedDashboardConfig, functionName: string, region: string): IWidget[][] {
	const rows: IWidget[][] = [];

	// Lambda handler section
	rows.push(sectionHeader('## 🔧 Lambda Handler'));
	rows.push(...buildLambdaWidgets(functionName, region));

	// Metrics section
	if (config.metricsEnabled) {
		rows.push(sectionHeader('## 📊 Metrics'));
		if (config.metricsKind === 'otlp') {
			// OTLP metrics are PromQL-queryable (no namespace) → PromQL chart widgets,
			// selected by metric name (+ optional @resource.* / attribute label filters).
			rows.push(...buildPromqlMetricsWidgets(config.metricConfigs, region, config.metricsDefaultDimensions));
		} else {
			// Classic CloudWatch metrics require a namespace (falls back to a placeholder).
			rows.push(...buildMetricsWidgets(config.metricsNamespace ?? 'Custom', config.metricConfigs, region, config.metricsDefaultDimensions));
		}
	}

	// Tracing section
	if (config.tracingEnabled) {
		rows.push(sectionHeader('## 🔍 Traces'));
		rows.push(...buildTracingWidgets(functionName, region));
	}

	// Logging section
	if (config.logGroupName) {
		rows.push(sectionHeader('## 📋 Logs'));
		rows.push(...buildLoggingWidgets(config.logGroupName, region));
	}

	return rows;
}

/**
 * Resolve DashboardOptions into a flat config, extracting values from real BB instances.
 *
 * Resolution:
 * - **Metrics namespace**: derived from `metrics.namespace`
 * - **Log group**: derived from Lambda handler function name when Logger BB present
 * - **Tracing**: enabled when Tracer BB instance is provided
 *
 * @param id - Dashboard construct ID used as fallback for title.
 * @param options - User-provided dashboard configuration.
 * @param functionName - Lambda function name for auto-deriving logGroupName.
 * @param scopeFullId - Fully-qualified scope identifier (includes stack name) used as the
 *   default dashboardName to ensure uniqueness across environments/deployments.
 */
export function resolveConfig(id: string, options?: DashboardOptions, functionName?: string, scopeFullId?: string): ResolvedDashboardConfig {
	// A metrics section renders whenever a Metrics ref is provided. Classic (EMF)
	// metrics carry a `namespace`; OTLP metrics (OtelMetrics) do not — they're selected
	// by metric name via PromQL — so the section must NOT be gated on the namespace.
	const metricsEnabled = options?.metrics !== undefined;
	const metricsNamespace = options?.metrics?.namespace;

	const metricsDefaultDimensions = options?.metrics?.defaultDimensions
		&& Object.keys(options.metrics.defaultDimensions).length > 0
		? options.metrics.defaultDimensions
		: undefined;

	const logGroupName = options?.logger && functionName
		? `/aws/lambda/${functionName}`
		: undefined;

	const tracingEnabled = options?.tracer !== undefined;

	return {
		title: options?.title ?? id,
		dashboardName: (options?.dashboardName ?? scopeFullId ?? id).replace(/[^A-Za-z0-9\-_]/g, '-').substring(0, 255),
		metricsEnabled,
		metricsNamespace,
		metricsDefaultDimensions,
		metricsKind: options?.metrics?.metricsKind ?? 'cloudwatch',
		logGroupName,
		tracingEnabled,
		metricConfigs: options?.metricConfigs ?? [],
		defaultTimeRange: options?.defaultTimeRange ?? '-PT3H',
	};
}
