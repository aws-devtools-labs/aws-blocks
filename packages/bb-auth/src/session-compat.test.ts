// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What an app that switches `AuthCognito` → `Auth` with the same id keeps, and
 * what it does not.
 *
 * **Kept:** the session cookie (name, value format, `Set-Cookie` line), the
 * HMAC secret and where the mock keeps it, the user (same `userSub`), and the
 * way a user is decoded from Cognito's tokens.
 *
 * **Not kept:** the stored sessions. The session store has a new child id
 * (`session-store`), so it has a new table on AWS and a new directory locally,
 * and nothing reads the old `sessions` store. A cookie from before the switch
 * still verifies, finds no row, and is handled as signed out: `null` / `false`
 * from the guards that return a value, 401 `NotAuthenticatedException` from
 * `requireAuth`, and a cleared cookie. Never an error. The user signs in once
 * more and is the same user (MIGRATION.md, "The session store").
 *
 * `bb-auth-cognito` was deleted at the cutover; what it left behind was
 * captured from the real package just before, and is restored from
 * `__fixtures__/legacy-mock-state.json` with `Date` pinned to the moment of
 * capture (see `test-support/legacy-fixtures.ts`):
 *
 * 1. **End to end with the real `AuthCognito` mock.** The shipped
 *    `@aws-blocks/bb-auth-cognito` signed a user up and in and handed the
 *    browser its cookie; then `Auth` (the real default entry, same id) is
 *    constructed, as on the first request after the upgrade. The old cookie is
 *    signed out and cleared, the old session file is not touched, and the same
 *    password signs the same user in again.
 * 2. **AWS row format with the real `SessionStore`.** A row written by
 *    `bb-auth-cognito`'s own `SessionStore`, with the `session-secret` value
 *    supplied as on AWS: its cookie is signed out the same way.
 * 3. **Captured fixtures** (`__fixtures__/authcognito-*.json`): the exact cookie
 *    bytes and `Set-Cookie` line `AuthCognito` produces, and the Cognito tokens
 *    of a row, which `Auth` decodes to the same user.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { KVStore } from '@aws-blocks/bb-kv-store';
import type { ScopeParent } from '@aws-blocks/core';
import { Scope } from '@aws-blocks/core';
import { setSessionCookie, signSessionId } from './cookies.js';
import { Auth } from './index.mock.js';
import { SESSION_STORE_ID } from './session-store-id.js';
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

