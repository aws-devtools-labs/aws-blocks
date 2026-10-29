// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { join } from 'node:path';
import { type ChildLogger, Logger } from '@aws-blocks/bb-logger';
import { registerSdkIdentifiers, Scope, type ScopeParent } from '@aws-blocks/core';
import { assertNotMockInDeployedEnv, getMockDataDir } from '@aws-blocks/core/bb-utils';
import type { DatabaseEngine, SqlQuery } from '@aws-blocks/data-common';
import { DEFAULT_SCHEMA, quoteIdent } from './constants.js';
import { registerDatabase, registerUniqueId } from './core/construction.js';
import { DatabaseCore } from './core/index.js';
import { registerInternalAccess } from './core/internal.js';
import { MockEngine } from './engines/mock-engine.js';
import { sharedPgliteCluster } from './engines/pglite-cluster.js';
import { configError } from './errors.js';
import { buildMigrationPlan, lintMigrationFiles } from './migrations/plan.js';
import { loadMigrationFiles, resolveMigrationsPath, runMigrationPlan } from './migrations/runner.js';
import type {
	ClusterRef,
	ClusterType,
	DatabaseClusterOptions,
	DatabaseOptions,
	DsqlDatabaseOptions,
	OwnedDatabaseOptions,
	QueryOptions,
	Transaction,
	TransactionOptions,
} from './types.js';
import { BB_NAME, BB_VERSION } from './version.js';

assertNotMockInDeployedEnv('bb-database');

function pgliteEngine(dataDir: string, schemaName: string): DatabaseEngine {
	return sharedPgliteCluster(join(dataDir, 'pglite')).forSchema(schemaName);
}

/**
 * A cluster several `Database` blocks share, each in its own schema. `type: 'dsql'`
 * is Aurora DSQL. Part of the `Database` block, not a block on its own.
 *
 * Locally it is one PGlite under `.bb-data/{fullId}/`.
 *
 * @example
 * const shared = new DatabaseCluster(scope, 'shared', { type: 'dsql' });
 * const users  = new Database(scope, 'users',  { cluster: shared });
 * const orders = new Database(scope, 'orders', { cluster: shared });
 */
export class DatabaseCluster extends Scope {
	/** The category this cluster was constructed with. */
	readonly type: ClusterType;

	constructor(scope: ScopeParent, id: string, options: DatabaseClusterOptions) {
		super(id, { parent: scope });
		this.type = options.type;
		registerUniqueId('DatabaseCluster', id, this.fullId);
		registerSdkIdentifiers(this.fullId, { clusterEndpoint: `mock-endpoint-${this.fullId}` });
	}

	/** @internal */
	engineFor(schemaName: string): DatabaseEngine {
		return pgliteEngine(getMockDataDir(this), schemaName);
	}
}

/**
 * SQL database on PostgreSQL. Omit `cluster` and the block owns an Aurora DSQL
 * cluster; pass a {@link DatabaseCluster} to share one.
 *
 * Locally this is PGlite under `.bb-data/`, with dsql-lint and the DSQL
 * transaction limits applied when the cluster is `dsql`. Migrations in
 * `./aws-blocks/migrations/{id}` run on first use. `simulateConflict(db)` from
 * `@aws-blocks/bb-database/testing` makes the next commit fail with
 * `SerializationFailure` so retry logic can be tested without a deployed cluster.
 *
 * @example
 * import { Database, sql } from '@aws-blocks/bb-database';
 * const db = new Database(scope, 'db');
 * const user = await db.queryOne<User>(sql`SELECT id, email FROM users WHERE id = ${id}`);
 */
export class Database extends Scope {
	/** Which cluster this block runs on. */
	readonly cluster: ClusterRef;
	/** The schema this block's tables live in. */
	readonly schemaName: string;
	private readonly migrationsPath: string | undefined;

	private readonly core: DatabaseCore;
	private mock: MockEngine | null = null;
	private pendingConflict = false;
	/** @internal Logger for internal operations. Defaults to error level. */
	protected log: ChildLogger;

	/** The block owns a `dsql` cluster. */
	constructor(scope: ScopeParent, id: string, options?: OwnedDatabaseOptions);
	/** The block runs on a shared `dsql` cluster. */
	constructor(scope: ScopeParent, id: string, options: DsqlDatabaseOptions);
	constructor(scope: ScopeParent, id: string, options: DatabaseOptions = {}) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options.logger ?? new Logger(this, 'logger', { level: 'error' });
		const resolved = registerDatabase(id, this.fullId, options);
		this.cluster = resolved.ref;
		this.schemaName = resolved.schemaName;

		const dataDir = getMockDataDir(this);
		this.migrationsPath = resolveMigrationsPath(options.migrationsPath, id, this.fullId);

