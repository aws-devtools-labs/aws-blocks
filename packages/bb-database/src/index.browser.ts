// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub. Database and DatabaseCluster run server-side only; this keeps
// Node.js / AWS SDK / PGlite code out of client bundles.

import type { ExternalCluster, ExternalClusterRef } from './types.js';

function serverOnly(name: string): never {
	throw new Error(`${name} is server-side only and cannot be used in the browser.`);
}

export class Database {
	constructor(..._args: unknown[]) {}
	query(): never {
		return serverOnly('Database.query()');
	}
	queryOne(): never {
		return serverOnly('Database.queryOne()');
	}
	execute(): never {
		return serverOnly('Database.execute()');
	}
	transaction(): never {
		return serverOnly('Database.transaction()');
	}
	withRLS(): never {
		return serverOnly('Database.withRLS()');
	}
	crud(): never {
		return serverOnly('Database.crud()');
	}
	simulateConflict(): never {
		return serverOnly('Database.simulateConflict()');
	}
	getEngine(): never {
		return serverOnly('Database.getEngine()');
	}
}

export class DatabaseCluster {
	constructor(..._args: unknown[]) {}
	static fromExisting(ref: ExternalClusterRef): ExternalCluster {
		return { __brand: 'ExternalCluster', kind: 'external', ref };
	}
}

export function sql(): never {
	return serverOnly('sql');
}

export function createKyselyAdapter(): never {
	return serverOnly('createKyselyAdapter()');
}

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
export type { RLSContext } from './rls.js';
export type {
	AnyClusterDatabaseOptions,
	Bindings,
	ClusterKind,
	ClusterRef,
	ClusterType,
	DatabaseBinding,
	DatabaseBlockOptions,
	DatabaseClusterOptions,
	DatabaseOptions,
	DistributedClusterOptions,
	DistributedDatabaseOptions,
	ExternalCluster,
	ExternalClusterRef,
	ExternalDatabaseOptions,
	ExternalSslOptions,
	FilePlan,
	MigrationPlan,
	OwnedDatabaseOptions,
	PlanStep,
	ProvisionedClusterOptions,
	ProvisionedDatabaseOptions,
	RlsCapableKind,
	SubnetSelection,
	TransactionOptions,
} from './types.js';
