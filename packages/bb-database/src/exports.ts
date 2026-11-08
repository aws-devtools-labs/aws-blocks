// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// One file for the mock, aws and cdk entries, so the conditional-export parity test holds for everything
// but the two classes.
export type { SqlQuery } from '@aws-blocks/data-common';
export { sql } from '@aws-blocks/data-common';
export { DatabaseErrors } from './errors.js';
export type {
	ClusterRef,
	ClusterType,
	DatabaseBlockOptions,
	DatabaseClusterLike,
	DatabaseClusterOptions,
	DatabaseOptions,
	DsqlClusterOptions,
	DsqlDatabaseOptions,
	OwnedDatabaseOptions,
	QueryOptions,
	Transaction,
	TransactionOptions,
} from './types.js';
