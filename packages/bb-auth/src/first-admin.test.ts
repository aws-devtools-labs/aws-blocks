// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The README's first-admin recipe, run against the local pool. A user may
 * change their own email (`updateUserAttributes`), and the new address applies
 * at once, unverified — as on Cognito without verification-before-update. An
 * `onSignIn` hook that trusted `user.attributes.email` would make the attacker
 * admin; the recipe reads the pool's `email_verified` instead.
 */

import assert from 'node:assert';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ApiError } from '@aws-blocks/core';
import { AuthErrors } from './errors.js';
import { Auth } from './index.mock.js';
import { Browser } from './test-helpers.js';
import { PACKAGE_DIR } from './test-support/typecheck.js';
import type { AuthenticatedUser, CodeDeliveryPurpose } from './types.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const PASSWORD = 'Passw0rd!';
const ADMIN_EMAILS = new Set(['you@example.com']);

function makeApp() {
	const codes = new Map<string, string>();
	const deliver = async (username: string, code: string, _purpose: CodeDeliveryPurpose) => {
		codes.set(username, code);
	};
	const auth = new Auth({ id: `first-admin-${process.pid}-${Date.now()}` }, 'auth', {
		users: { groups: ['admin'] },
		admin: {},
		codeDelivery: deliver,
		// The README recipe's hook.
		onSignIn: async (user: AuthenticatedUser) => {
			if (user.signInProvider !== 'password') return;
			const record = await auth.admin.getUser(user.username);
			const email = record?.attributes.email?.toLowerCase();
			if (record?.attributes.email_verified === 'true' && email && ADMIN_EMAILS.has(email)) {
				await auth.admin.addUserToGroup(user.username, 'admin');
			}
		},
	});
	const register = async (username: string, email: string) => {
		await auth.signUp(username, PASSWORD, { attributes: { email } });
		const code = codes.get(username);
		assert.ok(code, `a sign-up code for ${username}`);
		await auth.confirmSignUp(username, code);
	};
	return { auth, register };
}

async function isAdmin(auth: ReturnType<typeof makeApp>['auth'], username: string): Promise<boolean> {
	const b = new Browser();
	await b.request((ctx) => auth.signIn(username, PASSWORD, ctx));
	try {
		await b.request((ctx) => auth.requireRole(ctx, 'admin'));
		return true;
	} catch (e) {
		assert.ok(e instanceof ApiError && e.name === AuthErrors.NotAuthorized, `403, got ${String(e)}`);
		return false;
	}
}

describe('README: the first admin', () => {
	test("an attacker who changes their email to the allowlisted one is not made admin; the verified owner is", async () => {
		const { auth, register } = makeApp();
		await register('mallory', 'mallory@example.com');
		const mallory = new Browser();
		await mallory.request((ctx) => auth.signIn('mallory', PASSWORD, ctx));
		// She cannot mark it verified herself: the app client may not write the flag.
		await assert.rejects(
			mallory.request((ctx) => auth.updateUserAttributes(ctx, { email: 'you@example.com', email_verified: 'true' })),
			(e: unknown) => e instanceof ApiError && e.name === AuthErrors.NotAuthorized,
		);
		// Applies at once, unverified.
		await mallory.request((ctx) => auth.updateUserAttributes(ctx, { email: 'you@example.com' }));
		const record = await auth.admin.getUser('mallory');
		assert.strictEqual(record?.attributes.email, 'you@example.com');
		assert.notStrictEqual(record?.attributes.email_verified, 'true');

		assert.strictEqual(await isAdmin(auth, 'mallory'), false, 'mallory: 403');

		await register('owner', 'you@example.com');
		assert.strictEqual(await isAdmin(auth, 'owner'), true, 'the verified owner is admin');
	});

	test('the README recipe has the checks this test runs', () => {
		const readme = readFileSync(join(PACKAGE_DIR, 'README.md'), 'utf8');
		const recipe = readme.slice(readme.indexOf('### The first admin'), readme.indexOf('### Social sign-in'));
		assert.match(recipe, /if \(user\.signInProvider !== 'password'\) return;/);
		assert.match(recipe, /await auth\.admin\.getUser\(user\.username\)/);
		assert.match(recipe, /record\?\.attributes\.email_verified === 'true'/);
	});
});
