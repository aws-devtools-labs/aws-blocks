// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildLogger } from '@aws-cdk-blocks/bb-logger';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { SqlQuery } from './common/sql.js';

/**
 * The categories of cluster a {@link DatabaseCluster} can provision.
 *
 * - `dsql`: Aurora DSQL. Scales to zero, no VPC, optimistic concurrency.
 *   Runs most of PostgreSQL, including foreign keys, views, sequences, identity
 *   columns and JSONB. It lacks triggers, PL/pgSQL, extensions and Row Level
 *   Security, and limits a transaction to 3,000 changed rows and 10 MiB.
 * - `aurora`: Aurora PostgreSQL Serverless v2, created with the express
 *   configuration: all of PostgreSQL (triggers, PL/pgSQL, extensions, Row Level
 *   Security, transactions of any size), created in seconds, scales to zero,
 *   reached over its public endpoint with IAM authentication. No VPC.
 *   Locally, PGlite creates the contrib extensions that both it and Aurora
 *   have (`citext`, `pgcrypto`, `pg_trgm`, `hstore`, `uuid-ossp` and more; the
 *   README's Local mode section lists them). One it lacks, such as `vector`,
 *   fails locally.
 *
 * The value names the engine, so every stop and limit can say which database
 * it comes from.
 */
export type ClusterType = 'dsql' | 'aurora';

/**
 * Every kind of cluster a `Database` can run on: the two a {@link DatabaseCluster}
 * provisions, and `external`, an existing PostgreSQL database that
 * `DatabaseCluster.fromExisting()` refers to. The block provisions nothing for
 * `external` and connects with the role of its connection string.
 */
export type ClusterKind = ClusterType | 'external';

/**
 * Where the connection string of an existing database comes from: an
 * `AppSetting` with `secret: true`, a `Secret`, or any object with the same
 * `get()`. The value is a `postgres://` or `postgresql://` URL.
 */
export interface ConnectionStringSource {
	get(): Promise<string | null>;
}

/**
 * Where the RDS Data API finds an Aurora PostgreSQL cluster. The block then
 * sends each statement as an HTTPS call to the Data API and opens no
 * connection, so the cluster can stay in a VPC with no path to it. The cluster
 * must have the Data API (its HTTP endpoint) enabled.
 */
export interface DataApiOptions {
	/** The ARN of the Aurora cluster. */
	clusterArn: string;
	/**
	 * The ARN of the Secrets Manager secret that holds the database user name
	 * and password. The statements run as that user.
	 */
	secretArn: string;
	/** The name of the database in the cluster. */
	database: string;
}

/**
 * Options for `DatabaseCluster.fromExisting()`. Give exactly one of `name`,
 * `connectionString` and `dataApi`.
 */
export interface ExistingClusterOptions {
	/**
	 * A short name for the connection string. On AWS the block reads the SSM
	 * SecureString `/<stackName>-<name>`, so each stage has its own value;
	 * `npm run db -- connect --name <name> --stage <stage>` stores it. In local
	 * mode the block reads the value that `npm run db -- connect --name <name>`
	 * stored under `.cdk-blocks/local/data/`.
	 */
	name?: string;
	/**
	 * Your own store for the connection string, for an app that manages the
	 * value itself: an `AppSetting` with `secret: true` or a `Secret`. The block
	 * calls `get()` when it opens its first connection.
	 */
	connectionString?: ConnectionStringSource;
	/**
	 * An Aurora PostgreSQL cluster that the block reaches through the RDS Data
	 * API, with no connection string. The block's schema is `public`. A result
	 * is limited to 1 MB, and a `Date` or an object goes to the server as text,
	 * so a statement that writes one to a `timestamptz` or `jsonb` column casts
	 * the parameter.
	 */
	dataApi?: DataApiOptions;
	/**
	 * The certificate authority that signed the server certificate, as PEM
	 * text. Needed when the provider uses its own authority (Supabase). Without
	 * it Node's trust store applies. The server certificate is always verified;
	 * there is no option that turns verification off. Not used with `dataApi`.
	 */
	ca?: string;
}

