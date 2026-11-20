// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { join } from 'node:path';
import { type ChildLogger, Logger } from '@aws-cdk-blocks/bb-logger';
import { registerSdkIdentifiers, Scope, type ScopeParent } from '@aws-cdk-blocks/core';
import { assertNotMockInDeployedEnv, getMockDataDir } from '@aws-cdk-blocks/core/bb-utils';
import type { SqlQuery } from './common/sql.js';
import { LOCAL_APP_ROLE } from './constants.js';
import { RulesEngine } from './dialect/rules-engine.js';
import { dataApiEngine, type RowCountingEngine } from './engines/handle.js';
import { PGLITE_SUBDIR, type SchemaEngine, sharedPgliteCluster } from './engines/pglite-cluster.js';
import { configError } from './errors.js';
import { localConnectionLabel, sourceConnectionLabel } from './external/connection.js';
import { prepareLocalSchema } from './migrations/local.js';
import { lintMigrationFiles } from './migrations/plan.js';
import { loadMigrationFiles, resolveMigrationsPath } from './migrations/runner.js';
import {
	checkLegacyClusterOptions,
	existingCluster,
	registerDatabase,
	registerUniqueId,
	resolveClusterOptions,
} from './runtime/construction.js';
import { DatabaseCore } from './runtime/index.js';
import { registerInternalAccess } from './runtime/internal.js';
import { ownerBypassesPolicies, roleDatabase, scopedDatabase } from './runtime/scoped.js';
import type {
	ClusterRef,
	ClusterType,
	DatabaseClusterOptions,
	DatabaseOptions,
	ExistingClusterOptions,
	ExistingClusterRef,
	LegacyDatabaseClusterOptions,
	QueryOptions,
	ScopedDatabase,
	Transaction,
	TransactionOptions,
} from './types.js';
import { BB_NAME, BB_VERSION } from './version.js';

assertNotMockInDeployedEnv('bb-database');

function pgliteEngine(dataDir: string, kind: ClusterType, schemaName: string): SchemaEngine {
	return sharedPgliteCluster(join(dataDir, PGLITE_SUBDIR), kind).forSchema(schemaName);
}

/**
 * A cluster several `Database` blocks share, each in its own schema. `type: 'dsql'`
 * is Aurora DSQL; `type: 'aurora'` is Aurora PostgreSQL Serverless v2 with the
 * express configuration. Part of the `Database` block, not a block on its own.
 *
 * Locally it is one PGlite under `.cdk-blocks/local/data/{fullId}/pglite/`, with DSQL's checks
 * and limits when the type is `dsql`. When the type is `aurora`, a migration can create the
 * contrib extensions that PGlite and Aurora PostgreSQL both have, such as `citext` and `pgcrypto`.
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
		this.type = resolveClusterOptions(options, this.fullId).type;
		registerUniqueId('DatabaseCluster', this, id, this.fullId);
		registerSdkIdentifiers(this.fullId, { clusterEndpoint: `mock-endpoint-${this.fullId}` });
	}

	/**
	 * Refer to a PostgreSQL database that already exists (Supabase is the tested provider) instead of
	 * provisioning a cluster. Returns a reference object; pass it as a `Database`'s `cluster`. The block
	 * creates nothing in that database and connects with the role of its connection string, so that role's
	 * privileges are the block's: a role that owns the tables is not filtered by Row Level Security policies.
	 *
	 * The connection string is never written in code. With `name`, the block reads the SSM SecureString
	 * `/<stackName>-<name>` on AWS and the value under `.cdk-blocks/local/data/` locally; `npm run db -- connect --name <name>`
	 * checks the database and stores both. With `connectionString`, the block reads your own `AppSetting`
	 * or `Secret`.
	 *
	 * The server certificate is always verified: against `ca` when given, against Node's trust store
	 * otherwise. Local mode connects to the same kind of database; it does not run migration files.
	 *
	 * With `dataApi`, the database is an Aurora PostgreSQL cluster that the block reaches through the RDS
	 * Data API: no connection string and no network path to the cluster, and the credentials stay in the
	 * Secrets Manager secret that `secretArn` names. Local mode calls the Data API with your AWS credentials.
	 *
	 * @param options - `name`, `connectionString` or `dataApi` (exactly one), and optionally `ca` (PEM text)
	 * @returns A reference object for the `cluster` option of `Database`
	 * @throws {DatabaseConfigurationError} If both or neither of `name` and `connectionString` are given,
	 *   or `ca` is not PEM text
	 * @throws {DatabaseConfigurationError} If `dataApi` is given with another source or with `ca`, or one
	 *   of its three values is missing
	 * @example
	 * import { DATABASE_CA } from './database.ca.js';
	 * const db = new Database(scope, 'db', {
	 *   cluster: DatabaseCluster.fromExisting({ name: 'db-url', ca: DATABASE_CA }),
	 * });
	 */
	static fromExisting(options: ExistingClusterOptions): ExistingClusterRef {
		return existingCluster(options);
	}

	/** @internal */
	engineFor(schemaName: string): SchemaEngine {
		return pgliteEngine(getMockDataDir(this), this.type, schemaName);
	}
}

