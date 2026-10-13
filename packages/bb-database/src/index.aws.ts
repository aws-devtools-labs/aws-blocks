// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Lambda runtime entry point. DSQL over `pg` with IAM tokens, Aurora
 * over the RDS Data API, or `pg` to an external database. Connection config is
 * keyed by cluster (`BLOCKS_{clusterId}_*`), so blocks on one cluster share it.
 */
import { type ChildLogger, Logger } from '@aws-blocks/bb-logger';
import { getSdkIdentifiers, registerSdkIdentifiers, Scope, type ScopeParent } from '@aws-blocks/core';
import type { DatabaseEngine, SqlQuery, Transaction } from '@aws-blocks/data-common';
import { DsqlSigner } from '@aws-sdk/dsql-signer';
import { externalCluster, resolveCluster } from './cluster-ref.js';
import { DEFAULT_CLUSTER_ID, ENV_VAR_PREFIX, sanitizeDbRoleName, toEnvName } from './constants.js';
import type { CrudMethods, CrudOptions, TableTypeMeta } from './crud/types.js';
import { DatabaseCore } from './database-core.js';
import { DataApiEngine } from './engines/data-api-engine.js';
import { DsqlEngine } from './engines/dsql-engine.js';
import { PgClientEngine } from './engines/pg-client-engine.js';
import { configError } from './errors.js';
import { registerSchema, registerUniqueId } from './registry.js';
import type { RLSContext } from './rls.js';
import type { RLSScopedDatabase } from './rls-database.js';
import type {
	AnyClusterDatabaseOptions,
	ClusterKind,
	ClusterOptionsOf,
	ClusterRef,
	ClusterType,
	DatabaseOptions,
	DistributedDatabaseOptions,
	ExternalCluster,
	ExternalClusterRef,
	ExternalDatabaseOptions,
	KindOf,
	OwnedDatabaseOptions,
	ProvisionedDatabaseOptions,
	RlsCapableKind,
	RlsDatabaseOptions,
	TransactionOptions,
} from './types.js';
import { BB_NAME, BB_VERSION } from './version.js';

/** The config a cluster's runtime connection needs, read from `process.env` (loaded from the config bucket). */
function readClusterConfig(clusterFullId: string, type: ClusterType): Record<string, string> {
	const env = toEnvName(clusterFullId);
	const read = (suffix: string) => process.env[`${ENV_VAR_PREFIX}_${env}_${suffix}`] ?? '';
	return type === 'distributed'
		? { clusterEndpoint: read('ENDPOINT'), region: read('REGION') }
		: { clusterArn: read('CLUSTER_ARN'), secretArn: read('SECRET_ARN'), databaseName: read('DATABASE') || env };
}

/** At runtime a cluster only names the deployed resource; each block opens its own connections. */
export class DatabaseCluster<T extends ClusterType = ClusterType> extends Scope {
	readonly type: T;
	readonly kind: T;

	constructor(scope: ScopeParent, id: string, options: { type: T } & ClusterOptionsOf<T>) {
		// Plain scope: the cluster is part of the Database block, not a block itself.
		super(id, { parent: scope });
		this.type = options.type;
		this.kind = options.type;
		registerUniqueId('DatabaseCluster', id, this.fullId);
		registerSdkIdentifiers(this.fullId, readClusterConfig(this.fullId, options.type));
	}

	/** Reference a PostgreSQL you already have. See the mock entry for details. */
	static fromExisting(ref: ExternalClusterRef): ExternalCluster {
		return externalCluster(ref);
	}
}

/**
 * SQL database on PostgreSQL, Lambda runtime build. See the package README for the
 * full API; the surface is identical to local mode.
 */
export class Database<K extends ClusterKind = 'distributed'> extends Scope {
	readonly cluster: ClusterRef<K>;
	readonly schemaName: string;
	/** Migrations run at deploy time; the path is not resolved in the Lambda. */
	readonly migrationsPath: string | undefined = undefined;

