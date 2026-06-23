// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAgentTools } from '@aws-blocks/core';
import type { AgentToolProviderOptions, ToolMethodDef } from '@aws-blocks/core';
import type { Scope } from '@aws-blocks/core';

interface KVStoreLike {
	get(key: string): Promise<unknown>;
	put(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<void>;
	scan(): AsyncIterable<{ key: string; value: unknown }>;
}

export const KV_TOOL_METHODS: Record<string, ToolMethodDef<KVStoreLike>> = {
	get: {
		description: 'Retrieve a value by key',
		parameters: { type: 'object', properties: { key: { type: 'string', description: 'The key to retrieve' } }, required: ['key'] },
		handler: (self) => async ({ input }) => self.get(input.key),
	},
	put: {
		description: 'Store a value at a key',
		parameters: { type: 'object', properties: { key: { type: 'string', description: 'The key to store' }, value: { description: 'The value to store' } }, required: ['key', 'value'] },
		needsApproval: true,
		trustable: true,
		handler: (self) => async ({ input }) => { await self.put(input.key, input.value); return { success: true }; },
	},
	delete: {
		description: 'Delete a key',
		parameters: { type: 'object', properties: { key: { type: 'string', description: 'The key to delete' } }, required: ['key'] },
		needsApproval: true,
		trustable: false,
		handler: (self) => async ({ input }) => { await self.delete(input.key); return { success: true }; },
	},
	scan: {
		description: 'List keys and values. Returns up to `limit` entries (default 100).',
		parameters: { type: 'object', properties: { limit: { type: 'number', description: 'Maximum number of entries to return (default 100)' } } },
		handler: (self) => async ({ input }) => {
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
	return buildAgentTools(self, KV_TOOL_METHODS, options);
}
