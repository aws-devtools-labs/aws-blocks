// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { Scope, registerSdkIdentifiers, getSdkIdentifiers } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { BB_NAME, BB_VERSION } from './version.js';
import { KVStoreErrors } from './errors.js';
import { TTL_ATTRIBUTE, isExpired, resolveTtlEpochSeconds } from './ttl.js';

// Re-export public types and errors
export { KVStoreErrors } from './errors.js';
export type { ConditionalWriteOptions, ConditionalDeleteOptions, PutOptions, KVStoreOptions, ExternalTableRef, ScanOptions } from './types.js';
import type { ScanOptions } from './types.js';

/**
 * Simple key-value storage backed by DynamoDB.
 *
 * **When to use:** You need fast, single-key lookups with simple get/put/delete
 * semantics. Good for caches, session stores, feature flags, and config values.
 *
 * **When NOT to use:** If you need to query by multiple fields or secondary
 * indexes, use `DistributedTable`. If you need full SQL, use `Database`.
 *
 * **Best practices:**
 * - Keep keys short and descriptive (e.g., `user:{id}`, `session:{token}`)
 * - Store one logical entity per KVStore instance
 * - Use `{ ifNotExists: true }` for idempotent creates
 *
 * **Scaling:** PAY_PER_REQUEST billing. Single-digit ms reads/writes.
 * Throughput scales automatically. Items limited to 400 KB.
 */
