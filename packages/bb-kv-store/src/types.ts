// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for KVStore. Imported by mock, aws, cdk, and browser entry
 * points. This file has zero runtime dependencies and holds types only.
 */
import type { ChildLogger } from '@aws-cdk-blocks/bb-logger';
import type { StandardSchemaV1 } from '@standard-schema/spec';

// ── Keys ────────────────────────────────────────────────────────────────────

/** True for a plain object type. An array or a scalar is not a record. */
export type IsRecord<T> = T extends readonly unknown[] ? false : T extends object ? true : false;

/**
 * `P` when `Value` is a `Kind` that the stored (input) type `Stored` can hold, and `never` otherwise.
 * The one check behind {@link KeyField}, {@link IndexField} and {@link NumberField}.
 */
export type FieldIf<P, Value, Kind, Stored> = [Value] extends [Kind] ? ([Value] extends [Stored] ? P : never) : never;

/** The field names that the input type and the output type of a schema share. */
export type SharedField<In, Out> = keyof Out & keyof In & string;

/**
 * Fields that can form a key. The field is required in the output type and holds a string or a number.
 * Its output type must be assignable to its input type, so a brand passes and a type change does not.
 */
export type KeyField<In, Out> =
	IsRecord<Out> extends true
		? {
				[P in SharedField<In, Out>]-?: FieldIf<P, Out[P], string | number, NonNullable<In[P]>>;
			}[SharedField<In, Out>]
		: never;

/** Fields that can form an index key. As {@link KeyField}, but the field can be optional. An index skips an item that lacks it. */
export type IndexField<In, Out> =
	IsRecord<Out> extends true
		? {
				[P in SharedField<In, Out>]-?: FieldIf<P, NonNullable<Out[P]>, string | number, NonNullable<In[P]>>;
			}[SharedField<In, Out>]
		: never;

/** Number fields. The `ttl` option names one of them. Both the value that is stored and the value that a read returns are numbers. */
export type NumberField<In, Out> =
	IsRecord<Out> extends true
		? {
				[P in SharedField<In, Out>]-?: FieldIf<P, NonNullable<Out[P]> | NonNullable<In[P]>, number, number>;
			}[SharedField<In, Out>]
		: never;

/**
 * The declared key of a store: the fields of the value that form it.
 *
 * A key field is a required field of the schema that holds a string or a number.
 * A DynamoDB key is compound: a partition key and an optional sort key together
 * identify an item. So the key of a store with a `key` option is an object with
 * exactly these fields.
 */
export interface KeyConfig<In, Out> {
	/** Field of the value used as the partition key. Must be a required string or number field of the schema. */
	partitionKey: KeyField<In, Out>;
	/** Field of the value used as the sort key. Must be a required string or number field of the schema. Optional. */
	sortKey?: KeyField<In, Out>;
}

/**
 * One secondary index: the fields of the value that form its key. An index field
 * can be optional in the schema. An index holds an item only when each indexed
 * field is present, is not an empty string, and has the declared type.
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
 * One entry of a `query` or `scan`. `expiresAt` is present when the item has an
 * expiry, in Unix epoch seconds. A copy job passes it back to `put`.
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
 * Expiry options for a write. `ttlSeconds` and `expiresAt` exclude each other. A
 * call that passes both throws `ValidationFailedException`.
 */
