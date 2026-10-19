// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';

import type { ApiMethod, DiscoveredBlock } from '../contract/v1.js';
import {
	type JsonSchema,
	type RpcMethod,
	SEED_NOTICE,
	type SpecFileReader,
	buildRpcMethodCatalogue,
	deriveSeed,
	schemaTypeText,
} from './rpc-methods.js';

const PROJECT_ROOT = '/tmp/does-not-exist-blocks-app';

/** An ApiNamespace block exactly as discovery reports one. */
function apiBlock(id: string, methods: ApiMethod[]): DiscoveredBlock {
	return {
		type: 'ApiNamespace',
		id,
		fullId: `my-app-${id}`,
		category: 'core',
		file: 'aws-blocks/index.ts',
		line: 12,
		methods,
	};
}

/** A reader seam: returns the given text for any path, or nothing at all. */
function reader(text?: string): SpecFileReader {
	return () => text;
}

function specDocument(methods: unknown[], components?: Record<string, JsonSchema>): string {
	return JSON.stringify({
		openrpc: '1.3.2',
		info: { title: 'my-app', version: '0.0.0' },
		methods,
		...(components === undefined ? {} : { components: { schemas: components } }),
	});
}

function methodNamed(catalogue: { namespaces: { methods: RpcMethod[] }[] }, name: string): RpcMethod {
	for (const namespace of catalogue.namespaces) {
		const found = namespace.methods.find((method) => method.name === name);
		if (found !== undefined) return found;
	}
	throw new Error(`method ${name} is not in the catalogue`);
}

const blogBlocks = [
	apiBlock('blog', [
		{ name: 'getPost', params: [{ name: 'slug' }] },
		{ name: 'listPosts', params: [{ name: 'limit', optional: true }] },
	]),
];

describe('no spec at all', () => {
	it("reports 'source-scan' and keeps every discovered method and parameter name", async () => {
		const catalogue = await buildRpcMethodCatalogue(PROJECT_ROOT, blogBlocks, reader(undefined));

		assert.strictEqual(catalogue.methodsSource, 'source-scan');
		assert.strictEqual(catalogue.methodsError, undefined);
		assert.deepStrictEqual(catalogue.namespaces, [
			{
				namespace: 'blog',
				blockFullId: 'my-app-blog',
				methods: [
					{ name: 'getPost', params: [{ name: 'slug' }], origin: 'source' },
					{ name: 'listPosts', params: [{ name: 'limit', optional: true }], origin: 'source' },
				],
			},
		]);
	});

	it('never mutates the blocks it was given', async () => {
		const blocks = [apiBlock('blog', [{ name: 'getPost', params: [{ name: 'slug' }] }])];
		const snapshot = JSON.stringify(blocks);

		await buildRpcMethodCatalogue(PROJECT_ROOT, blocks, reader(specDocument([])));

		assert.strictEqual(JSON.stringify(blocks), snapshot);
	});
});

describe('a spec covering the discovered methods', () => {
	const spec = specDocument([
		{
			name: 'blog.getPost',
			params: [{ name: 'slug', required: true, schema: { type: 'string' } }],
			result: { name: 'result', schema: { type: 'object', title: 'Post' } },
		},
		{
			name: 'blog.listPosts',
			params: [{ name: 'limit', required: false, schema: { type: 'integer' } }],
		},
	]);

	it("reports 'spec' and attaches types without renaming discovery's parameters", async () => {
		const catalogue = await buildRpcMethodCatalogue(PROJECT_ROOT, blogBlocks, reader(spec));

		assert.strictEqual(catalogue.methodsSource, 'spec');
		assert.strictEqual(catalogue.methodsError, undefined);
		const getPost = methodNamed(catalogue, 'getPost');
		assert.strictEqual(getPost.origin, 'source+spec');
		assert.deepStrictEqual(getPost.params, [
			{
				name: 'slug',
				schema: { type: 'string' },
				required: true,
				type: 'string',
				seedValue: '',
				seedSource: 'schema',
			},
		]);
	});

	it("preserves discovery's own optional flag alongside the schema's required", async () => {
		const catalogue = await buildRpcMethodCatalogue(PROJECT_ROOT, blogBlocks, reader(spec));

		const limit = methodNamed(catalogue, 'listPosts').params[0];
		assert.strictEqual(limit.optional, true);
		assert.strictEqual(limit.required, false);
		assert.strictEqual(limit.type, 'number');
		assert.strictEqual(limit.seedValue, 0);
	});

	it("carries the spec's result schema through", async () => {
		const catalogue = await buildRpcMethodCatalogue(PROJECT_ROOT, blogBlocks, reader(spec));

		assert.deepStrictEqual(methodNamed(catalogue, 'getPost').result, {
			schema: { type: 'object', title: 'Post' },
			type: 'Post',
		});
	});

	it('labels seeds as starting points rather than defaults', () => {
		assert.match(SEED_NOTICE, /not defaults/);
	});
});

