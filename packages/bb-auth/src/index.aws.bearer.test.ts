// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS runtime — `allowBearerAuth` (D6c), offline.
 *
 * - **Pool users**: a Cognito access token, verified for real by
 *   `aws-jwt-verify` against a locally generated RS256 JWKS (the harness's
 *   `FakeIdp`, pre-loaded with `cacheJwks()` — no JWKS fetch): native client and
 *   hosted-UI client accepted; every other token refused with 401
 *   `NotAuthenticatedException` and no `$metadata` / ARN / account id.
 *   `requireRole` reads live groups (`AdminListGroupsForUser`).
 * - **Direct-OIDC users** on the AWS entry's direct engine (HTTPS only): the
 *   IdP's discovery and JWKS answered by a stubbed `fetch`.
 * - Off by default; cookie-before-bearer precedence.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ApiError, type BlocksContext, clearRouteRegistry } from '@aws-blocks/core';
import { SignJWT } from 'jose';
import { federationConfigKeys } from './cdk/contract.js';
import { Auth, AuthErrors } from './index.aws.js';
import {
	Browser,
	makeAwsAuth,
	signInAs,
	TEST_CLIENT_ID,
	TEST_POOL_ID,
	TEST_REGION,
} from './test-support/aws-harness.js';
import { FakeIdp as OidcIdp } from './test-support/fake-idp.js';

beforeEach(() => {
	clearRouteRegistry();
	rmSync('.bb-data', { recursive: true, force: true });
});
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const ISSUER = `https://cognito-idp.${TEST_REGION}.amazonaws.com/${TEST_POOL_ID}`;
const HOSTED_UI_CLIENT_ID = 'd6chosteduiclient0000000';
const NOT_AUTHENTICATED = { name: AuthErrors.NotAuthenticated, status: 401, message: 'Authentication required' };

function withBearer(ctx: BlocksContext, token: string): BlocksContext {
	ctx.request.headers.set('authorization', `Bearer ${token}`);
	return ctx;
}

async function observe(p: Promise<unknown>): Promise<{ name: string; status: number; message: string }> {
	try {
		await p;
	} catch (e) {
		assert.ok(e instanceof ApiError, `an ApiError, got ${String(e)}`);
		const leaked = JSON.stringify({ message: e.message, name: e.name, own: { ...e } });
		assert.ok(!/\$metadata|arn:aws|\d{12}/.test(leaked), `no service metadata on the wire: ${leaked}`);
		return { name: e.name, status: e.status, message: e.message };
	}
	assert.fail('expected a rejection');
}

function b64(v: unknown): string {
	return Buffer.from(JSON.stringify(v)).toString('base64url');
}

/** A Cognito-shaped access token payload. */
function accessClaims(username: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	const now = Math.floor(Date.now() / 1000);
	return {
		sub: `sub-${username}`,
		username,
		client_id: TEST_CLIENT_ID,
		token_use: 'access',
		scope: 'aws.cognito.signin.user.admin',
		auth_time: now,
		iss: ISSUER,
		iat: now,
		exp: now + 3600,
		jti: crypto.randomUUID(),
		...extra,
	};
}

/** The harness `Auth` with `allowBearerAuth`, its access-token verifier pre-loaded with the fake JWKS. */
function makeBearerAuth(options: { hostedUi?: boolean; allowBearerAuth?: boolean } = {}) {
	const h = makeAwsAuth({
		allowBearerAuth: options.allowBearerAuth ?? true,
		users: { groups: ['admins'] },
		...(options.hostedUi ? { socialProviders: { google: { clientId: 'g', clientSecret: secretRef() } } } : {}),
	});
	if (options.hostedUi) process.env[federationConfigKeys(h.fullId).HOSTED_UI_CLIENT_ID] = HOSTED_UI_CLIENT_ID;
	const poolBearer: unknown = Reflect.get(h.auth, 'poolBearer');
	if (options.allowBearerAuth !== false) {
		assert.ok(typeof poolBearer === 'object' && poolBearer !== null, 'the AWS layer wires a pool verifier');
		Reflect.get(poolBearer, 'verifier').cacheJwks(h.idp.jwks);
	} else {
		assert.strictEqual(poolBearer, undefined, 'no verifier without allowBearerAuth');
	}
	return h;
}