export type Expiry =
	| {
			/**
			 * Expire this item `ttlSeconds` from now (relative). Must be a finite number
			 * greater than zero. A fractional value rounds up to the next second.
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
			 * Expire this item at an absolute point in time: a `Date`, or a Unix epoch
			 * timestamp **in seconds** (the DynamoDB TTL unit). A value that looks like
			 * epoch milliseconds is rejected. Otherwise it would be stored as an expiry in
			 * the year 5138, with no error.
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
 * value. `ifValueEquals` compares a value that is not an object, such as a
 * string, a number, or an array. Each is available only for the matching part of
 * the value type, so `ifValueEquals` with an object value is a compile error.
 */
export type ValueCheck<T> = ([RecordPart<T>] extends [never]
	? { ifFieldEquals?: undefined }
	: {
			/**
			 * Only write if every listed field of the current value equals the given value
			 * (AND semantics). This is optimistic locking, or compare-and-swap, on an object
			 * value, typically with a `version` field. Needs at least one field. An empty
			 * object throws `InvalidQueryException`. Nested values compare structurally: the
			 * order of the keys of an object does not matter, and the order of an array
			 * does.
			 */
			ifFieldEquals?: AtLeastOne<RecordPart<T>>;
		}) &
	([OtherPart<T>] extends [never]
		? { ifValueEquals?: undefined }
		: {
				/**
				 * Only write if the current value equals this value. This is optimistic locking,
				 * or compare-and-swap, on a value that is not an object. An object value uses
				 * `ifFieldEquals` instead. An object passed here throws `InvalidQueryException`.
				 */
				ifValueEquals?: OtherPart<T>;
			});

/**
 * Conditions accepted by `put`.
 *
 * When BOTH `ifNotExists` and a value check are set they compose with OR: the
 * write succeeds if the key is absent OR its current value matches. This is the
 * optimistic "create it, or update it only if unchanged" pattern. The write
 * fails only when the key exists AND the value differs.
 */
export type ConditionalWriteOptions<T = unknown> = {
	/** Only write if the key does not already exist. */
	ifNotExists?: boolean;
} & ValueCheck<T>;

/**
 * Options accepted by `put`. A superset of {@link ConditionalWriteOptions}, so
 * every existing `put(key, value, { ifNotExists })` call remains valid.
 *
 * `ttlSeconds` and `expiresAt` are mutually exclusive. A call that passes both
 * throws `ValidationFailedException`. DynamoDB TTL is always on for a table the
 * block creates, so an expired item is deleted in the background. Reads hide
 * expired items regardless.
 */
export type PutOptions<T = unknown> = Expiry & ConditionalWriteOptions<T>;

/**
 * Conditions accepted by `delete`. `ifExists` and a value check compose with
 * AND, so both must hold.
 */
export type ConditionalDeleteOptions<T = unknown> = {
	/** Only delete if the key exists. Throws ConditionalCheckFailedException otherwise. */
	ifExists?: boolean;
} & ValueCheck<T>;

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
	/** The largest number of entries to return. A positive integer. */
	limit?: number;
	/** The position to start after, from the `cursor` of an earlier `scan`. */
	cursor?: string;
	/**
	 * Yield items whose expiry has passed but which DynamoDB has not deleted yet.
	 * Defaults to `false`, so a scan sees only live items.
	 *
	 * Enable this only for a maintenance job that must act on every row still
	 * physically present, for example a job that deletes the remains of expired
	 * items. Reads that answer "is this still valid?" must leave it off.
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
 * Sort key condition: exactly one of the comparisons. `beginsWith` is for a
 * string field only. DynamoDB allows one sort-key condition per query. Use
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
		// biome-ignore lint/complexity/noBannedTypes: `{}` adds no member for a number sort field
	} & ([V] extends [string] ? { beginsWith: string } : {})
>;

/** Partition key condition. DynamoDB requires an exact match on the partition key in a Query. */
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
	/** The largest number of entries to return. A positive integer. */
	limit?: number;
	/** Sort order on the sort field. Defaults to `'asc'`. */
	order?: 'asc' | 'desc';
	/** The position to start after, from the `cursor` of an earlier `query` with the same `index` and `where`. */
	cursor?: string;
}

/**
 * What `query` and `scan` return: an async iterable of entries with one more
 * property, `cursor`. The cursor is the position after the last entry that the
 * iterator returned. It is `undefined` when the read reached the end. Pass it to
 * the same call to read the next page, in this request or in a later one.
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
 * - `'coerce'` (default): pass through the schema and return the coerced output.
 *   On validation failure, return the raw value with a warning (never throws).
 * - `'strict'`: validate and throw `ValidationFailedException` on any
 *   non-conforming item.
 * - `'off'`: return the raw stored value with no validation.
 */
export type ReadValidationMode = 'off' | 'coerce' | 'strict';

// ── Options ─────────────────────────────────────────────────────────────────

/**
 * A reference to an existing DynamoDB table, produced by
 * `KVStore.fromExisting`. Pass it as the `table` option to use that table
 * instead of creating one.
 */
export interface ExternalTableRef {
	readonly __brand: 'ExternalTableRef';
	readonly tableName: string;
}

