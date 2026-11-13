// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isBlocksError, Scope } from '@aws-blocks/core';
import { KnowledgeBase, KnowledgeBaseErrors } from './index.mock.js';

const CORPUS = 'test-agent-tool-corpus';

function writeCorpus(): void {
	const root = join(process.cwd(), CORPUS);
	if (existsSync(root)) rmSync(root, { recursive: true, force: true });
	mkdirSync(join(root, 'tenant-a'), { recursive: true });
	mkdirSync(join(root, 'tenant-b'), { recursive: true });
	writeFileSync(join(root, 'tenant-a', 'plan.md'), 'Tenant A pricing plan: the gold tier costs 10 dollars.');
	writeFileSync(join(root, 'tenant-b', 'plan.md'), 'Tenant B pricing plan: the gold tier costs 99 dollars.');
}

function cleanup(): void {
	try { rmSync('.bb-data', { recursive: true, force: true }); } catch {}
	try { rmSync(join(process.cwd(), CORPUS), { recursive: true, force: true }); } catch {}
}

beforeEach(() => {
	cleanup();
	writeCorpus();
});
after(cleanup);

let n = 0;
const newKb = (description?: string) =>
	new KnowledgeBase(new Scope(`kb-tool-${++n}`), 'docs', { source: `./${CORPUS}`, description });

