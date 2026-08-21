// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope, registerSdkIdentifiers } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { getMockDataDir } from '@aws-blocks/core/bb-utils';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BB_NAME, BB_VERSION } from './version.js';

// ── Public types + errors ────────────────────────────────────────────────────
export { __BB_CLASS__Errors } from './errors.js';
export type { __BB_CLASS__Options, ExternalTableRef } from './types.js';

import type { __BB_CLASS__Options, ExternalTableRef } from './types.js';

/**
 * TODO: one-line summary of what __BB_CLASS__ does.
 *
 * Backed by a DynamoDB table in AWS; an on-disk key/value map locally, so the
 * dev loop needs no AWS account. Values are stored as strings — serialize
 * richer shapes yourself, or add a schema option (see `bb-kv-store`).
 *
 * **When to use:** TODO.
 *
 * **When NOT to use:** TODO.
 *
 * @example
 * ```ts
 * const store = new __BB_CLASS__(scope, 'store');
 * await store.put('greeting', 'hello');
 * const value = await store.get('greeting'); // 'hello'
 * ```
 */
export class __BB_CLASS__ extends Scope {
	private filePath: string;
	private data: Map<string, string>;

	constructor(scope: ScopeParent, id: string, _options?: __BB_CLASS__Options) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.filePath = join(getMockDataDir(this), 'store.json');
		this.data = this.loadFromDisk();
		registerSdkIdentifiers(this.fullId, { tableName: `mock-${this.fullId}`.substring(0, 255) });
	}

	/**
	 * Retrieve a value by key.
	 *
	 * @param key - The key to look up.
	 * @returns The stored value, or `null` if the key does not exist.
	 */
	async get(key: string): Promise<string | null> {
		const value = this.data.get(key);
		return value === undefined ? null : value;
	}

	/**
	 * Store a value at the given key, overwriting any existing value.
	 *
	 * @param key - The key to write.
	 * @param value - The value to store.
	 */
	async put(key: string, value: string): Promise<void> {
		this.data.set(key, value);
		this.flushToDisk();
	}

	/**
	 * Delete a value by key. No-op if the key does not exist.
	 *
	 * @param key - The key to delete.
	 */
	async delete(key: string): Promise<void> {
		this.data.delete(key);
		this.flushToDisk();
	}

	/**
	 * Wrap an existing DynamoDB table instead of provisioning one. __BB_CLASS__
	 * will not create or manage infrastructure for the referenced table.
	 *
	 * @param tableName - The name of the existing DynamoDB table.
	 */
	static fromExisting(tableName: string): ExternalTableRef {
		return { __brand: 'ExternalTableRef' as const, tableName };
	}

	// ── Disk persistence (stands in for DynamoDB during local dev) ──────────────

	private loadFromDisk(): Map<string, string> {
		if (!existsSync(this.filePath)) return new Map();
		try {
			const obj = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, string>;
			return new Map(Object.entries(obj));
		} catch {
			return new Map();
		}
	}

	private flushToDisk(): void {
		const obj: Record<string, string> = {};
		for (const [key, value] of this.data) obj[key] = value;
		writeFileSync(this.filePath, JSON.stringify(obj, null, 2));
	}
}
