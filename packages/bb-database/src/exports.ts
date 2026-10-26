// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export type { SqlQuery } from '@aws-blocks/data-common';
/**
 * The named exports every runtime entry point (mock, aws, cdk) shares. Keeping
 * them in one file is what makes the conditional-export parity test trivially
 * true for everything but the two classes.
 */
export { sql } from '@aws-blocks/data-common';
export { DatabaseErrors } from './errors.js';
export type {
	ClusterRef,
	ClusterType,
	DatabaseBlockOptions,
	DatabaseClusterLike,
	DatabaseClusterOptions,
	DatabaseOptions,
	DistributedClusterOptions,
	DistributedDatabaseOptions,
	OwnedDatabaseOptions,
	QueryOptions,
	Transaction,
	TransactionOptions,
} from './types.js';
