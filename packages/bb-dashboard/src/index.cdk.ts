// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import { registerConfig, registerDashboardFinalizer, Scope } from '@aws-blocks/core/cdk';
import { type ComputeDashboardSection, getComputes } from '@aws-blocks/core/cdk/internal';
import { CfnOutput, Fn, Stack } from 'aws-cdk-lib';
import { Dashboard as CwDashboard } from 'aws-cdk-lib/aws-cloudwatch';
import { BB_DASHBOARD_URL_ENV, mountDashboardRoute } from './routes.js';
import type { DashboardOptions } from './types.js';
import { buildDashboardWidgets, resolveConfig } from './widgets.js';

export { DashboardErrors } from './errors.js';
export type {
	DashboardOptions,
	MetricConfig,
	MetricsBBRef,
	MetricsSource,
	ResolvedDashboardConfig,
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
 * // Minimal — a health + logs section for every compute in the app.
 * const dashboard = new Dashboard(scope, 'dashboard');
 * ```
 *
 * @example
 * ```typescript
 * // Health + logs render for every compute automatically. A traces section
 * // appears per compute when the app contains a Tracer (tracing is
 * // presence-gated, enabling X-Ray on every compute). Metrics are app-wide and
 * // passed explicitly (one section per namespace), with their configs.
 * new Tracer(scope, 'tracer');   // → traces section on every compute
 * const metrics = new Metrics(scope, 'metrics');
 * const dashboard = new Dashboard(scope, 'dashboard', {
 *   logs: false,   // hide the logs sections (logs are still captured)
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

		// Display toggles for the logs / traces sections. Captured here (before the
		// finalizer runs) but applied per compute below. Default is to show both.
		const showLogs = options?.logs !== false;
		const showTraces = options?.traces !== false;

		// Create the CloudWatch Dashboard resource eagerly so the URL / redirect
		// route / config below always point at a resource that exists — never a
		// dangling link if the finalizer somehow doesn't run. Only the widget
		// *body* is deferred (added via `addWidgets` at finalize).
		const dashboard = new CwDashboard(this, 'Resource', {
			dashboardName: config.dashboardName,
			start: config.defaultTimeRange,
		});

		// Build the widget body in a finalizer, not here. The body depends on
		// which computes are traced (`dashboardSection` gates its traces section on
		// each compute's tracing flag), and that flag is flipped when the app's
		// `Tracer` is finalized during the backend-module import. This finalizer
		// runs after that import completes, so the dashboard observes tracing
		// regardless of the order the customer constructed things in — and its
		// compute list captures every compute in the app.
		registerDashboardFinalizer(this, () => {
			const region = Stack.of(this).region;
			// The dashboard is organized by compute: each compute is a group — health
			// always, plus logs/traces per the compute's state and this dashboard's
			// display toggles. Metrics are app-wide (rendered once per namespace,
			// after the compute groups).
			//
			// TODO(multi-compute): the dashboard currently always covers EVERY compute
			// in the app (`getComputes(this)`), which is complete today because there
			// is exactly one (the default) compute and no customer surface to create
			// more. When `Compute` becomes a public, customer-instantiable type, add a
			// `computes?: Compute[]` option to `DashboardOptions` and resolve it here
			// as `options.computes ?? getComputes(this)` — an explicit list restricts
			// the dashboard to just those computes (in the given order); omitting it
			// keeps the "cover every compute" default. It is left out of the public
			// API until then so we don't leak the internal `Compute` type before a
			// customer can construct one to pass.
			const computes = getComputes(this);
			const computeSections: ComputeDashboardSection[] = computes.map((compute) => {
				const section = compute.dashboardSection(region);
				// Apply the dashboard-wide display toggles uniformly. `logging` is
				// always present on the section (logs are always captured), so the
				// `logs` toggle can suppress it; `tracing` is only present when the
				// compute is traced, so the `traces` toggle only ever suppresses an
				// already-present section — it never fabricates one.
				return {
					...section,
					logging: showLogs ? section.logging : undefined,
					tracing: showTraces ? section.tracing : undefined,
				};
			});
			// Each row of widgets is added as its own dashboard row (side-by-side).
			for (const row of buildDashboardWidgets(computeSections, config, region)) {
				dashboard.addWidgets(...row);
			}
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