/**
 * The reference `DatabaseCluster.fromExisting()` returns: a plain value that
 * names an existing PostgreSQL database. Pass it as a `Database`'s `cluster`.
 */
export interface ExistingClusterRef {
	readonly __brand: 'ExistingClusterRef';
	readonly type: 'external';
	readonly name?: string;
	readonly connectionString?: ConnectionStringSource;
	readonly dataApi?: DataApiOptions;
	readonly ca?: string;
}

/**
 * The structural shape of a `DatabaseCluster<T>` as a `Database` constructor
 * sees it. Lets `types.ts` stay free of class imports while still narrowing the
 * `cluster` option by cluster type.
 */
export interface DatabaseClusterLike {
	/** The category this cluster was constructed with. */
	readonly type: ClusterType;
	/** The cluster's scoped id; drives resource naming. */
	readonly fullId: string;
	/**
	 * Set on a `LegacyDatabaseCluster`: on AWS the block reaches the cluster
	 * through the RDS Data API, and its schema is `public`.
	 */
	readonly dataApi?: true;
}

/**
 * Where a `LegacyDatabaseCluster` places its cluster when the app runs in a
 * VPC that you provide. Set at most one of `subnetType`, `subnetGroupName` and
 * `subnetIds`.
 */
export interface LegacySubnetSelection {
	/** Select all subnets of the given tier. */
	subnetType?: 'isolated' | 'private-with-egress' | 'public';
	/** Restrict the selection to these Availability Zones. */
	availabilityZones?: string[];
	/** Return at most one subnet per Availability Zone. */
	onePerAz?: boolean;
	/** Select a named subnet group of the VPC. */
	subnetGroupName?: string;
	/** Select individual subnets by id. */
	subnetIds?: string[];
}

/**
 * Options of a `LegacyDatabaseCluster`: the options of `Database` in
 * `@aws-blocks/bb-data` 0.5.0 that shaped its Aurora cluster. Give each one
 * the value that the `Database` had. A different value changes the deployed
 * cluster, and some changes replace it.
 */
export interface LegacyDatabaseClusterOptions {
	/** Minimum capacity in Aurora Capacity Units. Default `0.5`. */
	minCapacity?: number;
	/** Maximum capacity in Aurora Capacity Units. Default `2`. */
	maxCapacity?: number;
	/** Database name. Default: the cluster's full id, with `_` for every other character. */
	databaseName?: string;
	/**
	 * CloudFormation removal policy for the cluster. When omitted, the
	 * stack-wide `defaults` apply: `production` retains, `sandbox` destroys.
	 */
	removalPolicy?: 'destroy' | 'retain' | 'snapshot';
	/** Aurora PostgreSQL engine version, for example `'16.13'`. Default `'16.13'`. */
	postgresVersion?: string;
	/** Where the cluster is placed in a VPC that you provide. */
	subnets?: LegacySubnetSelection;
	/**
	 * ARN of a customer managed KMS key for the cluster's storage and for its
	 * credentials secret.
	 */
	storageEncryptionKeyArn?: string;
	/**
	 * Retention of the cluster's automated backups, which is also its
	 * point-in-time recovery window. `true` is 15 days, `false` is the 1-day
	 * minimum, and `{ retentionDays }` is an integer from 1 to 35. When
	 * omitted, the stack-wide `defaults.pointInTimeRecovery` applies.
	 */
	pointInTimeRecovery?: boolean | { retentionDays: number };
}

/**
 * The descriptor a `Database` exposes as `db.cluster`. It is a plain value, so
 * a handler can return it to the client and the runtime can branch on `kind`
 * without trusting the type parameter.
 */
export interface ClusterRef {
	/** Which kind of cluster the block runs on. */
	readonly kind: ClusterKind;
	/**
	 * `'default'` when the block owns its cluster, `'external'` for an existing database,
	 * otherwise the `DatabaseCluster`'s full id.
	 */
	readonly id: string;
}

