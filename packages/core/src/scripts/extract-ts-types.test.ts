// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for extract-ts-types.ts — verifies that `new ApiNamespace(...)`
 * calls and indirect calls (e.g., auth.createApi()) produce proper type info.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { extractMethodTypes, extractSkipCodegenMethods } from './extract-ts-types.js';
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

				export class AuthBasic {
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
				import { AuthBasic } from './auth.js';

				${API_NS_MOCK}

				const auth = new AuthBasic();

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

	// Documented limitation, not desired behaviour: the written node names the alias,
	// which carries no type arguments of its own. Pinned so a fix cannot land silently.
	it('reads through the Awaited wrapper the AsyncAPI mapped type writes', () => {
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
			assert.deepStrictEqual(types.get('iotApi.defaulted')?.transferable?.typeArgs, []);
			const explicit = types.get('iotApi.explicit')?.transferable?.typeArgs;
			assert.strictEqual(explicit?.length, 1, 'an explicit arg survives both wrappers');
			assert.strictEqual(explicit?.[0]?.title, 'Reading');
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

				// Mirrors AuthCognito's signUp payload: fixed fields plus an open
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
