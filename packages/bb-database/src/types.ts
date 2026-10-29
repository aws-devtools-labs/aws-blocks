// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Public types for the Database Building Block. Types only, no runtime code.
 */
import type { ChildLogger } from '@aws-blocks/bb-logger';
import type { SqlQuery } from '@aws-blocks/data-common';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * The categories of cluster a {@link DatabaseCluster} can provision.
 *
 * - `dsql`: Aurora DSQL. Scales to zero, no VPC, optimistic concurrency.
 *   Runs most of PostgreSQL, including foreign keys, views, sequences, identity
 *   columns and JSONB. It lacks triggers, PL/pgSQL, extensions and Row Level
 *   Security, and limits a transaction to 3,000 changed rows and 10 MiB.
 *
 * A second category, `provisioned` (Aurora Serverless v2, all of PostgreSQL in
 * a VPC), is planned and not yet available. The value names the engine, so
 * every stop and limit can say which database it comes from.
 */
export type ClusterType = 'dsql';

/**
 * The structural shape of a `DatabaseCluster<T>` as a `Database` constructor
 * sees it. Lets `types.ts` stay free of class imports while still narrowing the
 * `cluster` option by cluster type.
 */
export interface DatabaseClusterLike {
	/** The category this cluster was constructed with. */
	readonly type: ClusterType;
	/** The cluster's scoped id (drives resource naming and the binding record). */
	readonly fullId: string;
}

/**
 * The descriptor a `Database` exposes as `db.cluster`. It is a plain value, so
 * a handler can return it to the client and the runtime can branch on `kind`
 * without trusting the type parameter.
 */
export interface ClusterRef {
	/** Which kind of cluster the block runs on. */
	readonly kind: ClusterType;
	/**
	 * `'default'` when the block owns its cluster, otherwise the
	 * `DatabaseCluster`'s full id. The same value is written to the binding record.
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

/** Constructor options for a `DatabaseCluster`, narrowed by `type`. */
export type DatabaseClusterOptions = DsqlClusterOptions;

/** Options every `Database` block accepts, whichever cluster it runs on. */
export interface DatabaseBlockOptions {
	/**
	 * Directory of `.sql` migration files for this block, relative to the project
	 * root. Defaults to `./aws-blocks/migrations/{id}`, which may be absent; an
	 * explicit path must exist.
	 */
	migrationsPath?: string;
	/**
	 * The PostgreSQL schema this block's tables live in. `public` when the block
	 * owns its cluster, otherwise the block id. Two blocks on one cluster may not
	 * share a schema.
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

/** Options for a `Database` on a shared `dsql` cluster. */
export interface DsqlDatabaseOptions extends DatabaseBlockOptions {
	cluster: DatabaseClusterLike;
}

/** Every options shape a `Database` constructor accepts. */
export type DatabaseOptions = OwnedDatabaseOptions | DsqlDatabaseOptions;

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
	 * @default false
	 */
	retryOnConflict?: boolean;
	/**
	 * Maximum retry attempts on conflict. Only applies when `retryOnConflict` is true.
	 * @default 3
	 */
	maxRetries?: number;
}

/** Which cluster a `Database` is bound to. The dev server writes it to `.bb-data/{fullId}/binding.json`. */
export interface DatabaseBinding {
	/** `'default'` when the block owns its cluster, otherwise the cluster's full id. */
	cluster: string;
	type: ClusterType;
}
