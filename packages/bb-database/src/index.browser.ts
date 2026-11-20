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
	asUser(): never {
		return serverOnly('Database.asUser()');
	}
	asRole(): never {
		return serverOnly('Database.asRole()');
	}
}

// biome-ignore lint/complexity/noStaticOnlyClass: the stub mirrors the class the other entry points export
export class DatabaseCluster {
	static fromExisting(): never {
		return serverOnly('DatabaseCluster.fromExisting()');
	}
}

/** @deprecated See the server entry points. */
export class LegacyDatabaseCluster {}

export function sql(): never {
	return serverOnly('sql');
}

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
