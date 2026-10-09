// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The direct federation engine against an in-process fake IdP over real HTTP:
 * discovery, PKCE S256, JWKS-verified ID tokens (and each check failing on its
 * own: nonce, signature, audience, expiry, issuer), userinfo, refresh,
 * revocation, end-session logout, bare OAuth 2.0, and the endpoints override.
 */

import assert from 'node:assert';
import { after, before, beforeEach, describe, test } from 'node:test';
import { ApiError, type BlocksContext, isBlocksError, isWireSafeError, Scope } from '@aws-blocks/core';
import { resolveProviders } from './auth-base.js';
import { DirectFederationEngine, pkceChallenge } from './engines/federation-direct.js';
import { idpRefusedMessage } from './engines/idp-callback-error.js';
import type { EngineHost, FederatedIdentity } from './engines/types.js';
import { AuthErrors } from './errors.js';
import { customOauth2 } from './providers.js';
import type { DirectSessionRecord } from './sessions.js';
import { captureLogger, TEST_SECRET } from './test-helpers.js';
import { FakeIdp } from './test-support/fake-idp.js';
import type { AuthOptions } from './types.js';

const APP = 'http://127.0.0.1:3999';

function ctxFor(url: string, cookie?: string): BlocksContext {
	const u = new URL(url);
	const headers = new Headers({ host: u.host });
	if (cookie) headers.set('cookie', cookie);
	return {
		request: { headers, body: null, json: async () => ({}), text: async () => '', url: u, params: {} },
		response: { headers: new Headers(), status: 200, send: () => {} },
	};
}

/** The `name=value` of the response's pending-auth cookie. */
function pendingCookie(ctx: BlocksContext): string {
	const line = ctx.response.headers.getSetCookie().find((l) => l.startsWith('authpending_'));
	assert.ok(line, 'the sign-in sets the pending-auth cookie');
	return line.split(';')[0];
}

let counter = 0;

function makeEngine(options: AuthOptions, opts: { allowInsecure?: boolean } = {}) {
	const { logger, entries } = captureLogger();
	const scope = new Scope('auth', { parent: { id: `fed${process.pid}x${++counter}` } });
	const host: EngineHost = {
		scope,
		userAgentChain: () => [],
		options,
		log: logger,
		sessionSecret: async () => TEST_SECRET,
	};
	const [provider] = resolveProviders(options);
	const engine = new DirectFederationEngine(host, provider, { allowInsecure: opts.allowInsecure ?? true });
	return { engine, entries, scope };
}

