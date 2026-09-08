// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
	DynamoDBDocumentClient,
	GetCommand,
	PutCommand,
	DeleteCommand,
	QueryCommand,
	ScanCommand,
	BatchGetCommand,
	BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { Scope, registerSdkIdentifiers, getSdkIdentifiers } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
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
	ScanOptions,
	PutOptions,
	DeleteOptions,
	PartitionKeyCondition,
	SortKeyCondition,
	TableKey,
	ReadValidationMode,
} from './types.js';
import { DistributedTableErrors, DistributedTableMessages, blocksError, normalizeSortKeyCondition, remapItemTooLarge, applyReadValidation } from './errors.js';
import type { KeyCondition, QueryOptions } from './types.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';

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

export class DistributedTable<
	T,
	K extends TableKeyConfig<T> = TableKeyConfig<T>,
	Indexes extends Record<string, TableKeyConfig<T>> = Record<string, TableKeyConfig<T>>,
> extends Scope {
	readonly bbName = BB_NAME;
	private schema: StandardSchemaV1<T>;
	private keyConfig: K;
	private indexes: Indexes;
	private readValidation: ReadValidationMode;
	private docClient: DynamoDBDocumentClient;

	/** @internal Logger for internal operations. Defaults to warn-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, public options: DistributedTableOptions<T, K, Indexes>) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		// Default level is 'warn' (not 'error') so the readValidation='coerce'
		// raw-fallback warning actually surfaces — it's the only log the block
		// emits, so this doesn't add noise. Callers can pass their own logger.
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'warn' });
		const tableName = options.table?.tableName ?? this.fullId.substring(0, 255);
		this.schema = options.schema;
		this.keyConfig = options.key;
		this.indexes = (options.indexes ?? {}) as Indexes;
		this.readValidation = options.readValidation ?? 'coerce';
		const client = new DynamoDBClient({
			customUserAgent: this.buildUserAgentChain(),
		});
		this.docClient = DynamoDBDocumentClient.from(client);
		registerSdkIdentifiers(this.fullId, { tableName });
	}

	async get(key: TableKey<T, K>): Promise<T | null> {
		const result = await this.docClient.send(new GetCommand({
			TableName: getSdkIdentifiers(this).tableName,
			Key: this.buildKey(key),
		}));
		return this.reconcileRead((result.Item as T) ?? null);
	}

	async put(item: T, options?: PutOptions<T>): Promise<void> {
		await this.validateItem(item);
		const command: any = { TableName: getSdkIdentifiers(this).tableName, Item: item };

		if (options?.ifNotExists) {
			command.ConditionExpression = 'attribute_not_exists(#pk)';
			command.ExpressionAttributeNames = { '#pk': this.keyConfig.partitionKey };
		} else if (options?.ifFieldEquals) {
			this.applyFieldEqualsCondition(command, options.ifFieldEquals);
		}

		try {
			await this.docClient.send(new PutCommand(command));
		} catch (err: unknown) {
			throw remapItemTooLarge(err);
		}
	}

	async delete(key: TableKey<T, K>, options?: DeleteOptions<T>): Promise<void> {
		const command: any = { TableName: getSdkIdentifiers(this).tableName, Key: this.buildKey(key) };

		if (options?.ifExists) {
			command.ConditionExpression = 'attribute_exists(#pk)';
			command.ExpressionAttributeNames = { '#pk': this.keyConfig.partitionKey };
		} else if (options?.ifFieldEquals) {
			this.applyFieldEqualsCondition(command, options.ifFieldEquals);
		}

		await this.docClient.send(new DeleteCommand(command));
	}

	/**
	 * Query items by index, yielding matches as an async stream with automatic
	 * pagination over DynamoDB's `LastEvaluatedKey`.
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
		// Normalize the sort-key condition before building the query: a present-but-
		// empty condition ({} / all-undefined) becomes "no filter" (otherwise we'd
		// register #sk in ExpressionAttributeNames with no clause and DynamoDB would
		// reject it), and more than one condition is rejected before issuing a call.
		const skCondition = skField
			? normalizeSortKeyCondition((options.where as any)[skField] as SortKeyCondition<any> | undefined)
			: undefined;

		let lastEvaluatedKey: Record<string, any> | undefined;
		let count = 0;

		do {
			const command = this.buildQueryCommand(options.index, pkField, pkValue, skField, skCondition, lastEvaluatedKey, options);
			const result = await this.docClient.send(command);

			for (const item of result.Items ?? []) {
				yield (await this.reconcileRead(item as T)) as T;
				if (options.limit && ++count >= options.limit) return;
			}

			lastEvaluatedKey = result.LastEvaluatedKey;
		} while (lastEvaluatedKey);
	}

	async *scan(options?: ScanOptions): AsyncIterable<T> {
		let lastEvaluatedKey: Record<string, any> | undefined;
		let count = 0;

		do {
			const result = await this.docClient.send(new ScanCommand({
				TableName: getSdkIdentifiers(this).tableName,
				ExclusiveStartKey: lastEvaluatedKey,
				Limit: options?.limit,
			}));

			for (const item of result.Items ?? []) {
				yield (await this.reconcileRead(item as T)) as T;
				if (options?.limit && ++count >= options.limit) return;
			}

			lastEvaluatedKey = result.LastEvaluatedKey;
		} while (lastEvaluatedKey);
	}

	async getBatch(keys: TableKey<T, K>[]): Promise<(T | null)[]> {
		const results = new Map<string, T>();
		const tableName = getSdkIdentifiers(this).tableName;

		for (const chunk of chunked(keys, BATCH_GET_MAX_KEYS)) {
			await this.retryUnprocessed(
				'getBatch',
				chunk.map(k => this.buildKey(k)),
				async pendingKeys => {
					const resp = await this.docClient.send(new BatchGetCommand({
						RequestItems: { [tableName]: { Keys: pendingKeys } },
					}));
					for (const item of resp.Responses?.[tableName] ?? []) {
						results.set(JSON.stringify(this.buildKey(item as any)), item as T);
					}
					return resp.UnprocessedKeys?.[tableName]?.Keys as Record<string, any>[] | undefined;
				},
			);
		}
		return Promise.all(
			keys.map(key => this.reconcileRead(results.get(JSON.stringify(this.buildKey(key))) ?? null)),
		);
	}

	async putBatch(items: T[]): Promise<void> {
		for (const item of items) await this.validateItem(item);
		const tableName = getSdkIdentifiers(this).tableName;

		for (const chunk of chunked(items, BATCH_WRITE_MAX_REQUESTS)) {
			await this.retryUnprocessed(
				'putBatch',
				chunk.map(item => ({ PutRequest: { Item: item as any } })),
				async requests => {
					try {
						const resp = await this.docClient.send(new BatchWriteCommand({
							RequestItems: { [tableName]: requests },
						}));
						return resp.UnprocessedItems?.[tableName] as any[] | undefined;
					} catch (err: unknown) {
						throw remapItemTooLarge(err);
					}
				},
			);
		}
	}

	async deleteBatch(keys: TableKey<T, K>[]): Promise<void> {
		const tableName = getSdkIdentifiers(this).tableName;

		for (const chunk of chunked(keys, BATCH_WRITE_MAX_REQUESTS)) {
			await this.retryUnprocessed(
				'deleteBatch',
				chunk.map(key => ({ DeleteRequest: { Key: this.buildKey(key) } })),
				async requests => {
					const resp = await this.docClient.send(new BatchWriteCommand({
						RequestItems: { [tableName]: requests },
					}));
					return resp.UnprocessedItems?.[tableName] as any[] | undefined;
				},
			);
		}
	}

	static fromExisting(tableName: string): ExternalTableRef {
		return { __brand: 'ExternalTableRef' as const, tableName };
	}

	static fromKmsKey(keyArn: string): ExternalKmsKeyRef {
		return { __brand: 'ExternalKmsKeyRef' as const, keyArn };
	}

	// ── Internal ────────────────────────────────────────────────────────────

	private async validateItem(item: T): Promise<void> {
		const result = this.schema['~standard'].validate(item);
		const resolved = result instanceof Promise ? await result : result;
		if (resolved.issues) {
			throw blocksError(DistributedTableErrors.ValidationFailed, resolved.issues[0].message);
		}
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

	private buildKey(key: TableKey<T, K>): Record<string, any> {
		const result: Record<string, any> = { [this.keyConfig.partitionKey]: (key as any)[this.keyConfig.partitionKey] };
		if (this.keyConfig.sortKey) result[this.keyConfig.sortKey] = (key as any)[this.keyConfig.sortKey];
		return result;
	}

	private backoff(attempt: number): Promise<void> {
		// Exponential backoff with equal jitter: keep half the delay as a floor and
		// randomise the other half. Full jitter (random * cap) can collapse to ~0ms
		// and lets concurrent callers re-collide; equal jitter preserves a minimum
		// spacing while still de-synchronising retries under shared throttling.
		// See: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Programming.Errors.html#Programming.Errors.BatchOperations
		const capped = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
		const ms = capped / 2 + Math.random() * (capped / 2);
		return new Promise(resolve => setTimeout(resolve, ms));
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
				DistributedTableErrors.BatchIncomplete,
				DistributedTableMessages.batchIncomplete(operation, pending.length, MAX_BATCH_ATTEMPTS),
			);
		}
	}

	private applyFieldEqualsCondition(command: any, fields: Partial<T>): void {
		const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
		if (entries.length === 0) {
			throw blocksError(DistributedTableErrors.InvalidQuery, DistributedTableMessages.emptyIfFieldEquals);
		}
		const conditions: string[] = [];
		const names: Record<string, string> = {};
		const values: Record<string, any> = {};
		entries.forEach(([field, value], i) => {
			conditions.push(`#field${i} = :val${i}`);
			names[`#field${i}`] = field;
			values[`:val${i}`] = value;
		});
		command.ConditionExpression = conditions.join(' AND ');
		command.ExpressionAttributeNames = names;
		command.ExpressionAttributeValues = values;
	}

	private buildQueryCommand(
		indexName: string | undefined,
		pkField: string,
		pkValue: any,
		skField: string | undefined,
		skCondition: SortKeyCondition<any> | undefined,
		exclusiveStartKey?: Record<string, any>,
		options?: { limit?: number; order?: 'asc' | 'desc' },
	): QueryCommand {
		let expr = '#pk = :pkval';
		const names: Record<string, string> = { '#pk': pkField };
		const values: Record<string, any> = { ':pkval': pkValue };

		if (skField && skCondition) {
			names['#sk'] = skField;
			if ('equals' in skCondition && skCondition.equals !== undefined) {
				expr += ' AND #sk = :skval'; values[':skval'] = skCondition.equals;
			} else if ('greaterThan' in skCondition && skCondition.greaterThan !== undefined) {
				expr += ' AND #sk > :skval'; values[':skval'] = skCondition.greaterThan;
			} else if ('greaterThanOrEqual' in skCondition && skCondition.greaterThanOrEqual !== undefined) {
				expr += ' AND #sk >= :skval'; values[':skval'] = skCondition.greaterThanOrEqual;
			} else if ('lessThan' in skCondition && skCondition.lessThan !== undefined) {
				expr += ' AND #sk < :skval'; values[':skval'] = skCondition.lessThan;
			} else if ('lessThanOrEqual' in skCondition && skCondition.lessThanOrEqual !== undefined) {
				expr += ' AND #sk <= :skval'; values[':skval'] = skCondition.lessThanOrEqual;
			} else if ('between' in skCondition && skCondition.between) {
				expr += ' AND #sk BETWEEN :skval1 AND :skval2';
				values[':skval1'] = skCondition.between[0]; values[':skval2'] = skCondition.between[1];
			} else if ('beginsWith' in skCondition && skCondition.beginsWith !== undefined) {
				expr += ' AND begins_with(#sk, :skval)'; values[':skval'] = skCondition.beginsWith;
			}
		}

		return new QueryCommand({
			TableName: getSdkIdentifiers(this).tableName,
			IndexName: indexName || undefined,
			KeyConditionExpression: expr,
			ExpressionAttributeNames: names,
			ExpressionAttributeValues: values,
			ExclusiveStartKey: exclusiveStartKey,
			Limit: options?.limit,
			ScanIndexForward: options?.order === 'desc' ? false : undefined,
		});
	}
}

// ── Query input helper type ─────────────────────────────────────────────────

