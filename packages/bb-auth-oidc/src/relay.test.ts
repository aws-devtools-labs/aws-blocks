// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert';
import { backendHostsFor, relayOrigin, validateRelay, type RelayOrigin } from './relay.js';

const sameOriginUrl = new URL('https://api.myapp.com/auth/authorize-params/google');

describe('relayOrigin constructor', () => {
	test('accepts custom-scheme authority-only URI', () => {
		assert.strictEqual(relayOrigin('myapp://auth'), 'myapp://auth');
	});

	test('accepts HTTPS authority-only URI', () => {
		assert.strictEqual(relayOrigin('https://oauth.myapp.com'), 'https://oauth.myapp.com');
	});

	test('rejects path components', () => {
		assert.throws(() => relayOrigin('myapp://auth/callback'), /path components are not allowed/);
	});

	test('rejects query strings', () => {
		assert.throws(() => relayOrigin('https://oauth.myapp.com?foo=bar'), /query components are not allowed/);
	});

	test('rejects userinfo', () => {
		assert.throws(() => relayOrigin('https://user:pass@oauth.myapp.com'), /userinfo/);
	});

	test('rejects bare localhost', () => {
		assert.throws(() => relayOrigin('http://localhost:5000'), /'localhost' is not allowed/);
	});

	test('rejects empty string', () => {
		assert.throws(() => relayOrigin(''), /non-empty string/);
	});
});

describe('validateRelay', () => {
	const ALLOW: readonly RelayOrigin[] = [];
	const customScheme = relayOrigin('myapp://auth');

	test('loopback http://127.0.0.1 allowed without allowlist entry', () => {
		assert.deepStrictEqual(
			validateRelay('http://127.0.0.1:5234', { allowList: ALLOW, sameOrigin: sameOriginUrl }),
			{ allowed: true },
		);
	});

	test('loopback http://[::1] allowed', () => {
		assert.deepStrictEqual(
			validateRelay('http://[::1]:7000', { allowList: ALLOW, sameOrigin: sameOriginUrl }),
			{ allowed: true },
		);
	});

	test('same-origin allowed', () => {
		assert.deepStrictEqual(
			validateRelay('https://api.myapp.com', { allowList: ALLOW, sameOrigin: sameOriginUrl }),
			{ allowed: true },
		);
	});

	test('custom scheme in allowlist allowed', () => {
		assert.deepStrictEqual(
			validateRelay('myapp://auth', { allowList: [customScheme], sameOrigin: sameOriginUrl }),
			{ allowed: true },
		);
	});

	test('custom scheme with path in allowlist allowed (path preserved through relay)', () => {
		assert.deepStrictEqual(
			validateRelay('myapp://auth/callback', { allowList: [customScheme], sameOrigin: sameOriginUrl }),
			{ allowed: true },
		);
	});

	test('loopback with path allowed', () => {
		assert.deepStrictEqual(
			validateRelay('http://127.0.0.1:9876/callback', { allowList: ALLOW, sameOrigin: sameOriginUrl }),
			{ allowed: true },
		);
	});

	test('malformed URI → malformed', () => {
		assert.deepStrictEqual(
			validateRelay('not a uri', { allowList: ALLOW, sameOrigin: sameOriginUrl }),
			{ allowed: false, reason: 'malformed' },
		);
	});

	test('relayTo with path on unknown scheme → unknown-origin (path ignored, origin checked)', () => {
		assert.deepStrictEqual(
			validateRelay('myapp://auth/callback', { allowList: ALLOW, sameOrigin: sameOriginUrl }),
			{ allowed: false, reason: 'unknown-origin' },
		);
	});

	test('plain HTTP non-loopback → plaintext-non-loopback', () => {
		assert.deepStrictEqual(
			validateRelay('http://example.com:8080', { allowList: ALLOW, sameOrigin: sameOriginUrl }),
			{ allowed: false, reason: 'plaintext-non-loopback' },
		);
	});

	test('custom scheme not in allowlist → unknown-origin', () => {
		assert.deepStrictEqual(
			validateRelay('evilapp://auth', { allowList: ALLOW, sameOrigin: sameOriginUrl }),
			{ allowed: false, reason: 'unknown-origin' },
		);
	});
});

