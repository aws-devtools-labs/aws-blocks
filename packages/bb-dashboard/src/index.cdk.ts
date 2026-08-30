// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import { registerConfig, Scope } from '@aws-blocks/core/cdk';
import { CfnOutput, Fn, Stack } from 'aws-cdk-lib';
import { Dashboard as CwDashboard } from 'aws-cdk-lib/aws-cloudwatch';
import { BB_DASHBOARD_URL_ENV, mountDashboardRoute } from './routes.js';
import type { DashboardOptions } from './types.js';
import { buildDashboardWidgets, resolveConfig } from './widgets.js';

export { DashboardErrors } from './errors.js';
export type {
	DashboardOptions,
	LoggerBBRef,
	MetricConfig,
	MetricsBBRef,
	MetricsSource,
	ResolvedDashboardConfig,
	TracerBBRef,
} from './types.js';

/**
 * Auto-generated CloudWatch Dashboard for application observability.
 *
 * Creates a CloudWatch Dashboard via CDK L2 constructs with widgets for Lambda health,
 * custom metrics, logs, and X-Ray traces. Outputs the dashboard console URL
 * as a CfnOutput. Registers a RawRoute that 302-redirects to the dashboard URL.
 *
 * **When to use:** You want operational visibility into your deployed application
 * without manually creating CloudWatch dashboards.
 *
 * **When NOT to use:** If you need fully custom dashboards with specific widget
 * layouts, use the CloudWatch console directly.
 *
 * @example
 * ```typescript
 * // Minimal — a health section for the app's compute.
 * const dashboard = new Dashboard(scope, 'dashboard');
 * ```
 *
 * @example
 * ```typescript
 * // Logs/traces appear automatically when a Logger/Tracer is attached to the
 * // compute — you don't pass them to the dashboard. Metrics are app-wide and
 * // passed explicitly (one section per namespace), with their configs.
 * new Logger(scope, 'logger');   // → logs section
 * new Tracer(scope, 'tracer');   // → traces section
 * const metrics = new Metrics(scope, 'metrics');
 * const dashboard = new Dashboard(scope, 'dashboard', {
 *   metrics: {
 *     metrics,
 *     metricConfigs: [
 *       { name: 'OrdersPlaced' },
 *       { name: 'Latency', stat: 'p99', period: 300 },
 *     ],
 *   },
 * });
 * ```
 */
export class Dashboard extends Scope {
	/**
	 * CloudWatch Dashboard console URL.
	 * Contains CDK tokens until deployment; use the CfnOutput value.
	 */
	readonly url: string;

	/** The resolved CloudWatch Dashboard name. */
	readonly dashboardName: string;

	constructor(scope: ScopeParent, id: string, options?: DashboardOptions) {
		super(id, { parent: scope });

		const config = resolveConfig(id, options, this.fullId);
		this.dashboardName = config.dashboardName;

		const region = Stack.of(this).region;
		// The dashboard is organized by compute: it renders the app's compute
		// (`this.compute`) as a group — health always, plus logs/traces only when
		// a Logger/Tracer is attached to it (`dashboardSection` gates internally),
		// so we can't render an empty section. Metrics are app-wide (rendered once
		// per namespace). There is no customer-facing way to create additional
		// computes yet, so the dashboard covers the single default compute; a
		// `computes` selector arrives with the multi-compute customer surface.
		const computeSections = [this.compute.dashboardSection(region)];
		const widgetRows = buildDashboardWidgets(computeSections, config, region);

		new CwDashboard(this, 'Resource', {
			dashboardName: config.dashboardName,
			start: config.defaultTimeRange,
			widgets: widgetRows,
		});

		this.url = Fn.join('', [
			'https://',
			Fn.ref('AWS::Region'),
			'.console.aws.amazon.com/cloudwatch/home?region=',
			Fn.ref('AWS::Region'),
			'#dashboards/dashboard/',
			config.dashboardName,
		]);

		// Pass the dashboard URL to the runtime Lambda via config registry.
		registerConfig(this, BB_DASHBOARD_URL_ENV, this.url);

		// Register the redirect route so the Lambda handler dispatches it.
		const routePath = options?.routePath;
		if (routePath !== false) {
			mountDashboardRoute(this, routePath ?? '/aws-blocks/dashboard', this.url);
		}

		new CfnOutput(this, 'Url', {
			value: this.url,
			description: `CloudWatch Dashboard URL for ${config.title}`,
		});
	}
}
