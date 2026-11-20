// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// One file for the mock, aws and cdk entries, so the conditional-export parity test holds for everything
// but the two classes.
export type { SqlQuery } from './common/sql.js';
export { sql } from './common/sql.js';
export { DatabaseErrors } from './errors.js';
export type {
	AuroraClusterOptions,
	ClusterKind,
	ClusterRef,
	ClusterType,
	ConnectionStringSource,
	DataApiOptions,
	DatabaseBlockOptions,
	DatabaseClusterLike,
	DatabaseClusterOptions,
	DatabaseOptions,
	DsqlClusterOptions,
	ExistingClusterOptions,
	ExistingClusterRef,
	ExistingDatabaseOptions,
	LegacyDatabaseClusterOptions,
	LegacySubnetSelection,
	OwnedDatabaseOptions,
	QueryOptions,
	ScopedDatabase,
	SharedDatabaseOptions,
	Transaction,
	TransactionOptions,
} from './types.js';