/**
 * A reference to an existing customer-managed KMS key, produced by
 * `KVStore.fromKmsKey`. Pass it as the `encryption` option to encrypt the table
 * with a CMK you already own. Several tables can then share one key, and no
 * table provisions its own dedicated key.
 */
export interface ExternalKmsKeyRef {
	readonly __brand: 'ExternalKmsKeyRef';
	readonly keyArn: string;
}

/** Table options that apply to every form of a store. */
export interface TableOptions {
	/**
	 * How hard the table is to destroy. One option covers DynamoDB deletion
	 * protection and the CloudFormation removal policy, which together answer one
	 * question: "can this table be destroyed?"
	 *
	 * - `'disposable'`: `RemovalPolicy.DESTROY`, deletion protection **off**.
	 *   Deleting the stack deletes the table. The **sandbox default**, so
	 *   `sandbox:destroy` removes everything with one command.
	 * - `'retained'`: `RemovalPolicy.RETAIN`, deletion protection **off**. Deleting
	 *   the stack keeps the table in the account, but a direct `DeleteTable` call or
	 *   a console delete still works. Use when you want the data to survive stack
	 *   teardown without blocking intentional deletes.
	 * - `'locked'`: `RemovalPolicy.RETAIN` **and** deletion protection **on**. The
	 *   table survives stack deletion and DynamoDB refuses a direct delete until
	 *   protection is turned off. The **production default**.
	 *
	 * When omitted, removal policy and deletion protection follow the stack-wide
	 * `defaults`. `BlocksPresets.production` is close to `'locked'`, and
	 * `BlocksPresets.sandbox` is close to `'disposable'`. A per-block value always
	 * wins.
	 *
	 * Replaces the separate `deletionProtection` and `removalPolicy` options. Those
	 * two options could encode the contradictory state `deletionProtection: true`
	 * with `removalPolicy: 'destroy'`, which blocks stack deletion: CloudFormation
	 * issues `DeleteTable`, DynamoDB refuses it, and the stack ends in
	 * `DELETE_FAILED`. A single enum cannot express that state.
	 *
	 * Ignored by the mock and browser runtimes (no AWS resource to protect).
	 */
	protection?: 'disposable' | 'retained' | 'locked';
	/**
	 * DynamoDB Point-in-Time Recovery (continuous backups). You can restore the
	 * table to any second within a retention window, which protects against
	 * accidental writes, accidental deletes, and logical corruption.
	 *
	 * One option, since the recovery window only means anything when PITR is on:
	 * - `true`: enable PITR with the default 35-day window.
	 * - `false`: disable PITR.
	 * - `{ retentionDays: n }`: enable PITR and keep `n` days of continuous backups
	 *   (**1 to 35**). A shorter window reduces backup-storage cost, and you cannot
	 *   restore as far back.
	 *
	 * When omitted, the stack-wide default applies: `defaults.pointInTimeRecovery`
	 * from `BlocksPresets`, which is on under `production` and off under `sandbox`.
	 * A per-block value always wins.
	 *
	 * Note: PITR bills for continuous-backup storage (per GB-month of table size),
	 * so it is not free on large tables.
	 *
	 * Ignored by the mock and browser runtimes (no AWS resource to back up).
	 */
	pointInTimeRecovery?: boolean | { retentionDays: number };
	/**
	 * Server-side encryption at rest.
	 *
	 * - `'aws-managed'` (default): SSE with the AWS-managed `aws/dynamodb` KMS key.
	 *   Auditable through CloudTrail with no per-key monthly charge.
	 * - `'customer-managed'`: provisions a **dedicated** customer-managed KMS key
	 *   (CMK) for this table, giving you full control over rotation and key policy.
	 *   Incurs standard KMS key and request charges. This creates a **separate key
	 *   per table**, so a dozen tables means a dozen keys. The dedicated key follows
	 *   the removal policy of its table. The key of a retained table stays in the
	 *   account after stack teardown and keeps its monthly charge. The key of a
	 *   `'disposable'` table is scheduled for deletion with the table. To use one
	 *   key for several tables, pass a key from `KVStore.fromKmsKey`.
	 * - a {@link ExternalKmsKeyRef} from `KVStore.fromKmsKey`: uses an **existing**
	 *   CMK you already own, so several tables can share one key (and one monthly
	 *   charge) instead of each provisioning its own.
	 *
	 * DynamoDB is always encrypted at rest. This option only selects the key.
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
	 * Wrap an existing DynamoDB table instead of creating one. Pass the `key` option
	 * that matches the table's key schema. Without `key`, the table must have the
	 * string partition key `_bkv_pk`. The block does not create, change, or delete
	 * that table, and it ignores `protection`, `pointInTimeRecovery`, and
	 * `encryption` for it. You own the table's indexes and TTL setting.
	 */
	table?: ExternalTableRef;
	/**
	 * Optional logger for internal KVStore operations. Accepts a `Logger` instance
	 * or any `ChildLogger` from `@aws-cdk-blocks/bb-logger`.
	 *
	 * When omitted, a default Logger at warn level is created, so the fallback
	 * warnings of `readValidation: 'coerce'` are logged. It logs nothing during
	 * normal operation.
	 *
	 * @example
	 * ```typescript
	 * import { Logger } from '@aws-cdk-blocks/bb-logger';
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
	 * implementation, such as Zod, Valibot, or ArkType. When provided, the value
	 * types are inferred from the schema: `put` takes the schema's input type and a
	 * read returns its output type. Required for `key`, `indexes`, and `ttl`.
	 */
	schema: StandardSchemaV1<In, Out>;
	/**
	 * The fields of the value that form the key. Without `key`, the key is a string
	 * and the table's partition key is the attribute `_bkv_pk`. With `key`, the key
	 * of the store is an object with exactly these fields, and the table uses those
	 * attributes as its key schema. A key field is a required string or number field
	 * of the schema.
	 *
	 * A store fixes its key when it creates its table. DynamoDB cannot change the
	 * key schema of a table, so a changed `key` on a deployed store fails the
	 * deploy. Copy the items to a store with a new id instead.
	 */
	key?: K;
	/** Global secondary index definitions over fields of the value. Optional. */
	indexes?: I;
	/**
	 * Keep the expiry in this number field of the value instead of the block's own
	 * `_bkv_ttl` attribute. The field holds a Unix epoch timestamp in seconds. A
	 * `put` with no expiry option then uses the field of the value. A `put` with
	 * `ttlSeconds` or `expiresAt` writes the field before the schema validates the
	 * value, so the schema validates what is stored. DynamoDB automatically deletes
	 * items whose TTL attribute value is older than the current time, and every read
	 * hides an expired item until then.
	 *
	 * Do not change `ttl` on a deployed store: items from before the change keep
	 * their expiry in the old attribute and stop expiring.
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
	 * the configured `schema`. Writes (`put` and `putBatch`) always validate. This
	 * option governs the read side, which matters after a schema change: a row
	 * written under an older schema may no longer conform to the current output
	 * type.
	 *
	 * - **`'coerce'`** (default): pass each stored item through the schema and
	 *   return its output. For a schema that transforms its input, such as a Zod
	 *   schema, this fills `.default()`s and narrows types. The value then satisfies
	 *   the output type, and a read-modify-write cycle (`get()`, change the value,
	 *   `put()`) works. **Never throws:** an item that fails validation is returned
	 *   **as-is** with a warning, so rows from an older schema stay readable for
	 *   migration.
	 * - **`'strict'`**: validate on read and **throw** `ValidationFailedException`
	 *   on any item that doesn't satisfy the schema. For tables where a mismatch
	 *   should be treated as corruption or tampering and rejected rather than
	 *   absorbed. Note this makes a single bad row fail the whole `query`, `scan`,
	 *   or `getBatch`.
	 * - **`'off'`**: return the raw stored value with no validation (lowest cost).
	 *   Use for hot paths, data you trust was written through this schema, or to
	 *   read items you can't yet coerce during a migration.
	 *
	 * Defaults to `'coerce'`.
	 *
	 * > **Best-effort coercion (validator-dependent).** Coercion relies on the
	 * > schema *transforming* its input. Zod fills defaults and casts. A check-only
	 * > Standard Schema validator (some Valibot and ArkType schemas) validates
	 * > without transforming, so `'coerce'` returns the value unchanged for those.
	 * > It never invents data. A required field with no default is never fabricated:
	 * > under `'coerce'` such a row is returned raw with a warning, and under
	 * > `'strict'` the read throws.
	 *
	 * @example
	 * ```typescript
	 * const orders = new KVStore(scope, 'orders', {
	 *   schema: orderSchemaV2,        // adds `currency: z.string().default('USD')`
	 *   key: { partitionKey: 'orderId' },
	 *   // readValidation: 'coerce' is the default
	 * });
	 * const order = await orders.get({ orderId: 'o1' }); // a row from the old schema gets currency: 'USD'
	 * await orders.put({ orderId: 'o1' }, { ...order, total: 20 }); // the value passes validation
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
// biome-ignore lint/complexity/noBannedTypes: `{}` is the empty index map (no index declared)
export type KVStoreOptions<In = string, Out = In, K = undefined, I = {}> = TableOptions &
	(
		| { schema?: undefined; key?: undefined; indexes?: undefined; ttl?: undefined; readValidation?: undefined }
		| SchemaOptions<In, Out, K, I>
	);

/**
 * Constructor options of `LegacyKVStore`: the options that `KVStore` took in
 * release 0.4.0 or earlier. Keep the options that the old store had, with
 * their values. The block declares the table of the old store from them, and
 * a difference makes CloudFormation change that table.
 */
export interface LegacyKVStoreOptions<T = string> {
	/**
	 * The schema of the old store. It gives the value type `T`, and `put`
	 * validates a value with it before the write, as in release 0.4.0. A read
	 * does not validate.
	 */
	schema?: StandardSchemaV1<T>;
	/** The table that the old store wrapped, if it wrapped one. Keep `KVStore.fromExisting(tableName)` as it is. */
	table?: ExternalTableRef;
	/**
	 * The logger of the old store. The local mock reports a data file that it
	 * cannot read with it. The AWS runtime logs nothing.
	 */
	logger?: ChildLogger;
	/**
	 * The `removalPolicy` of the old store, if it had one. When omitted, the
	 * stack-wide `defaults` apply, as in release 0.4.0 (`production` retains the
	 * table, `sandbox` destroys it). It decides what happens to the table when
	 * you remove the `LegacyKVStore`: a table with `'destroy'` is deleted, and a
	 * table with `'retain'` stays in the account.
	 */
	removalPolicy?: 'destroy' | 'retain';
	/** The `deletionProtection` of the old store, if it had one. When omitted, the stack-wide `defaults` apply. */
	deletionProtection?: boolean;
	/** Set if the old store had `ttl: true`: the table has DynamoDB Time-to-Live on the attribute `ttl`. */
	ttl?: boolean;
	/** The `pointInTimeRecovery` of the old store, if it had one. When omitted, the stack-wide `defaults` apply. */
	pointInTimeRecovery?: boolean | { retentionDays: number };
	/**
	 * The `encryption` of the old store, if it had one. Keep a key from
	 * `KVStore.fromKmsKey()` as it is.
	 */
	encryption?: 'aws-managed' | 'customer-managed' | ExternalKmsKeyRef;
}

/**
 * Options of `LegacyKVStore.put`: the options that `put` took in release
 * 0.4.0.
 *
 * `ttlSeconds` and `expiresAt` exclude each other. When both `ifNotExists` and
 * `ifValueEquals` are set they compose with OR, as in that release: the write
 * succeeds if the key is absent or its current value matches.
 */
export type LegacyKVStorePutOptions<T = unknown> = Expiry & {
	/** Only write if the key does not exist. */
	ifNotExists?: boolean;
	/**
	 * Only write if the current value serializes equal to this value. The
	 * compare is on the JSON text, so the order of the keys of an object matters.
	 */
	ifValueEquals?: T;
};

/**
 * Conditions of `LegacyKVStore.delete`: the conditions that `delete` took in
 * release 0.4.0. When both are set, both must hold.
 */
export type LegacyKVStoreDeleteOptions<T = unknown> = {
	/** Only delete if the key exists. */
	ifExists?: boolean;
	/**
	 * Only delete if the current value serializes equal to this value. The
	 * compare is on the JSON text, so the order of the keys of an object matters.
	 */
	ifValueEquals?: T;
};
