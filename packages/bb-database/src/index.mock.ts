// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { join } from 'node:path';
/**
 * Local development entry point (`npm run dev`, tests).
 *
 * Every cluster is a PGlite (WASM PostgreSQL) on disk under `.bb-data/`, one
 * instance per cluster with one schema per block. A `distributed` cluster adds
 * the Aurora DSQL validation layer so unsupported SQL fails here, not in
 * production. `fromExisting()` connects straight to the external database.
 */
import { type ChildLogger, Logger } from '@aws-blocks/bb-logger';
import { registerSdkIdentifiers, Scope, type ScopeParent } from '@aws-blocks/core';
import { getMockDataDir } from '@aws-blocks/core/bb-utils';
import type { DatabaseEngine, SqlQuery, Transaction } from '@aws-blocks/data-common';
import { enforceLocalBinding } from './bindings.js';
import { externalCluster, resolveCluster } from './cluster-ref.js';
import { DEFAULT_CLUSTER_ID, quoteIdent } from './constants.js';
import type { CrudMethods, CrudOptions, TableTypeMeta } from './crud/types.js';
import { DatabaseCore } from './database-core.js';
import { MockEngine } from './engines/mock-engine.js';
import { PgClientEngine } from './engines/pg-client-engine.js';
import { sharedPgliteCluster } from './engines/pglite-cluster.js';
import { configError } from './errors.js';
import { buildMigrationPlan } from './migrations/plan.js';
import { loadMigrationFiles, resolveMigrationsPath, runMigrationPlan } from './migrations/runner.js';
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
	ExternalSslOptions,
	KindOf,
	OwnedDatabaseOptions,
	ProvisionedDatabaseOptions,
	RlsCapableKind,
	RlsDatabaseOptions,
	TransactionOptions,
} from './types.js';
import { BB_NAME, BB_VERSION } from './version.js';

/**
 * A cluster several `Database` blocks share, each in its own schema. Pick a
 * category, not a service: `distributed` (Aurora DSQL) or `provisioned`
 * (Aurora Serverless v2). Part of the `Database` block, not a block on its own.
 *
 * Locally it is one PGlite under `.bb-data/{fullId}/`; capacity options are ignored.
 *
 * @example
 * const main = new DatabaseCluster(scope, 'main', { type: 'provisioned', minCapacity: 0.5 });
 * const users  = new Database(scope, 'users',  { cluster: main });
 * const orders = new Database(scope, 'orders', { cluster: main });
 */
export class DatabaseCluster<T extends ClusterType = ClusterType> extends Scope {
	/** The category this cluster was constructed with. */
	readonly type: T;
	/** Same as `type`; the common discriminant with `fromExisting()` values. */
	readonly kind: T;

	constructor(scope: ScopeParent, id: string, options: { type: T } & ClusterOptionsOf<T>) {
		// Plain scope: the cluster is part of the Database block, not a block itself.
		super(id, { parent: scope });
		this.type = options.type;
		this.kind = options.type;
		registerUniqueId('DatabaseCluster', id, this.fullId);
		registerSdkIdentifiers(
			this.fullId,
			options.type === 'distributed'
				? { clusterEndpoint: `mock-endpoint-${this.fullId}` }
				: {
						clusterArn: `mock-cluster-${this.fullId}`,
						secretArn: `mock-secret-${this.fullId}`,
						databaseName: this.fullId,
					},
		);
	}

	/**
	 * Reference a PostgreSQL you already have. Returns a plain value to pass as a
	 * `Database`'s `cluster`; several blocks may share it, each in its own schema.
	 *
	 * @example
	 * const supabase = DatabaseCluster.fromExisting({
	 *   connectionString: process.env.DATABASE_URL ?? '',
	 *   ssl: { ca: process.env.DATABASE_CA_CERT },
	 * });
	 * const db = new Database(scope, 'db', { cluster: supabase, schemaName: 'public' });
	 */
	static fromExisting(ref: ExternalClusterRef): ExternalCluster {
		return externalCluster(ref);
	}

	/** @internal The per-block engine on this cluster's shared PGlite. */
	engineFor(schemaName: string): DatabaseEngine {
		return sharedPgliteCluster(join(getMockDataDir(this), 'pglite')).forSchema(schemaName);
	}
}

/**
 * SQL database on PostgreSQL. Omit `cluster` and the block owns an Aurora DSQL
 * cluster; pass a {@link DatabaseCluster} to share one, or
 * `DatabaseCluster.fromExisting()` for a database you already have.
 *
 * Locally this is PGlite under `.bb-data/`, with the DSQL validation layer when
 * the cluster is `distributed`. Migrations in `./aws-blocks/migrations/{id}`
 * run on first use. `simulateConflict()` makes the next commit fail with
 * `SerializationFailure` so retry logic can be tested on every kind.
 *
 * @example
 * import { Database, sql } from '@aws-blocks/bb-database';
 * const db = new Database(scope, 'db');
 * const user = await db.queryOne<User>(sql`SELECT id, email FROM users WHERE id = ${id}`);
 */