/** Options for a `dsql` (Aurora DSQL) cluster. */
export interface DsqlClusterOptions {
	type: 'dsql';
	/**
	 * CloudFormation removal policy for the cluster. When omitted the stack-wide
	 * defaults apply: production clusters retain with deletion protection on,
	 * sandbox clusters destroy. Most apps never set this.
	 */
	removalPolicy?: 'retain' | 'destroy';
}

/** Options for an `aurora` (Aurora PostgreSQL Serverless v2, express configuration) cluster. */
export interface AuroraClusterOptions {
	type: 'aurora';
	/**
	 * The smallest capacity the cluster scales down to, in Aurora Capacity Units
	 * (ACUs, 0.5 ACU steps). `0` lets the cluster pause after five idle minutes
	 * and costs nothing while paused; the first connection after a pause takes
	 * longer. Default `0`.
	 */
	minCapacity?: number;
	/**
	 * The largest capacity the cluster scales up to, in ACUs (1 to 256, in 0.5 steps).
	 * Default `2`. Can be raised in place; no cluster replacement.
	 */
	maxCapacity?: number;
	/**
	 * CloudFormation removal policy for the cluster. `snapshot` takes a final
	 * snapshot before deleting it. When omitted the stack-wide defaults apply:
	 * production clusters retain with deletion protection on, sandbox clusters
	 * destroy. Most apps never set this.
	 */
	removalPolicy?: 'retain' | 'destroy' | 'snapshot';
	/**
	 * Automated backups, which are Aurora's point-in-time recovery window. `true`
	 * keeps 15 days, `{ retentionDays }` pins the window (1 to 35), `false` keeps the
	 * one day the service always keeps. When omitted the stack-wide
	 * `defaults.pointInTimeRecovery` applies: on in production, off in a sandbox.
	 */
	pointInTimeRecovery?: boolean | { retentionDays: number };
}

/** Constructor options for a `DatabaseCluster`, narrowed by `type`. */
export type DatabaseClusterOptions = DsqlClusterOptions | AuroraClusterOptions;

/** Options every `Database` block accepts, whichever cluster it runs on. */
export interface DatabaseBlockOptions {
	/**
	 * Directory of `.sql` migration files for this block, relative to the project
	 * root. Defaults to `./cdk-blocks/migrations/{id}`, which may be absent; an
	 * explicit path must exist.
	 */
	migrationsPath?: string;
	/**
	 * The PostgreSQL schema this block's tables live in. `public` when the block
	 * owns its cluster, otherwise the block id as a PostgreSQL identifier (lower-cased,
	 * `_` for other characters). Two blocks on one cluster may not share a schema.
	 */
	schemaName?: string;
	/** Optional logger for internal operations. Defaults to an error-level Logger. */
	logger?: ChildLogger;
}

/** Options for a `Database` that owns its cluster (no `cluster`). The owned cluster is `dsql`. */
export interface OwnedDatabaseOptions extends DatabaseBlockOptions {
	cluster?: undefined;
	/**
	 * Removal policy of the owned cluster. Only valid when `cluster` is omitted;
	 * with a shared cluster the policy lives on the `DatabaseCluster`.
	 */
	removalPolicy?: 'retain' | 'destroy';
}

/** Options for a `Database` on a shared `DatabaseCluster`, of either type. */
export interface SharedDatabaseOptions extends DatabaseBlockOptions {
	cluster: DatabaseClusterLike;
}

/**
 * Options for a `Database` on an existing PostgreSQL database. The block's schema is `public`
 * unless `schemaName` names another one.
 */
export interface ExistingDatabaseOptions extends DatabaseBlockOptions {
	cluster: ExistingClusterRef;
}

/** Every options shape a `Database` constructor accepts. */
export type DatabaseOptions = OwnedDatabaseOptions | SharedDatabaseOptions | ExistingDatabaseOptions;

/**
 * Options for `query()` and `queryOne()`, on a `Database` and on the `tx` a
 * `transaction()` callback receives.
 */
