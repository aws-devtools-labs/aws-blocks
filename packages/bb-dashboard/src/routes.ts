// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Route registration for the Dashboard BB.
 *
 * Mounts a single GET route that 302-redirects to the CloudWatch Dashboard
 * console URL. The URL is read from the `BB_DASHBOARD_URL` environment variable
 * (set by the CDK layer) or from the provided deployment URL.
 */

import { RawRoute, type BlocksContext } from '@aws-cdk-blocks/core';
import type { ScopeParent } from '@aws-cdk-blocks/core';

/** Environment variable key used to pass the dashboard URL from CDK to runtime. */
export const BB_DASHBOARD_URL_ENV = 'BB_DASHBOARD_URL';

/**
 * Mount the dashboard redirect route on the given scope.
 *
 * @param scope - Parent scope to register the RawRoute on.
 * @param routePath - HTTP path for the redirect (e.g., '/cdk-blocks/dashboard').
 * @param dashboardUrl - Fallback CloudWatch URL when the environment does not supply one.
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
			const url = process.env[BB_DASHBOARD_URL_ENV] ?? dashboardUrl;
			if (!url) {
				ctx.response.status = 503;
				ctx.response.headers.set('Content-Type', 'application/json');
				ctx.response.send({
					message: 'Dashboard BB - CloudWatch Dashboards are a cloud-only resource.',
					hint: 'Run `npx cdk deploy` to create the dashboard in AWS.',
					localObservability: {
						logs: 'Check your terminal output - Logger BB writes structured JSON to stdout',
						metrics: 'Metrics BB writes EMF-formatted JSON to stdout (visible in terminal)',
						traces: 'Tracer stores mock traces to .cdk-blocks/local/data/ and logs them to stdout',
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
