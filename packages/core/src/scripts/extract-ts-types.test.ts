// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for extract-ts-types.ts — verifies that `new ApiNamespace(...)`
 * calls and indirect calls (e.g., auth.createApi()) produce proper type info.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CodegenTagError, describeOrWarn, extractMethodTypes, extractSkipCodegenMethods, type JsonSchema } from './extract-ts-types.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function createTempProject(files: Record<string, string>): string {
	const dir = join(tmpdir(), `blocks-ts-test-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		const filePath = join(dir, name);
		mkdirSync(join(filePath, '..'), { recursive: true });
		writeFileSync(filePath, content);
	}
	return dir;
}

/** Minimal mock so `new ApiNamespace(scope, name, handler)` parses as a NewExpression and types correctly. */
const API_NS_MOCK = `
	interface ApiNamespaceConstructor { new <T>(scope: any, name: string, handler: (ctx: any) => T): T; }
	const ApiNamespace: ApiNamespaceConstructor = class {} as any;
`;

describe('extractMethodTypes — namespaces sharing a method name (regression: #445)', () => {
	it('keys methods by namespace, so a shared method name does not cross-assign schemas', () => {
		const dir = createTempProject({
			'tsconfig.json': JSON.stringify({
				compilerOptions: { target: 'ESNext', module: 'ESNext', moduleResolution: 'bundler', strict: true },
			}),
			'index.ts': `
				${API_NS_MOCK}

				// Two namespaces both expose \`create\`, with deliberately incompatible contracts.
				export const widgets = new ApiNamespace(null, 'widgets', (context) => ({
					async create(label: string): Promise<{ widgetId: string }> {
						return { widgetId: 'w' };
					},
				}));
				export const subscriptions = new ApiNamespace(null, 'subscriptions', (context) => ({
					async create(topicCount: number): Promise<{ subId: number }> {
						return { subId: 1 };
					},
				}));
			`,
		});

		try {
			const types = extractMethodTypes(join(dir, 'index.ts'));
			// Distinct qualified keys — no collision.
			assert.ok(types.has('widgets.create'), 'widgets.create should be keyed by namespace');
			assert.ok(types.has('subscriptions.create'), 'subscriptions.create should be keyed by namespace');
			assert.ok(!types.has('create'), 'no bare-name entry that could cross-assign');

			// Each keeps its OWN parameter type.
			assert.strictEqual(types.get('widgets.create')!.params[0].name, 'label');
			assert.strictEqual(types.get('widgets.create')!.params[0].schema.type, 'string');
			assert.strictEqual(types.get('subscriptions.create')!.params[0].name, 'topicCount');
			assert.strictEqual(types.get('subscriptions.create')!.params[0].schema.type, 'number');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('extractMethodTypes — direct ApiNamespace calls', () => {
	it('extracts param and return types from inline ApiNamespace', () => {
		const dir = createTempProject({
			'tsconfig.json': JSON.stringify({
				compilerOptions: {
					target: 'ESNext',
					module: 'ESNext',
					moduleResolution: 'bundler',
					strict: true,
				},
			}),
			'index.ts': `
				${API_NS_MOCK}

				interface User { id: string; name: string; }

				export const api = new ApiNamespace(null, 'api', (context) => ({
					async getUser(id: string): Promise<User | null> {
						return null;
					},
					async createUser(name: string, age: number) {
						return { success: true };
					},
				}));
			`,
		});

		try {
			const types = extractMethodTypes(join(dir, 'index.ts'));
			assert.ok(types.has('api.getUser'), 'should find getUser');
			assert.ok(types.has('api.createUser'), 'should find createUser');

			const getUser = types.get('api.getUser')!;
			assert.strictEqual(getUser.params.length, 1);
			assert.strictEqual(getUser.params[0].name, 'id');
			assert.strictEqual(getUser.params[0].schema.type, 'string');

			const createUser = types.get('api.createUser')!;
			assert.strictEqual(createUser.params.length, 2);
			assert.strictEqual(createUser.params[0].schema.type, 'string');
			assert.strictEqual(createUser.params[1].schema.type, 'number');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// `new ApiNamespace(scope, name, handler, { compute })` — the handler is the third
// argument, not the last; taking the options object as the handler dropped every
// method (methods became `unknown` and `@blocksSkipCodegen` tags were missed).
describe('ApiNamespace with a fourth options argument', () => {
	const tsconfig = JSON.stringify({ compilerOptions: { target: 'ESNext', module: 'ESNext', moduleResolution: 'bundler', strict: true } });

	it('extractMethodTypes reads the handler, not the options object', () => {
		const dir = createTempProject({
			'tsconfig.json': tsconfig,
			'index.ts': `
				interface ApiNamespaceConstructor { new <T>(scope: any, name: string, handler: (ctx: any) => T, options?: { compute?: unknown }): T; }
				const ApiNamespace: ApiNamespaceConstructor = class {} as any;
				const compute = {};

				export const reports = new ApiNamespace(null, 'reportsApi', (context) => ({
					async build(month: string): Promise<{ rows: number }> {
						return { rows: 1 };
					},
				}), { compute });
			`,
		});
		try {
			const types = extractMethodTypes(join(dir, 'index.ts'));
			const build = types.get('reports.build');
			assert.ok(build, 'should find reports.build');
			assert.strictEqual(build.params[0].schema.type, 'string');
			assert.strictEqual(build.returnType.type, 'object');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('extractSkipCodegenMethods still finds @blocksSkipCodegen methods', () => {
		const dir = createTempProject({
			'index.ts': `
				class ApiNamespace { constructor(scope: any, name: any, handler: any, options?: any) {} }

				export const reports = new ApiNamespace(null, 'reports', (context) => ({
					async build() { return { ok: true }; },

					/**
					 * @blocksSkipCodegen
					 */
					async devOnly() { return null; },
				}), { compute: {} });
			`,
		});
		try {
			const skipped = extractSkipCodegenMethods(join(dir, 'index.ts'));
			assert.ok(skipped.has('reports.devOnly'), `devOnly should be skipped: ${[...skipped].join(', ')}`);
			assert.ok(!skipped.has('reports.build'));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('extractSkipCodegenMethods — pure-AST scan', () => {
	it('returns names of methods tagged with @blocksSkipCodegen, ignoring untagged ones', () => {
		const dir = createTempProject({
			// No tsconfig deliberately — this entry must work without one,
			// since `extractMethodTypes` may crash on a half-resolvable
			// program but the JSDoc scan should still succeed.
			'index.ts': `
				class ApiNamespace { constructor(scope: any, name: any, handler: any) {} }

				export const api = new ApiNamespace(null, 'api', (context) => ({
					async normalMethod() { return { ok: true }; },

					/**
					 * @blocksSkipCodegen
					 */
					async devOnly() { return null; },

					/** Plain JSDoc, not tagged. */
					async alsoNormal() { return 1; },
				}));
			`,
		});

		try {
			const skips = extractSkipCodegenMethods(join(dir, 'index.ts'));
			assert.strictEqual(skips.size, 1);
			assert.ok(skips.has('api.devOnly'), 'skip set is namespace-qualified');
			assert.ok(!skips.has('api.normalMethod'));
			assert.ok(!skips.has('api.alsoNormal'));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('qualifies skip names by namespace so a tag on one namespace does not drop another (regression: #445)', () => {
		const dir = createTempProject({
			'index.ts': `
				class ApiNamespace { constructor(scope: any, name: any, handler: any) {} }

				export const widgets = new ApiNamespace(null, 'widgets', () => ({
					/** @blocksSkipCodegen */
					async create() { return null; },
				}));
				// subscriptions.create is NOT tagged and must survive.
				export const subscriptions = new ApiNamespace(null, 'subscriptions', () => ({
					async create() { return null; },
				}));
			`,
		});
		try {
			const skips = extractSkipCodegenMethods(join(dir, 'index.ts'));
			assert.ok(skips.has('widgets.create'), 'tagged method is skipped, qualified');
			assert.ok(!skips.has('subscriptions.create'), 'untagged same-named method must NOT be skipped');
			assert.ok(!skips.has('create'), 'no bare key that would drop both');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('returns an empty set when the file has no ApiNamespace calls', () => {
		const dir = createTempProject({
			'index.ts': `export const x = 1;`,
		});
		try {
			const skips = extractSkipCodegenMethods(join(dir, 'index.ts'));
			assert.strictEqual(skips.size, 0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('extractMethodTypes — @blocksSkipCodegen JSDoc tag', () => {
	it('flags methods with @blocksSkipCodegen so the spec emitter can drop them', () => {
		const dir = createTempProject({
			'tsconfig.json': JSON.stringify({
				compilerOptions: {
					target: 'ESNext',
					module: 'ESNext',
					moduleResolution: 'bundler',
					strict: true,
				},
			}),
			'index.ts': `
				${API_NS_MOCK}

				export const api = new ApiNamespace(null, 'api', (context) => ({
					async normalMethod() {
						return { ok: true };
					},

					/**
					 * Mock-only helper. Should not show up in native codegen.
					 * @blocksSkipCodegen
					 */
					async getLastCode() {
						return null as { code: string } | null;
					},
				}));
			`,
		});

		try {
			const types = extractMethodTypes(join(dir, 'index.ts'));
			assert.strictEqual(types.get('api.normalMethod')?.skipCodegen, undefined);
			assert.strictEqual(types.get('api.getLastCode')?.skipCodegen, true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('extractMethodTypes — indirect ApiNamespace calls (e.g., auth.createApi())', () => {
	it('extracts types from methods returned by a helper method', () => {
		const dir = createTempProject({
			'tsconfig.json': JSON.stringify({
				compilerOptions: {
					target: 'ESNext',
					module: 'ESNext',
					moduleResolution: 'bundler',
					strict: true,
				},
			}),
			'auth.ts': `
				${API_NS_MOCK}

				interface AuthState {
					isSignedIn: boolean;
					username: string | null;
					error?: string;
				}

				export class DemoAuth {
					createApi() {
						return new ApiNamespace(null, 'auth', (context) => ({
							async getAuthState(): Promise<AuthState> {
								return { isSignedIn: false, username: null };
							},
							async setAuthState(action: string, fields: Record<string, string>): Promise<AuthState> {
								return { isSignedIn: false, username: null };
							},
						}));
					}
				}
			`,
			'index.ts': `
				import { DemoAuth } from './auth.js';

				${API_NS_MOCK}

				const auth = new DemoAuth();

				export const api = new ApiNamespace(null, 'api', (context) => ({
					async greet(name: string) {
						return { message: 'hello ' + name };
					},
				}));

				export const authApi = auth.createApi();
			`,
		});

		try {
			const types = extractMethodTypes(join(dir, 'index.ts'));

			// Direct ApiNamespace methods should still work
			assert.ok(types.has('api.greet'), 'should find greet from direct ApiNamespace');
			const greet = types.get('api.greet')!;
			assert.strictEqual(greet.params[0].name, 'name');
			assert.strictEqual(greet.params[0].schema.type, 'string');

			// Indirect methods from auth.createApi() should now be resolved
			assert.ok(types.has('authApi.getAuthState'), 'should find getAuthState from auth.createApi()');
			assert.ok(types.has('authApi.setAuthState'), 'should find setAuthState from auth.createApi()');

			const getAuthState = types.get('authApi.getAuthState')!;
			assert.strictEqual(getAuthState.params.length, 0, 'getAuthState has no params');
			assert.strictEqual(getAuthState.returnType.type, 'object', 'return type should be object');
			assert.ok(getAuthState.returnType.properties, 'return type should have properties');
			assert.ok('isSignedIn' in getAuthState.returnType.properties!, 'should have isSignedIn');
			assert.ok('username' in getAuthState.returnType.properties!, 'should have username');

			const setAuthState = types.get('authApi.setAuthState')!;
			assert.strictEqual(setAuthState.params.length, 2, 'setAuthState has 2 params');
			assert.strictEqual(setAuthState.params[0].name, 'action');
			assert.strictEqual(setAuthState.params[0].schema.type, 'string');
			assert.strictEqual(setAuthState.params[1].name, 'fields');
			assert.strictEqual(setAuthState.params[1].schema.type, 'object');
			// Record<string, string> should emit additionalProperties: { type: 'string' }
			assert.deepStrictEqual(setAuthState.params[1].schema.additionalProperties, { type: 'string' },
				'Record<string, string> should have additionalProperties: { type: "string" }');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('does not overwrite methods already found by AST walk', () => {
		const dir = createTempProject({
			'tsconfig.json': JSON.stringify({
				compilerOptions: {
					target: 'ESNext',
					module: 'ESNext',
					moduleResolution: 'bundler',
					strict: true,
				},
			}),
			'index.ts': `
				${API_NS_MOCK}

				// new ApiNamespace — AST walk finds this
				export const api = new ApiNamespace(null, 'api', (context) => ({
					async greet(name: string) {
						return { message: 'hello ' + name };
					},
				}));
			`,
		});

		try {
			const types = extractMethodTypes(join(dir, 'index.ts'));
			assert.ok(types.has('api.greet'), 'should find greet');
			// The AST-walk version should be preserved (it has richer info from the declaration)
			assert.strictEqual(types.get('api.greet')!.params[0].name, 'name');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});


describe('extractMethodTypes — @blocksCodegenDefaultTypeArgs (one native shape for a per-instance narrowing)', () => {
	const TSCONFIG = JSON.stringify({
		compilerOptions: { target: 'ESNext', module: 'ESNext', moduleResolution: 'bundler', strict: true },
	});
	/**
	 * A Building Block that narrows per instance, like `Auth`: `K` is the
	 * instance's subset of `Action`. The tagged types are described at their
	 * defaults; `PlainStep` and `PlainApi` are the same shapes, untagged.
	 */
	const BLOCK = `
		${API_NS_MOCK}

		export type Action = { action: 'signIn'; username: string } | { action: 'signOut' } | { action: 'listPasskeys' };
		export interface State { state: string }
		export type AnyStep = { name: 'sms'; session: string } | { name: 'totp'; session: string } | { name: 'newPassword' };

		/**
		 * The block's client surface.
		 *
		 * @blocksCodegenDefaultTypeArgs
		 */
		export interface TaggedApi<I extends Action = Action> {
			getState(): Promise<State>;
			setState(input: I): Promise<State>;
			setMany(inputs: I[]): Promise<State>;
		}
		export interface PlainApi<I extends Action = Action> {
			setState(input: I): Promise<State>;
		}

		/** @blocksCodegenDefaultTypeArgs */
		export type Step<K extends AnyStep['name'] = AnyStep['name']> = Extract<AnyStep, { name: K | 'newPassword' }>;
		export type Result<K extends AnyStep['name'] = AnyStep['name']> = { status: 'next'; step: Step<K> } | { status: 'done' };
		/** @blocksCodegenDefaultTypeArgs */
		export interface Preference<K extends string = 'sms' | 'totp'> { enabled: K[] }
		export type PlainStep<K extends AnyStep['name'] = AnyStep['name']> = Extract<AnyStep, { name: K | 'newPassword' }>;

		export class Block<const A extends Action['action'], const K extends AnyStep['name']> {
			constructor(readonly allowed: readonly A[], readonly factors: readonly K[]) {}
			createApi(): TaggedApi<Extract<Action, { action: A }>> {
				return new ApiNamespace(null, 'auth', () => ({
					async getState() { return { state: 'x' }; },
					async setState(_input: Action) { return { state: 'x' }; },
					async setMany(_inputs: Action[]) { return { state: 'x' }; },
				}));
			}
			createPlainApi(): PlainApi<Extract<Action, { action: A }>> {
				return new ApiNamespace(null, 'plain', () => ({
					async setState(_input: Action) { return { state: 'x' }; },
				}));
			}
			signIn(): Result<K> { return { status: 'done' }; }
			preference(): Preference<K> { return { enabled: [] }; }
			plainStep(): PlainStep<K> { return { name: 'newPassword' }; }
		}
	`;
	const INDEX = `
		import { Block } from './block.js';
		${API_NS_MOCK}

		const password = new Block(['signIn', 'signOut'], ['sms']);
		const federated = new Block(['signOut'], ['totp']);

		export const passwordApi = password.createApi();
		export const federatedApi = federated.createApi();
		export const plainApi = federated.createPlainApi();
		export const api = new ApiNamespace(null, 'api', (context) => ({
			async passwordSignIn() { return password.signIn(); },
			async federatedSignIn() { return federated.signIn(); },
			async passwordPreference() { return password.preference(); },
			async passwordPlainStep() { return password.plainStep(); },
		}));
	`;
	const values = (schema: JsonSchema | undefined, key: string): unknown[] =>
		(schema?.oneOf ?? (schema ? [schema] : [])).flatMap((arm) => arm.properties?.[key]?.enum ?? []).sort();
	const extract = (block = BLOCK) => {
		const dir = createTempProject({ 'tsconfig.json': TSCONFIG, 'block.ts': block, 'index.ts': INDEX });
		try {
			return extractMethodTypes(join(dir, 'index.ts'));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};

	it('describes a tagged namespace interface at its default type arguments', () => {
		const types = extract();
		const password = types.get('passwordApi.setState');
		const federated = types.get('federatedApi.setState');
		assert.ok(password && federated, 'both namespaces are extracted');
		// Two differently narrowed instances share one schema: the full union.
		assert.deepStrictEqual(values(password.params[0].schema, 'action'), ['listPasskeys', 'signIn', 'signOut']);
		assert.deepStrictEqual(federated.params[0].schema, password.params[0].schema);
		// Nested uses of the type parameter are at the default too.
		const many = types.get('federatedApi.setMany')?.params[0].schema.items;
		assert.ok(many && !Array.isArray(many));
		assert.deepStrictEqual(values(many, 'action'), ['listPasskeys', 'signIn', 'signOut']);
		// The untagged twin keeps the instantiated type.
		assert.deepStrictEqual(values(types.get('plainApi.setState')?.params[0].schema, 'action'), ['signOut']);
	});

	it('describes a tagged alias or interface at its defaults wherever it appears', () => {
		const types = extract();
		const sms = types.get('api.passwordSignIn')?.returnType;
		const totp = types.get('api.federatedSignIn')?.returnType;
		assert.ok(sms && totp);
		// Nested inside an untagged union: the tagged `Step<K>` is every step.
		assert.deepStrictEqual(sms, totp, 'differently narrowed blocks, one schema');
		const next = sms.oneOf?.find((arm) => arm.properties?.status?.enum?.[0] === 'next');
		assert.deepStrictEqual(values(next?.properties?.step, 'name'), ['newPassword', 'sms', 'totp']);

		const enabled = types.get('api.passwordPreference')?.returnType.properties?.enabled;
		assert.ok(enabled?.items && !Array.isArray(enabled.items));
		assert.deepStrictEqual(enabled.items.enum?.slice().sort(), ['sms', 'totp']);

		// An untagged alias keeps the narrowed instantiation.
		assert.deepStrictEqual(values(types.get('api.passwordPlainStep')?.returnType, 'name'), ['newPassword', 'sms']);
	});

	it('rejects a misplaced tag instead of falling back', () => {
		const misuses: [string, RegExp][] = [
			[`/** @blocksCodegenDefaultTypeArgs */\nexport interface Bare { x: string }`, /needs a default \(it has none\)/],
			[`/** @blocksCodegenDefaultTypeArgs */\nexport type NoDefault<T> = { x: T };`, /needs a default \(it has T without one\)/],
			[`/** @blocksCodegenDefaultTypeArgs */\ntype Hidden<T = string> = { x: T };\nexport type Shown = Hidden;`, /must be exported/],
		];
		for (const [declaration, message] of misuses) {
			assert.throws(
				() => extract(`${BLOCK}\n${declaration}`),
				(e: Error) => e instanceof CodegenTagError && message.test(e.message),
				declaration,
			);
		}
	});
});

// ── Transferable detection ──────────────────────────────────────────────────
// A "transferable" is a return type carrying a live handle (e.g.
// `RealtimeChannel`, `FileDownloadHandle`). It implements `toJSON()` returning
// a descriptor with a `__blocks: '<tag>'` literal. The spec emitter lowers that
// into `x-blocks-transferable: '<tag>'` so native client codegen can reconstruct
// a live handle on the receiving side. These tests target detection — the
// emission step is straight-line glue and is exercised end-to-end every time
// a customer's BB returns a transferable.

const TRANSFERABLE_TSCONFIG = JSON.stringify({
	compilerOptions: {
		target: 'ESNext',
		module: 'ESNext',
		moduleResolution: 'bundler',
		strict: true,
		esModuleInterop: true,
		skipLibCheck: true,
	},
});

/**
 * Inline definitions of the transferable protocol + a couple of common
 * handles. Reusing one source-of-truth string keeps the per-test fixtures
 * small and focused on the variation under test.
 */
const TRANSFERABLE_PRELUDE = `
	${API_NS_MOCK}

	interface RealtimeChannelDescriptor { __blocks: 'realtime/channel'; channel: string; }
	interface RealtimeChannel<T = unknown> {
		subscribe(handler: (message: T) => void): void;
		toJSON(): RealtimeChannelDescriptor;
	}

	interface FileDownloadDescriptor { __blocks: 'file-bucket/download'; url: string; }
	interface FileDownloadHandle {
		download(): Promise<Blob>;
		toJSON(): FileDownloadDescriptor;
	}
`;

describe('extractMethodTypes — transferable detection', () => {
	it('identifies a generic transferable and resolves its written type arg', () => {
		const dir = createTempProject({
			'tsconfig.json': TRANSFERABLE_TSCONFIG,
			'index.ts': `
				${TRANSFERABLE_PRELUDE}
				interface CursorPosition { userId: string; x: number; y: number; }
				export const api = new ApiNamespace(null, 'api', () => ({
					async getCursorChannel(): Promise<RealtimeChannel<CursorPosition>> { return null as any; },
				}));
			`,
		});
		try {
			const info = extractMethodTypes(join(dir, 'index.ts')).get('api.getCursorChannel');
			assert.ok(info, 'method should be discovered');
			assert.ok(info.transferable, 'should be detected as transferable');
			assert.strictEqual(info.transferable.blocksTag, 'realtime/channel');
			assert.strictEqual(info.transferable.typeArgs.length, 1);
			const arg = info.transferable.typeArgs[0];
			assert.strictEqual(arg.title, 'CursorPosition');
			assert.strictEqual(arg.properties?.userId?.type, 'string');
			assert.strictEqual(arg.properties?.x?.type, 'number');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('identifies a non-generic transferable with no type args', () => {
		const dir = createTempProject({
			'tsconfig.json': TRANSFERABLE_TSCONFIG,
			'index.ts': `
				${TRANSFERABLE_PRELUDE}
				export const api = new ApiNamespace(null, 'api', () => ({
					async getDownload(): Promise<FileDownloadHandle> { return null as any; },
				}));
			`,
		});
		try {
			const info = extractMethodTypes(join(dir, 'index.ts')).get('api.getDownload');
			assert.ok(info?.transferable);
			assert.strictEqual(info.transferable.blocksTag, 'file-bucket/download');
			assert.deepStrictEqual(info.transferable.typeArgs, []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('distinguishes default-unknown from explicit-unknown type args', () => {
		const dir = createTempProject({
			'tsconfig.json': TRANSFERABLE_TSCONFIG,
			'index.ts': `
				${TRANSFERABLE_PRELUDE}
				export const api = new ApiNamespace(null, 'api', () => ({
					async defaulted(): Promise<RealtimeChannel> { return null as any; },
					async explicit(): Promise<RealtimeChannel<unknown>> { return null as any; },
				}));
			`,
		});
		try {
			const types = extractMethodTypes(join(dir, 'index.ts'));
			assert.deepStrictEqual(types.get('api.defaulted')?.transferable?.typeArgs, []);
			assert.deepStrictEqual(types.get('api.explicit')?.transferable?.typeArgs, [{}]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('keeps an inferred channel message type out of the spec', () => {
		// Native generators can't decode every inferred message type (an `any`, a primitive), so a channel needs written args.
		const dir = createTempProject({
			'tsconfig.json': TRANSFERABLE_TSCONFIG,
			'index.ts': `
				${TRANSFERABLE_PRELUDE}
				interface CursorPosition { userId: string; x: number; y: number; }
				declare function channelOf<T = unknown>(name: string): RealtimeChannel<T>;
				export const api = new ApiNamespace(null, 'api', () => ({
					async inferred() { return channelOf<CursorPosition>('cursors'); },
					async inferredAny() { return channelOf<any>('cursors'); },
					async inferredNames() { return channelOf<'online' | 'away'>('status'); },
				}));
			`,
		});
		try {
			const types = extractMethodTypes(join(dir, 'index.ts'));
			assert.strictEqual(types.get('api.inferred')?.transferable?.blocksTag, 'realtime/channel');
			assert.deepStrictEqual(types.get('api.inferred')?.transferable?.typeArgs, []);
			assert.deepStrictEqual(types.get('api.inferredAny')?.transferable?.typeArgs, []);
			// String literals reach the spec only for an oidc/client's provider names.
			assert.deepStrictEqual(types.get('api.inferredNames')?.transferable?.typeArgs, []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('resolves a helper-built client generic to a string-literal enum, as AuthOIDC.createApi() does', () => {
		const dir = createTempProject({
			'tsconfig.json': TRANSFERABLE_TSCONFIG,
			'oidc.ts': `
				${API_NS_MOCK}
				interface ProviderConfig { readonly name: string; }
				type ProviderName<P extends readonly ProviderConfig[]> = P[number]['name'];
				interface OIDCClientDescriptor { __blocks: 'oidc/client'; providers: string[]; }
				export interface OIDCClient<Provider extends string = string> {
					signIn(provider: Provider): Promise<void>;
					toJSON(): OIDCClientDescriptor;
				}
				export function provider<N extends string>(name: N): { readonly name: N } { return { name }; }
				export class AuthOIDC<P extends readonly ProviderConfig[]> {
					constructor(readonly options: { providers: P }) {}
					createApi() {
						return new ApiNamespace(null, 'auth', () => ({
							getClient: async (): Promise<OIDCClient<ProviderName<P>>> => null as any,
						}));
					}
				}
			`,
			'index.ts': `
				import { AuthOIDC, provider } from './oidc.js';
				const typed = new AuthOIDC({ providers: [provider('google'), provider('github')] });
				const loose = new AuthOIDC({ providers: [] as { readonly name: string }[] });
				const parsed = new AuthOIDC({ providers: JSON.parse('[]') });
				export const oidcAuthApi = typed.createApi();
				export const looseAuthApi = loose.createApi();
				export const parsedAuthApi = parsed.createApi();
			`,
		});
		try {
			const types = extractMethodTypes(join(dir, 'index.ts'));
			const typed = types.get('oidcAuthApi.getClient')?.transferable;
			assert.strictEqual(typed?.blocksTag, 'oidc/client');
			assert.deepStrictEqual(typed.typeArgs, [{ type: 'string', enum: ['google', 'github'] }]);
			// Provider names that resolve to plain `string` or `any` name no providers, so the client stays untyped.
			for (const name of ['looseAuthApi.getClient', 'parsedAuthApi.getClient']) {
				const untyped = types.get(name)?.transferable;
				assert.strictEqual(untyped?.blocksTag, 'oidc/client', name);
				assert.deepStrictEqual(untyped.typeArgs, [], name);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('returns no transferable info when toJSON is missing or __blocks is not a literal', () => {
		const dir = createTempProject({
			'tsconfig.json': TRANSFERABLE_TSCONFIG,
			'index.ts': `
				${API_NS_MOCK}
				interface Plain { value: number; }
				interface NotLiteral { toJSON(): { __blocks: string; channel: string }; }
				export const api = new ApiNamespace(null, 'api', () => ({
					async plain(): Promise<Plain> { return null as any; },
					async loose(): Promise<NotLiteral> { return null as any; },
				}));
			`,
		});
		try {
			const types = extractMethodTypes(join(dir, 'index.ts'));
			assert.strictEqual(types.get('api.plain')?.transferable, undefined);
			assert.strictEqual(types.get('api.loose')?.transferable, undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('detects transferables imported from another module', () => {
		const dir = createTempProject({
			'tsconfig.json': TRANSFERABLE_TSCONFIG,
			'handles.ts': `
				export interface MessageDescriptor { __blocks: 'realtime/channel'; channel: string; }
				export interface MessageChannel<T = unknown> {
					subscribe(h: (m: T) => void): void;
					toJSON(): MessageDescriptor;
				}
			`,
			'index.ts': `
				import type { MessageChannel } from './handles.js';
				${API_NS_MOCK}
				interface Notification { id: string; message: string; }
				export const api = new ApiNamespace(null, 'api', () => ({
					async getNotifications(): Promise<MessageChannel<Notification>> { return null as any; },
				}));
			`,
		});
		try {
			const info = extractMethodTypes(join(dir, 'index.ts')).get('api.getNotifications');
			assert.ok(info?.transferable);
			assert.strictEqual(info.transferable.blocksTag, 'realtime/channel');
			assert.strictEqual(info.transferable.typeArgs[0]?.title, 'Notification');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	const IOT_MODULE_PRELUDE = `
		export interface Reading { celsius: number; }
		export interface DeviceLinkDescriptor { __blocks: 'example-iot/device-link'; linkId: string; }
		export interface DeviceLink<T> { toJSON(): DeviceLinkDescriptor; reading: T; }
	`;

	it('resolves the written type arg when the namespace comes from a declared interface', () => {
		const dir = createTempProject({
			'tsconfig.json': TRANSFERABLE_TSCONFIG,
			'iot.ts': `
				${IOT_MODULE_PRELUDE}
				export interface IotApi { getLink(id: string): Promise<DeviceLink<Reading>>; }
				export declare class Iot { createApi(): IotApi; }
			`,
			'index.ts': `
				import type { Iot } from './iot.js';
				declare const iot: Iot;
				export const iotApi = iot.createApi();
			`,
		});
		try {
			const info = extractMethodTypes(join(dir, 'index.ts')).get('iotApi.getLink');
			assert.ok(info?.transferable, 'should be detected as transferable');
			assert.strictEqual(info.transferable.blocksTag, 'example-iot/device-link');
			assert.strictEqual(info.transferable.typeArgs.length, 1, 'arity-1 tag needs its written type arg');
			assert.strictEqual(info.transferable.typeArgs[0]?.title, 'Reading');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('resolves the written type arg when the declared interface returns the transferable synchronously', () => {
		const dir = createTempProject({
			'tsconfig.json': TRANSFERABLE_TSCONFIG,
			'iot.ts': `
				${IOT_MODULE_PRELUDE}
				export interface IotApi { getLink(id: string): DeviceLink<Reading>; }
				export declare class Iot { createApi(): IotApi; }
			`,
			'index.ts': `
				import type { Iot } from './iot.js';
				declare const iot: Iot;
				export const iotApi = iot.createApi();
			`,
		});
		try {
			const info = extractMethodTypes(join(dir, 'index.ts')).get('iotApi.getLink');
			assert.ok(info?.transferable, 'should be detected as transferable');
			assert.strictEqual(info.transferable.typeArgs.length, 1, 'an unwrapped return passes straight through');
			assert.strictEqual(info.transferable.typeArgs[0]?.title, 'Reading');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('reads the return node through a method-shaped property on a declared interface', () => {
		const dir = createTempProject({
			'tsconfig.json': TRANSFERABLE_TSCONFIG,
			'iot.ts': `
				${IOT_MODULE_PRELUDE}
				export interface IotApi { getLink: (id: string) => Promise<DeviceLink<Reading>>; }
				export declare class Iot { createApi(): IotApi; }
			`,
			'index.ts': `
				import type { Iot } from './iot.js';
				declare const iot: Iot;
				export const iotApi = iot.createApi();
			`,
		});
		try {
			const info = extractMethodTypes(join(dir, 'index.ts')).get('iotApi.getLink');
			assert.ok(info?.transferable, 'should be detected as transferable');
			assert.strictEqual(info.transferable.typeArgs.length, 1, 'the return node sits inside the function type');
			assert.strictEqual(info.transferable.typeArgs[0]?.title, 'Reading');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('resolves the written type arg through a handler literal typed by the AsyncAPI mapped type', () => {
		const dir = createTempProject({
			'tsconfig.json': TRANSFERABLE_TSCONFIG,
			'iot.ts': `
				${IOT_MODULE_PRELUDE}
				type AsyncAPI<T extends Record<string, (...a: never[]) => unknown>> = {
					[K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never;
				};
				export declare function mk<T extends Record<string, (...a: never[]) => unknown>>(h: T): AsyncAPI<T>;
			`,
			'index.ts': `
				import { mk } from './iot.js';
				import type { DeviceLink, Reading } from './iot.js';
				export const iotApi = mk({
					getLink: (): Promise<DeviceLink<Reading>> => null as unknown as Promise<DeviceLink<Reading>>,
				});
			`,
		});
		try {
			const info = extractMethodTypes(join(dir, 'index.ts')).get('iotApi.getLink');
			assert.ok(info?.transferable, 'should be detected as transferable');
			assert.strictEqual(info.transferable.typeArgs.length, 1, 'the handler annotation carries the type arg');
			assert.strictEqual(info.transferable.typeArgs[0]?.title, 'Reading');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('resolves the written type arg when the namespace comes from a class method', () => {
		const dir = createTempProject({
			'tsconfig.json': TRANSFERABLE_TSCONFIG,
			'iot.ts': `
				${IOT_MODULE_PRELUDE}
				export declare class IotApi { getLink(id: string): Promise<DeviceLink<Reading>>; }
				export declare class Iot { createApi(): IotApi; }
			`,
			'index.ts': `
				import type { Iot } from './iot.js';
				declare const iot: Iot;
				export const iotApi = iot.createApi();
			`,
		});
		try {
			const info = extractMethodTypes(join(dir, 'index.ts')).get('iotApi.getLink');
			assert.ok(info?.transferable, 'should be detected as transferable');
			assert.strictEqual(info.transferable.typeArgs.length, 1, 'a class method annotates itself');
			assert.strictEqual(info.transferable.typeArgs[0]?.title, 'Reading');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('resolves the written type arg through a parenthesized function-type annotation', () => {
		const dir = createTempProject({
			'tsconfig.json': TRANSFERABLE_TSCONFIG,
			'iot.ts': `
				${IOT_MODULE_PRELUDE}
				export interface IotApi {
					getLink: ((id: string) => (Promise<DeviceLink<Reading>>));
					sync(): (Promise<DeviceLink<Reading>>);
					inner(): Promise<(DeviceLink<Reading>)>;
				}
				export declare class Iot { createApi(): IotApi; }
			`,
			'index.ts': `
				import type { Iot } from './iot.js';
				declare const iot: Iot;
				export const iotApi = iot.createApi();
			`,
		});
		try {
			const info = extractMethodTypes(join(dir, 'index.ts')).get('iotApi.getLink');
			assert.ok(info?.transferable, 'should be detected as transferable');
			assert.strictEqual(info.transferable.typeArgs.length, 1, 'parentheses do not hide the function type');
			assert.strictEqual(info.transferable.typeArgs[0]?.title, 'Reading');
			const types = extractMethodTypes(join(dir, 'index.ts'));
			const sync = types.get('iotApi.sync')?.transferable?.typeArgs.length;
			assert.strictEqual(sync, 1, 'nor a parenthesized return');
			const inner = types.get('iotApi.inner')?.transferable?.typeArgs.length;
			assert.strictEqual(inner, 1, 'nor a parenthesized argument');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('resolves the written type arg when a class declares the method as a function-typed property', () => {
		const dir = createTempProject({
			'tsconfig.json': TRANSFERABLE_TSCONFIG,
			'iot.ts': `
				${IOT_MODULE_PRELUDE}
				export declare class IotApi { getLink: (id: string) => Promise<DeviceLink<Reading>>; }
				export declare class Iot { createApi(): IotApi; }
			`,
			'index.ts': `
				import type { Iot } from './iot.js';
				declare const iot: Iot;
				export const iotApi = iot.createApi();
			`,
		});
		try {
			const info = extractMethodTypes(join(dir, 'index.ts')).get('iotApi.getLink');
			assert.ok(info?.transferable, 'should be detected as transferable');
			assert.strictEqual(info.transferable.typeArgs.length, 1, 'a class property annotates the function type');
			assert.strictEqual(info.transferable.typeArgs[0]?.title, 'Reading');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('resolves the written type arg through a function-expression handler property', () => {
		const dir = createTempProject({
			'tsconfig.json': TRANSFERABLE_TSCONFIG,
			'iot.ts': `
				${IOT_MODULE_PRELUDE}
				type AsyncAPI<T extends Record<string, (...a: never[]) => unknown>> = {
					[K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never;
				};
				export declare function mk<T extends Record<string, (...a: never[]) => unknown>>(h: T): AsyncAPI<T>;
			`,
			'index.ts': `
				import { mk } from './iot.js';
				import type { DeviceLink, Reading } from './iot.js';
				export const iotApi = mk({
					getLink: function (): Promise<DeviceLink<Reading>> {
						return null as unknown as Promise<DeviceLink<Reading>>;
					},
				});
			`,
		});
		try {
			const info = extractMethodTypes(join(dir, 'index.ts')).get('iotApi.getLink');
			assert.ok(info?.transferable, 'should be detected as transferable');
			assert.strictEqual(info.transferable.typeArgs.length, 1, 'a function expression annotates itself');
			assert.strictEqual(info.transferable.typeArgs[0]?.title, 'Reading');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// Consumers read these positionally and need one per declared parameter, so a list the
	// customer only partly wrote is emitted as none rather than shifting the rest left.
	it('emits nothing when a trailing type parameter is filled from its default', () => {
		const dir = createTempProject({
			'tsconfig.json': TRANSFERABLE_TSCONFIG,
			'iot.ts': `
				export interface Reading { celsius: number; }
				export interface PairDescriptor { __blocks: 'example-iot/pair'; }
				export interface Pair<A, B = string> { toJSON(): PairDescriptor; a: A; b: B; }
				export interface IotApi { pair(): Promise<Pair<Reading>>; }
				export declare class Iot { createApi(): IotApi; }
			`,
			'index.ts': `
				import type { Iot } from './iot.js';
				declare const iot: Iot;
				export const iotApi = iot.createApi();
			`,
		});
		try {
			const info = extractMethodTypes(join(dir, 'index.ts')).get('iotApi.pair');
			assert.strictEqual(info?.transferable?.blocksTag, 'example-iot/pair');
			assert.deepStrictEqual(info?.transferable?.typeArgs, []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('emits nothing when a utility wrapper stands between the annotation and the transferable', () => {
		const dir = createTempProject({
			'tsconfig.json': TRANSFERABLE_TSCONFIG,
			'iot.ts': `
				export interface Reading { celsius: number; }
				export interface StreamDescriptor { __blocks: 'example-iot/stream'; }
				export interface Stream<T = unknown> { toJSON(): StreamDescriptor; item: T; }
				export interface IotApi {
					defaulted(): Awaited<Promise<Stream>>;
					explicit(): Awaited<Promise<Stream<Reading>>>;
				}
				export declare class Iot { createApi(): IotApi; }
			`,
			'index.ts': `
				import type { Iot } from './iot.js';
				declare const iot: Iot;
				export const iotApi = iot.createApi();
			`,
		});
		try {
			const types = extractMethodTypes(join(dir, 'index.ts'));
			assert.strictEqual(types.get('iotApi.defaulted')?.transferable?.blocksTag, 'example-iot/stream');
			assert.deepStrictEqual(types.get('iotApi.defaulted')?.transferable?.typeArgs, []);
			// `Awaited<…>`'s own argument is not the transferable's, so neither form emits one.
			assert.deepStrictEqual(types.get('iotApi.explicit')?.transferable?.typeArgs, []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('emits no type args when the handler leaves its return type inferred', () => {
		const dir = createTempProject({
			'tsconfig.json': TRANSFERABLE_TSCONFIG,
			'iot.ts': `
				${IOT_MODULE_PRELUDE}
				type AsyncAPI<T extends Record<string, (...a: never[]) => unknown>> = {
					[K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never;
				};
				export declare function mk<T extends Record<string, (...a: never[]) => unknown>>(h: T): AsyncAPI<T>;
			`,
			'index.ts': `
				import { mk } from './iot.js';
				import type { DeviceLink, Reading } from './iot.js';
				export const iotApi = mk({
					getLink: async () => null as unknown as DeviceLink<Reading>,
				});
			`,
		});
		try {
			const info = extractMethodTypes(join(dir, 'index.ts')).get('iotApi.getLink');
			assert.ok(info?.transferable, 'the tag is still detected');
			assert.deepStrictEqual(info.transferable.typeArgs, []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('leaves the transferable undetected for a union or an optional method', () => {
		const dir = createTempProject({
			'tsconfig.json': TRANSFERABLE_TSCONFIG,
			'iot.ts': `
				${IOT_MODULE_PRELUDE}
				export interface IotApi {
					maybe(): Promise<DeviceLink<Reading> | undefined>;
					optional?(): Promise<DeviceLink<Reading>>;
				}
				export declare class Iot { createApi(): IotApi; }
			`,
			'index.ts': `
				import type { Iot } from './iot.js';
				declare const iot: Iot;
				export const iotApi = iot.createApi();
			`,
		});
		try {
			const types = extractMethodTypes(join(dir, 'index.ts'));
			assert.strictEqual(types.get('iotApi.maybe')?.transferable, undefined);
			assert.strictEqual(types.get('iotApi.optional')?.transferable, undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// Documented limitation, not desired behaviour: the written node names the alias,
	// which carries no type arguments of its own. Pinned so a fix cannot land silently.
	it('drops the type arg when the written return is a type alias for the generic', () => {
		const dir = createTempProject({
			'tsconfig.json': TRANSFERABLE_TSCONFIG,
			'iot.ts': `
				${IOT_MODULE_PRELUDE}
				export type DeviceLinkAlias = DeviceLink<Reading>;
				export interface IotApi { getLink(id: string): Promise<DeviceLinkAlias>; }
				export declare class Iot { createApi(): IotApi; }
			`,
			'index.ts': `
				import type { Iot } from './iot.js';
				declare const iot: Iot;
				export const iotApi = iot.createApi();
			`,
		});
		try {
			const info = extractMethodTypes(join(dir, 'index.ts')).get('iotApi.getLink');
			assert.ok(info?.transferable, 'the tag is still detected through the alias');
			assert.deepStrictEqual(info.transferable.typeArgs, []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('distinguishes a defaulted type param from an explicit one on the declared-interface path', () => {
		const dir = createTempProject({
			'tsconfig.json': TRANSFERABLE_TSCONFIG,
			'iot.ts': `
				export interface StreamDescriptor { __blocks: 'example-iot/stream'; }
				export interface Stream<T = unknown> { toJSON(): StreamDescriptor; item: T; }
				export interface IotApi {
					defaulted(): Promise<Stream>;
					explicit(): Promise<Stream<unknown>>;
				}
				export declare class Iot { createApi(): IotApi; }
			`,
			'index.ts': `
				import type { Iot } from './iot.js';
				declare const iot: Iot;
				export const iotApi = iot.createApi();
			`,
		});
		try {
			const types = extractMethodTypes(join(dir, 'index.ts'));
			assert.deepStrictEqual(types.get('iotApi.defaulted')?.transferable?.typeArgs, []);
			assert.deepStrictEqual(types.get('iotApi.explicit')?.transferable?.typeArgs, [{}]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('extractMethodTypes — open-shape intersections', () => {
	it('preserves additionalProperties from `T & Record<string, V>` intersections', () => {
		const dir = createTempProject({
			'tsconfig.json': JSON.stringify({
				compilerOptions: {
					target: 'ESNext',
					module: 'ESNext',
					moduleResolution: 'bundler',
					strict: true,
				},
			}),
			'index.ts': `
				${API_NS_MOCK}

				// Mirrors Auth's signUp payload: fixed fields plus an open
				// string-keyed bag for custom attributes.
				type SignUpInput = { username: string; password: string } & Record<string, string>;

				export const api = new ApiNamespace(null, 'api', () => ({
					async signUp(input: SignUpInput) { return { success: true }; },
				}));
			`,
		});
		try {
			const info = extractMethodTypes(join(dir, 'index.ts')).get('api.signUp');
			assert.ok(info, 'should find signUp');
			const inputSchema = info.params[0].schema as any;
			assert.strictEqual(inputSchema.type, 'object');
			assert.ok(inputSchema.properties?.username, 'fixed username property survives');
			assert.ok(inputSchema.properties?.password, 'fixed password property survives');
			assert.ok(inputSchema.additionalProperties, 'open shape preserved as additionalProperties');
			assert.strictEqual(inputSchema.additionalProperties.type, 'string');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('emits additionalProperties for object types with index signatures alongside fixed properties', () => {
		const dir = createTempProject({
			'tsconfig.json': JSON.stringify({
				compilerOptions: {
					target: 'ESNext',
					module: 'ESNext',
					moduleResolution: 'bundler',
					strict: true,
				},
			}),
			'index.ts': `
				${API_NS_MOCK}

				interface OpenShape {
					id: string;
					[key: string]: string;
				}

				export const api = new ApiNamespace(null, 'api', () => ({
					async tag(input: OpenShape) { return { success: true }; },
				}));
			`,
		});
		try {
			const info = extractMethodTypes(join(dir, 'index.ts')).get('api.tag');
			assert.ok(info, 'should find tag');
			const inputSchema = info.params[0].schema as any;
			assert.strictEqual(inputSchema.type, 'object');
			assert.ok(inputSchema.properties?.id, 'fixed id property survives');
			assert.ok(inputSchema.additionalProperties, 'index signature surfaces as additionalProperties');
			assert.strictEqual(inputSchema.additionalProperties.type, 'string');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('extractMethodTypes — namespace returned by a factory, then destructured (regression: #444)', () => {
	it('keys a destructured factory namespace qualified, with real schemas', () => {
		const dir = createTempProject({
			'tsconfig.json': JSON.stringify({
				compilerOptions: { target: 'ESNext', module: 'ESNext', moduleResolution: 'bundler', strict: true },
			}),
			'index.ts': `
				${API_NS_MOCK}
				class Scope { constructor(id: string) {} }

				class NamespaceFactory {
					constructor(private readonly scope: Scope) {}
					createNamespaces() {
						return {
							indirectNamespace: new ApiNamespace(this.scope, 'indirectNamespace', () => ({
								async getIndirectGreeting(times: number): Promise<string> { return 'hi'; },
							})),
						};
					}
				}

				const scope = new Scope('repro');
				export const directNamespace = new ApiNamespace(scope, 'directNamespace', () => ({
					async getDirectGreeting(name: string): Promise<number> { return name.length; },
				}));
				const { indirectNamespace } = new NamespaceFactory(scope).createNamespaces();
				export { indirectNamespace };
			`,
		});
		try {
			const types = extractMethodTypes(join(dir, 'index.ts'));
			// The factory-returned namespace is now attributed to its binding name,
			// exactly like the directly-constructed one.
			const indirect = types.get('indirectNamespace.getIndirectGreeting');
			assert.ok(indirect, 'indirectNamespace.getIndirectGreeting should be keyed by namespace');
			assert.strictEqual((indirect.params[0].schema as any).type, 'number');
			assert.strictEqual((indirect.returnType as any).type, 'string');

			const direct = types.get('directNamespace.getDirectGreeting');
			assert.ok(direct, 'directNamespace.getDirectGreeting should be present');
			assert.strictEqual((direct.params[0].schema as any).type, 'string');
			assert.strictEqual((direct.returnType as any).type, 'number');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('a factory namespace sharing a method name with a direct one does NOT cross-assign', () => {
		const dir = createTempProject({
			'tsconfig.json': JSON.stringify({
				compilerOptions: { target: 'ESNext', module: 'ESNext', moduleResolution: 'bundler', strict: true },
			}),
			'index.ts': `
				${API_NS_MOCK}
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
			`,
		});
		try {
			const types = extractMethodTypes(join(dir, 'index.ts'));
			// Each namespace keeps its OWN param type under a distinct qualified key.
			assert.strictEqual((types.get('widgets.create')?.params[0].schema as any)?.type, 'string');
			assert.strictEqual((types.get('subscriptions.create')?.params[0].schema as any)?.type, 'number');
			// The first-pass AST walk still emits a lingering bare `create` for the
			// factory namespace, but it never overrides a qualified key: the
			// direct namespace's qualified `widgets.create` is unaffected above, and
			// `generate-spec` prefers the qualified key (see the collision test in
			// generate-spec.test.ts, which asserts this end-to-end in the output).
			// So the bare entry can't reintroduce the #445 cross-assignment here. Assert
			// the documented lingering-bare-key behavior directly: a bare `create` key is
			// still emitted by the first-pass walk (rather than re-asserting the qualified
			// `widgets.create` type, which is unchanged from above).
			assert.strictEqual(types.has('create'), true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('attributes an array/tuple-destructured factory namespace to its binding name (#552)', () => {
		// `const [ns] = factory()` is now attributed to `ns` (was a documented boundary
		// that fell through to the bare key). The recursive binding-pattern walk resolves
		// the tuple element's type via the checker.
		const dir = createTempProject({
			'tsconfig.json': JSON.stringify({
				compilerOptions: { target: 'ESNext', module: 'ESNext', moduleResolution: 'bundler', strict: true },
			}),
			'index.ts': `
				${API_NS_MOCK}
				class Scope { constructor(id: string) {} }

				class Factory {
					constructor(private readonly scope: Scope) {}
					build() {
						return [
							new ApiNamespace(this.scope, 'tupleNs', () => ({
								async ping(count: number): Promise<string> { return 'p'; },
							})),
						] as const;
					}
				}
				const scope = new Scope('app');
				const [tupleNs] = new Factory(scope).build();
				export { tupleNs };
			`,
		});
		try {
			const types = extractMethodTypes(join(dir, 'index.ts'));
			const qualified = types.get('tupleNs.ping');
			assert.ok(qualified, 'array-destructured namespace should be keyed qualified (tupleNs.ping)');
			assert.strictEqual((qualified.params[0].schema as any)?.type, 'number');
			assert.strictEqual((qualified.returnType as any)?.type, 'string');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('attributes a nested-destructured factory namespace to its leaf binding name (#552)', () => {
		// `const { group: { nestedNs } } = factory()` recurses to the leaf `nestedNs`.
		const dir = createTempProject({
			'tsconfig.json': JSON.stringify({
				compilerOptions: { target: 'ESNext', module: 'ESNext', moduleResolution: 'bundler', strict: true },
			}),
			'index.ts': `
				${API_NS_MOCK}
				class Scope { constructor(id: string) {} }

				class Factory {
					constructor(private readonly scope: Scope) {}
					build() {
						return {
							group: {
								nestedNs: new ApiNamespace(this.scope, 'nestedNs', () => ({
									async ping(count: number): Promise<string> { return 'p'; },
								})),
							},
						};
					}
				}
				const scope = new Scope('app');
				const { group: { nestedNs } } = new Factory(scope).build();
				export { nestedNs };
			`,
		});
		try {
			const types = extractMethodTypes(join(dir, 'index.ts'));
			assert.ok(types.get('nestedNs.ping'), 'nested-destructured namespace should be keyed qualified (nestedNs.ping)');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('skips a rest binding so it adds no noise keys, still attributing the real namespace (#552)', () => {
		// `const [first, ...rest] = factory()` — `rest` is an array whose members carry
		// call signatures (push/map/…); the walk must skip it (it's never a namespace)
		// rather than emit `rest.push`-style keys.
		const dir = createTempProject({
			'tsconfig.json': JSON.stringify({
				compilerOptions: { target: 'ESNext', module: 'ESNext', moduleResolution: 'bundler', strict: true },
			}),
			'index.ts': `
				${API_NS_MOCK}
				class Scope { constructor(id: string) {} }

				class Factory {
					constructor(private readonly scope: Scope) {}
					build() {
						return [
							new ApiNamespace(this.scope, 'first', () => ({
								async ping(count: number): Promise<string> { return 'p'; },
							})),
							new ApiNamespace(this.scope, 'second', () => ({
								async ping(count: number): Promise<string> { return 'p'; },
							})),
						] as const;
					}
				}
				const scope = new Scope('app');
				const [first, ...rest] = new Factory(scope).build();
				export { first, rest };
			`,
		});
		try {
			const types = extractMethodTypes(join(dir, 'index.ts'));
			assert.ok(types.get('first.ping'), 'the named element is still attributed');
			// No array-member noise from the rest binding.
			assert.ok(!types.has('rest.push'), 'rest binding must not emit array-member keys');
			assert.ok(![...types.keys()].some(k => k.startsWith('rest.')), 'no rest.* keys at all');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('attributes a renamed object binding to the LOCAL name (#552 — locks the rename path)', () => {
		// `const { widgets: w } = factory()` binds `w` reading property `widgets`. The
		// recursive leaf resolution resolves `w`'s destructured type via the checker, so
		// the namespace keys under the local name `w` — locking the rename semantics the
		// deleted explicit `element.propertyName` code used to handle.
		const dir = createTempProject({
			'tsconfig.json': JSON.stringify({
				compilerOptions: { target: 'ESNext', module: 'ESNext', moduleResolution: 'bundler', strict: true },
			}),
			'index.ts': `
				${API_NS_MOCK}
				class Scope { constructor(id: string) {} }

				class Factory {
					constructor(private readonly scope: Scope) {}
					build() {
						return {
							widgets: new ApiNamespace(this.scope, 'widgets', () => ({
								async create(name: string): Promise<string> { return name; },
							})),
						};
					}
				}
				const scope = new Scope('app');
				const { widgets: w } = new Factory(scope).build();
				export { w };
			`,
		});
		try {
			const types = extractMethodTypes(join(dir, 'index.ts'));
			assert.ok(types.get('w.create'), 'renamed binding should key under the LOCAL name (w.create)');
			assert.ok(!types.has('widgets.create'), 'must NOT key under the property name (widgets.create)');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('attributes BOTH namespaces of a colliding-method tuple, dropping neither (#552 → the #445 class)', () => {
		// The motivating case: a factory returns a tuple of namespaces that share a
		// method name. Before #552 both `create`s landed on the bare `create` key and
		// the #445 cross-assignment could drop/mis-schema one. Now each is qualified.
		const dir = createTempProject({
			'tsconfig.json': JSON.stringify({
				compilerOptions: { target: 'ESNext', module: 'ESNext', moduleResolution: 'bundler', strict: true },
			}),
			'index.ts': `
				${API_NS_MOCK}
				class Scope { constructor(id: string) {} }

				class Factory {
					constructor(private readonly scope: Scope) {}
					build() {
						return [
							new ApiNamespace(this.scope, 'widgets', () => ({
								async create(name: string): Promise<string> { return name; },
							})),
							new ApiNamespace(this.scope, 'gadgets', () => ({
								async create(count: number): Promise<number> { return count; },
							})),
						] as const;
					}
				}
				const scope = new Scope('app');
				const [widgets, gadgets] = new Factory(scope).build();
				export { widgets, gadgets };
			`,
		});
		try {
			const types = extractMethodTypes(join(dir, 'index.ts'));
			const w = types.get('widgets.create');
			const g = types.get('gadgets.create');
			assert.ok(w, 'widgets.create should be keyed qualified');
			assert.ok(g, 'gadgets.create should be keyed qualified');
			// Each keeps its OWN param schema — the #445 cross-assignment can't happen.
			assert.strictEqual((w.params[0].schema as any)?.type, 'string', 'widgets.create takes a string');
			assert.strictEqual((g.params[0].schema as any)?.type, 'number', 'gadgets.create takes a number');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('describeOrWarn — one method whose types cannot be described', () => {
	it('warns naming the method and falls back to unknown (undefined), so the other methods keep their types', () => {
		const warned: string[] = [];
		const original = console.warn;
		console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(' '));
		try {
			assert.strictEqual(
				describeOrWarn('api.broken', () => {
					throw new RangeError('Maximum call stack size exceeded');
				}),
				undefined,
			);
			assert.deepStrictEqual(describeOrWarn('api.fine', () => 42), 42);
		} finally {
			console.warn = original;
		}
		assert.strictEqual(warned.length, 1);
		assert.match(warned[0], /Could not describe the types of api\.broken \(Maximum call stack size exceeded\)/);
	});

	it('rethrows a misused codegen tag rather than hiding it', () => {
		assert.throws(
			() =>
				describeOrWarn('api.tagged', () => {
					throw new CodegenTagError('bad tag');
				}),
			CodegenTagError,
		);
	});
});

describe('extractMethodTypes — warnings of a named type reused from the cache', () => {
	it('every schema that uses a named type with a deep cut carries its warning', () => {
		const dir = createTempProject({
			'tsconfig.json': JSON.stringify({
				compilerOptions: { target: 'ESNext', module: 'ESNext', moduleResolution: 'bundler', strict: true },
			}),
			'index.ts': `
				${API_NS_MOCK}
				interface Deep { a: { b: { c: { d: { e: { f: { g: { h: string } } } } } } } }
				export const api = new ApiNamespace(null, 'api', () => ({
					async first(): Promise<Deep> { return {} as Deep; },
					async second(): Promise<Deep> { return {} as Deep; },
				}));
			`,
		});
		try {
			const types = extractMethodTypes(join(dir, 'index.ts'));
			for (const name of ['api.first', 'api.second']) {
				const warnings = types.get(name)?.returnWarnings ?? [];
				assert.strictEqual(warnings.length, 1, `${name}: ${warnings.join('\n')}`);
				assert.match(warnings[0] ?? '', /`Deep\.a\.b\.c\.d\.e\.f\.g` nests unnamed objects/);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
