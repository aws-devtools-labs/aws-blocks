// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { inspect } from 'node:util';
import { clearRouteRegistry, ApiError, blocksError, getRegisteredRoutes, isWireSafeError } from '@aws-blocks/core';
import { createLambdaHandler, requestBaseUrl } from '@aws-blocks/core/lambda-handler';
import type { BlocksContext } from '@aws-blocks/core';
import type { AuthActionInput, AuthState } from '@aws-blocks/auth-common';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { AuthOIDC, AuthOIDCErrors, stubIdp, google, customOidc, customOauth2, cognitoFederated } from './index.mock.js';
import {
	handleDiscovery,
	handleJwks,
	handleAuthorize,
	handleAuthorizeSubmit,
	stubIssuerUrl,
	deriveStubCodeKey,
	stubCodeEncode,
	stubCodeDecode,
} from './engines/stub-idp.js';
import { buildExchangeUrl, withCause } from './engines/oidc-client-engine.js';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { CognitoFederationEngine } from './engines/cognito-federation-engine.js';
import { SessionManager } from './engines/session-manager.js';
import type { SessionRow } from './types.js';

const ROOT = { id: 'test-app' } as any;

function freshContext(url = 'http://localhost:3000/'): BlocksContext {
	const reqHeaders = new Headers();
	const resHeaders = new Headers();
	let status = 200;
	return {
		request: {
			headers: reqHeaders,
			body: null,
			json: async () => ({}),
			text: async () => '',
			url: new URL(url),
			params: {},
		},
		response: {
			headers: resHeaders,
			get status() { return status; },
			set status(v) { status = v; },
			send: () => {},
		} as any,
	};
}

