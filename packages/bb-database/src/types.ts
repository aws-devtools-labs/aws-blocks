// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Public types for the Database Building Block. Types only — no runtime code.
 */
import type { ChildLogger } from '@aws-blocks/bb-logger';
import type { TableSchema } from './crud/types.js';

/**
 * The categories of cluster a {@link DatabaseCluster} can provision.
 *
 * - `distributed` — Aurora DSQL: scales to zero, no VPC, optimistic concurrency,
 *   a subset of PostgreSQL (no foreign keys, triggers, views, extensions, or RLS).
 * - `provisioned` — Aurora Serverless v2: capacity you pay for, a VPC, all of PostgreSQL.
 *
 * The value names what you are choosing between, not the AWS product underneath.
 */
export type ClusterType = 'distributed' | 'provisioned';

/**
 * Every kind of cluster a `Database` can run on: a {@link ClusterType} the block
 * or a `DatabaseCluster` provisions, or `external` for a PostgreSQL you already
 * have (`DatabaseCluster.fromExisting()`).
 */
export type ClusterKind = ClusterType | 'external';

/** The kinds of cluster on which `withRLS()`, `crud()`, `schema` and `rlsPolicy` are available. */
export type RlsCapableKind = 'provisioned' | 'external';

/**
 * A CDK-free structural mirror of the inputs of `ec2.SubnetSelection`, safe to
 * reference from the runtime-resolved constructor (no `aws-cdk-lib` import).
 * Set at most one of `subnetType`, `subnetGroupName`, or `subnetIds`.
 */
export interface SubnetSelection {
	/** Select all subnets of the given tier. Proxy for `ec2.SubnetType`. */
	subnetType?: 'isolated' | 'private-with-egress' | 'public';
	/** Restrict the selection to these Availability Zones (filter). */
	availabilityZones?: string[];
	/** Return at most one subnet per AZ. */
	onePerAz?: boolean;
	/** Select a named subnet group (from the VPC's `subnetConfiguration`). */
	subnetGroupName?: string;
	/** Explicitly select individual subnets by id. */
	subnetIds?: string[];
}

/**
 * TLS policy for an external database connection.
 *
 * A discriminated union on `rejectUnauthorized` so that a misleading combination
 * is a compile-time error: a pinned `ca` only means something when the
 * certificate is verified, and node `pg` silently ignores `ca` when
 * `rejectUnauthorized: false`.
 *
 * - `{ rejectUnauthorized?: true; ca?: string }` — verify the server certificate
 *   (the default). Supply `ca` to pin a provider's private CA.
 * - `{ rejectUnauthorized: false }` — do NOT verify (encrypted but exposed to a
 *   man-in-the-middle).
 */
export type ExternalSslOptions = { rejectUnauthorized?: true; ca?: string } | { rejectUnauthorized: false };

/**
 * How to reach a PostgreSQL you already have. Passed to `DatabaseCluster.fromExisting()`.
 *
 * - `{ connectionString, ssl? }` — anything that speaks the PostgreSQL protocol
 *   (Supabase, Neon, RDS, a laptop). The string may be an `AppSetting`-style
 *   `{ get() }` so the secret is resolved at runtime instead of baked in.
 * - `{ host, secretArn, database }` — an Aurora cluster reached over the RDS
 *   Data API: `host` is the cluster ARN, `secretArn` the Secrets Manager secret.
 */
export type ExternalClusterRef =
	| {
			connectionString: string | { get(): Promise<string> };
			/**
			 * TLS settings. When omitted, the deployed runtime verifies the server
			 * certificate against Node's trust store; managed providers (Supabase,
			 * Neon) need their CA pinned via `ca`.
			 */
			ssl?: ExternalSslOptions;
	  }
	| { host: string; port?: number; database: string; secretArn: string };

/**
 * The value `DatabaseCluster.fromExisting()` returns: a plain reference object,
 * not a Scope. Pass it as a `Database`'s `cluster`. Several blocks may share one
 * value; each gets its own schema.
 */
