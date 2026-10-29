// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `auth.protect(...)` on the local runtime (default entry), served through
 * core's real request handler (`createLambdaHandler`: JSON-RPC decoding,
 * method resolution, `Set-Cookie` / `Cookie`) — the path a browser drives in
 * `npm run dev`.
 *
 * The point of `protect` is that nothing of `methods` runs for an anonymous
 * caller, so a spy counts every call of the `methods` factory and every method
 * body that ran.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { BlocksContext } from '@aws-blocks/core';
import { ApiNamespace } from '@aws-blocks/core';
import { createLambdaHandler } from '@aws-blocks/core/lambda-handler';
import { generateSpec } from '@aws-blocks/core/scripts';
import { Auth, AuthErrors } from './index.mock.js';
import { apiMethodNames, apiNamespaceOptionsOf } from './protect.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

let instance = 0;

/** The backend module an app would write (`aws-blocks/index.ts`). */
function backend() {
	const codes = new Map<string, string>();
	const scope = { id: `protect${process.pid}x${++instance}` };
	const auth = new Auth(scope, 'auth', {
		users: { groups: ['admin'] },
		admin: {},
		codeDelivery: async (username, code) => {
			codes.set(username, code);
		},
	});
	/** Every method body that ran, in order. */
	const ran: string[] = [];
	/** How many times each namespace's `methods` factory was called. */
	const factoryCalls = { notesApi: 0, adminApi: 0 };
	const accountApi = new ApiNamespace(scope, 'accountApi', (context: BlocksContext) => ({
		async signIn(username: string) {
			const result = await auth.signIn(username, 'Passw0rd!', context);
			return result.status;
		},
	}));
	const notesApi = auth.protect(scope, 'notesApi', {
		public: () => ({
			async health() {
				ran.push('health');
				return { ok: true };
			},
		}),
		methods: (_context, user) => {
			factoryCalls.notesApi++;
			return {
				async whoAmI() {
					ran.push('whoAmI');
					return { username: user.username, userSub: user.userSub, groups: user.groups };
				},
				async listAll() {
					ran.push('listAll');
					return ['secret note'];
				},
			};
		},
	});
	const adminApi = auth.protect(
		scope,
		'adminApi',
		{
			methods: () => {
				factoryCalls.adminApi++;
				return {
					async listUsers() {
						ran.push('listUsers');
						return Array.fromAsync(auth.admin.scan(), (u) => u.username);
					},
				};
			},
		},
		{ role: 'admin' },
	);
	// A clash, as an untyped (plain JavaScript) backend could write it.
	const clashing = {
		public: () => ({ async health() {} }),
		methods: () => ({ async health() {}, async other() {} }),
	};
	const clashApi: unknown = Reflect.apply(auth.protect, auth, [scope, 'clashApi', clashing]);
	async function createUser(username: string) {
		await auth.signUp(username, 'Passw0rd!', { attributes: { email: `${username}@example.com` } });
		const code = codes.get(username);
		assert.ok(code, 'codeDelivery received the sign-up code');
		await auth.confirmSignUp(username, code);
	}
	return {
		auth,
		ran,
		factoryCalls,
		createUser,
		module: { accountApi, notesApi, adminApi, clashApi },
	};
}

type Reply = { status: number; result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };

/** A browser against the handler: keeps cookies, speaks JSON-RPC. */
function client(handler: ReturnType<typeof createLambdaHandler>) {
	const jar = new Map<string, string>();
	let id = 0;
	return {
		async call(method: string, params: unknown[] = []): Promise<Reply> {
			const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
			const response: unknown = await handler({
				httpMethod: 'POST',
				path: '/aws-blocks/api',
				headers: {
					'Content-Type': 'application/json',
					host: 'localhost:3000',
					...(cookie ? { Cookie: cookie } : {}),
				},
				body: JSON.stringify({ jsonrpc: '2.0', method, params, id: ++id }),
				isBase64Encoded: false,
			});
			assert.ok(typeof response === 'object' && response !== null);
			const multi: unknown = Reflect.get(response, 'multiValueHeaders');
			const setCookies: unknown =
				typeof multi === 'object' && multi !== null ? Reflect.get(multi, 'Set-Cookie') : [];
			for (const line of Array.isArray(setCookies) ? setCookies : []) {
				const [pair] = String(line).split(';');
				const eq = pair.indexOf('=');
				const name = pair.slice(0, eq);
				const value = pair.slice(eq + 1);
				if (/Max-Age=0(?:;|$)/.test(String(line)) || value === '') jar.delete(name);
				else jar.set(name, value);
			}
			const body = JSON.parse(String(Reflect.get(response, 'body')));
			return { status: Number(Reflect.get(response, 'statusCode')), result: body.result, error: body.error };
		},
	};
}

