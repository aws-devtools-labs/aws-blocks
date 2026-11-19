// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { type BlocksContext, clearRouteRegistry, getRegisteredRoutes, Scope } from '@aws-blocks/core';
import { Dashboard } from './index.aws.js';
import { BB_DASHBOARD_URL_ENV, mountDashboardRoute } from './routes.js';

const opsUrl = 'https://us-east-1.console.aws.amazon.com/cloudwatch/home#dashboards/dashboard/ops';
const billingUrl = 'https://us-east-1.console.aws.amazon.com/cloudwatch/home#dashboards/dashboard/billing';
const opsKey = 'BLOCKS_DASHBOARD_URL_DASHBOARD_REDIRECTS_OPS_DASHBOARD';
const billingKey = 'BLOCKS_DASHBOARD_URL_DASHBOARD_REDIRECTS_BILLING_DASHBOARD';
const keys = [BB_DASHBOARD_URL_ENV, opsKey, billingKey];
let saved: Map<string, string | undefined>;

beforeEach(() => {
	clearRouteRegistry();
	saved = new Map(keys.map((key) => [key, process.env[key]]));
	for (const key of keys) delete process.env[key];
});

afterEach(() => {
	clearRouteRegistry();
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

async function responseAt(path: string): Promise<{ status: number; location: string | null }> {
	const route = getRegisteredRoutes().find((candidate) => candidate.path === path);
	assert.ok(route, `Missing route ${path}`);
	const headers = new Headers();
	const context: BlocksContext = {
		request: {
			headers: new Headers(),
			body: null,
			json: async () => ({}),
			text: async () => '',
			url: new URL(path, 'http://localhost'),
			params: {},
		},
		response: { headers, status: 200, send() {} },
	};
	await route.handler(context);
	return { status: context.response.status, location: headers.get('Location') };
}

function scopes() {
	const root = new Scope('dashboard-redirects');
	return {
		ops: new Scope('ops', { parent: root }),
		billing: new Scope('billing', { parent: root }),
	};
}

describe('Dashboard redirect isolation', () => {
	test('same-id dashboards in different scopes use their own URL, ahead of the legacy shared setting', async () => {
		process.env[opsKey] = opsUrl;
		process.env[billingKey] = billingUrl;
		process.env[BB_DASHBOARD_URL_ENV] = billingUrl;
		const { ops, billing } = scopes();
		const opsDashboard = new Dashboard(ops, 'dashboard', { routePath: '/ops/dashboard' });
		const billingDashboard = new Dashboard(billing, 'dashboard', { routePath: '/billing/dashboard' });

		assert.equal(opsDashboard.url, opsUrl);
		assert.equal(billingDashboard.url, billingUrl);
		assert.deepEqual(await responseAt('/ops/dashboard'), { status: 302, location: opsUrl });
		assert.deepEqual(await responseAt('/billing/dashboard'), { status: 302, location: billingUrl });
	});

	test('a dashboard without a configured URL does not redirect to a sibling dashboard', async () => {
		process.env[opsKey] = opsUrl;
		const { ops, billing } = scopes();
		new Dashboard(ops, 'dashboard', { routePath: '/ops/dashboard' });
		const unconfigured = new Dashboard(billing, 'dashboard', { routePath: '/billing/dashboard' });

		assert.equal(unconfigured.url, null);
		assert.deepEqual(await responseAt('/ops/dashboard'), { status: 302, location: opsUrl });
		assert.deepEqual(await responseAt('/billing/dashboard'), { status: 503, location: null });
	});

	test('routePath: false still exposes this dashboard URL without registering a route', () => {
		process.env[opsKey] = opsUrl;
		const { ops } = scopes();
		const dashboard = new Dashboard(ops, 'dashboard', { routePath: false });

		assert.equal(dashboard.url, opsUrl);
		assert.deepEqual(getRegisteredRoutes(), []);
	});

	test('an older single-dashboard config still supplies the URL and the default redirect', async () => {
		process.env[BB_DASHBOARD_URL_ENV] = opsUrl;
		const { ops } = scopes();
		const dashboard = new Dashboard(ops, 'dashboard');

		assert.equal(dashboard.url, opsUrl);
		assert.deepEqual(await responseAt('/aws-blocks/dashboard'), { status: 302, location: opsUrl });
	});

	test('a route-specific URL is not overridden by the legacy shared setting', async () => {
		process.env[BB_DASHBOARD_URL_ENV] = billingUrl;
		const { ops } = scopes();
		mountDashboardRoute(ops, '/ops/dashboard', opsUrl);

		assert.deepEqual(await responseAt('/ops/dashboard'), { status: 302, location: opsUrl });
	});
});
