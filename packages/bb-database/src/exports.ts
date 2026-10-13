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
export { DatabaseErrors } from './errors.js';
export { buildMigrationPlan, formatMigrationPlan } from './migrations/plan.js';
export { _resetDatabaseRegistry } from './registry.js';
export type {
	Bindings,
	ClusterBinding,
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
	FilePlan,
	KindOf,
	MigrationPlan,
	OwnedDatabaseOptions,
	PlanStep,
	TransactionOptions,
} from './types.js';
