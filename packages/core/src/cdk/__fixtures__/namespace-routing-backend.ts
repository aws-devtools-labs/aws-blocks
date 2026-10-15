// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test fixture: two exported API namespaces, one on the default compute and one
 * on a second compute — the latter exported under a different name than its
 * `ApiNamespace` constructor name (like `export const authApi = auth.createApi()`,
 * constructed as `'auth'`). The shared gateway must route it by the export name,
 * which is what the client calls and dispatch resolves.
 *
 * The second compute comes from the test via `__BLOCKS_TEST_MAKE_COMPUTE__`,
 * because core's tests can't depend on a concrete compute package.
 */
import { ApiNamespace } from '../../api.js';
import type { Compute } from '../compute/compute.js';
import { Scope } from '../index.js';

const root = (globalThis as any).CURRENT_BLOCKS_STACK;
const makeCompute = (globalThis as any).__BLOCKS_TEST_MAKE_COMPUTE__ as (parent: unknown, id: string) => Compute;

const ordersScope = new Scope('orders-scope', { parent: root });
ordersScope._compute = makeCompute(root, 'OrdersCompute');

// On the default compute: served by the catch-all resources, so no route of its own.
export const api = new ApiNamespace(new Scope('app', { parent: root }), 'api', () => ({
	async ping() {
		return 'pong';
	},
}));

// Constructed as 'orders', exported as 'shop' — routed as /aws-blocks/api/shop.
export const shop = new ApiNamespace(ordersScope, 'orders', () => ({
	async list() {
		return [];
	},
}));