/**
 * The Aurora cluster that `Database` of `@aws-blocks/bb-data` 0.5.0 provisioned, kept in the stack so that an
 * app can move from that block to this one without a change to the cluster. Give it the id of that `Database`
 * and the options that the `Database` had, and pass it as the `cluster` of a `Database` with a new id. The
 * new `Database` uses the tables that are in the cluster, in the `public` schema, and the `_migrations` table
 * of the earlier block.
 *
 * On AWS the block reaches the cluster through the RDS Data API, as the earlier block did. Locally the cluster
 * is one PGlite under `.cdk-blocks/local/data/{fullId}/pglite/`.
 *
 * @deprecated Only for an app that deployed `Database` of `@aws-blocks/bb-data`. It gets no new features. A
 * new app uses `DatabaseCluster`.
 *
 * @example
 * // Before: const db = new Database(scope, 'main', { minCapacity: 1, migrationsPath: './cdk-blocks/migrations' });
 * const cluster = new LegacyDatabaseCluster(scope, 'main', { minCapacity: 1 });
 * const db = new Database(scope, 'main-db', { cluster, migrationsPath: './cdk-blocks/migrations' });
 */
export class LegacyDatabaseCluster extends Scope {
	/** The engine of the cluster: Aurora PostgreSQL. */
	readonly type = 'aurora' as const;
	/** On AWS the block reaches this cluster through the RDS Data API. */
	readonly dataApi = true as const;

	constructor(scope: ScopeParent, id: string, options?: LegacyDatabaseClusterOptions) {
		super(id, { parent: scope });
		checkLegacyClusterOptions(options, this.fullId);
		registerUniqueId('DatabaseCluster', this, id, this.fullId);
	}

	/** @internal */
	engineFor(schemaName: string): SchemaEngine {
		return pgliteEngine(getMockDataDir(this), this.type, schemaName);
	}
}

/**
 * SQL database on PostgreSQL. Omit `cluster` and the block owns an Aurora DSQL
 * cluster; pass a {@link DatabaseCluster} to share one.
 *
 * Locally this is PGlite under `.cdk-blocks/local/data/`, with dsql-lint and the DSQL
 * transaction limits applied when the cluster is `dsql`. Migrations in
 * `./cdk-blocks/migrations/{id}` run on first use. `simulateConflict(db)` from
 * `@aws-cdk-blocks/bb-database/testing` makes the next commit fail with
 * `SerializationFailure` so retry logic can be tested without a deployed cluster.
 *
 * @example
 * import { Database, sql } from '@aws-cdk-blocks/bb-database';
 * const db = new Database(scope, 'db');
 * const user = await db.queryOne<User>(sql`SELECT id, email FROM users WHERE id = ${id}`);
 */
export class Database extends Scope {
	/** Which cluster this block runs on. */
	readonly cluster: ClusterRef;
	/** The schema this block's tables live in. */
	readonly schemaName: string;
	/** On a `LegacyDatabaseCluster` the statements run as the user that owns the tables. */
	private readonly ownerRunsStatements: boolean;
	private readonly migrationsPath: string | undefined;

	private readonly core: DatabaseCore;
	private mock: RulesEngine | null = null;
	private pendingConflict = false;
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
		this.cluster = resolved.ref;
		this.schemaName = resolved.schemaName;
		this.ownerRunsStatements = resolved.shared?.dataApi === true;

		this.migrationsPath = resolveMigrationsPath(options.migrationsPath, id, this.fullId);

