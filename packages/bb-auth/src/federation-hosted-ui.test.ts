// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The hosted-UI federation engine (D6b) against an in-process fake Cognito
 * domain over real HTTP (`test-support/fake-cognito.ts`: authorize, token,
 * revoke, logout, JWKS). Proves:
 *
 * - the authorize URL (domain, hosted-UI client, PKCE S256, `state` in the
 *   shared pending cookie, `identity_provider` per provider — Apple, SAML and
 *   Cognito-federated OIDC selected by provider id);
 * - `state` / PKCE / callback validation, and every ID-token check (tampered,
 *   expired, foreign audience, foreign pool, another IdP) with the real
 *   `aws-jwt-verify` verifier fetching the fake's JWKS;
 * - refresh (`/oauth2/token`), revocation (`/oauth2/revoke`), the `/logout` URL;
 * - a full sign-in through the real routes of the AWS entry → a pool session →
 *   `requireAuth` / `requireRole` (live groups) → sign-out `303` to Cognito's
 *   `/logout` → the GET landing → `postSignOutPath`, and that the managed-login
 *   cookie is gone afterwards (no silent re-authentication); no MFA path;
 * - a mixed configuration (password + direct OIDC + hosted-UI social): all
 *   three reachable, each signing out correctly;
 * - pool-less safety: no config keys → a clear refusal, never a request;
 * - decision Q10: a federated **first** sign-in runs `validateUser` in the
 *   pool's PreSignUp trigger (the fake plays Cognito, invoking core's real
 *   Lambda handler); a rejection reaches the browser as the canonical error.
 *
 * No AWS call is made: the Cognito SDK client is intercepted, and the JWKS
 * fetcher is pointed at the fake.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import {
	ApiError,
	type BlocksContext,
	clearRouteRegistry,
	isBlocksError,
	registerSdkIdentifiers,
	Scope,
	unlockRouteRegistry,
} from '@aws-blocks/core';
import { createLambdaHandler } from '@aws-blocks/core/lambda-handler';
import { resolveProviders } from './auth-base.js';
import { cognitoConfigKeys, federationConfigKeys } from './cdk/contract.js';
import { DirectFederationEngine } from './engines/federation-direct.js';
import { HostedUiFederationEngine, hostedUiBaseUrl } from './engines/federation-hosted-ui.js';
import { idpRefusedMessage } from './engines/idp-callback-error.js';
import type { EngineHost, FederatedIdentity, FederationEngine, ResolvedProvider } from './engines/types.js';
import { AuthErrors } from './errors.js';
import { Auth as AwsAuth } from './index.aws.js';
import { captureLogger, TEST_SECRET } from './test-helpers.js';
import { simulateTriggerConfig } from './test-support/aws-harness.js';
import {
	FAKE_HOSTED_UI_CLIENT_ID,
	FAKE_NATIVE_CLIENT_ID,
	FAKE_POOL_ID,
	FAKE_REGION,
	FakeCognito,
	type FakeTokenOverrides,
	MANAGED_LOGIN_COOKIE,
} from './test-support/fake-cognito.js';
import { FakeIdp } from './test-support/fake-idp.js';
import { location, type RouteServer, startRouteServer, TestBrowser } from './test-support/route-server.js';
import { encodeTriggerRejection } from './trigger-rejection.js';
import type { AppSettingRef, AuthOptions, UserCandidate } from './types.js';

const secret: AppSettingRef = { fullId: 'provider-secret', get: async () => 's3cret' };
const cognito = new FakeCognito();
let server: RouteServer;
let counter = 0;

before(async () => {
	delete process.env.BLOCKS_PUBLIC_ORIGIN;
	await cognito.start();
	server = await startRouteServer();
});
after(async () => {
	await server.close();
	await cognito.close();
});
beforeEach(() => {
	clearRouteRegistry();
	cognito.reset();
	rmSync('.bb-data', { recursive: true, force: true });
});
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

/** Point the fake at this test's front door (D3b registers exactly these). */
function registerFrontDoor(origin: string, signOutPath = '/aws-blocks/auth/signout') {
	cognito.callbackUrls = [`${origin}/aws-blocks/auth/callback`];
	cognito.logoutUrls = [`${origin}${signOutPath}`];
}

/** Set every config key the CDK layer registers in a hosted-UI configuration. */
function setConfigKeys(fullId: string, opts: { hostedUi?: boolean } = {}) {
	const pool = cognitoConfigKeys(fullId);
	process.env[pool.USER_POOL_ID] = FAKE_POOL_ID;
	process.env[pool.CLIENT_ID] = FAKE_NATIVE_CLIENT_ID;
	process.env[pool.REGION] = FAKE_REGION;
	const fed = federationConfigKeys(fullId);
	if (opts.hostedUi === false) {
		delete process.env[fed.DOMAIN];
		delete process.env[fed.HOSTED_UI_CLIENT_ID];
	} else {
		process.env[fed.DOMAIN] = cognito.origin;
		process.env[fed.HOSTED_UI_CLIENT_ID] = FAKE_HOSTED_UI_CLIENT_ID;
	}
}

/** Point an engine's JWKS fetches at the fake's JWKS endpoint, recording what was asked for. */
function routeJwksToFake(engine: HostedUiFederationEngine) {
	const cache: unknown = Reflect.get(engine, 'jwksCache');
	assert.ok(typeof cache === 'object' && cache !== null);
	Reflect.set(cache, 'fetcher', {
		fetch: async (uri: string) => {
			cognito.jwksFetches.push(uri);
			const res = await fetch(`${cognito.origin}/${FAKE_POOL_ID}/.well-known/jwks.json`);
			return res.arrayBuffer();
		},
	});
}

function ctxFor(url: string, cookie?: string): BlocksContext {
	const u = new URL(url);
	const headers = new Headers({ host: u.host });
	if (cookie) headers.set('cookie', cookie);
	return {
		request: { headers, body: null, json: async () => ({}), text: async () => '', url: u, params: {} },
		response: { headers: new Headers(), status: 200, send: () => {} },
	};
}

function pendingCookie(ctx: BlocksContext): string {
	const line = ctx.response.headers.getSetCookie().find((l) => l.startsWith('authpending_'));
	assert.ok(line, 'the sign-in sets the pending-auth cookie');
	return line.split(';')[0];
}

