// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// What getSdkIdentifiers(db) returns, from the local entry and from the Lambda entry: the same keys in both.
import assert from 'node:assert';
import { describe, test } from 'node:test';
import { getSdkIdentifiers } from '@aws-cdk-blocks/core';
import { LOCAL_APP_ROLE, sanitizeDbRoleName } from './constants.js';
import * as aws from './index.aws.js';
import * as mock from './index.mock.js';
import { freshScope, installLocalTestHooks } from './test-support/lifecycle.js';

installLocalTestHooks({ mockDataPrefix: 'bbsdkid' });

const entries = { mock, aws } as const;
// Never read: the block reads its connection string with the first statement.
const CONNECTION = { connectionString: { get: async () => null } };

describe('getSdkIdentifiers(db)', () => {
	test('on a cluster the block provisions, roleName is the role the block connects as', () => {
		const roles: Record<string, string> = {};
		const keys: Record<string, string[]> = {};
		for (const [name, entry] of Object.entries(entries)) {
			const scope = freshScope('bbsdkid');
			// Ids are unique per app, and both entries share the registry.
			const cluster = new entry.DatabaseCluster(scope, `main-${name}`, { type: 'aurora' });
			const ids = getSdkIdentifiers(new entry.Database(scope, `app-${name}`, { cluster }));
			roles[name] = ids.roleName;
			// The endpoint and region exist only in Lambda.
			keys[name] = Object.keys(ids)
				.filter((k) => k !== 'clusterEndpoint' && k !== 'region')
				.sort();
			if (name === 'aws') assert.strictEqual(ids.roleName, sanitizeDbRoleName(cluster.fullId));
		}
		assert.deepStrictEqual(keys.mock, ['clusterId', 'roleName', 'schemaName']);
		assert.deepStrictEqual(keys.aws, keys.mock);
		assert.strictEqual(roles.mock, LOCAL_APP_ROLE);
		assert.match(roles.aws, /^blocks_app_/);
	});

	test('a block that owns its cluster has one too', () => {
		for (const [name, entry] of Object.entries(entries)) {
			const db = new entry.Database(freshScope('bbsdkid'), `app-${name}`);
			assert.ok(getSdkIdentifiers(db).roleName?.startsWith('blocks_app_'));
		}
	});

	test('on an existing database there is no roleName: the role is the connection string’s', () => {
		for (const [name, entry] of Object.entries(entries)) {
			const db = new entry.Database(freshScope('bbsdkid'), `app-${name}`, {
				cluster: entry.DatabaseCluster.fromExisting(CONNECTION),
				schemaName: `app_${name}`,
			});
			assert.deepStrictEqual(Object.keys(getSdkIdentifiers(db)).sort(), ['clusterId', 'schemaName']);
		}
	});
});
