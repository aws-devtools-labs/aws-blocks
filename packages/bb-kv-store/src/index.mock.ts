// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope, registerSdkIdentifiers } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import type { AgentToolProviderOptions } from '@aws-blocks/core';
import { kvToAgentTools } from './agent-tools.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { getMockDataDir } from '@aws-blocks/core/bb-utils';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BB_NAME, BB_VERSION } from './version.js';

// ── Public types ────────────────────────────────────────────────────────────

export {
	KVStoreErrors,
} from './errors.js';
export type {
	ConditionalWriteOptions,
	ConditionalDeleteOptions,
	KVStoreOptions,
	ExternalTableRef,
} from './types.js';

import type { ConditionalWriteOptions, ConditionalDeleteOptions, KVStoreOptions, ExternalTableRef } from './types.js';
import { KVStoreErrors } from './errors.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const MAX_ITEM_BYTES = 400 * 1024; // DynamoDB 400 KB limit

function blocksError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return err;
}

async function validateSchema<T>(schema: StandardSchemaV1<T> | undefined, value: unknown): Promise<void> {
	if (!schema) return;
	const result = schema['~standard'].validate(value);
	const resolved = result instanceof Promise ? await result : result;
	if (resolved.issues) {
		throw blocksError('ValidationFailedException', resolved.issues[0].message);
	}
}

// ── KVStore (mock) ──────────────────────────────────────────────────────────

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
	private filePath: string;
	private data: Map<string, string>;
	private schema?: StandardSchemaV1<T>;
	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options?: KVStoreOptions<T>) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.filePath = join(getMockDataDir(this), 'store.json');
		this.data = this.loadFromDisk();
		this.schema = options?.schema;
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		registerSdkIdentifiers(this.fullId, { tableName: `mock-${this.fullId}`.substring(0, 255) });
	}

	/**
	 * Retrieve a value by key.
	 *
	 * @param key - The key to retrieve.
	 * @returns The value, or `null` if the key does not exist.
	 */
	async get(key: string): Promise<T | null> {
		const raw = this.data.get(key);
		if (raw === undefined) return null;
		return JSON.parse(raw) as T;
	}

	/**
	 * Store a value at the given key. Overwrites any existing value unless
	 * conditions are specified.
	 *
	 * @param key - The key to store.
	 * @param value - The value to store.
	 * @param conditions - Optional write conditions.
	 * @throws {KVStoreErrors.ItemTooLarge} If the serialized value exceeds the 400 KB DynamoDB per-item size limit.
	 * @throws {KVStoreErrors.ConditionalCheckFailed} If `ifNotExists` is true and the key already exists.
	 * @throws {KVStoreErrors.ConditionalCheckFailed} If `ifValueEquals` is set and the current value does not match.
	 */
	async put(key: string, value: T, conditions?: ConditionalWriteOptions<T>): Promise<void> {
		// Schema validation runs first (matches AWS entry which validates client-side before sending)
		await validateSchema(this.schema, value);

		const serialized = JSON.stringify(value);
		if (Buffer.byteLength(serialized, 'utf8') > MAX_ITEM_BYTES) {
			throw blocksError(KVStoreErrors.ItemTooLarge, `Item size has exceeded the maximum allowed size of 400 KB`);
		}

		if (conditions?.ifNotExists && this.data.has(key)) {
			throw blocksError(KVStoreErrors.ConditionalCheckFailed, 'The conditional request failed');
		}
		if (conditions?.ifValueEquals !== undefined) {
			const current = this.data.get(key);
			if (current !== JSON.stringify(conditions.ifValueEquals)) {
				throw blocksError(KVStoreErrors.ConditionalCheckFailed, 'The conditional request failed');
			}
		}

		this.data.set(key, serialized);
		this.flushToDisk();
	}

	/**
	 * Delete a value by key.
	 *
	 * @param key - The key to delete.
	 * @param conditions - Optional delete conditions.
	 * @throws {KVStoreErrors.ConditionalCheckFailed} If `ifExists` is true and the key does not exist.
	 * @throws {KVStoreErrors.ConditionalCheckFailed} If `ifValueEquals` is set and the current value does not match.
	 */
	async delete(key: string, conditions?: ConditionalDeleteOptions<T>): Promise<void> {
		if (conditions?.ifExists && !this.data.has(key)) {
			throw blocksError(KVStoreErrors.ConditionalCheckFailed, 'The conditional request failed');
		}
		if (conditions?.ifValueEquals !== undefined) {
			const current = this.data.get(key);
			if (current !== JSON.stringify(conditions.ifValueEquals)) {
				throw blocksError(KVStoreErrors.ConditionalCheckFailed, 'The conditional request failed');
			}
		}
		this.data.delete(key);
		this.flushToDisk();
	}

	/**
	 * Enumerate all key-value pairs. Reads every item in the store —
	 * use sparingly on large datasets.
	 *
	 * @returns An async iterable of key-value entries.
	 */
	async *scan(): AsyncIterable<{ key: string; value: T }> {
		for (const [key, raw] of this.data) {
			yield { key, value: JSON.parse(raw) as T };
		}
	}

	/**
	 * Wrap an existing DynamoDB table. KVStore will not create or manage
	 * infrastructure for this table.
	 *
	 * @param tableName - The name of the existing DynamoDB table.
	 */
	static fromExisting(tableName: string): ExternalTableRef {
		return { __brand: 'ExternalTableRef' as const, tableName };
	}

	// ── Agent tools ──────────────────────────────────────────────────────

	toAgentTools(options?: AgentToolProviderOptions): Record<string, any> {
		return kvToAgentTools(this, options);
	}

	// ── Disk persistence ──────────────────────────────────────────────────

	private loadFromDisk(): Map<string, string> {
		if (!existsSync(this.filePath)) return new Map();
		try {
			const obj = JSON.parse(readFileSync(this.filePath, 'utf8'));
			return new Map(Object.entries(obj));
		} catch {
			return new Map();
		}
	}

	private flushToDisk(): void {
		writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.data), null, 2));
	}
}