		let engine: () => Promise<RowCountingEngine>;
		let simulateConflict: () => void;
		if (resolved.external) {
			const external = resolved.external;
			// An existing database is the real one locally too: its schema, roles and data cannot be rebuilt
			// from files. Migration files are not run from here; a deploy or `npm run db migrate` runs them.
			// The driver and the settings store are loaded here, so an app without one never loads them.
			engine = async () => {
				if (external.dataApi) return dataApiEngine(external.dataApi);
				const [{ externalEngineFrom }, { localConnectionSetting }] = await Promise.all([
					import('./external/engine.js'),
					import('./external/local-store.js'),
				]);
				return externalEngineFrom(
					external.connectionString ?? localConnectionSetting(external.name ?? ''),
					external.name ? localConnectionLabel(external.name) : sourceConnectionLabel(this.fullId),
					{ ca: external.ca, schemaName: this.schemaName },
				);
			};
			simulateConflict = () => {
				throw configError(
					'simulateConflict() needs the local PGlite database; an existing database is the real one.',
				);
			};
		} else {
			const kind = resolved.ref.kind;
			const shared = resolved.shared;
			const dataDir = getMockDataDir(this);
			// At construction so a bad file stops `npm run dev`, not the first request; the engine lints again
			// (a cache hit) in case a file changed after startup.
			if (this.migrationsPath) lintMigrationFiles(loadMigrationFiles(this.migrationsPath), resolved.fileKind);

			engine = async () => {
				let inner: SchemaEngine;
				if (!shared) {
					inner = pgliteEngine(dataDir, kind, this.schemaName);
				} else if (shared instanceof DatabaseCluster || shared instanceof LegacyDatabaseCluster) {
					inner = shared.engineFor(this.schemaName);
				} else {
					throw configError(
						`Database '${this.fullId}': 'cluster' must be a DatabaseCluster from the same entry point.`,
					);
				}
				// A first statement inside another block's transaction() callback nests this migration run in that
				// transaction (DESIGN §4.1); if it rolls back, the schema goes with it and the engine is built again. A
				// simulateConflict() between the rollback and the rebuild must arm the rebuilt engine, not this one.
				inner.cluster.enclosingTransaction()?.onRollback(() => {
					this.mock = null;
					this.core.invalidateEngine();
				});
				const mock = new RulesEngine(inner, kind);
				const applied = await prepareLocalSchema(mock, inner, {
					kind,
					fileKind: resolved.fileKind,
					schemaName: this.schemaName,
					migrationsPath: this.migrationsPath,
					log: (m) => this.log.info(m),
				});
				// Visible in `npm run dev` without a logger: which files ran, into which schema, and where the data is.
				if (applied.length > 0) {
					console.log(
						`[bb-database] ${this.fullId}: applied ${applied.join(', ')} to schema "${this.schemaName}" (${dataDir})`,
					);
				}
				// Armed only now: a simulateConflict() called before the first statement is for the app's next
				// transaction, not for the migration run's own commits, which would consume it and fail the build.
				this.mock = mock;
				if (this.pendingConflict) {
					this.pendingConflict = false;
					mock.simulateConflict();
				}
				return mock;
			};
			simulateConflict = () => {
				if (this.mock) this.mock.simulateConflict();
				else this.pendingConflict = true;
			};
		}