function rejectsWith(name: string, status?: number) {
	return (e: unknown) => {
		assert.ok(e instanceof ApiError, `an ApiError (got ${String(e)})`);
		assert.ok(isBlocksError(e, name), `named ${name} (got ${e.name}: ${e.message})`);
		if (status !== undefined) assert.strictEqual(e.status, status);
		return true;
	};
}

const APP = 'http://127.0.0.1:3998';

/** What an attacker would like the app to answer with (R2-2). */
const ATTACKER_TEXT = 'Your account is suspended. Call +1-555-0100 to restore it.';
const FORGED_REJECTION = encodeTriggerRejection(new ApiError(ATTACKER_TEXT, 451, { name: 'AccountSuspended' }));

const providersConfig = (): AuthOptions => ({
	socialProviders: {
		google: { clientId: 'g', clientSecret: secret },
		apple: { clientId: 'com.example.web', teamId: 'TEAM123456', keyId: 'KEY1234567', privateKey: secret },
	},
	oidcProviders: {
		entra: { issuer: 'https://login.example.com', clientId: 'e', clientSecret: secret, federateVia: 'cognito' },
		okta: { issuer: 'https://okta.example.com', clientId: 'o' },
	},
	samlProviders: { acme: { metadataUrl: 'https://acme.example.com/metadata.xml' } },
});

/** A hosted-UI engine over a bare scope (engine-level tests). */
function makeEngine(providerId: string, options: AuthOptions = providersConfig(), keys = true) {
	const { logger, entries } = captureLogger();
	const scope = new Scope('auth', { parent: { id: `hui${process.pid}x${++counter}` } });
	setConfigKeys(scope.fullId, { hostedUi: keys });
	// The native engine registers the pool id; stand in for it.
	if (keys) registerSdkIdentifiers(scope.fullId, { userPoolId: FAKE_POOL_ID });
	const host: EngineHost = {
		scope,
		userAgentChain: () => [],
		options,
		log: logger,
		sessionSecret: async () => TEST_SECRET,
	};
	const provider = resolveProviders(options).find((p) => p.id === providerId);
	assert.ok(provider, providerId);
	const engine = new HostedUiFederationEngine(host, provider);
	routeJwksToFake(engine);
	return { engine, entries, scope };
}

/** Server-initiated sign-in at the engine level: authorize at the fake, then complete. */
async function engineSignIn(engine: HostedUiFederationEngine): Promise<FederatedIdentity> {
	registerFrontDoor(APP);
	const start = ctxFor(`${APP}/aws-blocks/auth/signin/x`);
	const authorizeUrl = await engine.buildSignInUrl(start, {});
	const res = await fetch(authorizeUrl, { redirect: 'manual' });
	assert.strictEqual(res.status, 302, `authorize answered ${res.status}: ${await res.clone().text()}`);
	const callback = res.headers.get('location') ?? '';
	return engine.completeSignIn(ctxFor(callback, pendingCookie(start)));
}