/** A `SecretRef`-shaped value (never read in these tests). */
function secretRef() {
	return { fullId: 'd6c-unused-secret', get: async () => 'unused' };
}

describe('AWS allowBearerAuth — Cognito access tokens (pool users)', () => {
	test('a native-client access token is accepted, with the cookie session’s identity', async () => {
		const h = makeBearerAuth();
		const token = h.idp.sign(accessClaims('alice', { 'cognito:groups': ['admins'] }));
		const user = await h.auth.requireAuth(withBearer(new Browser().context(), token));
		assert.deepStrictEqual(
			{
				userId: user.userId,
				username: user.username,
				userSub: user.userSub,
				signInProvider: user.signInProvider,
			},
			{ userId: 'alice', username: 'alice', userSub: 'sub-alice', signInProvider: 'password' },
		);
		assert.deepStrictEqual(user.groups, ['admins'], 'the token’s cognito:groups snapshot');
		assert.deepStrictEqual(h.sent, [], 'no Cognito call to authenticate a bearer request');

		const ctx = withBearer(new Browser().context(), token);
		assert.strictEqual(await h.auth.checkAuth(ctx), true);
		assert.deepStrictEqual(await h.auth.getAuthSession(ctx), { tokens: undefined, userSub: 'sub-alice' });
		// `{ fresh: true }`: the access token's auth_time (just now).
		assert.strictEqual(
			(await h.auth.requireAuth(withBearer(new Browser().context(), token), { fresh: true })).userId,
			'alice',
		);
	});

	test('requireRole reads live groups for a bearer pool user', async () => {
		const h = makeBearerAuth();
		const token = h.idp.sign(accessClaims('alice', { 'cognito:groups': ['admins'] }));
		h.on('AdminListGroupsForUserCommand', () => ({ Groups: [] }));
		assert.deepStrictEqual(
			(await observe(h.auth.requireRole(withBearer(new Browser().context(), token), 'admins'))).status,
			403,
			'the stale token claim is not trusted',
		);
		h.on('AdminListGroupsForUserCommand', () => ({ Groups: [{ GroupName: 'admins', UserPoolId: TEST_POOL_ID }] }));
		const user = await h.auth.requireRole(withBearer(new Browser().context(), token), 'admins');
		assert.deepStrictEqual(user.groups, ['admins']);
		assert.deepStrictEqual(h.sent.at(-1), {
			name: 'AdminListGroupsForUserCommand',
			input: { UserPoolId: TEST_POOL_ID, Username: 'alice' },
		});
	});

	test('a hosted-UI client access token is accepted, and names its federated provider', async () => {
		const h = makeBearerAuth({ hostedUi: true });
		const token = h.idp.sign(accessClaims('Google_1234567890', { client_id: HOSTED_UI_CLIENT_ID }));
		const user = await h.auth.requireAuth(withBearer(new Browser().context(), token));
		assert.strictEqual(user.userId, 'Google_1234567890');
		assert.strictEqual(user.signInProvider, 'google');
		const native = await h.auth.requireAuth(
			withBearer(new Browser().context(), h.idp.sign(accessClaims('Google_1', { client_id: TEST_CLIENT_ID }))),
		);
		assert.strictEqual(native.signInProvider, 'password', 'only the hosted-UI client implies federation');
	});

	test('rejections → 401 NotAuthenticated, no metadata: alg none, HS256, wrong client / issuer / key / token_use, expired', async () => {
		const h = makeBearerAuth();
		const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
		const claims = accessClaims('alice');
		const cases: Record<string, string> = {
			'alg: none': `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`,
			HS256: await new SignJWT(claims)
				.setProtectedHeader({ alg: 'HS256' })
				.sign(new TextEncoder().encode('a-shared-secret-anyone-could-guess-0123')),
			'wrong client': h.idp.sign(accessClaims('alice', { client_id: 'another-client' })),
			'hosted-UI client not configured': h.idp.sign(accessClaims('alice', { client_id: HOSTED_UI_CLIENT_ID })),
			'another pool': h.idp.sign(
				accessClaims('alice', { iss: `https://cognito-idp.${TEST_REGION}.amazonaws.com/us-east-1_Other` }),
			),
			'unpublished key': h.idp.sign(claims, other),
			'an ID token': h.idp.idToken('alice'),
			expired: h.idp.sign(accessClaims('alice', { exp: Math.floor(Date.now() / 1000) - 120 })),
			'not a JWT': 'opaque-token',
		};
		for (const [what, token] of Object.entries(cases)) {
			assert.deepStrictEqual(
				await observe(h.auth.requireAuth(withBearer(new Browser().context(), token))),
				NOT_AUTHENTICATED,
				what,
			);
			assert.strictEqual(await h.auth.getCurrentUser(withBearer(new Browser().context(), token)), null, what);
		}
		assert.deepStrictEqual(h.sent, [], 'no Cognito call for a rejected bearer');
	});

	test('off by default: a valid access token is ignored', async () => {
		const h = makeBearerAuth({ allowBearerAuth: false });
		const token = h.idp.sign(accessClaims('alice'));
		assert.deepStrictEqual(
			await observe(h.auth.requireAuth(withBearer(new Browser().context(), token))),
			NOT_AUTHENTICATED,
		);
		assert.strictEqual(await h.auth.checkAuth(withBearer(new Browser().context(), token)), false);
	});

	test('precedence: the cookie session wins over a bearer token for another user', async () => {
		const h = makeBearerAuth();
		const b = new Browser();
		await signInAs(h, b, 'alice');
		const bobToken = h.idp.sign(accessClaims('bob'));
		const user = await b.request((ctx) => h.auth.requireAuth(ctx), withBearer(b.context(), bobToken));
		assert.strictEqual(user.userId, 'alice');
		// No cookie → the bearer.
		assert.strictEqual((await h.auth.requireAuth(withBearer(new Browser().context(), bobToken))).userId, 'bob');
	});
});

