// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { CfnOutput, Fn, Stack } from 'aws-cdk-lib';
import { Dashboard as CwDashboard } from 'aws-cdk-lib/aws-cloudwatch';
import { Scope, registerConfig } from '@aws-blocks/core/cdk';
import type { Compute } from '@aws-blocks/core/cdk/internal';
import type { ScopeParent } from '@aws-blocks/core';
import type { DashboardOptions } from './types.js';
import { buildDashboardWidgets, resolveConfig } from './widgets.js';
import { mountDashboardRoute, BB_DASHBOARD_URL_ENV } from './routes.js';

export { DashboardErrors } from './errors.js';
export type {
	DashboardOptions,
	ResolvedDashboardConfig,
	MetricConfig,
	MetricsBBRef,
	MetricsSource,
	LoggerBBRef,
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
 * // Minimal — one health section per compute in the app.
 * const dashboard = new Dashboard(scope, 'dashboard');
 * ```
 *
 * @example
 * ```typescript
 * // Logs/traces appear automatically for any compute that has a Logger/Tracer
 * // attached — you don't pass them to the dashboard. Metrics are app-wide and
 * // passed explicitly (one section per namespace).
 * new Logger(scope, 'logger');   // → this compute's logs section
 * new Tracer(scope, 'tracer');   // → this compute's traces section
 * const metrics = new Metrics(scope, 'metrics');
 * const dashboard = new Dashboard(scope, 'dashboard', {
 *   metrics,
 *   metricConfigs: [
 *     { name: 'OrdersPlaced' },
 *     { name: 'Latency', stat: 'p99', period: 300 },
 *   ],
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
		// The dashboard is organized by compute: render a group per compute the
		// caller passed in, defaulting to the app's single default compute
		// (`this.compute`) when none is given. Each compute self-reports its
		// section — health always, plus logs/traces only when a Logger/Tracer is
		// attached to that compute (`dashboardSection` gates internally), so we
		// can't render an empty section. Metrics are app-wide (rendered once
		// per namespace). Taking computes explicitly avoids any construction-order
		// dependency: the caller names exactly which computes appear.
		const computes: Compute[] = options?.computes === undefined
			? [this.compute]
			: Array.isArray(options.computes)
				? options.computes
				: [options.computes];
		const computeSections = computes.map((compute) => compute.dashboardSection(region));
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