function scriptUsers() {
	cognito.supportedProviders = ['Google', 'SignInWithApple', 'entra', 'acme'];
	cognito.users = new Map([
		['Google', { idpSub: '1001', email: 'ada@example.com', name: 'Ada', groups: ['admin'] }],
		['SignInWithApple', { idpSub: '2002', email: 'bob@privaterelay.example' }],
		['entra', { idpSub: '3003', email: 'cy@corp.example' }],
		['acme', { idpSub: 'cy@acme.example', email: 'cy@acme.example' }],
	]);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('HostedUiFederationEngine — the authorize URL', () => {
	test('managed login on the domain, hosted-UI client, code + PKCE S256, state in the pending cookie', async () => {
		const { engine } = makeEngine('google');
		const start = ctxFor(`${APP}/aws-blocks/auth/signin/google`);
		const url = new URL(await engine.buildSignInUrl(start, { redirectPath: '/home', state: 'app-1' }));
		assert.strictEqual(`${url.origin}${url.pathname}`, `${cognito.origin}/oauth2/authorize`);
		const p = url.searchParams;
		assert.strictEqual(p.get('response_type'), 'code');
		assert.strictEqual(p.get('client_id'), FAKE_HOSTED_UI_CLIENT_ID, 'the hosted-UI client, never the native one');
		assert.strictEqual(p.get('redirect_uri'), `${APP}/aws-blocks/auth/callback`);
		assert.strictEqual(p.get('scope'), 'openid email profile');
		assert.strictEqual(p.get('identity_provider'), 'Google', 'straight to the IdP');
		assert.strictEqual(p.get('code_challenge_method'), 'S256');
		assert.match(p.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/);
		assert.match(p.get('state') ?? '', /^[A-Za-z0-9_-]{43}$/);
		assert.strictEqual(p.get('nonce'), null);
		const cookie = pendingCookie(start);
		assert.match(cookie, /^authpending_/, 'the shared pending-auth cookie (one callback route for every engine)');
	});

	test('identity_provider is the Cognito provider name, selected by provider id (Apple, SAML, cognito-OIDC)', async () => {
		const expected: Record<string, string> = {
			google: 'Google',
			apple: 'SignInWithApple',
			acme: 'acme',
			entra: 'entra',
		};
		for (const [id, name] of Object.entries(expected)) {
			const { engine } = makeEngine(id);
			assert.strictEqual(engine.providerName, name);
			const url = new URL(await engine.buildSignInUrl(ctxFor(`${APP}/x`), {}));
			assert.strictEqual(url.searchParams.get('identity_provider'), name, id);
		}
	});

	test('the AWS entry builds a hosted-UI engine per hosted provider and a direct one for the rest', () => {
		const scope = { id: `sel${process.pid}x${++counter}` };
		setConfigKeys(`${scope.id}-auth`);
		const auth = new AwsAuth(scope, 'auth', providersConfig());
		const providers: Map<string, { provider: ResolvedProvider; engine: FederationEngine }> = Reflect.get(
			auth,
			'providers',
		);
		const kinds = Object.fromEntries(
			[...providers].map(([id, { engine }]) => [
				id,
				engine instanceof HostedUiFederationEngine
					? `hosted-ui:${engine.providerName}`
					: engine instanceof DirectFederationEngine
						? 'direct'
						: 'other',
			]),
		);
		assert.deepStrictEqual(kinds, {
			google: 'hosted-ui:Google',
			apple: 'hosted-ui:SignInWithApple',
			entra: 'hosted-ui:entra',
			okta: 'direct',
			acme: 'hosted-ui:acme',
		});
	});

	test('a redirectPath must be same-origin', async () => {
		const { engine } = makeEngine('google');
		await assert.rejects(
			engine.buildSignInUrl(ctxFor(`${APP}/x`), { redirectPath: '//evil.example' }),
			rejectsWith(AuthErrors.InvalidParameter, 400),
		);
		// A browser strips the TAB and lands on `//evil.example`; a dot segment collapses the same way.
		for (const redirectPath of ['/\t/evil.example', '/.//evil.example', 'javascript:alert(1)']) {
			await assert.rejects(
				engine.buildSignInUrl(ctxFor(`${APP}/x`), { redirectPath }),
				rejectsWith(AuthErrors.InvalidParameter, 400),
				JSON.stringify(redirectPath),
			);
		}
	});

	test('the domain value: a bare host is https; http only for loopback; anything else refused', () => {
		assert.strictEqual(
			hostedUiBaseUrl('app-1a2b.auth.us-east-1.amazoncognito.com'),
			'https://app-1a2b.auth.us-east-1.amazoncognito.com',
		);
		assert.strictEqual(hostedUiBaseUrl('https://auth.example.com'), 'https://auth.example.com');
		assert.strictEqual(hostedUiBaseUrl('http://127.0.0.1:4000'), 'http://127.0.0.1:4000');
		assert.strictEqual(hostedUiBaseUrl('http://auth.example.com'), undefined);
		assert.strictEqual(hostedUiBaseUrl('https://auth.example.com/path'), undefined);
		assert.strictEqual(hostedUiBaseUrl('ftp://auth.example.com'), undefined);
	});
});

describe('HostedUiFederationEngine — completing the sign-in', () => {
	beforeEach(scriptUsers);

	test('a pool identity with verified Cognito tokens (JWKS fetched from the pool)', async () => {
		const { engine } = makeEngine('google');
		const identity = await engineSignIn(engine);
		assert.strictEqual(identity.kind, 'pool');
		assert.ok(identity.kind === 'pool');
		assert.ok(identity.tokens.idToken && identity.tokens.accessToken && identity.tokens.refreshToken);
		assert.deepStrictEqual(cognito.jwksFetches, [cognito.jwksUri], "the pool's own JWKS, nothing else");
		const token = cognito.requests.find((r) => r.path === '/oauth2/token');
		assert.ok(token);
		assert.strictEqual(token.form.get('grant_type'), 'authorization_code');
		assert.strictEqual(token.form.get('client_id'), FAKE_HOSTED_UI_CLIENT_ID);
		assert.strictEqual(token.form.get('client_secret'), null, 'a public client: PKCE binds the code');
		assert.ok(token.form.get('code_verifier'));
	});

	test('Apple, SAML and cognito-OIDC complete through the same path', async () => {
		for (const id of ['apple', 'acme', 'entra']) {
			const { engine } = makeEngine(id);
			const identity = await engineSignIn(engine);
			assert.strictEqual(identity.kind, 'pool', id);
		}
	});

	test('state: a mismatched state, a missing cookie, another provider’s callback are refused', async () => {
		registerFrontDoor(APP);
		const { engine } = makeEngine('google');
		const start = ctxFor(`${APP}/s`);
		const url = new URL(await engine.buildSignInUrl(start, {}));
		const state = url.searchParams.get('state') ?? '';
		const cookie = pendingCookie(start);
		const cb = (q: string, c?: string) => ctxFor(`${APP}/aws-blocks/auth/callback?${q}`, c);
		await assert.rejects(
			engine.completeSignIn(cb(`code=x&state=${encodeURIComponent(`${state}x`)}`, cookie)),
			rejectsWith(AuthErrors.InvalidState, 400),
		);
		await assert.rejects(
			engine.completeSignIn(cb(`code=x&state=${state}`)),
			rejectsWith(AuthErrors.InvalidCallback),
		);
		await assert.rejects(
			engine.completeSignIn(cb(`state=${state}`, cookie)),
			rejectsWith(AuthErrors.InvalidCallback),
		);
		// Another provider of the same block (same pending cookie name).
		const appleProvider = resolveProviders(providersConfig()).find((p) => p.id === 'apple');
		assert.ok(appleProvider);
		const apple = new HostedUiFederationEngine(Reflect.get(engine, 'host'), appleProvider);
		await assert.rejects(
			apple.completeSignIn(cb(`code=x&state=${state}`, cookie)),
			rejectsWith(AuthErrors.InvalidState),
		);
	});

	test('R2-2: an error callback is honoured only with the pending state — anything else is InvalidState', async () => {
		registerFrontDoor(APP);
		const { engine } = makeEngine('google');
		const start = ctxFor(`${APP}/s`);
		const url = new URL(await engine.buildSignInUrl(start, {}));
		const state = url.searchParams.get('state') ?? '';
		const cookie = pendingCookie(start);
		const cb = (q: string) => ctxFor(`${APP}/aws-blocks/auth/callback?${q}`, cookie);
		const forged = `error=invalid_request&error_description=${encodeURIComponent(`PreSignUp failed with error ${FORGED_REJECTION}. `)}`;
		const plain = `error=access_denied&error_description=${encodeURIComponent(ATTACKER_TEXT)}`;
		const cases: Record<string, string> = {
			'a forged trigger rejection, no state': forged,
			'a forged trigger rejection, a wrong state': `${forged}&state=${encodeURIComponent(`${state}x`)}`,
			'a forged trigger rejection, an empty state': `${forged}&state=`,
			'an IdP error, no state': plain,
			'an IdP error, a wrong state': `${plain}&state=nope`,
		};
		for (const [why, query] of Object.entries(cases)) {
			await assert.rejects(engine.completeSignIn(cb(query)), (e: unknown) => {
				rejectsWith(AuthErrors.InvalidState, 400)(e);
				assert.ok(e instanceof Error && !e.message.includes('+1-555'), `${why}: no attacker text`);
				return true;
			});
		}
		// The genuine redirect (it carries the pending state) is still honoured.
		const genuine = encodeTriggerRejection(
			new ApiError('Corporate accounts only', 403, { name: AuthErrors.NotAuthorized }),
		);
		await assert.rejects(
			engine.completeSignIn(
				cb(
					`error=invalid_request&error_description=${encodeURIComponent(`PreSignUp failed with error ${genuine}. `)}&state=${encodeURIComponent(state)}`,
				),
			),
			rejectsWith(AuthErrors.NotAuthorized, 403),
		);
	});

	test('FX60: managed login’s own error text never reaches the client; it is logged at the right level', async () => {
		registerFrontDoor(APP);
		// What managed login sends: its own wording, an echoed request value, and
		// (for a trigger failure it could not decode) a function ARN.
		const cases = [
			{
				error: 'access_denied',
				description: 'Ada (ada@example.com) is not assigned to this application',
				level: 'info',
			},
			{ error: 'server_error', description: 'the identity provider is unavailable', level: 'error' },
			{
				error: 'invalid_request',
				description:
					'PreSignUp failed with error arn:aws:lambda:us-east-1:123456789012:function:app-presignup.',
				level: 'error',
			},
			{ error: 'invalid_scope', description: null, level: 'info' },
		] as const;
		for (const c of cases) {
			const { engine, entries } = makeEngine('google');
			const start = ctxFor(`${APP}/s`);
			const state = new URL(await engine.buildSignInUrl(start, {})).searchParams.get('state') ?? '';
			const query = [
				`error=${c.error}`,
				...(c.description === null ? [] : [`error_description=${encodeURIComponent(c.description)}`]),
				`state=${encodeURIComponent(state)}`,
			].join('&');
			await assert.rejects(
				engine.completeSignIn(ctxFor(`${APP}/aws-blocks/auth/callback?${query}`, pendingCookie(start))),
				(e: unknown) => {
					rejectsWith(AuthErrors.IdpError, 400)(e);
					assert.ok(e instanceof ApiError);
					assert.strictEqual(e.message, idpRefusedMessage('google'), c.error);
					// Neither the OAuth code nor Cognito's text is anywhere a client can read.
					const seen = `${e.message} ${JSON.stringify(e)}`;
					assert.ok(!seen.includes(c.error), `${c.error}: the OAuth code stays server-side`);
					if (c.description) assert.ok(!seen.includes(c.description), `${c.error}: no managed-login text`);
					return true;
				},
			);
			const line = entries.find((x) => x.message === '[bb-auth] managed login returned an error');
			assert.ok(line, `${c.error}: the detail is logged: ${JSON.stringify(entries)}`);
			assert.strictEqual(line.level, c.level, c.error);
			assert.strictEqual(line.context?.provider, 'google');
			assert.strictEqual(line.context?.error, c.error);
			assert.strictEqual(line.context?.description, c.description);
		}
	});

	test('FX7b: a state of another length or encoding is InvalidState, never a throw of its own', async () => {
		registerFrontDoor(APP);
		const { engine } = makeEngine('google');
		const start = ctxFor(`${APP}/s`);
		const state = new URL(await engine.buildSignInUrl(start, {})).searchParams.get('state') ?? '';
		const cookie = pendingCookie(start);
		for (const bad of [state.slice(0, -1), `${state}x`, `${state.slice(0, -1)}é`, 'é']) {
			await assert.rejects(
				engine.completeSignIn(
					ctxFor(`${APP}/aws-blocks/auth/callback?code=x&state=${encodeURIComponent(bad)}`, cookie),
				),
				rejectsWith(AuthErrors.InvalidState, 400),
			);
		}
	});

	test('a managed-login error is an IdpError with the fixed message; the description is logged (FX60)', async () => {
		cognito.authorizeError = 'invalid_request';
		const { engine, entries } = makeEngine('google');
		await assert.rejects(engineSignIn(engine), (e: unknown) => {
			assert.ok(isBlocksError(e, AuthErrors.IdpError));
			// FX60: Cognito's own `error` / `error_description` stay server-side.
			assert.strictEqual(e instanceof Error ? e.message : '', idpRefusedMessage('google'));
			return true;
		});
		const line = entries.find((x) => x.message === '[bb-auth] managed login returned an error');
		assert.ok(line, `the detail is logged: ${JSON.stringify(entries)}`);
		assert.strictEqual(line.context?.error, 'invalid_request');
		assert.strictEqual(line.context?.description, 'the IdP said no');
	});

	test('PKCE: the token endpoint checks the verifier; a wrong one is rejected', async () => {
		registerFrontDoor(APP);
		const { engine } = makeEngine('google');
		const authorizeUrl = await engine.buildSignInUrl(ctxFor(`${APP}/s`), {});
		const res = await fetch(authorizeUrl, { redirect: 'manual' });
		const code = new URL(res.headers.get('location') ?? '').searchParams.get('code') ?? '';
		await assert.rejects(
			engine.exchangeCode(ctxFor(`${APP}/x`), {
				code,
				codeVerifier: 'not-the-verifier-not-the-verifier-not-the-ver',
				redirectUri: `${APP}/aws-blocks/auth/callback`,
				nonce: '',
			}),
			rejectsWith(AuthErrors.IdpError, 400),
		);
	});

	const badTokens: [string, FakeTokenOverrides][] = [
		['tampered signature', { tamper: true }],
		['expired', { idTokenExpiresIn: -120 }],
		['issued to the native client', { audience: FAKE_NATIVE_CLIENT_ID }],
		['issued by another pool', { issuer: `https://cognito-idp.${FAKE_REGION}.amazonaws.com/us-east-1_Other` }],
	];
	for (const [what, overrides] of badTokens) {
		test(`an ID token ${what} is rejected (401 IdpError)`, async () => {
			cognito.overrides = { ...overrides };
			const { engine } = makeEngine('google');
			await assert.rejects(engineSignIn(engine), rejectsWith(AuthErrors.IdpError, 401));
		});
	}

	test('an ID token from another IdP than the one requested is rejected', async () => {
		cognito.overrides = { identityProvider: 'Facebook' };
		const { engine, entries } = makeEngine('google');
		await assert.rejects(engineSignIn(engine), rejectsWith(AuthErrors.IdpError, 401));
		assert.ok(entries.some((e) => /another identity provider/.test(e.message)));
	});
});

describe('HostedUiFederationEngine — refresh, revoke, logout', () => {
	beforeEach(scriptUsers);

	async function pool(engine: HostedUiFederationEngine) {
		const identity = await engineSignIn(engine);
		assert.ok(identity.kind === 'pool');
		return identity.tokens;
	}

	test('refresh via /oauth2/token: new verified tokens, the refresh token kept (no rotation)', async () => {
		const { engine } = makeEngine('google');
		const tokens = await pool(engine);
		const out = await engine.refresh({ kind: 'pool', tokens });
		assert.ok(out);
		assert.notStrictEqual(out.tokens.idToken, tokens.idToken);
		assert.strictEqual(out.tokens.refreshToken, tokens.refreshToken);
		const req = cognito.requests.filter((r) => r.path === '/oauth2/token').at(-1);
		assert.strictEqual(req?.form.get('grant_type'), 'refresh_token');
		assert.strictEqual(req?.form.get('refresh_token'), tokens.refreshToken);
	});

	test('refresh: rejected → null (signed out); a Cognito 5xx → retriable throw; no refresh token → null', async () => {
		const { engine } = makeEngine('google');
		const tokens = await pool(engine);
		cognito.refreshBehavior = 'invalid_grant';
		assert.strictEqual(await engine.refresh({ kind: 'pool', tokens }), null);
		cognito.refreshBehavior = 'server_error';
		await assert.rejects(engine.refresh({ kind: 'pool', tokens }), (e: unknown) => {
			assert.ok(e instanceof ApiError && e.retriable === true && e.status === 502);
			return true;
		});
		assert.strictEqual(await engine.refresh({ kind: 'pool', tokens: { ...tokens, refreshToken: '' } }), null);
	});

	test('refresh: a refreshed ID token that fails verification signs the session out', async () => {
		const { engine } = makeEngine('google');
		const tokens = await pool(engine);
		cognito.overrides = { tamper: true };
		assert.strictEqual(await engine.refresh({ kind: 'pool', tokens }), null);
	});

	test('signOut revokes the refresh token at /oauth2/revoke and returns the /logout URL', async () => {
		const { engine } = makeEngine('google');
		const tokens = await pool(engine);
		const { logoutUrl } = await engine.signOut({ kind: 'pool', tokens }, ctxFor(`${APP}/aws-blocks/auth/signout`));
		assert.deepStrictEqual(cognito.revoked, [tokens.refreshToken]);
		assert.ok(logoutUrl);
		const url = new URL(logoutUrl);
		assert.strictEqual(`${url.origin}${url.pathname}`, `${cognito.origin}/logout`);
		assert.strictEqual(url.searchParams.get('client_id'), FAKE_HOSTED_UI_CLIENT_ID);
		assert.strictEqual(
			url.searchParams.get('logout_uri'),
			`${APP}/aws-blocks/auth/signout`,
			"the sign-out path D3b registers as the client's logout URL",
		);
	});

	test('refreshBearer and the client-driven transports', async () => {
		const { engine } = makeEngine('google');
		const tokens = await pool(engine);
		const bearer = await engine.refreshBearer(ctxFor(`${APP}/x`), tokens.refreshToken);
		assert.ok(bearer?.accessToken);
		assert.strictEqual(bearer.refreshToken, tokens.refreshToken);
		const params = await engine.authorizeParams();
		assert.strictEqual(params.clientId, FAKE_HOSTED_UI_CLIENT_ID);
		assert.strictEqual(new URL(params.authorizeUrl).searchParams.get('identity_provider'), 'Google');
		assert.strictEqual(params.usesNonce, false);
	});
});

describe('HostedUiFederationEngine — pool-less safety', () => {
	test('without the hosted-UI config keys every call refuses clearly, before any request', async () => {
		const { engine, entries } = makeEngine('google', providersConfig(), false);
		await assert.rejects(engine.buildSignInUrl(ctxFor(`${APP}/x`), {}), (e: unknown) => {
			assert.ok(e instanceof ApiError);
			assert.strictEqual(e.status, 500);
			assert.strictEqual(e.name, AuthErrors.ProviderMisconfigured);
			assert.match(e.message, /'google' is not available: this deployment has no Cognito managed-login/);
			return true;
		});
		const logged = entries.find((e) => e.level === 'error');
		assert.ok(logged, 'the actionable detail goes to the log');
		const missing = logged.context?.missing;
		assert.ok(Array.isArray(missing));
		assert.ok(missing.includes(federationConfigKeys(Reflect.get(engine, 'host').scope.fullId).DOMAIN));
		assert.deepStrictEqual(
			await engine.signOut(
				{ kind: 'pool', tokens: { idToken: '', accessToken: '', refreshToken: 'r' } },
				ctxFor(`${APP}/x`),
			),
			{},
		);
		assert.strictEqual(cognito.requests.length, 0, 'no request was made');
	});

	test('the engine refuses a provider that does not federate through Cognito', () => {
		const scope = new Scope('auth', { parent: { id: `hui-direct${++counter}` } });
		const options: AuthOptions = { oidcProviders: { okta: { issuer: 'https://okta.example.com', clientId: 'o' } } };
		const [provider] = resolveProviders(options);
		const { logger } = captureLogger();
		assert.throws(
			() =>
				new HostedUiFederationEngine(
					{ scope, userAgentChain: () => [], options, log: logger, sessionSecret: async () => TEST_SECRET },
					provider,
				),
			/does not federate through Cognito managed login/,
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Through the real routes of the AWS entry
// ─────────────────────────────────────────────────────────────────────────────

interface SentCommand {
	name: string;
	input: Record<string, unknown>;
}

/**
 * The real AWS `Auth`, its config keys set, the native engine's Cognito SDK
 * client intercepted (any command not scripted throws), both verifiers fed
 * from the fake's key.
 */
function awsAuth<const O extends AuthOptions>(options: O) {
	const root = { id: `huiaws${process.pid}x${++counter}` };
	setConfigKeys(`${root.id}-auth`);
	simulateTriggerConfig(`${root.id}-auth`, options, FAKE_POOL_ID);
	const auth = new AwsAuth(root, 'auth', options);
	const native: unknown = Reflect.get(auth, 'native');
	assert.ok(typeof native === 'object' && native !== null, 'a hosted-UI configuration has a pool');
	const sent: SentCommand[] = [];
	const responders = new Map<string, (input: Record<string, unknown>) => unknown>();
	const client = Reflect.get(native, 'client');
	client.middlewareStack.add(
		(_next: unknown, context: { commandName?: string }) => async (args: { input: Record<string, unknown> }) => {
			const name = context.commandName ?? 'UnknownCommand';
			sent.push({ name, input: JSON.parse(JSON.stringify(args.input)) });
			const fn = responders.get(name);
			if (!fn) throw new Error(`test: unexpected Cognito command ${name}`);
			return { output: { $metadata: { httpStatusCode: 200 }, ...((await fn(args.input)) ?? {}) } };
		},
		{ step: 'initialize', name: 'd6b-cognito-intercept', override: true },
	);
	Reflect.get(native, 'verifier').cacheJwks(cognito.jwks);
	const providers: Map<string, { provider: ResolvedProvider; engine: FederationEngine }> = Reflect.get(
		auth,
		'providers',
	);
	for (const { engine } of providers.values()) {
		if (engine instanceof HostedUiFederationEngine) routeJwksToFake(engine);
	}
	registerFrontDoor(server.origin, options.redirects?.signOutPath);
	return {
		auth,
		sent,
		providers,
		on: (name: string, fn: (input: Record<string, unknown>) => unknown) => responders.set(name, fn),
	};
}

/** Walk a hosted-UI sign-in hop by hop. Returns the authorize URL and the landing response. */
async function hostedSignIn(browser: TestBrowser, providerId: string) {
	const start = await browser.fetch(`${server.origin}/aws-blocks/auth/signin/${providerId}`);
	assert.strictEqual(start.status, 302, `signin answered ${start.status}: ${await start.clone().text()}`);
	const authorize = location(start, server.origin);
	const fromCognito = await browser.fetch(authorize);
	assert.strictEqual(fromCognito.status, 302);
	const landing = await browser.fetch(location(fromCognito, authorize));
	return { authorize: new URL(authorize), landing };
}

/** POST the sign-out form (the `<Authenticator>`'s federated sign-out). */
function signOutForm(browser: TestBrowser) {
	return browser.fetch(`${server.origin}/aws-blocks/auth/signout`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: '',
	});
}

describe('hosted-UI sign-in through the real routes (aws-runtime)', () => {
	beforeEach(scriptUsers);

	test('sign-in → pool session → requireAuth / requireRole → sign-out 303 to /logout → GET landing', async () => {
		const h = awsAuth({
			socialProviders: { google: { clientId: 'g', clientSecret: secret } },
			users: { groups: ['admin', 'staff'] },
			mfa: 'optional',
			redirects: { postSignOutPath: '/goodbye' },
		});
		const browser = new TestBrowser();
		const { authorize, landing } = await hostedSignIn(browser, 'google');
		assert.strictEqual(authorize.searchParams.get('identity_provider'), 'Google');
		assert.strictEqual(authorize.searchParams.get('redirect_uri'), `${server.origin}/aws-blocks/auth/callback`);
		assert.strictEqual(landing.status, 302);
		assert.strictEqual(landing.headers.get('location'), '/');
		assert.ok(browser.jar.has(`auth_${h.auth.fullId}`), 'the session cookie is set');
		assert.ok(!browser.jar.has(`authpending_${h.auth.fullId}`), 'the pending cookie is single-use');

		// A pool user: identity decoded from the Cognito ID token.
		const username = FakeCognito.username('Google', { idpSub: '1001' });
		const user = await h.auth.requireAuth(browser.context(server.origin));
		assert.strictEqual(user.username, username);
		assert.strictEqual(user.userId, username);
		assert.strictEqual(user.userSub, 'pool-sub-1001');
		assert.strictEqual(user.signInProvider, 'google');
		assert.strictEqual(user.attributes.email, 'ada@example.com');

		// requireRole reads live groups (AdminListGroupsForUser), as for a native user.
		h.on('AdminListGroupsForUserCommand', () => ({ Groups: [{ GroupName: 'staff' }] }));
		const staff = await h.auth.requireRole(browser.context(server.origin), 'staff');
		assert.deepStrictEqual(staff.groups, ['staff']);
		await assert.rejects(h.auth.requireRole(browser.context(server.origin), 'admin'), { status: 403 });
		assert.deepStrictEqual(
			h.sent.map((c) => [c.name, c.input.Username, c.input.UserPoolId]),
			[
				['AdminListGroupsForUserCommand', username, FAKE_POOL_ID],
				['AdminListGroupsForUserCommand', username, FAKE_POOL_ID],
			],
		);
		// No MFA path for a federated user: the IdP owns MFA.
		assert.ok(!h.sent.some((c) => /InitiateAuth|RespondToAuthChallenge/.test(c.name)));
		await assert.rejects(h.auth.setUpTotp(browser.context(server.origin)), {
			status: 400,
			message: /signs in through an identity provider/,
		});

		// Sign-out: 303 to Cognito's /logout (revoking the refresh token first).
		const out = await signOutForm(browser);
		assert.strictEqual(out.status, 303);
		const logout = new URL(location(out, server.origin));
		assert.strictEqual(`${logout.origin}${logout.pathname}`, `${cognito.origin}/logout`);
		assert.strictEqual(logout.searchParams.get('client_id'), FAKE_HOSTED_UI_CLIENT_ID);
		assert.strictEqual(logout.searchParams.get('logout_uri'), `${server.origin}/aws-blocks/auth/signout`);
		assert.strictEqual(cognito.revoked.length, 1);
		assert.ok(!browser.jar.has(`auth_${h.auth.fullId}`), 'the session cookie is cleared');
		await assert.rejects(h.auth.requireAuth(browser.context(server.origin)), { status: 401 });

		// Cognito clears its own cookie and comes back with a GET.
		assert.ok(browser.jar.has(MANAGED_LOGIN_COOKIE));
		const back = await browser.fetch(logout.toString());
		assert.strictEqual(back.status, 302);
		assert.ok(!browser.jar.has(MANAGED_LOGIN_COOKIE), 'the managed-login session is gone');
		const landingUrl = location(back, logout.toString());
		assert.strictEqual(landingUrl, `${server.origin}/aws-blocks/auth/signout`);
		const final = await browser.fetch(landingUrl);
		assert.strictEqual(final.status, 302, 'the sign-out path is served for GET — never a 404');
		assert.strictEqual(final.headers.get('location'), '/goodbye');

		// The next sign-in is not silently re-authenticated by managed login.
		cognito.requests.length = 0;
		await hostedSignIn(browser, 'google');
		const next = cognito.requests.find((r) => r.path === '/oauth2/authorize');
		assert.strictEqual(next?.managedLoginCookie, false);
	});

	test('without /logout the managed-login cookie would re-authenticate silently (why the 303 matters)', async () => {
		awsAuth({ emailPassword: false, socialProviders: { google: { clientId: 'g', clientSecret: secret } } });
		const browser = new TestBrowser();
		await hostedSignIn(browser, 'google');
		// A local-only sign-out (an API client that ignores the Location header).
		const out = await browser.fetch(`${server.origin}/aws-blocks/auth/signout`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		});
		assert.strictEqual(out.status, 204);
		assert.match(out.headers.get('location') ?? '', /\/logout\?client_id=/, 'the logout URL is still handed back');
		cognito.requests.length = 0;
		await hostedSignIn(browser, 'google');
		assert.strictEqual(cognito.requests.find((r) => r.path === '/oauth2/authorize')?.managedLoginCookie, true);
	});

	test('an expired session refreshes through /oauth2/token; a rejected refresh signs out', async () => {
		const h = awsAuth({
			emailPassword: false,
			socialProviders: { google: { clientId: 'g', clientSecret: secret } },
		});
		const browser = new TestBrowser();
		await hostedSignIn(browser, 'google');
		const ctx = () => browser.context(server.origin);
		const session = await h.auth.getAuthSession(ctx(), { forceRefresh: true });
		assert.ok(session.tokens, 'refreshed');
		assert.ok(
			cognito.requests.some((r) => r.path === '/oauth2/token' && r.form.get('grant_type') === 'refresh_token'),
		);
		cognito.refreshBehavior = 'invalid_grant';
		const gone = await h.auth.getAuthSession(ctx(), { forceRefresh: true });
		assert.strictEqual(gone.tokens, undefined);
	});

	test('a tampered ID token on the callback is refused and issues no session', async () => {
		const h = awsAuth({
			emailPassword: false,
			socialProviders: { google: { clientId: 'g', clientSecret: secret } },
		});
		cognito.overrides = { tamper: true };
		const browser = new TestBrowser();
		const { landing } = await hostedSignIn(browser, 'google');
		assert.strictEqual(landing.status, 401);
		assert.strictEqual((await landing.json()).name, AuthErrors.IdpError);
		assert.ok(!browser.jar.has(`auth_${h.auth.fullId}`));
	});

	test('Apple, SAML and cognito-OIDC sign in through the routes with their own identity_provider', async () => {
		const h = awsAuth({
			emailPassword: false,
			socialProviders: {
				apple: { clientId: 'com.example.web', teamId: 'TEAM123456', keyId: 'KEY1234567', privateKey: secret },
			},
			samlProviders: { acme: { metadataUrl: 'https://acme.example.com/metadata.xml' } },
			oidcProviders: {
				entra: {
					issuer: 'https://login.example.com',
					clientId: 'e',
					clientSecret: secret,
					federateVia: 'cognito',
				},
			},
		});
		for (const [id, name] of [
			['apple', 'SignInWithApple'],
			['acme', 'acme'],
			['entra', 'entra'],
		] as const) {
			const browser = new TestBrowser();
			const { authorize, landing } = await hostedSignIn(browser, id);
			assert.strictEqual(authorize.searchParams.get('identity_provider'), name);
			assert.strictEqual(landing.status, 302, id);
			const user = await h.auth.requireAuth(browser.context(server.origin));
			assert.strictEqual(user.signInProvider, id);
			assert.strictEqual(user.username, FakeCognito.username(name, cognito.users.get(name) ?? { idpSub: '' }));
		}
	});
});

describe('a mixed configuration — password + direct OIDC + hosted-UI social (aws-runtime)', () => {
	const idp = new FakeIdp();
	before(async () => {
		await idp.start();
	});
	after(async () => {
		await idp.close();
	});
	beforeEach(scriptUsers);

	test('all three are reachable, and each signs out correctly', async () => {
		const h = awsAuth({
			socialProviders: { google: { clientId: 'g', clientSecret: secret } },
			oidcProviders: { okta: { issuer: idp.issuer, clientId: 'okta-client' } },
		});
		// The AWS layer refuses `http:` issuers (HTTPS only); the fake IdP is plain
		// HTTP, so swap in the same direct engine class with `allowInsecure` —
		// everything else (routes, sessions, the hosted-UI engine) is the AWS layer.
		const okta = h.providers.get('okta');
		assert.ok(okta && okta.engine instanceof DirectFederationEngine, 'okta is federated directly on AWS');
		const resolveSecret: () => Promise<string> = Reflect.get(h.auth, 'resolveSecret');
		okta.engine = new DirectFederationEngine(
			{
				scope: h.auth,
				userAgentChain: () => [],
				options: Reflect.get(h.auth, 'config'),
				log: captureLogger().logger,
				sessionSecret: resolveSecret,
			},
			okta.provider,
			{ allowInsecure: true },
		);

		// 1. Password: a native sign-in, then sign-out lands on postSignOutPath (no IdP logout).
		const password = new TestBrowser();
		h.on('InitiateAuthCommand', () => ({ AuthenticationResult: cognito.nativeAuthResult('pat@example.com') }));
		const ctx = password.context(server.origin);
		const result = await h.auth.signIn('pat@example.com', 'Password!1', ctx);
		assert.strictEqual(result.status, 'signedIn');
		for (const line of ctx.response.headers.getSetCookie()) {
			const [pair] = line.split(';');
			const eq = pair.indexOf('=');
			password.jar.set(pair.slice(0, eq), pair.slice(eq + 1));
		}
		assert.strictEqual((await h.auth.requireAuth(password.context(server.origin))).signInProvider, 'password');
		const pwOut = await signOutForm(password);
		assert.strictEqual(pwOut.status, 303);
		assert.strictEqual(pwOut.headers.get('location'), '/');
		assert.strictEqual(cognito.revoked.length, 0, 'a password session never touches the hosted UI');

		// 2. Direct OIDC: the IdP's own authorize → callback → session; sign-out to its end_session_endpoint.
		const direct = new TestBrowser();
		const start = await direct.fetch(`${server.origin}/aws-blocks/auth/signin/okta`);
		assert.strictEqual(start.status, 302);
		const authorizeUrl = location(start, server.origin);
		assert.ok(authorizeUrl.startsWith(`${idp.issuer}/authorize?`));
		const code = idp.authorize(authorizeUrl, 'okta-user', { email: 'oz@example.com' });
		const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
		const cb = await direct.fetch(
			`${server.origin}/aws-blocks/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
		);
		assert.strictEqual(cb.status, 302);
		const oz = await h.auth.requireAuth(direct.context(server.origin));
		assert.strictEqual(oz.userId, `${idp.issuer}:okta-user`);
		const directOut = await signOutForm(direct);
		assert.strictEqual(directOut.status, 303);
		assert.ok(location(directOut, server.origin).startsWith(`${idp.origin}`), 'to the IdP’s end_session_endpoint');

		// 3. Hosted-UI social: sign-out to Cognito's /logout.
		const social = new TestBrowser();
		const { landing } = await hostedSignIn(social, 'google');
		assert.strictEqual(landing.status, 302);
		assert.strictEqual((await h.auth.requireAuth(social.context(server.origin))).signInProvider, 'google');
		const socialOut = await signOutForm(social);
		assert.strictEqual(socialOut.status, 303);
		assert.ok(location(socialOut, server.origin).startsWith(`${cognito.origin}/logout?`));
		assert.strictEqual(cognito.revoked.length, 1);

		// Each session ended on its own.
		for (const b of [password, direct, social]) {
			await assert.rejects(h.auth.requireAuth(b.context(server.origin)), { status: 401 });
		}
	});
});

describe('Q10: validateUser on a federated first sign-in — the PreSignUp trigger (aws-runtime)', () => {
	beforeEach(scriptUsers);

	/** Cognito invoking the trigger: core's real Lambda handler, which routes by pool id. */
	function wireTrigger() {
		const lambda = createLambdaHandler(async () => ({}));
		cognito.preSignUp = async (event) => {
			try {
				return await lambda(event);
			} finally {
				// The handler locks route registration on first use, as in Lambda.
				unlockRouteRegistry();
			}
		};
	}

	test('a rejection in the trigger blocks the pool user and reaches the browser by its canonical name', async () => {
		const seen: UserCandidate[] = [];
		const h = awsAuth({
			emailPassword: false,
			socialProviders: { google: { clientId: 'g', clientSecret: secret } },
			validateUser: async (c) => {
				seen.push(c);
				if (!c.email?.endsWith('@corp.example')) {
					throw new ApiError('Corporate accounts only', 403, { name: AuthErrors.NotAuthorized });
				}
			},
		});
		wireTrigger();
		const browser = new TestBrowser();
		const { landing } = await hostedSignIn(browser, 'google');
		assert.strictEqual(landing.status, 403);
		const body = await landing.json();
		assert.strictEqual(body.name, AuthErrors.NotAuthorized);
		assert.strictEqual(body.error, 'Corporate accounts only');
		assert.ok(!JSON.stringify(body).includes('PreSignUp failed'), 'no Cognito wrapping reaches the client');
		assert.ok(!browser.jar.has(`auth_${h.auth.fullId}`), 'no session');
		assert.deepStrictEqual(cognito.poolUsers.size, 0, 'Cognito created no pool user');
		assert.deepStrictEqual(seen, [
			{
				provider: 'google',
				subject: '',
				email: 'ada@example.com',
				username: 'google_1001',
				phase: 'signUp',
				claims: { email: 'ada@example.com', name: 'Ada' },
			},
		]);
	});

	test('R2-2: a crafted callback during a pending sign-in cannot choose the error the app answers with', async () => {
		awsAuth({
			emailPassword: false,
			socialProviders: { google: { clientId: 'g', clientSecret: secret } },
			validateUser: async () => {},
		});
		const description = encodeURIComponent(`PreSignUp failed with error ${FORGED_REJECTION}. `);
		for (const extra of ['', '&state=attacker-chosen']) {
			// The victim starts a sign-in (the pending cookie is set) …
			const browser = new TestBrowser();
			const start = await browser.fetch(`${server.origin}/aws-blocks/auth/signin/google`);
			assert.strictEqual(start.status, 302);
			// … and is sent the attacker's link instead of Cognito's redirect.
			const res = await browser.fetch(
				`${server.origin}/aws-blocks/auth/callback?error=invalid_request&error_description=${description}${extra}`,
			);
			assert.strictEqual(res.status, 400, extra || 'no state');
			const body = await res.json();
			assert.strictEqual(body.name, AuthErrors.InvalidState);
			assert.ok(!JSON.stringify(body).includes('+1-555'), 'no attacker text reaches the page');
			assert.ok(!JSON.stringify(body).includes('AccountSuspended'));
		}
	});

	test('FX60: a genuine error callback answers the browser with the fixed message, none of Cognito’s text', async () => {
		awsAuth({
			emailPassword: false,
			socialProviders: { google: { clientId: 'g', clientSecret: secret } },
		});
		const RAW =
			'Google refused: client 1234567890.apps.googleusercontent.com is not authorized for ada@example.com';
		// A real sign-in, so the callback carries this browser's own pending state.
		const browser = new TestBrowser();
		const start = await browser.fetch(`${server.origin}/aws-blocks/auth/signin/google`);
		assert.strictEqual(start.status, 302);
		const state = new URL(location(start, server.origin)).searchParams.get('state') ?? '';
		assert.ok(state, 'the authorize URL carries a state');
		const res = await browser.fetch(
			`${server.origin}/aws-blocks/auth/callback?error=access_denied&error_description=${encodeURIComponent(RAW)}&state=${encodeURIComponent(state)}`,
		);
		assert.strictEqual(res.status, 400);
		const text = await res.text();
		assert.ok(!text.includes(RAW), `the response body must not carry Cognito's text, got: ${text}`);
		assert.ok(!text.includes('googleusercontent'), 'not even the part of it that names the client');
		assert.ok(!text.includes('access_denied'), 'nor the OAuth code');
		const body = JSON.parse(text);
		assert.strictEqual(body.name, AuthErrors.IdpError);
		assert.strictEqual(body.error, idpRefusedMessage('google'));
	});

	test('accepted: the first sign-in checks signUp (trigger) then signIn; later sign-ins check signIn only', async () => {
		const phases: string[] = [];
		awsAuth({
			emailPassword: false,
			socialProviders: { google: { clientId: 'g', clientSecret: secret } },
			validateUser: async (c) => {
				phases.push(`${c.phase}:${c.provider}`);
			},
		});
		wireTrigger();
		const first = await hostedSignIn(new TestBrowser(), 'google');
		assert.strictEqual(first.landing.status, 302);
		assert.deepStrictEqual(phases, ['signUp:google', 'signIn:google']);
		const again = await hostedSignIn(new TestBrowser(), 'google');
		assert.strictEqual(again.landing.status, 302);
		assert.deepStrictEqual(phases, ['signUp:google', 'signIn:google', 'signIn:google']);
	});
});
