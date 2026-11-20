// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-cdk-blocks/core';
import { getSdkIdentifiers, installClientUserAgent, registerSdkIdentifiers, Scope } from '@aws-cdk-blocks/core';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { conditionalCheckFailed, KVStoreErrors, remapItemTooLarge } from '../errors.js';
import { decodeCursor, type Item, normalizeLimit, presentOptions, requestResults } from '../item.js';
import type {
	Entry,
	GetOptions,
	LegacyKVStoreDeleteOptions,
	LegacyKVStoreOptions,
	LegacyKVStorePutOptions,
	Results,
	ScanOptions,
} from '../types.js';
import { BB_NAME, BB_VERSION } from '../version.js';
import {
	RELEASE_MODEL,
	RELEASE_PK,
	RELEASE_VALUE,
	releaseDelete,
	releaseEntry,
	releaseKey,
	releaseLiveValue,
	releaseWrite,
} from './layout.js';

/**
 * The store of `KVStore` release 0.4.0 or earlier, for an upgrade. It has the
 * data methods of that store over its table: `get`, `put`, `delete`, and `scan`.
 *
 * **When to use:** Your app has a `KVStore` from release 0.4.0 or earlier. This
 * release keeps items in another layout, in a table with another key, so a
 * `KVStore` of this release cannot take over that table. Change the class on
 * the line of the old store to `LegacyKVStore`, keep its id and its options,
 * and add a `KVStore` with a new id. Migrate the data in your own code,
 * however is appropriate for your app, then remove the `LegacyKVStore`. The
 * block does not copy the items, and it does not carry a write from one store
 * to the other.
 *
 * **When NOT to use:** For new data. Use `KVStore`.
 *
 * **What it does to the table:** Nothing. The deploy keeps the table as it is,
 * with its items. The app's role keeps read and write access to it.
 *
 * @deprecated Only for the upgrade of a store from release 0.4.0 or earlier. The class is frozen: it has
 *   the methods of release 0.4.0 and gets no new features. Use `KVStore` for new data, and remove the
 *   `LegacyKVStore` when the data is in the new store. The steps are in the README section "Upgrade from release
 *   0.4.0 or earlier":
 *   https://github.com/aws-devtools-labs/aws-blocks/blob/main/packages/bb-kv-store/README.md#upgrade-from-release-040-or-earlier
 *
 * @example
 * ```typescript
 * // Release 0.4.0: const prefs = new KVStore<Prefs>(scope, 'prefs', { ttl: true });
 * const oldPrefs = new LegacyKVStore<Prefs>(scope, 'prefs', { ttl: true });
 * const prefs = new KVStore<Prefs>(scope, 'prefs-v2');
 * ```
 */
export class LegacyKVStore<T = string> extends Scope {
	readonly bbName = BB_NAME;
	private docClient: DynamoDBDocumentClient;
	private schema: StandardSchemaV1<T> | undefined;