export interface ExternalCluster {
	readonly __brand: 'ExternalCluster';
	/** Always `'external'`. Anchors `Database<'external'>` inference. */
	readonly kind: 'external';
	/** How to connect. */
	readonly ref: ExternalClusterRef;
}

/**
 * The structural shape of a `DatabaseCluster<T>` as a `Database` constructor
 * sees it. Lets `types.ts` stay free of class imports while still narrowing the
 * `cluster` option by cluster type.
 */
export interface DatabaseClusterLike<T extends ClusterType = ClusterType> {
	/** The category this cluster was constructed with. */
	readonly type: T;
	/** Same as `type`; the common discriminant with {@link ExternalCluster}. */
	readonly kind: T;
	/** The cluster's scoped id (drives resource naming and the binding record). */
	readonly fullId: string;
}

/** Anything that carries a `kind` — used to infer a `Database`'s kind from its `cluster` option. */
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
	 * `'default'` when the block owns its cluster, the `DatabaseCluster`'s full id
	 * when shared, `'external'` for `fromExisting()`. The same value is written to
	 * the binding record.
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

/** Options for a `provisioned` (Aurora Serverless v2) cluster. */
export interface ProvisionedClusterOptions {
	type: 'provisioned';
	/** Minimum Aurora capacity units. @default 0.5 */
	minCapacity?: number;
	/** Maximum Aurora capacity units. @default 2 */
	maxCapacity?: number;
	/**
	 * Aurora PostgreSQL engine version, e.g. `'16.13'`. Configurable because AWS
	 * periodically retires older minor versions. @default '16.13'
	 */
	postgresVersion?: string;
	/** Where to place the cluster when the app runs in a VPC. Defaults to the isolated tier. */
	subnets?: SubnetSelection;
	/**
	 * The PostgreSQL database every block on this cluster shares (each block has
	 * its own schema inside it). Derived from the cluster's full id if omitted.
	 */
	databaseName?: string;
	/**
	 * CloudFormation removal policy for the cluster. When omitted the stack-wide
	 * defaults apply: production clusters retain with deletion protection on,
	 * sandbox clusters destroy. `'snapshot'` takes a final snapshot on delete.
	 */
	removalPolicy?: 'retain' | 'destroy' | 'snapshot';
	/**
	 * ARN of an existing customer-managed KMS key for storage-at-rest encryption.
	 * Storage is always encrypted; without this the AWS-managed `aws/rds` key is used.
	 */
	storageEncryptionKeyArn?: string;
	/**
	 * Automated-backup retention, which is also the point-in-time-recovery window.
	 * `true` → 15 days; `{ retentionDays: n }` → 1–35 days; `false` → the 1-day
	 * minimum (Aurora cannot disable backups). Follows the stack-wide default when omitted.
	 */
	pointInTimeRecovery?: boolean | { retentionDays: number };
}

/** Constructor options for a `DatabaseCluster`, narrowed by `type`. */
export type DatabaseClusterOptions = DistributedClusterOptions | ProvisionedClusterOptions;

/** The options object for a given {@link ClusterType}. */
export type ClusterOptionsOf<T extends ClusterType> = T extends 'distributed'
	? DistributedClusterOptions
	: ProvisionedClusterOptions;

/** Options every `Database` block accepts, whichever cluster it runs on. */
export interface DatabaseBlockOptions {
	/**
	 * Directory of ordinary PostgreSQL `.sql` migration files for this block.
	 * Defaults to `./aws-blocks/migrations/{id}` — one directory per block, always,
	 * so two blocks never run the same files. A missing default directory is not
	 * an error (a new block has no migrations yet); an explicitly set path must exist.
	 */
	migrationsPath?: string;
	/**
	 * The PostgreSQL schema this block's tables live in. `public` when the block
	 * owns its cluster, otherwise the block id. Two blocks on one cluster with the
	 * same name is a dev-server error. On `fromExisting()`, the block that should
	 * see the existing tables sets `schemaName: 'public'`.
	 */
	schemaName?: string;
	/** Optional logger for internal operations. Defaults to an error-level Logger. */
	logger?: ChildLogger;
}

