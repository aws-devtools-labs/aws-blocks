// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import type { BlocksContext } from '@aws-cdk-blocks/core';
import { isBlocksError } from '@aws-cdk-blocks/core';
import { AuthErrors } from './errors.js';
import {
	resolveCookieSecurity,
	buildCookieSecurityAttrs,
	isInsecurePublicOrigin,
	isLocalDevRequest,
	isLoopbackRequest,
	type CookieSecurityInput,
} from './cookies.js';

/**
 * Run `fn` as if on deployed compute: the two variables synth stamps on every
 * CDK Blocks-configured compute, which `getDeploymentType()` reads.
 */
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

/** Run `fn` with `BLOCKS_DEPLOYMENT_TYPE` set (how synth and local processes read the deployment type). */
function withDeploymentType(value: string | undefined, fn: () => void): void {
	const previous = process.env.BLOCKS_DEPLOYMENT_TYPE;
	if (value === undefined) delete process.env.BLOCKS_DEPLOYMENT_TYPE;
	else process.env.BLOCKS_DEPLOYMENT_TYPE = value;
	try {
		fn();
	} finally {
		if (previous === undefined) delete process.env.BLOCKS_DEPLOYMENT_TYPE;
		else process.env.BLOCKS_DEPLOYMENT_TYPE = previous;
	}
}

