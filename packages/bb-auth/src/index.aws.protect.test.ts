// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS runtime — `auth.protect(...)` over the real Cognito engine, against a
 * spied Cognito client (no network). Harness: `test-support/aws-harness.ts`.
 *
 * Each call invokes the namespace the way the Lambda dispatcher does: call the
 * exported namespace with the request's context, then the named method. Every
 * refusal also asserts that the `methods` factory did not run, and that no
 * Cognito call was made for an anonymous caller.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { type BlocksContext, isBlocksError } from '@aws-blocks/core';
import { AuthErrors } from './index.aws.js';
import { Browser, makeAwsAuth, signInAs, TEST_POOL_ID } from './test-support/aws-harness.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const ROOT = { id: 'protect-app' };

/** Run `namespace.method(...args)` as the dispatcher does for one request (test plumbing). */
async function invoke(namespace: unknown, method: string, ctx: BlocksContext, args: unknown[] = []): Promise<unknown> {
	assert.strictEqual(typeof namespace, 'function', 'an ApiNamespace export is its handler');
	const methods: unknown = Reflect.apply(namespace as (ctx: BlocksContext) => unknown, undefined, [ctx]);
	assert.ok(typeof methods === 'object' && methods !== null);
	const fn: unknown = Reflect.get(methods, method);
	assert.strictEqual(typeof fn, 'function', `${method} is a method`);
	return Reflect.apply(fn as (...a: unknown[]) => unknown, methods, args);
}

function groupsReply(...names: string[]) {
	return { Groups: names.map((GroupName) => ({ GroupName, UserPoolId: TEST_POOL_ID })) };
}

describe('AWS Auth.protect', () => {
	function app() {
		const h = makeAwsAuth({ users: { groups: ['admin'] } });
		const ran: string[] = [];
		const factoryCalls = { notesApi: 0, adminApi: 0 };
		const notesApi = h.auth.protect(ROOT, 'notesApi', {
			public: () => ({
				async health() {
					ran.push('health');
					return 'ok';
				},
			}),
			methods: (_context, user) => {
				factoryCalls.notesApi++;
				return {
					async whoAmI() {
						ran.push('whoAmI');
						return { username: user.username, userSub: user.userSub };
					},
				};
			},
		});
		const adminApi = h.auth.protect(
			ROOT,
			'adminApi',
			{
				methods: (_context, user) => {
					factoryCalls.adminApi++;
					return {
						async listUsers() {
							ran.push('listUsers');
							return [user.username];
						},
					};
				},
			},
			{ role: 'admin' },
		);
		return { h, ran, factoryCalls, notesApi, adminApi };
	}

	test('an anonymous call to a protected method is refused with 401 before its body runs', async () => {
		const { h, ran, factoryCalls, notesApi } = app();
		const b = new Browser();
		await assert.rejects(
			() => b.request((ctx) => invoke(notesApi, 'whoAmI', ctx)),
			(e: Error & { status?: number }) => {
				assert.strictEqual(e.status, 401);
				assert.ok(isBlocksError(e, AuthErrors.NotAuthenticated));
				return true;
			},
		);
		assert.deepStrictEqual(ran, []);
		assert.deepStrictEqual(factoryCalls, { notesApi: 0, adminApi: 0 }, '`methods` never ran');
		assert.deepStrictEqual(h.sentNames(), [], 'no Cognito call for an anonymous caller');
	});

	test('an unknown name: 401 when anonymous, "method not found" when signed in', async () => {
		const { h, factoryCalls, notesApi } = app();
		const b = new Browser();
		await assert.rejects(
			() => b.request((ctx) => invoke(notesApi, 'nope', ctx)),
			(e: Error & { status?: number }) => e.status === 401 && isBlocksError(e, AuthErrors.NotAuthenticated),
		);
		await signInAs(h, b, 'alice');
		await assert.rejects(
			() => b.request((ctx) => invoke(notesApi, 'nope', ctx)),
			(e: Error & { status?: number }) => e.status === -32601 && /^Method not found: 'nope'/.test(e.message),
		);
		assert.strictEqual(factoryCalls.notesApi, 1);
	});

	test('a public method runs with no session', async () => {
		const { ran, factoryCalls, notesApi } = app();
		const b = new Browser();
		assert.strictEqual(await b.request((ctx) => invoke(notesApi, 'health', ctx)), 'ok');
		assert.deepStrictEqual(ran, ['health']);
		assert.strictEqual(factoryCalls.notesApi, 0);
	});

	test('a signed-in caller reaches the protected method with the session user', async () => {
		const { ran, h, factoryCalls, notesApi } = app();
		const b = new Browser();
		await signInAs(h, b, 'alice');
		const me = await b.request((ctx) => invoke(notesApi, 'whoAmI', ctx));
		assert.ok(typeof me === 'object' && me !== null);
		assert.strictEqual(Reflect.get(me, 'username'), 'alice');
		assert.match(String(Reflect.get(me, 'userSub')), /\S/);
		assert.deepStrictEqual(ran, ['whoAmI']);
		assert.strictEqual(factoryCalls.notesApi, 1, '`methods` ran once, after the guard');
	});

	test('role reads live groups: a non-member gets 403 before the body runs, a member gets through', async () => {
		const { ran, h, factoryCalls, adminApi } = app();
		const b = new Browser();
		await signInAs(h, b, 'alice');
		h.on('AdminListGroupsForUserCommand', () => groupsReply());
		await assert.rejects(
			() => b.request((ctx) => invoke(adminApi, 'listUsers', ctx)),
			(e: Error & { status?: number }) => {
				assert.strictEqual(e.status, 403);
				assert.ok(isBlocksError(e, AuthErrors.NotAuthorized));
				return true;
			},
		);
		assert.deepStrictEqual(ran, []);
		assert.strictEqual(factoryCalls.adminApi, 0, '`methods` did not run for a non-member');

		h.on('AdminListGroupsForUserCommand', () => groupsReply('admin'));
		assert.deepStrictEqual(await b.request((ctx) => invoke(adminApi, 'listUsers', ctx)), ['alice']);
		assert.deepStrictEqual(ran, ['listUsers']);
		assert.deepStrictEqual(h.sentNames(), ['AdminListGroupsForUserCommand', 'AdminListGroupsForUserCommand']);
	});
});
