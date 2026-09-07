// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope, registerSdkIdentifiers } from '@aws-blocks/core';
import { getMockDataDir } from '@aws-blocks/core/bb-utils';
import type { ScopeParent } from '@aws-blocks/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BB_NAME, BB_VERSION } from './version.js';

export { DistributedTableErrors } from './errors.js';
export type {
	TableKeyConfig,
	DistributedTableOptions,
	ReadValidationMode,
	ExternalTableRef,
	ExternalKmsKeyRef,
	TableKey,
	PartitionKeyCondition,
	SortKeyCondition,
	KeyCondition,
	QueryOptions,
	ScanOptions,
	PutOptions,
	DeleteOptions,
} from './types.js';

import type {
	TableKeyConfig,
	DistributedTableOptions,
	ExternalTableRef,
	ExternalKmsKeyRef,
	SortKeyCondition,
	ScanOptions,
	PutOptions,
	DeleteOptions,
	TableKey,
	ReadValidationMode,
} from './types.js';
import { DistributedTableErrors, DistributedTableMessages, blocksError, normalizeSortKeyCondition, applyReadValidation } from './errors.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const MAX_ITEM_BYTES = 400 * 1024;

async function validateSchema<T>(schema: StandardSchemaV1<T>, value: unknown): Promise<void> {
	const result = schema['~standard'].validate(value);
	const resolved = result instanceof Promise ? await result : result;
	if (resolved.issues) {
		throw blocksError(DistributedTableErrors.ValidationFailed, resolved.issues[0].message);
	}
}

function matchesSortKeyCondition(value: any, condition: SortKeyCondition<any>): boolean {
	if ('equals' in condition && condition.equals !== undefined && value !== condition.equals) return false;
	if ('greaterThan' in condition && condition.greaterThan !== undefined && !(value > condition.greaterThan)) return false;
	if ('greaterThanOrEqual' in condition && condition.greaterThanOrEqual !== undefined && !(value >= condition.greaterThanOrEqual)) return false;
	if ('lessThan' in condition && condition.lessThan !== undefined && !(value < condition.lessThan)) return false;
	if ('lessThanOrEqual' in condition && condition.lessThanOrEqual !== undefined && !(value <= condition.lessThanOrEqual)) return false;
	if ('between' in condition && condition.between && !(value >= condition.between[0] && value <= condition.between[1])) return false;
	if ('beginsWith' in condition && condition.beginsWith !== undefined) {
		if (typeof value !== 'string' || !value.startsWith(condition.beginsWith as string)) return false;
	}
	return true;
}

/**
 * Order-independent structural equality, used to compare `ifFieldEquals` values
 * against stored attributes. DynamoDB Maps are an unordered collection of
 * name-value pairs, so `{ a, b }` and `{ b, a }` are the same value — a plain
 * `JSON.stringify` compare would wrongly treat them as different and fail the
 * condition. Arrays remain order-sensitive (DynamoDB Lists are ordered).
 */
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b) return false;
	if (a === null || b === null) return a === b;

	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((v, i) => deepEqual(v, b[i]));
	}

	if (typeof a === 'object' && typeof b === 'object') {
		const aKeys = Object.keys(a as object);
		const bKeys = Object.keys(b as object);
		if (aKeys.length !== bKeys.length) return false;
		return aKeys.every(k =>
			Object.prototype.hasOwnProperty.call(b, k) &&
			deepEqual((a as any)[k], (b as any)[k]),
		);
	}

	return false;
}

// ── DistributedTable (mock) ─────────────────────────────────────────────────

/**
 * Structured data storage backed by DynamoDB with secondary indexes and
 * rich query capabilities.
 *
 * **When to use:** You need to query by multiple fields, use composite keys,
 * or perform sort-key-based range queries. Good for entities with relationships,
 * time-series data, and access patterns that require multiple indexes.
 *
 * **When NOT to use:** If you only need single-key lookups, use `KVStore`.
 * If you need full SQL (joins, aggregations), use `Database`.
 *
 * **Best practices:**
 * - Design partition keys for even data distribution (e.g., `userId`, `tenantId`)
 * - Use sort keys for range queries (e.g., timestamps, alphabetical ordering)
 * - Define GSIs upfront for known access patterns — adding them later requires backfill
 * - Use `{ ifNotExists: true }` for idempotent creates
 * - Use `{ ifFieldEquals }` for optimistic locking (compare-and-swap)
 *
 * **Scaling:** PAY_PER_REQUEST billing. Single-digit ms reads/writes.
 * Throughput scales automatically. Items limited to 400 KB.
 * GSIs have separate throughput and may throttle independently.
 */
