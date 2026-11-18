// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AppSetting } from '@aws-blocks/bb-app-setting';
import { type ChildLogger, Logger } from '@aws-blocks/bb-logger';
import { getSdkIdentifiers, registerSdkIdentifiers, Scope, type ScopeParent } from '@aws-blocks/core';
import type { SqlQuery } from './common/sql.js';
import {
	CONNECTION_SETTING_ID,
	clusterConfigKey,
	connectionParameterName,
	sanitizeDbRoleName,
	searchPathFor,
} from './constants.js';
import { iamAuthToken, PgEngine } from './engines/pg-engine.js';
import { configError } from './errors.js';
import { sourceConnectionLabel, ssmConnectionLabel } from './external/connection.js';
import { externalEngineFrom } from './external/engine.js';
import { existingCluster, registerDatabase, registerUniqueId, resolveClusterOptions } from './runtime/construction.js';
import { DatabaseCore } from './runtime/index.js';
import { registerInternalAccess } from './runtime/internal.js';
import { roleDatabase, scopedDatabase } from './runtime/scoped.js';
import type {
	ClusterRef,
	ClusterType,
	ConnectionStringSource,
	DatabaseClusterOptions,
	DatabaseOptions,
	ExistingClusterOptions,
	ExistingClusterRef,
	QueryOptions,
	ScopedDatabase,
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
		this.type = resolveClusterOptions(options, this.fullId).type;
		registerUniqueId('DatabaseCluster', this, id, this.fullId);
		registerSdkIdentifiers(this.fullId, readClusterConfig(this.fullId));
	}

	/** Refer to an existing PostgreSQL database; see the local entry for the full description. */
	static fromExisting(options: ExistingClusterOptions): ExistingClusterRef {
		return existingCluster(options);
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
		const resolved = registerDatabase(this, id, this.fullId, options);
		const { clusterFullId } = resolved;
		this.cluster = resolved.ref;
		this.schemaName = resolved.schemaName;

		registerSdkIdentifiers(this.fullId, {
			clusterId: clusterFullId,
			schemaName: this.schemaName,
			...(resolved.external ? {} : readClusterConfig(clusterFullId)),
		});

		let buildEngine: () => Promise<PgEngine>;
		if (resolved.external) {
			// The connection string of an existing database: the app's own store, or the SSM SecureString that
			// `cdk-blocks db connect --stage` wrote and the CDK layer lets the app role read. The child setting
			// is built here, in the constructor; the value is read with the first statement.
			const { ca } = resolved.external;
			const { source, label } = this.connectionSource(resolved.external);
			buildEngine = () => externalEngineFrom(source, label, { ca, schemaName: this.schemaName });
		} else {
			const kind = resolved.ref.kind;
			buildEngine = async () => {
				const { clusterEndpoint, region } = getSdkIdentifiers(this);
				if (!clusterEndpoint || !region) {
					throw configError(
						`Database '${this.fullId}' is not configured: missing ${clusterConfigKey(clusterFullId, 'ENDPOINT')} / _REGION. Ensure the cluster is provisioned.`,
					);
				}
				const role = sanitizeDbRoleName(clusterFullId);
				return new PgEngine({
					kind,
					endpoint: clusterEndpoint,
					role,
					getAuthToken: iamAuthToken({ kind, endpoint: clusterEndpoint, region, role }),
					searchPath: searchPathFor(this.schemaName),
				});
			};
		}

		this.core = new DatabaseCore({ engine: buildEngine });
		registerInternalAccess(this, {
			engine: () => this.core.getEngine(),
			session: () => this.core.session(),
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

	asUser(user: { userId: string }, claims?: Record<string, unknown>): ScopedDatabase {
		return scopedDatabase(this, user, claims);
	}

	asRole(role: string, claims?: Record<string, unknown>): ScopedDatabase {
		return roleDatabase(this, role, claims);
	}

	private connectionSource(external: ExistingClusterRef): { source: ConnectionStringSource; label: string } {
		if (external.connectionString) {
			return { source: external.connectionString, label: sourceConnectionLabel(this.fullId) };
		}
		// Tools load this entry outside a function (client generation does), where there is no stack name. The
		// constructor must not fail there, so a missing name stops the first statement instead.
		const stackName = process.env.BLOCKS_STACK_NAME;
		const parameterName = connectionParameterName(stackName ?? '', external.name ?? '');
		const setting = AppSetting.fromExisting<string>(this, CONNECTION_SETTING_ID, {
			name: parameterName,
			secret: true,
		});
		return {
			source: {
				get: () => {
					if (!stackName) {
						throw configError(
							`Database '${this.fullId}': BLOCKS_STACK_NAME is not set, so the connection string parameter cannot be named.`,
						);
					}
					return setting.get();
				},
			},
			label: ssmConnectionLabel(parameterName),
		};
	}
}

export * from './exports.js';