describe('asAgentTool()', () => {
	test('marks the tool output untrusted and exposes only a query parameter to the model', () => {
		const tool = newKb().asAgentTool({ filter: () => undefined });
		assert.strictEqual(tool.untrustedOutput, true);
		assert.deepStrictEqual(Object.keys(tool.parameters.shape), ['query']);
		assert.ok(tool.parameters.safeParse({ query: 'gold tier' }).success);
		assert.ok(!tool.parameters.safeParse({ query: '' }).success, 'an empty query is rejected');
		assert.ok(!tool.parameters.safeParse({ query: '   ' }).success, 'a whitespace-only query is rejected by the schema');
		// The model can't smuggle a filter in: unknown keys are stripped from the parsed input.
		const parsed = tool.parameters.parse({ query: 'gold', filter: { folder: { equals: 'tenant-b' } } });
		assert.deepStrictEqual(parsed, { query: 'gold' });
	});

	test('scopes retrieval with the filter derived from the tool context', async () => {
		const tool = newKb().asAgentTool<{ tenantId: string }>({
			filter: (context) => ({ folder: { equals: context.tenantId } }),
		});
		const results = await tool.handler({ input: { query: 'gold tier pricing plan' }, context: { tenantId: 'tenant-a' } });
		assert.ok(results.length > 0, 'expected a hit for tenant-a');
		for (const r of results) {
			assert.strictEqual(r.metadata.folder, 'tenant-a');
			assert.ok(!r.text.includes('99 dollars'), `tenant-b content leaked: ${r.text}`);
		}
	});

	test('ignores a filter the model puts in the tool input', async () => {
		const tool = newKb().asAgentTool<{ tenantId: string }>({
			filter: (context) => ({ folder: { equals: context.tenantId } }),
		});
		// Even if the input carries extra keys (a misbehaving provider), only `query` is read.
		const input = { query: 'gold tier pricing plan', filter: { folder: { equals: 'tenant-b' } } };
		const results = await tool.handler({ input, context: { tenantId: 'tenant-a' } });
		assert.ok(results.every((r) => r.metadata.folder === 'tenant-a'));
	});

	test('accepts an async filter callback', async () => {
		const tool = newKb().asAgentTool<{ tenantId: string }>({
			filter: async (context) => ({ folder: { equals: context.tenantId } }),
		});
		const results = await tool.handler({ input: { query: 'gold tier pricing plan' }, context: { tenantId: 'tenant-b' } });
		assert.ok(results.length > 0 && results.every((r) => r.metadata.folder === 'tenant-b'));
	});

	test('an explicit `() => undefined` filter searches the whole knowledge base', async () => {
		const tool = newKb().asAgentTool({ filter: () => undefined, maxResults: 10 });
		const results = await tool.handler({ input: { query: 'gold tier pricing plan' }, context: {} });
		const folders = new Set(results.map((r) => r.metadata.folder));
		assert.ok(folders.has('tenant-a') && folders.has('tenant-b'), `expected both tenants, got ${[...folders]}`);
	});

	test('fails closed when the filter callback throws (no unscoped search)', async () => {
		const tool = newKb().asAgentTool<{ tenantId?: string }>({
			filter: (context) => {
				if (!context.tenantId) throw new Error('no tenant on the session');
				return { folder: { equals: context.tenantId } };
			},
		});
		await assert.rejects(tool.handler({ input: { query: 'gold' }, context: {} }), /no tenant on the session/);
	});

	test('fails closed when the filter callback returns something that would widen the search', async () => {
		const kb = newKb();
		let calls = 0;
		const spy = kb.retrieve.bind(kb);
		kb.retrieve = (...args) => { calls++; return spy(...args); };
		const bad: unknown[] = [null, '', 0, false, {}, [], { folder: { equals: undefined } }, { folder: { equals: '' } }, { folder: {} }, { folder: 'tenant-a' }, { folder: null }];
		for (const value of bad) {
			const tool = kb.asAgentTool({ filter: () => value as never });
			await assert.rejects(
				tool.handler({ input: { query: 'gold tier pricing plan' }, context: {} }),
				(err: unknown) => isBlocksError(err, KnowledgeBaseErrors.ValidationError),
				`expected a ValidationError for ${JSON.stringify(value)}`,
			);
		}
		assert.strictEqual(calls, 0, 'no search runs on an invalid filter');
	});

	test('validates maxResults when the tool is defined', () => {
		const kb = newKb();
		for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			assert.throws(
				() => kb.asAgentTool({ filter: () => undefined, maxResults: bad }),
				(err: unknown) => isBlocksError(err, KnowledgeBaseErrors.ValidationError),
				`expected a ValidationError for maxResults ${bad}`,
			);
		}
	});

	test('a null maxResults falls back to the tool default of 5', async () => {
		const kb = newKb();
		let seen: number | undefined;
		const spy = kb.retrieve.bind(kb);
		kb.retrieve = (query, options) => { seen = options?.maxResults; return spy(query, options); };
		const tool = kb.asAgentTool({ filter: () => undefined, maxResults: null as unknown as number });
		await tool.handler({ input: { query: 'gold' }, context: {} });
		assert.strictEqual(seen, 5);
	});

	test('rejects a missing or non-function filter at definition time', () => {
		const kb = newKb();
		for (const bad of [undefined, null, { folder: { equals: 'tenant-a' } }]) {
			assert.throws(
				// Plain-JS callers can omit the required option; the typed API cannot.
				() => kb.asAgentTool({ filter: bad } as unknown as Parameters<typeof kb.asAgentTool>[0]),
				(err: unknown) => isBlocksError(err, KnowledgeBaseErrors.ValidationError),
			);
		}
	});

	test('returns plain JSON results capped by maxResults', async () => {
		const tool = newKb().asAgentTool({ filter: () => undefined, maxResults: 1 });
		const results = await tool.handler({ input: { query: 'gold tier pricing plan' }, context: {} });
		assert.strictEqual(results.length, 1);
		const [r] = results;
		assert.deepStrictEqual(Object.keys(r).sort(), ['metadata', 'score', 'source', 'text']);
		assert.doesNotThrow(() => JSON.stringify(results));
	});

	test('uses the knowledge base description in the default tool description, and lets you override it', () => {
		assert.match(newKb('Product docs').asAgentTool({ filter: () => undefined }).description, /Product docs/);
		assert.strictEqual(newKb().asAgentTool({ filter: () => undefined, description: 'Search FAQs' }).description, 'Search FAQs');
	});
});
