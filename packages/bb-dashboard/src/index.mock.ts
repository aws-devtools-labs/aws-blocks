// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock implementation of the Dashboard Building Block.
 *
 * In local mode, the RawRoute is still registered so the dev server responds
 * at the configured path. Since no CloudWatch Dashboard exists locally, the
 * route returns a 503 with a helpful message directing the user to deploy.
 */
import type { ScopeParent } from '@aws-blocks/core';
import { registerSdkIdentifiers } from '@aws-blocks/core';
import type { DashboardOptions } from './types.js';
import { mountDashboardRoute } from './routes.js';

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
 * Mock Dashboard — registers redirect route but URL is always null locally.
 *
 * CloudWatch Dashboards are a cloud-only resource that cannot be replicated
 * locally. This mock logs a message on construction and provides a null URL.
 * The RawRoute is still registered so it responds in the dev server.
 *
 * @example
 * ```typescript
 * const dashboard = new Dashboard(scope, 'dashboard', { title: 'My App' });
 * // Logs: "[Dashboard] Will create CloudWatch Dashboard 'My App' on deploy."
 * // dashboard.url === null
 * ```
 */
export class Dashboard {
	/** Always null in local mode. */
	readonly url: null = null;

	/** The configured dashboard name. */
	readonly dashboardName: string;

	/** Scope-qualified identifier for SDK registry. */
	readonly fullId: string;

	constructor(scope: ScopeParent, id: string, options?: DashboardOptions) {
		const title = options?.title ?? id;
		this.fullId = 'fullId' in scope && scope.fullId ? `${scope.fullId}-${id}` : ('id' in scope && scope.id ? `${scope.id}-${id}` : id);
		this.dashboardName = (options?.dashboardName ?? this.fullId).replace(/[^A-Za-z0-9\-_]/g, '-').substring(0, 255);
		registerSdkIdentifiers(this.fullId, { dashboardName: this.dashboardName });

		const routePath = options?.routePath;
		if (routePath !== false) {
			const path = routePath ?? '/aws-blocks/dashboard';
			mountDashboardRoute(scope, path, null);
		}

		console.log(
			`[Dashboard] Dashboard BB: no-op in local mode (CloudWatch Dashboard is a cloud-only resource).\n` +
			`Will create CloudWatch Dashboard '${title}' on deploy. Run 'npx cdk deploy' to view.\n\n` +
			`📍 Local observability data:\n` +
			`   • Logs: Check your terminal output - Logger BB writes structured JSON to stdout\n` +
			`   • Metrics: Metrics BB writes EMF-formatted JSON to stdout (visible in terminal)\n` +
			`   • Traces: Tracer stores mock traces to .bb-data/ and logs them to stdout`
		);
	}
}