export class Database<K extends ClusterKind = 'distributed'> extends Scope {
	/** Which cluster this block runs on. Anchors `K`. */
	readonly cluster: ClusterRef<K>;
	/** The schema this block's tables live in. */
	readonly schemaName: string;
	/** The resolved migrations directory, or `undefined` when the block has none. */
	readonly migrationsPath: string | undefined;

	private readonly core: DatabaseCore;
	private mock: MockEngine | null = null;
	private pendingConflict = false;
	/** @internal Logger for internal operations. Defaults to error level. */
	protected log: ChildLogger;

	/** The block owns a `distributed` cluster. */
	constructor(scope: ScopeParent, id: string, options?: OwnedDatabaseOptions);
	/** The block runs on a shared `provisioned` cluster. */
	constructor(scope: ScopeParent, id: string, options: ProvisionedDatabaseOptions & { cluster: KindOf<K> });
	/** The block runs on a PostgreSQL you already have. */
	constructor(scope: ScopeParent, id: string, options: ExternalDatabaseOptions & { cluster: KindOf<K> });
	/** The block runs on a shared `distributed` cluster. */
	constructor(scope: ScopeParent, id: string, options: DistributedDatabaseOptions & { cluster: KindOf<K> });
	/** The cluster's kind is only known as a union: the conservative surface, without `withRLS()` / `crud()`. */
	constructor(scope: ScopeParent, id: string, options: AnyClusterDatabaseOptions & { cluster: KindOf<K> });
	constructor(scope: ScopeParent, id: string, options: DatabaseOptions = {}) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options.logger ?? new Logger(this, 'logger', { level: 'error' });
		registerUniqueId('Database', id, this.fullId);

		const resolved = resolveCluster(id, this.fullId, options);
		this.cluster = resolved.ref as ClusterRef<K>;
		this.schemaName = resolved.schemaName;
		const clusterKey = resolved.owned
			? this.fullId
			: resolved.external
				? externalKey(resolved.external)
				: resolved.ref.id;
		registerSchema(clusterKey, this.schemaName, this.fullId);

		const dataDir = getMockDataDir(this);
		enforceLocalBinding(dataDir, this.fullId, id, { cluster: resolved.ref.id, type: resolved.ref.kind });
		this.migrationsPath = resolveMigrationsPath(options.migrationsPath, id, this.fullId);

		const schema = 'schema' in options ? (options as RlsDatabaseOptions).schema : undefined;
		const kind = resolved.ref.kind;

