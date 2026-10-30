// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test fixture: one namespace created with `httpErrorStatus: true` and one
 * without. The backend owner records the first one's export name for `Hosting`.
 */
import { ApiNamespace } from '../../api.js';
import { Scope } from '../index.js';

const root = (globalThis as any).CURRENT_BLOCKS_STACK;
const scope = new Scope('app', { parent: root });

export const strictApi = new ApiNamespace(
	scope,
	'strict',
	() => ({
		async ping() {
			return 'pong';
		},
	}),
	{ httpErrorStatus: true },
);

export const api = new ApiNamespace(scope, 'api', () => ({
	async ping() {
		return 'pong';
	},
}));
