// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export type { SqlQuery, Transaction } from '@aws-blocks/data-common';
/**
 * The named exports every runtime entry point (mock, aws, cdk) shares. Keeping
 * them in one file is what makes the conditional-export parity test trivially
 * true for everything but the two classes.
 */
export { createKyselyAdapter, sql } from '@aws-blocks/data-common';
export { diffBindings, formatBindingStop } from './bindings.js';
export type {
	CrudAuthResult,
	CrudMethods,
	CrudOptions,
	QueryOpts,
	TableMetaEntry,
	TableSchema,
	TableTypeMeta,
} from './crud/types.js';
export { DatabaseErrors } from './errors.js';
export { buildMigrationPlan, formatMigrationPlan } from './migrations/plan.js';
export { _resetDatabaseRegistry } from './registry.js';
export type { RLSContext } from './rls.js';
export type { RLSScopedDatabase } from './rls-database.js';
export type {
	AnyClusterDatabaseOptions,
	Bindings,
	ClusterKind,
	ClusterOptionsOf,
	ClusterRef,
	ClusterType,
	DatabaseBinding,
	DatabaseBlockOptions,
	DatabaseClusterLike,
	DatabaseClusterOptions,
	DatabaseOptions,
	DistributedClusterOptions,
	DistributedDatabaseOptions,
	ExternalCluster,
	ExternalClusterRef,
	ExternalDatabaseOptions,
	ExternalSslOptions,
	FilePlan,
	KindOf,
	MigrationPlan,
	OwnedDatabaseOptions,
	PlanStep,
	ProvisionedClusterOptions,
	ProvisionedDatabaseOptions,
	RlsCapableKind,
	RlsDatabaseOptions,
	SubnetSelection,
	TransactionOptions,
} from './types.js';