function unique(prefix = 'scope') {
	return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

// Subclass to reach the protected redirect_uri builder for unit assertions.
class CallbackProbe extends AuthOIDC {
	callbackUrlFor(ctx: BlocksContext): string {
		return this.computeCallbackUrl(ctx);
	}
}

describe('computeCallbackUrl — public origin (Phase C)', () => {
	const GATEWAY_ORIGIN = 'https://abc123.execute-api.us-east-1.amazonaws.com';
	// `ctx.request.url` as the deployed handler builds it: the route path, no stage.
	const GATEWAY = `${GATEWAY_ORIGIN}/aws-blocks/auth/real/signin/p`;

	afterEach(() => { delete process.env.BLOCKS_PUBLIC_ORIGIN; });

	test('prefers BLOCKS_PUBLIC_ORIGIN (no stage prefix) when set — full deploy', () => {
		process.env.BLOCKS_PUBLIC_ORIGIN = 'https://app.example.com';
		const auth = new CallbackProbe(ROOT, unique('cb'), { providers: [stubIdp({ name: 'p' })] });
		// Even though the request landed on the raw execute-api host with a /prod
		// stage, the redirect_uri is built from the trusted CloudFront origin so
		// the cookie-scoped public domain is used and no stage leaks in.
		const url = requestBaseUrl.run(`${GATEWAY_ORIGIN}/prod`, () => auth.callbackUrlFor(freshContext(GATEWAY)));
		assert.strictEqual(url, 'https://app.example.com/aws-blocks/auth/callback');
	});

	test('falls back to the request base URL (preserving stage) when unset — deploy reached at the gateway', () => {
		delete process.env.BLOCKS_PUBLIC_ORIGIN;
		const auth = new CallbackProbe(ROOT, unique('cb'), { providers: [stubIdp({ name: 'p' })] });
		const url = requestBaseUrl.run(`${GATEWAY_ORIGIN}/prod`, () => auth.callbackUrlFor(freshContext(GATEWAY)));
		assert.strictEqual(url, `${GATEWAY_ORIGIN}/prod/aws-blocks/auth/callback`);
	});

	test('falls back to the request origin when unset — local dev', () => {
		delete process.env.BLOCKS_PUBLIC_ORIGIN;
		const auth = new CallbackProbe(ROOT, unique('cb'), { providers: [stubIdp({ name: 'p' })] });
		assert.strictEqual(
			auth.callbackUrlFor(freshContext('http://localhost:3000/aws-blocks/auth/real/signin/p')),
			'http://localhost:3000/aws-blocks/auth/callback',
		);
	});
});

describe('cognitoFederated in the mock runtime (local dev)', () => {
	// The provider's own clientId/clientSecret are only read by the CDK layer,
	// never by the mock runtime, so a minimal AppSettingLike stub is enough.
	const fakeCred = { fullId: 'test-cred', get: async () => 'unused-locally' };

	function cognitoAuth() {
		return new AuthOIDC(ROOT, unique('cog'), {
			providers: [cognitoFederated({
				name: 'google',
				identityProvider: 'Google',
				cognitoDomain: 'myapp',
				region: 'us-east-1',
				clientId: fakeCred,
				clientSecret: fakeCred,
			})],
		});
	}

	test('construction succeeds — declaring cognitoFederated does not block `npm run dev`', () => {
		assert.doesNotThrow(() => cognitoAuth());
	});

	test('a cognito-federated sign-in fails fast with an actionable local-dev message', async () => {
		const auth = cognitoAuth();
		// Mirrors the AWS engine selection: the mock builds CognitoFederationEngine
		// (not OidcClientEngine), so this throws the clear local-dev error instead
		// of crashing on OIDC discovery against an empty issuer.
		await assert.rejects(
			() => auth.getSignInUrl(freshContext(), 'google'),
			/isn't available in local/,
		);
	});
});

describe('buildExchangeUrl — server-initiated token redirect_uri', () => {
	const CALLBACK = 'https://app.cloudfront.net/aws-blocks/auth/callback';

	test('uses the stored callback origin/path, not the inbound request host (CloudFront)', () => {
		// Behind CloudFront the callback request resolves to the execute-api host
		// with a /prod stage; the token redirect_uri must still be the public
		// callback URL that authorize used, or Google returns invalid_grant.
		const requestUrl = new URL(
			'https://z5fwto2vj6.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/auth/callback'
				+ '?code=auth-code&state=xyz&iss=https://accounts.google.com',
		);
		const exchange = buildExchangeUrl(CALLBACK, requestUrl);
		assert.strictEqual(exchange.origin, 'https://app.cloudfront.net');
		assert.strictEqual(exchange.pathname, '/aws-blocks/auth/callback');
		// IdP-returned params are carried so openid-client can read code/state/iss.
		assert.strictEqual(exchange.searchParams.get('code'), 'auth-code');
		assert.strictEqual(exchange.searchParams.get('state'), 'xyz');
		assert.strictEqual(exchange.searchParams.get('iss'), 'https://accounts.google.com');
	});

	test('is a no-op on origin when request and callback already share a host (local/sandbox)', () => {
		const requestUrl = new URL(`${CALLBACK}?code=c&state=s`);
		const exchange = buildExchangeUrl(CALLBACK, requestUrl);
		assert.strictEqual(exchange.origin, 'https://app.cloudfront.net');
		assert.strictEqual(exchange.searchParams.get('code'), 'c');
	});
});

describe('stubIssuerUrl — gateway origin (Phase B)', () => {
	const API_URL = 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/aws-blocks/api';

	afterEach(() => { delete process.env.BLOCKS_API_URL; });

	test('derives the gateway issuer from BLOCKS_API_URL when set, ignoring the loopback front-door url', () => {
		process.env.BLOCKS_API_URL = API_URL;
		// In sandbox ctx.request.url is the localhost front door (unreachable from
		// the Lambda); the issuer must resolve to the execute-api gateway instead.
		const ctx = { request: { url: new URL('http://localhost:3000/aws-blocks/auth/idp/google/authorize') } };
		assert.strictEqual(
			stubIssuerUrl('google', ctx),
			'https://abc123.execute-api.us-east-1.amazonaws.com/prod/aws-blocks/auth/idp/google',
		);
	});

	test('falls back to ctx.request.url when BLOCKS_API_URL is unset (local dev / mock)', () => {
		delete process.env.BLOCKS_API_URL;
		const ctx = { request: { url: new URL('http://localhost:3001/aws-blocks/auth/idp/google/token') } };
		assert.strictEqual(
			stubIssuerUrl('google', ctx),
			'http://localhost:3001/aws-blocks/auth/idp/google',
		);
	});
});

beforeEach(() => {
	clearRouteRegistry();
	try { rmSync('.bb-data', { recursive: true, force: true }); } catch { /* ignore */ }
});

afterEach(() => {
	try { rmSync('.bb-data', { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('AuthOIDC construction validation', () => {
	test('requires at least one provider', () => {
		assert.throws(
			() => new AuthOIDC(ROOT, unique('empty'), { providers: [] as any }),
			/at least one provider/,
		);
	});

	test('rejects duplicate provider names', () => {
		assert.throws(
			() => new AuthOIDC(ROOT, unique('dup'), {
				providers: [stubIdp({ name: 'a' }), stubIdp({ name: 'a' })],
			}),
			/duplicate provider name/,
		);
	});

	test('rejects provider missing name', () => {
		assert.throws(
			() => new AuthOIDC(ROOT, unique('noname'), {
				providers: [{ kind: 'stub', clientId: 'x', clientSecret: 'x', scopes: [] } as any],
			}),
			/provider\.name is required/,
		);
	});

	test('rejects provider missing clientId', () => {
		assert.throws(
			() => new AuthOIDC(ROOT, unique('noid'), {
				providers: [{ name: 'test', kind: 'stub', clientSecret: 'x', scopes: [] } as any],
			}),
			/missing clientId/,
		);
	});

	test('rejects provider missing clientSecret', () => {
		assert.throws(
			() => new AuthOIDC(ROOT, unique('nosecret'), {
				providers: [{ name: 'test', kind: 'stub', clientId: 'x', scopes: [] } as any],
			}),
			/missing clientSecret/,
		);
	});

	test('rejects customOidc with invalid issuerUrl', () => {
		assert.throws(
			() => new AuthOIDC(ROOT, unique('badissuer'), {
				providers: [{
					name: 'bad',
					kind: 'oidc-custom',
					issuerUrl: 'not-a-url',
					clientId: 'x',
					clientSecret: 'x',
					scopes: ['openid'],
				} as any],
			}),
			/invalid issuerUrl/,
		);
	});

	test('rejects customOauth2 with missing authUrl', () => {
		assert.throws(
			() => new AuthOIDC(ROOT, unique('noauth'), {
				providers: [{
					name: 'bad',
					kind: 'oauth2-custom',
					authUrl: '',
					tokenUrl: 'https://example.com/token',
					userInfoUrl: 'https://example.com/userinfo',
					clientId: 'x',
					clientSecret: 'x',
					scopes: ['read'],
					mapClaims: () => ({ providerSub: '1', email: null, name: null }),
				} as any],
			}),
			/invalid authUrl/,
		);
	});

	test('rejects customOauth2 with missing tokenUrl', () => {
		assert.throws(
			() => new AuthOIDC(ROOT, unique('notoken'), {
				providers: [{
					name: 'bad',
					kind: 'oauth2-custom',
					authUrl: 'https://example.com/auth',
					tokenUrl: '',
					userInfoUrl: 'https://example.com/userinfo',
					clientId: 'x',
					clientSecret: 'x',
					scopes: ['read'],
					mapClaims: () => ({ providerSub: '1', email: null, name: null }),
				} as any],
			}),
			/invalid tokenUrl/,
		);
	});

	test('rejects customOauth2 with missing userInfoUrl', () => {
		assert.throws(
			() => new AuthOIDC(ROOT, unique('noui'), {
				providers: [{
					name: 'bad',
					kind: 'oauth2-custom',
					authUrl: 'https://example.com/auth',
					tokenUrl: 'https://example.com/token',
					userInfoUrl: '',
					clientId: 'x',
					clientSecret: 'x',
					scopes: ['read'],
					mapClaims: () => ({ providerSub: '1', email: null, name: null }),
				} as any],
			}),
			/invalid userInfoUrl/,
		);
	});

	test('rejects customOauth2 without mapClaims function', () => {
		assert.throws(
			() => new AuthOIDC(ROOT, unique('nomap'), {
				providers: [{
					name: 'bad',
					kind: 'oauth2-custom',
					authUrl: 'https://example.com/auth',
					tokenUrl: 'https://example.com/token',
					userInfoUrl: 'https://example.com/userinfo',
					clientId: 'x',
					clientSecret: 'x',
					scopes: ['read'],
				} as any],
			}),
			/mapClaims/,
		);
	});

	test('rejects unknown provider kind', () => {
		assert.throws(
			() => new AuthOIDC(ROOT, unique('badkind'), {
				providers: [{
					name: 'bad',
					kind: 'unknown-kind',
					clientId: 'x',
					clientSecret: 'x',
					scopes: [],
				} as any],
			}),
			/unknown kind/,
		);
	});

	test('rejects callbackPath not under /aws-blocks/auth/', () => {
		assert.throws(
			() => new AuthOIDC(ROOT, unique('badpath'), {
				providers: [stubIdp({ name: unique('p') })],
				callbackPath: 'no-slash',
			}),
			/callbackPath.*must be a path under/,
		);
	});

	test('rejects signOutPath not under /aws-blocks/auth/', () => {
		assert.throws(
			() => new AuthOIDC(ROOT, unique('badso'), {
				providers: [stubIdp({ name: unique('p') })],
				signOutPath: 'relative',
			}),
			/signOutPath.*must be a path under/,
		);
	});

	test('rejects postSignInPath not starting with /', () => {
		assert.throws(
			() => new AuthOIDC(ROOT, unique('badpsi'), {
				providers: [stubIdp({ name: unique('p') })],
				postSignInPath: 'relative',
			}),
			/postSignInPath.*must be an absolute path/,
		);
	});

	test('accepts valid stub provider', () => {
		assert.doesNotThrow(() => {
			new AuthOIDC(ROOT, unique('ok'), {
				providers: [stubIdp({ name: unique('p') })],
			});
		});
	});

	test('accepts multiple valid providers', () => {
		assert.doesNotThrow(() => {
			new AuthOIDC(ROOT, unique('multi'), {
				providers: [
					stubIdp({ name: unique('p1') }),
					stubIdp({ name: unique('p2') }),
				],
			});
		});
	});
});

describe('stub IdP /authorize', () => {
	const HTTPS_REDIRECT = 'https://app.example.com/aws-blocks/auth/callback';
	const stubOpts = { codeKey: () => deriveStubCodeKey('test-cookie-secret', 'google') };

	function authorizeContext(provider: string, params: Record<string, string>, body?: string) {
		const url = new URL(`http://localhost:3000/aws-blocks/auth/idp/${provider}/authorize`);
		for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
		let status = 200;
		const headers = new Map<string, string>();
		let sent: unknown;
		const ctx = {
			request: { headers: new Headers(), body: null, json: async () => ({}), text: async () => body ?? '', url, params: {} },
			response: {
				headers,
				get status() { return status; },
				set status(v: number) { status = v; },
				send: (b: unknown) => { sent = b; },
			},
		} as any;
		return { ctx, get status() { return status; }, headers, get sent() { return sent; } };
	}

	const baseParams = {
		client_id: 'stub-client-id',
		redirect_uri: HTTPS_REDIRECT,
		response_type: 'code',
		code_challenge: 'abc',
		code_challenge_method: 'S256',
		state: 'xyz',
	};

	test('interactive default renders a login screen (200 HTML)', async () => {
		const provider = stubIdp({ name: 'google' });
		const cap = authorizeContext('google', baseParams);
		await handleAuthorize(provider, cap.ctx, stubOpts);
		assert.strictEqual(cap.status, 200);
		assert.strictEqual(cap.headers.get('Content-Type'), 'text/html');
		assert.match(String(cap.sent), /Blocks stub IdP: sign in/);
		assert.match(String(cap.sent), /name="sub"/);
	});

	test('login form action preserves the API Gateway stage prefix', async () => {
		// Behind a deployed gateway the request's base URL carries a stage (e.g.
		// /prod), while `ctx.request.url` is the route path. The picker POST must
		// keep the stage, or the form posts to a non-existent resource and API
		// Gateway returns Forbidden.
		const url = new URL('https://abc123.execute-api.us-east-1.amazonaws.com/aws-blocks/auth/idp/google/authorize');
		for (const [k, v] of Object.entries(baseParams)) url.searchParams.set(k, v);
		let sent: unknown;
		const ctx = {
			request: { headers: new Headers(), body: null, json: async () => ({}), text: async () => '', url, params: {} },
			response: {
				headers: new Map<string, string>(),
				status: 200,
				send: (b: unknown) => { sent = b; },
			},
		} as any;
		const provider = stubIdp({ name: 'google' });
		await requestBaseUrl.run('https://abc123.execute-api.us-east-1.amazonaws.com/prod', () =>
			handleAuthorize(provider, ctx, stubOpts),
		);
		assert.match(
			String(sent),
			/action="https:\/\/abc123\.execute-api\.us-east-1\.amazonaws\.com\/prod\/aws-blocks\/auth\/idp\/google\/authorize"/,
		);
	});

	test('onAuthorize returning a user auto-approves (302 to callback)', async () => {
		const provider = stubIdp({ name: 'google', onAuthorize: (req) => req.users[0] });
		const cap = authorizeContext('google', baseParams);
		await handleAuthorize(provider, cap.ctx, stubOpts);
		assert.strictEqual(cap.status, 302);
		const location = cap.headers.get('Location')!;
		assert.match(location, /^https:\/\/app\.example\.com\/aws-blocks\/auth\/callback\?code=/);
		assert.match(location, /state=xyz/);
	});

	test('onAuthorize throwing denies (302 with error)', async () => {
		const provider = stubIdp({ name: 'google', onAuthorize: () => { throw new Error('nope'); } });
		const cap = authorizeContext('google', baseParams);
		await handleAuthorize(provider, cap.ctx, stubOpts);
		assert.strictEqual(cap.status, 302);
		assert.match(cap.headers.get('Location')!, /error=access_denied/);
	});

	test('onAuthorize can pick by loginHint', async () => {
		const provider = stubIdp({
			name: 'google',
			onAuthorize: (req) => req.users.find((u) => u.email === req.loginHint),
		});
		const cap = authorizeContext('google', { ...baseParams, login_hint: 'google-user@stub.invalid' });
		await handleAuthorize(provider, cap.ctx, stubOpts);
		assert.strictEqual(cap.status, 302, 'matching loginHint signs in');
		assert.match(cap.headers.get('Location')!, /code=/);
	});

	test('inline users appear on the login screen (and replace the default)', async () => {
		const provider = stubIdp({
			name: 'corporate',
			users: [
				{ sub: 'u-1', email: 'alice@example.com', name: 'Alice' },
				{ sub: 'u-2', email: 'bob@example.com', name: 'Bob' },
			],
		});
		const cap = authorizeContext('corporate', baseParams);
		await handleAuthorize(provider, cap.ctx, stubOpts);
		assert.strictEqual(cap.status, 200);
		const html = String(cap.sent);
		assert.match(html, /alice@example\.com/);
		assert.match(html, /bob@example\.com/);
		// The built-in default user is no longer offered when inline users are set.
		assert.doesNotMatch(html, /corporate-user@stub\.invalid/);
	});

	test('onAuthorize receives the inline users directory', async () => {
		const provider = stubIdp({
			name: 'corporate',
			users: [
				{ sub: 'u-1', email: 'alice@example.com', name: 'Alice' },
				{ sub: 'u-2', email: 'bob@example.com', name: 'Bob' },
			],
			onAuthorize: (req) => req.users.find((u) => u.email === req.loginHint),
		});
		const cap = authorizeContext('corporate', { ...baseParams, login_hint: 'bob@example.com' });
		await handleAuthorize(provider, cap.ctx, stubOpts);
		assert.strictEqual(cap.status, 302, 'inline user matched by loginHint signs in');
		assert.match(cap.headers.get('Location')!, /code=/);
	});

	test('rejects custom-scheme redirect_uri', async () => {
		const provider = stubIdp({ name: 'google', onAuthorize: (req) => req.users[0] });
		const cap = authorizeContext('google', { ...baseParams, redirect_uri: 'myapp://callback' });
		await handleAuthorize(provider, cap.ctx, stubOpts);
		assert.strictEqual(cap.status, 400);
	});

	test('rejects redirect_uri whose query carries the reserved `scope` param', async () => {
		const provider = stubIdp({ name: 'google', onAuthorize: (req) => req.users[0] });
		const cap = authorizeContext('google', {
			...baseParams,
			redirect_uri: 'https://app.example.com/auth/spa-callback?scope=openid',
		});
		await handleAuthorize(provider, cap.ctx, stubOpts);
		assert.strictEqual(cap.status, 400);
		assert.deepStrictEqual(cap.sent, {
			error: 'invalid_request',
			error_description: 'Invalid redirect_uri: contains reserved response param scope',
		});
	});

	test('rejects redirect_uri whose query carries the reserved `state` param', async () => {
		const provider = stubIdp({ name: 'google', onAuthorize: (req) => req.users[0] });
		const cap = authorizeContext('google', {
			...baseParams,
			redirect_uri: 'https://app.example.com/auth/callback?state=abc',
		});
		await handleAuthorize(provider, cap.ctx, stubOpts);
		assert.strictEqual(cap.status, 400);
		assert.deepStrictEqual(cap.sent, {
			error: 'invalid_request',
			error_description: 'Invalid redirect_uri: contains reserved response param state',
		});
	});

	test('rejects redirect_uri whose query carries the reserved `error_description` param', async () => {
		const provider = stubIdp({ name: 'google', onAuthorize: (req) => req.users[0] });
		const cap = authorizeContext('google', {
			...baseParams,
			redirect_uri: 'https://app.example.com/auth/callback?error_description=x',
		});
		await handleAuthorize(provider, cap.ctx, stubOpts);
		assert.strictEqual(cap.status, 400);
		assert.deepStrictEqual(cap.sent, {
			error: 'invalid_request',
			error_description: 'Invalid redirect_uri: contains reserved response param error_description',
		});
	});

	test('accepts a differently-cased reserved param name, matching the real IdP', async () => {
		const provider = stubIdp({ name: 'google', onAuthorize: (req) => req.users[0] });
		const cap = authorizeContext('google', {
			...baseParams,
			redirect_uri: 'https://app.example.com/aws-blocks/auth/callback?State=abc',
		});
		await handleAuthorize(provider, cap.ctx, stubOpts);
		assert.strictEqual(cap.status, 302, 'capital-S `State` is a distinct, non-reserved query key');
		assert.match(cap.headers.get('Location')!, /State=abc/);
		assert.match(cap.headers.get('Location')!, /code=/);
	});

	test('rejects redirect_uri carrying a fragment', async () => {
		const provider = stubIdp({ name: 'google', onAuthorize: (req) => req.users[0] });
		const cap = authorizeContext('google', {
			...baseParams,
			redirect_uri: 'https://app.example.com/auth/callback#state=1',
		});
		await handleAuthorize(provider, cap.ctx, stubOpts);
		assert.strictEqual(cap.status, 400);
		assert.deepStrictEqual(cap.sent, {
			error: 'invalid_request',
			error_description: 'Invalid redirect_uri: must not contain a fragment',
		});
	});

	test('accepts redirect_uri with a non-reserved query param', async () => {
		const provider = stubIdp({ name: 'google', onAuthorize: (req) => req.users[0] });
		const cap = authorizeContext('google', {
			...baseParams,
			redirect_uri: 'https://app.example.com/aws-blocks/auth/callback?tenant=acme',
		});
		await handleAuthorize(provider, cap.ctx, stubOpts);
		assert.strictEqual(cap.status, 302);
		assert.match(cap.headers.get('Location')!, /tenant=acme/);
		assert.match(cap.headers.get('Location')!, /code=/);
	});

	test('login-form submit issues a code for the picked user', async () => {
		const provider = stubIdp({ name: 'google' });
		const form = new URLSearchParams({ ...baseParams, scope: 'openid email', sub: 'stub-google-user' });
		const cap = authorizeContext('google', {}, form.toString());
		await handleAuthorizeSubmit(provider, cap.ctx, stubOpts);
		assert.strictEqual(cap.status, 302);
		assert.match(cap.headers.get('Location')!, /^https:\/\/app\.example\.com\/aws-blocks\/auth\/callback\?code=/);
	});

	test('loads a users.json directory and exposes it as req.users', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'stub-users-'));
		writeFileSync(join(dir, 'users.json'), JSON.stringify([
			{ sub: 'alice', email: 'alice@example.com', name: 'Alice' },
			{ sub: 'bob', email: 'bob@example.com', name: 'Bob' },
		]));
		let seen: string[] = [];
		const provider = stubIdp({
			name: 'google',
			onAuthorize: (req) => { seen = req.users.map((u) => u.sub); return req.users.find((u) => u.email === req.loginHint); },
		});
		const cap = authorizeContext('google', { ...baseParams, login_hint: 'bob@example.com' });
		await handleAuthorize(provider, cap.ctx, { ...stubOpts, dataDir: dir });
		rmSync(dir, { recursive: true, force: true });
		assert.deepStrictEqual(seen, ['alice', 'bob']);
		assert.strictEqual(cap.status, 302, 'picked Bob by loginHint');
	});

	test('falls back to the default user when no directory exists', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'stub-empty-'));
		let seen: string[] = [];
		const provider = stubIdp({ name: 'google', onAuthorize: (req) => { seen = req.users.map((u) => u.sub); return req.users[0]; } });
		const cap = authorizeContext('google', baseParams);
		await handleAuthorize(provider, cap.ctx, { ...stubOpts, dataDir: dir });
		rmSync(dir, { recursive: true, force: true });
		assert.deepStrictEqual(seen, ['stub-google-user']);
		assert.strictEqual(cap.status, 302);
	});
});

