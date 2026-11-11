// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for KVStore. Imported by mock, aws, cdk, and browser entry points.
 * This file has zero runtime dependencies — types only.
 */
import type { ChildLogger } from '@aws-blocks/bb-logger';
import type { StandardSchemaV1 } from '@standard-schema/spec';

// ── Keys ────────────────────────────────────────────────────────────────────

/** True for a plain object type. An array or a scalar is not a record. */
export type IsRecord<T> = T extends readonly unknown[] ? false : T extends object ? true : false;

/**
 * Fields that can form a key. The field is required in the output type and holds a string or a number.
 * Its output type must be assignable to its input type, so a brand passes and a type change does not.
 */
export type KeyField<In, Out> =
	IsRecord<Out> extends true
		? {
				[P in keyof Out & string]-?: [Out[P]] extends [string | number]
					? P extends keyof In
						? [Out[P]] extends [NonNullable<In[P]>]
							? P
							: never
						: never
					: never;
			}[keyof Out & string]
		: never;

/** Fields that can form an index key. As {@link KeyField}, but the field can be optional. An index skips an item that lacks it. */
export type IndexField<In, Out> =
	IsRecord<Out> extends true
		? {
				[P in keyof Out & string]-?: [NonNullable<Out[P]>] extends [string | number]
					? P extends keyof In
						? [NonNullable<Out[P]>] extends [NonNullable<In[P]>]
							? P
							: never
						: never
					: never;
			}[keyof Out & string]
		: never;

/** Number fields. The `ttl` option names one of them. */
export type NumberField<In, Out> =
	IsRecord<Out> extends true
		? {
				[P in keyof Out & string]-?: [NonNullable<Out[P]>] extends [number]
					? P extends keyof In
						? [NonNullable<In[P]>] extends [number]
							? P
							: never
						: never
					: never;
			}[keyof Out & string]
		: never;

/**
 * The declared key of a store: the fields of the value that form it.
 *
 * A key field is a required field of the schema that holds a string or a
 * number. DynamoDB keys are compound by nature — a partition key and an
 * optional sort key that together identify an item — so the key of a store
 * with a `key` option is an object with exactly these fields.
 */
export interface KeyConfig<In, Out> {
	/** Field of the value used as the partition key. Must be a required string or number field of the schema. */
	partitionKey: KeyField<In, Out>;
	/** Field of the value used as the sort key. Must be a required string or number field of the schema. Optional. */
	sortKey?: KeyField<In, Out>;
}

/**
 * One secondary index: the fields of the value that form its key. An index
 * field can be optional in the schema — an index holds an item only when each
 * indexed field is present, is not an empty string, and has the declared type.
 */
export interface IndexConfig<In, Out> {
	/** Field of the value used as the index partition key. */
	partitionKey: IndexField<In, Out>;
	/** Field of the value used as the index sort key. Optional. */
	sortKey?: IndexField<In, Out>;
}

/** The field names a key or index config names. */
export type FieldsOf<C> = C extends { partitionKey: infer P; sortKey: infer S }
	? (P | S) & string
	: C extends { partitionKey: infer P }
		? P & string
		: never;

/**
 * The key of a store. A `string` when the store declares no `key`. Otherwise an
 * object with exactly the declared key fields, typed from the output type of
 * the schema (so a brand carries through).
 */
export type KeyOf<T, K> = [K] extends [undefined] ? string : { [F in FieldsOf<K> & keyof T]: T[F] };

/**
 * The value that `put` accepts. It has the input type of the schema. On a store
 * with a declared key the key fields are optional, because the key supplies them.
 */
export type ValueOf<T, K> = [K] extends [undefined]
	? T
	: Omit<T, FieldsOf<K>> & { [F in FieldsOf<K> & keyof T]?: T[F] };

/**
 * One entry of a `query` or `scan`. `expiresAt` is present when the item has
 * an expiry, in Unix epoch seconds — a copy job passes it back to `put`.
 */
