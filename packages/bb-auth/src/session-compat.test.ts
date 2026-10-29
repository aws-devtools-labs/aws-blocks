// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The upgrade safety property for sessions: an app that switches
 * `AuthCognito` → `Auth` with the same id keeps its users signed in.
 *
 * Proven three ways. `bb-auth-cognito` was deleted at the cutover (F1b); the
 * first two were captured from the real package just before, and are restored
 * from `__fixtures__/legacy-mock-state.json` with `Date` pinned to the moment of
 * capture (see `test-support/legacy-fixtures.ts`):
 *
 * 1. **End to end with the real `AuthCognito` mock.** The shipped
 *    `@aws-blocks/bb-auth-cognito` signed a user up and in and handed the browser
 *    its cookie; then `Auth` (the real default entry, same id) is constructed —
 *    as on the first request after the upgrade — and the same cookie is signed
 *    in as the same user. Exercises the cookie name, the HMAC scheme, the mock
 *    secret's location, the `sessions` table location and the row shape.
 * 2. **AWS row format with the real `SessionStore`.** A row written by
 *    `bb-auth-cognito`'s own `SessionStore` (Cognito-shaped tokens, TTL), with
 *    the `session-secret` value supplied as on AWS, is signed in by `AuthBase`.
 * 3. **Captured fixtures** (`__fixtures__/authcognito-*.json`): the exact cookie
 *    bytes and `Set-Cookie` line `AuthCognito` produces, and a row exactly as
 *    its `SessionStore` stores it.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { KVStore } from '@aws-blocks/bb-kv-store';
import type { ScopeParent } from '@aws-blocks/core';
import { Scope } from '@aws-blocks/core';
import { setSessionCookie, signSessionId } from './cookies.js';
import { Auth } from './index.mock.js';
import { SessionStore } from './sessions.js';
import { Browser, makeAuth, makeContext, poolTokens, setCookieFor } from './test-helpers.js';
import { mockStateCapture, restoreMockFiles } from './test-support/legacy-fixtures.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', '__fixtures__');
const cookieFixture: {
	fullId: string;
	secret: string;
	sessionId: string;
	signedCookieValue: string;
	setCookieLine: string;
} = JSON.parse(readFileSync(join(fixtures, 'authcognito-session-cookie.json'), 'utf8'));
const rowFixture: { sessionId: string; entry: { value: string } } = JSON.parse(
	readFileSync(join(fixtures, 'authcognito-session-row.json'), 'utf8'),
);

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