describe('stub IdP authorization-code signing', () => {
	const payload = () => ({
		clientId: 'stub-client-id',
		codeChallenge: 'abc',
		codeChallengeMethod: 'S256',
		state: 'xyz',
		nonce: 'n',
		redirectUri: 'https://app.example.com/aws-blocks/auth/callback',
		scopes: ['openid'],
		user: { sub: 'stub-google-user', email: 'google-user@stub.invalid' },
		exp: Math.floor(Date.now() / 1000) + 300,
	});
	const keyA = deriveStubCodeKey('test-cookie-secret', 'A');

	test('round-trips a code signed with a derived key', () => {
		const code = stubCodeEncode(payload(), keyA);
		const decoded = stubCodeDecode(code, keyA);
		assert.ok(decoded);
		assert.strictEqual(decoded.clientId, 'stub-client-id');
		assert.strictEqual(decoded.user.sub, 'stub-google-user');
	});

	test('key derivation is deterministic per secret and provider', () => {
		assert.ok(deriveStubCodeKey('test-cookie-secret', 'A').equals(keyA));
		assert.ok(!deriveStubCodeKey('other-cookie-secret', 'A').equals(keyA));
	});

	test('rejects a code signed with a different key (the former fixed key)', () => {
		const code = stubCodeEncode(payload(), 'blocks-stub-idp-code-signing-secret-not-for-production');
		assert.strictEqual(stubCodeDecode(code, keyA), null);
	});

	test('rejects a code whose payload was modified', () => {
		const code = stubCodeEncode(payload(), keyA);
		const dot = code.lastIndexOf('.');
		const body = code.slice(0, dot);
		const i = Math.floor(body.length / 2);
		const flipped = body.slice(0, i) + (body[i] === 'A' ? 'B' : 'A') + body.slice(i + 1);
		assert.strictEqual(stubCodeDecode(`${flipped}${code.slice(dot)}`, keyA), null);
	});

	test('returns null without throwing for a truncated or wrong-length MAC', () => {
		const code = stubCodeEncode(payload(), keyA);
		assert.doesNotThrow(() => stubCodeDecode(code.slice(0, -4), keyA));
		assert.strictEqual(stubCodeDecode(code.slice(0, -4), keyA), null);
		assert.strictEqual(stubCodeDecode(`${code}AAAA`, keyA), null);
		assert.strictEqual(stubCodeDecode(code.slice(0, code.lastIndexOf('.') + 1), keyA), null);
		assert.strictEqual(stubCodeDecode('no-dot-here', keyA), null);
	});

	test('rejects a MAC with trailing base64 padding appended', () => {
		const code = stubCodeEncode(payload(), keyA);
		assert.strictEqual(stubCodeDecode(`${code}=`, keyA), null);
		assert.strictEqual(stubCodeDecode(`${code}==`, keyA), null);
	});

	test('rejects a MAC whose last character is flipped to a byte-equivalent spelling', () => {
		// A 32-byte MAC is 43 base64url chars; the last char's low 2 bits are
		// unused, so toggling its lowest alphabet bit decodes to the same bytes.
		const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
		const code = stubCodeEncode(payload(), keyA);
		const last = code[code.length - 1];
		const sibling = alphabet[alphabet.indexOf(last) ^ 1];
		const tampered = code.slice(0, -1) + sibling;
		assert.notStrictEqual(tampered, code);
		assert.strictEqual(stubCodeDecode(tampered, keyA), null);
	});

	test('rejects a MAC with an inserted non-base64url character', () => {
		const code = stubCodeEncode(payload(), keyA);
		const dot = code.lastIndexOf('.');
		const i = dot + 1 + Math.floor((code.length - dot - 1) / 2);
		assert.strictEqual(stubCodeDecode(`${code.slice(0, i)}!${code.slice(i)}`, keyA), null);
	});

	test('rejects a code minted for provider A under provider B\'s key', () => {
		const code = stubCodeEncode(payload(), keyA);
		const keyB = deriveStubCodeKey('test-cookie-secret', 'B');
		assert.strictEqual(stubCodeDecode(code, keyB), null);
	});

	test('rejects an expired code signed with the right key', () => {
		const code = stubCodeEncode({ ...payload(), exp: Math.floor(Date.now() / 1000) - 1 }, keyA);
		assert.strictEqual(stubCodeDecode(code, keyA), null);
	});
});

