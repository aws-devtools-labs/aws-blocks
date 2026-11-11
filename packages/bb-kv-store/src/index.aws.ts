// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildLogger } from '@aws-blocks/bb-logger';
import { Logger } from '@aws-blocks/bb-logger';
import type { ScopeParent } from '@aws-blocks/core';
import { getSdkIdentifiers, installClientUserAgent, registerSdkIdentifiers, Scope } from '@aws-blocks/core';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
	BatchGetCommand,
	BatchWriteCommand,
	DeleteCommand,
	DynamoDBDocumentClient,
	GetCommand,
	PutCommand,
	QueryCommand,
	ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
	applyReadValidation,
	blocksError,
	conditionalCheckFailed,
	KVStoreErrors,
	KVStoreMessages,
	remapItemTooLarge,
	validateSchema,
} from './errors.js';
import {
	buildItem,
	decodeCursor,
	deleteCondition,
	encodeCursor,
	type Item,
	itemExpired,
	type KeyModel,
	type KeyValue,
	keyOfItem,
	mergeKeyIntoValue,
	normalizeKey,
	PagedResults,
	type Positioned,
	planQuery,
	putCondition,
	type QueryPlan,
	type ReadEntry,
	readItem,
	resolveKeyModel,
	serializeKey,
} from './item.js';
import { resolveTtlEpochSeconds } from './ttl.js';
import type {
	ConditionalDeleteOptions,
	Entry,
	Expiry,
	ExternalKmsKeyRef,
	ExternalTableRef,
	GetOptions,
	IndexConfig,
	KeyConfig,
	KeyOf,
	KVStoreOptions,
	PutBatchEntry,
	PutOptions,
	QueryOptions,
	ReadValidationMode,
	Results,
	ScanOptions,
	ValueOf,
} from './types.js';
import { BB_NAME, BB_VERSION } from './version.js';

// Re-export public types and errors
export { KVStoreErrors } from './errors.js';
export type {
	AtLeastOne,
	ConditionalDeleteOptions,
	ConditionalWriteOptions,
	DeleteOptions,
	Entry,
	Expiry,
	ExternalKmsKeyRef,
	ExternalTableRef,
	FieldsOf,
	GetOptions,
	IndexConfig,
	IndexField,
	IsRecord,
	KeyConfig,
	KeyField,
	KeyOf,
	KVStoreOptions,
	NumberField,
	OneOf,
	OtherPart,
	Page,
	PartitionCondition,
	PutBatchEntry,
	PutOptions,
	QueryOptions,
	ReadValidationMode,
	RecordPart,
	Results,
	ScanOptions,
	SchemaOptions,
	SortCondition,
	TableOptions,
	ValueCheck,
	ValueOf,
	Where,
} from './types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

// DynamoDB batch API limits and retry tuning.
// BatchGetItem accepts up to 100 keys per call; BatchWriteItem up to 25 requests.
// Both can return UnprocessedKeys/UnprocessedItems on partial success (e.g. throttling
// or the 16 MB response cap), which the caller must resubmit with backoff.
// See: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Programming.Errors.html#Programming.Errors.BatchOperations
const BATCH_GET_MAX_KEYS = 100;
const BATCH_WRITE_MAX_REQUESTS = 25;
const MAX_BATCH_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 50;
const MAX_BACKOFF_MS = 5000;