export interface Entry<T, K> {
	key: KeyOf<T, K>;
	value: T;
	expiresAt?: number;
}

// ── Conditions and expiry ───────────────────────────────────────────────────

/** Exactly one of the properties of `M`. */
export type OneOf<M> = { [P in keyof M]: { [Q in P]: M[Q] } & { [Q in Exclude<keyof M, P>]?: never } }[keyof M];

/** `T` with at least one of its properties present. */
export type AtLeastOne<T> = T extends unknown
	? { [P in keyof T]-?: Required<Pick<T, P>> & Partial<T> }[keyof T]
	: never;

/** The members of `T` that are plain objects. Distributes over a union. */
export type RecordPart<T> = T extends readonly unknown[] ? never : T extends object ? T : never;
/** The members of `T` that are not plain objects (scalars and arrays). Distributes over a union. */
export type OtherPart<T> = T extends readonly unknown[] ? T : T extends object ? never : T;

/**
 * Expiry options for a write. `ttlSeconds` and `expiresAt` exclude each other;
 * passing both throws `ValidationFailedException`.
 */
export type Expiry =
	| {
			/**
			 * Expire this item `ttlSeconds` from now (relative). Must be a finite
			 * number greater than zero; fractional values round up to the next second.
			 *
			 * @example
			 * ```typescript
			 * await cache.put('otp:alice', code, { ttlSeconds: 300 }); // 5 minutes
			 * ```
			 */
			ttlSeconds?: number;
			expiresAt?: undefined;
	  }
	| {
			/**
			 * Expire this item at an absolute point in time — either a `Date` or a Unix
			 * epoch timestamp **in seconds** (the DynamoDB TTL unit). Values that look
			 * like epoch milliseconds are rejected rather than silently stored as a
			 * year-5138 expiry.
			 *
			 * @example
			 * ```typescript
			 * await sessions.put(id, record, { expiresAt: new Date(jwt.exp * 1000) });
			 * ```
			 */
			expiresAt?: Date | number;
			ttlSeconds?: undefined;
	  };

/**
 * The value check of a condition. `ifFieldEquals` compares fields of an object
 * value; `ifValueEquals` compares a value that is not an object (a string, a
 * number, an array, ...). Each is available only for the matching part of the
 * value type, so `ifValueEquals` with an object value is a compile error.
 */
export type ValueCheck<T> = ([RecordPart<T>] extends [never]
	? { ifFieldEquals?: undefined }
	: {
			/**
			 * Only write if every listed field of the current value equals the given
			 * value (AND semantics) — optimistic locking / compare-and-swap on an
			 * object value, typically with a `version` field. Needs at least one
			 * field; an empty object throws `InvalidQueryException`. Nested values
			 * compare structurally (object key order does not matter; array order does).
			 */
			ifFieldEquals?: AtLeastOne<RecordPart<T>>;
		}) &
	([OtherPart<T>] extends [never]
		? { ifValueEquals?: undefined }
		: {
				/**
				 * Only write if the current value equals this value — optimistic
				 * locking / compare-and-swap on a value that is not an object. An
				 * object value uses `ifFieldEquals` instead; passing an object here
				 * throws `InvalidQueryException`.
				 */
				ifValueEquals?: OtherPart<T>;
			});

/**
 * Conditions accepted by `put`.
 *
 * When BOTH `ifNotExists` and a value check are set they compose with OR:
 * the write succeeds if the key is absent OR its current value matches — the
 * optimistic "create it, or update it only if unchanged" pattern. It fails
 * only when the key exists AND the value differs.
 */
export type ConditionalWriteOptions<T = unknown> = {
	/** Only write if the key does not already exist. */
	ifNotExists?: boolean;
} & ValueCheck<T>;

