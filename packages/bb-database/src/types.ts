// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Public types for the Database Building Block. Types only, no runtime code.
 */
import type { ChildLogger } from '@aws-blocks/bb-logger';

/**
 * The categories of cluster a {@link DatabaseCluster} can provision.
 *
 * - `distributed`: Aurora DSQL. Scales to zero, no VPC, optimistic concurrency.
 *   Runs most of PostgreSQL, including foreign keys, views, sequences, identity
 *   columns and JSONB. It lacks triggers, PL/pgSQL, extensions and Row Level
 *   Security, and limits a transaction to 3,000 changed rows and 10 MiB.
 *
 * A second category, `provisioned` (Aurora Serverless v2, all of PostgreSQL in
 * a VPC), is planned and not yet available. The value names what you choose
 * between, not the AWS product underneath.
 */
export type ClusterType = 'distributed';

/**
 * Every kind of cluster a `Database` can run on. Today the same as
 * {@link ClusterType}; a later release adds `external` for a PostgreSQL you
 * already have.
 */
export type ClusterKind = ClusterType;

/**
 * The structural shape of a `DatabaseCluster<T>` as a `Database` constructor
 * sees it. Lets `types.ts` stay free of class imports while still narrowing the
 * `cluster` option by cluster type.
 */
export interface DatabaseClusterLike<T extends ClusterType = ClusterType> {
	/** The category this cluster was constructed with. */
	readonly type: T;
	/** Same as `type`; the discriminant a `Database` infers its kind from. */
	readonly kind: T;
	/** The cluster's scoped id (drives resource naming and the binding record). */
	readonly fullId: string;
}

/** Anything with a `kind`. Used to infer a `Database`'s kind from its `cluster` option. */
export interface KindOf<K extends ClusterKind> {
	readonly kind: K;
}

/**
 * The descriptor a `Database` exposes as `db.cluster`. Every entry point checks
 * `kind` at runtime; nothing about the kind is read from the type.
 */
export interface ClusterRef<K extends ClusterKind = ClusterKind> {
	/** Which kind of cluster the block runs on. */
	readonly kind: K;
	/**
	 * `'default'` when the block owns its cluster, otherwise the
	 * `DatabaseCluster`'s full id. The same value is written to the binding record.
	 */
	readonly id: string;
}

/** Options for a `distributed` (Aurora DSQL) cluster. */
export interface DistributedClusterOptions {
	type: 'distributed';
	/**
	 * CloudFormation removal policy for the cluster. When omitted the stack-wide
	 * defaults apply: production clusters retain with deletion protection on,
	 * sandbox clusters destroy. Most apps never set this.
	 */
	removalPolicy?: 'retain' | 'destroy';
}

/** Constructor options for a `DatabaseCluster`, narrowed by `type`. */
export type DatabaseClusterOptions = DistributedClusterOptions;

/** The options object for a given {@link ClusterType}. */
export type ClusterOptionsOf<T extends ClusterType> = T extends 'distributed' ? DistributedClusterOptions : never;

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

/** Options for a `Database` that owns its cluster (no `cluster`). The owned cluster is `distributed`. */
export interface OwnedDatabaseOptions extends DatabaseBlockOptions {
	cluster?: undefined;
	/**
	 * Removal policy of the owned cluster. Only valid when `cluster` is omitted;
	 * with a shared cluster the policy lives on the `DatabaseCluster`.
	 */
	removalPolicy?: 'retain' | 'destroy';
}

/** Options for a `Database` on a shared `distributed` cluster. */
export interface DistributedDatabaseOptions extends DatabaseBlockOptions {
	cluster: DatabaseClusterLike<'distributed'>;
}

/** Every options shape a `Database` constructor accepts. */
export type DatabaseOptions = OwnedDatabaseOptions | DistributedDatabaseOptions;

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

/** Which cluster each block is bound to. Written to stack metadata and to the dev-server marker. */
export interface Bindings {
	/** Keyed by block full id. `cluster` is `'default'` or the cluster's full id. */
	databases: { [fullId: string]: DatabaseBinding };
	/** Keyed by cluster full id. */
	clusters: { [fullId: string]: ClusterBinding };
}

/** One `Database` block's binding. */
export interface DatabaseBinding {
	/** `'default'` when the block owns its cluster, otherwise the cluster's full id. */
	cluster: string;
	type: ClusterKind;
	/**
	 * CloudFormation logical id of the cluster resource the block owns. Present
	 * only in stack metadata, only for a block that owns its cluster; lets the
	 * deploy guard tell "this block was deleted" from "this cluster was renamed".
	 */
	resource?: string;
}

/** One `DatabaseCluster`'s entry in the binding record. */
export interface ClusterBinding {
	type: ClusterType;
	/** CloudFormation logical id of the cluster resource. Present only in stack metadata. */
	resource?: string;
}

/** A migration plan step, as `bb-database migrate --explain` prints it. */
export interface PlanStep {
	/**
	 * What the step does. `statement` runs SQL; `validate-constraint` runs an
	 * `ALTER TABLE ASYNC … VALIDATE CONSTRAINT` that returns a job id; `wait-job`
	 * waits for the job the previous step started (an index build or a
	 * constraint validation).
	 */
	kind: 'statement' | 'validate-constraint' | 'wait-job';
	/** The SQL to run (a template for `wait-job`, which substitutes the job id). */
	sql: string;
	/** Whether this step runs inside the file's shared transaction (`false` → its own implicit transaction). */
	transactional: boolean;
	/** Human-readable note about any rewrite applied. */
	note?: string;
}

/** The plan for one migration file. */
export interface FilePlan {
	file: string;
	steps: PlanStep[];
	/** Foreign keys whose referential action this file defines or changes. */
	foreignKeys: string[];
}

/** The plan for a migration directory against a cluster kind. */
export interface MigrationPlan {
	target: ClusterKind;
	files: FilePlan[];
}
