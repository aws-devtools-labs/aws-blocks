// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Widget builder utilities for CloudWatch Dashboard L2 constructs.
 * Produces IWidget arrays for the L2 Dashboard construct.
 */
import { Duration } from 'aws-cdk-lib';
import { GraphWidget, Metric, TextWidget } from 'aws-cdk-lib/aws-cloudwatch';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import type { ComputeDashboardSection } from '@aws-blocks/core/cdk/internal';
import type { ResolvedDashboardConfig, ResolvedMetricsSource, DashboardOptions, MetricConfig } from './types.js';
import { DashboardErrors } from './errors.js';

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
 * Build the complete set of dashboard widget rows.
 *
 * The dashboard is organized **by compute**: each compute contributes a group
 * (health, plus logs / traces when attached), rendered in the order the
 * computes are given. App-wide **metrics** sections follow, one per namespace —
 * metrics are not compute-scoped, so they render once at the end.
 *
 * Returns an array of widget rows (each row is an array of IWidget) to add to
 * the Dashboard via `addWidgets()`.
 *
 * @param computes - Per-compute self-reported sections, in display order.
 * @param config - Resolved dashboard configuration (metrics + metricConfigs).
 * @param region - AWS region string.
 * @returns Array of widget rows for the Dashboard.
 */
export function buildDashboardWidgets(
	computes: ComputeDashboardSection[],
	config: ResolvedDashboardConfig,
	region: string,
): IWidget[][] {
	const rows: IWidget[][] = [];

	// Compute-scoped groups: one per compute, in registration order. Each compute
	// self-reports its health/logs/traces rows, so the dashboard makes no
	// single-function assumption. For the default single-compute app this is one
	// group with the usual Invocations/Errors/Duration/Concurrency widgets.
	for (const compute of computes) {
		rows.push(sectionHeader(`## 🔧 ${compute.label}`));
		rows.push(...compute.health);

		// Traces — present only when a Tracer is attached to this compute.
		if (compute.tracing) {
			rows.push(sectionHeader('### 🔍 Traces'));
			rows.push(...compute.tracing);
		}

		// Logs — present only when a Logger is attached to this compute.
		if (compute.logging) {
			rows.push(sectionHeader('### 📋 Logs'));
			rows.push(...compute.logging);
		}
	}

	// App-wide metrics sections — not compute-scoped, so rendered once per
	// namespace after the compute groups, each from its own metric configs.
	for (const metrics of config.metrics) {
		rows.push(sectionHeader(`## 📊 Metrics — ${metrics.namespace}`));
		rows.push(...buildMetricsWidgets(metrics.namespace, metrics.metricConfigs, region, metrics.defaultDimensions));
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
 * @param scopeFullId - Fully-qualified scope identifier (includes stack name) used as the
 *   default dashboardName to ensure uniqueness across environments/deployments.
 */
export function resolveConfig(id: string, options?: DashboardOptions, scopeFullId?: string): ResolvedDashboardConfig {
	// Normalize the single-or-array `metrics` option into a list of app-wide
	// sources. Each carries its own metricConfigs (namespace-specific); empty
	// defaultDimensions are dropped so widget queries stay clean.
	const sources = options?.metrics === undefined
		? []
		: Array.isArray(options.metrics)
			? options.metrics
			: [options.metrics];
	const metrics: ResolvedMetricsSource[] = sources.map((source) => ({
		namespace: source.metrics.namespace,
		defaultDimensions: source.metrics.defaultDimensions && Object.keys(source.metrics.defaultDimensions).length > 0
			? source.metrics.defaultDimensions
			: undefined,
		metricConfigs: source.metricConfigs ?? [],
	}));

	return {
		title: options?.title ?? id,
		dashboardName: (options?.dashboardName ?? scopeFullId ?? id).replace(/[^A-Za-z0-9\-_]/g, '-').substring(0, 255),
		metrics,
		defaultTimeRange: options?.defaultTimeRange ?? '-PT3H',
	};
}