/**
 * Options accepted by `put`. A superset of {@link ConditionalWriteOptions} —
 * every existing `put(key, value, { ifNotExists })` call remains valid.
 *
 * `ttlSeconds` and `expiresAt` are mutually exclusive; passing both throws
 * `ValidationFailedException`. DynamoDB TTL is always on for a table the block
 * creates, so an expired item is deleted in the background; reads hide expired
 * items regardless.
 */
export type PutOptions<T = unknown> = Expiry & ConditionalWriteOptions<T>;

/**
 * Conditions accepted by `delete`. `ifExists` and a value check compose with
 * AND — both must hold.
 */
export type ConditionalDeleteOptions<T = unknown> = {
	/** Only delete if the key exists. Throws ConditionalCheckFailedException otherwise. */
	ifExists?: boolean;
} & ValueCheck<T>;

/** Options accepted by `delete`. Alias of {@link ConditionalDeleteOptions}. */
export type DeleteOptions<T = unknown> = ConditionalDeleteOptions<T>;

/** One entry of a `putBatch`: the key (typed from the output type), the value (the input type), and an optional expiry. */
export type PutBatchEntry<In, Out, K> = { key: KeyOf<Out, K>; value: ValueOf<In, K> } & Expiry;

// ── Reads ───────────────────────────────────────────────────────────────────

/** Options for `get()`. */
export interface GetOptions {
	/**
	 * Read with strong consistency, so the result reflects every write that
	 * succeeded before the read. **Defaults to `true`**: `get()` is a strongly
	 * consistent DynamoDB `GetItem` (`ConsistentRead: true`), so it returns a
	 * value that a `put()` wrote a moment before. The block holds session, job,
	 * and conversation state, where a stale read gives a wrong result with no
	 * error. A strongly consistent read costs twice the read capacity of an
	 * eventually consistent one. Pass `false` where a stale value is acceptable.
	 * The local mock is always strongly consistent.
	 *
	 * @defaultValue true
	 */
	consistentRead?: boolean;
}

/**
 * Options accepted by `scan`.
 */
export interface ScanOptions {
	/** The largest number of entries to return. */
	limit?: number;
	/** The position to start after, from the `cursor` of an earlier `scan`. */
	cursor?: string;
	/**
	 * Yield items whose expiry has passed but which DynamoDB's reaper has not
	 * deleted yet. Defaults to `false`, so a scan sees only live items.
	 *
	 * Enable this only for maintenance sweeps that must act on every row still
	 * physically present — deleting the remains of expired items, for example.
	 * Reads that answer "is this still valid?" must leave it off.
	 *
	 * @example
	 * ```typescript
	 * for await (const { key } of sessions.scan({ includeExpired: true })) {
	 *   await sessions.delete(key);
	 * }
	 * ```
	 */
	includeExpired?: boolean;
}

// ── Query ───────────────────────────────────────────────────────────────────

/**
 * Sort key condition — exactly one of the comparisons. `beginsWith` is for a
 * string field only. DynamoDB allows one sort-key condition per query; use
 * `between` for a range.
 */
export type SortCondition<V> = OneOf<
	{
		equals: V;
		greaterThan: V;
		greaterThanOrEqual: V;
		lessThan: V;
		lessThanOrEqual: V;
		between: [V, V];
	} & ([V] extends [string] ? { beginsWith: string } : {})
>;

/** Partition key condition — DynamoDB requires an exact match on the partition key in a Query. */
export type PartitionCondition<V> = { equals: V };

/**
 * The `where` clause of a query for a given key or index config. The partition
 * field is required (`{ equals }` only). The sort field is optional with one
 * condition. No other fields appear.
 *
 * @example
 * ```typescript
 * // Index: { partitionKey: 'userId', sortKey: 'createdAt' }
 * // T: { userId: string; createdAt: number; name: string }
 * // Where = { userId: { equals: string }; createdAt?: SortCondition<number> }
 * ```
 */
