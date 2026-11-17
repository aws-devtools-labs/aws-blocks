// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test fixture: an API namespace defined in a sub-module of the backend module.
 * `create()` cache-busts only the top-level backend module (`?stack=<id>`), so
 * this module is evaluated once per process — its namespace stays bound to the
 * FIRST backend that imported it, even when a second backend re-exports it.
 */
import { ApiNamespace } from '../../api.js';
import { Scope } from '../index.js';

export const reports = new ApiNamespace(
	new Scope('reports', { parent: (globalThis as any).CURRENT_BLOCKS_STACK }),
	'reports',
	() => ({
		async run() {
			return 'ok';
		},
	}),
);
