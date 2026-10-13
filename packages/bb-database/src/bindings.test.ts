// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { diffBindings, enforceLocalBinding, formatBindingStop, readBindingMarker } from './bindings.js';

describe('bindings', () => {
	test('diffBindings reports only blocks whose cluster id or type changed', () => {
		const deployed = {
			databases: {
				'app-orders': { cluster: 'default', type: 'distributed' as const },
				'app-gone': { cluster: 'default', type: 'distributed' as const },
			},
			clusters: {},
		};
		const next = {
			databases: {
				'app-orders': { cluster: 'app-main', type: 'provisioned' as const },
				'app-new': { cluster: 'default', type: 'distributed' as const },
			},
			clusters: { 'app-main': { type: 'provisioned' as const } },
		};
		const changes = diffBindings(deployed, next);
		assert.strictEqual(changes.length, 1);
		assert.strictEqual(changes[0].fullId, 'app-orders');
		assert.deepStrictEqual(diffBindings(undefined, next), [], 'first deploy has nothing to compare');
	});

	test('formatBindingStop prints the stop message', () => {
		const message = formatBindingStop(
			{
				fullId: 'app-orders',
				from: { cluster: 'default', type: 'distributed' },
				to: { cluster: 'app-main', type: 'provisioned' },
			},
			{ shortId: 'orders', removalPolicy: 'retain' },
		);
		assert.strictEqual(
			message,
			"Deploy stopped: Database 'app-orders' is bound to its default cluster (distributed) and cannot move to 'app-main' (provisioned).\n" +
				"A Database keeps its cluster for life. To change clusters: add a new Database on 'app-main', copy the data, switch your handlers, then remove 'orders'.\n" +
				'Data on the default cluster is retained (removal policy: retain).',
		);
	});

	test('enforceLocalBinding writes the marker once and stops on a change', () => {
		const dir = mkdtempSync(join(tmpdir(), 'bb-database-binding-'));
		try {
			enforceLocalBinding(dir, 'app-db', 'db', { cluster: 'default', type: 'distributed' });
			assert.deepStrictEqual(readBindingMarker(dir), { cluster: 'default', type: 'distributed' });
			enforceLocalBinding(dir, 'app-db', 'db', { cluster: 'default', type: 'distributed' });
			assert.throws(
				() => enforceLocalBinding(dir, 'app-db', 'db', { cluster: 'app-main', type: 'provisioned' }),
				/Deploy stopped: Database 'app-db' is bound to its default cluster \(distributed\)[\s\S]*delete \.bb-data\/app-db/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
