// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for KVStore. Imported by mock, aws, cdk, and browser entry points.
 * This file has zero runtime dependencies — types only.
 */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ChildLogger } from '@aws-blocks/bb-logger';

export interface ConditionalWriteOptions<T = unknown> {
	/** Only write if the key does not already exist. */
	ifNotExists?: boolean;
	/** Only write if the current value deep-equals this value (optimistic locking / compare-and-swap). */
	ifValueEquals?: T;
}

/**
 * Options accepted by `put`. A superset of {@link ConditionalWriteOptions} —
 * every existing `put(key, value, { ifNotExists })` call remains valid.
 *
 * `ttlSeconds` and `expiresAt` are mutually exclusive; passing both throws
 * `ValidationFailedException`. Both require the store to be constructed with
 * `{ ttl: true }` for DynamoDB to actually reap the item (reads filter expired
 * items regardless).
 */
export interface PutOptions<T = unknown> extends ConditionalWriteOptions<T> {
	/**
	 * Expire this item `ttlSeconds` from now (relative). Must be a finite
	 * number greater than zero; fractional values round up to the next second.
	 *
	 * @example
	 * ```typescript
	 * await cache.put('otp:alice', code, { ttlSeconds: 300 }); // 5 minutes
	 * ```
	 */
	ttlSeconds?: number;
	/**
	 * Expire this item at an absolute point in time — either a `Date` or a Unix
	 * epoch timestamp **in seconds** (the DynamoDB TTL unit). Values that look
	 * like epoch milliseconds are rejected rather than silently stored as a
	 * year-5138 expiry.
	 *
	 * @example
	 * ```typescript
	 * await sessions.put(id, record, { expiresAt: new Date(jwt.exp * 1000) });
	 * ```
	 */
	expiresAt?: Date | number;
}

/**
 * Options accepted by `scan`.
 */
export interface ScanOptions {
	/**
	 * Yield items whose `ttl` has passed but which DynamoDB's reaper has not
	 * deleted yet. Defaults to `false`, so a scan sees only live items.
	 *
	 * Enable this only for maintenance sweeps that must act on every row still
	 * physically present — deleting the remains of expired items, for example.
	 * Reads that answer "is this still valid?" must leave it off.
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

export interface ConditionalDeleteOptions<T = unknown> {
	/** Only delete if the key exists. Throws ConditionalCheckFailedException otherwise. */
	ifExists?: boolean;
	/** Only delete if the current value deep-equals this value (optimistic locking). */
	ifValueEquals?: T;
}

export interface KVStoreOptions<T = string> {
	/** Runtime schema for value validation on `put`. Accepts any StandardSchemaV1 implementation (Zod, Valibot, ArkType, etc.). When provided, the type parameter `T` is inferred from the schema. */
	schema?: StandardSchemaV1<T>;
	/** Wrap an existing DynamoDB table instead of creating one. */
	table?: ExternalTableRef;
	/**
	 * Optional logger for internal KVStore operations. Accepts a `Logger`
	 * instance or any `ChildLogger` from `@aws-blocks/bb-logger`.
	 *
	 * When omitted, a default Logger at error level is created (silent during
	 * normal operation, only emits on errors).
	 *
	 * @example
	 * ```typescript
	 * import { Logger } from '@aws-blocks/bb-logger';
	 * const log = new Logger(scope, 'app', { level: 'debug' });
	 * const store = new KVStore(scope, 'cache', { logger: log });
	 * ```
	 */
	logger?: ChildLogger;
	/**
	 * CDK removal behavior for the underlying DynamoDB table. When omitted,
	 * CDK's default applies (RETAIN — data is preserved on `cdk destroy`).
	 * Pass `'destroy'` for sandbox / ephemeral stacks where the table and
	 * its contents should be dropped on teardown. Pass `'retain'` to set
	 * the policy explicitly (identical to omitting it today, but robust
	 * against stack-layer policy overrides).
	 *
	 * Templates that apply `RemovalPolicies.of(stack).destroy()` at the
	 * top level (e.g. under `sandboxMode`) override this setting.
	 *
	 * Ignored by the mock and browser runtimes (no AWS resource to retain).
	 */
	removalPolicy?: 'destroy' | 'retain';
	/**
	 * Enable DynamoDB Time-to-Live on the underlying table so items written with
	 * `put(key, value, { ttlSeconds })` (or `{ expiresAt }`) are deleted
	 * automatically once they expire. The attribute name is fixed to `ttl`.
	 *
	 * Defaults to `false`. Opt-in because turning TTL on for a table that
	 * already exists is a CloudFormation update to the live table.
	 *
	 * DynamoDB's reaper is asynchronous (typically within 48 hours of expiry),
	 * so `get` and `scan` also filter expired items on read in every runtime —
	 * an expired item is never returned even while it is still on disk.
	 *
	 * @example
	 * ```typescript
	 * const sessions = new KVStore<Session>(scope, 'sessions', { ttl: true });
	 * await sessions.put(id, record, { ttlSeconds: 3600 });
	 * ```
	 */
	ttl?: boolean;
}

export interface ExternalTableRef {
	readonly __brand: 'ExternalTableRef';
	readonly tableName: string;
}