/** The error's wire name (`error.data.name`). */
function errorName(reply: Reply): unknown {
	const data = reply.error?.data;
	return typeof data === 'object' && data !== null ? Reflect.get(data, 'name') : undefined;
}

function assertNotAuthenticated(reply: Reply, label: string): void {
	assert.strictEqual(reply.result, undefined, label);
	assert.strictEqual(reply.error?.code, 401, `${label}: ${JSON.stringify(reply)}`);
	assert.strictEqual(errorName(reply), AuthErrors.NotAuthenticated, label);
}

describe('Auth.protect (local runtime)', () => {
	test('an anonymous call to a protected method gets 401, and `methods` is never called', async () => {
		const app = backend();
		const browser = client(createLambdaHandler(async () => app.module));
		for (const method of ['notesApi.whoAmI', 'notesApi.listAll', 'adminApi.listUsers']) {
			assertNotAuthenticated(await browser.call(method), method);
		}
		assert.deepStrictEqual(app.factoryCalls, { notesApi: 0, adminApi: 0 }, 'no `methods` factory ran');
		assert.deepStrictEqual(app.ran, [], 'no protected method body ran');
	});

	test('a public method runs with no session, as in a plain ApiNamespace, without calling `methods`', async () => {
		const app = backend();
		const browser = client(createLambdaHandler(async () => app.module));
		const reply = await browser.call('notesApi.health');
		assert.strictEqual(reply.error, undefined, JSON.stringify(reply));
		assert.deepStrictEqual(reply.result, { ok: true });
		assert.deepStrictEqual(app.ran, ['health']);
		assert.strictEqual(app.factoryCalls.notesApi, 0);
	});

	test('a signed-in call calls `methods` exactly once, with the signed-in user', async () => {
		const app = backend();
		const browser = client(createLambdaHandler(async () => app.module));
		await app.createUser('alice');
		assert.strictEqual((await browser.call('accountApi.signIn', ['alice'])).result, 'signedIn');

		const reply = await browser.call('notesApi.whoAmI');
		assert.strictEqual(reply.error, undefined, JSON.stringify(reply));
		const me = reply.result;
		assert.ok(typeof me === 'object' && me !== null);
		assert.strictEqual(Reflect.get(me, 'username'), 'alice');
		assert.match(String(Reflect.get(me, 'userSub')), /\S/);
		assert.deepStrictEqual(Reflect.get(me, 'groups'), []);
		assert.strictEqual(app.factoryCalls.notesApi, 1, 'one call, one `methods` call');

		assert.deepStrictEqual((await browser.call('notesApi.listAll')).result, ['secret note']);
		assert.strictEqual(app.factoryCalls.notesApi, 2, 'one more call, one more `methods` call');
		assert.deepStrictEqual(app.ran, ['whoAmI', 'listAll']);
	});

	test('an unknown name: 401 when anonymous (no enumeration), "method not found" when signed in', async () => {
		const app = backend();
		const browser = client(createLambdaHandler(async () => app.module));
		assertNotAuthenticated(await browser.call('notesApi.nope'), 'anonymous, unknown name');
		assert.strictEqual(app.factoryCalls.notesApi, 0);

		await app.createUser('dave');
		await browser.call('accountApi.signIn', ['dave']);
		const unknown = await browser.call('notesApi.nope');
		assert.strictEqual(unknown.result, undefined);
		assert.strictEqual(unknown.error?.code, -32601, JSON.stringify(unknown));
		assert.match(String(unknown.error?.message), /^Method not found: 'nope'/);
		assert.strictEqual(app.factoryCalls.notesApi, 1);
	});

	test('Object.prototype names, `then`, `toJSON` and symbols never reach the guard or `methods`', async () => {
		const app = backend();
		const browser = client(createLambdaHandler(async () => app.module));
		for (const method of [
			'notesApi.toString',
			'notesApi.constructor',
			'notesApi.hasOwnProperty',
			'notesApi.then',
			'notesApi.toJSON',
		]) {
			const reply = await browser.call(method);
			assert.strictEqual(reply.error?.code, -32601, `${method}: ${JSON.stringify(reply)}`);
		}
		const methods: unknown = Reflect.apply(app.module.notesApi as unknown as (ctx: object) => unknown, undefined, [
			{},
		]);
		assert.ok(typeof methods === 'object' && methods !== null);
		assert.strictEqual(Reflect.get(methods, 'then'), undefined, 'the method map is not a thenable');
		assert.strictEqual(Reflect.get(methods, Symbol.iterator), undefined);
		assert.deepStrictEqual(app.factoryCalls, { notesApi: 0, adminApi: 0 });
	});

	test('role: 401 when anonymous, then 403 for a non-member before `methods` runs; a member gets through', async () => {
		const app = backend();
		const browser = client(createLambdaHandler(async () => app.module));
		assertNotAuthenticated(await browser.call('adminApi.listUsers'), 'anonymous');

		await app.createUser('bob');
		await browser.call('accountApi.signIn', ['bob']);
		const refused = await browser.call('adminApi.listUsers');
		assert.strictEqual(refused.error?.code, 403, JSON.stringify(refused));
		assert.strictEqual(errorName(refused), AuthErrors.NotAuthorized);
		assert.strictEqual(app.factoryCalls.adminApi, 0, '`methods` did not run for a non-member');

		await app.auth.admin.addUserToGroup('bob', 'admin');
		const allowed = await browser.call('adminApi.listUsers');
		assert.strictEqual(allowed.error, undefined, JSON.stringify(allowed));
		assert.deepStrictEqual(allowed.result, ['bob']);
		assert.strictEqual(app.factoryCalls.adminApi, 1);
	});

	test('a name in both `public` and `methods` is an error on a protected call, and in spec generation', async () => {
		const app = backend();
		const browser = client(createLambdaHandler(async () => app.module));
		await app.createUser('carol');
		await browser.call('accountApi.signIn', ['carol']);
		// Server-side messages never reach the wire: a generic 500.
		const reply = await browser.call('clashApi.other');
		assert.strictEqual(reply.error?.code, 500, JSON.stringify(reply));
		assert.strictEqual(reply.result, undefined);

		assert.ok(typeof app.module.clashApi === 'function');
		const discover: unknown = Reflect.get(app.module.clashApi, Symbol.for('blocks:ApiNamespaceDiscover'));
		assert.strictEqual(typeof discover, 'function');
		assert.throws(
			() => Reflect.apply(discover as (ctx: object) => unknown, undefined, [{}]),
			/'health' is defined in both `public` and `methods`/,
		);
	});

	test('the discovery handler lists every method, with the original functions', () => {
		const app = backend();
		const discover: unknown = Reflect.get(app.module.notesApi, Symbol.for('blocks:ApiNamespaceDiscover'));
		assert.strictEqual(typeof discover, 'function');
		const all: unknown = Reflect.apply(discover as (ctx: object) => unknown, undefined, [{}]);
		assert.ok(typeof all === 'object' && all !== null);
		assert.deepStrictEqual(Object.keys(all).sort(), ['health', 'listAll', 'whoAmI']);
		assert.match(String(Reflect.get(all, 'listAll')), /secret note/, 'not a wrapper: the spec reads its source');
		assert.deepStrictEqual(app.ran, [], 'discovery runs no method');
	});
});