describe('provider helpers', () => {
	test('stubIdp returns correct shape', () => {
		const p = stubIdp({ name: 'test' });
		assert.strictEqual(p.name, 'test');
		assert.strictEqual(p.kind, 'stub');
		assert.strictEqual(p.clientId, 'stub-client-id');
		assert.strictEqual(p.clientSecret, 'stub-client-secret');
		assert.deepStrictEqual(p.scopes, ['openid', 'email', 'profile']);
	});

	test('stubIdp accepts custom scopes', () => {
		const p = stubIdp({ name: 'custom', scopes: ['openid'] });
		assert.deepStrictEqual(p.scopes, ['openid']);
	});

	test('google returns oidc-builtin with correct issuer', () => {
		const p = google({ clientId: 'id', clientSecret: 'secret' });
		assert.strictEqual(p.name, 'google');
		assert.strictEqual(p.kind, 'oidc-builtin');
		assert.strictEqual(p.issuerUrl, 'https://accounts.google.com');
		assert.deepStrictEqual(p.scopes, ['openid', 'email', 'profile']);
	});

	test('customOidc returns oidc-custom with issuerUrl', () => {
		const p = customOidc({
			name: 'okta',
			issuerUrl: 'https://my-org.okta.com/oauth2/default',
			clientId: 'id',
			clientSecret: 'secret',
		});
		assert.strictEqual(p.name, 'okta');
		assert.strictEqual(p.kind, 'oidc-custom');
		assert.strictEqual(p.issuerUrl, 'https://my-org.okta.com/oauth2/default');
	});

	test('customOauth2 returns oauth2-custom with all URLs', () => {
		const mapClaims = (raw: unknown) => ({ providerSub: '1', email: null, name: null });
		const p = customOauth2({
			name: 'slack',
			authUrl: 'https://slack.com/oauth/v2/authorize',
			tokenUrl: 'https://slack.com/api/oauth.v2.access',
			userInfoUrl: 'https://slack.com/api/users.identity',
			clientId: 'id',
			clientSecret: 'secret',
			scopes: ['identity.basic'],
			mapClaims,
		});
		assert.strictEqual(p.name, 'slack');
		assert.strictEqual(p.kind, 'oauth2-custom');
		assert.strictEqual(p.authUrl, 'https://slack.com/oauth/v2/authorize');
		assert.strictEqual(p.tokenUrl, 'https://slack.com/api/oauth.v2.access');
		assert.strictEqual(p.userInfoUrl, 'https://slack.com/api/users.identity');
		assert.strictEqual(p.mapClaims, mapClaims);
	});
});

describe('requireAuth / checkAuth / getCurrentUser without session', () => {
	test('requireAuth throws NotAuthenticated when no session', async () => {
		const auth = new AuthOIDC(ROOT, unique('noauth'), {
			providers: [stubIdp({ name: unique('p') })],
		});
		const ctx = freshContext();
		await assert.rejects(
			() => auth.requireAuth(ctx),
			(e: Error) => e.name === AuthOIDCErrors.NotAuthenticated,
		);
	});

	test('requireAuth throws an ApiError with status 401 (regression: handle401 / e.status===401 must match)', async () => {
		// A bare Error serializes as 500 over JSON-RPC, so handle401 (status === 401)
		// never fired. Must be ApiError(401); name preserved for isBlocksError().
		const auth = new AuthOIDC(ROOT, unique('noauth401'), {
			providers: [stubIdp({ name: unique('p') })],
		});
		const ctx = freshContext();
		await assert.rejects(
			() => auth.requireAuth(ctx),
			(e: unknown) => {
				assert.ok(e instanceof ApiError, `expected ApiError, got ${(e as { constructor?: { name?: string } })?.constructor?.name}`);
				assert.strictEqual(e.status, 401);
				assert.strictEqual(e.name, AuthOIDCErrors.NotAuthenticated);
				return true;
			},
		);
	});

	test('checkAuth returns false when no session', async () => {
		const auth = new AuthOIDC(ROOT, unique('nocheck'), {
			providers: [stubIdp({ name: unique('p') })],
		});
		const ctx = freshContext();
		assert.strictEqual(await auth.checkAuth(ctx), false);
	});

	test('getCurrentUser returns null when no session', async () => {
		const auth = new AuthOIDC(ROOT, unique('nocur'), {
			providers: [stubIdp({ name: unique('p') })],
		});
		const ctx = freshContext();
		assert.strictEqual(await auth.getCurrentUser(ctx), null);
	});
});

describe('createApi', () => {
	test('returns a function (ApiNamespace)', () => {
		const auth = new AuthOIDC(ROOT, unique('api'), {
			providers: [stubIdp({ name: unique('p') })],
		});
		const api = auth.createApi();
		assert.strictEqual(typeof api, 'function');
	});

	test('providers getter returns configured provider names', () => {
		const auth = new AuthOIDC(ROOT, unique('prov'), {
			providers: [stubIdp({ name: 'alpha' }), stubIdp({ name: 'beta' })],
		});
		assert.deepStrictEqual([...auth.providers], ['alpha', 'beta']);
	});
});

describe('path configuration', () => {
	test('default paths', () => {
		const auth = new AuthOIDC(ROOT, unique('paths'), {
			providers: [stubIdp({ name: unique('p') })],
		});
		assert.strictEqual(auth.callbackPath, '/aws-blocks/auth/callback');
		assert.strictEqual(auth.signOutPath, '/aws-blocks/auth/signout');
		assert.strictEqual(auth.postSignInPath, '/');
	});

	test('custom paths', () => {
		const auth = new AuthOIDC(ROOT, unique('cpaths'), {
			providers: [stubIdp({ name: unique('p') })],
			callbackPath: '/aws-blocks/auth/custom/callback',
			signOutPath: '/aws-blocks/auth/custom/logout',
			postSignInPath: '/dashboard',
		});
		assert.strictEqual(auth.callbackPath, '/aws-blocks/auth/custom/callback');
		assert.strictEqual(auth.signOutPath, '/aws-blocks/auth/custom/logout');
		assert.strictEqual(auth.postSignInPath, '/dashboard');
	});

	test('rejects callbackPath outside the /aws-blocks/auth subtree', () => {
		assert.throws(
			() => new AuthOIDC(ROOT, unique('badbase'), {
				providers: [stubIdp({ name: unique('p') })],
				callbackPath: '/auth/callback',
			}),
			/must be a path under '\/aws-blocks\/auth\/'/,
		);
	});

	test('signInRoutePath includes provider name', () => {
		const auth = new AuthOIDC(ROOT, unique('route'), {
			providers: [stubIdp({ name: unique('p') })],
		});
		assert.strictEqual(auth.signInRoutePath('google'), '/aws-blocks/auth/signin/google');
		assert.strictEqual(auth.signInRoutePath('my provider'), '/aws-blocks/auth/signin/my%20provider');
	});

	test('signin base follows a non-default callbackPath (shares one flow base)', () => {
		const auth = new AuthOIDC(ROOT, unique('route2'), {
			providers: [stubIdp({ name: unique('p') })],
			callbackPath: '/aws-blocks/auth/real/callback',
		});
		assert.strictEqual(auth.signInBasePath, '/aws-blocks/auth/real/signin');
		assert.strictEqual(auth.signInRoutePath('google'), '/aws-blocks/auth/real/signin/google');
	});
});

describe('AuthOIDCErrors', () => {
	test('all error names end with Exception', () => {
		for (const [key, value] of Object.entries(AuthOIDCErrors)) {
			assert.ok(
				(value as string).endsWith('Exception'),
				`${key} should end with Exception, got: ${value}`,
			);
		}
	});
});

describe('allowBearerAuth', () => {
	test('defaults to false', () => {
		const auth = new AuthOIDC(ROOT, unique('bearer-off'), {
			providers: [stubIdp({ name: unique('p') })],
		});
		assert.strictEqual(auth.allowBearerAuth, false);
	});

	test('reflects the configured value', () => {
		const auth = new AuthOIDC(ROOT, unique('bearer-on'), {
			providers: [stubIdp({ name: unique('p') })],
			allowBearerAuth: true,
		});
		assert.strictEqual(auth.allowBearerAuth, true);
	});

	test('refreshBearerTokens returns null when allowBearerAuth is disabled', async () => {
		const auth = new AuthOIDC(ROOT, unique('bearer-disabled'), {
			providers: [stubIdp({ name: 'google' })],
		});
		const result = await auth.refreshBearerTokens(
			{ refreshToken: 'any', provider: 'google' },
			freshContext(),
		);
		assert.strictEqual(result, null);
	});

	test('refreshBearerTokens throws ProviderNotConfigured for unknown provider', async () => {
		const auth = new AuthOIDC(ROOT, unique('bearer-unknown'), {
			providers: [stubIdp({ name: 'google' })],
			allowBearerAuth: true,
		});
		await assert.rejects(
			() => auth.refreshBearerTokens(
				{ refreshToken: 'any', provider: 'not-configured' },
				freshContext(),
			),
			(err: Error) => err.name === AuthOIDCErrors.ProviderNotConfigured,
		);
	});
});

