// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS runtime entry point for Dashboard BB.
 *
 * Registers a RawRoute that 302-redirects to the CloudWatch Dashboard URL.
 * The URL is injected via the `BB_DASHBOARD_URL` environment variable by the
 * CDK layer at deploy time.
 */
import type { ScopeParent } from '@aws-blocks/core';
import { registerSdkIdentifiers } from '@aws-blocks/core';
import type { DashboardOptions } from './types.js';
import { mountDashboardRoute, BB_DASHBOARD_URL_ENV } from './routes.js';

export { DashboardErrors } from './errors.js';
export type {
	DashboardOptions,
	MetricConfig,
	MetricsBBRef,
	MetricsSource,
	LoggerBBRef,
	TracerBBRef,
} from './types.js';

/**
 * Dashboard BB (AWS runtime).
 *
 * Registers a redirect route to the CloudWatch Dashboard console URL.
 * The actual dashboard infrastructure is created by the CDK layer (`index.cdk.ts`).
 */
export class Dashboard {
	/** CloudWatch Dashboard URL read from the environment variable. */
	readonly url: string | null;

	/** The configured dashboard name. */
	readonly dashboardName: string;

	/** Scope-qualified identifier for SDK registry. */
	readonly fullId: string;

	constructor(scope: ScopeParent, id: string, options?: DashboardOptions) {
		this.fullId = 'fullId' in scope && scope.fullId ? `${scope.fullId}-${id}` : ('id' in scope && scope.id ? `${scope.id}-${id}` : id);
		this.dashboardName = (options?.dashboardName ?? id).replace(/[^A-Za-z0-9\-_]/g, '-').substring(0, 255);
		this.url = process.env[BB_DASHBOARD_URL_ENV] ?? null;
		registerSdkIdentifiers(this.fullId, { dashboardName: this.dashboardName });

		const routePath = options?.routePath;
		if (routePath !== false) {
			mountDashboardRoute(scope, routePath ?? '/aws-blocks/dashboard', this.url);
		}
	}
}
