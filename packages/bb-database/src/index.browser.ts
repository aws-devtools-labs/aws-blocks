// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

function serverOnly(name: string): never {
	throw new Error(`${name} is server-side only and cannot be used in the browser.`);
}

export class Database {
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
}

export class DatabaseCluster {}

export function sql(): never {
	return serverOnly('sql');
}

export { DatabaseErrors } from './errors.js';
export type {
	AuroraClusterOptions,
	ClusterRef,
	ClusterType,
	DatabaseBlockOptions,
	DatabaseClusterLike,
	DatabaseClusterOptions,
	DatabaseOptions,
	DsqlClusterOptions,
	OwnedDatabaseOptions,
	QueryOptions,
	SharedDatabaseOptions,
	Transaction,
	TransactionOptions,
} from './types.js';