describe('AuthCognito → Auth: signed-in users stay signed in', () => {
	test('end to end: a session issued by the real AuthCognito mock is signed in by Auth (same id)', async (t) => {
		// Frozen at the cutover: `new AuthCognito({ id: 'upgrade-app' }, 'auth', { groups: ['admins'] })`
		// after alice signed up, was confirmed and signed in — its files and the browser's cookie.
		const legacy = mockStateCapture('cognito-groups-session');
		restoreMockFiles(legacy);
		t.mock.timers.enable({ apis: ['Date'], now: legacy.capturedAt });
		const root: ScopeParent = { id: legacy.rootId };
		const browser = new Browser();
		for (const [name, value] of Object.entries(legacy.cookies)) browser.jar.set(name, value);
		const legacyUser = legacy.results.user;
		assert.ok(legacyUser && typeof legacyUser === 'object' && 'userSub' in legacyUser);
		assert.ok(browser.jar.has('auth_upgrade-app-auth'), 'AuthCognito set auth_<fullId>');

		// The upgrade: same app, same id, `Auth` instead of `AuthCognito`.
		const auth = new Auth(root, 'auth', { users: { groups: ['admins'] } });
		const user = await browser.request((ctx) => auth.requireAuth(ctx));
		assert.strictEqual(user.userId, 'alice');
		assert.strictEqual(user.username, 'alice');
		assert.strictEqual(user.userSub, legacyUser.userSub);
		assert.strictEqual(user.signInProvider, 'password');
		assert.strictEqual(user.attributes.email, 'alice@example.com');
		assert.deepStrictEqual(browser.lastSetCookies, [], 'a valid legacy session is served as-is');
		assert.strictEqual(await browser.request((ctx) => auth.checkAuth(ctx)), true);
	});

	test('AWS row format: a row written by bb-auth-cognito’s SessionStore + the session-secret is signed in', async (t) => {
		const secret = crypto.randomBytes(32).toString('hex');
		// Frozen at the cutover: the row `bb-auth-cognito`'s `SessionStore` (400-day TTL) wrote for
		// poolTokens('bob', { sub: 'uuid-bob', groups: ['admins', 'stale'], attributes: { email } }).
		const legacy = mockStateCapture('cognito-sessionstore-row');
		restoreMockFiles(legacy);
		t.mock.timers.enable({ apis: ['Date'], now: legacy.capturedAt });
		const { sessionId } = legacy.results;
		assert.ok(typeof sessionId === 'string');
		const cookie = `auth_aws-app-auth=${signSessionId(sessionId, secret)}`;

		const { auth } = makeAuth({ users: { groups: ['admins'] } }, { rootId: 'aws-app', secret });
		const ctx = makeContext(cookie);
		const user = await auth.requireAuth(ctx);
		assert.deepStrictEqual(
			{ userId: user.userId, userSub: user.userSub, groups: user.groups, email: user.attributes.email },
			{ userId: 'bob', userSub: 'uuid-bob', groups: ['admins'], email: 'bob@example.com' },
		);
		assert.deepStrictEqual(ctx.response.headers.getSetCookie(), []);
	});

	test('fixture: Auth signs and formats the session cookie byte-for-byte like AuthCognito', () => {
		assert.strictEqual(
			signSessionId(cookieFixture.sessionId, cookieFixture.secret),
			cookieFixture.signedCookieValue,
		);
		const ctx = makeContext(undefined, 'app.example.com');
		setSessionCookie(ctx, cookieFixture.fullId, cookieFixture.signedCookieValue, 34_560_000);
		assert.deepStrictEqual(ctx.response.headers.getSetCookie(), [cookieFixture.setCookieLine]);
	});

	test('fixture: a captured AuthCognito row + cookie is signed in, with its claims decoded the same way', async () => {
		const root: ScopeParent = { id: 'fixture-app' };
		// Store the captured row bytes under the captured key, in the table `Auth`
		// reads (`<fullId>-sessions`), as `AuthCognito` did.
		const legacyScope = new Scope('auth', { parent: root });
		const table = new KVStore<unknown>(legacyScope, 'sessions');
		await table.put(rowFixture.sessionId, JSON.parse(rowFixture.entry.value), { ttlSeconds: 400 * 86400 });

		const { auth } = makeAuth(
			{ users: { groups: ['admins'] } },
			{ rootId: 'fixture-app', secret: cookieFixture.secret },
		);
		const ctx = makeContext(`auth_fixture-app-auth=${signSessionId(rowFixture.sessionId, cookieFixture.secret)}`);
		const user = await auth.requireAuth(ctx);
		assert.deepStrictEqual(user, {
			userId: 'alice',
			username: 'alice',
			userSub: '8c1d5e2a-0f3b-4a6c-9d7e-1b2c3d4e5f60',
			groups: ['admins'],
			attributes: { email: 'alice@example.com', 'custom:department': 'eng' },
			signInProvider: 'password',
		});
		// `auth_time` from the ID token drives freshness: this fixture signed in long ago.
		await assert.rejects(auth.requireAuth(makeContext(ctx.request.headers.get('cookie') ?? ''), { fresh: true }), {
			name: 'ReauthenticationRequiredException',
			status: 401,
		});
	});

	test('rows Auth writes for pool sessions keep AuthCognito’s exact shape and TTL (rollback-safe)', async () => {
		const h = makeAuth(undefined, { rootId: 'shape-app' });
		h.native.addUser('carol');
		const browser = new Browser();
		await browser.request((ctx) => h.auth.signIn('carol', 'Passw0rd!', ctx));
		const raw = JSON.parse(readFileSync('.bb-data/shape-app-auth-sessions/store.json', 'utf8'));
		const [entry] = Object.values(raw) as { value: string; ttl: number }[];
		assert.deepStrictEqual(Object.keys(JSON.parse(entry.value)).sort(), ['accessToken', 'idToken', 'refreshToken']);
		const expected = Math.floor(Date.now() / 1000) + 400 * 86400;
		assert.ok(Math.abs(entry.ttl - expected) <= 5, 'TTL = now + 400 days, as AuthCognito');

		// …and bb-auth-cognito's own store reads it back: its `lookupSession` was a plain
		// `KVStore` read of `<fullId>-sessions` (checked against the live package at the freeze).
		const legacy = new KVStore<unknown>(new Scope('auth', { parent: { id: 'shape-app' } }), 'sessions');
		const [sessionId] = Object.keys(raw);
		assert.ok(await legacy.get(sessionId));
	});

	test('the mock layer reads AuthCognito’s mock secret from .bb-data/<fullId>/state.json', async () => {
		// Frozen at the cutover: the state file `new AuthCognito({ id: 'secret-app' }, 'auth')` wrote.
		restoreMockFiles(mockStateCapture('cognito-secret-only'));
		const state = JSON.parse(readFileSync('.bb-data/secret-app-auth/state.json', 'utf8'));
		const store = new SessionStore(new Auth({ id: 'secret-app' }, 'auth'));
		const sessionId = await store.create(poolTokens('dave'));
		const browser = new Browser();
		browser.jar.set('auth_secret-app-auth', signSessionId(sessionId, state.sessionSecret));
		const auth = new Auth({ id: 'secret-app' }, 'auth');
		const user = await browser.request((ctx) => auth.getCurrentUser(ctx));
		assert.strictEqual(user?.username, 'dave');
		assert.strictEqual(setCookieFor(browser.lastSetCookies, 'auth_secret-app-auth'), undefined);
	});
});
