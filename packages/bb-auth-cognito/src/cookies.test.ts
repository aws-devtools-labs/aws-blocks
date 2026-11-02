// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import type { BlocksContext } from '@aws-blocks/core';
import {
	signSessionId,
	verifySessionId,
	setSessionCookie,
	clearSessionCookie,
	readSessionCookie,
} from './cookies.js';

const SECRET = 'test-secret-do-not-use-in-prod';
const FULL_ID = 'my-app-auth';

function mockContext(cookie?: string) {
	const reqHeaders = new Headers();
	if (cookie) reqHeaders.set('cookie', cookie);
	return {
		request: { headers: reqHeaders, body: null, json: async () => ({}), text: async () => '', params: {} },
		response: { headers: new Headers(), status: 200, send: () => {} },
	};
}

// ─── signSessionId / verifySessionId ────────────────────────────────────────

describe('signSessionId + verifySessionId', () => {
	test('round trip recovers the session id', () => {
		const signed = signSessionId('abc123', SECRET);
		assert.strictEqual(verifySessionId(signed, SECRET), 'abc123');
	});

	test('rejects a tampered signature', () => {
		const signed = signSessionId('abc123', SECRET);
		const tampered = signed.slice(0, -1) + (signed.slice(-1) === 'A' ? 'B' : 'A');
		assert.strictEqual(verifySessionId(tampered, SECRET), null);
	});

	test('rejects a tampered session id', () => {
		const signed = signSessionId('abc123', SECRET);
		const tampered = 'xyz789' + signed.slice(signed.lastIndexOf('.'));
		assert.strictEqual(verifySessionId(tampered, SECRET), null);
	});

	test('rejects when the secret differs', () => {
		const signed = signSessionId('abc123', SECRET);
		assert.strictEqual(verifySessionId(signed, 'different-secret'), null);
	});

	test('rejects a value with no separator', () => {
		assert.strictEqual(verifySessionId('not-a-signed-value', SECRET), null);
	});

	test('handles base64url session ids', () => {
		const sessionId = 'aZ-._9xYZ';
		const signed = signSessionId(sessionId, SECRET);
		assert.strictEqual(verifySessionId(signed, SECRET), sessionId);
	});
});

// ─── setSessionCookie ───────────────────────────────────────────────────────

describe('setSessionCookie', () => {
	test('defaults to SameSite=Lax (same-origin)', () => {
		const ctx = mockContext();
		setSessionCookie(ctx as any, FULL_ID, 'signed.value', 3600);
		const header = ctx.response.headers.get('Set-Cookie');
		assert.ok(header);
		assert.ok(header.startsWith(`auth_${FULL_ID}=signed.value`), header);
		assert.ok(header.includes('HttpOnly'));
		assert.ok(header.includes('SameSite=Lax'), header);
		assert.ok(!header.includes('SameSite=None'), header);
		assert.ok(!header.includes('Partitioned'), header);
		assert.ok(header.includes('Path=/'));
		assert.ok(header.includes('Max-Age=3600'));
	});

	test('non-localhost request keeps Secure on the Lax default', () => {
		const ctx = mockContext();
		ctx.request.headers.set('origin', 'https://app.example.com');
		setSessionCookie(ctx as any, FULL_ID, 'signed.value', 3600);
		const header = ctx.response.headers.get('Set-Cookie');
		assert.ok(header);
		assert.ok(header.includes('SameSite=Lax'), header);
		assert.ok(header.includes('Secure'), header);
	});

	test('localhost request drops Secure on the Lax default', () => {
		const ctx = mockContext();
		ctx.request.headers.set('origin', 'http://localhost:3000');
		setSessionCookie(ctx as any, FULL_ID, 'signed.value', 3600);
		const header = ctx.response.headers.get('Set-Cookie');
		assert.ok(header);
		assert.ok(header.includes('SameSite=Lax'), header);
		assert.ok(!header.includes('Secure'), header);
	});

	test('crossDomain=true produces None; Secure; Partitioned (prod)', () => {
		const ctx = mockContext();
		ctx.request.headers.set('origin', 'https://app.example.com');
		setSessionCookie(ctx as any, FULL_ID, 'signed.value', 3600, true);
		const header = ctx.response.headers.get('Set-Cookie');
		assert.ok(header);
		assert.ok(header.includes('SameSite=None'), header);
		assert.ok(header.includes('Secure'), header);
		assert.ok(header.includes('Partitioned'), header);
	});

	test('crossDomain=true on localhost produces None; Secure (no Partitioned)', () => {
		const ctx = mockContext();
		ctx.request.headers.set('origin', 'http://localhost:3000');
		setSessionCookie(ctx as any, FULL_ID, 'signed.value', 3600, true);
		const header = ctx.response.headers.get('Set-Cookie');
		assert.ok(header);
		assert.ok(header.includes('SameSite=None'), header);
		assert.ok(header.includes('Secure'), header);
		assert.ok(!header.includes('Partitioned'), header);
	});

	test('on deployed compute, a request claiming a localhost Origin cannot drop Secure or Partitioned', () => {
		withDeployedEnv(() => {
			const lax = localhostContext();
			setSessionCookie(lax, FULL_ID, 'signed.value', 3600);
			assert.ok(lax.response.headers.get('Set-Cookie')?.includes('SameSite=Lax; Secure'));

			const cross = localhostContext();
			setSessionCookie(cross, FULL_ID, 'signed.value', 3600, true);
			assert.ok(cross.response.headers.get('Set-Cookie')?.includes('SameSite=None; Secure; Partitioned'));

			const cleared = localhostContext();
			clearSessionCookie(cleared, FULL_ID);
			assert.ok(cleared.response.headers.get('Set-Cookie')?.includes('Secure'));
		});
	});
});