describe('a stale spec', () => {
	it('still lists a discovered method the spec is missing', async () => {
		const spec = specDocument([
			{ name: 'blog.getPost', params: [{ name: 'slug', required: true, schema: { type: 'string' } }] },
		]);

		const catalogue = await buildRpcMethodCatalogue(PROJECT_ROOT, blogBlocks, reader(spec));

		assert.strictEqual(catalogue.methodsSource, 'spec');
		assert.deepStrictEqual(
			catalogue.namespaces[0].methods.map((method) => [method.name, method.origin]),
			[
				['getPost', 'source+spec'],
				['listPosts', 'source'],
			],
		);
		// The uncovered method keeps its real parameter name and gains nothing.
		assert.deepStrictEqual(methodNamed(catalogue, 'listPosts').params, [{ name: 'limit', optional: true }]);
	});

	it('lists a spec-only method and flags it', async () => {
		const spec = specDocument([
			{ name: 'blog.getPost', params: [{ name: 'slug', required: true, schema: { type: 'string' } }] },
			{ name: 'blog.listPosts', params: [] },
			{ name: 'blog.deletePost', params: [{ name: 'id', required: true, schema: { type: 'string' } }] },
		]);

		const catalogue = await buildRpcMethodCatalogue(PROJECT_ROOT, blogBlocks, reader(spec));

		const deletePost = methodNamed(catalogue, 'deletePost');
		assert.strictEqual(deletePost.origin, 'spec-only');
		assert.deepStrictEqual(deletePost.params, [
			{
				name: 'id',
				schema: { type: 'string' },
				required: true,
				type: 'string',
				seedValue: '',
				seedSource: 'schema',
				specOnly: true,
			},
		]);
	});

	it('appends a spec parameter the source does not declare, flagged, without reordering', async () => {
		const spec = specDocument([
			{
				name: 'blog.getPost',
				params: [
					{ name: 'slug', required: true, schema: { type: 'string' } },
					{ name: 'draft', required: false, schema: { type: 'boolean' } },
				],
			},
		]);

		const catalogue = await buildRpcMethodCatalogue(PROJECT_ROOT, blogBlocks, reader(spec));

		const params = methodNamed(catalogue, 'getPost').params;
		assert.deepStrictEqual(
			params.map((param) => param.name),
			['slug', 'draft'],
		);
		assert.strictEqual(params[0].specOnly, undefined);
		assert.strictEqual(params[1].specOnly, true);
	});

	it('LISTS a namespace the spec declares and the source does not, and notes it', async () => {
		// Originally this asserted the namespace was dropped with a note. Running
		// the catalogue against the real testbed app showed why that is wrong: a
		// namespace built by `auth.createApi()` is invisible to a source scan and
		// still answers real calls, so dropping it hides working methods.
		const spec = specDocument([
			{ name: 'blog.getPost', params: [{ name: 'slug', required: true, schema: { type: 'string' } }] },
			{ name: 'ghost.vanished', params: [] },
		]);

		const catalogue = await buildRpcMethodCatalogue(PROJECT_ROOT, blogBlocks, reader(spec));

		assert.strictEqual(catalogue.methodsSource, 'spec');
		assert.match(String(catalogue.methodsError), /ghost/);
		assert.match(String(catalogue.methodsError), /blocks\.spec\.json/);
		assert.deepStrictEqual(
			catalogue.namespaces.map((namespace) => namespace.namespace),
			['blog', 'ghost'],
		);
		const ghost = catalogue.namespaces.find((namespace) => namespace.namespace === 'ghost');
		assert.strictEqual(ghost?.methods[0]?.origin, 'spec-only');
		assert.strictEqual(ghost?.blockFullId, undefined);
	});

	it("reports 'spec' when the spec's only contribution is a namespace of its own", async () => {
		// The spec enriched nothing discovered, but it did contribute a namespace
		// and typed methods that would otherwise be unreachable — so the catalogue
		// IS spec-derived in part, and saying 'source-scan' would understate what
		// the user is looking at.
		const catalogue = await buildRpcMethodCatalogue(
			PROJECT_ROOT,
			blogBlocks,
			reader(specDocument([{ name: 'ghost.vanished', params: [] }])),
		);

		assert.strictEqual(catalogue.methodsSource, 'spec');
		const blog = catalogue.namespaces.find((namespace) => namespace.namespace === 'blog');
		// The discovered methods are untouched and still listed as source-only.
		assert.strictEqual(blog?.methods.length, 2);
		for (const method of blog?.methods ?? []) assert.strictEqual(method.origin, 'source');
	});
});

