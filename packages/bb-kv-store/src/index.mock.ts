// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { Logger } from '@aws-blocks/bb-logger';
import type { ScopeParent } from '@aws-blocks/core';
import { registerSdkIdentifiers, Scope } from '@aws-blocks/core';
import { assertNotMockInDeployedEnv, getMockDataDir } from '@aws-blocks/core/bb-utils';
import { blocksError, conditionalCheckFailed, isPlainObject, KVStoreErrors, KVStoreMessages } from './errors.js';
import {
	compareKeyValues,
	createReader,
	decodeCursor,
	deleteCondition,
	encodeCursor,
	type Item,
	itemExpired,
	type KeyModel,
	type KeyValue,
	keyFields,
	liveItems,
	matchesSort,
	normalizeKey,
	normalizeLimit,
	PagedResults,
	planQuery,
	prepareItem,
	presentOptions,
	putCondition,
	type Reader,
	resolveKeyModel,
	serializeKey,
	valueCheckHolds,
} from './item.js';
import { nowEpochSeconds } from './ttl.js';
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
	Results,
	ScanOptions,
	ValueOf,
} from './types.js';
import { BB_NAME, BB_VERSION } from './version.js';

// Fail closed if this mock entry loads in a deployed env — see assertNotMockInDeployedEnv.
assertNotMockInDeployedEnv('bb-kv-store');

// ── Public types ────────────────────────────────────────────────────────────

export { KVStoreErrors } from './errors.js';
export type * from './types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const MAX_ITEM_BYTES = 400 * 1024; // DynamoDB 400 KB limit

// ── KVStore (mock) ──────────────────────────────────────────────────────────

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
	// biome-ignore lint/complexity/noBannedTypes: `{}` is the empty index map; `keyof {}` is `never`, so a store without indexes accepts no index name
	I extends Record<string, IndexConfig<In, Out>> = {},
