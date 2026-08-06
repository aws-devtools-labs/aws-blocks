// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for DistributedTable. Imported by mock, aws, and browser entry points.
 * This file has zero runtime dependencies — types only.
 */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ChildLogger } from '@aws-blocks/bb-logger';

// ── Read validation ─────────────────────────────────────────────────────────

/**
 * Controls how reads reconcile a stored item with the schema. See
 * {@link DistributedTableOptions.readValidation} for full semantics.
 *
 * - `'coerce'` (default): pass through the schema, return coerced output; on
 *   validation failure return the raw value + warn (never throws).
 * - `'strict'`: validate and throw `ValidationFailed` on any non-conforming item.
 * - `'off'`: return the raw stored value with no validation.
 */
export type ReadValidationMode = 'off' | 'coerce' | 'strict';

// ── Key configuration ───────────────────────────────────────────────────────

export interface TableKeyConfig<T> {
	/** Attribute name used as the partition key. Must be a field in the schema. */
	partitionKey: keyof T & string;
	/** Attribute name used as the sort key. Must be a field in the schema. Optional. */
	sortKey?: keyof T & string;
}

export interface DistributedTableOptions<
	T,
	K extends TableKeyConfig<T> = TableKeyConfig<T>,
	Indexes extends Record<string, TableKeyConfig<T>> = Record<string, TableKeyConfig<T>>,