/** Run `fn` with `BLOCKS_ALLOW_PLAIN_HTTP` set (how synth and local processes read the door's opt-out). */
function withAllowPlainHttp(value: string | undefined, fn: () => void): void {
	const previous = process.env.BLOCKS_ALLOW_PLAIN_HTTP;
	if (value === undefined) delete process.env.BLOCKS_ALLOW_PLAIN_HTTP;
	else process.env.BLOCKS_ALLOW_PLAIN_HTTP = value;
	try {
		fn();
	} finally {
		if (previous === undefined) delete process.env.BLOCKS_ALLOW_PLAIN_HTTP;
		else process.env.BLOCKS_ALLOW_PLAIN_HTTP = previous;
	}
}

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

	test('same-origin HTTP front door outside a sandbox → refuses to issue the cookie (InsecureTransportException)', () => {
		const plain: CookieSecurityInput = { crossDomain: false, isLocalhost: false, plainHttpOrigin: true };
		const refused = (e: unknown): boolean => {
			assert.ok(isBlocksError(e, AuthErrors.InsecureTransport), String(e));
			assert.match(e.message, /refuses to issue a session cookie over a plain-HTTP front door outside a sandbox deploy/);
			return true;
		};
		// A production deploy (synth / a process that reads the env var)…
		withDeploymentType('production', () => {
			assert.throws(() => resolveCookieSecurity(plain), refused);
			assert.throws(() => buildCookieSecurityAttrs(plain), refused);
		});
		// …and deployed compute whose config says nothing (fails closed as production).
		withDeploymentType(undefined, () => withDeployedEnv(() => assert.throws(() => resolveCookieSecurity(plain), refused)));
	});

	test('outside a sandbox, the door\'s `allowPlainHttp` opt-out (BLOCKS_ALLOW_PLAIN_HTTP=true) → Lax; no Secure', () => {
		const plain: CookieSecurityInput = { crossDomain: false, isLocalhost: false, plainHttpOrigin: true };
		withDeploymentType('production', () =>
			withAllowPlainHttp('true', () => {
				assert.deepStrictEqual(resolveCookieSecurity(plain), { sameSite: 'Lax', secure: false, partitioned: false });
				assert.strictEqual(buildCookieSecurityAttrs(plain), 'SameSite=Lax');
				// HTTPS and cross-domain cookies are unaffected by the opt-out.
				assert.deepStrictEqual(
					resolveCookieSecurity({ crossDomain: false, isLocalhost: false, plainHttpOrigin: false }),
					{ sameSite: 'Lax', secure: true, partitioned: false },
				);
				assert.deepStrictEqual(
					resolveCookieSecurity({ crossDomain: true, isLocalhost: false, plainHttpOrigin: true }),
					{ sameSite: 'None', secure: true, partitioned: true },
				);
			}),
		);
	});

	test('outside a sandbox, a missing or malformed BLOCKS_ALLOW_PLAIN_HTTP fails closed (refuses the cookie)', () => {
		const plain: CookieSecurityInput = { crossDomain: false, isLocalhost: false, plainHttpOrigin: true };
		const refused = (e: unknown): boolean => isBlocksError(e, AuthErrors.InsecureTransport);
		for (const value of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes', ' true', 'true ']) {
			withDeploymentType('production', () =>
				withAllowPlainHttp(value, () => assert.throws(() => resolveCookieSecurity(plain), refused, JSON.stringify(value))),
			);
		}
	});

	test('on deployed compute an env var cannot opt out: only the loaded config entry counts (none loaded → refuses)', () => {
		const plain: CookieSecurityInput = { crossDomain: false, isLocalhost: false, plainHttpOrigin: true };
		const refused = (e: unknown): boolean => isBlocksError(e, AuthErrors.InsecureTransport);
		withDeploymentType('production', () =>
			withAllowPlainHttp('true', () => withDeployedEnv(() => assert.throws(() => resolveCookieSecurity(plain), refused))),
		);
	});

	test('a clearing cookie (Max-Age=0) over a plain-HTTP front door outside a sandbox → Lax; no Secure, never refused', () => {
		// A clearing cookie carries no value, so it is let through: sign-out and
		// account deletion still drop the cookie instead of answering 500.
		const clearing: CookieSecurityInput = { crossDomain: false, isLocalhost: false, plainHttpOrigin: true, clearing: true };
		withDeploymentType('production', () => {
			assert.deepStrictEqual(resolveCookieSecurity(clearing), { sameSite: 'Lax', secure: false, partitioned: false });
			assert.strictEqual(buildCookieSecurityAttrs(clearing), 'SameSite=Lax');
		});
	});

	test('same-origin HTTP front door in a sandbox → Lax; no Secure (unchanged)', () => {
		withDeploymentType('sandbox', () => {
			assert.deepStrictEqual(
				resolveCookieSecurity({ crossDomain: false, isLocalhost: false, plainHttpOrigin: true }),
				{ sameSite: 'Lax', secure: false, partitioned: false },
			);
		});
	});

	test('outside a sandbox, HTTPS, cross-domain and localhost cookies are issued as before', () => {
		withDeploymentType('production', () => {
			assert.deepStrictEqual(
				resolveCookieSecurity({ crossDomain: false, isLocalhost: false, plainHttpOrigin: false }),
				{ sameSite: 'Lax', secure: true, partitioned: false },
			);
			assert.deepStrictEqual(
				resolveCookieSecurity({ crossDomain: true, isLocalhost: false, plainHttpOrigin: true }),
				{ sameSite: 'None', secure: true, partitioned: true },
			);
			assert.deepStrictEqual(
				resolveCookieSecurity({ crossDomain: false, isLocalhost: true, plainHttpOrigin: true }),
				{ sameSite: 'Lax', secure: false, partitioned: false },
			);
		});
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

// ─── isLocalDevRequest ───────────────────────────────────────────────────────

describe('isLocalDevRequest', () => {
	function ctxWith(headers: Record<string, string>): BlocksContext {
		const h = new Headers();
		for (const [k, v] of Object.entries(headers)) h.set(k, v);
		return { request: { headers: h } } as unknown as BlocksContext;
	}

	test('local dev: a loopback request is local', () => {
		assert.strictEqual(isLocalDevRequest(ctxWith({ origin: 'http://localhost:3000' })), true);
	});

	test('local dev: a public origin is not local', () => {
		assert.strictEqual(isLocalDevRequest(ctxWith({ origin: 'https://app.example.com' })), false);
	});

	test('deployed: a request claiming a loopback Origin or Host is not local', () => {
		withDeployedEnv(() => {
			const forged: Record<string, string>[] = [
				{ origin: 'http://localhost:3000' },
				{ origin: 'http://127.0.0.1:8080' },
				{ origin: 'http://[::1]:3000' },
				{ host: 'localhost:3001' },
			];
			for (const headers of forged) {
				assert.strictEqual(isLocalDevRequest(ctxWith(headers)), false, JSON.stringify(headers));
			}
		});
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