export type Where<T, C> = C extends { partitionKey: infer P extends keyof T; sortKey: infer S extends keyof T }
	? { [F in P]: PartitionCondition<NonNullable<T[F]>> } & { [F in S]?: SortCondition<NonNullable<T[F]>> }
	: C extends { partitionKey: infer P extends keyof T }
		? { [F in P]: PartitionCondition<NonNullable<T[F]>> }
		: never;

/** Paging and ordering options shared by every form of `query`. */
export interface Page {
	/** The largest number of entries to return. */
	limit?: number;
	/** Sort order on the sort field. Defaults to `'asc'`. */
	order?: 'asc' | 'desc';
	/** The position to start after, from the `cursor` of an earlier `query` with the same `index` and `where`. */
	cursor?: string;
}

/**
 * What `query` and `scan` return: an async iterable of entries with one more
 * property, `cursor` — the position after the last entry that the iterator
 * returned. It is `undefined` when the read reached the end. Pass it to the
 * same call to read the next page, in this request or in a later one.
 */
export interface Results<T, K> extends AsyncIterable<Entry<T, K>> {
	readonly cursor: string | undefined;
}

/**
 * Query options. `where` gives the key conditions, `index` selects a secondary
 * index (omit it to query by the declared key of the store), and `limit`,
 * `order`, and `cursor` control the page.
 *
 * @example
 * ```typescript
 * // Query by the declared key (no index)
 * for await (const { value } of store.query({ where: { userId: { equals: 'u1' } } })) { ... }
 *
 * // Index query with limit and reverse order
 * for await (const { value } of store.query({
 *   index: 'byTimestamp',
 *   where: { userId: { equals: 'u1' }, timestamp: { greaterThan: 1000 } },
 *   limit: 10,
 *   order: 'desc',
 * })) { ... }
 * ```
 */
export type QueryOptions<T, K, I> =
	| ([K] extends [undefined] ? never : { index?: undefined; where: Where<T, K> } & Page)
	| { [N in keyof I & string]: { index: N; where: Where<T, I[N]> } & Page }[keyof I & string];

// ── Read validation ─────────────────────────────────────────────────────────

/**
 * Controls how reads reconcile a stored item with the schema. See
 * {@link SchemaOptions.readValidation} for full semantics.
 *
 * - `'coerce'` (default): pass through the schema, return coerced output; on
 *   validation failure return the raw value + warn (never throws).
 * - `'strict'`: validate and throw `ValidationFailed` on any non-conforming item.
 * - `'off'`: return the raw stored value with no validation.
 */
export type ReadValidationMode = 'off' | 'coerce' | 'strict';

// ── Options ─────────────────────────────────────────────────────────────────

export interface ExternalTableRef {
	readonly __brand: 'ExternalTableRef';
	readonly tableName: string;
}

/**
 * A reference to an existing customer-managed KMS key, produced by
 * `KVStore.fromKmsKey`. Pass it as the `encryption` option to encrypt the
 * table with a CMK you already own — letting several tables share one key
 * instead of each provisioning its own dedicated key.
 */
export interface ExternalKmsKeyRef {
	readonly __brand: 'ExternalKmsKeyRef';
	readonly keyArn: string;
}

