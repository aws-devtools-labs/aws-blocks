// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { KVStore } from '@aws-blocks/bb-kv-store';
import { BB_NAME, BB_VERSION } from './version.js';

// ── Public errors ────────────────────────────────────────────────────────────
export { __BB_CLASS__Errors } from './errors.js';

/** Options for constructing a {@link __BB_CLASS__}. */
export interface __BB_CLASS__Options {
	/** TODO: describe the block's options. */
	namespace?: string;
}

/**
 * TODO: one-line summary of what __BB_CLASS__ does.
 *
 * A **composite** Building Block: it owns no infrastructure of its own and
 * composes other Building Blocks (here, a `KVStore`) for storage. The composed
 * blocks handle context switching (mock locally, DynamoDB in AWS), so this
 * single file works in every execution context with no `index.mock/aws/cdk`
 * split.
 *
 * @example
 * ```ts
 * const thing = new __BB_CLASS__(scope, 'thing');
 * await thing.set('greeting', 'hello');
 * const value = await thing.read('greeting'); // 'hello'
 * ```
 */
export class __BB_CLASS__ extends Scope {
	private store: KVStore;

	constructor(scope: ScopeParent, id: string, _options?: __BB_CLASS__Options) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		// Compose a KVStore for storage. It provisions its own DynamoDB table at
		// deploy time and its own mock locally — __BB_CLASS__ inherits both.
		this.store = new KVStore(this, 'store');
	}

	/**
	 * Store a value under a key.
	 *
	 * @param key - The key to write.
	 * @param value - The value to store.
	 */
	async set(key: string, value: string): Promise<void> {
		await this.store.put(key, value);
	}

	/**
	 * Read a value by key.
	 *
	 * @param key - The key to look up.
	 * @returns The stored value, or `null` if the key does not exist.
	 */
	async read(key: string): Promise<string | null> {
		return this.store.get(key);
	}
}