/** Run a full server-initiated sign-in; returns the identity. */
async function signIn(
	idp: FakeIdp,
	engine: DirectFederationEngine,
	claims: Record<string, unknown> = { email: 'ada@example.com', name: 'Ada' },
): Promise<FederatedIdentity> {
	const start = ctxFor(`${APP}/aws-blocks/auth/signin/okta`);
	const authorizeUrl = await engine.buildSignInUrl(start, {});
	const code = idp.authorize(authorizeUrl, 'user-1', claims);
	const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
	const callback = ctxFor(
		`${APP}/aws-blocks/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
		pendingCookie(start),
	);
	return engine.completeSignIn(callback);
}

function rejectsWith(name: string, status?: number) {
	return (e: unknown) => {
		assert.ok(e instanceof ApiError, `an ApiError (got ${String(e)})`);
		assert.ok(isBlocksError(e, name), `named ${name} (got ${e.name}: ${e.message})`);
		if (status !== undefined) assert.strictEqual(e.status, status);
		return true;
	};
}

describe('DirectFederationEngine', () => {
	const idp = new FakeIdp();
	before(async () => {
		await idp.start();
	});
	after(async () => {
		await idp.close();
	});
	beforeEach(() => {
		idp.overrides = {};
		idp.refreshBehavior = 'rotate';
		idp.advertisedIssuer = undefined;
		idp.clientSecret = undefined;
		idp.endSession = true;
		idp.revocation = true;
		idp.userInfoClaims = {};
		idp.tokenResponse = undefined;
		idp.requests.length = 0;
		idp.revoked.length = 0;
	});

	const okta = (extra: Record<string, unknown> = {}): AuthOptions => ({
		emailPassword: false,
		oidcProviders: { okta: { issuer: idp.issuer, clientId: 'client-1', groupsClaim: 'groups', ...extra } },
	});

	test('a public (PKCE-only) client: discovery, PKCE S256, verified ID token, Q1 identity, groupsClaim', async () => {
		const { engine } = makeEngine(okta());
		const start = ctxFor(`${APP}/aws-blocks/auth/signin/okta`);
		const authorizeUrl = new URL(await engine.buildSignInUrl(start, {}));
		assert.strictEqual(authorizeUrl.origin + authorizeUrl.pathname, `${idp.issuer}/authorize`);
		const p = authorizeUrl.searchParams;
		assert.strictEqual(p.get('response_type'), 'code');
		assert.strictEqual(p.get('client_id'), 'client-1');
		assert.strictEqual(p.get('redirect_uri'), `${APP}/aws-blocks/auth/callback`);
		assert.strictEqual(p.get('scope'), 'openid email profile');
		assert.strictEqual(p.get('code_challenge_method'), 'S256');
		assert.ok(p.get('state') && p.get('nonce') && p.get('code_challenge'));

		const identity = await signIn(idp, engine, { email: 'ada@example.com', name: 'Ada', groups: ['admin', 'ops'] });
		assert.strictEqual(identity.kind, 'direct');
		if (identity.kind !== 'direct') return;
		assert.strictEqual(identity.issuer, idp.issuer);
		assert.strictEqual(identity.subject, 'user-1');
		assert.deepStrictEqual(identity.groups, ['admin', 'ops']);
		assert.strictEqual(identity.claims.email, 'ada@example.com');
		assert.ok(identity.idToken && identity.accessToken && identity.refreshToken);

		const token = idp.requests.find((r) => r.path === '/token');
		assert.ok(token);
		assert.strictEqual(token.form.get('client_secret'), null, 'a public client sends no secret');
		// The fake IdP checked S256(code_verifier) against the challenge it was sent.
		assert.ok(token.form.get('code_verifier'), 'the verifier is sent');
	});

	test('a confidential client sends its secret (client_secret_post)', async () => {
		idp.clientSecret = 's3cret';
		const { engine } = makeEngine(okta({ clientSecret: { fullId: 'okta-secret', get: async () => 's3cret' } }));
		const identity = await signIn(idp, engine);
		assert.strictEqual(identity.kind, 'direct');
		assert.strictEqual(idp.requests.find((r) => r.path === '/token')?.form.get('client_secret'), 's3cret');
	});

	test('rejects an ID token with the wrong nonce', async () => {
		idp.overrides = { nonce: 'not-the-one-we-sent' };
		const { engine } = makeEngine(okta());
		await assert.rejects(signIn(idp, engine), rejectsWith(AuthErrors.IdpError, 401));
	});

	test('rejects an ID token with no nonce when one was sent', async () => {
		idp.overrides = { nonce: null };
		const { engine } = makeEngine(okta());
		await assert.rejects(signIn(idp, engine), rejectsWith(AuthErrors.IdpError, 401));
	});

	test('rejects an ID token signed with a key the JWKS does not publish', async () => {
		idp.overrides = { foreignKey: true };
		const { engine, entries } = makeEngine(okta());
		await assert.rejects(signIn(idp, engine), rejectsWith(AuthErrors.IdpError, 401));
		assert.ok(entries.some((e) => e.message.includes('ID token verification failed')));
	});

	test('rejects an ID token for another audience', async () => {
		idp.overrides = { audience: 'someone-else' };
		const { engine } = makeEngine(okta());
		await assert.rejects(signIn(idp, engine), rejectsWith(AuthErrors.IdpError, 401));
	});

	test('rejects an expired ID token', async () => {
		idp.overrides = { idTokenExpiresIn: -120 };
		const { engine } = makeEngine(okta());
		await assert.rejects(signIn(idp, engine), rejectsWith(AuthErrors.IdpError, 401));
	});

	test('rejects an ID token from another issuer', async () => {
		idp.overrides = { issuer: 'https://evil.example.com' };
		const { engine } = makeEngine(okta());
		await assert.rejects(signIn(idp, engine), rejectsWith(AuthErrors.IdpError, 401));
	});

	test('rejects a response with no ID token', async () => {
		idp.overrides = { omitIdToken: true };
		const { engine } = makeEngine(okta());
		await assert.rejects(signIn(idp, engine), rejectsWith(AuthErrors.IdpError));
	});

	test('callback checks: state mismatch, missing cookie, IdP error, another provider', async () => {
		const { engine } = makeEngine(okta());
		const start = ctxFor(`${APP}/aws-blocks/auth/signin/okta`);
		const authorizeUrl = await engine.buildSignInUrl(start, {});
		const cookie = pendingCookie(start);
		const code = idp.authorize(authorizeUrl);
		await assert.rejects(
			engine.completeSignIn(ctxFor(`${APP}/aws-blocks/auth/callback?code=${code}&state=forged`, cookie)),
			rejectsWith(AuthErrors.InvalidState),
		);
		await assert.rejects(
			engine.completeSignIn(ctxFor(`${APP}/aws-blocks/auth/callback?code=${code}&state=x`)),
			rejectsWith(AuthErrors.InvalidCallback),
		);
		const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
		await assert.rejects(
			engine.completeSignIn(
				ctxFor(
					`${APP}/aws-blocks/auth/callback?error=access_denied&error_description=nope&state=${encodeURIComponent(state)}`,
					cookie,
				),
			),
			(e: unknown) => {
				assert.ok(e instanceof ApiError && isBlocksError(e, AuthErrors.IdpError));
				// FX60: the fixed message, not the IdP's `error` / `error_description`.
				assert.strictEqual(e.message, idpRefusedMessage('okta'));
				return true;
			},
		);
		// A tampered cookie does not verify.
		const tampered = `${cookie.slice(0, -2)}xx`;
		await assert.rejects(
			engine.completeSignIn(ctxFor(`${APP}/aws-blocks/auth/callback?code=${code}&state=x`, tampered)),
			rejectsWith(AuthErrors.InvalidCallback),
		);
		// The callback clears the pending cookie (single use).
		const cb = ctxFor(`${APP}/aws-blocks/auth/callback?code=${code}&state=x`, cookie);
		await assert.rejects(engine.completeSignIn(cb));
		assert.ok(cb.response.headers.getSetCookie().some((l) => l.startsWith('authpending_') && /Max-Age=0/.test(l)));
	});

	test('R2-2: an IdP error is honoured only with the pending state — a forged one is InvalidState', async () => {
		const { engine } = makeEngine(okta());
		const start = ctxFor(`${APP}/aws-blocks/auth/signin/okta`);
		const authorizeUrl = await engine.buildSignInUrl(start, {});
		const cookie = pendingCookie(start);
		const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
		const forged = `error=access_denied&error_description=${encodeURIComponent('Your account is suspended. Call +1-555-0100.')}`;
		for (const query of [forged, `${forged}&state=`, `${forged}&state=${encodeURIComponent(`${state}x`)}`]) {
			await assert.rejects(
				engine.completeSignIn(ctxFor(`${APP}/aws-blocks/auth/callback?${query}`, cookie)),
				(e: unknown) => {
					rejectsWith(AuthErrors.InvalidState, 400)(e);
					assert.ok(e instanceof Error && !e.message.includes('+1-555'), query);
					return true;
				},
			);
		}
	});

	test('FX7b: a state of another length or encoding is InvalidState, never a throw of its own', async () => {
		const { engine } = makeEngine(okta());
		const start = ctxFor(`${APP}/aws-blocks/auth/signin/okta`);
		const authorizeUrl = await engine.buildSignInUrl(start, {});
		const cookie = pendingCookie(start);
		const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
		const code = idp.authorize(authorizeUrl);
		for (const bad of [state.slice(0, -1), `${state}x`, `${state.slice(0, -1)}é`, 'é']) {
			await assert.rejects(
				engine.completeSignIn(
					ctxFor(`${APP}/aws-blocks/auth/callback?code=${code}&state=${encodeURIComponent(bad)}`, cookie),
				),
				rejectsWith(AuthErrors.InvalidState, 400),
			);
		}
	});

	test('FX7b: a nonce of another length or type is refused (401), never a throw of its own', async () => {
		for (const nonce of ['short', `${'n'.repeat(40)}é`]) {
			idp.overrides = { nonce };
			const { engine } = makeEngine(okta());
			await assert.rejects(signIn(idp, engine), rejectsWith(AuthErrors.IdpError, 401));
		}
	});

	test('a wrong PKCE verifier is refused by the IdP', async () => {
		const { engine } = makeEngine(okta());
		const authorizeUrl = await engine.buildSignInUrl(ctxFor(`${APP}/x`), {});
		const code = idp.authorize(authorizeUrl);
		await assert.rejects(
			engine.exchangeCode(ctxFor(`${APP}/aws-blocks/auth/exchange`), {
				code,
				codeVerifier: 'not-the-verifier-that-matches-the-challenge-at-all',
				redirectUri: `${APP}/aws-blocks/auth/callback`,
				nonce: new URL(authorizeUrl).searchParams.get('nonce') ?? '',
			}),
			rejectsWith(AuthErrors.IdpError),
		);
	});

	test('rejects a redirectPath that is not same-origin', async () => {
		const { engine } = makeEngine(okta());
		for (const bad of ['https://evil.example.com', '//evil.example.com', '/\\evil']) {
			await assert.rejects(
				engine.buildSignInUrl(ctxFor(`${APP}/x`), { redirectPath: bad }),
				rejectsWith(AuthErrors.InvalidParameter),
			);
		}
	});

	test('rejects a redirectPath a browser would resolve off-origin (control characters, dot segments)', async () => {
		const { engine } = makeEngine(okta());
		// Browsers strip TAB / CR / LF while parsing a URL, so `/\t/evil.com`
		// becomes `//evil.com`; a dot segment can collapse to `//` the same way.
		const bad = [
			'/\t/evil.example.com',
			'/\n/evil.example.com',
			'/\r/evil.example.com',
			'/\u0000/evil.example.com',
			'/\u001f/evil.example.com',
			'/\u007f/evil.example.com',
			'/\\evil.example.com',
			'//evil.example.com',
			'/.//evil.example.com',
			'/a/..//evil.example.com',
			'/%2e%2e//evil.example.com',
			'\t/evil.example.com',
			' /evil.example.com',
			'evil.example.com',
			'javascript:alert(1)',
			'https://evil.example.com/x',
			'',
		];
		for (const redirectPath of bad) {
			await assert.rejects(
				engine.buildSignInUrl(ctxFor(`${APP}/x`), { redirectPath }),
				rejectsWith(AuthErrors.InvalidParameter),
				JSON.stringify(redirectPath),
			);
		}
	});

	test('discovery: the advertised issuer must match; https is required outside local dev', async () => {
		idp.advertisedIssuer = 'https://other.example.com';
		const { engine } = makeEngine(okta());
		await assert.rejects(
			engine.buildSignInUrl(ctxFor(`${APP}/x`), {}),
			rejectsWith(AuthErrors.ProviderMisconfigured),
		);
		idp.advertisedIssuer = undefined;
		const strict = makeEngine(okta(), { allowInsecure: false });
		await assert.rejects(
			strict.engine.buildSignInUrl(ctxFor(`${APP}/x`), {}),
			(e: unknown) => e instanceof ApiError && /must use https/.test(e.message),
		);
	});

	test('the endpoints override skips discovery', async () => {
		const { engine } = makeEngine(
			okta({
				endpoints: {
					authorization: `${idp.issuer}/authorize`,
					token: `${idp.issuer}/token`,
					userInfo: `${idp.issuer}/userinfo`,
					jwks: `${idp.issuer}/jwks`,
				},
			}),
		);
		const identity = await signIn(idp, engine);
		assert.strictEqual(identity.kind, 'direct');
		assert.ok(!idp.requests.some((r) => r.path === '/.well-known/openid-configuration'), 'no discovery request');
	});

	test('userinfo fills profile claims the ID token left out (same subject only)', async () => {
		idp.userInfoClaims = { locale: 'en-GB', email: 'other@example.com' };
		const { engine } = makeEngine(okta());
		const identity = await signIn(idp, engine, { email: 'ada@example.com' });
		assert.strictEqual(identity.kind, 'direct');
		if (identity.kind !== 'direct') return;
		assert.strictEqual(identity.claims.locale, 'en-GB', 'filled from userinfo');
		assert.strictEqual(identity.claims.email, 'ada@example.com', 'the verified ID-token claim wins');
	});

	test('browser-PKCE exchange: the client’s own verifier and nonce', async () => {
		const { engine } = makeEngine(okta());
		const verifier = 'client-generated-verifier-0123456789-abcdefghijklmnop';
		const code = idp.codeFor({
			clientId: 'client-1',
			redirectUri: `${APP}/app/callback`,
			challenge: pkceChallenge(verifier),
			nonce: 'client-nonce',
			sub: 'user-2',
			claims: {},
		});
		const identity = await engine.exchangeCode(ctxFor(`${APP}/aws-blocks/auth/exchange`), {
			code,
			codeVerifier: verifier,
			redirectUri: `${APP}/app/callback`,
			nonce: 'client-nonce',
		});
		assert.strictEqual(identity.kind === 'direct' && identity.subject, 'user-2');
		await assert.rejects(
			engine.exchangeCode(ctxFor(`${APP}/x`), {
				code: 'c',
				codeVerifier: verifier,
				redirectUri: 'myapp://callback',
				nonce: '',
			}),
			rejectsWith(AuthErrors.InvalidCallback),
		);
	});

	test('RFC 9207: an iss parameter from another server is refused', async () => {
		const { engine } = makeEngine(okta());
		await assert.rejects(
			engine.exchangeCode(ctxFor(`${APP}/x`), {
				code: 'c',
				codeVerifier: 'v',
				redirectUri: `${APP}/cb`,
				nonce: '',
				iss: 'https://mix-up.example.com',
			}),
			rejectsWith(AuthErrors.InvalidCallback),
		);
	});

	function recordOf(identity: FederatedIdentity): DirectSessionRecord {
		assert.ok(identity.kind === 'direct');
		return {
			kind: 'direct',
			provider: 'okta',
			issuer: identity.issuer,
			subject: identity.subject,
			username: identity.subject,
			groups: identity.groups,
			attributes: {},
			authTime: 0,
			expiresAt: identity.expiresAt,
			...(identity.idToken ? { idToken: identity.idToken } : {}),
			...(identity.accessToken ? { accessToken: identity.accessToken } : {}),
			...(identity.refreshToken ? { refreshToken: identity.refreshToken } : {}),
		};
	}

	test('refresh rotates the refresh token; a rejected grant is null; a 5xx is a transient throw', async () => {
		const { engine } = makeEngine(okta());
		const record = recordOf(await signIn(idp, engine));
		const out = await engine.refresh({ kind: 'direct', record });
		assert.ok(out && out.kind === 'direct');
		assert.notStrictEqual(out.record.refreshToken, record.refreshToken, 'rotated');
		assert.notStrictEqual(out.record.accessToken, record.accessToken);
		assert.ok(out.record.expiresAt > Date.now());

		idp.refreshBehavior = 'invalid_grant';
		assert.strictEqual(await engine.refresh({ kind: 'direct', record: out.record }), null);

		idp.refreshBehavior = 'server_error';
		await assert.rejects(engine.refresh({ kind: 'direct', record: out.record }), (e: unknown) => {
			assert.ok(e instanceof ApiError && e.retriable === true);
			return true;
		});

		const { refreshToken: _r, ...noRefresh } = out.record;
		assert.strictEqual(
			await engine.refresh({ kind: 'direct', record: noRefresh }),
			null,
			'nothing to refresh with',
		);
	});

	// Port of main's #231 OIDC wire guard (`bb-auth-oidc` `oidc-client-engine.test.ts`): an
	// `ApiError`'s `name` and `message` cross the RPC wire, so the IdP's response body and a
	// secret resolver's error (endpoints, client ids, ARNs, account ids) must stay server-side.
	test('IdP and secret-resolver failures never put their raw text in the wire message (#231)', async () => {
		const RAW = 'client 1234567890.apps.googleusercontent.com at https://idp.internal/token is not authorized';
		const RAW_ARN =
			'User arn:aws:sts::123456789012:assumed-role/app-fn-role/app-fn is not authorized to perform ssm:GetParameter';
		const assertWireSafe = (name: string, status: number, raw: string) => (e: unknown) => {
			rejectsWith(name, status)(e);
			assert.ok(
				e instanceof ApiError && isWireSafeError(e),
				'a wire-safe ApiError, so its name reaches the client',
			);
			assert.ok(!e.message.includes(raw), `the wire message must not carry the raw text, got: ${e.message}`);
			assert.ok(!JSON.stringify(e).includes(raw), 'JSON.stringify of the error must not carry the raw text');
			return true;
		};

		// The code exchange is rejected (4xx) with a body that describes the client.
		const { engine, entries } = makeEngine(okta());
		idp.tokenResponse = { status: 400, body: { error: 'invalid_client', error_description: RAW } };
		await assert.rejects(signIn(idp, engine), assertWireSafe(AuthErrors.IdpError, 400, RAW));
		assert.ok(
			entries.some((x) => JSON.stringify(x).includes(RAW)),
			'the IdP description is still logged server-side',
		);

		// The token endpoint fails (5xx) with the same body.
		idp.tokenResponse = { status: 500, body: { error: 'server_error', error_description: RAW } };
		await assert.rejects(signIn(idp, makeEngine(okta()).engine), assertWireSafe(AuthErrors.IdpError, 502, RAW));

		// A refresh grant that fails with a 5xx (a rejected one is `null`, not a throw).
		idp.tokenResponse = undefined;
		const { engine: refresher } = makeEngine(okta());
		const record = recordOf(await signIn(idp, refresher));
		idp.tokenResponse = { status: 503, body: { error: 'temporarily_unavailable', error_description: RAW } };
		await assert.rejects(
			refresher.refresh({ kind: 'direct', record }),
			assertWireSafe(AuthErrors.IdpError, 502, RAW),
		);
		idp.tokenResponse = { status: 400, body: { error: 'invalid_grant', error_description: RAW } };
		assert.strictEqual(await refresher.refresh({ kind: 'direct', record }), null);
		idp.tokenResponse = undefined;

		// The client-secret resolver (an `AppSetting` read from SSM) throws with an ARN.
		const { engine: noSecret } = makeEngine(
			okta({
				clientSecret: {
					fullId: 'okta-secret',
					get: async () => {
						throw new Error(RAW_ARN);
					},
				},
			}),
		);
		await assert.rejects(signIn(idp, noSecret), assertWireSafe(AuthErrors.ProviderMisconfigured, 502, RAW_ARN));
	});

	// FX60: the callback's own OAuth error response was the last path that still
	// quoted external text in the wire message, which is what the
	// `<Authenticator>` renders. Now it gets the fixed message and the text is
	// logged — the engine-level mirror of the `#231` guard above.
	test('an error callback never puts the IdP’s text in the wire message; it is logged at the right level', async () => {
		const cases = [
			{
				error: 'access_denied',
				description: 'ada@example.com is not a member of okta-group-engineering',
				level: 'info',
			},
			{ error: 'temporarily_unavailable', description: 'the directory is being migrated', level: 'error' },
			{
				error: 'invalid_request',
				description: 'the SSM parameter arn:aws:ssm:us-east-1:123456789012:parameter/okta could not be read',
				level: 'error',
			},
			{ error: 'invalid_scope', description: null, level: 'info' },
		] as const;
		for (const c of cases) {
			const { engine, entries } = makeEngine(okta());
			const start = ctxFor(`${APP}/aws-blocks/auth/signin/okta`);
			const authorizeUrl = await engine.buildSignInUrl(start, {});
			const cookie = pendingCookie(start);
			const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
			const query = [
				`error=${c.error}`,
				...(c.description === null ? [] : [`error_description=${encodeURIComponent(c.description)}`]),
				`state=${encodeURIComponent(state)}`,
			].join('&');
			await assert.rejects(
				engine.completeSignIn(ctxFor(`${APP}/aws-blocks/auth/callback?${query}`, cookie)),
				(e: unknown) => {
					rejectsWith(AuthErrors.IdpError, 400)(e);
					assert.ok(e instanceof ApiError && isWireSafeError(e), 'wire-safe, so its name reaches the client');
					assert.strictEqual(e.message, idpRefusedMessage('okta'), c.error);
					const seen = `${e.message} ${JSON.stringify(e)}`;
					assert.ok(!seen.includes(c.error), `${c.error}: the OAuth code stays server-side`);
					if (c.description) assert.ok(!seen.includes(c.description), `${c.error}: no IdP text`);
					return true;
				},
			);
			const line = entries.find(
				(x) => x.message === '[bb-auth] the identity provider returned an error on the callback',
			);
			assert.ok(line, `${c.error}: the detail is logged: ${JSON.stringify(entries)}`);
			assert.strictEqual(line.level, c.level, c.error);
			assert.strictEqual(line.context?.provider, 'okta');
			assert.strictEqual(line.context?.error, c.error);
			assert.strictEqual(line.context?.description, c.description);
		}
	});

	test('sign-out revokes upstream and returns the end_session logout URL', async () => {
		const { engine } = makeEngine(okta());
		const record = recordOf(await signIn(idp, engine));
		const { logoutUrl } = await engine.signOut(
			{ kind: 'direct', record },
			ctxFor(`${APP}/aws-blocks/auth/signout`),
		);
		assert.deepStrictEqual(idp.revoked, [record.refreshToken]);
		assert.ok(logoutUrl);
		const url = new URL(logoutUrl);
		assert.strictEqual(`${url.origin}${url.pathname}`, `${idp.issuer}/logout`);
		assert.strictEqual(url.searchParams.get('id_token_hint'), record.idToken);
		assert.strictEqual(url.searchParams.get('client_id'), 'client-1');
		assert.strictEqual(url.searchParams.get('post_logout_redirect_uri'), `${APP}/`);

		idp.endSession = false;
		const plain = makeEngine(okta());
		const r2 = recordOf(await signIn(idp, plain.engine));
		assert.deepStrictEqual(await plain.engine.signOut({ kind: 'direct', record: r2 }, ctxFor(`${APP}/x`)), {});
	});

	test('bare OAuth 2.0 (customOauth2): userinfo + mapClaims, Q1 identity oauth2:<name>:<sub>', async () => {
		idp.userInfoClaims = { id: 4242, login: 'ada', email: 'ada@example.com', name: 'Ada' };
		const { engine } = makeEngine({
			emailPassword: false,
			oidcProviders: {
				gh: customOauth2({
					name: 'gh',
					clientId: 'client-1',
					scopes: ['read:user'],
					endpoints: {
						authorization: `${idp.issuer}/authorize`,
						token: `${idp.issuer}/token`,
						userInfo: `${idp.issuer}/userinfo`,
					},
					mapClaims: (raw) => {
						const o = typeof raw === 'object' && raw !== null ? raw : {};
						return {
							providerSub: String(Reflect.get(o, 'id')),
							email: String(Reflect.get(o, 'email')),
							name: String(Reflect.get(o, 'name')),
						};
					},
				}),
			},
		});
		const start = ctxFor(`${APP}/aws-blocks/auth/signin/gh`);
		const authorizeUrl = await engine.buildSignInUrl(start, {});
		assert.strictEqual(new URL(authorizeUrl).searchParams.get('nonce'), null, 'OAuth 2.0 sends no nonce');
		const code = idp.authorize(authorizeUrl, 'gh-user');
		const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
		const identity = await engine.completeSignIn(
			ctxFor(`${APP}/aws-blocks/auth/callback?code=${code}&state=${state}`, pendingCookie(start)),
		);
		assert.ok(identity.kind === 'direct');
		assert.strictEqual(identity.issuer, 'oauth2:gh');
		assert.strictEqual(identity.subject, '4242');
		assert.strictEqual(`${identity.issuer}:${identity.subject}`, 'oauth2:gh:4242', "AuthOIDC's userId");
		assert.strictEqual(identity.claims.email, 'ada@example.com');
		assert.ok(!idp.requests.some((r) => r.path === '/.well-known/openid-configuration'), 'no discovery');

		// No refresh token: the access token is re-validated against userinfo.
		const record = recordOf(identity);
		const { refreshToken: _r, ...noRefresh } = record;
		const refreshed = await engine.refresh({ kind: 'direct', record: noRefresh });
		assert.ok(refreshed && refreshed.record.expiresAt > Date.now());
		assert.strictEqual(
			await engine.refresh({ kind: 'direct', record: { ...noRefresh, accessToken: 'revoked-token' } }),
			null,
		);
	});

	test('authorize parameters are public: never a secret', async () => {
		const { engine } = makeEngine(okta({ clientSecret: { fullId: 'okta-secret', get: async () => 's3cret' } }));
		const params = await engine.authorizeParams(ctxFor(`${APP}/x`));
		assert.deepStrictEqual(params, {
			authorizeUrl: `${idp.issuer}/authorize`,
			clientId: 'client-1',
			scopes: ['openid', 'email', 'profile'],
			kind: 'oidc-custom',
			usesNonce: true,
		});
		assert.ok(!JSON.stringify(params).includes('s3cret'));
	});

	test('bearer refresh: rotated tokens, or null when rejected', async () => {
		const { engine } = makeEngine(okta());
		const record = recordOf(await signIn(idp, engine));
		const tokens = await engine.refreshBearer(ctxFor(`${APP}/x`), record.refreshToken ?? '');
		assert.ok(tokens?.accessToken && tokens.refreshToken !== record.refreshToken && tokens.expiresIn === 3600);
		assert.strictEqual(await engine.refreshBearer(ctxFor(`${APP}/x`), 'unknown'), null);
	});
});
