// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Each `@ts-expect-error` is a rule of the public surface: if the compiler stops rejecting the line,
// `tsc --build` fails. The runtime test only confirms the file compiled, so the rules cannot be skipped.
import assert from 'node:assert';
import { test } from 'node:test';
import type { Scope } from '@aws-blocks/core';
import type { DatabaseCluster as DatabaseClusterType, Database as DatabaseType } from './index.mock.js';

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

declare const Database: typeof DatabaseType;
declare const DatabaseCluster: typeof DatabaseClusterType;
declare const scope: Scope;

function typeChecks(): void {
	const owned = new Database(scope, 'db');
	type _Owned = Expect<Equal<typeof owned, DatabaseType>>;
	const ownedWithOptions = new Database(scope, 'db2', { migrationsPath: './x', removalPolicy: 'destroy' });
	type _OwnedOpts = Expect<Equal<typeof ownedWithOptions, DatabaseType>>;

	const shared = new DatabaseCluster(scope, 'shared', { type: 'dsql' });
	type _Shared = Expect<Equal<typeof shared, DatabaseClusterType>>;
	const onShared = new Database(scope, 'orders', { cluster: shared, schemaName: 'orders_v2' });
	type _OnShared = Expect<Equal<typeof onShared, DatabaseType>>;

	void onShared.query;
	void owned.transaction;
	type _Ref = Expect<Equal<typeof onShared.cluster.kind, 'dsql'>>;
	type _RefId = Expect<Equal<typeof onShared.cluster.id, string>>;

	// @ts-expect-error: capacity options do not belong to a DSQL cluster
	new DatabaseCluster(scope, 'c1', { type: 'dsql', minCapacity: 1 });
	// @ts-expect-error: snapshot is not a DSQL removal policy
	new DatabaseCluster(scope, 'c2', { type: 'dsql', removalPolicy: 'snapshot' });
	// @ts-expect-error: the retired category name is not a cluster kind
	new DatabaseCluster(scope, 'c3', { type: 'distributed' });
	// @ts-expect-error: type is required
	new DatabaseCluster(scope, 'c4', {});
	// @ts-expect-error: provisioned is not available yet
	new DatabaseCluster(scope, 'c5', { type: 'provisioned' });
	new DatabaseCluster(scope, 'c6', { type: 'dsql', removalPolicy: 'retain' });

	// @ts-expect-error: removalPolicy lives on the cluster once `cluster` is set
	new Database(scope, 'b1', { cluster: shared, removalPolicy: 'destroy' });
	// @ts-expect-error: a cluster must be a DatabaseCluster
	new Database(scope, 'b2', { cluster: { kind: 'dsql' } });
	// @ts-expect-error: no RLS surface in this release
	void owned.withRLS;

	void ownedWithOptions;
}

test('type contract compiled', () => {
	assert.strictEqual(typeof typeChecks, 'function');
});
