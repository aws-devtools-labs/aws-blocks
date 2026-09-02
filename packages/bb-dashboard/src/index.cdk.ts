// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { CfnOutput, Fn, Stack } from 'aws-cdk-lib';
import { Dashboard as CwDashboard } from 'aws-cdk-lib/aws-cloudwatch';
import { Scope, registerConfig } from '@aws-blocks/core/cdk';
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
 * // Minimal — Lambda health widgets only
 * const dashboard = new Dashboard(scope, 'dashboard');
 * ```
 *
 * @example
 * ```typescript
 * // With observability BB composition
 * const dashboard = new Dashboard(scope, 'dashboard', {
 *   logger,
 *   metrics,
 *   tracer,
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

		const functionName = this.handler.functionName;
		// Point log widgets at the framework-owned handler log group (its name is
		// generated, not `/aws/lambda/<fn>`), so "Recent Errors" / "Log Volume"
		// resolve to the group the handler actually writes to.
		const config = resolveConfig(id, options, functionName, this.fullId, this.handlerLogGroup.logGroupName);
		this.dashboardName = config.dashboardName;

		const region = Stack.of(this).region;
		const widgetRows = buildDashboardWidgets(config, functionName, region);

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
