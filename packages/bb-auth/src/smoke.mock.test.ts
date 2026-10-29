// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local end-to-end smoke for `Auth` (default entry, local user pool): a backend
 * module exporting `auth.createApi()` and an app namespace, served through
 * core's real request handler (`createLambdaHandler` — JSON-RPC decoding,
 * `Set-Cookie` on the response, `Cookie` on the next request), exactly the
 * path a browser drives in `npm run dev`:
 *
 * sign-up → read the code from `codeDelivery` → confirm → sign in →
 * `requireAuth` → sign out.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';
import type { BlocksContext } from '@aws-blocks/core';
import { ApiNamespace } from '@aws-blocks/core';
import { createLambdaHandler } from '@aws-blocks/core/lambda-handler';
import { Auth } from './index.mock.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

/** The backend module an app would write (`aws-blocks/index.ts`). */
function backend() {
	const codes: string[] = [];
	const scope = { id: `smoke${process.pid}` };
	const auth = new Auth(scope, 'auth', {
		codeDelivery: async (_username, code) => {
			codes.push(code);
		},
	});
	const authApi = auth.createApi();
	const api = new ApiNamespace(auth, 'api', (context: BlocksContext) => ({
		async whoAmI() {
			const user = await auth.requireAuth(context);
			return { username: user.username, userSub: user.userSub };
		},
	}));
	return { module: { authApi, api }, codes, cookieName: `auth_${auth.fullId}` };
}

/** A browser against the handler: keeps cookies, speaks JSON-RPC. */
function client(handler: ReturnType<typeof createLambdaHandler>) {
	const jar = new Map<string, string>();
	let id = 0;
	return {
		jar,
		async call(method: string, params: unknown[]): Promise<{ status: number; result?: unknown; error?: unknown }> {
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

/** The `AuthState` on the wire: its state and its action names. */
function state(r: { result?: unknown }): { state: string; actions: string[] } {
	const s = r.result;
	assert.ok(typeof s === 'object' && s !== null, JSON.stringify(r));
	const value: unknown = Reflect.get(s, 'state');
	const actions: unknown = Reflect.get(s, 'actions');
	assert.ok(typeof value === 'string' && Array.isArray(actions), JSON.stringify(r));
	return { state: value, actions: actions.map((a: unknown) => String(Reflect.get(Object(a), 'name'))) };
}

test('local e2e through createApi(): sign-up → code → confirm → sign-in → requireAuth → sign-out', async () => {
	const app = backend();
	const handler = createLambdaHandler(async () => app.module);
	const browser = client(handler);

	const initial = state(await browser.call('authApi.getAuthState', []));
	assert.strictEqual(initial.state, 'signedOut');
	assert.ok(initial.actions.includes('signUp'));

	const signedUp = state(
		await browser.call('authApi.setAuthState', [
			{ action: 'signUp', username: 'alice', password: 'Passw0rd!', email: 'alice@example.com' },
		]),
	);
	assert.strictEqual(signedUp.state, 'confirmingSignUp');
	assert.strictEqual(app.codes.length, 1, 'codeDelivery received the sign-up code');

	const confirmed = state(
		await browser.call('authApi.setAuthState', [
			{ action: 'confirmSignUp', username: 'alice', code: app.codes[0] },
		]),
	);
	// autoSignIn is on by default: the bridge cookie set at sign-up lets the user skip the password.
	assert.ok(confirmed.actions.includes('autoSignIn'), JSON.stringify(confirmed));

	const anonymous = await browser.call('api.whoAmI', []);
	assert.match(JSON.stringify(anonymous.error), /NotAuthenticatedException/, 'not signed in yet');

	const signedIn = state(
		await browser.call('authApi.setAuthState', [{ action: 'signIn', username: 'alice', password: 'Passw0rd!' }]),
	);
	assert.strictEqual(signedIn.state, 'signedIn');
	assert.ok(browser.jar.has(app.cookieName), 'the session cookie came back on the response');

	const me = await browser.call('api.whoAmI', []);
	assert.strictEqual(me.error, undefined);
	assert.deepStrictEqual(Reflect.get(Object(me.result), 'username'), 'alice');

	const out = state(await browser.call('authApi.setAuthState', [{ action: 'signOut' }]));
	assert.strictEqual(out.state, 'signedOut');
	assert.ok(!browser.jar.has(app.cookieName), 'the session cookie was cleared');
	assert.match(JSON.stringify((await browser.call('api.whoAmI', [])).error), /NotAuthenticatedException/);
});
