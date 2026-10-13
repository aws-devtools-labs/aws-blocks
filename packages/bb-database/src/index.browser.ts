// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub. Database and DatabaseCluster run server-side only; this keeps
// Node.js / AWS SDK / PGlite code out of client bundles.

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
	simulateConflict(): never {
		return serverOnly('Database.simulateConflict()');
	}
	getEngine(): never {
		return serverOnly('Database.getEngine()');
	}
}

export class DatabaseCluster {
	constructor(..._args: unknown[]) {}
}

export function sql(): never {
	return serverOnly('sql');
}

export function createKyselyAdapter(): never {
	return serverOnly('createKyselyAdapter()');
}

export { DatabaseErrors } from './errors.js';
export type {
	Bindings,
	ClusterBinding,
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
	MigrationPlan,
	OwnedDatabaseOptions,
	PlanStep,
	TransactionOptions,
} from './types.js';