describe('AuthCognito → Auth: the cookie and the user stay, the stored sessions do not', () => {
	test('end to end: the cookie the real AuthCognito mock issued is signed out cleanly, and a new sign-in gives the same user', async (t) => {
		// Frozen at the cutover: `new AuthCognito({ id: 'upgrade-app' }, 'auth', { groups: ['admins'] })`
		// after alice signed up, was confirmed and signed in — its files and the browser's cookie.
		const legacy = mockStateCapture('cognito-groups-session');
		restoreMockFiles(legacy);
		t.mock.timers.enable({ apis: ['Date'], now: legacy.capturedAt });
		const root: ScopeParent = { id: legacy.rootId };
		const cookieName = 'auth_upgrade-app-auth';
		const oldCookie = legacy.cookies[cookieName];
		assert.ok(oldCookie, 'AuthCognito set auth_<fullId>');
		const legacyUser = legacy.results.user;
		assert.ok(legacyUser && typeof legacyUser === 'object' && 'userSub' in legacyUser);
		const oldSessionFile = legacy.files['upgrade-app-auth-sessions/store.json'];
		assert.ok(oldSessionFile, 'AuthCognito left its session file');

		// The upgrade: same app, same id, `Auth` instead of `AuthCognito`.
		const auth = new Auth(root, 'auth', { users: { groups: ['admins'] } });
		const browser = new Browser();
		browser.jar.set(cookieName, oldCookie);

		// The cookie verifies (same name, same HMAC secret), but its row is in the
		// old store, which `Auth` does not read: signed out, and the cookie is cleared.
		assert.strictEqual(await browser.request((ctx) => auth.getCurrentUser(ctx)), null);
		assert.ok(setCookieFor(browser.lastSetCookies, cookieName)?.includes('Max-Age=0'), 'the old cookie is cleared');
		assert.strictEqual(browser.jar.get(cookieName), undefined);
		const header = `${cookieName}=${oldCookie}`;
		assert.strictEqual(await auth.checkAuth(makeContext(header)), false);
		assert.deepStrictEqual(await auth.getAuthSession(makeContext(header)), { tokens: undefined });
		await assert.rejects(auth.requireAuth(makeContext(header)), {
			name: 'NotAuthenticatedException',
			status: 401,
		});
		// The old session file is as AuthCognito left it: not read, not converted, not removed.
		assert.strictEqual(readFileSync('.bb-data/upgrade-app-auth-sessions/store.json', 'utf8'), oldSessionFile);

		// A new sign-in works. The local user is kept, so the same password signs in as the same user.
		const signIn = await browser.request((ctx) => auth.signIn('alice', 'Passw0rd!', ctx));
		assert.strictEqual(signIn.status, 'signedIn');
		const user = await browser.request((ctx) => auth.requireAuth(ctx));
		assert.strictEqual(user.userId, 'alice');
		assert.strictEqual(user.username, 'alice');
		assert.strictEqual(user.userSub, legacyUser.userSub);
		assert.strictEqual(user.signInProvider, 'password');
		assert.strictEqual(user.attributes.email, 'alice@example.com');
		// The new session is in the session store.
		assert.ok(existsSync(`.bb-data/upgrade-app-auth-${SESSION_STORE_ID}/store.json`));
	});

	test('AWS row format: a row that bb-auth-cognito’s SessionStore wrote is not read; its cookie is signed out and cleared', async (t) => {
		const secret = crypto.randomBytes(32).toString('hex');
		// Frozen at the cutover: the row `bb-auth-cognito`'s `SessionStore` (400-day TTL) wrote for
		// poolTokens('bob', { sub: 'uuid-bob', groups: ['admins', 'stale'], attributes: { email } }).
		const legacy = mockStateCapture('cognito-sessionstore-row');
		restoreMockFiles(legacy);
		t.mock.timers.enable({ apis: ['Date'], now: legacy.capturedAt });
		const { sessionId } = legacy.results;
		assert.ok(typeof sessionId === 'string');
		const cookieName = 'auth_aws-app-auth';
		const cookie = `${cookieName}=${signSessionId(sessionId, secret)}`;

		const { auth } = makeAuth({ users: { groups: ['admins'] } }, { rootId: 'aws-app', secret });
		const ctx = makeContext(cookie);
		assert.strictEqual(await auth.getCurrentUser(ctx), null);
		assert.ok(
			setCookieFor(ctx.response.headers.getSetCookie(), cookieName)?.includes('Max-Age=0'),
			'the old cookie is cleared',
		);
		assert.strictEqual(await auth.checkAuth(makeContext(cookie)), false);
		await assert.rejects(auth.requireAuth(makeContext(cookie)), {
			name: 'NotAuthenticatedException',
			status: 401,
		});
		// The row is where bb-auth-cognito wrote it, and nothing changed it.
		assert.strictEqual(
			readFileSync('.bb-data/aws-app-auth-sessions/store.json', 'utf8'),
			legacy.files['aws-app-auth-sessions/store.json'],
		);
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

	test('fixture: the Cognito tokens of a captured AuthCognito row, as a row of the session store, decode to the same user', async () => {
		const root: ScopeParent = { id: 'fixture-app' };
		// The captured tokens under the captured key, in the store `Auth` reads
		// (`<fullId>-session-store`). The record format is the same; only the store is new.
		const blockScope = new Scope('auth', { parent: root });
		const table = new KVStore<unknown>(blockScope, SESSION_STORE_ID);
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

	test('rows Auth writes for pool sessions: AuthCognito’s record fields and TTL, plus the row version', async () => {
		const h = makeAuth(undefined, { rootId: 'shape-app' });
		h.native.addUser('carol');
		const browser = new Browser();
		await browser.request((ctx) => h.auth.signIn('carol', 'Passw0rd!', ctx));
		// The mock file holds the exact DynamoDB items: `{ version, items }` (`version` there is the file format's).
		const file: { items: Record<string, unknown>[] } = JSON.parse(
			readFileSync(`.bb-data/shape-app-auth-${SESSION_STORE_ID}/store.json`, 'utf8'),
		);
		const [item] = file.items;
		// AuthCognito's three tokens, plus `Auth`'s optional sign-in time (#912), which
		// AuthCognito never read (as it never read `provider`), plus the row's `version`
		// (what a conditional write compares) and the store's own key and expiry attributes.
		assert.deepStrictEqual(Object.keys(item).sort(), [
			'_bkv_pk',
			'_bkv_ttl',
			'accessToken',
			'idToken',
			'issuedAt',
			'refreshToken',
			'version',
		]);
		assert.strictEqual(item.version, 1);
		const expected = Math.floor(Date.now() / 1000) + 400 * 86400;
		assert.ok(
			typeof item._bkv_ttl === 'number' && Math.abs(item._bkv_ttl - expected) <= 5,
			'TTL = now + 400 days, as AuthCognito',
		);

		// The row is in the session store of the block, under the session id.
		const store = new KVStore<unknown>(new Scope('auth', { parent: { id: 'shape-app' } }), SESSION_STORE_ID);
		assert.ok(await store.get(String(item._bkv_pk)));
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