describe('AWS allowBearerAuth — direct OIDC (HTTPS issuer, stubbed discovery + JWKS)', () => {
	const idp = new OidcIdp();
	const HTTPS_ISSUER = 'https://idp.d6c.example/tenant';
	const realFetch = globalThis.fetch;
	let jwksFetches = 0;
	before(async () => {
		await idp.start();
		globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			if (url === `${HTTPS_ISSUER}/.well-known/openid-configuration`) {
				return Response.json({
					issuer: HTTPS_ISSUER,
					authorization_endpoint: `${HTTPS_ISSUER}/authorize`,
					token_endpoint: `${HTTPS_ISSUER}/token`,
					jwks_uri: `${HTTPS_ISSUER}/jwks`,
				});
			}
			if (url === `${HTTPS_ISSUER}/jwks`) {
				jwksFetches++;
				return Response.json(idp.jwksDocument);
			}
			return realFetch(input, init);
		};
	});
	after(async () => {
		globalThis.fetch = realFetch;
		await idp.close();
	});

	let n = 0;
	function makeDirectAuth() {
		return new Auth({ id: `d6caws${process.pid}x${++n}` }, 'auth', {
			emailPassword: false,
			allowBearerAuth: true,
			oidcProviders: { okta: { issuer: HTTPS_ISSUER, clientId: 'client-1', groupsClaim: 'groups' } },
			users: { groups: ['admins'] },
		});
	}

	function ctxWith(token: string): BlocksContext {
		return withBearer(new Browser().context(), token);
	}

	test('the IdP access token is accepted (Q1 identity, groupsClaim) and its JWKS is fetched once', async () => {
		const auth = makeDirectAuth();
		const token = await idp.accessJwt('user-1', {
			issuer: HTTPS_ISSUER,
			claims: { groups: ['admins'], name: 'Ada' },
		});
		const user = await auth.requireRole(ctxWith(token), 'admins');
		assert.strictEqual(user.userId, `${HTTPS_ISSUER}:user-1`);
		assert.strictEqual(user.username, 'Ada');
		assert.strictEqual(user.signInProvider, 'okta');
		await auth.requireAuth(ctxWith(token));
		assert.strictEqual(jwksFetches, 1, 'the JWKS is cached');
	});

	test('wrong audience / issuer / key, expired, alg none, HS256 → 401 NotAuthenticated', async () => {
		const auth = makeDirectAuth();
		const now = Math.floor(Date.now() / 1000);
		const claims = { iss: HTTPS_ISSUER, sub: 'user-1', aud: 'client-1', iat: now, exp: now + 3600 };
		const cases: Record<string, string> = {
			'wrong audience': await idp.accessJwt('user-1', { issuer: HTTPS_ISSUER, audience: 'other' }),
			'wrong issuer': await idp.accessJwt('user-1', { issuer: 'https://evil.example/tenant' }),
			'unpublished key': await idp.accessJwt('user-1', { issuer: HTTPS_ISSUER, foreignKey: true }),
			expired: await idp.accessJwt('user-1', { issuer: HTTPS_ISSUER, expiresIn: -120 }),
			'alg: none': `${b64({ alg: 'none' })}.${b64(claims)}.`,
			HS256: await new SignJWT(claims)
				.setProtectedHeader({ alg: 'HS256' })
				.sign(new TextEncoder().encode('a-shared-secret-anyone-could-guess-0123')),
		};
		for (const [what, token] of Object.entries(cases)) {
			assert.deepStrictEqual(await observe(auth.requireAuth(ctxWith(token))), NOT_AUTHENTICATED, what);
		}
	});
});