describe('verifyAccessToken signature verification', () => {
	const PROVIDER_NAME = 'sig-verify-provider';
	let server: Server;
	let baseUrl: string;
	let privateKey: CryptoKey;
	let publicJwk: any;
	let kid: string;

	// Own keypair + served JWKS so we can sign valid-signature-but-bad-claim
	// tokens (expired, wrong-issuer) without reaching into the stub's key.
	const issuerFor = () => `${baseUrl}/aws-blocks/auth/idp/${PROVIDER_NAME}`;

	async function signToken(opts: { issuer?: string; sub: string; expSeconds?: number; claims?: Record<string, unknown>; key?: CryptoKey; kid?: string }): Promise<string> {
		const now = Math.floor(Date.now() / 1000);
		return new SignJWT({ ...opts.claims })
			.setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? kid, typ: 'JWT' })
			.setIssuer(opts.issuer ?? issuerFor())
			.setSubject(opts.sub)
			.setAudience('stub-client-id')
			.setIssuedAt(now)
			.setExpirationTime(now + (opts.expSeconds ?? 3600))
			.sign(opts.key ?? privateKey);
	}

	beforeEach(async () => {
		const keyPair = await generateKeyPair('RS256', { extractable: true });
		privateKey = keyPair.privateKey;
		publicJwk = await exportJWK(keyPair.publicKey);
		kid = `sig-test-${Date.now()}`;
		publicJwk.kid = kid;
		publicJwk.use = 'sig';
		publicJwk.alg = 'RS256';

		await new Promise<void>((resolve) => {
			server = createServer((req, res) => {
				const url = new URL(req.url!, 'http://localhost');
				res.writeHead(200, { 'Content-Type': 'application/json' });
				if (url.pathname.endsWith('/.well-known/openid-configuration')) {
					const issuer = issuerFor();
					res.end(JSON.stringify({
						issuer,
						authorization_endpoint: `${issuer}/authorize`,
						token_endpoint: `${issuer}/token`,
						jwks_uri: `${issuer}/jwks.json`,
						id_token_signing_alg_values_supported: ['RS256'],
					}));
				} else if (url.pathname.endsWith('/jwks.json')) {
					res.end(JSON.stringify({ keys: [publicJwk] }));
				} else {
					res.writeHead(404);
					res.end('not found');
				}
			});
			server.listen(0, '127.0.0.1', () => {
				const addr = server.address() as { port: number };
				baseUrl = `http://127.0.0.1:${addr.port}`;
				resolve();
			});
		});
	});

	afterEach(() => {
		server?.close();
	});

	function bearerContext(token: string): BlocksContext {
		const reqHeaders = new Headers();
		reqHeaders.set('authorization', `Bearer ${token}`);
		const resHeaders = new Headers();
		let status = 200;
		return {
			request: {
				headers: reqHeaders,
				body: null,
				json: async () => ({}),
				text: async () => '',
				url: new URL(`${baseUrl}/`),
				params: {},
			},
			response: {
				headers: resHeaders,
				get status() { return status; },
				set status(v) { status = v; },
				send: () => {},
			} as any,
		};
	}

	test('accepts a properly signed JWT with valid claims', async () => {
		const auth = new AuthOIDC(ROOT, unique('sig-valid'), {
			providers: [stubIdp({ name: PROVIDER_NAME })],
			allowBearerAuth: true,
		});

		const token = await signToken({
			sub: 'user-123',
			claims: { email: 'test@example.com', name: 'Test User' },
		});

		const ctx = bearerContext(token);
		const user = await auth.getCurrentUser(ctx);
		assert.ok(user, 'expected a valid user from signature-verified token');
		assert.strictEqual(user.sub, 'user-123');
		assert.strictEqual(user.email, 'test@example.com');
		assert.strictEqual(user.name, 'Test User');
	});

	test('rejects a token with forged signature (different key)', async () => {
		const auth = new AuthOIDC(ROOT, unique('sig-forged'), {
			providers: [stubIdp({ name: PROVIDER_NAME })],
			allowBearerAuth: true,
		});

		// Sign with a throwaway key the served JWKS doesn't know.
		const { privateKey: forgedKey } = await generateKeyPair('RS256', { extractable: true });
		const forgedToken = await signToken({
			sub: 'attacker-sub',
			claims: { email: 'attacker@evil.com', name: 'Attacker' },
			key: forgedKey,
			kid: 'forged-kid',
		});

		const ctx = bearerContext(forgedToken);
		const user = await auth.getCurrentUser(ctx);
		assert.strictEqual(user, null, 'forged token must be rejected');
	});

	test('rejects an expired token', async () => {
		const auth = new AuthOIDC(ROOT, unique('sig-expired'), {
			providers: [stubIdp({ name: PROVIDER_NAME })],
			allowBearerAuth: true,
		});

		const token = await signToken({ sub: 'user-123', expSeconds: -600 });

		const ctx = bearerContext(token);
		const user = await auth.getCurrentUser(ctx);
		assert.strictEqual(user, null, 'expired token must be rejected');
	});

	test('rejects a token with wrong issuer', async () => {
		const auth = new AuthOIDC(ROOT, unique('sig-wrong-iss'), {
			providers: [stubIdp({ name: PROVIDER_NAME })],
			allowBearerAuth: true,
		});

		const token = await signToken({ issuer: 'https://evil-issuer.example.com', sub: 'user-123' });

		const ctx = bearerContext(token);
		const user = await auth.getCurrentUser(ctx);
		assert.strictEqual(user, null, 'token with wrong issuer must be rejected');
	});

	test('rejects a non-JWT string', async () => {
		const auth = new AuthOIDC(ROOT, unique('sig-non-jwt'), {
			providers: [stubIdp({ name: PROVIDER_NAME })],
			allowBearerAuth: true,
		});

		const ctx = bearerContext('not-a-jwt-token');
		const user = await auth.getCurrentUser(ctx);
		assert.strictEqual(user, null, 'non-JWT string must be rejected');
	});

	test('returns null when allowBearerAuth is disabled', async () => {
		const auth = new AuthOIDC(ROOT, unique('sig-disabled'), {
			providers: [stubIdp({ name: PROVIDER_NAME })],
			allowBearerAuth: false,
		});

		const token = await signToken({ sub: 'user-123' });

		const ctx = bearerContext(token);
		const user = await auth.getCurrentUser(ctx);
		assert.strictEqual(user, null, 'bearer auth must be disabled');
	});
});

describe('Cognito issuer validation - cross-pool rejection', () => {
	const REGION = 'us-east-1';
	const LEGITIMATE_POOL_ID = 'us-east-1_LegitPool1';
	const ATTACKER_POOL_ID = 'us-east-1_AttackerPool';

	let server: Server;
	let baseUrl: string;
	let privateKey: CryptoKey;
	let publicJwk: any;
	let kid: string;

	beforeEach(async () => {
		const keyPair = await generateKeyPair('RS256', { extractable: true });
		privateKey = keyPair.privateKey;
		publicJwk = await exportJWK(keyPair.publicKey);
		kid = `test-kid-${Date.now()}`;
		publicJwk.kid = kid;
		publicJwk.use = 'sig';
		publicJwk.alg = 'RS256';

		await new Promise<void>((resolve) => {
			server = createServer(async (req, res) => {
				const url = new URL(req.url!, `http://localhost`);
				if (url.pathname.endsWith('/jwks.json')) {
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ keys: [publicJwk] }));
				} else {
					res.writeHead(404);
					res.end('not found');
				}
			});
			server.listen(0, '127.0.0.1', () => {
				const addr = server.address() as { port: number };
				baseUrl = `http://127.0.0.1:${addr.port}`;
				resolve();
			});
		});
	});

	afterEach(() => {
		server?.close();
	});

	function makeCognitoEngine(userPoolId: string) {
		const sessionManager = new SessionManager({
			sessionStore: {
				get: async () => null,
				put: async () => {},
				delete: async () => {},
			},
			cookieSecret: 'test-secret',
			cookieNamePrefix: 'test',
			cookieAttributes: { secure: false, partitioned: false, sameSite: 'Lax', path: '/' },
		});

		return new CognitoFederationEngine({
			providers: [{
				name: 'google',
				kind: 'cognito-federated',
				cognitoDomain: 'myapp',
				region: REGION,
				identityProvider: 'Google',
				clientId: () => 'test-client-id',
				clientSecret: () => 'test-client-secret',
				scopes: ['openid', 'email', 'profile'],
				idpClientId: { fullId: 'test', get: async () => 'test' },
				idpClientSecret: { fullId: 'test', get: async () => 'test' },
			}],
			sessionManager,
			cognitoClientId: () => 'test-client-id',
			cognitoClientSecret: () => 'test-client-secret',
			cognitoUserPoolId: () => userPoolId,
		});
	}

	async function signToken(issuer: string, sub: string, clientId: string) {
		const now = Math.floor(Date.now() / 1000);
		return new SignJWT({ sub, client_id: clientId, token_use: 'access' })
			.setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
			.setIssuer(issuer)
			.setSubject(sub)
			.setIssuedAt(now)
			.setExpirationTime(now + 3600)
			.sign(privateKey);
	}

	test('rejects token from a different user pool in the same region', async () => {
		const engine = makeCognitoEngine(LEGITIMATE_POOL_ID);
		const attackerIssuer = `https://cognito-idp.${REGION}.amazonaws.com/${ATTACKER_POOL_ID}`;
		const token = await signToken(attackerIssuer, 'attacker-user', 'test-client-id');

		const ctx = freshContext();
		const user = await engine.verifyAccessToken(token, ctx);
		assert.strictEqual(user, null, 'token from a different pool must be rejected');
	});

	test('rejects token with issuer matching region but different pool ID', async () => {
		const engine = makeCognitoEngine(LEGITIMATE_POOL_ID);
		const sneakyIssuer = `https://cognito-idp.${REGION}.amazonaws.com/us-east-1_SneakyPool`;
		const token = await signToken(sneakyIssuer, 'sneaky-user', 'test-client-id');

		const ctx = freshContext();
		const user = await engine.verifyAccessToken(token, ctx);
		assert.strictEqual(user, null, 'token from sneaky pool must be rejected');
	});

	test('rejects token with trailing slash on issuer', async () => {
		const engine = makeCognitoEngine(LEGITIMATE_POOL_ID);
		const trailingSlashIssuer = `https://cognito-idp.${REGION}.amazonaws.com/${LEGITIMATE_POOL_ID}/`;
		const token = await signToken(trailingSlashIssuer, 'user-123', 'test-client-id');

		const ctx = freshContext();
		const user = await engine.verifyAccessToken(token, ctx);
		assert.strictEqual(user, null, 'token with trailing slash issuer must be rejected');
	});

	test('rejects token from wrong region entirely', async () => {
		const engine = makeCognitoEngine(LEGITIMATE_POOL_ID);
		const wrongRegionIssuer = `https://cognito-idp.eu-west-1.amazonaws.com/${LEGITIMATE_POOL_ID}`;
		const token = await signToken(wrongRegionIssuer, 'user-123', 'test-client-id');

		const ctx = freshContext();
		const user = await engine.verifyAccessToken(token, ctx);
		assert.strictEqual(user, null, 'token from wrong region must be rejected');
	});

	describe('token-endpoint failure keeps the Cognito response body off the wire', () => {
		const RAW_BODY = '{"error":"invalid_client","error_description":"Client 123456789012 arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_LegitPool1"}';

		afterEach(() => {
			mock.restoreAll();
		});

		test('handleExchange throws a stable branded message with the body on a non-enumerable cause', async () => {
			mock.method(globalThis, 'fetch', async () => new Response(RAW_BODY, { status: 400 }));
			const engine = makeCognitoEngine(LEGITIMATE_POOL_ID);

			const thrown = await engine
				.handleExchange(
					{ code: 'c', verifier: 'v', state: 's', nonce: 'n', provider: 'google', callbackUrl: 'http://localhost:3000/aws-blocks/auth/callback' },
					freshContext(),
				)
				.then(
					() => assert.fail('handleExchange should reject'),
					(err: unknown) => err,
				);

			assert.ok(thrown instanceof Error);
			assert.ok(isWireSafeError(thrown), 'still a branded engine error');
			assert.ok(thrown.message.includes('HTTP 400'), `the status is kept, got: ${thrown.message}`);
			assert.ok(!thrown.message.includes('123456789012'), `message must not embed the token-endpoint body: ${thrown.message}`);
			assert.ok(!thrown.message.includes('invalid_client'));
			assert.ok(thrown.cause instanceof Error && thrown.cause.message === RAW_BODY, 'the body is kept on cause for server-side diagnostics');
			assert.ok(!Object.keys(thrown).includes('cause'), 'cause is non-enumerable (Core rule 5)');
		});
	});
});

