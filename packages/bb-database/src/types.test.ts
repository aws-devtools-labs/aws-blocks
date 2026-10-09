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
import type { ClusterKind, ClusterType, ExternalCluster } from './types.js';

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

	// 2. A cluster is a block; its type parameter is inferred from `type`.
	const main = new DatabaseCluster(scope, 'main', { type: 'provisioned', minCapacity: 0.5 });
	type _Main = Expect<Equal<typeof main, DatabaseClusterType<'provisioned'>>>;
	const onMain = new Database(scope, 'users', { cluster: main });
	type _OnMain = Expect<Equal<typeof onMain, DatabaseType<'provisioned'>>>;

	const shared = new DatabaseCluster(scope, 'shared', { type: 'distributed' });
	type _Shared = Expect<Equal<typeof shared, DatabaseClusterType<'distributed'>>>;
	const onShared = new Database(scope, 'orders', { cluster: shared });
	type _OnShared = Expect<Equal<typeof onShared, DatabaseType<'distributed'>>>;

	// 4. A cluster you already have.
	const supabase = DatabaseCluster.fromExisting({
		connectionString: 'postgres://x',
		ssl: { rejectUnauthorized: true },
	});
	type _Ext = Expect<Equal<typeof supabase, ExternalCluster>>;
	const onExternal = new Database(scope, 'ext', {
		cluster: supabase,
		schemaName: 'public',
		schema: {},
		rlsPolicy: 'enforce',
	});
	type _OnExt = Expect<Equal<typeof onExternal, DatabaseType<'external'>>>;

	// A cluster held as a union lands on the catch-all: the conservative surface.
	const dynamic = Math.random() > 0.5 ? main : shared;
	const onDynamic = new Database(scope, 'dyn', { cluster: dynamic });
	type _Dyn = Expect<Equal<typeof onDynamic, DatabaseType<ClusterType>>>;
	const dynamicOrExternal: DatabaseClusterType<ClusterType> | ExternalCluster =
		Math.random() > 0.5 ? dynamic : supabase;
	const onAny = new Database(scope, 'any', { cluster: dynamicOrExternal });
	type _Any = Expect<Equal<typeof onAny, DatabaseType<ClusterKind>>>;

	// withRLS() / crud() exist only where the kind allows them.
	void onMain.withRLS({ userId: 'u' });
	void onExternal.crud({ tables: [], auth: async () => ({ userId: 'u' }) });
	// @ts-expect-error: not available on a 'distributed' cluster
	void owned.withRLS({ userId: 'u' });
	// @ts-expect-error: not available on a 'distributed' cluster
	void onShared.crud({ tables: [], auth: async () => ({ userId: 'u' }) });
	// @ts-expect-error: a dynamic choice gets the conservative surface
	void onDynamic.withRLS({ userId: 'u' });
	// @ts-expect-error: a dynamic choice gets the conservative surface
	void onAny.crud({ tables: [], auth: async () => ({ userId: 'u' }) });

	// query / queryOne / execute / transaction: every kind.
	void onDynamic.query;
	void onAny.transaction;

	// Cluster options are narrowed by `type`.
	// @ts-expect-error: minCapacity does not belong to a distributed cluster
	new DatabaseCluster(scope, 'c1', { type: 'distributed', minCapacity: 1 });
	// @ts-expect-error: snapshot is not a distributed removal policy
	new DatabaseCluster(scope, 'c2', { type: 'distributed', removalPolicy: 'snapshot' });
	// @ts-expect-error: service names are not categories
	new DatabaseCluster(scope, 'c3', { type: 'aurora' });
	// @ts-expect-error: type is required
	new DatabaseCluster(scope, 'c4', {});
	new DatabaseCluster(scope, 'c5', { type: 'provisioned', removalPolicy: 'snapshot', postgresVersion: '16.13' });

	// Block options: schema / rlsPolicy only where the cluster is provisioned or external.
	// @ts-expect-error: schema on a block with no cluster
	new Database(scope, 'b1', { schema: {} });
	// @ts-expect-error: rlsPolicy on a distributed cluster
	new Database(scope, 'b2', { cluster: shared, rlsPolicy: 'enforce' });
	// @ts-expect-error: removalPolicy lives on the cluster once `cluster` is set
	new Database(scope, 'b3', { cluster: main, removalPolicy: 'destroy' });
	// @ts-expect-error: schema is not accepted on the conservative surface
	new Database(scope, 'b4', { cluster: dynamic, schema: {} });

	// fromExisting rejects the misleading TLS combination.
	// @ts-expect-error: a pinned CA with verification off is not expressible
	DatabaseCluster.fromExisting({ connectionString: 'postgres://x', ssl: { ca: 'x', rejectUnauthorized: false } });

	// The descriptor carries the kind.
	type _Ref = Expect<Equal<typeof onMain.cluster.kind, 'provisioned'>>;
	void owned;
	void onDynamic;
}

test('type contract compiled', () => {
	assert.strictEqual(typeof typeChecks, 'function');
});