describe('a malformed spec', () => {
	it("degrades to 'source-scan' and names the file and the parse problem", async () => {
		const catalogue = await buildRpcMethodCatalogue(PROJECT_ROOT, blogBlocks, reader('{ "openrpc": '));

		assert.strictEqual(catalogue.methodsSource, 'source-scan');
		assert.match(String(catalogue.methodsError), /blocks\.spec\.json/);
		assert.match(String(catalogue.methodsError), /Could not parse/);
		// Discovery's methods survive a broken spec untouched.
		assert.deepStrictEqual(
			catalogue.namespaces[0].methods.map((method) => method.name),
			['getPost', 'listPosts'],
		);
	});

	it("degrades the same way when 'methods' is not an array", async () => {
		const catalogue = await buildRpcMethodCatalogue(
			PROJECT_ROOT,
			blogBlocks,
			reader(JSON.stringify({ openrpc: '1.3.2', methods: { 'blog.getPost': {} } })),
		);

		assert.strictEqual(catalogue.methodsSource, 'source-scan');
		assert.match(String(catalogue.methodsError), /"methods" is a object, expected an array/);
		assert.strictEqual(catalogue.namespaces[0].methods.length, 2);
	});

	it("degrades the same way when 'methods' is missing entirely", async () => {
		const catalogue = await buildRpcMethodCatalogue(
			PROJECT_ROOT,
			blogBlocks,
			reader(JSON.stringify({ openrpc: '1.3.2' })),
		);

		assert.strictEqual(catalogue.methodsSource, 'source-scan');
		assert.match(String(catalogue.methodsError), /"methods" is missing/);
	});

	it("degrades the same way when the document's top level is not an object", async () => {
		const catalogue = await buildRpcMethodCatalogue(PROJECT_ROOT, blogBlocks, reader('[]'));

		assert.strictEqual(catalogue.methodsSource, 'source-scan');
		assert.match(String(catalogue.methodsError), /top level is an array/);
	});

	it('skips a method name that is not namespace.method rather than offering it', async () => {
		const catalogue = await buildRpcMethodCatalogue(
			PROJECT_ROOT,
			blogBlocks,
			reader(
				specDocument([
					{ name: 'orphan', params: [] },
					{ name: '.leading', params: [] },
				]),
			),
		);

		assert.strictEqual(catalogue.methodsSource, 'source-scan');
		assert.strictEqual(catalogue.methodsError, undefined);
		assert.strictEqual(catalogue.namespaces[0].methods.length, 2);
	});
});