	private readonly core: DatabaseCore;
	/** @internal Logger for internal operations. Defaults to error level. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options?: OwnedDatabaseOptions);
	constructor(scope: ScopeParent, id: string, options: ProvisionedDatabaseOptions & { cluster: KindOf<K> });
	constructor(scope: ScopeParent, id: string, options: ExternalDatabaseOptions & { cluster: KindOf<K> });
	constructor(scope: ScopeParent, id: string, options: DistributedDatabaseOptions & { cluster: KindOf<K> });
	constructor(scope: ScopeParent, id: string, options: AnyClusterDatabaseOptions & { cluster: KindOf<K> });
	constructor(scope: ScopeParent, id: string, options: DatabaseOptions = {}) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options.logger ?? new Logger(this, 'logger', { level: 'error' });
		registerUniqueId('Database', id, this.fullId);

		const resolved = resolveCluster(id, this.fullId, options);
		this.cluster = resolved.ref as ClusterRef<K>;
		this.schemaName = resolved.schemaName;
		const kind = resolved.ref.kind;
		const clusterFullId = resolved.ref.id === DEFAULT_CLUSTER_ID ? this.fullId : resolved.ref.id;
		registerSchema(clusterFullId, this.schemaName, this.fullId);

		const identifiers: Record<string, string> = { clusterId: clusterFullId, schemaName: this.schemaName };
		if (kind !== 'external') Object.assign(identifiers, readClusterConfig(clusterFullId, kind));
		registerSdkIdentifiers(this.fullId, identifiers);

		const schema = 'schema' in options ? (options as RlsDatabaseOptions).schema : undefined;
		const searchPath = this.schemaName !== 'public' ? this.schemaName : undefined;

		const buildEngine = async (): Promise<DatabaseEngine> => {
			if (resolved.external) {
				const ref = resolved.external.ref;
				if ('connectionString' in ref) {
					const connectionString =
						typeof ref.connectionString === 'string'
							? ref.connectionString
							: await ref.connectionString.get();
					return new PgClientEngine({ connectionString, ssl: ref.ssl, searchPath });
				}
				return new DataApiEngine({
					resourceArn: ref.host,
					secretArn: ref.secretArn,
					database: ref.database,
					schema: this.schemaName,
					customUserAgent: this.buildUserAgentChain(),
				});
			}
			const ids = getSdkIdentifiers(this);
			if (kind === 'distributed') {
				const { clusterEndpoint, region } = ids;
				if (!clusterEndpoint || !region) {
					throw configError(
						`Database '${this.fullId}' is not configured: missing ${ENV_VAR_PREFIX}_${toEnvName(clusterFullId)}_ENDPOINT / _REGION. Ensure the cluster is provisioned.`,
					);
				}
				const signer = new DsqlSigner({ hostname: clusterEndpoint, region });
				return new DsqlEngine({
					endpoint: clusterEndpoint,
					region,
					role: sanitizeDbRoleName(clusterFullId),
					getAuthToken: () => signer.getDbConnectAuthToken(),
					searchPath,
				});
			}
			const { clusterArn, secretArn, databaseName } = ids;
			if (!clusterArn || !secretArn) {
				throw configError(
					`Database '${this.fullId}' is not configured: missing ${ENV_VAR_PREFIX}_${toEnvName(clusterFullId)}_CLUSTER_ARN / _SECRET_ARN. Ensure the cluster is provisioned.`,
				);
			}
			return new DataApiEngine({
				resourceArn: clusterArn,
				secretArn,
				database: databaseName,
				schema: this.schemaName,
				customUserAgent: this.buildUserAgentChain(),
			});
		};

		this.core = new DatabaseCore({ kind, engine: buildEngine, schema, fullId: this.fullId });
	}

	query<T>(query: SqlQuery): Promise<T[]> {
		return this.core.query<T>(query);
	}

	queryOne<T>(query: SqlQuery): Promise<T | null> {
		return this.core.queryOne<T>(query);
	}

	execute(query: SqlQuery): Promise<{ rowCount: number }> {
		return this.core.execute(query);
	}

	transaction<T>(fn: (tx: Transaction) => Promise<T>, options?: TransactionOptions): Promise<T> {
		return this.core.transaction(fn, options);
	}

	/** Not available on a 'distributed' cluster. Use type: 'provisioned' or DatabaseCluster.fromExisting(). */
	withRLS(this: Database<RlsCapableKind>, context: RLSContext): Promise<RLSScopedDatabase> {
		return this.core.withRLS(context);
	}

	/** Not available on a 'distributed' cluster. Use type: 'provisioned' or DatabaseCluster.fromExisting(). */
	crud<M extends Record<string, TableTypeMeta>>(
		this: Database<RlsCapableKind>,
		options: CrudOptions<M>,
	): CrudMethods<M, (typeof options)['tables'][number]> {
		return this.core.crud(options) as unknown as CrudMethods<M, (typeof options)['tables'][number]>;
	}

	/** Local mode only. In the Lambda runtime a conflict comes from the cluster itself. */
	simulateConflict(): void {
		throw configError('simulateConflict() is only available in local mode (the mock entry point).');
	}

	/** @internal The underlying engine. Used by `createKyselyAdapter()`. */
	getEngine(): Promise<DatabaseEngine> {
		return this.core.getEngine();
	}
}

export * from './exports.js';
