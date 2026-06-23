// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { buildAgentTools } from './agent-tools.js';
import { Scope } from './common/index.js';
import type { ToolMethodDef } from './agent-tools.js';

const scope = new Scope('test-app');

// Simulates a BB's tool registry — tests buildAgentTools logic in isolation
// so each BB only needs to test its own handlers, not filtering/scope/overrides.
const MOCK_METHODS: Record<string, ToolMethodDef<any>> = {
	get: {
		description: 'Retrieve a value',
		parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
		handler: (self) => async ({ input }) => `got:${input.key}`,
	},
	put: {
		description: 'Store a value',
		parameters: { type: 'object', properties: { key: { type: 'string' }, value: {} }, required: ['key', 'value'] },
		needsApproval: true,
		trustable: true,
		handler: (self) => async ({ input }) => ({ stored: input.key }),
	},
	delete: {
		description: 'Delete a value',
		parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
		needsApproval: true,
		handler: (self) => async ({ input }) => ({ deleted: input.key }),
	},
};

// Use a minimal Scope-like object for testing
const mockBB = new Scope('store', { parent: scope });

describe('buildAgentTools', () => {
	test('returns all methods by default', () => {
		const tools = buildAgentTools(mockBB, MOCK_METHODS);
		assert.deepStrictEqual(Object.keys(tools).sort(), ['store__delete', 'store__get', 'store__put']);
	});

	test('tool naming is bbId__methodName', () => {
		const bb = new Scope('my-store', { parent: scope });
		const tools = buildAgentTools(bb, MOCK_METHODS);
		assert.ok('my-store__get' in tools);
		assert.ok('my-store__put' in tools);
		assert.ok('my-store__delete' in tools);
	});

	test('preserves description, parameters, needsApproval, trustable', () => {
		const tools = buildAgentTools(mockBB, MOCK_METHODS);
		assert.strictEqual(tools['store__get'].description, 'Retrieve a value');
		assert.strictEqual(tools['store__get'].needsApproval, false);
		assert.strictEqual(tools['store__put'].needsApproval, true);
		assert.strictEqual(tools['store__put'].trustable, true);
		assert.strictEqual(tools['store__delete'].needsApproval, true);
		assert.strictEqual(tools['store__delete'].trustable, undefined);
	});

	test('handler is a callable function', async () => {
		const tools = buildAgentTools(mockBB, MOCK_METHODS);
		const result = await tools['store__get'].handler({ input: { key: 'abc' }, context: {} });
		assert.strictEqual(result, 'got:abc');
	});

	describe('include/exclude', () => {
		test('include filters to specified methods', () => {
			const tools = buildAgentTools(mockBB, MOCK_METHODS, { include: ['get'] });
			assert.deepStrictEqual(Object.keys(tools), ['store__get']);
		});

		test('exclude removes specified methods', () => {
			const tools = buildAgentTools(mockBB, MOCK_METHODS, { exclude: ['delete'] });
			assert.deepStrictEqual(Object.keys(tools).sort(), ['store__get', 'store__put']);
		});

		test('include and exclude together throws', () => {
			assert.throws(
				() => buildAgentTools(mockBB, MOCK_METHODS, { include: ['get'], exclude: ['put'] }),
				/mutually exclusive/,
			);
		});
	});

	describe('overrides', () => {
		test('override description', () => {
			const tools = buildAgentTools(mockBB, MOCK_METHODS, {
				overrides: { get: { description: 'Custom description' } },
			});
			assert.strictEqual(tools['store__get'].description, 'Custom description');
		});

		test('override needsApproval', () => {
			const tools = buildAgentTools(mockBB, MOCK_METHODS, {
				overrides: { get: { needsApproval: true } },
			});
			assert.strictEqual(tools['store__get'].needsApproval, true);
		});

		test('override schema replaces parameters', () => {
			const customSchema = { type: 'object', properties: { id: { type: 'number' } } };
			const tools = buildAgentTools(mockBB, MOCK_METHODS, {
				overrides: { get: { schema: customSchema } },
			});
			assert.deepStrictEqual(tools['store__get'].parameters, customSchema);
		});

		test('fixed values are injected into handler input', async () => {
			const methods: Record<string, ToolMethodDef<any>> = {
				query: {
					description: 'Query items',
					parameters: { type: 'object', properties: {} },
					handler: () => async ({ input }) => input,
				},
			};
			const tools = buildAgentTools(mockBB, methods, {
				overrides: { query: { fixed: { region: 'us-east-1' } } },
			});
			const result = await tools['store__query'].handler({ input: { status: 'active' }, context: {} });
			assert.deepStrictEqual(result, { status: 'active', region: 'us-east-1' });
		});
	});

	describe('scope', () => {
		test('scope injects context fields into input', async () => {
			const methods: Record<string, ToolMethodDef<any>> = {
				query: {
					description: 'Query items',
					parameters: { type: 'object', properties: {} },
					handler: () => async ({ input }) => input,
				},
			};
			const tools = buildAgentTools(mockBB, methods, {
				scope: (ctx: { userId: string }) => ({ userId: ctx.userId }),
			});
			const result = await tools['store__query'].handler({
				input: { status: 'active' },
				context: { userId: 'user-123' },
			});
			assert.deepStrictEqual(result, { status: 'active', userId: 'user-123' });
		});

		test('scope overrides user-provided input for scoped fields', async () => {
			const methods: Record<string, ToolMethodDef<any>> = {
				query: {
					description: 'Query items',
					parameters: { type: 'object', properties: {} },
					handler: () => async ({ input }) => input,
				},
			};
			const tools = buildAgentTools(mockBB, methods, {
				scope: (ctx: { userId: string }) => ({ userId: ctx.userId }),
			});
			const result = await tools['store__query'].handler({
				input: { userId: 'attacker', status: 'active' },
				context: { userId: 'real-user' },
			});
			assert.strictEqual(result.userId, 'real-user');
		});

		test('scope and fixed combine on disjoint keys', async () => {
			const methods: Record<string, ToolMethodDef<any>> = {
				query: {
					description: 'Query items',
					parameters: { type: 'object', properties: {} },
					handler: () => async ({ input }) => input,
				},
			};
			const tools = buildAgentTools(mockBB, methods, {
				scope: (ctx: { userId: string }) => ({ userId: ctx.userId }),
				overrides: { query: { fixed: { limit: 10 } } },
			});
			const result = await tools['store__query'].handler({
				input: { status: 'active' },
				context: { userId: 'user-123' },
			});
			assert.deepStrictEqual(result, { status: 'active', userId: 'user-123', limit: 10 });
		});

		test('fixed wins over scope when both target the same key', async () => {
			const methods: Record<string, ToolMethodDef<any>> = {
				query: {
					description: 'Query items',
					parameters: { type: 'object', properties: {} },
					handler: () => async ({ input }) => input,
				},
			};
			const tools = buildAgentTools(mockBB, methods, {
				scope: (ctx: { tenant: string }) => ({ tenant: ctx.tenant }),
				overrides: { query: { fixed: { tenant: 'pinned-tenant' } } },
			});
			const result = await tools['store__query'].handler({
				input: { status: 'active' },
				context: { tenant: 'context-tenant' },
			});
			assert.strictEqual(result.tenant, 'pinned-tenant');
		});
	});
});