export class DistributedTable<
	T,
	K extends TableKeyConfig<T> = TableKeyConfig<T>,
	Indexes extends Record<string, TableKeyConfig<T>> = Record<string, TableKeyConfig<T>>,
> extends Scope {
	private filePath: string;
	private data: Map<string, T>;
	private schema: StandardSchemaV1<T>;
	private keyConfig: K;
	private indexes: Indexes;
	private readValidation: ReadValidationMode;

	/** @internal Logger for internal operations. Defaults to warn-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, public options: DistributedTableOptions<T, K, Indexes>) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		// Default level is 'warn' (not 'error') so the readValidation='coerce'
		// raw-fallback warning actually surfaces — it's the only log the block
		// emits, so this doesn't add noise. Callers can pass their own logger.
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'warn' });
		this.filePath = join(getMockDataDir(this), 'data.json');
		this.data = this.loadFromDisk();
		this.schema = options.schema;
		this.keyConfig = options.key;
		this.indexes = (options.indexes ?? {}) as Indexes;
		this.readValidation = options.readValidation ?? 'coerce';
		registerSdkIdentifiers(this.fullId, { tableName: `mock-${this.fullId}`.substring(0, 255) });
	}

	async get(key: TableKey<T, K>): Promise<T | null> {
		return this.reconcileRead(this.data.get(this.serializeKey(key)) ?? null);
	}

	/**
	 * Reconcile a stored value with the schema per this table's `readValidation`
	 * mode (`off` → raw, `coerce` → coerced output / raw+warn on failure, `strict`
	 * → throw on mismatch). `null` (a missing item) passes straight through. See
	 * {@link applyReadValidation}.
	 */
	private reconcileRead(item: T | null): Promise<T | null> {
		return applyReadValidation(this.readValidation, this.schema, item, this.log, { table: this.fullId });
	}

	async put(item: T, options?: PutOptions<T>): Promise<void> {
		await validateSchema(this.schema, item);

		const serialized = JSON.stringify(item);
		if (Buffer.byteLength(serialized, 'utf8') > MAX_ITEM_BYTES) {
			throw blocksError(DistributedTableErrors.ItemTooLarge, DistributedTableMessages.itemTooLarge(Buffer.byteLength(serialized, 'utf8')));
		}

		const keyStr = this.serializeKey(item as any);

		if (options?.ifNotExists && this.data.has(keyStr)) {
			throw blocksError(DistributedTableErrors.ConditionalCheckFailed, 'The conditional request failed');
		}
		if (options?.ifFieldEquals) {
			this.checkFieldEquals(keyStr, options.ifFieldEquals);
		}

		this.data.set(keyStr, item);
		this.flushToDisk();
	}

	async delete(key: TableKey<T, K>, options?: DeleteOptions<T>): Promise<void> {
		const keyStr = this.serializeKey(key);

		if (options?.ifExists && !this.data.has(keyStr)) {
			throw blocksError(DistributedTableErrors.ConditionalCheckFailed, 'The conditional request failed');
		}
		if (options?.ifFieldEquals) {
			this.checkFieldEquals(keyStr, options.ifFieldEquals);
		}

		this.data.delete(keyStr);
		this.flushToDisk();
	}

	/**
	 * Query items by index. The input object's fields are determined by the index:
	 * - Partition key field: required, `{ equals: value }`
	 * - Sort key field (if defined): optional, supports `equals`, `greaterThan`,
	 *   `lessThan`, `between`, `beginsWith` (strings only), etc.
	 *
	 * @example
	 * ```typescript
	 * // Primary key query
	 * for await (const item of table.query({ where: { userId: { equals: 'u1' } } })) { ... }
	 *
	 * // GSI query with limit and reverse order
	 * for await (const item of table.query({
	 *   index: 'byStatus',
	 *   where: { status: { equals: 'pending' } },
	 *   limit: 10,
	 *   order: 'desc',
	 * })) { ... }
	 * ```
	 *
	 * @throws {DistributedTableErrors.InvalidQuery} If `options.index` does not exist,
	 *   the `where` clause is missing, the partition key is not given as
	 *   `{ equals: value }`, or more than one sort-key condition is supplied
	 *   (DynamoDB allows only one per query — use `between` for ranges).
	 */
	async *query(
		options: QueryOptions<T, K, Indexes>,
	): AsyncIterable<T> {
		const indexConfig = options.index ? this.indexes[options.index as keyof Indexes] : this.keyConfig;
		if (!indexConfig) throw blocksError(DistributedTableErrors.InvalidQuery, DistributedTableMessages.indexNotFound(options.index));

		const pkField = indexConfig.partitionKey;
		const skField = indexConfig.sortKey;

		if (!options.where) {
			throw blocksError(DistributedTableErrors.InvalidQuery, DistributedTableMessages.whereRequired(pkField));
		}
		const pkValue = (options.where as any)[pkField]?.equals;
		if (pkValue === undefined) {
			throw blocksError(DistributedTableErrors.InvalidQuery, DistributedTableMessages.partitionKeyEqualsRequired(pkField));
		}

		// Normalize the sort-key condition up front — before scanning data — so the
		// mock behaves identically to the AWS runtime regardless of stored data:
		// a present-but-empty condition ({} / all-undefined) becomes "no filter"
		// (query the whole partition) and multiple conditions are rejected eagerly,
		// even on an empty table or a partition with no matches (where the per-item
		// filter would never run).
		const skCondition = skField
			? normalizeSortKeyCondition((options.where as any)[skField] as SortKeyCondition<any> | undefined)
			: undefined;

		const items: T[] = [];

		for (const item of this.data.values()) {
			if ((item as any)[pkField] !== pkValue) continue;

			if (skField && skCondition) {
				if (!matchesSortKeyCondition((item as any)[skField], skCondition)) continue;
			}

			items.push(item);
		}

		if (skField) {
			const dir = options.order === 'desc' ? -1 : 1;
			items.sort((a, b) => {
				const av = (a as any)[skField], bv = (b as any)[skField];
				const primary = av < bv ? -1 : av > bv ? 1 : 0;
				// Tie-break on the base-table primary key. On a GSI the sort key need
				// not be unique, so equal sort-key values must NOT fall back to Map
				// insertion order (which varies by write order / disk reload) — that's
				// the mock-vs-DynamoDB divergence. DynamoDB orders index ties by the
				// base-table key, and the whole index (ties included) reverses under
				// `order: 'desc'`.
				return (primary !== 0 ? primary : this.compareByBaseKey(a, b)) * dir;
			});
		}

		let count = 0;
		for (const item of items) {
			yield (await this.reconcileRead(item)) as T;
			if (options.limit && ++count >= options.limit) return;
		}
	}

	async *scan(options?: ScanOptions): AsyncIterable<T> {
		let count = 0;
		for (const item of this.data.values()) {
			yield (await this.reconcileRead(item)) as T;
			if (options?.limit && ++count >= options.limit) return;
		}
	}

	/**
	 * Fetch multiple items by key in batches. Returns results positionally —
	 * `null` for keys with no matching item.
	 *
	 * @throws {DistributedTableErrors.BatchIncomplete} (AWS runtime only) If DynamoDB
	 *   leaves keys unprocessed after the retry budget is exhausted, typically under
	 *   sustained throttling. The local mock never throttles, so it does not throw this.
	 */
	async getBatch(keys: TableKey<T, K>[]): Promise<(T | null)[]> {
		return Promise.all(
			keys.map(key => this.reconcileRead(this.data.get(this.serializeKey(key)) ?? null)),
		);
	}

	/**
	 * Write multiple items in batches. Each item is schema-validated first.
	 *
	 * @throws {DistributedTableErrors.BatchIncomplete} (AWS runtime only) If DynamoDB
	 *   leaves writes unprocessed after the retry budget is exhausted, typically under
	 *   sustained throttling. The local mock never throttles, so it does not throw this.
	 */
	async putBatch(items: T[]): Promise<void> {
		for (const item of items) {
			await validateSchema(this.schema, item);
			const serialized = JSON.stringify(item);
			if (Buffer.byteLength(serialized, 'utf8') > MAX_ITEM_BYTES) {
				throw blocksError(DistributedTableErrors.ItemTooLarge, DistributedTableMessages.itemTooLarge(Buffer.byteLength(serialized, 'utf8')));
			}
		}
		for (const item of items) {
			this.data.set(this.serializeKey(item as any), item);
		}
		this.flushToDisk();
	}

	/**
	 * Delete multiple items by key in batches.
	 *
	 * @throws {DistributedTableErrors.BatchIncomplete} (AWS runtime only) If DynamoDB
	 *   leaves deletes unprocessed after the retry budget is exhausted, typically under
	 *   sustained throttling. The local mock never throttles, so it does not throw this.
	 */
	async deleteBatch(keys: TableKey<T, K>[]): Promise<void> {
		for (const key of keys) this.data.delete(this.serializeKey(key));
		this.flushToDisk();
	}

	static fromExisting(tableName: string): ExternalTableRef {
		return { __brand: 'ExternalTableRef' as const, tableName };
	}

	static fromKmsKey(keyArn: string): ExternalKmsKeyRef {
		return { __brand: 'ExternalKmsKeyRef' as const, keyArn };
	}

	// ── Internal ────────────────────────────────────────────────────────────

	private checkFieldEquals(keyStr: string, fields: Partial<T>): void {
		const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
		if (entries.length === 0) {
			throw blocksError(DistributedTableErrors.InvalidQuery, DistributedTableMessages.emptyIfFieldEquals);
		}

		const existing = this.data.get(keyStr);
		if (!existing) {
			throw blocksError(DistributedTableErrors.ConditionalCheckFailed, 'The conditional request failed');
		}
		for (const [field, value] of entries) {
			if (!deepEqual((existing as any)[field], value)) {
				throw blocksError(DistributedTableErrors.ConditionalCheckFailed, 'The conditional request failed');
			}
		}
	}

	/**
	 * Deterministic tie-break for `query` ordering: compare two items by the
	 * base-table primary key (partition key, then sort key). Used when an index
	 * sort-key value is shared by multiple items, so results don't depend on Map
	 * insertion order. Returns a stable -1/0/1.
	 */
	private compareByBaseKey(a: T, b: T): number {
		const pk = this.keyConfig.partitionKey;
		const ap = (a as any)[pk], bp = (b as any)[pk];
		if (ap !== bp) return ap < bp ? -1 : 1;
		const sk = this.keyConfig.sortKey;
		if (sk) {
			const as = (a as any)[sk], bs = (b as any)[sk];
			if (as !== bs) return as < bs ? -1 : 1;
		}
		// Unreachable for distinct rows: every item is keyed by its serialized base
		// primary key, so two different entries always differ in base PK or SK.
		// (String comparisons above use JS UTF-16 order — see DESIGN.md D-DT-6.)
		return 0;
	}

	private serializeKey(key: TableKey<T, K>): string {
		const parts = [(key as any)[this.keyConfig.partitionKey]];
		if (this.keyConfig.sortKey) parts.push((key as any)[this.keyConfig.sortKey]);
		return JSON.stringify(parts);
	}

	private loadFromDisk(): Map<string, T> {
		if (!existsSync(this.filePath)) return new Map();
		try {
			return new Map(JSON.parse(readFileSync(this.filePath, 'utf8')));
		} catch { return new Map(); }
	}

	private flushToDisk(): void {
		writeFileSync(this.filePath, JSON.stringify([...this.data.entries()], null, 2));
	}
}

// ── Query input helper type ─────────────────────────────────────────────────
// This is defined here (not in types.ts) because it needs to resolve the
// Indexes generic from the class. types.ts exports the building blocks;
// this assembles them for the method signature.

import type { PartitionKeyCondition, SortKeyCondition as SKC, KeyCondition, QueryOptions } from './types.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';

