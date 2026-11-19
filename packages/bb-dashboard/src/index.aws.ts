// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS runtime entry point for Dashboard BB.
 *
 * Registers a RawRoute that 302-redirects to the CloudWatch Dashboard URL.
 * The URL is derived, not injected: each instance computes its own dashboard
 * name exactly as the CDK layer does (the `dashboardName` option, else
 * `fullId`) and builds the console URL from it and the compute's `AWS_REGION`,
 * so an app with several dashboards gets one URL per dashboard.
 */
import type { ScopeParent } from '@aws-blocks/core';
import { Scope, registerSdkIdentifiers } from '@aws-blocks/core';
import { dashboardConsoleUrl, deriveDashboardName } from './naming.js';
import { mountDashboardRoute } from './routes.js';
import type { DashboardOptions } from './types.js';
import { BB_NAME, BB_VERSION } from './version.js';

export { DashboardErrors } from './errors.js';
export type {
	DashboardOptions,
	MetricConfig,
	MetricsBBRef,
	MetricsSource,
} from './types.js';

/**
 * Dashboard BB (AWS runtime).
 *
 * Registers a redirect route to the CloudWatch Dashboard console URL.
 * The actual dashboard infrastructure is created by the CDK layer (`index.cdk.ts`).
 */
export class Dashboard extends Scope {
	/**
	 * CloudWatch Dashboard console URL of this dashboard, derived from `AWS_REGION`
	 * and {@link Dashboard.dashboardName}. Null when `AWS_REGION` is not set.
	 */
	readonly url: string | null;

	/** The configured dashboard name (the `dashboardName` option, else `fullId`, as deployed by the CDK layer). */
	readonly dashboardName: string;

	readonly #fullId: string;

	/** Scope-qualified identifier for SDK registry (snapshot at construction, as before extending Scope). */
	override get fullId(): string {
		return this.#fullId;
	}

	constructor(scope: ScopeParent, id: string, options?: DashboardOptions) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.#fullId =
			'fullId' in scope && scope.fullId
				? `${scope.fullId}-${id}`
				: 'id' in scope && scope.id
					? `${scope.id}-${id}`
					: id;
		// Same derivation as the CDK layer's resolveConfig, so this names the deployed dashboard.
		this.dashboardName = deriveDashboardName(id, options?.dashboardName, this.fullId);
		// The compute runs in the stack's region, so AWS_REGION is the region the
		// CDK layer's `AWS::Region` URL resolves to.
		const region = process.env.AWS_REGION;
		this.url = region ? dashboardConsoleUrl(region, this.dashboardName) : null;
		registerSdkIdentifiers(this.fullId, { dashboardName: this.dashboardName });

		const routePath = options?.routePath;
		if (routePath !== false) {
			// Mounted on this block (as the CDK layer does), so each dashboard owns its route.
			mountDashboardRoute(this, routePath ?? '/aws-blocks/dashboard', this.url);
		}
	}
}
