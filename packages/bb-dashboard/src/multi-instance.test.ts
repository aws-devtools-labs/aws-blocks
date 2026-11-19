// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Several `Dashboard` blocks in one app, on the AWS runtime.
 *
 * Each dashboard's redirect route must 302 to that dashboard's own CloudWatch
 * console URL, and each instance's `url` / `dashboardName` must describe its own
 * deployed resource — never another dashboard's. The deployed name is the one the
 * CDK layer provisions (`resolveConfig(id, options, fullId)`), so the runtime is
 * checked against it.
 */

import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type BlocksContext, clearRouteRegistry, getRegisteredRoutes, Scope } from '@aws-blocks/core';
import { resolveConfig } from './widgets.js';

const REGION = 'eu-central-1';

/** The console URL of the dashboard named `name` in {@link REGION}. */
function consoleUrl(name: string): string {
	return `https://${REGION}.console.aws.amazon.com/cloudwatch/home?region=${REGION}#dashboards/dashboard/${name}`;
}

/** Invoke the registered GET route at `path` and return its status and Location header. */
async function hit(path: string): Promise<{ status: number; location: string | null }> {
	const route = getRegisteredRoutes().find((r) => r.method === 'GET' && r.path === path);
	assert.ok(route, `a GET route is registered at ${path}`);
	const headers = new Headers();
	const ctx: BlocksContext = {
		request: {
			headers: new Headers(),
			body: null,
			json: async () => ({}),
			text: async () => '',
			url: new URL(`http://localhost${path}`),
			params: {},
		},
		response: { headers, status: 200, send: () => {} },
	};
	await route.handler(ctx);
	return { status: ctx.response.status, location: headers.get('Location') };
}

describe('several Dashboards on the AWS runtime', () => {
	const saved = { region: process.env.AWS_REGION, legacy: process.env.BB_DASHBOARD_URL };

	beforeEach(() => {
		Scope._resetRegistry();
		clearRouteRegistry();
		process.env.AWS_REGION = REGION;
		// The value an earlier release's config would leave behind: one app-wide
		// key holding the URL of whichever dashboard registered it last. A dashboard
		// must not redirect to it.
		process.env.BB_DASHBOARD_URL = consoleUrl('app-ops');
	});

	afterEach(() => {
		for (const [key, value] of [
			['AWS_REGION', saved.region],
			['BB_DASHBOARD_URL', saved.legacy],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it('each route redirects to its own dashboard and each url is its own', async () => {
		const { Dashboard } = await import('./index.aws.js');
		const app = new Scope('app');
		const dashboards = [
			{ dash: new Dashboard(app, 'main'), path: '/aws-blocks/dashboard' },
			{ dash: new Dashboard(app, 'billing', { routePath: '/dash/billing' }), path: '/dash/billing' },
			{ dash: new Dashboard(app, 'ops', { routePath: '/dash/ops' }), path: '/dash/ops' },
		];

		for (const { dash, path } of dashboards) {
			const expected = consoleUrl(dash.dashboardName);
			assert.equal(dash.url, expected, `${dash.fullId}.url`);
			assert.deepEqual(await hit(path), { status: 302, location: expected }, `GET ${path}`);
		}
		assert.equal(new Set(dashboards.map(({ dash }) => dash.url)).size, dashboards.length, 'urls are distinct');
	});

	it('dashboardName matches the name the CDK layer deploys', async () => {
		const { Dashboard } = await import('./index.aws.js');
		const app = new Scope('app');
		const plain = new Dashboard(app, 'main', { routePath: false });
		const named = new Dashboard(app, 'named', { routePath: false, dashboardName: 'my.ops/board' });

		assert.equal(plain.dashboardName, resolveConfig('main', undefined, plain.fullId).dashboardName);
		assert.equal(plain.dashboardName, 'app-main');
		assert.equal(
			named.dashboardName,
			resolveConfig('named', { dashboardName: 'my.ops/board' }, named.fullId).dashboardName,
		);
		assert.equal(named.url, consoleUrl('my-ops-board'));
	});

	it('url is null and the route returns 503 when no region is set', async () => {
		delete process.env.AWS_REGION;
		const { Dashboard } = await import('./index.aws.js');
		const dash = new Dashboard(new Scope('app'), 'main');
		assert.equal(dash.url, null);
		assert.equal((await hit('/aws-blocks/dashboard')).status, 503);
	});
});