export class KVStore<T = string> extends Scope {
	readonly bbName = BB_NAME;
	private schema?: import('@standard-schema/spec').StandardSchemaV1<T>;
	private docClient: DynamoDBDocumentClient;
	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options?: import('./index.mock.js').KVStoreOptions<T>) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		const tableName = options?.table ? options.table.tableName : this.fullId.substring(0, 255);
		registerSdkIdentifiers(this.fullId, { tableName });
		this.schema = options?.schema;
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		const client = new DynamoDBClient({
			customUserAgent: this.buildUserAgentChain(),
		});
		this.docClient = DynamoDBDocumentClient.from(client);
	}

	/**
	 * Retrieve a value by key.
	 *
	 * Items whose TTL has passed are treated as absent even if DynamoDB has not
	 * reaped them yet (deletion is asynchronous, typically within 48 hours).
	 *
	 * @param key - The key to retrieve.
	 * @returns The value, or `null` if the key does not exist or has expired.
	 */
	async get(key: string): Promise<T | null> {
		const result = await this.docClient.send(new GetCommand({
			TableName: getSdkIdentifiers(this).tableName,
			Key: { pk: key },
		}));
		if (!result.Item) return null;
		if (isExpired(result.Item[TTL_ATTRIBUTE])) return null;
		return JSON.parse(result.Item.value) as T;
	}

	/**
	 * Store a value at the given key. Overwrites any existing value unless
	 * conditions are specified.
	 *
	 * @param key - The key to store.
	 * @param value - The value to store.
	 * @param options - Optional write conditions and expiry (`ttlSeconds` / `expiresAt`).
	 * @throws {KVStoreErrors.ItemTooLarge} If the serialized value exceeds the 400 KB DynamoDB per-item size limit.
	 * @throws {KVStoreErrors.ConditionalCheckFailed} If `ifNotExists` is true and the key already exists.
	 * @throws {KVStoreErrors.ConditionalCheckFailed} If `ifValueEquals` is set and the current value does not match.
	 * @throws {KVStoreErrors.ValidationFailed} If both `ttlSeconds` and `expiresAt` are set, or either is not a usable time.
	 */
	async put(key: string, value: T, options?: import('./index.mock.js').PutOptions<T>): Promise<void> {
		if (this.schema) {
			const result = this.schema['~standard'].validate(value);
			const resolved = result instanceof Promise ? await result : result;
			if (resolved.issues) {
				const err = new Error(`ValidationFailedException: ${resolved.issues[0].message}`);
				err.name = 'ValidationFailedException';
				throw err;
			}
		}

		const expiresAtEpochSeconds = resolveTtlEpochSeconds(options);
		const item: Record<string, unknown> = { pk: key, value: JSON.stringify(value) };
		if (expiresAtEpochSeconds !== undefined) item[TTL_ATTRIBUTE] = expiresAtEpochSeconds;

		const command: any = {
			TableName: getSdkIdentifiers(this).tableName,
			Item: item,
		};

		// `ifNotExists` and `ifValueEquals` compose with OR: write when the key is
		// absent OR its current value matches — the optimistic "create it, or update
		// it only if unchanged" pattern. (AND would be unsatisfiable: a key can't be
		// both absent and have a matching value.)
		const conditions: string[] = [];
		const names: Record<string, string> = {};
		const values: Record<string, unknown> = {};
		if (options?.ifNotExists) {
			conditions.push('attribute_not_exists(#pk)');
			names['#pk'] = 'pk';
		}
		if (options && 'ifValueEquals' in options) {
			conditions.push('#value = :expected');
			names['#value'] = 'value';
			values[':expected'] = JSON.stringify(options.ifValueEquals);
		}
		if (conditions.length > 0) {
			command.ConditionExpression = conditions.join(' OR ');
			command.ExpressionAttributeNames = names;
			if (Object.keys(values).length > 0) command.ExpressionAttributeValues = values;
		}

		try {
			await this.docClient.send(new PutCommand(command));
		} catch (err: unknown) {
			if (err instanceof Error && err.name === 'ValidationException' && /size has exceeded/i.test(err.message)) {
				const sized = new Error(err.message);
				sized.name = KVStoreErrors.ItemTooLarge;
				throw sized;
			}
			throw err;
		}
	}

	/**
	 * Delete a value by key.
	 *
	 * @param key - The key to delete.
	 * @param conditions - Optional delete conditions.
	 * @throws {KVStoreErrors.ConditionalCheckFailed} If `ifExists` is true and the key does not exist.
	 * @throws {KVStoreErrors.ConditionalCheckFailed} If `ifValueEquals` is set and the current value does not match.
	 */
	async delete(key: string, conditions?: import('./index.mock.js').ConditionalDeleteOptions<T>): Promise<void> {
		const command: any = {
			TableName: getSdkIdentifiers(this).tableName,
			Key: { pk: key },
		};

		if (conditions?.ifExists) {
			command.ConditionExpression = 'attribute_exists(#pk)';
			command.ExpressionAttributeNames = { '#pk': 'pk' };
		} else if (conditions && 'ifValueEquals' in conditions) {
			command.ConditionExpression = '#value = :expected';
			command.ExpressionAttributeNames = { '#value': 'value' };
			command.ExpressionAttributeValues = { ':expected': JSON.stringify(conditions.ifValueEquals) };
		}

		await this.docClient.send(new DeleteCommand(command));
	}

	/**
	 * Enumerate all key-value pairs. Reads every item in the table —
	 * use sparingly on large datasets. Uses DynamoDB's native Scan operation.
	 * Expired items are skipped even if DynamoDB has not reaped them yet,
	 * unless `includeExpired` is set.
	 *
	 * @returns An async iterable of key-value entries.
	 */
	async *scan(options?: ScanOptions): AsyncIterable<{ key: string; value: T }> {
		const includeExpired = options?.includeExpired === true;
		let lastKey: Record<string, any> | undefined;
		do {
			const result = await this.docClient.send(new ScanCommand({
				TableName: getSdkIdentifiers(this).tableName,
				ExclusiveStartKey: lastKey,
			}));
			for (const item of result.Items ?? []) {
				if (!includeExpired && isExpired(item[TTL_ATTRIBUTE])) continue;
				yield { key: item.pk as string, value: JSON.parse(item.value as string) as T };
			}
			lastKey = result.LastEvaluatedKey;
		} while (lastKey);
	}

	/**
	 * Wrap an existing DynamoDB table. KVStore will not create or manage
	 * infrastructure for this table.
	 *
	 * @param tableName - The name of the existing DynamoDB table.
	 */
	static fromExisting(tableName: string): import('./index.mock.js').ExternalTableRef {
		return { __brand: 'ExternalTableRef' as const, tableName };
	}
}