	constructor(scope: ScopeParent, id: string, options?: LegacyKVStoreOptions<T>) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.schema = options?.schema;
		const tableName = options?.table ? options.table.tableName : this.fullId.substring(0, 255);
		registerSdkIdentifiers(this.fullId, { tableName });
		const client = new DynamoDBClient({
			customUserAgent: this.buildUserAgentChain(),
		});
		installClientUserAgent(client);
		this.docClient = DynamoDBDocumentClient.from(client);
	}

	/**
	 * Retrieve a value of the old store by key.
	 *
	 * A strongly consistent read by default, so it does not return a key that
	 * {@link LegacyKVStore.delete} removed a moment before. Pass
	 * `{ consistentRead: false }` where a stale value is acceptable at half the
	 * read cost. An item whose expiry has passed is treated as absent.
	 *
	 * @param key - The string key.
	 * @param options - `consistentRead` (default `true`).
	 * @returns The value, or `null` if the key does not exist or has expired.
	 * @throws {KVStoreErrors.InvalidQuery} If the key is not a string.
	 * @throws {KVStoreErrors.ValidationFailed} If the key is an empty string, or the item is not an item of
	 *   release 0.4.0 or earlier.
	 *
	 * @example
	 * ```typescript
	 * const value = await oldPrefs.get('alice');
	 * ```
	 */
	async get(key: string, options?: GetOptions): Promise<T | null> {
		const result = await this.docClient.send(
			new GetCommand({
				TableName: getSdkIdentifiers(this).tableName,
				Key: { [RELEASE_PK]: releaseKey(key) },
				ConsistentRead: presentOptions(options)?.consistentRead !== false,
			}),
		);
		return releaseLiveValue<T>(result.Item as Item | undefined);
	}

	/**
	 * Store a value in the old store, as release 0.4.0 stores it: the JSON text
	 * of the value, under the key. Replaces the value of the key unless a
	 * condition is set.
	 *
	 * It is here so that the code that writes the old store runs unchanged
	 * until you migrate it. The block does not carry a write from one store to
	 * the other.
	 *
	 * @param key - The string key.
	 * @param value - The value. With a `schema`, it is validated before the write.
	 * @param options - `ttlSeconds` or `expiresAt`, and the conditions `ifNotExists` and `ifValueEquals`.
	 *   With both conditions the write succeeds if the key is absent or its value matches.
	 * @throws {KVStoreErrors.InvalidQuery} If the key is not a string.
	 * @throws {KVStoreErrors.ValidationFailed} If the key is an empty string, the value fails the schema
	 *   or has no JSON text, or the expiry options are not valid.
	 * @throws {KVStoreErrors.ConditionalCheckFailed} If a condition is set and does not hold. Status 409.
	 *   Retriable when `ifValueEquals` took part.
	 * @throws {KVStoreErrors.ItemTooLarge} If the item is larger than 400 KB.
	 *
	 * @example
	 * ```typescript
	 * await oldPrefs.put('alice', { theme: 'dark' }, { ttlSeconds: 3600 });
	 * ```
	 */
	async put(key: string, value: T, options?: LegacyKVStorePutOptions<T>): Promise<void> {
		const write = await releaseWrite(this.schema, key, value, presentOptions(options));
		// `ifNotExists` and `ifValueEquals` compose with OR, as in the release.
		const conditions: string[] = [];
		const names: Record<string, string> = {};
		if (write.ifAbsent) {
			conditions.push('attribute_not_exists(#pk)');
			names['#pk'] = RELEASE_PK;
		}
		if (write.ifValue !== undefined) {
			conditions.push('#value = :expected');
			names['#value'] = RELEASE_VALUE;
		}
		try {
			await this.docClient.send(
				new PutCommand({
					TableName: getSdkIdentifiers(this).tableName,
					Item: write.item,
					...(conditions.length > 0 && {
						ConditionExpression: conditions.join(' OR '),
						ExpressionAttributeNames: names,
					}),
					...(write.ifValue !== undefined && { ExpressionAttributeValues: { ':expected': write.ifValue } }),
				}),
			);
		} catch (err: unknown) {
			// A failed condition is a 409 with the name of the block, and an oversize item is ItemTooLarge, as on a KVStore.
			if (err instanceof Error && err.name === KVStoreErrors.ConditionalCheckFailed) {
				throw conditionalCheckFailed(write.retriable, err);
			}
			throw remapItemTooLarge(err);
		}
	}

	/**
	 * Enumerate the entries of the old store, each with its expiry. Reads every
	 * item of the table, so it is for the copy, not for a request path.
	 *
	 * The result has a `cursor`: the position after the last entry that the
	 * iterator returned. With a `limit`, pass the cursor to the next call to
	 * read the next page, in this request or in a later one.
	 *
	 * @param options - `limit`, `cursor`, and `includeExpired` (default `false`).
	 * @returns An async iterable of `{ key, value, expiresAt }`, with a `cursor`.
	 * @throws {KVStoreErrors.InvalidQuery} If `limit` is not a positive integer, or `cursor` is not a cursor of this store.
	 * @throws {KVStoreErrors.ValidationFailed} If an item is not an item of release 0.4.0 or earlier.
	 *
	 * @example
	 * ```typescript
	 * // One page. Pass `page.cursor` to the next call, until it is undefined.
	 * const page = oldPrefs.scan({ limit: 500, cursor });
	 * for await (const { key, value, expiresAt } of page) {
	 *   console.log(key, value, expiresAt);
	 * }
	 * const next = page.cursor;
	 * ```
	 */
	scan(options?: ScanOptions): Results<T, undefined> {
		const present = presentOptions(options);
		return requestResults<Entry<T, undefined>>(
			RELEASE_MODEL,
			releaseEntry<T>,
			{
				limit: normalizeLimit(present?.limit),
				startKey: decodeCursor(RELEASE_MODEL, present?.cursor, undefined),
				indexName: undefined,
				includeExpired: present?.includeExpired === true,
			},
			(exclusiveStartKey, limit) =>
				this.docClient.send(
					new ScanCommand({
						TableName: getSdkIdentifiers(this).tableName,
						ExclusiveStartKey: exclusiveStartKey,
						Limit: limit,
					}),
				),
		);
	}

	/**
	 * Delete a key of the old store. A key that does not exist is not an error,
	 * unless `ifExists` is set.
	 *
	 * While the app reads both stores, a read that falls back to the old store
	 * returns the old value of a key that the new store does not have. The
	 * README section "Upgrade from release 0.4.0 or earlier" lists the limits.
	 *
	 * @param key - The string key.
	 * @param conditions - `ifExists` and `ifValueEquals`, the conditions of release 0.4.0. With both, both must hold.
	 * @throws {KVStoreErrors.InvalidQuery} If the key is not a string.
	 * @throws {KVStoreErrors.ValidationFailed} If the key is an empty string.
	 * @throws {KVStoreErrors.ConditionalCheckFailed} If a condition is set and does not hold. Status 409.
	 *   Retriable when `ifValueEquals` is set without `ifExists`.
	 *
	 * @example
	 * ```typescript
	 * await oldPrefs.delete('alice');
	 *
	 * // Throws `ConditionalCheckFailedException` if the key does not exist.
	 * await oldPrefs.delete('alice', { ifExists: true });
	 * ```
	 */
	async delete(key: string, conditions?: LegacyKVStoreDeleteOptions<T>): Promise<void> {
		const plan = releaseDelete(key, presentOptions(conditions));
		// `ifExists` and `ifValueEquals` compose with AND, as in the release.
		const parts: string[] = [];
		const names: Record<string, string> = {};
		if (plan.ifExists) {
			parts.push('attribute_exists(#pk)');
			names['#pk'] = RELEASE_PK;
		}
		if (plan.ifValue !== undefined) {
			parts.push('#value = :expected');
			names['#value'] = RELEASE_VALUE;
		}
		try {
			await this.docClient.send(
				new DeleteCommand({
					TableName: getSdkIdentifiers(this).tableName,
					Key: { [RELEASE_PK]: plan.pk },
					...(parts.length > 0 && {
						ConditionExpression: parts.join(' AND '),
						ExpressionAttributeNames: names,
					}),
					...(plan.ifValue !== undefined && { ExpressionAttributeValues: { ':expected': plan.ifValue } }),
				}),
			);
		} catch (err: unknown) {
			// A failed condition is a 409 with the name of the block, as on a KVStore.
			if (err instanceof Error && err.name === KVStoreErrors.ConditionalCheckFailed) {
				throw conditionalCheckFailed(plan.retriable, err);
			}
			throw err;
		}
	}
}