/** Split an array into chunks of at most `size` elements. */
function chunked<U>(items: U[], size: number): U[][] {
	const chunks: U[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

/**
 * Key-value and document storage backed by DynamoDB, with optional secondary
 * indexes.
 *
 * **When to use:** Any data that you read by key. With no options, `KVStore`
 * is a string-keyed store for caches, sessions, feature flags, and config
 * values — fast, single-key lookups with simple get/put/delete semantics. With
 * a `schema` and a `key`, it holds app records that you list or query as a
 * collection, such as todos, orders, or messages: entities with composite
 * keys, time-series data, and sort-key-based range queries. Add `indexes` to
 * read the same records by other fields, for access patterns that require
 * multiple indexes.
 *
 * **Declare a key for anything you list.** A store fixes its key when you
 * create it. A store with a string key reads one item for each key, and it
 * cannot list its keys in order or by prefix.
 *
 * **When NOT to use:** If you need full SQL (joins, aggregations, or a
 * transaction across tables), use `Database`.
 *
 * **Best practices:**
 * - Keep string keys short and descriptive (e.g., `user:{id}`, `session:{token}`);
 *   a prefix in a string key does not give a list by prefix
 * - Design partition keys for even data distribution (e.g., `userId`, `tenantId`)
 * - Use sort keys for range queries (e.g., timestamps, alphabetical ordering)
 * - Define indexes upfront for known access patterns — DynamoDB fills a new
 *   index from the items that exist, and leaves out each item whose indexed
 *   field is absent, empty, or of the wrong type
 * - Store one logical entity per KVStore instance
 * - Use `{ ifNotExists: true }` for idempotent creates
 * - Use `{ ifFieldEquals }` with a version field for optimistic locking
 *   (compare-and-swap) on an object value, and `{ ifValueEquals }` on any other value
 *
 * **Scaling:** PAY_PER_REQUEST billing. Single-digit ms reads/writes.
 * Throughput scales automatically. Items limited to 400 KB.
 * Indexes have separate throughput and may throttle independently.
 */
export class KVStore<
	In = string,
	Out = In,
	K extends KeyConfig<In, Out> | undefined = undefined,
	I extends Record<string, IndexConfig<In, Out>> = {},
> extends Scope {
	readonly bbName = BB_NAME;
	private schema?: StandardSchemaV1<In, Out>;
	private model: KeyModel;
	private readValidation: ReadValidationMode;
	private docClient: DynamoDBDocumentClient;
	/** @internal Logger for internal operations. Defaults to warn-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options?: KVStoreOptions<In, Out, K, I>) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		// Default level is 'warn' (not 'error') so the readValidation='coerce'
		// raw-fallback warning actually surfaces — it's the only log the block
		// emits, so this doesn't add noise. Callers can pass their own logger.
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'warn' });
		const tableName = options?.table ? options.table.tableName : this.fullId.substring(0, 255);
		registerSdkIdentifiers(this.fullId, { tableName });
		this.schema = options?.schema;
		this.model = resolveKeyModel(options as Parameters<typeof resolveKeyModel>[0]);
		this.readValidation = options?.readValidation ?? 'coerce';
		const client = new DynamoDBClient({
			customUserAgent: this.buildUserAgentChain(),
		});
		installClientUserAgent(client);
		// Drop undefined attributes on marshalling, as JSON does, so an optional
		// field left undefined does not fail the write.
		this.docClient = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
	}

	/**
	 * Retrieve a value by key.
	 *
	 * A strongly consistent read by default (`ConsistentRead: true`), so it
	 * returns a value that a `put` wrote a moment before; pass
	 * `{ consistentRead: false }` where a stale value is acceptable at half the
	 * read cost. Items whose expiry has passed are treated as absent even if
	 * DynamoDB has not reaped them yet (deletion is asynchronous, typically
	 * within 48 hours).
	 *
	 * @param key - The key to retrieve: a string, or the key object of a store with a declared `key`.
	 * @param options - `consistentRead` (default `true`).
	 * @returns The value, or `null` if the key does not exist or has expired.
	 * @throws {KVStoreErrors.InvalidQuery} If the key has the wrong shape for this store.
	 */
	async get(key: KeyOf<Out, K>, options?: GetOptions): Promise<Out | null> {
		const result = await this.docClient.send(
			new GetCommand({
				TableName: getSdkIdentifiers(this).tableName,
				Key: normalizeKey(this.model, key),
				ConsistentRead: options?.consistentRead !== false,
			}),
		);
		const item = result.Item as Item | undefined;
		if (!item || itemExpired(this.model, item)) return null;
		return this.reconcileRead(readItem(this.model, item).value);
	}

	/**
	 * Store a value at the given key. Overwrites any existing value unless
	 * conditions are specified.
	 *
	 * On a store with a declared `key`, `put` writes the key fields from the key,
	 * so the value may leave them out; a value whose key field disagrees with the
	 * key is rejected.
	 *
	 * @param key - The key to store.
	 * @param value - The value to store. An object is stored as one attribute per top-level field.
	 * @param options - Optional write conditions and expiry (`ttlSeconds` / `expiresAt`).
	 * @throws {KVStoreErrors.ValidationFailed} If the value fails the schema, disagrees with its key, has a
	 *   top-level field that starts with `_bkv_`, or has an empty string in a key field or an indexed field.
	 * @throws {KVStoreErrors.ItemTooLarge} If the item exceeds the 400 KB DynamoDB per-item size limit.
	 * @throws {KVStoreErrors.InvalidQuery} If `ifValueEquals` is given an object, or `ifFieldEquals` is empty.
	 * @throws {KVStoreErrors.ConditionalCheckFailed} If `ifNotExists` is set (alone) and the key already exists.
	 * @throws {KVStoreErrors.ConditionalCheckFailed} If a value check (`ifFieldEquals` / `ifValueEquals`) is set (alone) and the current value does not match.
	 * @throws {KVStoreErrors.ConditionalCheckFailed} If BOTH `ifNotExists` and a value check are set (they compose with OR), only when the key exists AND its current value does not match.
	 *   All three ConditionalCheckFailed cases serialize to HTTP 409 (Conflict). `retriable` is true whenever a value check participated (a stale-value optimistic-lock conflict; under OR composition the combined failure means the key exists but its value differs, so re-read and retry) and false for a pure `ifNotExists` existence assertion (a blind retry fails identically).
	 * @throws {KVStoreErrors.ValidationFailed} If both `ttlSeconds` and `expiresAt` are set, or either is not a usable time.
	 */
	async put(key: KeyOf<Out, K>, value: ValueOf<In, K>, options?: PutOptions<Out>): Promise<void> {
		const item = await this.prepareWrite(key, value, options);

		// `ifNotExists` and a value check compose with OR: write when the key is
		// absent OR its current value matches — the optimistic "create it, or update
		// it only if unchanged" pattern. (AND would be unsatisfiable: a key can't be
		// both absent and have a matching value.) The expression and the
		// retriability come from item.ts, shared with the mock.
		const condition = putCondition(this.model, options);
		try {
			await this.docClient.send(
				new PutCommand({
					TableName: getSdkIdentifiers(this).tableName,
					Item: item,
					...condition.expression,
				}),
			);
		} catch (err: unknown) {
			// A failed conditional write is a Conflict, not an InternalServerError:
			// map DynamoDB's raw ConditionalCheckFailedException to an ApiError with
			// status 409 so the JSON-RPC serializer emits code 409 instead of 500.
			// Preserve the name (== KVStoreErrors.ConditionalCheckFailed) so
			// isBlocksError() keeps matching, and keep the driver error as `cause`
			// (server-side). DynamoDB collapses every conditional failure under one
			// exception with no sub-reason, so retriability is derived from the
			// conditions THIS call set, matching the mock branch-for-branch.
			if (err instanceof Error && err.name === KVStoreErrors.ConditionalCheckFailed) {
				throw conditionalCheckFailed(condition.retriable, err);
			}
			throw remapItemTooLarge(err);
		}
	}

	/**
	 * Delete a value by key.
	 *
	 * @param key - The key to delete.
	 * @param conditions - Optional delete conditions. `ifExists` and a value check compose with AND.
	 * @throws {KVStoreErrors.InvalidQuery} If the key has the wrong shape, `ifValueEquals` is given an object, or `ifFieldEquals` is empty.
	 * @throws {KVStoreErrors.ConditionalCheckFailed} If `ifExists` is true and the key does not exist. Serializes to HTTP 409 (Conflict), not retriable (a blind retry fails identically).
	 * @throws {KVStoreErrors.ConditionalCheckFailed} If a value check is set and the current value does not match. Serializes to HTTP 409 (Conflict), retriable (optimistic-lock conflict — re-read and retry) unless `ifExists` is also set.
	 */
	async delete(key: KeyOf<Out, K>, conditions?: ConditionalDeleteOptions<Out>): Promise<void> {
		const keyAttrs = normalizeKey(this.model, key);
		// Delete conditions are conjunctive — both `ifExists` and the value check
		// must hold — so they compose with AND, matching the mock.
		const condition = deleteCondition(this.model, conditions);
		try {
			await this.docClient.send(
				new DeleteCommand({
					TableName: getSdkIdentifiers(this).tableName,
					Key: keyAttrs,
					...condition.expression,
				}),
			);
		} catch (err: unknown) {
			// Retriability is derived from the conditions THIS call set (see the
			// put path): existence assertion wins — retriable only for a pure value
			// check and NOT when `ifExists` is also set. Matches the mock path.
			if (err instanceof Error && err.name === KVStoreErrors.ConditionalCheckFailed) {
				throw conditionalCheckFailed(condition.retriable, err);
			}
			throw err;
		}
	}

	/**
	 * Read the items of one partition — of the declared key, or of an index —
	 * in sort order, as an async stream with automatic pagination over
	 * DynamoDB's `LastEvaluatedKey`. The `where` clause names the partition
	 * field with `{ equals }` and at most one condition on the sort field.
	 *
	 * Returns a `Results` object: an async iterable of `{ key, value, expiresAt }`
	 * entries with a `cursor` property. Pass `limit` and the `cursor` of an
	 * earlier call to read the next page. Expired items are hidden. A query is
	 * eventually consistent; a query on an index always is.
	 *
	 * @throws {KVStoreErrors.InvalidQuery} If `options.index` does not exist, the store has no
	 *   declared key and no `index` is given, the `where` clause is missing, the partition key is
	 *   not given as `{ equals: value }`, more than one sort-key condition is supplied (DynamoDB
	 *   allows only one per query — use `between` for ranges), or the cursor does not belong to
	 *   this store, index, and partition.
	 */
	query(options: QueryOptions<Out, K, I>): Results<Out, K> {
		const plan = planQuery(this.model, options as Parameters<typeof planQuery>[1]);
		const cursor = options.cursor;
		const startKey =
			cursor === undefined
				? undefined
				: decodeCursor(this.model, cursor, plan.indexName, {
						field: plan.key.partitionKey,
						value: plan.pkValue,
					});
		return this.page(
			plan.limit,
			startKey,
			(exclusiveStartKey, limit) => this.docClient.send(this.buildQueryCommand(plan, exclusiveStartKey, limit)),
			plan.indexName,
			false,
		);
	}

	/**
	 * Enumerate every item in the table with DynamoDB's native Scan operation.
	 * Reads every item — use sparingly on large datasets; prefer `get` or
	 * `query`. Expired items are skipped even if DynamoDB has not reaped them
	 * yet, unless `includeExpired` is set. Returns a `Results` object with a
	 * `cursor` for the next page.
	 *
	 * @throws {KVStoreErrors.InvalidQuery} If the cursor does not belong to this store.
	 */
	scan(options?: ScanOptions): Results<Out, K> {
		const startKey =
			options?.cursor === undefined ? undefined : decodeCursor(this.model, options.cursor, undefined);
		return this.page(
			options?.limit,
			startKey,
			(exclusiveStartKey, limit) =>
				this.docClient.send(
					new ScanCommand({
						TableName: getSdkIdentifiers(this).tableName,
						ExclusiveStartKey: exclusiveStartKey,
						Limit: limit,
					}),
				),
			undefined,
			options?.includeExpired === true,
		);
	}

	/**
	 * Fetch multiple values by key in batches. Returns results positionally —
	 * `null` for a key with no matching item or an expired one. Eventually
	 * consistent.
	 *
	 * @throws {KVStoreErrors.InvalidQuery} If a key has the wrong shape for this store.
	 * @throws {KVStoreErrors.BatchIncomplete} If DynamoDB leaves keys unprocessed after the retry budget
	 *   is exhausted, typically under sustained throttling.
	 */
	async getBatch(keys: KeyOf<Out, K>[]): Promise<(Out | null)[]> {
		const results = new Map<string, Item>();
		const tableName = getSdkIdentifiers(this).tableName;
		const keyAttrs = keys.map((key) => normalizeKey(this.model, key));

		for (const chunk of chunked(keyAttrs, BATCH_GET_MAX_KEYS)) {
			await this.retryUnprocessed('getBatch', chunk, async (pendingKeys) => {
				const resp = await this.docClient.send(
					new BatchGetCommand({
						RequestItems: { [tableName]: { Keys: pendingKeys } },
					}),
				);
				for (const item of resp.Responses?.[tableName] ?? []) {
					results.set(serializeKey(this.model, keyOfItem(this.model, item as Item)), item as Item);
				}
				return resp.UnprocessedKeys?.[tableName]?.Keys as Record<string, KeyValue>[] | undefined;
			});
		}
		return Promise.all(
			keyAttrs.map((attrs) => {
				const item = results.get(serializeKey(this.model, attrs));
				if (!item || itemExpired(this.model, item)) return null;
				return this.reconcileRead(readItem(this.model, item).value);
			}),
		);
	}

	/**
	 * Write multiple values in batches. Each entry is `{ key, value }` plus an
	 * optional expiry (`ttlSeconds` or `expiresAt`). Every value is validated
	 * first, so nothing is written when one entry fails. Batch writes take no
	 * conditions (DynamoDB's `BatchWriteItem` cannot carry a condition expression).
	 *
	 * @throws {KVStoreErrors.ValidationFailed} As for `put`.
	 * @throws {KVStoreErrors.ItemTooLarge} If an item exceeds 400 KB.
	 * @throws {KVStoreErrors.BatchIncomplete} If DynamoDB leaves writes unprocessed after the retry budget
	 *   is exhausted, typically under sustained throttling.
	 */
	async putBatch(entries: PutBatchEntry<In, Out, K>[]): Promise<void> {
		const items: Item[] = [];
		for (const entry of entries) items.push(await this.prepareWrite(entry.key, entry.value, entry));
		const tableName = getSdkIdentifiers(this).tableName;

		for (const chunk of chunked(items, BATCH_WRITE_MAX_REQUESTS)) {
			await this.retryUnprocessed(
				'putBatch',
				chunk.map((item) => ({ PutRequest: { Item: item } })),
				async (requests) => {
					try {
						const resp = await this.docClient.send(
							new BatchWriteCommand({
								RequestItems: { [tableName]: requests },
							}),
						);
						return resp.UnprocessedItems?.[tableName] as typeof requests | undefined;
					} catch (err: unknown) {
						throw remapItemTooLarge(err);
					}
				},
			);
		}
	}

	/**
	 * Delete multiple values by key in batches.
	 *
	 * @throws {KVStoreErrors.InvalidQuery} If a key has the wrong shape for this store.
	 * @throws {KVStoreErrors.BatchIncomplete} If DynamoDB leaves deletes unprocessed after the retry budget
	 *   is exhausted, typically under sustained throttling.
	 */
	async deleteBatch(keys: KeyOf<Out, K>[]): Promise<void> {
		const tableName = getSdkIdentifiers(this).tableName;
		const keyAttrs = keys.map((key) => normalizeKey(this.model, key));

		for (const chunk of chunked(keyAttrs, BATCH_WRITE_MAX_REQUESTS)) {
			await this.retryUnprocessed(
				'deleteBatch',
				chunk.map((attrs) => ({ DeleteRequest: { Key: attrs } })),
				async (requests) => {
					const resp = await this.docClient.send(
						new BatchWriteCommand({
							RequestItems: { [tableName]: requests },
						}),
					);
					return resp.UnprocessedItems?.[tableName] as typeof requests | undefined;
				},
			);
		}
	}

	/**
	 * Wrap an existing DynamoDB table. KVStore will not create or manage
	 * infrastructure for this table. Pass the `key` option that matches the
	 * table's key schema.
	 *
	 * @param tableName - The name of the existing DynamoDB table.
	 */
	static fromExisting(tableName: string): ExternalTableRef {
		return { __brand: 'ExternalTableRef' as const, tableName };
	}

	/**
	 * Reference an existing customer-managed KMS key to encrypt the table. Pass
	 * the result as the `encryption` option so several stores can share one key.
	 */
	static fromKmsKey(keyArn: string): ExternalKmsKeyRef {
		return { __brand: 'ExternalKmsKeyRef' as const, keyArn };
	}

	// ── Internal ────────────────────────────────────────────────────────────

	/**
	 * Validate a write and build its stored item. Schema validation runs
	 * client-side before any DynamoDB call, then the layout checks. The 400 KB
	 * limit is DynamoDB's; its `ValidationException` is re-mapped on the way back.
	 */
	private async prepareWrite(key: KeyOf<Out, K>, value: unknown, expiry: Expiry | undefined): Promise<Item> {
		const keyAttrs = normalizeKey(this.model, key);
		const full = mergeKeyIntoValue(this.model, keyAttrs, value);
		await validateSchema(this.schema, full);
		return buildItem(this.model, keyAttrs, full, resolveTtlEpochSeconds(expiry));
	}

	/**
	 * Reconcile a stored value with the schema per this store's `readValidation`
	 * mode (`off` → raw, `coerce` → coerced output / raw+warn on failure, `strict`
	 * → throw on mismatch). `null` (a missing item) passes straight through. See
	 * {@link applyReadValidation}.
	 */
	private reconcileRead(value: unknown): Promise<Out | null> {
		return applyReadValidation(this.readValidation, this.schema, value, this.log, { store: this.fullId });
	}

	/**
	 * Page through a Query or Scan: follow `LastEvaluatedKey` until `limit`
	 * entries have been yielded or the read reaches the end, hiding expired
	 * items. The cursor of the result is the position after the last entry
	 * yielded when the read stopped at `limit`.
	 */
	private page(
		limit: number | undefined,
		startKey: Record<string, KeyValue> | undefined,
		send: (
			exclusiveStartKey: Record<string, unknown> | undefined,
			limit: number | undefined,
		) => Promise<{ Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> }>,
		indexName: string | undefined,
		includeExpired: boolean,
	): Results<Out, K> {
		const model = this.model;
		const reconcile = (value: unknown) => this.reconcileRead(value);
		return new PagedResults<Entry<Out, K>>(async function* (): AsyncGenerator<Positioned<Entry<Out, K>>, boolean> {
			let lastEvaluatedKey: Record<string, unknown> | undefined = startKey;
			let count = 0;
			do {
				const result = await send(lastEvaluatedKey, limit === undefined ? undefined : limit - count);
				for (const raw of result.Items ?? []) {
					const item = raw as Item;
					if (!includeExpired && itemExpired(model, item)) continue;
					const read: ReadEntry = readItem(model, item);
					const entry = { ...read, value: await reconcile(read.value) } as Entry<Out, K>;
					yield { entry, position: encodeCursor(model, indexName, item) };
					if (limit !== undefined && ++count >= limit) return true;
				}
				lastEvaluatedKey = result.LastEvaluatedKey;
			} while (lastEvaluatedKey);
			return false;
		});
	}

	private backoff(attempt: number): Promise<void> {
		// Exponential backoff with equal jitter: keep half the delay as a floor and
		// randomise the other half. Full jitter (random * cap) can collapse to ~0ms
		// and lets concurrent callers re-collide; equal jitter preserves a minimum
		// spacing while still de-synchronising retries under shared throttling.
		// See: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Programming.Errors.html#Programming.Errors.BatchOperations
		const capped = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
		const ms = capped / 2 + Math.random() * (capped / 2);
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Run a DynamoDB batch operation, resubmitting any unprocessed entries with
	 * exponential backoff. DynamoDB batch APIs can succeed partially (HTTP 200 with
	 * UnprocessedKeys/UnprocessedItems) under throttling or the 16 MB response cap,
	 * so the leftovers must be retried by the caller.
	 *
	 * If entries remain unprocessed after MAX_BATCH_ATTEMPTS, this throws a
	 * BatchIncomplete error rather than returning quietly: for writes/deletes a
	 * silent return would drop data, and for reads it would be indistinguishable
	 * from a missing item. Callers should back off and resubmit.
	 * See: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Programming.Errors.html#Programming.Errors.BatchOperations
	 *
	 * @param operation Human-readable operation name used in the exhaustion error.
	 * @param initial Entries to submit on the first attempt.
	 * @param send Performs one batch call and returns the entries DynamoDB did not process.
	 */
	private async retryUnprocessed<E>(
		operation: string,
		initial: E[],
		send: (pending: E[]) => Promise<E[] | undefined>,
	): Promise<void> {
		let pending: E[] | undefined = initial;
		for (let attempt = 0; attempt < MAX_BATCH_ATTEMPTS && pending && pending.length > 0; attempt++) {
			if (attempt > 0) await this.backoff(attempt);
			pending = await send(pending);
		}
		if (pending && pending.length > 0) {
			throw blocksError(
				KVStoreErrors.BatchIncomplete,
				KVStoreMessages.batchIncomplete(operation, pending.length, MAX_BATCH_ATTEMPTS),
			);
		}
	}

	private buildQueryCommand(
		plan: QueryPlan,
		exclusiveStartKey: Record<string, unknown> | undefined,
		limit: number | undefined,
	): QueryCommand {
		let expr = '#pk = :pkval';
		const names: Record<string, string> = { '#pk': plan.key.partitionKey };
		const values: Record<string, unknown> = { ':pkval': plan.pkValue };

		const sk = plan.skCondition as Record<string, unknown> | undefined;
		if (plan.key.sortKey && sk) {
			names['#sk'] = plan.key.sortKey;
			if ('equals' in sk && sk.equals !== undefined) {
				expr += ' AND #sk = :skval';
				values[':skval'] = sk.equals;
			} else if ('greaterThan' in sk && sk.greaterThan !== undefined) {
				expr += ' AND #sk > :skval';
				values[':skval'] = sk.greaterThan;
			} else if ('greaterThanOrEqual' in sk && sk.greaterThanOrEqual !== undefined) {
				expr += ' AND #sk >= :skval';
				values[':skval'] = sk.greaterThanOrEqual;
			} else if ('lessThan' in sk && sk.lessThan !== undefined) {
				expr += ' AND #sk < :skval';
				values[':skval'] = sk.lessThan;
			} else if ('lessThanOrEqual' in sk && sk.lessThanOrEqual !== undefined) {
				expr += ' AND #sk <= :skval';
				values[':skval'] = sk.lessThanOrEqual;
			} else if ('between' in sk && Array.isArray(sk.between)) {
				expr += ' AND #sk BETWEEN :skval1 AND :skval2';
				values[':skval1'] = sk.between[0];
				values[':skval2'] = sk.between[1];
			} else if ('beginsWith' in sk && sk.beginsWith !== undefined) {
				expr += ' AND begins_with(#sk, :skval)';
				values[':skval'] = sk.beginsWith;
			}
		}

		return new QueryCommand({
			TableName: getSdkIdentifiers(this).tableName,
			IndexName: plan.indexName || undefined,
			KeyConditionExpression: expr,
			ExpressionAttributeNames: names,
			ExpressionAttributeValues: values,
			ExclusiveStartKey: exclusiveStartKey,
			Limit: limit,
			ScanIndexForward: plan.order === 'desc' ? false : undefined,
		});
	}
}