		const buildEngine = async (): Promise<DatabaseEngine> => {
			let inner: DatabaseEngine;
			if (!resolved.shared) {
				inner = pgliteEngine(dataDir, this.schemaName);
			} else if (resolved.shared instanceof DatabaseCluster) {
				inner = resolved.shared.engineFor(this.schemaName);
			} else {
				throw configError(
					`Database '${this.fullId}': 'cluster' must be a DatabaseCluster from the same entry point.`,
				);
			}
			const mock = new MockEngine(inner);
			if (this.pendingConflict) mock.simulateConflict();
			this.mock = mock;
			await mock.withDdl(async () => {
				if (this.migrationsPath) {
					const files = loadMigrationFiles(this.migrationsPath);
					lintMigrationFiles(files);
					const plan = buildMigrationPlan(files);
					await runMigrationPlan(mock, plan, { schemaName: this.schemaName, log: (m) => this.log.info(m) });
				} else if (this.schemaName !== DEFAULT_SCHEMA) {
					await mock.execute(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(this.schemaName)}`);
				}
			});
			return mock;
		};

		this.core = new DatabaseCore({ engine: buildEngine });
		registerInternalAccess(this, {
			engine: () => this.core.getEngine(),
			simulateConflict: () => {
				if (this.mock) this.mock.simulateConflict();
				else this.pendingConflict = true;
			},
			migrationsPath: this.migrationsPath,
		});
		registerSdkIdentifiers(this.fullId, { clusterId: resolved.clusterFullId, schemaName: this.schemaName });
	}

	/**
	 * Execute a SQL query and return all matching rows.
	 *
	 * Pass `{ schema }` (a Standard Schema: Zod, Valibot, ArkType) to derive the
	 * row type from a value and validate every row against it; without it the
	 * type argument is an unchecked assertion.
	 *
	 * @param query - A `sql` tagged template expression
	 * @param options - `schema`: validates each row and types the result
	 * @returns Array of rows; empty when nothing matches
	 * @throws {DatabaseErrors.QueryFailed} If the query fails
	 * @throws {DatabaseErrors.ResultValidationFailed} If a row does not match `schema`
	 * @example
	 * const users = await db.query<User>(sql`SELECT * FROM users WHERE active = ${true}`);
	 * @example
	 * const User = z.object({ id: z.string(), email: z.string() });
	 * const users = await db.query(sql`SELECT id, email FROM users`, { schema: User }); // { id: string; email: string }[]
	 */
	query<T>(query: SqlQuery, options?: QueryOptions<T>): Promise<T[]> {
		return this.core.query<T>(query, options);
	}

	/**
	 * Execute a SQL query and return the first row, or `null` when nothing matches.
	 *
	 * With `{ schema }` the first row is validated and the result type is the
	 * schema's output (or `null`).
	 *
	 * @param options - `schema`: validates the row and types the result
	 * @throws {DatabaseErrors.ResultValidationFailed} If the row does not match `schema`
	 * @example
	 * const user = await db.queryOne<User>(sql`SELECT * FROM users WHERE id = ${id}`);
	 * @example
	 * const user = await db.queryOne(sql`SELECT id, email FROM users WHERE id = ${id}`, { schema: User });
	 */
	queryOne<T>(query: SqlQuery, options?: QueryOptions<T>): Promise<T | null> {
		return this.core.queryOne<T>(query, options);
	}

	/**
	 * Execute a statement that modifies data and return the affected row count.
	 *
	 * @throws {DatabaseErrors.UniqueConstraintViolation} On a duplicate key (HTTP 409)
	 * @throws {DatabaseErrors.TransactionRowLimitExceeded} When one statement changes more than 3,000 rows on a `dsql` cluster
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
	 * An `ApiError` thrown inside `fn` (a 404, or the 401 from `requireAuth`) and
	 * any branded Blocks error reach the caller unchanged; the transaction still
	 * rolls back. Any other error becomes `TransactionFailed`.
	 *
	 * @throws {DatabaseErrors.TransactionFailed} If `fn` throws an error that is not an `ApiError`, a Blocks error or a database error, or the commit fails
	 * @throws {DatabaseErrors.SerializationFailure} On an unretried conflict (HTTP 409, retriable)
	 * @throws {DatabaseErrors.TransactionRowLimitExceeded} When the transaction changes more than 3,000 rows or 10 MiB on a `dsql` cluster
	 * @example
	 * await db.transaction(async (tx) => {
	 *   const row = await tx.queryOne<{ balance: number }>(sql`SELECT balance FROM accounts WHERE id = ${id} FOR UPDATE`);
	 *   await tx.execute(sql`UPDATE accounts SET balance = ${row.balance - amount} WHERE id = ${id}`);
	 * }, { retryOnConflict: true, maxRetries: 3 });
	 */
	transaction<T>(fn: (tx: Transaction) => Promise<T>, options?: TransactionOptions): Promise<T> {
		return this.core.transaction(fn, options);
	}
}

export * from './exports.js';