		this.core = new DatabaseCore({ engine });
		registerInternalAccess(this, {
			engine: () => this.core.getEngine(),
			session: () => this.core.session(),
			simulateConflict,
			migrationsPath: this.migrationsPath,
		});
		registerSdkIdentifiers(this.fullId, {
			clusterId: resolved.clusterFullId,
			schemaName: this.schemaName,
			// The role the block's statements run as, on a cluster the block provisions: locally the one plain role
			// of every PGlite. An existing database and a LegacyDatabaseCluster run as the role of their connection.
			...(resolved.external || this.ownerRunsStatements ? {} : { roleName: LOCAL_APP_ROLE }),
		});
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
	 * callback when the commit hits a serialization conflict. The block waits a
	 * random time before each re-run; `TransactionOptions` has the wait and the
	 * number of retries.
	 *
	 * An `ApiError` thrown inside `fn` (a 404, or the 401 from `requireAuth`) and
	 * any branded CDK Blocks error reach the caller unchanged; the transaction still
	 * rolls back. Any other error becomes `TransactionFailed`.
	 *
	 * @throws {DatabaseErrors.TransactionFailed} If `fn` throws an error that is not an `ApiError`, a CDK Blocks error or a database error, or the commit fails
	 * @throws {DatabaseErrors.SerializationFailure} On an unretried conflict (HTTP 409, retriable)
	 * @throws {DatabaseErrors.TransactionRowLimitExceeded} When the transaction changes more than 3,000 rows or 10 MiB on a `dsql` cluster
	 * @example
	 * await db.transaction(async (tx) => {
	 *   const row = await tx.queryOne<{ balance: number }>(sql`SELECT balance FROM accounts WHERE id = ${id} FOR UPDATE`);
	 *   await tx.execute(sql`UPDATE accounts SET balance = ${row.balance - amount} WHERE id = ${id}`);
	 * }, { retryOnConflict: true });
	 */
	transaction<T>(fn: (tx: Transaction) => Promise<T>, options?: TransactionOptions): Promise<T> {
		return this.core.transaction(fn, options);
	}

	/**
	 * This block with every statement run as `user`, for tables with Row Level
	 * Security on an `aurora` cluster. Each transaction on the result starts by
	 * setting `request.jwt.claims` to `{ ...claims, sub: user.userId }`, for that
	 * transaction only; a policy reads it with
	 * `current_setting('request.jwt.claims', true)::jsonb`. A single statement
	 * runs in a transaction of its own.
	 *
	 * The call does not turn Row Level Security on: a table without
	 * `ENABLE ROW LEVEL SECURITY` and a policy returns every row to every user. A
	 * statement on the block itself carries no user, so a policy that compares a
	 * column with `sub` gives it no rows.
	 *
	 * @param user - The signed-in user: pass the result of `auth.requireAuth(context)`. Only `userId` is read
	 * @param claims - More claims for policies to read, such as `{ org_id }`. `sub` is always the user id
	 * @returns A `ScopedDatabase` with `query`, `queryOne`, `execute` and `transaction`; pass it to `DatabaseDialect` for Kysely
	 * @throws {DatabaseConfigurationError} On a `dsql` cluster, which has no Row Level Security
	 * @throws {DatabaseErrors.PermissionDenied} From a statement that a policy refuses (HTTP 403)
	 * @example
	 * const user = await auth.requireAuth(context);
	 * const notes = await db.asUser(user).query<Note>(sql`SELECT id, body FROM notes`);
	 */
	asUser(user: { userId: string }, claims?: Record<string, unknown>): ScopedDatabase {
		if (this.ownerRunsStatements) throw ownerBypassesPolicies(this.fullId);
		return scopedDatabase(this, user, claims);
	}

	/**
	 * The block with every statement run as a database role, for Row Level Security policies that are
	 * written for a role (`CREATE POLICY … TO authenticated`). Each transaction on the returned object
	 * starts with `SET LOCAL ROLE` to `role` and sets `request.jwt.claims` to `claims`, both for that
	 * transaction only; a single statement gets a transaction of its own. Nothing stays on the connection.
	 *
	 * Use it when the connection role owns the tables, as on an existing database: PostgreSQL does not
	 * apply policies to a table's owner, so `asUser()` alone does not filter there. The connection role
	 * must be a member of `role`. The claims are yours, unchanged: pass the `sub` and any other value your
	 * policies read. Only your server code sets them, so take them from a verified session.
	 *
	 * @param role - The database role to run as, such as `'authenticated'` or `'anon'`
	 * @param claims - The value of `request.jwt.claims` for the transaction. Default `{}`
	 * @returns A `ScopedDatabase` with `query`, `queryOne`, `execute` and `transaction`; pass it to `DatabaseDialect` for Kysely
	 * @throws {DatabaseConfigurationError} On a `dsql` cluster, or when the connection role cannot switch to `role`
	 * @throws {DatabaseErrors.PermissionDenied} From a statement that a policy refuses (HTTP 403)
	 * @example
	 * const user = await auth.requireAuth(context);
	 * const todos = await db.asRole('authenticated', { sub: user.userId }).query<Todo>(sql`SELECT id, title FROM todos`);
	 */
	asRole(role: string, claims?: Record<string, unknown>): ScopedDatabase {
		return roleDatabase(this, role, claims);
	}
}

export * from './exports.js';