		const buildEngine = async (): Promise<DatabaseEngine> => {
			let inner: DatabaseEngine;
			if (resolved.owned) {
				inner = sharedPgliteCluster(join(dataDir, 'pglite')).forSchema(this.schemaName);
			} else if (resolved.external) {
				inner = await externalEngine(resolved.external, this.schemaName);
			} else if (resolved.shared instanceof DatabaseCluster) {
				inner = resolved.shared.engineFor(this.schemaName);
			} else {
				throw configError(
					`Database '${this.fullId}': 'cluster' must be a DatabaseCluster from the same entry point or DatabaseCluster.fromExisting().`,
				);
			}
			const mock = new MockEngine(inner, { dialect: kind === 'distributed' ? 'distributed' : 'postgres' });
			if (this.pendingConflict) mock.simulateConflict();
			this.mock = mock;
			await mock.withDdl(async () => {
				if (this.migrationsPath) {
					const plan = buildMigrationPlan(loadMigrationFiles(this.migrationsPath), kind);
					await runMigrationPlan(mock, plan, { schemaName: this.schemaName, log: (m) => this.log.info(m) });
				} else if (this.schemaName !== 'public') {
					await mock.execute(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(this.schemaName)}`);
				}
			});
			return mock;
		};

		this.core = new DatabaseCore({ kind, engine: buildEngine, schema, fullId: this.fullId });
		registerSdkIdentifiers(this.fullId, {
			clusterId: resolved.ref.id === DEFAULT_CLUSTER_ID ? this.fullId : resolved.ref.id,
			schemaName: this.schemaName,
		});
	}

	/**
	 * Execute a SQL query and return all matching rows.
	 *
	 * @param query - A `sql` tagged template expression
	 * @returns Array of rows; empty when nothing matches
	 * @throws {DatabaseErrors.QueryFailed} If the query fails
	 * @example
	 * const users = await db.query<User>(sql`SELECT * FROM users WHERE active = ${true}`);
	 */
	query<T>(query: SqlQuery): Promise<T[]> {
		return this.core.query<T>(query);
	}

	/**
	 * Execute a SQL query and return the first row, or `null` when nothing matches.
	 *
	 * @example
	 * const user = await db.queryOne<User>(sql`SELECT * FROM users WHERE id = ${id}`);
	 */
	queryOne<T>(query: SqlQuery): Promise<T | null> {
		return this.core.queryOne<T>(query);
	}

	/**
	 * Execute a statement that modifies data and return the affected row count.
	 *
	 * @throws {DatabaseErrors.UniqueConstraintViolation} On a duplicate key (HTTP 409)
	 * @example
	 * const { rowCount } = await db.execute(sql`INSERT INTO users (email) VALUES (${email})`);
	 */
	execute(query: SqlQuery): Promise<{ rowCount: number }> {
		return this.core.execute(query);
	}

	/**
	 * Run `fn` inside a transaction. Commits when it resolves, rolls back when it
	 * throws. Pass `{ retryOnConflict: true }` to re-run a side-effect-free
	 * callback when the commit hits a serialization conflict.
	 *
	 * @throws {DatabaseErrors.TransactionFailed} If `fn` throws a non-database error or the commit fails
	 * @throws {DatabaseErrors.SerializationFailure} On an unretried conflict (HTTP 409, retriable)
	 * @example
	 * await db.transaction(async (tx) => {
	 *   const row = await tx.queryOne<{ balance: number }>(sql`SELECT balance FROM accounts WHERE id = ${id} FOR UPDATE`);
	 *   await tx.execute(sql`UPDATE accounts SET balance = ${row.balance - amount} WHERE id = ${id}`);
	 * }, { retryOnConflict: true, maxRetries: 3 });
	 */
	transaction<T>(fn: (tx: Transaction) => Promise<T>, options?: TransactionOptions): Promise<T> {
		return this.core.transaction(fn, options);
	}

	/**
	 * Return a database scoped with Row Level Security context: every query runs
	 * inside a transaction with `SET LOCAL ROLE` and `request.jwt.claims` set.
	 *
	 * Not available on a 'distributed' cluster. Use type: 'provisioned' or DatabaseCluster.fromExisting().
	 *
	 * @example
	 * const scoped = await db.withRLS({ userId: user.userId });
	 * const mine = await scoped.query<Post>(sql`SELECT * FROM posts`);
	 */
	withRLS(this: Database<RlsCapableKind>, context: RLSContext): Promise<RLSScopedDatabase> {
		return this.core.withRLS(context);
	}

	/**
	 * Generate typed CRUD handlers (list/get/create/update/delete) for the given
	 * tables. Requires `schema` metadata in the constructor; every operation runs
	 * through `withRLS()`.
	 *
	 * Not available on a 'distributed' cluster. Use type: 'provisioned' or DatabaseCluster.fromExisting().
	 */
	crud<M extends Record<string, TableTypeMeta>>(
		this: Database<RlsCapableKind>,
		options: CrudOptions<M>,
	): CrudMethods<M, (typeof options)['tables'][number]> {
		return this.core.crud(options) as unknown as CrudMethods<M, (typeof options)['tables'][number]>;
	}

	/**
	 * Test helper (local mode only): make the next commit raise
	 * `SerializationFailure`, on every kind of cluster, so retry logic can be
	 * exercised without a deployed DSQL cluster.
	 */
	simulateConflict(): void {
		if (this.mock) this.mock.simulateConflict();
		else this.pendingConflict = true;
	}

	/** @internal The underlying engine. Used by `createKyselyAdapter()`. */
	getEngine(): Promise<DatabaseEngine> {
		return this.core.getEngine();
	}
}

/** Stable key per `fromExisting()` value for the schema-collision check. */
const externalKeys = new WeakMap<ExternalCluster, string>();
let externalCounter = 0;
function externalKey(cluster: ExternalCluster): string {
	let key = externalKeys.get(cluster);
	if (!key) {
		key = `external#${++externalCounter}`;
		externalKeys.set(cluster, key);
	}
	return key;
}

/** Warn at most once per process that an external connection omitted `ssl`. */
let warnedMockSslOmitted = false;

/** Locally, an omitted `ssl` means unverified (the deployed runtime verifies); warn once. */
function mockExternalSsl(ssl: ExternalSslOptions | undefined): ExternalSslOptions {
	if (ssl) return ssl;
	if (!warnedMockSslOmitted) {
		warnedMockSslOmitted = true;
		console.warn(
			'[bb-database] DB TLS (local dev): this external connection has no `ssl` set, so it connects WITHOUT ' +
				'certificate verification locally, but the deployed runtime verifies by default. Pin your provider CA ' +
				'via `ssl: { ca }` (or set `ssl: { rejectUnauthorized: false }` explicitly) so local and deploy behave the same.',
		);
	}
	return { rejectUnauthorized: false };
}

async function externalEngine(cluster: ExternalCluster, schemaName: string): Promise<DatabaseEngine> {
	const ref = cluster.ref;
	if (!('connectionString' in ref)) {
		throw configError(
			'Local mode cannot reach an Aurora cluster through the RDS Data API. Use fromExisting({ connectionString }) ' +
				'for local development, or run against a sandbox.',
		);
	}
	const connectionString =
		typeof ref.connectionString === 'string' ? ref.connectionString : await ref.connectionString.get();
	return new PgClientEngine({
		connectionString,
		ssl: mockExternalSsl(ref.ssl),
		searchPath: schemaName !== 'public' ? schemaName : undefined,
	});
}

export * from './exports.js';
