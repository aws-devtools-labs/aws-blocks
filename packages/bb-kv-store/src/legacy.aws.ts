// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import { getSdkIdentifiers, installClientUserAgent, registerSdkIdentifiers, Scope } from '@aws-blocks/core';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { decodeCursor, type Item, normalizeLimit, presentOptions, requestResults } from './item.js';
import { RELEASE_MODEL, RELEASE_PK, releaseEntry, releaseKey, releaseLiveValue } from './legacy.js';
import type { Entry, GetOptions, LegacyKVStoreOptions, Results, ScanOptions } from './types.js';
import { BB_NAME, BB_VERSION } from './version.js';

/**
 * The store of a `KVStore` release up to 0.4.0, for an upgrade: it reads the
 * table of that store, and deletes from it. It does not write.
 *
 * **When to use:** Your app has a `KVStore` from a release up to 0.4.0. This
 * release keeps items in another layout, in a table with another key, so a
 * `KVStore` of this release cannot take over that table. Change the class on
 * the line of the old store to `LegacyKVStore`, keep its id and its options,
 * and add a `KVStore` with a new id. Copy the items in your own code, then
 * remove the `LegacyKVStore`.
 *
 * **When NOT to use:** For new data. Use `KVStore`.
 *
 * **What it does to the table:** Nothing. The deploy keeps the table as it is,
 * with its items. The app's role gets read and delete access to it.
 *
 * @example
 * ```typescript
 * // Release 0.4.0: const prefs = new KVStore<Prefs>(scope, 'prefs', { ttl: true });
 * const oldPrefs = new LegacyKVStore<Prefs>(scope, 'prefs', { ttl: true });
 * const prefs = new KVStore<Prefs>(scope, 'prefs-v2');
 *
 * // In a handler: copy each item, with its expiry. A key that the app wrote since stays as it is.
 * for await (const { key, value, expiresAt } of oldPrefs.scan()) {
 *   try {
 *     await prefs.put(key, value, { ifNotExists: true, expiresAt });
 *   } catch (e: unknown) {
 *     if (!isBlocksError(e, KVStoreErrors.ConditionalCheckFailed)) throw e;
 *   }
 * }
 * ```
 */
export class LegacyKVStore<T = string> extends Scope {
	readonly bbName = BB_NAME;
	private docClient: DynamoDBDocumentClient;

	constructor(scope: ScopeParent, id: string, options?: LegacyKVStoreOptions<T>) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
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
	 * {@link LegacyKVStore.delete} removed a moment before; pass
	 * `{ consistentRead: false }` where a stale value is acceptable at half the
	 * read cost. An item whose expiry has passed is treated as absent.
	 *
	 * @param key - The string key.
	 * @param options - `consistentRead` (default `true`).
	 * @returns The value, or `null` if the key does not exist or has expired.
	 * @throws {KVStoreErrors.InvalidQuery} If the key is not a string.
	 * @throws {KVStoreErrors.ValidationFailed} If the key is an empty string, or the item is not an item of a release.
	 *
	 * @example
	 * ```typescript
	 * // While the copy runs, a read falls back to the old store.
	 * const value = (await prefs.get(key)) ?? (await oldPrefs.get(key));
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
	 * @throws {KVStoreErrors.ValidationFailed} If an item is not an item of a release.
	 *
	 * @example
	 * ```typescript
	 * // One page of the copy. Run it again with the cursor, until the cursor is undefined.
	 * const page = oldPrefs.scan({ limit: 500, cursor });
	 * for await (const { key, value, expiresAt } of page) {
	 *   try {
	 *     await prefs.put(key, value, { ifNotExists: true, expiresAt });
	 *   } catch (e: unknown) {
	 *     if (!isBlocksError(e, KVStoreErrors.ConditionalCheckFailed)) throw e;
	 *   }
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
	 * Delete a key of the old store. A key that does not exist is not an error.
	 *
	 * Use it while the copy runs. Where the app deletes a key, delete it in the
	 * old store first, and then in the new one, so that the copy and a read that
	 * falls back to the old store do not bring it back. Where the app writes a
	 * key to the new store, delete it in the old store after the write, so that
	 * the old value does not show again when the new one expires.
	 *
	 * @param key - The string key.
	 * @throws {KVStoreErrors.InvalidQuery} If the key is not a string.
	 * @throws {KVStoreErrors.ValidationFailed} If the key is an empty string.
	 *
	 * @example
	 * ```typescript
	 * await oldPrefs.delete(key);
	 * await prefs.delete(key);
	 * ```
	 */
	async delete(key: string): Promise<void> {
		await this.docClient.send(
			new DeleteCommand({
				TableName: getSdkIdentifiers(this).tableName,
				Key: { [RELEASE_PK]: releaseKey(key) },
			}),
		);
	}
}
