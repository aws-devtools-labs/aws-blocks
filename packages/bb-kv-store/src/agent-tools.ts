// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentToolProviderOptions, Scope, ToolMethodDef } from '@aws-blocks/core';
import { buildAgentTools } from '@aws-blocks/core';
import type { KVStore } from './index.mock.js';

interface KVStoreLike {
	get(key: string): Promise<unknown>;
	put(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<void>;
	scan(): AsyncIterable<{ key: string; value: unknown }>;
}

export const KV_TOOL_METHODS: Record<string, ToolMethodDef<KVStoreLike>> = {
	get: {
		description:
			'Retrieve a stored value by its exact key. Use when you know the specific key you are looking for. Returns null if the key does not exist.',
		parameters: {
			type: 'object',
			properties: { key: { type: 'string', description: 'The key to retrieve' } },
			required: ['key'],
		},
		handler:
			(self) =>
			async ({ input }) =>
				self.get(input.key),
	},
	put: {
		description:
			'Store or overwrite a value at a key. Use when you want to save or update a value. Overwrites any existing value at that key without warning — use with care if data loss is a concern.',
		parameters: {
			type: 'object',
			properties: {
				key: { type: 'string', description: 'The key to store' },
				value: { description: 'The value to store' },
			},
			required: ['key', 'value'],
		},
		needsApproval: true,
		trustable: true,
		handler:
			(self) =>
			async ({ input }) => {
				await self.put(input.key, input.value);
				return { success: true };
			},
	},
	delete: {
		description:
			'Permanently delete a key and its value. Use when you want to remove an entry entirely. Cannot be undone.',
		parameters: {
			type: 'object',
			properties: { key: { type: 'string', description: 'The key to delete' } },
			required: ['key'],
		},
		needsApproval: true,
		trustable: false,
		handler:
			(self) =>
			async ({ input }) => {
				await self.delete(input.key);
				return { success: true };
			},
	},
	scan: {
		description:
			'List all key-value pairs in the store. Use when you need to browse or search across entries without knowing specific keys. Returns up to `limit` entries (default 100) — for large stores, prefer get if you know the key.',
		parameters: {
			type: 'object',
			properties: { limit: { type: 'number', description: 'Maximum number of entries to return (default 100)' } },
		},
		handler:
			(self) =>
			async ({ input }) => {
				const max = input.limit ?? 100;
				const items: { key: string; value: unknown }[] = [];
				for await (const entry of self.scan()) {
					items.push(entry);
					if (items.length >= max) break;
				}
				return items;
			},
	},
};

export function kvToAgentTools(self: Scope & KVStoreLike, options?: AgentToolProviderOptions): Record<string, any> {
	// A KVStore is commonly keyed by userId, so it can hold per-user data. Require the
	// caller to scope it to the current user or explicitly opt out as a shared store.
	return buildAgentTools(self, KV_TOOL_METHODS, options, { requiresScope: true });
}

// Compile-time check: fails the build if KVStoreLike drifts from the real KVStore class.
const _kvStoreSatisfiesInterface: KVStoreLike = {} as KVStore;
