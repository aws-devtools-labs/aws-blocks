// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Bindings } from '../types.js';
import {
	diffBindings,
	enforceLocalBinding,
	formatBindingStop,
	readBindingMarker,
	removedClusterResources,
} from './bindings.js';

describe('bindings', () => {
	test('diffBindings reports only blocks whose cluster id or type changed', () => {
		const deployed: Bindings = {
			databases: {
				'app-orders': { cluster: 'default', type: 'dsql', resource: 'ordersDsql' },
				'app-gone': { cluster: 'default', type: 'dsql', resource: 'goneDsql' },
			},
			clusters: {},
		};
		const next: Bindings = {
			databases: {
				'app-orders': { cluster: 'app-main', type: 'dsql' },
				'app-new': { cluster: 'default', type: 'dsql', resource: 'newDsql' },
			},
			clusters: { 'app-main': { type: 'dsql', resource: 'mainDsql' } },
		};
		const changes = diffBindings(deployed, next);
		assert.strictEqual(changes.length, 1);
		assert.strictEqual(changes[0].fullId, 'app-orders');
		assert.deepStrictEqual(diffBindings(undefined, next), [], 'first deploy has nothing to compare');
		const renamedResource: Bindings = {
			databases: { 'app-orders': { cluster: 'default', type: 'dsql', resource: 'other' } },
			clusters: {},
		};
		assert.deepStrictEqual(
			diffBindings(
				{ databases: { 'app-orders': deployed.databases['app-orders'] }, clusters: {} },
				renamedResource,
			),
			[],
			'a changed logical id alone is not a binding change',
		);
	});

	test('removedClusterResources lists the cluster resources whose owner left the record', () => {
		const deployed: Bindings = {
			databases: {
				'app-orders': { cluster: 'default', type: 'dsql', resource: 'ordersDsql' },
				'app-kept': { cluster: 'default', type: 'dsql', resource: 'keptDsql' },
				'app-shared': { cluster: 'app-main', type: 'dsql' },
			},
			clusters: {
				'app-main': { type: 'dsql', resource: 'mainDsql' },
				'app-old': { type: 'dsql', resource: 'oldDsql' },
			},
		};
		const next: Bindings = {
			databases: {
				'app-kept': { cluster: 'default', type: 'dsql', resource: 'keptDsql' },
				'app-shared': { cluster: 'app-main', type: 'dsql' },
			},
			clusters: { 'app-main': { type: 'dsql', resource: 'mainDsql' } },
		};
		assert.deepStrictEqual([...removedClusterResources(deployed, next)].sort(), ['oldDsql', 'ordersDsql']);
		assert.deepStrictEqual([...removedClusterResources(undefined, next)], []);
	});

	test('formatBindingStop prints the stop message', () => {
		const message = formatBindingStop(
			{
				fullId: 'app-orders',
				from: { cluster: 'default', type: 'dsql' },
				to: { cluster: 'app-main', type: 'dsql' },
			},
			{ shortId: 'orders', removalPolicy: 'retain' },
		);
		assert.strictEqual(
			message,
			"Deploy stopped: Database 'app-orders' is bound to its default cluster (dsql) and cannot move to 'app-main' (dsql).\n" +
				"A Database keeps its cluster for life. To change clusters: add a new Database on 'app-main', copy the data, switch your handlers, then remove 'orders'.\n" +
				'Data on the default cluster is retained (removal policy: retain).',
		);
	});

	test('enforceLocalBinding writes the marker once and stops on a change', () => {
		const dir = mkdtempSync(join(tmpdir(), 'bb-database-binding-'));
		try {
			enforceLocalBinding(dir, 'app-db', 'db', { cluster: 'default', type: 'dsql' });
			assert.deepStrictEqual(readBindingMarker(dir), { cluster: 'default', type: 'dsql' });
			enforceLocalBinding(dir, 'app-db', 'db', { cluster: 'default', type: 'dsql' });
			assert.throws(
				() => enforceLocalBinding(dir, 'app-db', 'db', { cluster: 'app-main', type: 'dsql' }),
				/Deploy stopped: Database 'app-db' is bound to its default cluster \(dsql\)[\s\S]*delete \.bb-data\/app-db/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