export interface QueryOptions<T> {
	/**
	 * A [Standard Schema](https://standardschema.dev) (Zod, Valibot, ArkType, or
	 * your own) that every returned row is validated against. The method's result
	 * type is the schema's output type, so no type argument is needed, and a row
	 * that does not match throws `DatabaseErrors.ResultValidationFailed` instead
	 * of reaching a handler as the wrong shape. The schema's output is what comes
	 * back, so a transform or default applies. The first issue's path and message
	 * are in the error message, which reaches the client; keep custom refinement
	 * messages free of row values.
	 *
	 * @example
	 * ```ts
	 * const Customer = z.object({ id: z.string(), email: z.string() });
	 * const customers = await shop.query(sql`SELECT id, email FROM customers`, { schema: Customer });
	 * // customers: { id: string; email: string }[]
	 * ```
	 */
	schema?: StandardSchemaV1<unknown, T>;
}

/**
 * The handle a `transaction()` callback receives. Every call runs inside the
 * open transaction; the methods mirror `Database.query`, `queryOne` and
 * `execute`, including the `schema` option.
 */
export interface Transaction {
	/** Run a query inside this transaction and return every row. */
	query<T>(query: SqlQuery, options?: QueryOptions<T>): Promise<T[]>;
	/** Run a query inside this transaction and return the first row, or `null`. */
	queryOne<T>(query: SqlQuery, options?: QueryOptions<T>): Promise<T | null>;
	/** Run an `INSERT`, `UPDATE` or `DELETE` inside this transaction and return the rows affected. */
	execute(query: SqlQuery): Promise<{ rowCount: number }>;
}

/** Options for `transaction()`. */
export interface TransactionOptions {
	/**
	 * Re-run the callback when the commit hits a serialization conflict
	 * (SQLSTATE 40001). Off by default because the callback may have side effects.
	 *
	 * Before each re-run the block waits a random time between 0 and a ceiling.
	 * The ceiling is 50 ms for the first retry, doubles with each retry and stops
	 * at 2,000 ms. The wait is the same in local mode and on AWS.
	 * @default false
	 */
	retryOnConflict?: boolean;
	/**
	 * Maximum retry attempts on conflict. Only applies when `retryOnConflict` is true.
	 * The callback runs at most `maxRetries + 1` times. With the default, the waits
	 * before the retries add up to 7.15 seconds at most. A value that is not a
	 * whole number of 0 or more throws `DatabaseConfigurationError`.
	 * @default 8
	 */
	maxRetries?: number;
	/**
	 * Stops the retries. When the signal is aborted, the block does not wait or
	 * re-run the callback again, and the conflict is thrown. It does not cancel a
	 * run that is in progress. In an API method, pass `context.request.signal`:
	 * it aborts at the request deadline, so a retry cannot commit after the
	 * caller received a timeout.
	 */
	signal?: AbortSignal;
}

/**
 * A `Database` whose statements all run as one user, for tables protected by
 * Row Level Security. Returned by `Database.asUser()`. `query`, `queryOne`,
 * `execute` and `transaction` behave as on the block. Each transaction starts
 * by setting `request.jwt.claims` to the user's claims, which a policy reads
 * with `current_setting('request.jwt.claims', true)::jsonb`. Pass it to
 * `DatabaseDialect` to run Kysely statements as the same user. It has no
 * `asUser()`: a scoped database cannot be scoped again.
 */
export interface ScopedDatabase {
	/** Which cluster the block runs on. */
	readonly cluster: ClusterRef;
	/** The schema the block's tables live in. */
	readonly schemaName: string;
	/** `Database.query()`, as the user. */
	query<T>(query: SqlQuery, options?: QueryOptions<T>): Promise<T[]>;
	/** `Database.queryOne()`, as the user. */
	queryOne<T>(query: SqlQuery, options?: QueryOptions<T>): Promise<T | null>;
	/** `Database.execute()`, as the user. */
	execute(query: SqlQuery): Promise<{ rowCount: number }>;
	/** `Database.transaction()`, as the user: the claims are set once, for the whole transaction. */
	transaction<T>(fn: (tx: Transaction) => Promise<T>, options?: TransactionOptions): Promise<T>;
}
