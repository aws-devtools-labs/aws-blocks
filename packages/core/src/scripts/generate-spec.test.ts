/**
 * Integration test for `generateSpec`. Builds a tiny backend file with one
 * normal method and one `@blocksSkipCodegen`-tagged method, runs the spec
 * emitter, and asserts the tagged method is dropped from the OpenRPC
 * document.
 *
 * Uses a `.js` foundation file so plain `node --test dist/...` can run the
 * test without a TypeScript loader. The TS compiler still parses JSDoc on
 * the `.js` file when `allowJs` is enabled in the synthetic tsconfig.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { generateSpec } from './generate-spec.js';
import { ApiNamespace } from '../api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// `import.meta.url` lives in dist/scripts/, so `..` is dist/ and the built
// `api.js` is next to it. Re-using the real ApiNamespace ensures the marker
// symbol matches what `generateSpec` discovers.
const builtApiUrl = pathToFileURL(join(__dirname, '..', 'api.js')).href;

function writeTsconfig(dir: string): void {
	writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
		compilerOptions: {
			target: 'ESNext',
			module: 'ESNext',
			moduleResolution: 'bundler',
			allowJs: true,
			esModuleInterop: true,
			skipLibCheck: true,
		},
	}));
}

describe('generateSpec — @blocksSkipCodegen', () => {
	it('drops methods carrying @blocksSkipCodegen from the OpenRPC document', async () => {
		const dir = join(tmpdir(), `blocks-spec-test-${Date.now()}-skip`);
		mkdirSync(dir, { recursive: true });
		writeTsconfig(dir);

		writeFileSync(join(dir, 'index.js'), `
			import { ApiNamespace } from ${JSON.stringify(builtApiUrl)};

			export const api = new ApiNamespace(null, 'api', (context) => ({
				async normalMethod(name) {
					return { greeting: 'hi ' + name };
				},

				/**
				 * Mock-only helper.
				 * @blocksSkipCodegen
				 */
				async getLastCode() {
					return null;
				},
			}));
		`);

		try {
			const doc = await generateSpec(join(dir, 'index.js'));
			const methodNames = doc.methods.map((m) => m.name).sort();
			assert.deepStrictEqual(
				methodNames,
				['api.normalMethod'],
				'getLastCode should be omitted; only normalMethod should remain',
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('keeps methods that do not carry the tag', async () => {
		const dir = join(tmpdir(), `blocks-spec-test-${Date.now()}-keep`);
		mkdirSync(dir, { recursive: true });
		writeTsconfig(dir);

		writeFileSync(join(dir, 'index.js'), `
			import { ApiNamespace } from ${JSON.stringify(builtApiUrl)};

			export const api = new ApiNamespace(null, 'api', (context) => ({
				/** Plain JSDoc with no special tag. */
				async ping() { return { ok: true }; },
				async echo(s) { return s; },
			}));
		`);

		try {
			const doc = await generateSpec(join(dir, 'index.js'));
			const methodNames = doc.methods.map((m) => m.name).sort();
			assert.deepStrictEqual(methodNames, ['api.echo', 'api.ping']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('generateSpec — namespaces sharing a method name (regression: #445)', () => {
	it('emits each namespace its OWN schema for a same-named method', async () => {
		const dir = join(tmpdir(), `blocks-spec-test-${Date.now()}-collision`);
		mkdirSync(dir, { recursive: true });
		writeTsconfig(dir);

		// Typed foundation for the TS type extractor. `create` has DIFFERENT params
		// in each namespace; binding names (widgets/subscriptions) match the runtime
		// module's export names below.
		writeFileSync(join(dir, 'index.ts'), `
			interface ApiNamespaceConstructor { new <T>(scope: any, name: string, handler: (ctx: any) => T): T; }
			const ApiNamespace: ApiNamespaceConstructor = class {} as any;

			export const widgets = new ApiNamespace(null, 'widgets', () => ({
				async create(label: string): Promise<{ widgetId: string }> { return { widgetId: 'w' }; },
			}));
			export const subscriptions = new ApiNamespace(null, 'subscriptions', () => ({
				async create(topicCount: number): Promise<{ subId: number }> { return { subId: 1 }; },
			}));
		`);

		// Runtime module for namespace discovery (types come from the .ts above via
		// the extractor). Use the real ApiNamespace so the marker symbol matches.
		const widgets = new ApiNamespace(null as any, 'widgets', () => ({ async create(_label: string) { return { widgetId: 'w' }; } }));
		const subscriptions = new ApiNamespace(null as any, 'subscriptions', () => ({ async create(_topicCount: number) { return { subId: 1 }; } }));
		const loader = async () => ({ widgets, subscriptions }) as Record<string, unknown>;

		try {
			const doc = await generateSpec(join(dir, 'index.ts'), loader);
			const byName = new Map(doc.methods.map((m) => [m.name, m]));

			const w = byName.get('widgets.create');
			const s = byName.get('subscriptions.create');
			assert.ok(w && s, 'both namespace-qualified methods should be present');

			// Each keeps its OWN param — no cross-assignment.
			assert.strictEqual(w!.params[0]?.name, 'label');
			assert.strictEqual((w!.params[0] as any)?.schema?.type, 'string');
			assert.strictEqual(s!.params[0]?.name, 'topicCount');
			assert.strictEqual((s!.params[0] as any)?.schema?.type, 'number');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('generateSpec — namespace returned by a factory, then destructured (regression: #444)', () => {
	it('emits real schemas (not unknown) for a factory/destructured namespace', async () => {
		const dir = join(tmpdir(), `blocks-spec-test-${Date.now()}-factory`);
		mkdirSync(dir, { recursive: true });
		writeTsconfig(dir);

		// Typed foundation: one directly-exported namespace and one built inside a
		// factory, returned as a property, destructured, and re-exported. Both use
		// `create` with DIFFERENT params so a regression would cross-assign or emit
		// unknown.
		writeFileSync(join(dir, 'index.ts'), `
			interface ApiNamespaceConstructor { new <T>(scope: any, name: string, handler: (ctx: any) => T): T; }
			const ApiNamespace: ApiNamespaceConstructor = class {} as any;
			class Scope { constructor(id: string) {} }

			class Factory {
				constructor(private readonly scope: Scope) {}
				build() {
					return {
						subscriptions: new ApiNamespace(this.scope, 'subscriptions', () => ({
							async create(topicCount: number): Promise<{ subId: number }> { return { subId: 1 }; },
						})),
					};
				}
			}

			const scope = new Scope('app');
			export const widgets = new ApiNamespace(scope, 'widgets', () => ({
				async create(label: string): Promise<{ widgetId: string }> { return { widgetId: 'w' }; },
			}));
			const { subscriptions } = new Factory(scope).build();
			export { subscriptions };
		`);

		const widgets = new ApiNamespace(null as any, 'widgets', () => ({ async create(_label: string) { return { widgetId: 'w' }; } }));
		const subscriptions = new ApiNamespace(null as any, 'subscriptions', () => ({ async create(_topicCount: number) { return { subId: 1 }; } }));
		const loader = async () => ({ widgets, subscriptions }) as Record<string, unknown>;

		try {
			const doc = await generateSpec(join(dir, 'index.ts'), loader);
			const byName = new Map(doc.methods.map((m) => [m.name, m]));
			const w = byName.get('widgets.create');
			const s = byName.get('subscriptions.create');
			assert.ok(w && s, 'both qualified methods present');
			// The factory-returned namespace keeps its own param, not `unknown` and
			// not the direct namespace's `string`.
			assert.strictEqual((s!.params[0] as any)?.schema?.type, 'number');
			assert.strictEqual((w!.params[0] as any)?.schema?.type, 'string');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('generateSpec — inferred transferable type args', () => {
	it('emits a client generic resolved to a string-literal union as an inline enum type arg', async () => {
		const dir = join(tmpdir(), `blocks-spec-test-${Date.now()}-type-args`);
		mkdirSync(dir, { recursive: true });
		writeTsconfig(dir);

		// The client generic is inferred through a helper in another module, the
		// way AuthOIDC.createApi() types getClient() as OIDCClient<ProviderName<P>>.
		writeFileSync(join(dir, 'oidc.ts'), `
			interface ApiNamespaceConstructor { new <T>(scope: any, name: string, handler: (ctx: any) => T): T; }
			const ApiNamespace: ApiNamespaceConstructor = class {} as any;
			interface OIDCClientDescriptor { __blocks: 'oidc/client'; providers: string[]; }
			export interface OIDCClient<Provider extends string = string> {
				signIn(provider: Provider): Promise<void>;
				toJSON(): OIDCClientDescriptor;
			}
			export function createOidcApi<N extends string>(providers: readonly N[]) {
				return new ApiNamespace(null, 'oidc', () => ({
					getClient: async (): Promise<OIDCClient<N>> => null as any,
				}));
			}
		`);
		writeFileSync(join(dir, 'index.ts'), `
			import { createOidcApi } from './oidc.js';
			export const oidcAuthApi = createOidcApi(['google', 'github']);
			export const looseAuthApi = createOidcApi([] as string[]);
		`);

		const client = { toJSON: () => ({ __blocks: 'oidc/client', providers: [] }) };
		const oidcAuthApi = new ApiNamespace(null as any, 'oidc', () => ({ async getClient() { return client; } }));
		const looseAuthApi = new ApiNamespace(null as any, 'oidc', () => ({ async getClient() { return client; } }));
		const loader = async () => ({ oidcAuthApi, looseAuthApi }) as Record<string, unknown>;

		try {
			const doc = await generateSpec(join(dir, 'index.ts'), loader);
			const byName = new Map(doc.methods.map((m) => [m.name, m]));
			assert.deepStrictEqual(byName.get('oidcAuthApi.getClient')?.result?.schema, {
				'x-blocks-transferable': 'oidc/client',
				'x-blocks-type-args': [{ type: 'string', enum: ['google', 'github'] }],
			});
			// No component schema is hoisted for an inline enum.
			assert.deepStrictEqual(Object.keys(doc.components?.schemas ?? {}), []);
			// A plain `string` provider is the default, so no type args are emitted.
			assert.deepStrictEqual(byName.get('looseAuthApi.getClient')?.result?.schema, {
				'x-blocks-transferable': 'oidc/client',
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('generateSpec — one component per type name', () => {
	const NS_MOCK = `
		interface ApiNamespaceConstructor { new <T>(scope: any, name: string, handler: (ctx: any) => T): T; }
		const ApiNamespace: ApiNamespaceConstructor = class {} as any;
	`;
	async function specOf(files: Record<string, string>, methods: string[]) {
		const dir = mkdtempSync(join(tmpdir(), 'blocks-spec-test-'));
		writeTsconfig(dir);
		for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
		const api = new ApiNamespace(null as any, 'api', () =>
			Object.fromEntries(methods.map((m) => [m, async () => null])),
		);
		try {
			return await generateSpec(join(dir, 'index.ts'), async () => ({ api }) as Record<string, unknown>);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	/** Capture `console.warn` while `run` runs. */
	async function warnings<T>(run: () => Promise<T>): Promise<{ value: T; warned: string[] }> {
		const warned: string[] = [];
		const original = console.warn;
		console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(' '));
		try {
			return { value: await run(), warned };
		} finally {
			console.warn = original;
		}
	}
	/** Every `$ref` in `doc` names a component. */
	function assertRefsResolve(doc: any): void {
		const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]);
		for (const ref of refs) assert.ok(doc.components?.schemas?.[ref], `$ref ${ref} resolves`);
	}

	it('two Building Blocks forwarding a same-named type: each described where used, with a warning (no failure)', async () => {
		// As an app forwarding bb-kv-store's and bb-file-bucket's `ScanOptions`.
		const { value: doc, warned } = await warnings(() =>
			specOf(
				{
					'kv.ts': 'export interface ScanOptions { prefix?: string; limit?: number }',
					'files.ts': 'export interface ScanOptions { prefix: string; delimiter?: string; maxKeys?: number }',
					'index.ts': `
						import type { ScanOptions as KvScan } from './kv.js';
						import type { ScanOptions as FileScan } from './files.js';
						${NS_MOCK}
						export const api = new ApiNamespace(null, 'api', () => ({
							async listKeys(options: KvScan): Promise<string[]> { return []; },
							async listFiles(options: FileScan): Promise<string[]> { return []; },
						}));
					`,
				},
				['listKeys', 'listFiles'],
			),
		);
		const param = (m: string) => doc.methods.find((x) => x.name === `api.${m}`)?.params[0]?.schema as any;
		// The one the name went to before (the first by method name, `listFiles`'s) keeps it.
		assert.deepStrictEqual(param('listFiles'), { $ref: '#/components/schemas/ScanOptions' });
		assert.deepStrictEqual(
			Object.keys((doc.components?.schemas?.ScanOptions as any)?.properties).sort(),
			['delimiter', 'maxKeys', 'prefix'],
		);
		// The other, decoded with the wrong shape before, is described where it is used.
		assert.deepStrictEqual(Object.keys(param('listKeys').properties).sort(), ['limit', 'prefix']);
		assert.strictEqual(warned.length, 1, warned.join('\n'));
		assert.match(warned[0], /2 different types are named "ScanOptions"/);
		assert.match(warned[0], /Rename one type, or share one declaration/);
		assert.match(warned[0], /kv\.ts#ScanOptions/);
		assert.match(warned[0], /files\.ts#ScanOptions/);
		assertRefsResolve(doc);
	});

	it('a recursive generic used with two type arguments: a valid spec, the first keeps the name', async () => {
		const doc = await specOf(
			{
				'index.ts': `
					${NS_MOCK}
					interface Tree<T> { value: T; children: Tree<T>[] }
					export const api = new ApiNamespace(null, 'api', () => ({
						async words(): Promise<Tree<string>> { return { value: '', children: [] }; },
						async numbers(): Promise<Tree<number>> { return { value: 0, children: [] }; },
					}));
				`,
			},
			['words', 'numbers'],
		);
		assertRefsResolve(doc);
		const result = (m: string) => doc.methods.find((x) => x.name === `api.${m}`)?.result.schema as any;
		assert.deepStrictEqual(result('words'), { $ref: '#/components/schemas/Tree' }, 'found first: keeps Tree');
		assert.strictEqual((doc.components?.schemas?.Tree as any)?.properties.value.type, 'string');
		assert.strictEqual(result('numbers').properties.value.type, 'number');
		// Typed levels below, then the recursion is cut.
		assert.strictEqual(result('numbers').properties.children.items.properties.value.type, 'number');
	});

	it('an expanding generic (Nest<T> holding Nest<T[]>) stops instead of overflowing the stack', async () => {
		const { value: doc, warned } = await warnings(() =>
			specOf(
				{
					'index.ts': `
						${NS_MOCK}
						interface Nest<T> { value: T; inner?: Nest<T[]> }
						export const api = new ApiNamespace(null, 'api', () => ({
							async nest(): Promise<Nest<string>> { return { value: '' }; },
							async ping(): Promise<{ ok: boolean }> { return { ok: true }; },
						}));
					`,
				},
				['nest', 'ping'],
			),
		);
		// The cut, and the deep levels' `value` (string[][][][][][][]…); no method lost its types.
		assert.strictEqual(warned.length, 2, warned.join('\n'));
		assert.match(warned[0], /`Nest\.value` nests unnamed objects or arrays more than 6 levels deep/);
		assert.match(warned[1], /`Nest` nests itself at `Nest\.inner`; the OpenRPC spec describes it 9 levels deep/);
		const result = (m: string) => doc.methods.find((x) => x.name === `api.${m}`)?.result.schema as any;
		assert.deepStrictEqual(result('nest'), { $ref: '#/components/schemas/Nest' });
		const nest = doc.components?.schemas?.Nest as any;
		assert.strictEqual(nest.properties.value.type, 'string');
		assert.strictEqual(nest.properties.inner.properties.value.type, 'array', 'the first expansions are kept');
		assert.strictEqual(result('ping').properties.ok.type, 'boolean', 'the other methods keep their types');
		assertRefsResolve(doc);
	});

	it('differently instantiated generics: the first keeps the shared name (its native type stays X), the others are inline', async () => {
		const doc = await specOf(
			{
				'index.ts': `
					${NS_MOCK}
					interface Member<P extends string = string> { userId: string; provider: P }
					export const api = new ApiNamespace(null, 'api', () => ({
						async password(): Promise<Member<'password'>> { return { userId: 'u', provider: 'password' }; },
						async okta(): Promise<Member<'password' | 'okta'>> { return { userId: 'u', provider: 'okta' }; },
						async again(): Promise<Member<'password'>> { return { userId: 'u', provider: 'password' }; },
					}));
				`,
			},
			['password', 'okta', 'again'],
		);
		const result = (name: string) => doc.methods.find((m) => m.name === `api.${name}`)?.result.schema as any;
		// The schema the name went to before (the first found, `password`'s) keeps it:
		// an app's native `Member` stays `Member`. The other, mistyped before, is inline.
		assert.deepStrictEqual((doc.components?.schemas?.Member as any)?.properties?.provider?.enum, ['password']);
		assert.deepStrictEqual(result('password'), { $ref: '#/components/schemas/Member' });
		assert.deepStrictEqual(result('again'), { $ref: '#/components/schemas/Member' });
		assert.deepStrictEqual([...result('okta').properties.provider.enum].sort(), ['okta', 'password']);
		assert.ok(!JSON.stringify(doc).includes('x-blocks-declaration'), 'the internal marker is stripped');

		const agreeing = await specOf(
			{
				'index.ts': `
					${NS_MOCK}
					interface Member<P extends string = string> { userId: string; provider: P }
					export const api = new ApiNamespace(null, 'api', () => ({
						async one(): Promise<Member<'password'>> { return { userId: 'u', provider: 'password' }; },
						async two(): Promise<Member<'password'>> { return { userId: 'u', provider: 'password' }; },
					}));
				`,
			},
			['one', 'two'],
		);
		assert.ok(agreeing.components?.schemas?.Member, 'one shared component');
		assert.deepStrictEqual(agreeing.methods.find((m) => m.name === 'api.one')?.result.schema, {
			$ref: '#/components/schemas/Member',
		});
	});

	it('mutually recursive types keep their names (the outermost of each), with no dangling $ref', async () => {
		const { value: doc, warned } = await warnings(() => specOf(
			{
				'index.ts': `
					${NS_MOCK}
					interface A { name: string; b?: B }
					interface B { count: number; a?: A }
					export const api = new ApiNamespace(null, 'api', () => ({
						async getA(): Promise<A> { return { name: '' }; },
					}));
				`,
			},
			['getA'],
		));
		assertRefsResolve(doc);
		assert.deepStrictEqual(doc.methods.find((m) => m.name === 'api.getA')?.result.schema, {
			$ref: '#/components/schemas/A',
		});
		assert.deepStrictEqual((doc.components?.schemas?.A as any)?.properties.b, { $ref: '#/components/schemas/B' });
		assert.ok(doc.components?.schemas?.B, 'B keeps its name');
		// A → B → A → B → A: both types of the pair count.
		assert.strictEqual(warned.length, 1, warned.join('\n'));
		assert.match(warned[0], /`B` nests itself at `A\.b`; the OpenRPC spec describes it 5 levels deep/);
	});

	it('mutually recursive types both returned: each keeps its name, the other is described inside it', async () => {
		const doc = await specOf(
			{
				'index.ts': `
					${NS_MOCK}
					interface A { name: string; b?: B }
					interface B { count: number; a?: A }
					export const api = new ApiNamespace(null, 'api', () => ({
						async getA(): Promise<A> { return { name: '' }; },
						async getB(): Promise<B> { return { count: 0 }; },
					}));
				`,
			},
			['getA', 'getB'],
		);
		assertRefsResolve(doc);
		const a = doc.components?.schemas?.A as any;
		const b = doc.components?.schemas?.B as any;
		// Not a $ref cycle (A.b → B, B.a → A), which Swift and Kotlin cannot generate.
		assert.strictEqual(a?.properties.b.properties.count.type, 'number');
		assert.strictEqual(b?.properties.a.properties.name.type, 'string');
		assert.ok(!JSON.stringify(doc.components).includes('"$ref"'), 'no $ref between A and B');
	});

	it('a deep DAG of named types is converted once per type, not once per path', async () => {
		// D0 → D1 (twice) → D2 (twice) … : 2^20 paths, 21 types.
		const levels = 20;
		const decls = Array.from({ length: levels + 1 }, (_, i) =>
			i === levels ? `interface D${i} { leaf: string }` : `interface D${i} { a: D${i + 1}; b: D${i + 1} }`,
		).join('\n');
		const started = performance.now();
		const { value: doc, warned } = await warnings(() =>
			specOf(
				{
					'index.ts': `
						${NS_MOCK}
						${decls}
						export const api = new ApiNamespace(null, 'api', () => ({
							async dag(): Promise<D0> { return {} as D0; },
						}));
					`,
				},
				['dag'],
			),
		);
		const ms = performance.now() - started;
		// Each type converted once: no size limit reached, nothing cut.
		assert.deepStrictEqual(warned, []);
		assertRefsResolve(doc);
		assert.strictEqual(Object.keys(doc.components?.schemas ?? {}).length, levels + 1);
		assert.deepStrictEqual((doc.components?.schemas?.D0 as any)?.properties.a, { $ref: '#/components/schemas/D1' });
		assert.ok(ms < 5_000, `took ${ms.toFixed(0)} ms`);
	});

	it('distinct nested instantiations of one generic are kept (Box<Box<Box<Box<Box<string>>>>>)', async () => {
		const { value: doc, warned } = await warnings(() =>
			specOf(
				{
					'index.ts': `
						${NS_MOCK}
						interface Box<T> { value: T }
						export const api = new ApiNamespace(null, 'api', () => ({
							async boxes(): Promise<Box<Box<Box<Box<Box<string>>>>>> { return {} as never; },
						}));
					`,
				},
				['boxes'],
			),
		);
		assert.deepStrictEqual(warned, []);
		assertRefsResolve(doc);
		let node = doc.methods.find((m) => m.name === 'api.boxes')?.result.schema as any;
		let levels = 0;
		while (node) {
			if (node.$ref) node = doc.components?.schemas?.[node.$ref.split('/').pop()];
			if (!node?.properties?.value) break;
			levels++;
			node = node.properties.value;
		}
		assert.strictEqual(levels, 5);
		assert.strictEqual(node.type, 'string');
	});

	it('a recursive JSON value type stops at the nesting limit, with every level above it typed', async () => {
		const { value: doc, warned } = await warnings(() =>
			specOf(
				{
					'index.ts': `
						${NS_MOCK}
						type Json = string | number | boolean | null | { [key: string]: Json } | Json[];
						interface Meta { input?: Json }
						export const api = new ApiNamespace(null, 'api', () => ({
							async meta(): Promise<Meta> { return {}; },
						}));
					`,
				},
				['meta'],
			),
		);
		assertRefsResolve(doc);
		const meta = JSON.stringify(doc.components?.schemas?.Meta);
		assert.ok(meta.length < 5_000, `bounded: ${meta.length} characters`);
		assert.ok(meta.includes('"additionalProperties":{"type":"unknown"}'), 'deep objects are open maps');
		assert.ok(meta.includes('"items":{"type":"unknown"}'), 'deep arrays are arrays of any values');
		assert.strictEqual(warned.length, 1, warned.join('\n'));
		assert.match(warned[0], /`Meta\.input` nests unnamed objects or arrays more than 6 levels deep/);
	});

	it('unnamed objects and arrays past the nesting limit keep their data; leaves and named types keep their types', async () => {
		const { value: doc, warned } = await warnings(() =>
			specOf(
				{
					'index.ts': `
						${NS_MOCK}
						interface Leafy { x: string }
						export const api = new ApiNamespace(null, 'api', () => ({
							async deep(): Promise<{ l1: { l2: { l3: { l4: { l5: { l6: { leaf: string; named: Leafy; tags: string[]; leafies: Leafy[]; rows: { id: string }[]; l7: { leaf: string } } } } } } } }> {
								return {} as never;
							},
						}));
					`,
				},
				['deep'],
			),
		);
		assertRefsResolve(doc);
		let node = doc.methods.find((m) => m.name === 'api.deep')?.result.schema as any;
		for (const key of ['l1', 'l2', 'l3', 'l4', 'l5', 'l6']) node = node?.properties?.[key];
		assert.deepStrictEqual(node.properties.leaf, { type: 'string' }, 'a string past the limit stays a string');
		assert.deepStrictEqual(node.properties.named, { $ref: '#/components/schemas/Leafy' }, 'a named type is described');
		assert.deepStrictEqual(node.properties.tags, { type: 'array', items: { type: 'string' } });
		assert.deepStrictEqual(node.properties.leafies, { type: 'array', items: { $ref: '#/components/schemas/Leafy' } });
		assert.deepStrictEqual(node.properties.rows, { type: 'array', items: { type: 'unknown' } });
		assert.deepStrictEqual(node.properties.l7, { type: 'object', additionalProperties: { type: 'unknown' } });
		assert.strictEqual(warned.length, 2, warned.join('\n'));
		// Named by the method, and the path from it.
		assert.match(warned[0], /`deep\(\)\.l1\.l2\.l3\.l4\.l5\.l6\.rows` nests unnamed objects or arrays more than 6 levels deep/);
		assert.match(warned[1], /`deep\(\)\.l1\.l2\.l3\.l4\.l5\.l6\.l7` nests unnamed objects or arrays/);
	});

	it('a recursive type keeps four typed levels, then an object with any fields, with a warning naming the field', async () => {
		const { value: doc, warned } = await warnings(() =>
			specOf(
				{
					'index.ts': `
						${NS_MOCK}
						interface Comment { text: string; replies: Comment[] }
						export const api = new ApiNamespace(null, 'api', () => ({
							async thread(): Promise<Comment> { return { text: '', replies: [] }; },
						}));
					`,
				},
				['thread'],
			),
		);
		assertRefsResolve(doc);
		let node = doc.components?.schemas?.Comment as any;
		let levels = 0;
		while (node?.properties?.replies) {
			levels++;
			assert.strictEqual(node.properties.text.type, 'string');
			node = node.properties.replies.items;
		}
		assert.strictEqual(levels, 4, 'at least the three typed levels the old depth limit gave');
		// An object with any fields: native clients keep the nested data (not an empty type that drops it).
		assert.deepStrictEqual(node, { type: 'object', additionalProperties: { type: 'unknown' } });
		assert.strictEqual(warned.length, 1, warned.join('\n'));
		assert.match(warned[0], /`Comment` nests itself at `Comment\.replies`/);
	});
});

describe('generateSpec — tuples', () => {
	const NS_MOCK = `
		interface ApiNamespaceConstructor { new <T>(scope: any, name: string, handler: (ctx: any) => T): T; }
		const ApiNamespace: ApiNamespaceConstructor = class {} as any;
	`;

	it('describes a tuple with prefixItems, hoisting a named element type to a component', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'blocks-spec-test-'));
		writeTsconfig(dir);
		writeFileSync(
			join(dir, 'index.ts'),
			`${NS_MOCK}
			interface Point { x: number; y: number }
			type Kind = { kind: 'a'; a: string } | { kind: 'b'; b: number };
			export const api = new ApiNamespace(null, 'api', () => ({
				async between(range: [number, number]): Promise<[Point, Point]> { return [{ x: 0, y: 0 }, { x: 1, y: 1 }]; },
				async tagged(): Promise<[string, Kind]> { return ['', { kind: 'a', a: '' }]; },
			}));`,
		);
		const api = new ApiNamespace(null as any, 'api', () => ({ between: async () => null, tagged: async () => null }));
		let doc: any;
		try {
			doc = await generateSpec(join(dir, 'index.ts'), async () => ({ api }) as Record<string, unknown>);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		const between = doc.methods.find((m: any) => m.name === 'api.between');
		assert.deepStrictEqual(between.params[0].schema, {
			type: 'array',
			prefixItems: [{ type: 'number' }, { type: 'number' }],
			minItems: 2,
			maxItems: 2,
		});
		assert.deepStrictEqual(between.result.schema, {
			type: 'array',
			prefixItems: [{ $ref: '#/components/schemas/Point' }, { $ref: '#/components/schemas/Point' }],
			minItems: 2,
			maxItems: 2,
		});
		assert.ok(doc.components.schemas.Point, 'the named element type is a component');
		assert.ok(!JSON.stringify(doc).includes('"length"'), 'no tuple is described as an object with a length');
		const tagged = doc.methods.find((m: any) => m.name === 'api.tagged');
		assert.strictEqual(tagged.result.schema.prefixItems[1].oneOf.length, 2);
	});
});

describe('generateSpec — a namespace typed through a mapped type (`(...args: A)` methods)', () => {
	it('describes each parameter by its tuple label, required or optional', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'blocks-spec-test-'));
		writeTsconfig(dir);
		// `AsyncAPI<T>` (core) and `ProtectedApi<T>` (bb-auth) both map each method to
		// `(...args: Parameters) => Promise<…>`; a namespace built by a helper reaches
		// the extractor only through that type.
		writeFileSync(join(dir, 'index.ts'), `
			type Mapped<T extends Record<string, (...args: any[]) => any>> = {
				[K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
			};
			declare function helper<T extends Record<string, (...args: any[]) => any>>(make: () => T): Mapped<T>;
			export const notes = helper(() => ({
				async rename(id: string, title?: string): Promise<{ ok: boolean }> { return { ok: true }; },
			}));
		`);
		const notes = new ApiNamespace(null as any, 'notes', () => ({ async rename(_id: string, _title?: string) { return { ok: true }; } }));
		try {
			const doc = await generateSpec(join(dir, 'index.ts'), async () => ({ notes }) as Record<string, unknown>);
			const rename = doc.methods.find((m) => m.name === 'notes.rename');
			assert.ok(rename, 'notes.rename is in the spec');
			assert.deepStrictEqual(
				rename.params.map((p: any) => ({ name: p.name, required: p.required, type: p.schema?.type })),
				[
					{ name: 'id', required: true, type: 'string' },
					{ name: 'title', required: false, type: 'string' },
				],
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('generateSpec — a namespace with a discovery handler', () => {
	it('lists the methods the discovery handler returns, not only the request handler', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'blocks-spec-test-'));
		writeTsconfig(dir);
		writeFileSync(join(dir, 'index.js'), 'export {};\n');
		let served = 0;
		const gated = new ApiNamespace(null as any, 'gated', () => {
			served++;
			return { async open() { return 1; } };
		});
		Reflect.set(gated, Symbol.for('blocks:ApiNamespaceDiscover'), () => ({
			async open() { return 1; },
			async closed(name: string) { return name; },
		}));
		try {
			const doc = await generateSpec(join(dir, 'index.js'), async () => ({ gated }) as Record<string, unknown>);
			assert.deepStrictEqual(doc.methods.map((m) => m.name).sort(), ['gated.closed', 'gated.open']);
			assert.strictEqual(served, 0, 'the request handler is not called when a discovery handler exists');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('generateSpec — a discovery handler that throws', () => {
	it('warns, naming the namespace and the error, and leaves only that namespace out', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'blocks-spec-test-'));
		writeTsconfig(dir);
		writeFileSync(join(dir, 'index.js'), 'export {};\n');
		const broken = new ApiNamespace(null as any, 'broken', () => ({ async a() { return 1; } }));
		Reflect.set(broken, Symbol.for('blocks:ApiNamespaceDiscover'), () => {
			throw new Error('user.profile is undefined');
		});
		const fine = new ApiNamespace(null as any, 'fine', () => ({ async b() { return 2; } }));
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
		try {
			const doc = await generateSpec(join(dir, 'index.js'), async () => ({ broken, fine }) as Record<string, unknown>);
			assert.deepStrictEqual(doc.methods.map((m) => m.name), ['fine.b']);
			const warning = warnings.find((w) => w.includes("'broken'"));
			assert.ok(warning, `a warning names the namespace (got: ${JSON.stringify(warnings)})`);
			assert.match(warning, /user\.profile is undefined/);
		} finally {
			console.warn = original;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