describe('alg:none rejection', () => {
	const PROVIDER_NAME = 'alg-none-provider';
	let server: Server;
	let baseUrl: string;

	beforeEach(async () => {
		await new Promise<void>((resolve) => {
			server = createServer(async (req, res) => {
				const url = new URL(req.url!, `http://localhost`);
				const fakeCtx = {
					request: { headers: new Headers(), body: null, json: async () => ({}), text: async () => '', url: new URL(`${baseUrl}${req.url}`), params: {} },
					response: {
						headers: new Map<string, string>(),
						status: 200,
						send: (body: unknown) => {
							res.writeHead(200, { 'Content-Type': 'application/json' });
							res.end(JSON.stringify(body));
						},
					},
				} as any;

				if (url.pathname.endsWith('/.well-known/openid-configuration')) {
					await handleDiscovery(PROVIDER_NAME, fakeCtx);
				} else if (url.pathname.endsWith('/jwks.json')) {
					await handleJwks(PROVIDER_NAME, fakeCtx);
				} else {
					res.writeHead(404);
					res.end('not found');
				}
			});
			server.listen(0, '127.0.0.1', () => {
				const addr = server.address() as { port: number };
				baseUrl = `http://127.0.0.1:${addr.port}`;
				resolve();
			});
		});
	});

	afterEach(() => {
		server?.close();
	});

	test('rejects JWT with alg: none (unsigned token)', async () => {
		const auth = new AuthOIDC(ROOT, unique('alg-none'), {
			providers: [stubIdp({ name: PROVIDER_NAME })],
			allowBearerAuth: true,
		});

		const issuer = `${baseUrl}/aws-blocks/auth/idp/${PROVIDER_NAME}`;

		// Craft a token with alg: none — no signature
		const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
		const now = Math.floor(Date.now() / 1000);
		const payload = Buffer.from(JSON.stringify({
			iss: issuer,
			sub: 'attacker',
			aud: 'stub-client-id',
			exp: now + 3600,
			iat: now,
			email: 'attacker@evil.com',
			name: 'Attacker',
		})).toString('base64url');
		const algNoneToken = `${header}.${payload}.`;

		const reqHeaders = new Headers();
		reqHeaders.set('authorization', `Bearer ${algNoneToken}`);
		const ctx: BlocksContext = {
			request: {
				headers: reqHeaders,
				body: null,
				json: async () => ({}),
				text: async () => '',
				url: new URL(`${baseUrl}/`),
				params: {},
			},
			response: {
				headers: new Headers(),
				get status() { return 200; },
				set status(_v) {},
				send: () => {},
			} as any,
		};

		const user = await auth.getCurrentUser(ctx);
		assert.strictEqual(user, null, 'alg:none token must be rejected');
	});

	test('rejects JWT with alg: none even with valid-looking claims', async () => {
		const auth = new AuthOIDC(ROOT, unique('alg-none-valid-claims'), {
			providers: [stubIdp({ name: PROVIDER_NAME })],
			allowBearerAuth: true,
		});

		const issuer = `${baseUrl}/aws-blocks/auth/idp/${PROVIDER_NAME}`;

		// Craft with empty signature (three parts, last is empty)
		const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
		const now = Math.floor(Date.now() / 1000);
		const payload = Buffer.from(JSON.stringify({
			iss: issuer,
			sub: 'legitimate-user',
			aud: 'stub-client-id',
			exp: now + 3600,
			iat: now,
			email: 'user@company.com',
			name: 'Legitimate User',
		})).toString('base64url');
		// Three-part structure with empty signature
		const algNoneToken = `${header}.${payload}.`;

		const reqHeaders = new Headers();
		reqHeaders.set('authorization', `Bearer ${algNoneToken}`);
		const ctx: BlocksContext = {
			request: {
				headers: reqHeaders,
				body: null,
				json: async () => ({}),
				text: async () => '',
				url: new URL(`${baseUrl}/`),
				params: {},
			},
			response: {
				headers: new Headers(),
				get status() { return 200; },
				set status(_v) {},
				send: () => {},
			} as any,
		};

		const user = await auth.getCurrentUser(ctx);
		assert.strictEqual(user, null, 'alg:none with valid claims must still be rejected');
	});
});

