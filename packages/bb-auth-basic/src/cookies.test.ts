// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Session-cookie attribute tests for AuthBasic (D-007 defaults + crossDomain).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import type { BlocksContext } from '@aws-blocks/core';
import { Scope } from '@aws-blocks/core';
import { AuthBasic, type AuthBasicOptions } from './index.js';

function ctx(origin?: string): BlocksContext {
	const headers = new Headers();
	if (origin) headers.set('origin', origin);
	return {
		request: { headers },
		response: { headers: new Headers() },
	} as unknown as BlocksContext;
}

let counter = 0;
function makeAuth(options?: AuthBasicOptions): AuthBasic {
	const scope = new Scope(`basic-cookies-${++counter}-${Math.random().toString(36).slice(2, 6)}`);
	return new AuthBasic(scope, 'auth', options);
}

const USER = 'alice';
const PASS = 'password123';

describe('AuthBasic session cookie', () => {
	test('defaults to SameSite=Lax; Secure on a public origin', async () => {
		const auth = makeAuth();
		await auth.signUp(USER, PASS);
		const c = ctx('https://app.example.com');
		await auth.signIn(USER, PASS, c);
		const header = (c as any).response.headers.get('set-cookie') as string;
		assert.ok(header.startsWith('auth_'), header);
		assert.ok(header.includes('HttpOnly'), header);
		assert.ok(header.includes('SameSite=Lax'), header);
		assert.ok(header.includes('Secure'), header);
		assert.ok(!header.includes('SameSite=None'), header);
		assert.ok(!header.includes('Partitioned'), header);
	});

	test('drops Secure on plain-HTTP localhost', async () => {
		const auth = makeAuth();
		await auth.signUp(USER, PASS);
		const c = ctx('http://localhost:3000');
		await auth.signIn(USER, PASS, c);
		const header = (c as any).response.headers.get('set-cookie') as string;
		assert.ok(header.includes('SameSite=Lax'), header);
		assert.ok(!header.includes('Secure'), header);
	});

	test('crossDomain=true → SameSite=None; Secure; Partitioned (prod)', async () => {
		const auth = makeAuth({ crossDomain: true });
		await auth.signUp(USER, PASS);
		const c = ctx('https://app.example.com');
		await auth.signIn(USER, PASS, c);
		const header = (c as any).response.headers.get('set-cookie') as string;
		assert.ok(header.includes('SameSite=None'), header);
		assert.ok(header.includes('Secure'), header);
		assert.ok(header.includes('Partitioned'), header);
	});

	test('crossDomain=true on localhost → None; Secure; no Partitioned', async () => {
		const auth = makeAuth({ crossDomain: true });
		await auth.signUp(USER, PASS);
		const c = ctx('http://localhost:3000');
		await auth.signIn(USER, PASS, c);
		const header = (c as any).response.headers.get('set-cookie') as string;
		assert.ok(header.includes('SameSite=None'), header);
		assert.ok(header.includes('Secure'), header);
		assert.ok(!header.includes('Partitioned'), header);
	});

	test('behind a plain-HTTP front door (BLOCKS_PUBLIC_ORIGIN http://…): sign-in and sign-out drop Secure', async () => {
		const previous = process.env.BLOCKS_PUBLIC_ORIGIN;
		process.env.BLOCKS_PUBLIC_ORIGIN = 'http://blocks-hosti-abc.us-west-2.elb.amazonaws.com';
		try {
			const auth = makeAuth();
			await auth.signUp(USER, PASS);
			const c = ctx('http://blocks-hosti-abc.us-west-2.elb.amazonaws.com');
			await auth.signIn(USER, PASS, c);
			const header = (c as any).response.headers.get('set-cookie') as string;
			assert.ok(header.includes('SameSite=Lax'), header);
			assert.ok(!header.includes('Secure'), header);
			const out = ctx('http://blocks-hosti-abc.us-west-2.elb.amazonaws.com');
			await auth.signOut(out);
			const cleared = (out as any).response.headers.get('set-cookie') as string;
			assert.ok(cleared.includes('Max-Age=0'), cleared);
			assert.ok(!cleared.includes('Secure'), cleared);
		} finally {
			if (previous === undefined) delete process.env.BLOCKS_PUBLIC_ORIGIN;
			else process.env.BLOCKS_PUBLIC_ORIGIN = previous;
		}
	});

	test('behind an HTTPS front door (BLOCKS_PUBLIC_ORIGIN https://…): Secure stays', async () => {
		const previous = process.env.BLOCKS_PUBLIC_ORIGIN;
		process.env.BLOCKS_PUBLIC_ORIGIN = 'https://d123.cloudfront.net';
		try {
			const auth = makeAuth();
			await auth.signUp(USER, PASS);
			const c = ctx('https://d123.cloudfront.net');
			await auth.signIn(USER, PASS, c);
			const header = (c as any).response.headers.get('set-cookie') as string;
			assert.ok(header.includes('Secure'), header);
		} finally {
			if (previous === undefined) delete process.env.BLOCKS_PUBLIC_ORIGIN;
			else process.env.BLOCKS_PUBLIC_ORIGIN = previous;
		}
	});

	test('on deployed compute, a request claiming a localhost Origin cannot drop Secure', async () => {
		const keys = ['BLOCKS_CONFIG_BUCKET', 'BLOCKS_CONFIG_KEY'] as const;
		const previous = keys.map((k) => process.env[k]);
		const auth = makeAuth();
		await auth.signUp(USER, PASS);
		process.env.BLOCKS_CONFIG_BUCKET = 'config-bucket';
		process.env.BLOCKS_CONFIG_KEY = 'config.json';
		try {
			const c = ctx('http://localhost:3000');
			await auth.signIn(USER, PASS, c);
			const header = c.response.headers.get('set-cookie') ?? '';
			assert.ok(header.includes('SameSite=Lax; Secure'), header);
			const out = ctx('http://localhost:3000');
			await auth.signOut(out);
			const cleared = out.response.headers.get('set-cookie') ?? '';
			assert.ok(cleared.includes('Max-Age=0'), cleared);
			assert.ok(cleared.includes('Secure'), cleared);
		} finally {
			keys.forEach((k, i) => {
				if (previous[i] === undefined) delete process.env[k];
				else process.env[k] = previous[i];
			});
		}
	});

	test('signOut clears the cookie with matching attributes', async () => {
		const auth = makeAuth();
		const c = ctx('https://app.example.com');
		await auth.signOut(c);
		const header = (c as any).response.headers.get('set-cookie') as string;
		assert.ok(header.includes('Max-Age=0'), header);
		assert.ok(header.includes('SameSite=Lax'), header);
	});
});