describe('validateRelay — the backend\'s own hosts', () => {
	// What the callback re-check passes: every host the backend serves over HTTPS.
	const backendHosts = ['d111.cloudfront.net', '*.tenant.example.com', 'abc.execute-api.us-east-1.amazonaws.com'];
	const callbackUrl = new URL('https://app.example.com/aws-blocks/auth/callback');
	const check = (uri: string) => validateRelay(uri, { allowList: [], sameOrigin: callbackUrl, backendHosts });

	test('a relay to any of them, a wildcard alias\'s subdomain at any depth included, is same-origin', () => {
		for (const uri of [
			'https://d111.cloudfront.net/app',
			'https://a.tenant.example.com/app',
			'https://deep.a.tenant.example.com/',
			'https://abc.execute-api.us-east-1.amazonaws.com/prod/app',
			'https://app.example.com/app',
		]) {
			assert.deepStrictEqual(check(uri), { allowed: true }, uri);
		}
	});

	test('a wildcard alias\'s apex, a lookalike, plain HTTP and another port are not', () => {
		for (const uri of [
			'https://tenant.example.com/app',
			'https://eviltenant.example.com/app',
			'https://d111.cloudfront.net.evil.example/app',
			'https://d111.cloudfront.net:8443/app',
		]) {
			assert.deepStrictEqual(check(uri), { allowed: false, reason: 'unknown-origin' }, uri);
		}
		assert.deepStrictEqual(check('http://d111.cloudfront.net/app'), { allowed: false, reason: 'plaintext-non-loopback' });
	});
});

describe('backendHostsFor — the gateway host a callback came in on', () => {
	const GATEWAY = 'abc123.execute-api.us-east-1.amazonaws.com';
	const saved = process.env.BLOCKS_PUBLIC_HOSTS;
	beforeEach(() => {
		delete process.env.BLOCKS_PUBLIC_HOSTS;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.BLOCKS_PUBLIC_HOSTS;
		else process.env.BLOCKS_PUBLIC_HOSTS = saved;
	});
	const request = (url: string, host: string) => ({ url: new URL(url), headers: new Headers({ host }) });
	const refusedAtCallback = (relay: string, req: { url: URL; headers: Headers }) =>
		validateRelay(relay, { allowList: [], sameOrigin: req.url, backendHosts: backendHostsFor(req) }).allowed === false;

	test("a callback through a CloudFront door accepts a relay to the gateway's own host", () => {
		const req = request('https://app.example.com/aws-blocks/auth/callback', GATEWAY);
		assert.deepStrictEqual(backendHostsFor(req), [GATEWAY]);
		assert.strictEqual(refusedAtCallback(`https://${GATEWAY}/prod/app`, req), false);
	});

	test('a Host that is not an execute-api endpoint, or arrived over plain HTTP, grants nothing', () => {
		// A local dev-server callback: the client chose the Host, the request is plain HTTP.
		const local = request('http://relay.example:3000/aws-blocks/auth/callback', 'relay.example:3000');
		assert.deepStrictEqual(backendHostsFor(local), []);
		assert.strictEqual(refusedAtCallback('https://relay.example/signed-in', local), true);
		assert.deepStrictEqual(backendHostsFor(request('http://localhost:3000/aws-blocks/auth/callback', GATEWAY)), []);
		for (const host of ['relay.example', `${GATEWAY}:8443`, `evil.example/${GATEWAY}`, `${GATEWAY}.evil.example`]) {
			assert.deepStrictEqual(backendHostsFor(request('https://app.example.com/aws-blocks/auth/callback', host)), [], host);
		}
	});
});
