// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `auth.admin` is a server-side API, never an RPC surface: exporting it from the
 * backend module, or returning it from a namespace handler, answers JSON-RPC
 * "method not found" (-32601) in both runtimes, while a route the application
 * writes that calls an admin method keeps working.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createLambdaHandler } from '@aws-blocks/core/lambda-handler';
import { Auth } from './index.mock.js';
import { Browser } from './test-helpers.js';
import { makeAwsAuth } from './test-support/aws-harness.js';
import type { CodeDeliveryPurpose } from './types.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const PASSWORD = 'Passw0rd!';
let counter = 0;
const root = () => ({ id: `anr${process.pid}x${++counter}` });

const rpc = (method: string, params: unknown[]) => ({
	httpMethod: 'POST',
	path: '/aws-blocks/api',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
	isBase64Encoded: false,
});
const body = (res: unknown) => JSON.parse((res as { body: string }).body);
const methodNotFound = (res: unknown) => body(res).error?.code === -32601;

/** A mock pool with one confirmed user, `username`, whose password is PASSWORD. */
async function mockAuthWithUser(username: string) {
	const codes: string[] = [];
	const auth = new Auth(root(), 'auth', {
		admin: {},
		users: { groups: ['admins'] },
		codeDelivery: async (_u: string, code: string, _p: CodeDeliveryPurpose) => {
			codes.push(code);
		},
	});
	await auth.signUp(username, PASSWORD, { attributes: { email: `${username}@example.com` } });
	const code = codes.at(-1);
	assert.ok(code, 'a sign-up code was delivered');
	await auth.confirmSignUp(username, code);
	return auth;
}

describe('auth.admin is never served over RPC (mock runtime)', () => {
	test('exporting auth.admin directly does not expose its methods', async () => {
		const auth = await mockAuthWithUser('alice');
		const handler = createLambdaHandler(async () => ({ adminApi: auth.admin }));

		const set = await handler(rpc('adminApi.setUserPassword', ['alice', 'Other-Passw0rd!1', { permanent: true }]));
		const grant = await handler(rpc('adminApi.addUserToGroup', ['alice', 'admins']));
		assert.ok(methodNotFound(set), JSON.stringify(body(set)));
		assert.ok(methodNotFound(grant), JSON.stringify(body(grant)));
		assert.deepStrictEqual(await auth.admin.listGroupsForUser('alice'), []);
		await new Browser().request((ctx) => auth.signIn('alice', PASSWORD, ctx)); // password unchanged
	});

	test('a namespace handler that returns auth.admin does not expose its methods', async () => {
		const auth = await mockAuthWithUser('bob');
		const handler = createLambdaHandler(async () => ({ api: () => auth.admin }));

		const res = await handler(rpc('api.deleteUser', ['bob']));
		assert.ok(methodNotFound(res), JSON.stringify(body(res)));
		assert.notStrictEqual(await auth.admin.getUser('bob'), null);
	});

	test('an application route that calls auth.admin still works', async () => {
		const auth = await mockAuthWithUser('carol');
		const handler = createLambdaHandler(async () => ({
			api: () => ({
				async exists(u: string) {
					return (await auth.admin.getUser(u)) !== null;
				},
			}),
		}));

		assert.strictEqual(body(await handler(rpc('api.exists', ['carol']))).result, true);
	});
});

describe('auth.admin is never served over RPC (AWS runtime)', () => {
	test('exporting auth.admin directly is method-not-found, before any Cognito call', async () => {
		const h = makeAwsAuth({ admin: {} });
		h.on('AdminSetUserPasswordCommand', () => ({}));
		const handler = createLambdaHandler(async () => ({ adminApi: h.auth.admin }));

		const res = await handler(rpc('adminApi.setUserPassword', ['alice', 'Other-Passw0rd!1', { permanent: true }]));
		assert.ok(methodNotFound(res), JSON.stringify(body(res)));
		assert.deepStrictEqual(h.sent, []);
	});

	test('admin.updateUserAttributes is server-only too: method-not-found, no Cognito call', async () => {
		const h = makeAwsAuth({ admin: {} });
		h.on('AdminUpdateUserAttributesCommand', () => ({}));
		const handler = createLambdaHandler(async () => ({ adminApi: h.auth.admin }));

		const res = await handler(rpc('adminApi.updateUserAttributes', ['alice', { name: 'X' }]));
		assert.ok(methodNotFound(res), JSON.stringify(body(res)));
		assert.deepStrictEqual(h.sent, []);
	});
});