/** Table options that apply to every form of a store. */
export interface TableOptions {
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
	 * When omitted, removal policy and deletion protection follow the stack-wide
	 * `defaults` (`BlocksPresets.production` ≈ `'locked'`, `BlocksPresets.sandbox`
	 * ≈ `'disposable'`). A per-block value always wins.
	 *
	 * Replaces the separate `deletionProtection` + `removalPolicy` booleans:
	 * those two knobs could encode the contradictory `deletionProtection: true`
	 * + `removalPolicy: 'destroy'` state, which wedges stack deletion (CFN
	 * issues `DeleteTable`, DynamoDB refuses it, the stack lands in
	 * `DELETE_FAILED`). A single enum makes that state unrepresentable.
	 *
	 * Ignored by the mock and browser runtimes (no AWS resource to protect).
	 */
	protection?: 'disposable' | 'retained' | 'locked';
	/**
	 * DynamoDB Point-in-Time Recovery (continuous backups) — restore the table
	 * to any second within a retention window, protecting against accidental
	 * writes/deletes and logical corruption.
	 *
	 * A single knob, since the recovery window only means anything when PITR is
	 * on:
	 * - `true` — enable PITR with the default 35-day window.
	 * - `false` — disable PITR.
	 * - `{ retentionDays: n }` — enable PITR and keep `n` days of continuous
	 *   backups (**1–35**). A shorter window reduces backup-storage cost at the
	 *   expense of how far back you can restore.
	 *
	 * When omitted, the stack-wide default applies (`defaults.pointInTimeRecovery`
	 * from `BlocksPresets` — on under `production`, off under `sandbox`). A
	 * per-block value always wins.
	 *
	 * Note: PITR bills for continuous-backup storage (per GB-month of table
	 * size), so it is not free on large tables.
	 *
	 * Ignored by the mock and browser runtimes (no AWS resource to back up).
	 */
	pointInTimeRecovery?: boolean | { retentionDays: number };
	/**
	 * Server-side encryption at rest.
	 *
	 * - `'aws-managed'` (default): SSE with the AWS-managed `aws/dynamodb` KMS
	 *   key. Auditable via CloudTrail with no per-key monthly charge.
	 * - `'customer-managed'`: provisions a **dedicated** customer-managed KMS
	 *   key (CMK) for this table, giving you full control over rotation and key
	 *   policy. Incurs standard KMS key + request charges — and note this mints
	 *   a **separate key per table**, so a dozen tables means a dozen keys. The
	 *   dedicated key is retained on stack teardown (not auto-deleted), so each
	 *   torn-down stack leaves its key behind (its monthly key charge plus
	 *   rotation); a bring-your-own key via `KVStore.fromKmsKey` avoids
	 *   this per-stack key sprawl.
	 * - a {@link ExternalKmsKeyRef} from `KVStore.fromKmsKey`:
	 *   uses an **existing** CMK you already own, so several tables can share one
	 *   key (and one monthly charge) instead of each provisioning its own.
	 *
	 * DynamoDB is always encrypted at rest; this only selects the key.
	 *
	 * @example
	 * ```ts
	 * // Share one key across several stores
	 * const key = KVStore.fromKmsKey(
	 *   'arn:aws:kms:us-east-1:111122223333:key/abcd-1234',
	 * );
	 * new KVStore(scope, 'sessions', { encryption: key });
	 * new KVStore(scope, 'cache', { encryption: key });
	 * ```
	 *
	 * Ignored by the mock and browser runtimes (no AWS resource to encrypt).
	 */
	encryption?: 'aws-managed' | 'customer-managed' | ExternalKmsKeyRef;
	/**
	 * Wrap an existing DynamoDB table instead of creating one. Pass the `key`
	 * option that matches the table's key schema; without `key`, the table must
	 * have the string partition key `_bkv_pk`. The block does not create,
	 * change, or delete that table, and it ignores `protection`,
	 * `pointInTimeRecovery`, and `encryption` for it — you own the table's
	 * indexes and TTL setting.
	 */
	table?: ExternalTableRef;
	/**
	 * Optional logger for internal KVStore operations. Accepts a `Logger`
	 * instance or any `ChildLogger` from `@aws-blocks/bb-logger`.
	 *
	 * When omitted, a default Logger at warn level is created so the
	 * `readValidation: 'coerce'` fallback warnings surface (silent during
	 * normal operation).
	 *
	 * @example
	 * ```typescript
	 * import { Logger } from '@aws-blocks/bb-logger';
	 * const log = new Logger(scope, 'app', { level: 'debug' });
	 * const store = new KVStore(scope, 'cache', { logger: log });
	 * ```
	 */
	logger?: ChildLogger;
}