/** A request context whose `Origin` claims to be the local dev server. */
function localhostContext(): BlocksContext {
	const ctx = mockContext();
	ctx.request.headers.set('origin', 'http://localhost:3000');
	return ctx as unknown as BlocksContext;
}

/** Run `fn` with the two variables synth stamps on Blocks-configured compute. */
function withDeployedEnv(fn: () => void): void {
	const keys = ['BLOCKS_CONFIG_BUCKET', 'BLOCKS_CONFIG_KEY'] as const;
	const previous = keys.map((k) => process.env[k]);
	process.env.BLOCKS_CONFIG_BUCKET = 'config-bucket';
	process.env.BLOCKS_CONFIG_KEY = 'config.json';
	try {
		fn();
	} finally {
		keys.forEach((k, i) => {
			if (previous[i] === undefined) delete process.env[k];
			else process.env[k] = previous[i];
		});
	}
}

// ─── clearSessionCookie ─────────────────────────────────────────────────────

describe('clearSessionCookie', () => {
	test('sets Max-Age=0 and empty value', () => {
		const ctx = mockContext();
		clearSessionCookie(ctx as any, FULL_ID);
		const header = ctx.response.headers.get('Set-Cookie');
		assert.ok(header);
		assert.ok(header.startsWith(`auth_${FULL_ID}=;`), header);
		assert.ok(header.includes('Max-Age=0'));
	});
});

// ─── readSessionCookie ──────────────────────────────────────────────────────

describe('readSessionCookie', () => {
	test('extracts the value when the cookie is present', () => {
		const ctx = mockContext(`auth_${FULL_ID}=signed.value; other=foo`);
		assert.strictEqual(readSessionCookie(ctx as any, FULL_ID), 'signed.value');
	});

	test('returns null when the cookie is missing', () => {
		const ctx = mockContext('other=foo');
		assert.strictEqual(readSessionCookie(ctx as any, FULL_ID), null);
	});

	test('returns null when no cookie header is present', () => {
		const ctx = mockContext();
		assert.strictEqual(readSessionCookie(ctx as any, FULL_ID), null);
	});

	test('is scoped to the fullId — other auth cookies do not leak', () => {
		const ctx = mockContext(`auth_other-scope=leak; auth_${FULL_ID}=mine`);
		assert.strictEqual(readSessionCookie(ctx as any, FULL_ID), 'mine');
	});

	test('suffix-collision: cookie whose name ends with this one does not leak', () => {
		// Without anchoring, `auth_foo=([^;]+)` would match the tail of
		// `my_auth_foo=leak` at position 3 and return `leak`. Anchored regex
		// requires either start-of-string or `; ` before the name.
		const ctx = mockContext('my_auth_foo=leak; auth_foo=real');
		assert.strictEqual(readSessionCookie(ctx as any, 'foo'), 'real');
	});

	test('metacharacter-safe: fullId with a dot matches only the literal', () => {
		// Without escaping, `.` in `my.app` would match any character —
		// `auth_myXapp=wrong` would match the regex and leak.
		const ctx = mockContext('auth_myXapp=wrong; auth_my.app=right');
		assert.strictEqual(readSessionCookie(ctx as any, 'my.app'), 'right');
	});

	test('metacharacter-safe: does NOT match a sibling cookie whose value differs by metacharacter', () => {
		// Only `auth_myXapp` present — with escaping, `fullId='my.app'` should
		// NOT match it.
		const ctx = mockContext('auth_myXapp=wrong');
		assert.strictEqual(readSessionCookie(ctx as any, 'my.app'), null);
	});
});
