// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildLogger, Logger } from '@aws-blocks/bb-logger';
import { getSdkIdentifiers, registerSdkIdentifiers, Scope, type ScopeParent } from '@aws-blocks/core';
import type { DatabaseEngine, SqlQuery } from '@aws-blocks/data-common';
import { DsqlSigner } from '@aws-sdk/dsql-signer';
import { clusterConfigKey, sanitizeDbRoleName, searchPathFor } from './constants.js';
import { registerDatabase, registerUniqueId } from './core/construction.js';
import { DatabaseCore } from './core/index.js';
import { registerInternalAccess } from './core/internal.js';
import { DsqlEngine } from './engines/dsql-engine.js';
import { configError } from './errors.js';
import type {
	ClusterRef,
	ClusterType,
	DatabaseClusterOptions,
	DatabaseOptions,
	QueryOptions,
	Transaction,
	TransactionOptions,
} from './types.js';
import { BB_NAME, BB_VERSION } from './version.js';

// Keyed by cluster, not by block, so every block on one cluster reads the same config.
function readClusterConfig(clusterFullId: string): Record<string, string> {
	return {
		clusterEndpoint: process.env[clusterConfigKey(clusterFullId, 'ENDPOINT')] ?? '',
		region: process.env[clusterConfigKey(clusterFullId, 'REGION')] ?? '',
	};
}

/** At runtime a cluster only names the deployed resource; each block opens its own connections. */
export class DatabaseCluster extends Scope {
	/** The category this cluster was constructed with. */
	readonly type: ClusterType;

	constructor(scope: ScopeParent, id: string, options: DatabaseClusterOptions) {
		super(id, { parent: scope });
		this.type = options.type;
		registerUniqueId('DatabaseCluster', id, this.fullId);
		registerSdkIdentifiers(this.fullId, readClusterConfig(this.fullId));
	}
}

/**
 * SQL database on PostgreSQL, Lambda runtime build. See the package README for the
 * full API; the surface is identical to local mode.
 */
export class Database extends Scope {
	readonly cluster: ClusterRef;
	readonly schemaName: string;

	private readonly core: DatabaseCore;
	/** @internal Logger for internal operations. Defaults to error level. */
	protected log: ChildLogger;

	/**
	 * Without `cluster`, the block owns an Aurora DSQL cluster and `removalPolicy`
	 * applies to it. With `cluster`, the block runs in its own schema on that shared
	 * `DatabaseCluster`, whose own options then apply.
	 */
	constructor(scope: ScopeParent, id: string, options: DatabaseOptions = {}) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options.logger ?? new Logger(this, 'logger', { level: 'error' });
		const { ref, schemaName, clusterFullId } = registerDatabase(id, this.fullId, options);
		this.cluster = ref;
		this.schemaName = schemaName;

		registerSdkIdentifiers(this.fullId, {
			clusterId: clusterFullId,
			schemaName: this.schemaName,
			...readClusterConfig(clusterFullId),
		});

		const buildEngine = async (): Promise<DatabaseEngine> => {
			const { clusterEndpoint, region } = getSdkIdentifiers(this);
			if (!clusterEndpoint || !region) {
				throw configError(
					`Database '${this.fullId}' is not configured: missing ${clusterConfigKey(clusterFullId, 'ENDPOINT')} / _REGION. Ensure the cluster is provisioned.`,
				);
			}
			const signer = new DsqlSigner({ hostname: clusterEndpoint, region });
			return new DsqlEngine({
				endpoint: clusterEndpoint,
				role: sanitizeDbRoleName(clusterFullId),
				getAuthToken: () => signer.getDbConnectAuthToken(),
				searchPath: searchPathFor(this.schemaName),
			});
		};

		this.core = new DatabaseCore({ engine: buildEngine });
		registerInternalAccess(this, {
			engine: () => this.core.getEngine(),
			simulateConflict: () => {
				throw configError('simulateConflict() is only available in local mode (the mock entry point).');
			},
			migrationsPath: undefined,
		});
	}

	query<T>(query: SqlQuery, options?: QueryOptions<T>): Promise<T[]> {
		return this.core.query<T>(query, options);
	}

	queryOne<T>(query: SqlQuery, options?: QueryOptions<T>): Promise<T | null> {
		return this.core.queryOne<T>(query, options);
	}

	execute(query: SqlQuery): Promise<{ rowCount: number }> {
		return this.core.execute(query);
	}

	transaction<T>(fn: (tx: Transaction) => Promise<T>, options?: TransactionOptions): Promise<T> {
		return this.core.transaction(fn, options);
	}
}

export * from './exports.js';
