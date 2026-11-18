// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared TTL resolution used by the mock and AWS runtimes so both layers agree
 * on the exact epoch-seconds value written and on when an item counts as
 * expired. Zero runtime dependencies beyond the error constants.
 */
import { blocksError } from '@aws-blocks/core';
import { KVStoreErrors } from './errors.js';
import type { Expiry } from './types.js';

/**
 * Every top-level attribute name that starts with this prefix belongs to the
 * block. `put` rejects an object value that has such a field: a value an app
 * builds from request input must not be able to set the key or the expiry of
 * an item. The prefix stands for "Blocks key-value".
 */
export const RESERVED_PREFIX = '_bkv_';

/** Partition key attribute of a store with no declared `key` (a string key). */
export const PK_ATTRIBUTE = '_bkv_pk';

/** Attribute that holds a value that is not an object (a string, a number, an array, ...). */
export const VALUE_ATTRIBUTE = '_bkv_value';

/**
 * DynamoDB attribute that holds the expiry timestamp when the store does not
 * name a field of the value with the `ttl` option. TTL is always on for a table
 * the block creates, on this attribute or on the named field.
 */
export const TTL_ATTRIBUTE = '_bkv_ttl';

/**
 * Epoch *seconds* above which a value is almost certainly epoch milliseconds
 * (1e11 seconds is the year 5138). Writing milliseconds into a DynamoDB TTL
 * attribute silently means "never expires", which is the exact failure mode
 * TTL is meant to prevent — so we reject it instead.
 */
const MAX_PLAUSIBLE_EPOCH_SECONDS = 1e11;

function invalidTtl(message: string): never {
	throw blocksError(KVStoreErrors.ValidationFailed, message);
}

/** Current time as Unix epoch seconds — the unit DynamoDB TTL expects. */
export function nowEpochSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

/**
 * Resolve `ttlSeconds` / `expiresAt` to an absolute Unix epoch-seconds value,
 * or `undefined` when the caller asked for no expiry.
 *
 * `expiresAt` accepts any point in time, including one already past — that
 * reads as "expire immediately", so there is no lower bound beyond being a
 * finite time. Only the epoch-milliseconds guard caps the upper end.
 * `ttlSeconds` is a duration rather than an instant, so it must be positive.
 *
 * @throws {KVStoreErrors.ValidationFailed} If both options are set, or either is not a usable time.
 */
export function resolveTtlEpochSeconds(options?: Expiry): number | undefined {
	const ttlSeconds = options?.ttlSeconds;
	const expiresAt = options?.expiresAt;
	if (ttlSeconds === undefined && expiresAt === undefined) return undefined;
	if (ttlSeconds !== undefined && expiresAt !== undefined) {
		invalidTtl('put: pass either `ttlSeconds` or `expiresAt`, not both');
	}

	if (ttlSeconds !== undefined) {
		if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
			invalidTtl(`put: \`ttlSeconds\` must be a finite number greater than 0 (received ${String(ttlSeconds)})`);
		}
		return nowEpochSeconds() + Math.ceil(ttlSeconds);
	}

	if (expiresAt instanceof Date) {
		const ms = expiresAt.getTime();
		if (!Number.isFinite(ms)) invalidTtl('put: `expiresAt` is an Invalid Date');
		return Math.floor(ms / 1000);
	}
	if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
		invalidTtl(`put: \`expiresAt\` must be a Date or a Unix epoch time in seconds (received ${String(expiresAt)})`);
	}
	if (expiresAt >= MAX_PLAUSIBLE_EPOCH_SECONDS) {
		invalidTtl(
			'put: `expiresAt` looks like epoch milliseconds; DynamoDB TTL expects seconds — pass a Date or divide by 1000',
		);
	}
	return Math.floor(expiresAt);
}

/**
 * Whether a stored TTL attribute has passed. Non-numeric / absent values are
 * never expired, matching DynamoDB (it ignores items whose TTL attribute is
 * missing or not a Number).
 */
export function isExpired(ttl: unknown, nowSeconds: number = nowEpochSeconds()): boolean {
	return typeof ttl === 'number' && Number.isFinite(ttl) && ttl <= nowSeconds;
}