/** Sign `USER` in and return the session token from the issued `Set-Cookie`. */
async function signedInToken(auth: AuthBasic): Promise<string> {
	await auth.signUp(USER, PASS);
	const c = ctx();
	await auth.signIn(USER, PASS, c);
	const token = c.response.headers.get('set-cookie')?.match(/^[^=]+=([^;]+)/)?.[1];
	assert.ok(token, 'signIn issued a session token');
	return token;
}

/** A request context whose `Cookie` header is exactly `cookieHeader`. */
function ctxWithCookies(cookieHeader: string): BlocksContext {
	const headers = new Headers();
	headers.set('cookie', cookieHeader);
	return {
		request: { headers },
		response: { headers: new Headers() },
	} as unknown as BlocksContext;
}

describe('AuthBasic session cookie read', () => {
	test('reads the session cookie when it is first, middle, or last in the header', async () => {
		const auth = makeAuth();
		const token = await signedInToken(auth);
		const name = `auth_${auth.fullId}`;
		for (const header of [`${name}=${token}`, `a=1; ${name}=${token}; b=2`, `a=1;${name}=${token}`]) {
			assert.strictEqual(await auth.checkAuth(ctxWithCookies(header)), true, header);
		}
	});

	test('a sibling cookie whose name ends with the session cookie name does not match', async () => {
		const auth = makeAuth();
		const token = await signedInToken(auth);
		const name = `auth_${auth.fullId}`;
		assert.strictEqual(await auth.checkAuth(ctxWithCookies(`x${name}=${token}`)), false);
	});

	test('a sibling cookie earlier in the header does not shadow the real session cookie', async () => {
		const auth = makeAuth();
		const token = await signedInToken(auth);
		const name = `auth_${auth.fullId}`;
		assert.strictEqual(await auth.checkAuth(ctxWithCookies(`x${name}=garbage; ${name}=${token}`)), true);
	});

	test('regex metacharacters in the fullId are matched literally', async () => {
		const scope = new Scope(`my.app-${++counter}-${Math.random().toString(36).slice(2, 6)}`);
		const auth = new AuthBasic(scope, 'auth');
		const token = await signedInToken(auth);
		const lookalike = `auth_${auth.fullId.replace('.', 'X')}`;
		assert.strictEqual(await auth.checkAuth(ctxWithCookies(`${lookalike}=${token}`)), false);
	});
});