describe('the OpenRPC spec of a protect() namespace', () => {
	test('describes every public and protected method, typed', async () => {
		const { mkdtempSync, writeFileSync } = await import('node:fs');
		const { dirname, join } = await import('node:path');
		const { fileURLToPath } = await import('node:url');
		// Inside the package, so `@aws-blocks/*` resolve through the workspace's node_modules.
		const dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.spec-protect-'));
		try {
			writeFileSync(
				join(dir, 'tsconfig.json'),
				JSON.stringify({
					compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true },
				}),
			);
			const source = `
import { Scope } from '@aws-blocks/core';
import { Auth } from '@aws-blocks/bb-auth';

const scope = new Scope('spec');
const auth = new Auth(scope, 'auth', { users: { groups: ['admin'] } });
export const notesApi = auth.protect(scope, 'notesApi', {
	public: () => ({
		async health(): Promise<{ ok: boolean }> { return { ok: true }; },
	}),
	methods: (_context, user) => ({
		async rename(id: string, title: string) { return { id, title, by: user.userSub }; },
	}),
});
`;
			writeFileSync(join(dir, 'index.ts'), source);
			// The same backend, in process (the source above gives the types).
			const typed = await generateSpec(join(dir, 'index.ts'), async () => {
				const scope = { id: `spec${process.pid}` };
				const auth = new Auth(scope, 'auth', { users: { groups: ['admin'] } });
				return {
					notesApi: auth.protect(scope, 'notesApi', {
						public: () => ({
							async health() {
								return { ok: true };
							},
						}),
						methods: (_context, user) => ({
							async rename(id: string, title: string) {
								return { id, title, by: user.userSub };
							},
						}),
					}),
				};
			});
			const rename = typed.methods.find((m) => m.name === 'notesApi.rename');
			assert.ok(rename, 'the protected method is in the spec');
			assert.deepStrictEqual(
				rename.params.map((p) => [p.name, p.schema]),
				[
					['id', { type: 'string' }],
					['title', { type: 'string' }],
				],
			);
			assert.deepStrictEqual(typed.methods.map((m) => m.name).sort(), ['notesApi.health', 'notesApi.rename']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('apiNamespaceOptionsOf', () => {
	test('passes every option but `role` on to the ApiNamespace, including ones added later', () => {
		const compute = { resolve: () => ({ type: 'serverless' as const }) };
		// A field `ApiNamespaceOptions` doesn't have today, as a newer core could define it.
		const later = { compute, role: 'admin', httpErrorStatus: true, somethingNew: { a: 1 } };
		const passed: unknown = Reflect.apply(apiNamespaceOptionsOf, undefined, [later]);
		assert.deepStrictEqual(passed, { compute, httpErrorStatus: true, somethingNew: { a: 1 } });
		assert.strictEqual(apiNamespaceOptionsOf(undefined), undefined);
		assert.deepStrictEqual(apiNamespaceOptionsOf({ role: 'admin' }), {});
	});

	test('the namespace gets the compute it was given (runtime entry)', () => {
		const scope = { id: `opts${process.pid}` };
		const auth = new Auth(scope, 'auth', {});
		const compute = { resolve: () => ({ type: 'serverless' as const }) };
		const api = auth.protect(scope, 'computed', { methods: () => ({ async a() {} }) }, { compute });
		assert.strictEqual(Reflect.get(api, Symbol.for('blocks:ApiNamespaceExplicitCompute')), true);
		const resolve: unknown = Reflect.get(api, Symbol.for('blocks:ApiNamespaceCompute'));
		assert.ok(typeof resolve === 'function');
		assert.deepStrictEqual(resolve(), { type: 'serverless' });
	});
});

describe('apiMethodNames', () => {
	test('own enumerable functions and class prototype methods, never Object.prototype members', () => {
		class Methods {
			async fromProto() {}
			toString() {
				return 'overridden';
			}
		}
		const methods = Object.assign(new Methods(), { own: async () => 1, data: 42 });
		assert.deepStrictEqual(apiMethodNames(methods).sort(), ['fromProto', 'own']);
		assert.deepStrictEqual(apiMethodNames({ a() {}, b: 1 }), ['a']);
	});
});
