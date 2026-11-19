// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Route registration for the Dashboard BB.
 *
 * Mounts a single GET route that 302-redirects to the CloudWatch Dashboard
 * console URL. Each route uses its dashboard's URL. The old shared
 * `BB_DASHBOARD_URL` environment variable is a fallback for earlier deployments.
 */

import { RawRoute, type BlocksContext } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { sanitizeConfigKey } from '@aws-blocks/core/bb-utils';

/** Legacy shared dashboard URL key, read only for compatibility with earlier deployments. */
export const BB_DASHBOARD_URL_ENV = 'BB_DASHBOARD_URL';

/** Config key shared by the CDK writer and runtime reader for one dashboard. */
export function dashboardUrlConfigKey(fullId: string): string {
	return `BLOCKS_DASHBOARD_URL_${sanitizeConfigKey(fullId)}`;
}

/**
 * Mount the dashboard redirect route on the given scope.
 *
 * @param scope - Parent scope to register the RawRoute on.
 * @param routePath - HTTP path for the redirect (e.g., '/aws-blocks/dashboard').
 * @param dashboardUrl - This dashboard's URL (null means not deployed). Takes priority over the legacy shared setting.
 */
export function mountDashboardRoute(
	scope: ScopeParent,
	routePath: string,
	dashboardUrl: string | null,
): void {
	new RawRoute(scope, 'dashboard-redirect', {
		method: 'GET',
		path: routePath,
		handler: async (ctx: BlocksContext) => {
			const url = dashboardUrl ?? process.env[BB_DASHBOARD_URL_ENV];
			if (!url) {
				ctx.response.status = 503;
				ctx.response.headers.set('Content-Type', 'application/json');
				ctx.response.send({
					message: 'Dashboard BB - CloudWatch Dashboards are a cloud-only resource.',
					hint: 'Run `npx cdk deploy` to create the dashboard in AWS.',
					localObservability: {
						logs: 'Check your terminal output - Logger BB writes structured JSON to stdout',
						metrics: 'Metrics BB writes EMF-formatted JSON to stdout (visible in terminal)',
						traces: 'Tracer stores mock traces to .bb-data/ and logs them to stdout',
					},
				});
				return;
			}
			ctx.response.status = 302;
			ctx.response.headers.set('Location', url);
			ctx.response.send('');
		},
	});
}
