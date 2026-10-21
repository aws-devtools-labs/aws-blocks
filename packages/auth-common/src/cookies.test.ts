// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
	resolveCookieSecurity,
	buildCookieSecurityAttrs,
	isInsecurePublicOrigin,
	isLoopbackRequest,
	type CookieSecurityInput,
} from './cookies.js';

// ─── resolveCookieSecurity ───────────────────────────────────────────────────

describe('resolveCookieSecurity', () => {
	test('same-origin prod → Lax; Secure; no Partitioned', () => {
		assert.deepStrictEqual(
			resolveCookieSecurity({ crossDomain: false, isLocalhost: false }),
			{ sameSite: 'Lax', secure: true, partitioned: false },
		);
	});

	test('same-origin localhost → Lax; no Secure; no Partitioned', () => {
		assert.deepStrictEqual(
			resolveCookieSecurity({ crossDomain: false, isLocalhost: true }),
			{ sameSite: 'Lax', secure: false, partitioned: false },
		);
	});

	test('cross-domain prod → None; Secure; Partitioned', () => {
		assert.deepStrictEqual(
			resolveCookieSecurity({ crossDomain: true, isLocalhost: false }),
			{ sameSite: 'None', secure: true, partitioned: true },
		);
	});

	test('cross-domain localhost → None; Secure; no Partitioned', () => {
		assert.deepStrictEqual(
			resolveCookieSecurity({ crossDomain: true, isLocalhost: true }),
			{ sameSite: 'None', secure: true, partitioned: false },
		);
	});

	test('same-origin HTTP front door (plainHttpOrigin) → Lax; no Secure', () => {
		// A deployed TLS-less door (S3-website / ALB w/o cert) can't carry a
		// `Secure` cookie; the same-origin `Lax` cookie drops it so the session works.
		assert.deepStrictEqual(
			resolveCookieSecurity({ crossDomain: false, isLocalhost: false, plainHttpOrigin: true }),
			{ sameSite: 'Lax', secure: false, partitioned: false },
		);
	});

	test('cross-domain behind an HTTP page (frontDoor: none) → None; Secure; Partitioned, as on HTTPS', () => {
		// The cross-domain cookie is set by the API's own (HTTPS) response, not by
		// the HTTP page: the page's scheme must not drop `Partitioned`, which
		// browsers that block third-party cookies require.
		assert.deepStrictEqual(
			resolveCookieSecurity({ crossDomain: true, isLocalhost: false, plainHttpOrigin: true }),
			{ sameSite: 'None', secure: true, partitioned: true },
		);
	});

	test('an explicit HTTPS front door (plainHttpOrigin: false) keeps Secure', () => {
		assert.deepStrictEqual(
			resolveCookieSecurity({ crossDomain: false, isLocalhost: false, plainHttpOrigin: false }),
			{ sameSite: 'Lax', secure: true, partitioned: false },
		);
	});
});

// ─── isInsecurePublicOrigin ──────────────────────────────────────────────────

describe('isInsecurePublicOrigin', () => {
	const withOrigin = (value: string | undefined, run: () => void) => {
		const previous = process.env.BLOCKS_PUBLIC_ORIGIN;
		if (value === undefined) delete process.env.BLOCKS_PUBLIC_ORIGIN;
		else process.env.BLOCKS_PUBLIC_ORIGIN = value;
		try {
			run();
		} finally {
			if (previous === undefined) delete process.env.BLOCKS_PUBLIC_ORIGIN;
			else process.env.BLOCKS_PUBLIC_ORIGIN = previous;
		}
	};

	test('unset → false (assume HTTPS, keep Secure)', () => {
		withOrigin(undefined, () => assert.strictEqual(isInsecurePublicOrigin(), false));
	});

	test('an https:// front door → false', () => {
		withOrigin('https://d123.cloudfront.net', () => assert.strictEqual(isInsecurePublicOrigin(), false));
	});

	test('an http:// front door (TLS-less ALB, S3 website) → true', () => {
		withOrigin('http://blocks-hosti-abc.us-west-2.elb.amazonaws.com', () =>
			assert.strictEqual(isInsecurePublicOrigin(), true),
		);
	});
});

// ─── buildCookieSecurityAttrs ────────────────────────────────────────────────

describe('buildCookieSecurityAttrs', () => {
	test('same-origin prod', () => {
		assert.strictEqual(
			buildCookieSecurityAttrs({ crossDomain: false, isLocalhost: false }),
			'SameSite=Lax; Secure',
		);
	});

	test('same-origin localhost', () => {
		assert.strictEqual(
			buildCookieSecurityAttrs({ crossDomain: false, isLocalhost: true }),
			'SameSite=Lax',
		);
	});

	test('cross-domain prod', () => {
		assert.strictEqual(
			buildCookieSecurityAttrs({ crossDomain: true, isLocalhost: false }),
			'SameSite=None; Secure; Partitioned',
		);
	});

	test('cross-domain localhost', () => {
		assert.strictEqual(
			buildCookieSecurityAttrs({ crossDomain: true, isLocalhost: true }),
			'SameSite=None; Secure',
		);
	});
});

// ─── isLoopbackRequest ───────────────────────────────────────────────────────

describe('isLoopbackRequest', () => {
	function ctxWith(headers: Record<string, string>) {
		const h = new Headers();
		for (const [k, v] of Object.entries(headers)) h.set(k, v);
		return { request: { headers: h } } as any;
	}

	test('detects localhost origin', () => {
		assert.strictEqual(isLoopbackRequest(ctxWith({ origin: 'http://localhost:3000' })), true);
	});

	test('detects 127.0.0.1 origin', () => {
		assert.strictEqual(isLoopbackRequest(ctxWith({ origin: 'http://127.0.0.1:8080' })), true);
	});

	test('detects [::1] origin', () => {
		assert.strictEqual(isLoopbackRequest(ctxWith({ origin: 'http://[::1]:3000' })), true);
	});

	test('falls back to host header', () => {
		assert.strictEqual(isLoopbackRequest(ctxWith({ host: 'localhost:3001' })), true);
	});

	test('public origin is not loopback', () => {
		assert.strictEqual(isLoopbackRequest(ctxWith({ origin: 'https://app.example.com' })), false);
	});

	test('no origin/host header is not loopback', () => {
		assert.strictEqual(isLoopbackRequest(ctxWith({})), false);
	});
});

// ─── Cross-BB parity ─────────────────────────────────────────────────────────
// Convergence guard: the string builder (basic/cognito) and the attribute
// resolver (oidc) must agree for identical inputs, so the family can't drift.

describe('cross-BB parity', () => {
	const inputs: CookieSecurityInput[] = [
		{ crossDomain: false, isLocalhost: false },
		{ crossDomain: false, isLocalhost: true },
		{ crossDomain: true, isLocalhost: false },
		{ crossDomain: true, isLocalhost: true },
	];

	for (const input of inputs) {
		test(`stable output for ${JSON.stringify(input)}`, () => {
			const attrs = resolveCookieSecurity(input);
			const str = buildCookieSecurityAttrs(input);

			const expectedParts = [`SameSite=${attrs.sameSite}`];
			if (attrs.secure) expectedParts.push('Secure');
			if (attrs.partitioned) expectedParts.push('Partitioned');
			assert.strictEqual(str, expectedParts.join('; '));
		});
	}
});