> {
	/** StandardSchemaV1 schema for runtime validation and type inference. Required. */
	schema: StandardSchemaV1<T>;
	/** Primary key configuration. */
	key: K;
	/** Global secondary index definitions. Optional. */
	indexes?: Indexes;
	/**
	 * Enable DynamoDB Time-to-Live (TTL) on the specified attribute.
	 * The attribute must be a field in the schema and should contain a Unix
	 * epoch timestamp (in seconds). DynamoDB automatically deletes items
	 * whose TTL attribute value is older than the current time.
	 *
	 * @example
	 * ```typescript
	 * const sessions = new DistributedTable(scope, 'sessions', {
	 *   schema: sessionSchema,
	 *   key: { partitionKey: 'sessionId' },
	 *   ttl: 'expiresAt',
	 * });
	 * ```
	 */
	ttl?: keyof T & string;
	/**
	 * Enable DynamoDB Point-in-Time Recovery (continuous backups).
	 *
	 * PITR lets you restore the table to any second within the retention
	 * window (see {@link pointInTimeRecoveryDays}), protecting against
	 * accidental writes/deletes and logical corruption.
	 *
	 * Defaults to **`true` on production deploys** and **`false` in sandbox
	 * mode** (`--context sandboxMode=true`) to keep throwaway sandboxes cheap.
	 * Set explicitly to override that default in either environment.
	 *
	 * Note: PITR bills for continuous-backup storage (per GB-month of table
	 * size), so it is not free on large tables.
	 */
	pointInTimeRecovery?: boolean;
	/**
	 * The recovery window, in days, that Point-in-Time Recovery keeps
	 * continuous backups for — you can restore to any second within this many
	 * preceding days.
	 *
	 * Accepts **1–35**; defaults to **35** (the maximum) when omitted. Only
	 * meaningful when PITR is enabled; ignored when `pointInTimeRecovery` is
	 * `false`. A shorter window reduces backup-storage cost at the expense of
	 * how far back you can restore.
	 */
	pointInTimeRecoveryDays?: number;
	/**
	 * How hard the table is to destroy — a single knob spanning DynamoDB
	 * deletion protection and the CloudFormation removal policy, which together
	 * answer one question: "can this table be destroyed?"
	 *
	 * - `'disposable'`: `RemovalPolicy.DESTROY`, deletion protection **off**.
	 *   Deleting the stack deletes the table. The **sandbox default** — keeps
	 *   `sandbox:destroy` a one-command teardown.
	 * - `'retained'`: `RemovalPolicy.RETAIN`, deletion protection **off**.
	 *   Deleting the stack orphans (keeps) the table, but a direct
	 *   `DeleteTable`/console delete still works. Use when you want the data to
	 *   survive stack teardown without blocking intentional deletes.
	 * - `'locked'`: `RemovalPolicy.RETAIN` **and** deletion protection **on**.
	 *   The table survives stack deletion and DynamoDB refuses a direct delete
	 *   until protection is turned off. The **production default**.
	 *
	 * Defaults to **`'locked'` on production deploys** and **`'disposable'` in
	 * sandbox mode** (`--context sandboxMode=true`). Set explicitly to override
	 * in either environment.
	 *
	 * Replaces the separate `deletionProtection` + `removalPolicy` booleans:
	 * those two knobs could encode the contradictory `deletionProtection: true`
	 * + `removalPolicy: 'destroy'` state, which wedges stack deletion (CFN
	 * issues `DeleteTable`, DynamoDB refuses it, the stack lands in
	 * `DELETE_FAILED`). A single enum makes that state unrepresentable.
	 */
	protection?: 'disposable' | 'retained' | 'locked';
	/**
	 * Server-side encryption at rest.
	 *
	 * - `'aws-managed'` (default): SSE with the AWS-managed `aws/dynamodb` KMS
	 *   key. Auditable via CloudTrail with no per-key monthly charge.
	 * - `'customer-managed'`: provisions a **dedicated** customer-managed KMS
	 *   key (CMK) for this table, giving you full control over rotation and key
	 *   policy. Incurs standard KMS key + request charges — and note this mints
	 *   a **separate key per table**, so a dozen tables means a dozen keys.
	 * - a {@link ExternalKmsKeyRef} from {@link DistributedTable.fromKmsKey}:
	 *   uses an **existing** CMK you already own, so several tables can share one
	 *   key (and one monthly charge) instead of each provisioning its own.
	 *
	 * DynamoDB is always encrypted at rest; this only selects the key.
	 *
	 * @example
	 * ```ts
	 * // Share one key across several tables
	 * const key = DistributedTable.fromKmsKey(
	 *   'arn:aws:kms:us-east-1:111122223333:key/abcd-1234',
	 * );
	 * new DistributedTable(scope, 'orders', { schema, key: { partitionKey: 'id' }, encryption: key });
	 * new DistributedTable(scope, 'events', { schema, key: { partitionKey: 'id' }, encryption: key });
	 * ```
	 */
	encryption?: 'aws-managed' | 'customer-managed' | ExternalKmsKeyRef;
	/**
	 * How reads (`get`, `getBatch`, `query`, `scan`) reconcile a stored item with
	 * the configured `schema`. Writes (`put`/`putBatch`) always validate; this
	 * governs the read side, which matters after a schema change: a row written
	 * under an older schema may no longer conform to the current type `T`.
	 *
	 * - **`'coerce'`** (default) — pass each stored item through the schema and
	 *   return its output. For transform-bearing schemas (e.g. Zod) this fills
	 *   `.default()`s and narrows types so the value satisfies `T` and the
	 *   read-modify-write cycle (`get()` → mutate → `put()`) round-trips. **Never
	 *   throws:** an item that fails validation is returned **as-is** with a
	 *   warning, keeping drifted/legacy rows readable for migration.
	 * - **`'strict'`** — validate on read and **throw** `ValidationFailed` on any
	 *   item that doesn't satisfy the schema. For tables where a mismatch should be
	 *   treated as corruption/tampering and rejected rather than absorbed. Note
	 *   this makes a single bad row fail the whole `query`/`scan`/`getBatch`.
	 * - **`'off'`** — return the raw stored value with no validation (lowest cost).
	 *   Use for hot paths, data you trust was written through this schema, or to
	 *   read items you can't yet coerce during a migration.
	 *
	 * Defaults to `'coerce'`.
	 *
	 * > **Best-effort coercion (validator-dependent).** Coercion relies on the
	 * > schema *transforming* its input. Zod fills defaults and casts; a check-only
	 * > Standard Schema validator (some Valibot/ArkType schemas) validates without
	 * > transforming, so `'coerce'` returns the value unchanged for those — it never
	 * > invents data. A required field with no default is never fabricated: under
	 * > `'coerce'` such a row is returned raw + warned; under `'strict'` it throws.
	 *
	 * @example
	 * ```typescript
	 * const orders = new DistributedTable(scope, 'orders', {
	 *   schema: orderSchemaV2,        // adds `currency: z.string().default('USD')`
	 *   key: { partitionKey: 'orderId' },
	 *   // readValidation: 'coerce' is the default
	 * });
	 * const order = await orders.get({ orderId: 'o1' }); // legacy row → currency: 'USD'
	 * await orders.put({ ...order, total: 20 });         // round-trips cleanly
	 * ```
	 */
	readValidation?: ReadValidationMode;
	/** Wrap an existing table instead of creating one. */
	table?: ExternalTableRef;
	/** Optional logger for internal operations. When omitted, a default Logger at error level is created. */
	logger?: ChildLogger;
}