> extends Scope {
	private filePath: string;
	private data: Map<string, Item>;
	private model: KeyModel;
	private reader: Reader<Out, Entry<Out, K>>;
	/** Every item in base-key order, for `scan`. Sorted on first use and dropped on every write. */
	private sorted: Item[] | undefined;
	/** @internal Logger for internal operations. Defaults to warn-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options?: KVStoreOptions<In, Out, K, I>) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		// Default level is 'warn' (not 'error') so the readValidation='coerce'
		// raw-fallback warning actually surfaces — it's the only log the block
		// emits, so this doesn't add noise. Callers can pass their own logger.
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'warn' });
		this.filePath = join(getMockDataDir(this), 'store.json');
		this.model = resolveKeyModel(options);
		this.reader = createReader(this.model, options?.readValidation ?? 'coerce', this.log, { store: this.fullId });
		this.data = this.loadFromDisk();
		registerSdkIdentifiers(this.fullId, { tableName: `mock-${this.fullId}`.substring(0, 255) });
	}

	/**
	 * Retrieve a value by key.
	 *
	 * Items whose expiry has passed are treated as absent, mirroring DynamoDB TTL
	 * (whose reaper is asynchronous, so reads must filter regardless). The
	 * in-memory store is always strongly consistent, so `options.consistentRead`
	 * needs no handling.
	 *
	 * @param key - The key to retrieve: a string, or the key object of a store with a declared `key`.
	 * @param options - `consistentRead` (default `true`); accepted and ignored by the mock.
	 * @returns The value, or `null` if the key does not exist or has expired.
	 * @throws {KVStoreErrors.InvalidQuery} If the key has the wrong shape for this store.
	 */
	async get(key: KeyOf<Out, K>, _options?: GetOptions): Promise<Out | null> {
		return this.reader.value(this.data.get(serializeKey(this.model, normalizeKey(this.model, key))));
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
	 *   top-level field that starts with `_bkv_`, has a field named `__proto__` at any depth (DynamoDB cannot
	 *   store that field name), or has an empty string in a key field or an indexed field.
	 * @throws {KVStoreErrors.ItemTooLarge} If the serialized item exceeds the 400 KB DynamoDB per-item size limit.
	 * @throws {KVStoreErrors.InvalidQuery} If `ifValueEquals` is given an object, or `ifFieldEquals` is empty.
	 * @throws {KVStoreErrors.ConditionalCheckFailed} If `ifNotExists` is set (alone) and the key already exists.
	 * @throws {KVStoreErrors.ConditionalCheckFailed} If a value check (`ifFieldEquals` / `ifValueEquals`) is set (alone) and the current value does not match.
	 * @throws {KVStoreErrors.ConditionalCheckFailed} If BOTH `ifNotExists` and a value check are set (they compose with OR), only when the key exists AND its current value does not match.
	 *   All three ConditionalCheckFailed cases serialize to HTTP 409 (Conflict). `retriable` is true whenever a value check participated (a stale-value optimistic-lock conflict; under OR composition the combined failure means the key exists but its value differs, so re-read and retry) and false for a pure `ifNotExists` existence assertion (a blind retry fails identically).
	 * @throws {KVStoreErrors.ValidationFailed} If both `ttlSeconds` and `expiresAt` are set, or either is not a usable time.
	 */
	async put(key: KeyOf<Out, K>, value: ValueOf<In, K>, options?: PutOptions<Out>): Promise<void> {
		const present = presentOptions(options);
		const { keyStr, item } = await this.prepareWrite(key, value, present);

		// Conditional write. `ifNotExists` and a value check compose with OR
		// (mirrors the AWS `attribute_not_exists(pk) OR <value check>`): the write
		// succeeds when the key is absent OR its current value matches, and fails
		// only when the key exists AND the value differs. Retriability comes from
		// the shared derivation in item.ts so mock and aws agree for identical
		// inputs (incl. the combined case). Conditions see an expired item until
		// DynamoDB deletes it, as on AWS.
		const condition = putCondition(this.model, present);
		if (condition.existence || condition.check) {
			const existing = this.data.get(keyStr);
			const absentOk = condition.existence && existing === undefined;
			const valueOk = condition.check !== undefined && valueCheckHolds(condition.check, existing);
			if (!absentOk && !valueOk) throw conditionalCheckFailed(condition.retriable);
		}

		this.data.set(keyStr, item);
		this.flushToDisk();
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
		const keyStr = serializeKey(this.model, normalizeKey(this.model, key));
		// Existence assertion wins (see put): `ifExists` makes a conflict
		// non-retriable even when combined with a value check.
		const condition = deleteCondition(this.model, presentOptions(conditions));
		const existing = this.data.get(keyStr);
		if (condition.existence && existing === undefined) throw conditionalCheckFailed(condition.retriable);
		if (condition.check && !valueCheckHolds(condition.check, existing)) {
			throw conditionalCheckFailed(condition.retriable);
		}
		this.data.delete(keyStr);
		this.flushToDisk();
	}

	/**
	 * Read the items of one partition — of the declared key, or of an index —
	 * in sort order. The `where` clause names the partition field with
	 * `{ equals }` and at most one condition on the sort field: `equals`,
	 * `greaterThan`, `greaterThanOrEqual`, `lessThan`, `lessThanOrEqual`,
	 * `between`, or `beginsWith` (strings only).
	 *
	 * Returns a `Results` object: an async iterable of `{ key, value, expiresAt }`
	 * entries with a `cursor` property. Pass `limit` and the `cursor` of an
	 * earlier call to read the next page. Expired items are hidden.
	 *
	 * @example
	 * ```typescript
	 * // Query by the declared key
	 * for await (const { value } of store.query({ where: { userId: { equals: 'u1' } } })) { ... }
	 *
	 * // Index query with limit and reverse order
	 * const page = store.query({
	 *   index: 'byStatus',
	 *   where: { status: { equals: 'pending' } },
	 *   limit: 10,
	 *   order: 'desc',
	 * });
	 * const entries = await Array.fromAsync(page);
	 * const next = page.cursor; // undefined at the end
	 * ```
	 *
	 * @throws {KVStoreErrors.InvalidQuery} If `options.index` does not exist, the store has no
	 *   declared key and no `index` is given, the `where` clause is missing, the partition key is
	 *   not given as `{ equals: value }`, more than one sort-key condition is supplied (DynamoDB
	 *   allows only one per query — use `between` for ranges), or the cursor does not belong to
	 *   this store, index, and partition, or `limit` is not a positive integer. Also if the
	 *   partition value or a sort value does not have the type of its field, or if the sort
	 *   condition is not one of the conditions above.
	 * @throws {KVStoreErrors.ValidationFailed} If the partition value or a sort value is an empty string.
	 */
	query(options: QueryOptions<Out, K, I>): Results<Out, K> {
		const plan = planQuery(this.model, presentOptions(options));
		const { key } = plan;
		const direction = plan.order === 'desc' ? -1 : 1;

		// Compare by the queried sort key, then by the base-table key. On an
		// index the sort key need not be unique, so equal sort-key values must NOT
		// fall back to Map insertion order (which varies by write order / disk
		// reload). DynamoDB orders index ties by the base-table key, and the whole
		// index (ties included) reverses under `order: 'desc'`.
		const compare = (a: Item, b: Item): number =>
			((key.sortKey ? compareKeyValues(a[key.sortKey], b[key.sortKey]) : 0) ||
				compareByBaseKey(this.model, a, b)) * direction;

		return this.results(
			() =>
				[...this.data.values()]
					.filter(
						(item) =>
							item[key.partitionKey] === plan.pkValue &&
							(!key.sortKey || (key.sortKey in item && matchesSort(item[key.sortKey], plan.sort))),
					)
					.sort(compare),
			compare,
			plan.startKey,
			plan.limit,
			plan.indexName,
			false,
		);
	}

	/**
	 * Enumerate every item in the store. Reads every item — use sparingly on
	 * large datasets; prefer `get` or `query`. Expired items are skipped unless
	 * `includeExpired` is set. Returns a `Results` object with a `cursor` for the
	 * next page.
	 *
	 * @throws {KVStoreErrors.InvalidQuery} If the cursor does not belong to this store, or `limit` is not a positive integer.
	 */
	scan(options?: ScanOptions): Results<Out, K> {
		// Deterministic order by the base key, so a cursor resumes at the same
		// position after a restart (Map order would follow write order).
		const byBaseKey = (a: Item, b: Item) => compareByBaseKey(this.model, a, b);
		const present = presentOptions(options);
		return this.results(
			() => this.inBaseKeyOrder(byBaseKey),
			byBaseKey,
			decodeCursor(this.model, present?.cursor, undefined),
			normalizeLimit(present?.limit),
			undefined,
			present?.includeExpired === true,
		);
	}

	/**
	 * Fetch multiple values by key. Returns results positionally — `null` for a
	 * key with no matching item or an expired one. Eventually consistent on AWS.
	 *
	 * @throws {KVStoreErrors.InvalidQuery} If a key has the wrong shape for this store.
	 * @throws {KVStoreErrors.BatchIncomplete} (AWS runtime only) If DynamoDB
	 *   leaves keys unprocessed after the retry budget is exhausted, typically under
	 *   sustained throttling. The local mock never throttles, so it does not throw this.
	 */
	async getBatch(keys: KeyOf<Out, K>[]): Promise<(Out | null)[]> {
		const now = nowEpochSeconds();
		return Promise.all(
			keys.map((key) =>
				this.reader.value(this.data.get(serializeKey(this.model, normalizeKey(this.model, key))), now),
			),
		);
	}

	/**
	 * Write multiple values. Each entry is `{ key, value }` plus an optional
	 * expiry (`ttlSeconds` or `expiresAt`). Every value is validated first, so
	 * nothing is written when one entry fails. Batch writes take no conditions.
	 *
	 * @throws {KVStoreErrors.ValidationFailed} As for `put`.
	 * @throws {KVStoreErrors.ItemTooLarge} If an item exceeds 400 KB.
	 * @throws {KVStoreErrors.BatchIncomplete} (AWS runtime only) If DynamoDB
	 *   leaves writes unprocessed after the retry budget is exhausted, typically under
	 *   sustained throttling. The local mock never throttles, so it does not throw this.
	 */
	async putBatch(entries: PutBatchEntry<In, Out, K>[]): Promise<void> {
		const prepared: { keyStr: string; item: Item }[] = [];
		for (const entry of entries) {
			prepared.push(await this.prepareWrite(entry.key, entry.value, presentOptions(entry)));
		}
		for (const { keyStr, item } of prepared) this.data.set(keyStr, item);
		this.flushToDisk();
	}

	/**
	 * Delete multiple values by key.
	 *
	 * @throws {KVStoreErrors.InvalidQuery} If a key has the wrong shape for this store.
	 * @throws {KVStoreErrors.BatchIncomplete} (AWS runtime only) If DynamoDB
	 *   leaves deletes unprocessed after the retry budget is exhausted, typically under
	 *   sustained throttling. The local mock never throttles, so it does not throw this.
	 */
	async deleteBatch(keys: KeyOf<Out, K>[]): Promise<void> {
		for (const key of keys) this.data.delete(serializeKey(this.model, normalizeKey(this.model, key)));
		this.flushToDisk();
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
	 * Validate a write and build its stored item. Schema validation runs first
	 * (matches the AWS entry, which validates client-side before sending), then
	 * the layout checks, then the size check.
	 */
	private async prepareWrite(
		key: KeyOf<Out, K>,
		value: unknown,
		expiry: Expiry | undefined,
	): Promise<{ keyStr: string; item: Item }> {
		const { keyAttrs, item } = await prepareItem(this.model, key, value, expiry);
		const bytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
		if (bytes > MAX_ITEM_BYTES) {
			throw blocksError(KVStoreErrors.ItemTooLarge, KVStoreMessages.itemTooLarge(bytes));
		}
		return { keyStr: serializeKey(this.model, keyAttrs), item };
	}

	/**
	 * The `Results` of a read. `ordered` gives the matching items in read order;
	 * the result hides expired items, starts after the cursor position, and
	 * stops at `limit`. One page holds every item: the mock has no page size.
	 */
	private results(
		ordered: () => Item[],
		compare: (a: Item, b: Item) => number,
		startAfter: Item | undefined,
		limit: number | undefined,
		indexName: string | undefined,
		includeExpired: boolean,
	): Results<Out, K> {
		const model = this.model;
		return new PagedResults<Entry<Out, K>>(
			() => {
				const items = includeExpired ? ordered() : liveItems(model, ordered());
				return [startAfter ? items.filter((item) => compare(item, startAfter) > 0) : items];
			},
			this.reader.entry,
			limit,
			(item) => encodeCursor(model, indexName, item),
		);
	}

	// ── Disk persistence ──────────────────────────────────────────────────

	private loadFromDisk(): Map<string, Item> {
		if (!existsSync(this.filePath)) return new Map();
		try {
			const obj = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, unknown>;
			const entries = new Map<string, Item>();
			if (!isPlainObject(obj)) return entries;
			const now = nowEpochSeconds();
			for (const [key, stored] of Object.entries(obj)) {
				// Skip anything that is not an item (a corrupt or legacy entry).
				if (!isPlainObject(stored) || !keyFields(this.model.table).every((f) => f in stored)) continue;
				// Drop an item whose expiry has passed, as DynamoDB does in the
				// background. Without this the file only grows, and every write
				// rewrites the dead rows.
				if (itemExpired(this.model, stored, now)) continue;
				entries.set(key, stored);
			}
			return entries;
		} catch {
			return new Map();
		}
	}

	/** Every item in base-key order. A full sort for each `scan` is wasted work when nothing was written in between. */
	private inBaseKeyOrder(compare: (a: Item, b: Item) => number): Item[] {
		if (!this.sorted) this.sorted = [...this.data.values()].sort(compare);
		return this.sorted;
	}

	private flushToDisk(): void {
		this.sorted = undefined;
		const obj: Record<string, Item> = {};
		for (const [key, item] of this.data) obj[key] = item;
		writeFileSync(this.filePath, JSON.stringify(obj, null, 2));
	}
}

/**
 * Deterministic tie-break for ordering: compare two items by the base-table
 * key (partition key, then sort key). Returns a stable -1/0/1. (String
 * comparisons use JS UTF-16 order — see DESIGN.md.)
 */
function compareByBaseKey(model: KeyModel, a: Item, b: Item): number {
	for (const field of keyFields(model.table)) {
		const c = compareKeyValues(a[field] as KeyValue, b[field] as KeyValue);
		if (c !== 0) return c;
	}
	return 0;
}