describe('signOut — session-store failures must not report a completed sign-out', () => {
	// Raw store error text shaped like a DynamoDB SDK failure: it must never reach
	// the wire (no ARN / account id / operation name in the thrown message).
	const RAW_STORE_ERROR =
		'ThrottlingException: Rate exceeded for arn:aws:dynamodb:us-east-1:123456789012:table/sessions (DeleteItem)';
	const NO_LEAK = /arn:aws|123456789012|DeleteItem|GetItem|Throttling/;

	type SignOutProbe = { engine: { sessionManager: SessionManager } };

	function makeAuth() {
		return new AuthOIDC(ROOT, unique('signout'), { providers: [stubIdp({ name: 'google' })] });
	}

	function sessionManagerOf(auth: AuthOIDC): SessionManager {
		return (auth as unknown as SignOutProbe).engine.sessionManager;
	}

	function withCookie(cookie: string): BlocksContext {
		const ctx = freshContext();
		ctx.request.headers.set('cookie', cookie);
		return ctx;
	}

	/** Write a live stateful session (as a completed sign-in would) and return its cookie. */
	async function signedInCookie(sm: SessionManager): Promise<string> {
		const ctx = freshContext();
		const exp = Math.floor(Date.now() / 1000) + 3600;
		await sm.writeStatefulSession({
			userId: 'https://issuer.example:u1',
			username: 'u1',
			provider: 'google',
			sub: 'u1',
			iss: 'https://issuer.example',
			email: null,
			name: null,
			claims: { sub: 'u1', iss: 'https://issuer.example', exp },
		}, 'RT-1', ctx);
		const [setCookie] = ctx.response.headers.getSetCookie();
		return setCookie.split(';')[0];
	}

	function assertCookiesCleared(ctx: BlocksContext): void {
		const cleared = ctx.response.headers.getSetCookie();
		assert.ok(cleared.some((c) => /_session=;/.test(c) && /Max-Age=0/i.test(c)), `session cookie cleared: ${cleared}`);
		assert.ok(cleared.some((c) => /_pending=;/.test(c)), `pending cookie cleared: ${cleared}`);
	}

	test('a successful sign-out invalidates the session server-side (replayed cookie rejected)', async () => {
		const auth = makeAuth();
		const cookie = await signedInCookie(sessionManagerOf(auth));
		assert.ok(await auth.getCurrentUser(withCookie(cookie)), 'precondition: the cookie authenticates');

		const ctx = withCookie(cookie);
		await auth.signOut(ctx);

		assertCookiesCleared(ctx);
		assert.strictEqual(await auth.getCurrentUser(withCookie(cookie)), null, 'replayed cookie no longer authenticates');
	});

	test('a failed session delete clears cookies and throws SignOutIncomplete (503, no store-error leak)', async () => {
		const auth = makeAuth();
		const sm = sessionManagerOf(auth);
		const cookie = await signedInCookie(sm);
		const store = sm.sessionStore;
		const realDelete = store.delete.bind(store);
		store.delete = async () => { throw new Error(RAW_STORE_ERROR); };
		try {
			const ctx = withCookie(cookie);
			await assert.rejects(() => auth.signOut(ctx), (e: unknown) => {
				assert.ok(e instanceof ApiError, `expected ApiError, got ${String(e)}`);
				assert.strictEqual(e.name, AuthOIDCErrors.SignOutIncomplete);
				assert.strictEqual(e.status, 503);
				assert.doesNotMatch(e.message, NO_LEAK);
				return true;
			});
			// This device is still signed out: the cookies are cleared even though
			// the server-side row could not be deleted.
			assertCookiesCleared(ctx);

			// Through the createApi state machine the Authenticator sees a
			// signed-out state carrying the stable error name, not a silent success.
			const api = (auth.createApi() as unknown as (c: BlocksContext) => {
				setAuthState(input: AuthActionInput): Promise<AuthState>;
			})(withCookie(cookie));
			const next = await api.setAuthState({ action: 'signOut' });
			assert.strictEqual(next.state, 'signedOut');
			assert.strictEqual(next.errorName, AuthOIDCErrors.SignOutIncomplete);
			assert.doesNotMatch(next.error ?? '', NO_LEAK);
		} finally {
			store.delete = realDelete;
		}
	});

	test('the sign-out route answers 503 SignOutIncomplete (not 204) and still clears the cookies on the wire', async () => {
		const auth = makeAuth();
		const sm = sessionManagerOf(auth);
		const cookie = await signedInCookie(sm);
		const store = sm.sessionStore;
		const realDelete = store.delete.bind(store);
		store.delete = async () => { throw new Error(RAW_STORE_ERROR); };
		const originalError = console.error;
		const originalWarn = console.warn;
		console.error = () => {};
		console.warn = () => {};
		try {
			// The real RawRoute through the real Lambda dispatcher (API Gateway v1 event).
			const handler = createLambdaHandler(async () => ({}));
			const res = (await handler({
				httpMethod: 'POST',
				path: auth.signOutPath,
				headers: { cookie },
				body: null,
				isBase64Encoded: false,
			} as never)) as { statusCode: number; body: string; multiValueHeaders?: { 'Set-Cookie'?: string[] } };

			assert.strictEqual(res.statusCode, 503, `sign-out must not report success: ${res.body}`);
			const body = JSON.parse(res.body) as { error?: string; name?: string };
			assert.strictEqual(body.name, AuthOIDCErrors.SignOutIncomplete);
			assert.doesNotMatch(res.body, NO_LEAK);
			const cookies = res.multiValueHeaders?.['Set-Cookie'] ?? [];
			assert.ok(cookies.some((c) => /_session=;/.test(c) && /Max-Age=0/i.test(c)), `session cookie cleared: ${cookies}`);
			assert.ok(await auth.getCurrentUser(withCookie(cookie)), 'the row survived the failed delete (why 503 is reported)');
		} finally {
			console.error = originalError;
			console.warn = originalWarn;
			store.delete = realDelete;
		}
	});

	test('a failed session read still deletes the row, so a replayed cookie is rejected', async () => {
		const auth = makeAuth();
		const sm = sessionManagerOf(auth);
		const cookie = await signedInCookie(sm);
		const store = sm.sessionStore;
		const realGet = store.get.bind(store);
		let failNextGet = true;
		store.get = async (key: string) => {
			if (failNextGet) {
				failNextGet = false;
				throw new Error(RAW_STORE_ERROR);
			}
			return realGet(key);
		};
		try {
			const ctx = withCookie(cookie);
			await auth.signOut(ctx);
			assertCookiesCleared(ctx);
			assert.strictEqual(await auth.getCurrentUser(withCookie(cookie)), null, 'replayed cookie no longer authenticates');
		} finally {
			store.get = realGet;
		}
	});

	test('a failed cookie-secret resolution still clears cookies and throws SignOutIncomplete (no revoke, no leak)', async () => {
		// In production the secret is an SSM fetch that can fail transiently, and
		// memoizedSecretResolver rethrows (it never memoizes a failure).
		const RAW_SSM_ERROR = 'ThrottlingException: Rate exceeded for arn:aws:ssm:us-east-1:123456789012:parameter/cookie';
		const rows = new Map<string, SessionRow>();
		const sessionStore = {
			get: async (k: string) => rows.get(k) ?? null,
			put: async (k: string, v: SessionRow) => { rows.set(k, v); },
			delete: async (k: string) => { rows.delete(k); },
		};
		const cookieAttributes = { secure: false, partitioned: false, sameSite: 'Lax', path: '/' } as const;
		// One container signed the cookie; this one cannot resolve the secret.
		const signer = new SessionManager({ sessionStore, cookieSecret: 'test-secret', cookieNamePrefix: 'test', cookieAttributes });
		const sm = new SessionManager({
			sessionStore,
			cookieSecret: () => { throw new Error(RAW_SSM_ERROR); },
			cookieNamePrefix: 'test',
			cookieAttributes,
		});
		const cookie = await signedInCookie(signer);

		const revoked: string[] = [];
		const originalError = console.error;
		console.error = () => {};
		try {
			const ctx = withCookie(cookie);
			await assert.rejects(() => sm.signOutSession(ctx, async (rt) => { revoked.push(rt); }), (e: unknown) => {
				assert.ok(e instanceof ApiError, `expected ApiError, got ${String(e)}`);
				assert.strictEqual(e.name, AuthOIDCErrors.SignOutIncomplete);
				assert.strictEqual(e.status, 503);
				assert.doesNotMatch(e.message, /arn:aws|123456789012|Throttling|ssm/i);
				return true;
			});
			// This device is signed out even though the session could not be identified.
			assertCookiesCleared(ctx);
			assert.deepStrictEqual(revoked, [], 'no refresh token was read, so nothing is revoked');
			assert.strictEqual(rows.size, 1, 'the row was not deleted (why SignOutIncomplete is reported)');
		} finally {
			console.error = originalError;
		}
	});

	test('Cognito engine: upstream revocation still runs with the stored refresh token when the delete fails', async () => {
		const rows = new Map<string, SessionRow>();
		const sm = new SessionManager({
			sessionStore: {
				get: async (k) => rows.get(k) ?? null,
				put: async (k, v) => { rows.set(k, v); },
				delete: async () => { throw new Error(RAW_STORE_ERROR); },
			},
			cookieSecret: 'test-secret',
			cookieNamePrefix: 'test',
			cookieAttributes: { secure: false, partitioned: false, sameSite: 'Lax', path: '/' },
		});
		const engine = new CognitoFederationEngine({
			providers: [{
				name: 'google',
				kind: 'cognito-federated',
				cognitoDomain: 'myapp',
				region: 'us-east-1',
				identityProvider: 'Google',
				clientId: () => 'test-client-id',
				clientSecret: () => 'test-client-secret',
				scopes: ['openid', 'email', 'profile'],
				idpClientId: { fullId: 'test', get: async () => 'test' },
				idpClientSecret: { fullId: 'test', get: async () => 'test' },
			}],
			sessionManager: sm,
			cognitoClientId: () => 'test-client-id',
			cognitoClientSecret: () => 'test-client-secret',
			cognitoUserPoolId: () => 'us-east-1_Pool',
		});
		const cookie = await signedInCookie(sm);

		const revoked: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			if (String(url).endsWith('/oauth2/revoke')) {
				revoked.push(new URLSearchParams(String(init?.body)).get('token') ?? '');
			}
			return new Response(null, { status: 200 });
		}) as typeof globalThis.fetch;
		try {
			const ctx = withCookie(cookie);
			await assert.rejects(
				() => engine.signOut(ctx),
				(e: unknown) => e instanceof ApiError && e.name === AuthOIDCErrors.SignOutIncomplete,
			);
			assertCookiesCleared(ctx);
			assert.deepStrictEqual(revoked, ['RT-1'], 'the refresh token read before the failed delete was revoked upstream');
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test('OIDC engine: upstream revocation still runs with the stored refresh token when the delete fails', async () => {
		const auth = makeAuth();
		const sm = sessionManagerOf(auth);
		const cookie = await signedInCookie(sm);
		// Plumbing: the generic engine's revocation is private; probe it the same way
		// `sessionManagerOf` reaches the session manager.
		type RevokeProbe = {
			engine: { bestEffortRevoke: (provider: string, refreshToken: string, ctx: BlocksContext) => Promise<void> };
		};
		const probe: RevokeProbe = auth as unknown as RevokeProbe;
		const revoked: Array<[string, string]> = [];
		probe.engine.bestEffortRevoke = async (provider, refreshToken) => { revoked.push([provider, refreshToken]); };
		const store = sm.sessionStore;
		const realDelete = store.delete.bind(store);
		store.delete = async () => { throw new Error(RAW_STORE_ERROR); };
		try {
			const ctx = withCookie(cookie);
			await assert.rejects(
				() => auth.signOut(ctx),
				(e: unknown) => e instanceof ApiError && e.name === AuthOIDCErrors.SignOutIncomplete,
			);
			assertCookiesCleared(ctx);
			assert.deepStrictEqual(revoked, [['google', 'RT-1']], 'the refresh token read before the failed delete was revoked upstream');
		} finally {
			store.delete = realDelete;
		}
	});
});

// Behind a Blocks CloudFront front door, ctx.request.url is the host the request came
// in on. Authorize can come in on any of the door's hosts; the IdP sends the callback
// to the one BLOCKS_PUBLIC_ORIGIN names. A same-origin relay accepted at authorize must
// still be accepted at the callback's re-check.
describe('relay — a same-origin relay survives the callback on another of the backend\'s hosts', () => {
	const savedHosts = process.env.BLOCKS_PUBLIC_HOSTS;
	let server: Server;
	let issuer: string;

	// A local OIDC discovery document, so authorize-params resolves the provider
	// without the network (the door hosts below are not real).
	beforeEach(async () => {
		server = createServer((req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				issuer,
				authorization_endpoint: `${issuer}/authorize`,
				token_endpoint: `${issuer}/token`,
				jwks_uri: `${issuer}/jwks.json`,
			}));
		});
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const address = server.address();
		assert.ok(address && typeof address === 'object', 'a TCP address');
		issuer = `http://127.0.0.1:${address.port}`;
	});

	afterEach(() => {
		server?.close();
		if (savedHosts === undefined) delete process.env.BLOCKS_PUBLIC_HOSTS;
		else process.env.BLOCKS_PUBLIC_HOSTS = savedHosts;
	});

	/** The gateway's own host: the `Host` a callback through any door reaches the Lambda with. */
	const GATEWAY_HOST = 'abc123.execute-api.us-east-1.amazonaws.com';

	/** Authorize at `authorizeOrigin` with `relayTo`, then call back at `callbackOrigin` with the signed state. */
	async function relayThrough(authorizeOrigin: string, relayTo: string, callbackOrigin: string) {
		const auth = new AuthOIDC(ROOT, unique('relay-hosts'), {
			providers: [customOidc({ name: 'p', issuerUrl: issuer, clientId: 'id', clientSecret: 'secret' })],
		});
		const params = await auth.getAuthorizeParams(freshContext(`${authorizeOrigin}/aws-blocks/auth/authorize-params/p`), 'p', {
			csrf: 'csrf-1',
			relayTo,
		});
		assert.ok(params.state, 'the relay flow returns a signed state');
		const callback = new URL(`${callbackOrigin}/aws-blocks/auth/callback`);
		callback.searchParams.set('code', 'auth-code');
		callback.searchParams.set('state', params.state);
		const ctx = freshContext(callback.href);
		ctx.request.headers.set('host', GATEWAY_HOST);
		return auth.handleCallbackDispatch(ctx);
	}

	test('authorized on the CloudFront domain, called back on the custom domain', async () => {
		process.env.BLOCKS_PUBLIC_HOSTS = 'd111.cloudfront.net,app.example.com';
		const result = await relayThrough('https://d111.cloudfront.net', 'https://d111.cloudfront.net/signed-in', 'https://app.example.com');
		assert.strictEqual(result.kind, 'relay', JSON.stringify(result));
		assert.ok(result.kind === 'relay' && result.redirectTo.startsWith('https://d111.cloudfront.net/signed-in?'), JSON.stringify(result));
	});

	test('authorized on a subdomain of a wildcard alias', async () => {
		process.env.BLOCKS_PUBLIC_HOSTS = 'd111.cloudfront.net,*.tenant.example.com,app.example.com';
		const result = await relayThrough('https://a.tenant.example.com', 'https://a.tenant.example.com/signed-in', 'https://app.example.com');
		assert.strictEqual(result.kind, 'relay', JSON.stringify(result));
	});

	test("authorized on the gateway's execute-api URL, called back on a CloudFront door", async () => {
		// No BLOCKS_API_URL: backend compute doesn't get one. The callback's Host is the gateway's.
		process.env.BLOCKS_PUBLIC_HOSTS = 'app.example.com';
		const gateway = `https://${GATEWAY_HOST}`;
		const result = await relayThrough(`${gateway}/prod`, `${gateway}/prod/signed-in`, 'https://app.example.com');
		assert.strictEqual(result.kind, 'relay', JSON.stringify(result));
	});
});