export interface ExternalTableRef {
	readonly __brand: 'ExternalTableRef';
	readonly tableName: string;
}

/**
 * A reference to an existing customer-managed KMS key, produced by
 * {@link DistributedTable.fromKmsKey}. Pass it as the `encryption` option to
 * encrypt the table with a CMK you already own — letting several tables share
 * one key instead of each provisioning its own dedicated key.
 */
export interface ExternalKmsKeyRef {
	readonly __brand: 'ExternalKmsKeyRef';
	readonly keyArn: string;
}

// ── Key type for get/delete ─────────────────────────────────────────────────

/**
 * Picks exactly the key fields from T and makes them required.
 * Non-key fields are excluded.
 */
export type TableKey<T, K extends TableKeyConfig<T> = TableKeyConfig<T>> =
	K extends { sortKey: infer SK extends keyof T & string }
		? Required<Pick<T, K['partitionKey'] | SK>>
		: Required<Pick<T, K['partitionKey']>>;

// ── Query condition types ───────────────────────────────────────────────────

/** Partition key condition — DynamoDB requires exact match on PK in a Query. */
export type PartitionKeyCondition<V> = { equals: V };

/** Sort key condition — supports range queries, beginsWith (strings only). */
export type SortKeyCondition<V> = {
	equals?: V;
	greaterThan?: V;
	greaterThanOrEqual?: V;
	lessThan?: V;
	lessThanOrEqual?: V;
	between?: [V, V];
	beginsWith?: V extends string ? string : never;
};

/**
 * Query input for a given index. The partition key field is required (equals only).
 * The sort key field is optional with rich conditions. No other fields appear.
 *
 * @example
 * ```typescript
 * // Index: { partitionKey: 'userId', sortKey: 'createdAt' }
 * // T: { userId: string; createdAt: number; name: string }
 * // KeyCondition = { userId: { equals: string }; createdAt?: SortKeyCondition<number> }
 * ```
 */
export type KeyCondition<T, K extends TableKeyConfig<T>> =
	K extends { sortKey: infer SK extends keyof T & string }
		? { [P in K['partitionKey']]: PartitionKeyCondition<T[P]> } &
		  { [P in SK]?: SortKeyCondition<T[P]> }
		: { [P in K['partitionKey']]: PartitionKeyCondition<T[P]> };

// ── Method options ──────────────────────────────────────────────────────────

/**
 * Query options using named parameters. The `where` clause provides key
 * conditions, `index` selects a GSI (omit for primary key), and `limit`
 * and `order` control result size and sort direction.
 *
 * @example
 * ```typescript
 * // Primary key query (no index)
 * for await (const item of table.query({ where: { userId: { equals: 'u1' } } })) { ... }
 *
 * // GSI query with limit and reverse order
 * for await (const item of table.query({
 *   index: 'byTimestamp',
 *   where: { userId: { equals: 'u1' }, timestamp: { greaterThan: 1000 } },
 *   limit: 10,
 *   order: 'desc',
 * })) { ... }
 * ```
 */
export type QueryOptions<
	T,
	K extends TableKeyConfig<T>,
	Indexes extends Record<string, TableKeyConfig<T>>,
> = {
	[Name in string & keyof Indexes]: {
		/** GSI to query. Omit to query the primary key. */
		index: Name;
		/** Key conditions for the query. */
		where: KeyCondition<T, Indexes[Name]>;
		/** Maximum number of items to return. */
		limit?: number;
		/** Sort order. Defaults to 'asc'. */
		order?: 'asc' | 'desc';
	};
}[string & keyof Indexes] | {
	index?: undefined;
	/** Key conditions for the primary key query. */
	where: KeyCondition<T, K>;
	/** Maximum number of items to return. */
	limit?: number;
	/** Sort order. Defaults to 'asc'. */
	order?: 'asc' | 'desc';
};

export interface ScanOptions {
	/** Maximum number of items to return. */
	limit?: number;
}

export type PutOptions<T> =
	| { ifNotExists: true; ifFieldEquals?: never }
	| { ifNotExists?: never; ifFieldEquals: Partial<T> }
	| Record<string, never>;

export type DeleteOptions<T> =
	| { ifExists: true; ifFieldEquals?: never }
	| { ifExists?: never; ifFieldEquals: Partial<T> }
	| Record<string, never>;