/** The options that need a `schema`. */
export interface SchemaOptions<In, Out, K, I> {
	/**
	 * Runtime schema for value validation on `put`. Accepts any StandardSchemaV1
	 * implementation (Zod, Valibot, ArkType, etc.). When provided, the value
	 * types are inferred from the schema: `put` takes the schema's input type and
	 * a read returns its output type. Required for `key`, `indexes`, and `ttl`.
	 */
	schema: StandardSchemaV1<In, Out>;
	/**
	 * The fields of the value that form the key. Without `key`, the key is a
	 * string and the table's partition key is the attribute `_bkv_pk`. With
	 * `key`, the key of the store is an object with exactly these fields, and
	 * the table uses those attributes as its key schema. A key field is a
	 * required string or number field of the schema.
	 *
	 * A store fixes its key when it creates its table. DynamoDB cannot change
	 * the key schema of a table, so a changed `key` on a deployed store fails
	 * the deploy; copy the items to a store with a new id instead.
	 */
	key?: K;
	/** Global secondary index definitions over fields of the value. Optional. */
	indexes?: I;
	/**
	 * Keep the expiry in this number field of the value instead of the block's
	 * own `_bkv_ttl` attribute. The field holds a Unix epoch timestamp in
	 * seconds. A `put` with no expiry option then uses the field of the value;
	 * a `put` with `ttlSeconds` or `expiresAt` writes the field. DynamoDB
	 * automatically deletes items whose TTL attribute value is older than the
	 * current time, and every read hides an expired item until then.
	 *
	 * Do not change `ttl` on a deployed store: items from before the change
	 * keep their expiry in the old attribute and stop expiring.
	 *
	 * @example
	 * ```typescript
	 * const sessions = new KVStore(scope, 'sessions', {
	 *   schema: sessionSchema,
	 *   key: { partitionKey: 'sessionId' },
	 *   ttl: 'expiresAt',
	 * });
	 * ```
	 */
	ttl?: NumberField<In, Out>;
	/**
	 * How reads (`get`, `getBatch`, `query`, `scan`) reconcile a stored item with
	 * the configured `schema`. Writes (`put`/`putBatch`) always validate; this
	 * governs the read side, which matters after a schema change: a row written
	 * under an older schema may no longer conform to the current output type.
	 *
	 * - **`'coerce'`** (default) — pass each stored item through the schema and
	 *   return its output. For transform-bearing schemas (e.g. Zod) this fills
	 *   `.default()`s and narrows types so the value satisfies the output type and
	 *   the read-modify-write cycle (`get()` → mutate → `put()`) round-trips. **Never
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
	 * const orders = new KVStore(scope, 'orders', {
	 *   schema: orderSchemaV2,        // adds `currency: z.string().default('USD')`
	 *   key: { partitionKey: 'orderId' },
	 *   // readValidation: 'coerce' is the default
	 * });
	 * const order = await orders.get({ orderId: 'o1' }); // legacy row → currency: 'USD'
	 * await orders.put({ orderId: 'o1' }, { ...order, total: 20 }); // round-trips cleanly
	 * ```
	 */
	readValidation?: ReadValidationMode;
}

/**
 * Constructor options for `KVStore`.
 *
 * With no `schema`, the store takes a string key and a value of the type
 * argument (`string` by default). With a `schema`, the value types come from
 * the schema, and `key`, `indexes`, `ttl`, and `readValidation` become
 * available. `key` or `indexes` without a `schema` is a compile error.
 */
export type KVStoreOptions<In = string, Out = In, K = undefined, I = {}> = TableOptions &
	(
		| { schema?: undefined; key?: undefined; indexes?: undefined; ttl?: undefined; readValidation?: undefined }
		| SchemaOptions<In, Out, K, I>
	);