describe('$ref resolution', () => {
	const blocks = [apiBlock('blog', [{ name: 'savePost', params: [{ name: 'post' }] }])];

	it('resolves a local $ref one level into components.schemas', async () => {
		const spec = specDocument(
			[
				{
					name: 'blog.savePost',
					params: [{ name: 'post', required: true, schema: { $ref: '#/components/schemas/Post' } }],
				},
			],
			{ Post: { type: 'object', title: 'Post', properties: { slug: { type: 'string' } } } },
		);

		const catalogue = await buildRpcMethodCatalogue(PROJECT_ROOT, blocks, reader(spec));

		const post = methodNamed(catalogue, 'savePost').params[0];
		assert.deepStrictEqual(post.schema, {
			type: 'object',
			title: 'Post',
			properties: { slug: { type: 'string' } },
		});
		assert.strictEqual(post.type, 'Post');
		assert.deepStrictEqual(post.seedValue, {});
		assert.strictEqual(post.schemaWarning, undefined);
	});

	it("resolves an array's items $ref", async () => {
		const spec = specDocument(
			[
				{
					name: 'blog.savePost',
					params: [
						{
							name: 'post',
							required: true,
							schema: { type: 'array', items: { $ref: '#/components/schemas/Tag' } },
						},
					],
				},
			],
			{ Tag: { type: 'string' } },
		);

		const catalogue = await buildRpcMethodCatalogue(PROJECT_ROOT, blocks, reader(spec));

		const post = methodNamed(catalogue, 'savePost').params[0];
		assert.deepStrictEqual(post.schema, { type: 'array', items: { type: 'string' } });
		assert.strictEqual(post.type, 'string[]');
	});

	it('leaves an unresolvable $ref in place, claims no type, and says so', async () => {
		const spec = specDocument([
			{
				name: 'blog.savePost',
				params: [{ name: 'post', required: true, schema: { $ref: '#/components/schemas/Missing' } }],
			},
		]);

		const catalogue = await buildRpcMethodCatalogue(PROJECT_ROOT, blocks, reader(spec));

		const post = methodNamed(catalogue, 'savePost').params[0];
		assert.deepStrictEqual(post.schema, { $ref: '#/components/schemas/Missing' });
		assert.strictEqual(post.type, undefined);
		assert.match(String(post.schemaWarning), /#\/components\/schemas\/Missing/);
		assert.strictEqual(post.seedValue, null);
		assert.strictEqual(post.seedSource, 'no-schema');
	});

	it('leaves an external $ref in place', async () => {
		const spec = specDocument([
			{
				name: 'blog.savePost',
				params: [{ name: 'post', required: true, schema: { $ref: 'https://example.com/Post.json' } }],
			},
		]);

		const catalogue = await buildRpcMethodCatalogue(PROJECT_ROOT, blocks, reader(spec));

		const post = methodNamed(catalogue, 'savePost').params[0];
		assert.deepStrictEqual(post.schema, { $ref: 'https://example.com/Post.json' });
		assert.match(String(post.schemaWarning), /example\.com/);
	});
});

describe('seed derivation', () => {
	it('derives a seed for every JSON Schema type', () => {
		assert.deepStrictEqual(deriveSeed({ type: 'string' }), { value: '', source: 'schema' });
		assert.deepStrictEqual(deriveSeed({ type: 'number' }), { value: 0, source: 'schema' });
		assert.deepStrictEqual(deriveSeed({ type: 'integer' }), { value: 0, source: 'schema' });
		assert.deepStrictEqual(deriveSeed({ type: 'boolean' }), { value: false, source: 'schema' });
		assert.deepStrictEqual(deriveSeed({ type: 'array' }), { value: [], source: 'schema' });
		assert.deepStrictEqual(deriveSeed({ type: 'object' }), { value: {}, source: 'schema' });
		assert.deepStrictEqual(deriveSeed({ type: 'null' }), { value: null, source: 'schema' });
	});

	it('prefers the first enum member over the type', () => {
		assert.deepStrictEqual(deriveSeed({ type: 'string', enum: ['draft', 'published'] }), {
			value: 'draft',
			source: 'enum',
		});
	});

	it('derives nothing for a type-less schema rather than inventing a value', () => {
		assert.deepStrictEqual(deriveSeed({}), { value: null, source: 'no-schema' });
		assert.deepStrictEqual(deriveSeed({ description: 'anything' }), { value: null, source: 'no-schema' });
		assert.deepStrictEqual(deriveSeed(undefined), { value: null, source: 'no-schema' });
	});

	it('reads the first non-null member of a union type', () => {
		assert.deepStrictEqual(deriveSeed({ type: ['string', 'null'] }), { value: '', source: 'schema' });
		assert.deepStrictEqual(deriveSeed({ type: ['null'] }), { value: null, source: 'schema' });
	});

	it('returns a fresh container each time, so one form cannot poison another', () => {
		const first = deriveSeed({ type: 'array' }).value as unknown[];
		first.push('edited');
		assert.deepStrictEqual(deriveSeed({ type: 'array' }).value, []);
	});

	it('renders readable type text, including enums and unions', () => {
		assert.strictEqual(schemaTypeText({ type: 'string', enum: ['draft', 'published'] }), "'draft' | 'published'");
		assert.strictEqual(schemaTypeText({ type: ['string', 'null'] }), 'string | null');
		assert.strictEqual(schemaTypeText({ type: 'array', items: { type: 'number' } }), 'number[]');
		assert.strictEqual(schemaTypeText({ type: 'array' }), 'unknown[]');
		assert.strictEqual(schemaTypeText({ type: 'unknown' }), 'unknown');
		assert.strictEqual(schemaTypeText({}), undefined);
	});
});

describe('no API blocks', () => {
	it("reports 'unavailable' and says the app declares no API", async () => {
		const blocks: DiscoveredBlock[] = [
			{
				type: 'DistributedTable',
				id: 'posts',
				fullId: 'my-app-posts',
				category: 'data',
				file: 'aws-blocks/index.ts',
				line: 4,
			},
		];

		const catalogue = await buildRpcMethodCatalogue(PROJECT_ROOT, blocks, reader(undefined));

		assert.strictEqual(catalogue.methodsSource, 'unavailable');
		assert.match(String(catalogue.methodsError), /no ApiNamespace block/);
		assert.deepStrictEqual(catalogue.namespaces, []);
	});

	it("reports 'unavailable' for an empty project", async () => {
		const catalogue = await buildRpcMethodCatalogue(PROJECT_ROOT, [], reader(undefined));

		assert.strictEqual(catalogue.methodsSource, 'unavailable');
		assert.deepStrictEqual(catalogue.namespaces, []);
	});

	it('lists an ApiNamespace whose methods could not be read as an empty namespace', async () => {
		const blocks: DiscoveredBlock[] = [
			{
				type: 'ApiNamespace',
				id: 'api',
				fullId: 'my-app-api',
				category: 'core',
				file: 'aws-blocks/index.ts',
				line: 9,
			},
		];

		const catalogue = await buildRpcMethodCatalogue(PROJECT_ROOT, blocks, reader(undefined));

		assert.strictEqual(catalogue.methodsSource, 'source-scan');
		assert.deepStrictEqual(catalogue.namespaces, [{ namespace: 'api', blockFullId: 'my-app-api', methods: [] }]);
	});

	it("reports 'spec' when the spec supplies methods discovery could not read", async () => {
		const blocks: DiscoveredBlock[] = [
			{
				type: 'ApiNamespace',
				id: 'api',
				fullId: 'my-app-api',
				category: 'core',
				file: 'aws-blocks/index.ts',
				line: 9,
			},
		];
		const spec = specDocument([
			{ name: 'api.ping', params: [{ name: 'echo', required: false, schema: { type: 'string' } }] },
		]);

		const catalogue = await buildRpcMethodCatalogue(PROJECT_ROOT, blocks, reader(spec));

		assert.strictEqual(catalogue.methodsSource, 'spec');
		assert.strictEqual(catalogue.namespaces[0].methods[0].origin, 'spec-only');
	});
});

describe('ordering', () => {
	const blocks = [
		apiBlock('users', [{ name: 'getUser', params: [] }]),
		apiBlock('blog', [{ name: 'getPost', params: [] }]),
		apiBlock('admin', [{ name: 'purge', params: [] }]),
	];

	it('orders namespaces stably across calls', async () => {
		const first = await buildRpcMethodCatalogue(PROJECT_ROOT, blocks, reader(undefined));
		const second = await buildRpcMethodCatalogue(PROJECT_ROOT, blocks, reader(undefined));

		assert.deepStrictEqual(
			first.namespaces.map((namespace) => namespace.namespace),
			['admin', 'blog', 'users'],
		);
		assert.deepStrictEqual(first.namespaces, second.namespaces);
	});

	it('orders namespaces the same way when discovery reports the blocks in another order', async () => {
		const forward = await buildRpcMethodCatalogue(PROJECT_ROOT, blocks, reader(undefined));
		const reversed = await buildRpcMethodCatalogue(PROJECT_ROOT, [...blocks].reverse(), reader(undefined));

		assert.deepStrictEqual(forward.namespaces, reversed.namespaces);
	});

	it("keeps the source's own method order and appends spec-only methods sorted", async () => {
		const sourceBlocks = [
			apiBlock('blog', [
				{ name: 'zeta', params: [] },
				{ name: 'alpha', params: [] },
			]),
		];
		const spec = specDocument([
			{ name: 'blog.zeta', params: [] },
			{ name: 'blog.omega', params: [] },
			{ name: 'blog.beta', params: [] },
		]);

		const catalogue = await buildRpcMethodCatalogue(PROJECT_ROOT, sourceBlocks, reader(spec));

		assert.deepStrictEqual(
			catalogue.namespaces[0].methods.map((method) => method.name),
			['zeta', 'alpha', 'beta', 'omega'],
		);
	});
});

describe('the default reader', () => {
	it('finds no spec under a project root that does not exist, and still lists methods', async () => {
		const catalogue = await buildRpcMethodCatalogue(PROJECT_ROOT, blogBlocks);

		assert.strictEqual(catalogue.methodsSource, 'source-scan');
		assert.strictEqual(catalogue.methodsError, undefined);
		assert.strictEqual(catalogue.namespaces[0].methods.length, 2);
	});
});

describe('a namespace the spec declares and the source scan cannot see', () => {
	/**
	 * Found by running the catalogue against the real testbed app, not by any unit
	 * test. `export const authApi = auth.createApi();` builds a namespace from a
	 * FACTORY METHOD, so block discovery — which resolves constructor calls —
	 * cannot see it, while the generated OpenRPC spec, which introspects the
	 * running backend, lists it with both its methods.
	 *
	 * It was being dropped from the catalogue with a note claiming the spec was
	 * stale. It is not stale: `authApi.getAuthState` was verified returning a real
	 * result against a live dev server. Hiding a working namespace AND blaming the
	 * user's spec for our own blind spot is the worst of both outcomes.
	 */
	const factorySpec = specDocument([
		{ name: 'posts.list', params: [] },
		{ name: 'authApi.getAuthState', params: [] },
		{ name: 'authApi.setAuthState', params: [{ name: 'input', schema: { type: 'object' } }] },
	]);
	const sourceBlocks = [apiBlock('posts', [{ name: 'list', params: [] }])];
	const build = () => buildRpcMethodCatalogue(PROJECT_ROOT, sourceBlocks, reader(factorySpec));

	it('lists the namespace instead of dropping it', async () => {
		const catalogue = await build();
		assert.deepStrictEqual(
			catalogue.namespaces.map((entry) => entry.namespace),
			['authApi', 'posts'],
		);
	});

	it('lists all of its methods, flagged spec-only', async () => {
		const catalogue = await build();
		const authApi = catalogue.namespaces.find((entry) => entry.namespace === 'authApi');
		assert.deepStrictEqual(
			authApi?.methods.map((method) => method.name),
			['getAuthState', 'setAuthState'],
		);
		for (const method of authApi?.methods ?? []) assert.strictEqual(method.origin, 'spec-only');
	});

	it('carries no blockFullId, rather than inventing an attribution', async () => {
		const catalogue = await build();
		const authApi = catalogue.namespaces.find((entry) => entry.namespace === 'authApi');
		assert.strictEqual(authApi?.blockFullId, undefined);
	});

	it('keeps the spec-derived parameter names, which are the point of listing it', async () => {
		const catalogue = await build();
		assert.deepStrictEqual(
			methodNamed(catalogue, 'setAuthState').params.map((param) => param.name),
			['input'],
		);
	});

	it('explains the factory case rather than asserting the spec is stale', async () => {
		const catalogue = await build();
		assert.match(catalogue.methodsError ?? '', /authApi/);
		assert.match(catalogue.methodsError ?? '', /createApi|factory/i);
		// The stale reading is offered as a possibility, never as the verdict.
		assert.doesNotMatch(catalogue.methodsError ?? '', /The spec is stale —/);
		assert.strictEqual(catalogue.methodsSource, 'spec');
	});

	it('still reports the source-scanned namespace normally alongside it', async () => {
		const catalogue = await build();
		const posts = catalogue.namespaces.find((entry) => entry.namespace === 'posts');
		assert.strictEqual(posts?.blockFullId, 'my-app-posts');
		assert.strictEqual(posts?.methods[0]?.origin, 'source+spec');
	});
});
