// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wire-sanitization guard for the two OIDC error helpers that carry a raw
 * underlying error (#227 leak class). `idpError` and `providerNotConfigured`
 * build a branded error with a stable, BB-authored message and keep the raw
 * openid-client / SSM-resolver error only on a NON-ENUMERABLE `cause`.
 *
 * Only `name` + `message` cross the RPC wire (core's `errorResponseFromCatch`
 * sends nothing else), so a regression — re-interpolating `cause.message` back
 * into the message (e.g. `IdP error: ${msg}: ${cause.message}`) — would leak IdP
 * endpoints, tokens, SSM ARNs, and account ids to the caller. These tests pin
 * both wire-visible fields: the message must stay BB-authored, and
 * `JSON.stringify` must not expose the cause. Without them, adding the raw text
 * back passes the rest of the suite silently (the gap osama flagged).
 */
import { test, describe, mock, afterEach } from 'node:test';
import assert from 'node:assert';
import type { BlocksContext } from '@aws-blocks/core';
import { OidcClientEngine, idpError, providerNotConfigured } from './oidc-client-engine.js';
import { stubIdp } from '../providers.js';
import { resolveProviderIssuerUrl } from '../utils.js';
import { encodeSignedCookie, type PendingAuthPayload, type SessionCookiePayload } from '../session-cookie.js';
import { pendingCookieName, sessionCookieName } from './session-manager.js';
import type { ProviderConfig, SessionRow, SessionStore } from '../types.js';

/** A raw IdP error whose message carries detail that must never reach the wire. */
const RAW_IDP_SECRET = 'invalid_grant: code expired for client 1234567890.apps.googleusercontent.com';
/** A raw SSM-resolver error carrying an ARN + account id that must never leak. */
const RAW_SSM_SECRET =
	'AccessDenied: User arn:aws:sts::123456789012:assumed-role/app-fn-role/app-fn is not authorized to perform ssm:GetParameter on /app/google/clientSecret';

/**
 * Assert the branded error only exposes BB-authored text on the two fields that
 * cross the RPC wire (`name`, `message`), and keeps the raw error on a
 * non-enumerable `cause` for server-side diagnostics.
 */
function assertNoLeak(err: Error, expectedName: string, rawSecret: string): void {
	// (1) name is the stable BB constant.
	assert.strictEqual(err.name, expectedName);
	// (2) the wire-visible MESSAGE must not embed the raw error text.
	assert.ok(
		!err.message.includes(rawSecret),
		`wire message must not leak the raw error text, got: ${err.message}`,
	);
	// (3) the raw error is retained on `cause` for debugging...
	const { cause } = err;
	assert.ok(cause instanceof Error, 'raw error should be retained on cause');
	assert.ok(
		cause.message.includes(rawSecret),
		'cause should preserve the raw error text for server-side diagnostics',
	);
	// (4) ...but `cause` must be NON-ENUMERABLE, so JSON.stringify (and therefore
	// anything that serializes the error) can never surface the raw text.
	assert.strictEqual(
		Object.getOwnPropertyDescriptor(err, 'cause')?.enumerable,
		false,
		'`cause` must be non-enumerable',
	);
	assert.ok(
		!JSON.stringify(err).includes(rawSecret),
		'JSON.stringify of the error must not leak the raw text',
	);
}

describe('OIDC error helpers do not leak the raw cause over the wire', () => {
	test('idpError keeps the raw IdP error off the wire message', () => {
		const err = idpError('code exchange failed', new Error(RAW_IDP_SECRET));
		assert.strictEqual(err.message, 'IdP error: code exchange failed');
		assertNoLeak(err, 'IdpErrorException', RAW_IDP_SECRET);
	});

	test('providerNotConfigured keeps the raw resolver error off the wire message', () => {
		const err = providerNotConfigured('google: clientSecret resolver threw', new Error(RAW_SSM_SECRET));
		assert.strictEqual(err.message, 'provider not configured: google: clientSecret resolver threw');
		assertNoLeak(err, 'ProviderNotConfiguredException', RAW_SSM_SECRET);
	});

	test('both helpers are a no-op on cause when none is supplied', () => {
		const idp = idpError('code exchange did not return an ID token');
		assert.strictEqual(idp.cause, undefined);
		assert.strictEqual(idp.message, 'IdP error: code exchange did not return an ID token');

		const prov = providerNotConfigured('google');
		assert.strictEqual(prov.cause, undefined);
		assert.strictEqual(prov.message, 'provider not configured: google');
	});

	// The OAuth2 token/userinfo and refresh-grant failure sites pass the raw IdP
	// HTTP response body as `cause` and keep a BB-authored, STATUS-ONLY message.
	// The numeric HTTP status is safe on the wire; the response body (which can
	// embed account/endpoint detail) must not be interpolated into the message.
	const RAW_HTTP_BODY =
		'{"error":"invalid_client","error_description":"client 1234567890.apps.googleusercontent.com at https://idp.internal/token is not authorized"}';

	test('token-endpoint failure keeps the raw response body off the wire message', () => {
		const err = idpError('token endpoint rejected the code exchange (HTTP 400)', new Error(RAW_HTTP_BODY));
		assert.strictEqual(err.message, 'IdP error: token endpoint rejected the code exchange (HTTP 400)');
		assertNoLeak(err, 'IdpErrorException', RAW_HTTP_BODY);
	});

	test('userinfo failure keeps the raw response body off the wire message', () => {
		const err = idpError('userinfo endpoint request failed (HTTP 401)', new Error(RAW_HTTP_BODY));
		assert.strictEqual(err.message, 'IdP error: userinfo endpoint request failed (HTTP 401)');
		assertNoLeak(err, 'IdpErrorException', RAW_HTTP_BODY);
	});

	test('refresh-grant failure keeps the raw response body off the wire message', () => {
		const err = idpError('refresh_token grant failed (HTTP 400)', new Error(RAW_HTTP_BODY));
		assert.strictEqual(err.message, 'IdP error: refresh_token grant failed (HTTP 400)');
		assertNoLeak(err, 'IdpErrorException', RAW_HTTP_BODY);
	});
});

describe('OidcClientEngine: trustStubProviders', () => {
	const ORIGIN = 'https://api.example.test';
	const STUB_ISSUER = `${ORIGIN}/aws-blocks/auth/idp/dev`;

	/** Request context whose origin resolves the stub issuer to `STUB_ISSUER`. */
	function ctxWith(headers: Headers = new Headers()): BlocksContext {
		return {
			request: {
				headers,
				body: null,
				json: async () => ({}),
				text: async () => '',
				url: new URL(`${ORIGIN}/`),
				params: {},
			},
			response: {
				headers: new Headers(),
				status: 200,
				send: () => {},
			},
		} as unknown as BlocksContext;
	}

	/** Unsigned token whose payload names `iss`; matching runs before signature checks. */
	function tokenWithIssuer(iss: string): string {
		const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k' })).toString('base64url');
		const now = Math.floor(Date.now() / 1000);
		const payload = Buffer.from(
			JSON.stringify({ iss, sub: 'u', aud: 'stub-client-id', exp: now + 3600, iat: now }),
		).toString('base64url');
		return `${header}.${payload}.sig`;
	}

	const COOKIE_SECRET = 'test-cookie-secret-test-cookie-secret';
	const COOKIE_PREFIX = 'oidc_test';

	/** Build an engine with one stub provider; `resolveIssuerUrl` calls are counted. */
	function engineFor(trustStubProviders: boolean, sessionStore: SessionStore = {} as unknown as SessionStore) {
		const resolved: string[] = [];
		const engine = new OidcClientEngine({
			providers: [stubIdp({ name: 'dev' })],
			// Plumbing only unless a test passes a store: most paths under
			// test never reach the session store.
			sessionStore,
			cookieSecret: COOKIE_SECRET,
			cookieNamePrefix: COOKIE_PREFIX,
			cookieAttributes: { secure: true, partitioned: false, sameSite: 'Lax', path: '/' },
			callbackPath: '/aws-blocks/auth/callback',
			postSignInPath: '/',
			resolveIssuerUrl: (provider: ProviderConfig, ctx: BlocksContext) => {
				resolved.push(provider.name);
				return resolveProviderIssuerUrl(provider, ctx);
			},
			allowInsecureIssuers: false,
			trustStubProviders,
		});
		return { engine, resolved };
	}

	afterEach(() => {
		mock.restoreAll();
	});

	test('false: a bearer token issued by the stub issuer is not matched and no discovery runs', async () => {
		const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
		const { engine, resolved } = engineFor(false);
		const user = await engine.verifyAccessToken(tokenWithIssuer(STUB_ISSUER), ctxWith());
		assert.strictEqual(user, null);
		assert.deepStrictEqual(resolved, [], 'the stub issuer must not be resolved from the request');
		assert.strictEqual(fetchMock.mock.callCount(), 0, 'no issuer discovery for an untrusted stub');
	});

	test('false: sign-in, authorize-params, and exchange answer ProviderNotConfigured for the stub', async () => {
		const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
		const { engine, resolved } = engineFor(false);
		const ctx = ctxWith();
		const notConfigured = { name: 'ProviderNotConfiguredException' };
		await assert.rejects(
			engine.buildSignInUrl({ provider: 'dev', callbackUrl: `${ORIGIN}/aws-blocks/auth/callback`, ctx }),
			notConfigured,
		);
		await assert.rejects(engine.getAuthorizeParams('dev', ctx), notConfigured);
		await assert.rejects(
			engine.handleExchange(
				{
					code: 'c',
					verifier: 'v',
					state: 's',
					nonce: '',
					provider: 'dev',
					callbackUrl: `${ORIGIN}/aws-blocks/auth/callback`,
				},
				ctx,
			),
			notConfigured,
		);
		assert.strictEqual(await engine.refreshBearerTokens({ refreshToken: 'r', provider: 'dev' }, ctx), null);
		assert.deepStrictEqual(resolved, []);
		assert.strictEqual(fetchMock.mock.callCount(), 0);
	});

	test('false: hasProvider reports the stub as not served', () => {
		assert.strictEqual(engineFor(false).engine.hasProvider('dev'), false);
		assert.strictEqual(engineFor(true).engine.hasProvider('dev'), true);
	});

	test('false: a callback whose pending-auth cookie names the stub answers ProviderNotConfigured', async () => {
		const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
		const { engine, resolved } = engineFor(false);
		const pending: PendingAuthPayload = {
			provider: 'dev',
			state: 'st',
			nonce: 'n',
			codeVerifier: 'v',
			callbackUrl: `${ORIGIN}/aws-blocks/auth/callback`,
			exp: Math.floor(Date.now() / 1000) + 600,
		};
		const cookie = `${pendingCookieName(COOKIE_PREFIX)}=${encodeSignedCookie(pending, COOKIE_SECRET)}`;
		const ctx = ctxWith(new Headers({ cookie }));
		ctx.request.url.searchParams.set('state', 'st');
		ctx.request.url.searchParams.set('code', 'c');
		await assert.rejects(engine.handleCallback(ctx), { name: 'ProviderNotConfiguredException' });
		assert.deepStrictEqual(resolved, []);
		assert.strictEqual(fetchMock.mock.callCount(), 0);
	});

	test('false: signing out a stub session never revokes upstream (no fetch)', async () => {
		const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
		const rows = new Map<string, SessionRow>([
			['sid-1', { userId: 'u', refreshToken: 'rt', expiresAt: 0, claims: {}, state: 'ready', version: 1 }],
		]);
		const deleted: string[] = [];
		const store: SessionStore = {
			get: async (key) => rows.get(key) ?? null,
			put: async (key, value) => {
				rows.set(key, value);
			},
			delete: async (key) => {
				deleted.push(key);
				rows.delete(key);
			},
		};
		const { engine, resolved } = engineFor(false, store);
		const session: SessionCookiePayload = {
			mode: 'stateful',
			provider: 'dev',
			sessionId: 'sid-1',
			exp: Math.floor(Date.now() / 1000) + 3600,
		};
		const cookie = `${sessionCookieName(COOKIE_PREFIX)}=${encodeSignedCookie(session, COOKIE_SECRET)}`;
		const ctx = ctxWith(new Headers({ cookie }));
		await engine.signOut(ctx);
		// The local session is still cleaned up; only the upstream revoke is skipped.
		assert.deepStrictEqual(deleted, ['sid-1']);
		assert.deepStrictEqual(resolved, [], 'the stub issuer must not be resolved on sign-out');
		assert.strictEqual(fetchMock.mock.callCount(), 0, 'no revocation or discovery for an untrusted stub');
	});

	test('false: a signed stub session cookie with a live row is not honoured', async () => {
		const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
		const now = Math.floor(Date.now() / 1000);
		const rows = new Map<string, SessionRow>([
			['sid-1', { userId: 'u', refreshToken: 'rt', expiresAt: now + 3600, claims: {}, state: 'ready', version: 1 }],
		]);
		const store: SessionStore = {
			get: async (key) => rows.get(key) ?? null,
			put: async (key, value) => {
				rows.set(key, value);
			},
			delete: async (key) => {
				rows.delete(key);
			},
		};
		const session: SessionCookiePayload = {
			mode: 'stateful',
			provider: 'dev',
			sessionId: 'sid-1',
			exp: now + 3600,
		};
		const cookie = `${sessionCookieName(COOKIE_PREFIX)}=${encodeSignedCookie(session, COOKIE_SECRET)}`;

		// The same cookie and row resolve to a user on a trusting engine, so
		// the `null` below comes from the stub check and not from the fixture.
		const trusted = engineFor(true, store).engine;
		assert.strictEqual((await trusted.verifySession(ctxWith(new Headers({ cookie }))))?.provider, 'dev');

		const { engine, resolved } = engineFor(false, store);
		assert.strictEqual(await engine.verifySession(ctxWith(new Headers({ cookie }))), null);
		assert.strictEqual(await engine.refreshSession(ctxWith(new Headers({ cookie }))), null);
		assert.deepStrictEqual(resolved, []);
		assert.strictEqual(fetchMock.mock.callCount(), 0);
	});

	test('false: loadConfig refuses a stub provider when called directly', async () => {
		const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
		const { engine, resolved } = engineFor(false);
		// `loadConfig` is private and not reachable for a stub through the
		// public API (the provider table already excludes it); call it
		// directly to pin the second check.
		const internal = engine as unknown as {
			loadConfig: (p: ProviderConfig, c: BlocksContext) => Promise<unknown>;
		};
		await assert.rejects(internal.loadConfig(stubIdp({ name: 'dev' }), ctxWith()), {
			name: 'ProviderNotConfiguredException',
		});
		assert.deepStrictEqual(resolved, []);
		assert.strictEqual(fetchMock.mock.callCount(), 0);
	});

	test('true: the stub issuer is matched and discovery runs against it', async () => {
		const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
		const { engine, resolved } = engineFor(true);
		// Discovery is answered 404, so verification still fails closed; what
		// this pins is that a trusted stub IS matched and discovered.
		const user = await engine.verifyAccessToken(tokenWithIssuer(STUB_ISSUER), ctxWith());
		assert.strictEqual(user, null);
		assert.ok(resolved.includes('dev'));
		assert.ok(fetchMock.mock.callCount() > 0, 'expected issuer discovery for a trusted stub');
		const firstUrl = String(fetchMock.mock.calls[0].arguments[0]);
		assert.ok(firstUrl.startsWith(`${STUB_ISSUER}/.well-known/openid-configuration`), firstUrl);
	});
});
