// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Cookie signing, the anchored reader, multi-cookie responses and the auto-sign-in bridge. */

import assert from 'node:assert';
import { describe, test } from 'node:test';
import {
	clearAutoSignInCookie,
	clearSessionCookie,
	decryptAutoSignInPayload,
	encryptAutoSignInPayload,
	readAutoSignInCookie,
	readSessionCookie,
	sessionCookieName,
	setAutoSignInCookie,
	setSessionCookie,
	signSessionId,
	verifySessionId,
} from './cookies.js';
import { makeContext } from './test-helpers.js';

describe('session id signing', () => {
	test('round-trips, and rejects tampering, other secrets and foreign formats', () => {
		const signed = signSessionId('abc123', 'k1');
		assert.strictEqual(verifySessionId(signed, 'k1'), 'abc123');
		assert.strictEqual(verifySessionId(signed, 'k2'), null);
		assert.strictEqual(verifySessionId(`x${signed}`, 'k1'), null);
		assert.strictEqual(verifySessionId(`${signed}x`, 'k1'), null);
		assert.strictEqual(verifySessionId('abc123', 'k1'), null, 'no signature');
		assert.strictEqual(verifySessionId('.sig', 'k1'), null, 'empty id');
		// An AuthBasic HS256 JWT: three dot-separated parts that are not our HMAC.
		assert.strictEqual(verifySessionId('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.c2ln', 'k1'), null);
	});
});

describe('readSessionCookie (anchored, escaped)', () => {
	const name = sessionCookieName('app-auth');
	test('reads the exact cookie only', () => {
		assert.strictEqual(name, 'auth_app-auth');
		assert.strictEqual(readSessionCookie(makeContext(`${name}=v1`), 'app-auth'), 'v1');
		assert.strictEqual(readSessionCookie(makeContext(`a=1; ${name}=v1; b=2`), 'app-auth'), 'v1');
		assert.strictEqual(readSessionCookie(makeContext(`a=1;${name}=v1`), 'app-auth'), 'v1');
		for (const sibling of [`my_${name}=v`, `x${name}=v`, `${name}x=v`, `${name}_old=v`]) {
			assert.strictEqual(readSessionCookie(makeContext(sibling), 'app-auth'), null, sibling);
		}
		assert.strictEqual(readSessionCookie(makeContext(`${name}=`), 'app-auth'), null, 'empty value');
		assert.strictEqual(readSessionCookie(makeContext(), 'app-auth'), null);
	});

	test('regex metacharacters in fullId are literal', () => {
		assert.strictEqual(readSessionCookie(makeContext('auth_myXapp=v'), 'my.app'), null);
		assert.strictEqual(readSessionCookie(makeContext('auth_my.app=v'), 'my.app'), 'v');
		assert.strictEqual(readSessionCookie(makeContext('auth_a+b=v'), 'a+b'), 'v');
	});
});

describe('Set-Cookie writing', () => {
	test('session set/clear keep other cookies on the same response, newest line per name wins', () => {
		const ctx = makeContext(undefined, 'app.example.com');
		clearAutoSignInCookie(ctx, 'app-auth');
		setSessionCookie(ctx, 'app-auth', 'sid.sig', 100);
		setSessionCookie(ctx, 'app-auth', 'sid2.sig', 100);
		const lines = ctx.response.headers.getSetCookie();
		assert.strictEqual(lines.length, 2);
		assert.ok(lines.some((l) => l.startsWith('autosignin_app-auth=;') && l.includes('Max-Age=0')));
		assert.ok(
			lines.some((l) => l === 'auth_app-auth=sid2.sig; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=100'),
		);
	});

	test('clear is a Max-Age=0 clearing cookie (forwarded on error responses, A1c)', () => {
		const ctx = makeContext();
		clearSessionCookie(ctx, 'app-auth');
		assert.deepStrictEqual(ctx.response.headers.getSetCookie(), [
			'auth_app-auth=; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=0',
		]);
	});

	test('loopback drops Secure; crossDomain uses SameSite=None; Secure; Partitioned', () => {
		const local = makeContext(undefined, 'localhost:3000');
		setSessionCookie(local, 'a', 'v.s', 1);
		assert.strictEqual(
			local.response.headers.getSetCookie()[0],
			'auth_a=v.s; HttpOnly; SameSite=Lax; Path=/; Max-Age=1',
		);
		const cross = makeContext(undefined, 'api.example.com');
		setSessionCookie(cross, 'a', 'v.s', 1, true);
		assert.match(cross.response.headers.getSetCookie()[0] ?? '', /SameSite=None; Secure; Partitioned/);
	});
});

describe('auto-sign-in bridge', () => {
	test('round-trips; tamper, wrong secret and expiry → null', () => {
		const payload = { username: 'u', password: 'p', cognitoSession: 's', exp: Date.now() + 60_000 };
		const c = encryptAutoSignInPayload(payload, 'k');
		assert.deepStrictEqual(decryptAutoSignInPayload(c, 'k'), payload);
		assert.strictEqual(decryptAutoSignInPayload(c, 'other'), null);
		assert.strictEqual(decryptAutoSignInPayload(`${c.slice(0, -2)}xx`, 'k'), null);
		assert.strictEqual(decryptAutoSignInPayload('a.b.c', 'k'), null);
		assert.strictEqual(decryptAutoSignInPayload(encryptAutoSignInPayload({ ...payload, exp: 1 }, 'k'), 'k'), null);
	});

	test('set / read / clear', () => {
		const ctx = makeContext('autosignin_app-auth=enc');
		assert.strictEqual(readAutoSignInCookie(ctx, 'app-auth'), 'enc');
		setAutoSignInCookie(ctx, 'app-auth', 'enc2', 900);
		clearAutoSignInCookie(ctx, 'app-auth');
		assert.deepStrictEqual(ctx.response.headers.getSetCookie(), [
			'autosignin_app-auth=; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=0',
		]);
	});
});
