// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Compile-time contract of the `Database` / `DatabaseCluster` surface. Every
 * `@ts-expect-error` below is a rule of the public surface: if the compiler
 * stops rejecting the line, `tsc --build` fails. The runtime test only confirms
 * the file was compiled, so the assertions can never be skipped.
 */
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
	// 1. Default: the block owns a distributed cluster.
	const owned = new Database(scope, 'db');
	type _Owned = Expect<Equal<typeof owned, DatabaseType<'distributed'>>>;
	const ownedWithOptions = new Database(scope, 'db2', { migrationsPath: './x', removalPolicy: 'destroy' });
	type _OwnedOpts = Expect<Equal<typeof ownedWithOptions, DatabaseType<'distributed'>>>;

	// 2. A shared cluster; its type parameter is inferred from `type`, and the block's kind from the cluster.
	const shared = new DatabaseCluster(scope, 'shared', { type: 'distributed' });
	type _Shared = Expect<Equal<typeof shared, DatabaseClusterType<'distributed'>>>;
	const onShared = new Database(scope, 'orders', { cluster: shared, schemaName: 'orders_v2' });
	type _OnShared = Expect<Equal<typeof onShared, DatabaseType<'distributed'>>>;

	// query / queryOne / execute / transaction on every kind; the descriptor carries the kind.
	void onShared.query;
	void owned.transaction;
	type _Ref = Expect<Equal<typeof onShared.cluster.kind, 'distributed'>>;
	type _RefId = Expect<Equal<typeof onShared.cluster.id, string>>;

	// Cluster options are narrowed by `type`.
	// @ts-expect-error: capacity options do not belong to a distributed cluster
	new DatabaseCluster(scope, 'c1', { type: 'distributed', minCapacity: 1 });
	// @ts-expect-error: snapshot is not a distributed removal policy
	new DatabaseCluster(scope, 'c2', { type: 'distributed', removalPolicy: 'snapshot' });
	// @ts-expect-error: service names are not categories
	new DatabaseCluster(scope, 'c3', { type: 'dsql' });
	// @ts-expect-error: type is required
	new DatabaseCluster(scope, 'c4', {});
	// @ts-expect-error: provisioned is not available yet
	new DatabaseCluster(scope, 'c5', { type: 'provisioned' });
	new DatabaseCluster(scope, 'c6', { type: 'distributed', removalPolicy: 'retain' });

	// Block options.
	// @ts-expect-error: removalPolicy lives on the cluster once `cluster` is set
	new Database(scope, 'b1', { cluster: shared, removalPolicy: 'destroy' });
	// @ts-expect-error: a cluster must be a DatabaseCluster
	new Database(scope, 'b2', { cluster: { kind: 'distributed' } });
	// @ts-expect-error: no RLS surface in this release
	void owned.withRLS;

	void ownedWithOptions;
}

test('type contract compiled', () => {
	assert.strictEqual(typeof typeChecks, 'function');
});
