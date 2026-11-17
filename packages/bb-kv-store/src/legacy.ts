// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The item layout of the `KVStore` releases up to 0.4.0, which `LegacyKVStore`
 * reads: the key in `pk`, the whole value as JSON text in `value`, and the
 * expiry in `ttl`.
 *
 * ```json
 * { "pk": "theme", "value": "{\"color\":\"dark\"}", "ttl": 1800000000 }
 * ```
 */
import { blocksError, KVStoreErrors } from './errors.js';
import { type Item, itemExpired, type KeyModel, normalizeKey } from './item.js';
import type { Entry } from './types.js';

/** The key attribute of the layout. */
export const RELEASE_PK = 'pk';
/** The attribute that holds the value as JSON text. */
export const RELEASE_VALUE = 'value';
/** The attribute that holds the expiry, in epoch seconds. */
export const RELEASE_TTL = 'ttl';

/** The key model of a table of such a release: a string key in `pk`, and the expiry in `ttl`. */
export const RELEASE_MODEL: KeyModel = {
	table: { partitionKey: RELEASE_PK },
	declared: false,
	indexes: {},
	ttlAttribute: RELEASE_TTL,
	ttlInValue: false,
	schema: undefined,
	keyTypes: new Map([[RELEASE_PK, 'S']]),
};

/**
 * The key of a call, checked as `KVStore` checks a string key.
 *
 * @throws {KVStoreErrors.InvalidQuery} If the key is not a string.
 * @throws {KVStoreErrors.ValidationFailed} If the key is an empty string.
 */
export function releaseKey(key: unknown): string {
	return normalizeKey(RELEASE_MODEL, key)[RELEASE_PK] as string;
}

/**
 * The value of an item of the layout.
 *
 * @throws {KVStoreErrors.ValidationFailed} If the item is not an item of a release: its `value` is not JSON text.
 */
export function releaseValue(item: Item): unknown {
	const text = item[RELEASE_VALUE];
	if (typeof text === 'string') {
		try {
			return JSON.parse(text);
		} catch {
			// Reported below, with the key.
		}
	}
	throw blocksError(
		KVStoreErrors.ValidationFailed,
		`the item '${String(item[RELEASE_PK])}' is not an item of a KVStore release up to 0.4.0: its 'value' is not JSON text`,
	);
}

/** The value that `get` returns for an item: `null` for an absent item, and for an item whose expiry has passed. */
export function releaseLiveValue<T>(item: Item | undefined): T | null {
	if (!item || itemExpired(RELEASE_MODEL, item)) return null;
	return releaseValue(item) as T;
}

/** The `{ key, value, expiresAt }` entry of an item of the layout. */
export function releaseEntry<T>(item: Item): Entry<T, undefined> {
	const entry: Entry<T, undefined> = { key: item[RELEASE_PK] as string, value: releaseValue(item) as T };
	const ttl = item[RELEASE_TTL];
	if (typeof ttl === 'number' && Number.isFinite(ttl)) entry.expiresAt = ttl;
	return entry;
}