/** Options for a `Database` that owns its cluster (no `cluster`). The owned cluster is `distributed`. */
export interface OwnedDatabaseOptions extends DatabaseBlockOptions {
	cluster?: undefined;
	/**
	 * Removal policy of the owned cluster. Only valid when `cluster` is omitted —
	 * with a shared cluster the policy lives on the `DatabaseCluster`.
	 */
	removalPolicy?: 'retain' | 'destroy';
}

/** Options for a `Database` on a shared `distributed` cluster. */
export interface DistributedDatabaseOptions extends DatabaseBlockOptions {
	cluster: DatabaseClusterLike<'distributed'>;
}

/** Options available only where the cluster is `provisioned` or external. */
export interface RlsDatabaseOptions {
	/** Runtime schema metadata for `crud()`. Generated by `db pull`. */
	schema?: TableSchema;
	/**
	 * RLS enforcement policy. `'enforce'` applies to `crud()` operations (which
	 * always route through `withRLS()`); raw `query()`/`execute()`/`transaction()`
	 * bypass RLS unless you call `withRLS()` yourself.
	 */
	rlsPolicy?: 'enforce';
}

/** Options for a `Database` on a shared `provisioned` cluster. */
export interface ProvisionedDatabaseOptions extends DatabaseBlockOptions, RlsDatabaseOptions {
	cluster: DatabaseClusterLike<'provisioned'>;
}

/** Options for a `Database` on `DatabaseCluster.fromExisting()`. */
export interface ExternalDatabaseOptions extends DatabaseBlockOptions, RlsDatabaseOptions {
	cluster: ExternalCluster;
}

/**
 * Options for a `Database` whose cluster is held in a variable typed as a union
 * of kinds. The conservative surface: `schema` and `rlsPolicy` are not accepted,
 * and the resulting `Database<ClusterKind>` has no `withRLS()` / `crud()`.
 */
export interface AnyClusterDatabaseOptions extends DatabaseBlockOptions {
	cluster: DatabaseClusterLike<ClusterType> | ExternalCluster;
}

/** Every options shape a `Database` constructor accepts. */
export type DatabaseOptions =
	| OwnedDatabaseOptions
	| DistributedDatabaseOptions
	| ProvisionedDatabaseOptions
	| ExternalDatabaseOptions
	| AnyClusterDatabaseOptions;

/** Options for `transaction()`. */
export interface TransactionOptions {
	/**
	 * Re-run the callback when the commit fails with a serialization conflict
	 * (SQLSTATE 40001, {@link DatabaseErrors.SerializationFailure}). Off by default
	 * because the callback may have side effects. Safe when the callback is a pure
	 * read-modify-write.
	 * @default false
	 */
	retryOnConflict?: boolean;
	/**
	 * Maximum retry attempts on conflict. Only applies when `retryOnConflict` is true.
	 * @default 3
	 */
	maxRetries?: number;
}

/**
 * The record the CDK layer writes into stack metadata under `aws-blocks:bindings`
 * and the dev server writes per block to its marker file. A `Database` is bound
 * to one cluster, by id and type, at its first deploy; a deploy that would change
 * either stops.
 */
export interface Bindings {
	/** Keyed by block full id. `cluster` is `'default'`, `'external'`, or the cluster's full id. */
	databases: { [fullId: string]: DatabaseBinding };
	/** Keyed by cluster full id. */
	clusters: { [fullId: string]: { type: ClusterType } };
}

/** One `Database` block's binding. */
export interface DatabaseBinding {
	cluster: string;
	type: ClusterKind;
}

/** A migration plan step, as `bb-database migrate --explain` prints it. */
export interface PlanStep {
	/** What the step does. */
	kind: 'statement' | 'wait-index-job' | 'validate-constraint';
	/** The SQL to run (a template for `wait-index-job`, which substitutes the job id). */
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
