// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock implementation of the Dashboard Building Block.
 *
 * The dev server serves a local observability page at the configured path,
 * without creating a CloudWatch dashboard or resolving credentials.
 */
import type { ScopeParent } from '@aws-cdk-blocks/core';
import { RawRoute, Scope, registerSdkIdentifiers } from '@aws-cdk-blocks/core';
import { renderLocalDashboard } from './local-dashboard.js';
import type { DashboardOptions } from './types.js';
import { BB_NAME, BB_VERSION } from './version.js';
import { assertNotMockInDeployedEnv } from '@aws-cdk-blocks/core/bb-utils';

// Fail closed if this mock entry loads in a deployed env — see assertNotMockInDeployedEnv.
assertNotMockInDeployedEnv('bb-dashboard');

export { DashboardErrors } from './errors.js';
export type {
	DashboardOptions,
	MetricConfig,
	MetricsBBRef,
	MetricsSource,
} from './types.js';

/**
 * Mock Dashboard — serves the local dashboard; the CloudWatch URL is always null locally.
 *
 * CloudWatch Dashboards are a cloud-only resource that cannot be replicated
 * locally. This mock logs a message on construction and provides a null URL.
 * The RawRoute serves local observability guidance and configured metrics in the dev server.
 *
 * @example
 * ```typescript
 * const dashboard = new Dashboard(scope, 'dashboard', { title: 'My App' });
 * // Logs: "[Dashboard] Local dashboard: /cdk-blocks/dashboard"
 * // dashboard.url === null
 * ```
 */
export class Dashboard extends Scope {
	/** Always null in local mode. */
	readonly url: null = null;

	/** The configured dashboard name. */
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
		const title = options?.title ?? id;
		this.dashboardName = (options?.dashboardName ?? this.fullId).replace(/[^A-Za-z0-9\-_]/g, '-').substring(0, 255);
		registerSdkIdentifiers(this.fullId, { dashboardName: this.dashboardName });

		const routePath = options?.routePath;
		if (routePath !== false) {
			const path = routePath ?? '/cdk-blocks/dashboard';
			const page = renderLocalDashboard(title, options);
			new RawRoute(scope, 'dashboard-redirect', {
				method: 'GET',
				path,
				handler: async ({ response }) => {
					response.status = 200;
					response.headers.set('Content-Type', 'text/html; charset=utf-8');
					response.send(page);
				},
			});
			console.log(`[Dashboard] Local dashboard: ${path}`);
		}
	}
}