// ── Route error redaction ─────────────────────────────────────────────────────
//
// The auth RawRoutes catch their own errors, so core's RawRoute sanitizer never
// sees them. An unbranded error (an `onSignIn` hook's driver error, an SSM/SDK
// failure) must collapse to a nameless generic 500 with the original logged
// server-side; an ApiError or a branded Building Block error keeps its status,
// name and message.

describe('auth routes never echo raw error text', () => {
	const RAW_DETAIL = 'User: arn:aws:sts::123456789012:assumed-role/BlocksRole/x is not authorized to perform: ssm:GetParameter';

	// Every route-facing AuthOIDC method throws `failure`, so each route's catch is
	// exercised directly. The callback route's second catch (server-initiated
	// exchange) is reached by dispatching to 'server-exchange' first.
	class FailingAuth extends AuthOIDC {
		failure: unknown = new Error('unset');
		dispatchFails = true;
		override async handleCallbackDispatch(): Promise<{ kind: 'server-exchange' }> {
			if (this.dispatchFails) throw this.failure;
			return { kind: 'server-exchange' };
		}
		override async handleCallback(): Promise<never> {
			throw this.failure;
		}
		override async getSignInUrl(): Promise<never> {
			throw this.failure;
		}
		override async handleExchange(): Promise<never> {
			throw this.failure;
		}
		override async getAuthorizeParams(): Promise<never> {
			throw this.failure;
		}
		override async refreshBearerTokens(): Promise<never> {
			throw this.failure;
		}
	}

	const VALID_CSRF = 'c'.repeat(32);
	type RouteCase = { label: string; method: string; path: string; body?: unknown; rawBody?: string; dispatchFails?: boolean };
	const routeCases: RouteCase[] = [
		{ label: 'callback (dispatch)', method: 'GET', path: '/aws-blocks/auth/callback' },
		{ label: 'callback (server exchange)', method: 'GET', path: '/aws-blocks/auth/callback', dispatchFails: false },
		{ label: 'signin', method: 'GET', path: '/aws-blocks/auth/signin/google' },
		{
			label: 'exchange',
			method: 'POST',
			path: '/aws-blocks/auth/exchange',
			body: { code: 'c', verifier: 'v', state: 's', provider: 'google', callbackUrl: 'http://localhost:3000/aws-blocks/auth/callback' },
		},
		{ label: 'authorize-params GET', method: 'GET', path: '/aws-blocks/auth/authorize-params/google' },
		{ label: 'authorize-params POST', method: 'POST', path: '/aws-blocks/auth/authorize-params/google', body: { csrf: VALID_CSRF } },
		{ label: 'refresh', method: 'POST', path: '/aws-blocks/auth/refresh', body: { refreshToken: 'r', provider: 'google' } },
	];

	function setup(failure: unknown) {
		const errors: unknown[] = [];
		const logger: ChildLogger = {
			debug() {},
			info() {},
			warn() {},
			error(message, context) {
				// inspect() renders an Error's message, as the real logger does; JSON.stringify drops it.
				errors.push(inspect({ message, context }));
			},
			child: () => logger,
		};
		const auth = new FailingAuth(ROOT, unique('route-redact'), {
			providers: [stubIdp({ name: 'google' })],
			allowBearerAuth: true,
			logger,
		});
		auth.failure = failure;
		return { auth, errors };
	}

	async function invoke(auth: FailingAuth, c: RouteCase) {
		auth.dispatchFails = c.dispatchFails ?? true;
		const route = getRegisteredRoutes().find((r) => r.method === c.method && r.path === c.path);
		assert.ok(route, `route ${c.method} ${c.path} should be mounted`);
		let status = 200;
		let sent: unknown;
		const ctx = {
			request: {
				headers: new Headers(),
				body: null,
				// `rawBody` reproduces the runtime's `JSON.parse(bodyText)` on a malformed body.
				json: async () => (c.rawBody !== undefined ? JSON.parse(c.rawBody) : c.body),
				text: async () => c.rawBody ?? JSON.stringify(c.body ?? null),
				url: new URL(`http://localhost:3000${c.path}?code=x&state=y`),
				params: {},
			},
			response: {
				headers: new Headers(),
				get status() { return status; },
				set status(v: number) { status = v; },
				send: (b: unknown) => { sent = b; },
			},
		} as unknown as BlocksContext;
		await route.handler(ctx);
		return { status, body: sent as { error?: string; name?: string } };
	}

	for (const c of routeCases) {
		test(`${c.label}: an unbranded error becomes a nameless generic 500 and is logged`, async () => {
			const { auth, errors } = setup(new Error(RAW_DETAIL));
			const { status, body } = await invoke(auth, c);
			assert.strictEqual(status, 500);
			assert.deepStrictEqual(body, { error: 'Internal error' });
			assert.ok(JSON.stringify(errors).includes(RAW_DETAIL), 'the original error is logged server-side');
		});

		test(`${c.label}: an ApiError keeps its status, name and message`, async () => {
			const { auth } = setup(new ApiError('Sign-in is disabled for this account', 403, { name: 'SignInBlockedException' }));
			const { status, body } = await invoke(auth, c);
			assert.strictEqual(status, 403);
			assert.deepStrictEqual(body, { error: 'Sign-in is disabled for this account', name: 'SignInBlockedException' });
		});

		test(`${c.label}: a branded Building Block error keeps its name and message as a 400`, async () => {
			const branded = blocksError(AuthOIDCErrors.InvalidState, 'state mismatch');
			const { auth } = setup(branded);
			const { status, body } = await invoke(auth, c);
			assert.strictEqual(status, 400);
			assert.deepStrictEqual(body, { error: branded.message, name: AuthOIDCErrors.InvalidState });
		});
	}

	for (const path of ['/aws-blocks/auth/exchange', '/aws-blocks/auth/refresh']) {
		test(`${path}: a malformed JSON body is a 400 for missing fields, not a 500`, async () => {
			const { auth } = setup(new Error('unreachable'));
			const { status, body } = await invoke(auth, { label: 'malformed', method: 'POST', path, rawBody: '{not json' });
			assert.strictEqual(status, 400);
			assert.match(String(body.error), /Missing required fields/);
		});
	}

	// A failed Cognito token exchange throws a branded engine error whose response body rides
	// only on the non-enumerable `cause`. The body must stay off the wire but reach the log.
	const TOKEN_BODY = '{"error":"invalid_client","error_description":"Client 123456789012 rejected"}';
	for (const c of routeCases.filter((rc) => rc.label === 'exchange' || rc.label === 'callback (server exchange)')) {
		test(`${c.label}: a branded error's cause is logged server-side and kept out of the response`, async () => {
			const failure = withCause(blocksError('AuthOIDCEngineError', 'CognitoFederationEngine: Cognito token exchange failed (HTTP 400)'), new Error(TOKEN_BODY));
			const { auth, errors } = setup(failure);
			const { status, body } = await invoke(auth, c);
			assert.strictEqual(status, 400);
			assert.ok(!JSON.stringify(body).includes('123456789012'), `response must not carry the token-endpoint body: ${JSON.stringify(body)}`);
			assert.ok(JSON.stringify(errors).includes('invalid_client'), 'the token-endpoint body is logged server-side');
		});
	}
});