describe('AWS allowBearerAuth — the mock verifier is unreachable by construction', () => {
	test('nothing the aws-runtime entry imports (transitively) is bearer-mock.js, the mock engine or the stub IdP', () => {
		const dist = dirname(fileURLToPath(import.meta.url));
		const seen = new Set<string>();
		/** Every `import('./x.js')` in the static graph: `[importing file, target]`. */
		const dynamic: Array<[string, string]> = [];
		const walk = (file: string): void => {
			if (seen.has(file)) return;
			seen.add(file);
			const source = readFileSync(join(dist, file), 'utf8');
			// `./x.js` and `../x.js` alike: the engines import their siblings' parents.
			for (const m of source.matchAll(/(?:from|import)\s*['"](\.\.?\/[^'"]+)['"]/g)) {
				walk(join(dirname(file), m[1]));
			}
			// Code only: a comment may quote an import.
			const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
			for (const m of code.matchAll(/\bimport\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)) {
				dynamic.push([file, join(dirname(file), m[1])]);
			}
		};
		walk('index.aws.js');
		assert.ok(seen.has('bearer-cognito.js'), 'the graph walk sees the AWS verifier');
		assert.ok(seen.has('errors.js'), 'the graph walk follows `../` imports out of engines/');
		assert.ok(seen.has('engines/stub-idp-routes.js'), 'the graph walk sees the stub route table');
		// The stub IdP signs anyone in through its account picker: a normal
		// deployed backend must never load it (local dev only, unless opted in).
		// FX43: the Cognito engine shares the local engine's schema-independent
		// attribute rules through a pure module, not through the mock's.
		assert.ok(seen.has('engines/attribute-write-rules.js'), 'the graph walk sees the shared attribute rules');
		for (const forbidden of [
			'bearer-mock.js',
			'engines/native-mock.js',
			'engines/stub-idp.js',
			'engines/mock-attribute-schema.js',
			'engines/native-mock-store.js',
		]) {
			assert.ok(!seen.has(forbidden), `index.aws.js must not reach ${forbidden}`);
		}
		// FX8: the one way in is a lazy import, from index.aws.js, inside
		// `deployedStubIdp()` — which runs only for `unsafeAllowDeployed` providers.
		assert.deepStrictEqual(dynamic, [['index.aws.js', 'engines/stub-idp.js']], 'the only dynamic import');
		const entry = readFileSync(join(dist, 'index.aws.js'), 'utf8');
		const importAt = entry.indexOf("import('./engines/stub-idp.js')");
		const fnAt = entry.lastIndexOf('function deployedStubIdp(', importAt);
		assert.ok(fnAt >= 0 && entry.indexOf('\n}\n', fnAt) > importAt, 'the import sits inside deployedStubIdp()');
		const calls = [...entry.matchAll(/deployedStubIdp\(/g)].length;
		assert.strictEqual(calls, 2, 'deployedStubIdp is defined once and called once');
		assert.match(
			entry,
			/stubAllowsDeployment\(provider\.config\.stubIdp\)\s*\?\s*deployedStubIdp\(/,
			'…and called only when the provider opted in',
		);
	});
});
