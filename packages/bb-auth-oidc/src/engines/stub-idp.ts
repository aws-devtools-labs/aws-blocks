// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Stub IdP used by the mock runtime.
 *
 * Each configured provider gets its own issuer path, mounted as a set of
 * `RawRoute`s by the mock `AuthOIDC` constructor:
 *
 *    /aws-blocks/auth/idp/<provider>/.well-known/openid-configuration
 *    /aws-blocks/auth/idp/<provider>/authorize
 *    /aws-blocks/auth/idp/<provider>/token
 *    /aws-blocks/auth/idp/<provider>/jwks.json
 *    /aws-blocks/auth/idp/<provider>/userinfo      (for OAuth 2.0 providers)
 *
 * Tokens are signed with a real RS256 keypair per IdP instance so the mock
 * runtime exercises the same JWKS-fetch + RS256-verify code path
 * `openid-client` uses in production.
 *
 * The stub auto-approves every `/authorize` with a deterministic fake user
 * derived from the requested provider name. Tests that want to exercise
 * sign-in failure paths can set the `BLOCKS_OIDC_STUB_FAIL` environment
 * variable or use the test helpers exported alongside the class.
 */

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT, type JWK } from 'jose';
import type { BlocksContext } from '@aws-blocks/core';
import { BLOCKS_AUTH_PREFIX } from '@aws-blocks/core';
import type { ProviderConfig, StubProvider, StubUser } from '../types.js';

/**
 * Root path under which each provider's stub IdP is mounted. Lives under the
 * reserved `/aws-blocks/auth` subtree so the same CloudFront behavior that
 * proxies the auth flow also covers the co-hosted stub IdP.
 */
export const STUB_ROOT = `${BLOCKS_AUTH_PREFIX}/idp`;

/** Path segment per provider. */
export function stubIssuerPath(providerName: string): string {
	return `${STUB_ROOT}/${encodeURIComponent(providerName)}`;
}

/**
 * Compute the absolute issuer URL for a provider's stub, given the current
 * request. Used at runtime to build discovery + token + jwks URLs.
 *
 * The stub IdP's issuer (and its discovery / token / JWKS / authorize
 * endpoints) is fetched **server-side by the Lambda itself** during
 * `openid-client` discovery and code exchange, so it must resolve to a host
 * the Lambda can reach over HTTPS. We prefer the deploy-injected `BLOCKS_API_URL`
 * (the API's own execute-api gateway origin) for exactly that reason: in
 * sandbox, `ctx.request.url` is rewritten to the loopback dev-server front door
 * (`http://localhost:3000`), which the Lambda can't reach and the AWS runtime's
 * HTTPS-only discovery would reject. In a full deploy `BLOCKS_API_URL` is also the
 * execute-api origin (correct), and in local dev it's unset so we fall back to
 * `ctx.request.url` (the in-process mock allows insecure issuers).
 *
 * Like a real external IdP, the stub's authorize/login step then runs on the
 * issuer's own origin (the gateway), not the app front door; that hop sets no
 * cookie and 302s back to the front-door `redirect_uri`.
 *
 * Both sources carry the API Gateway stage prefix (e.g. `/prod`) before the
 * `/aws-blocks` route segment; we extract it so the issuer URL is the correct
 * external-facing one.
 */
export function stubIssuerUrl(providerName: string, ctx: { request: { url: URL } }): string {
	// `BLOCKS_API_URL` is injected at synth by core (the API's own execute-api
	// gateway URL). Literal key — it's core-owned config, already set under this
	// name on the compute/SSR functions and read by the RPC client.
	const apiUrl = process.env.BLOCKS_API_URL;
	const url = apiUrl ? new URL(apiUrl) : ctx.request.url;
	const stubPath = stubIssuerPath(providerName);
	// The stage prefix (if any) is the path segment before the route. All stub
	// routes live under the reserved `/aws-blocks` namespace — and `BLOCKS_API_URL`
	// likewise ends in `/{stage}/aws-blocks/api`, so the same scan extracts the
	// stage from either source.
	const pathname = url.pathname;
	const routeStart = pathname.search(/\/aws-blocks\b/);
	const stagePrefix = routeStart > 0 ? pathname.slice(0, routeStart) : '';
	return `${url.protocol}//${url.host}${stagePrefix}${stubPath}`;
}

interface StubKeyMaterial {
	privateKey: CryptoKey;
	publicJwk: JWK;
	kid: string;
}

/** Lazily-generated keypairs, one per provider. Cached for the life of the process. */
const keyPromises = new Map<string, Promise<StubKeyMaterial>>();

function getKeyMaterial(providerName: string): Promise<StubKeyMaterial> {
	let p = keyPromises.get(providerName);
	if (p) return p;
	p = (async () => {
		const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
		const publicJwk = await exportJWK(publicKey);
		const kid = `stub-${providerName}-${Date.now()}`;
		publicJwk.kid = kid;
		publicJwk.use = 'sig';
		publicJwk.alg = 'RS256';
		return { privateKey, publicJwk, kid };
	})();
	keyPromises.set(providerName, p);
	return p;
}

interface PendingAuth {
	/** Client that initiated the flow (matched against token request). */
	clientId: string;
	/** PKCE code challenge (S256) for verification against the verifier. */
	codeChallenge: string;
	codeChallengeMethod: 'S256';
	/** State echoed back to the RP. */
	state: string;
	/** Nonce echoed into the ID token. */
	nonce: string;
	/** Redirect URI registered with the flow — must match token request. */
	redirectUri: string;
	/** Requested scopes. */
	scopes: string[];
	/** Fake user — deterministic per provider but distinct across tests. */
	user: StubUser;
	/** When the code expires (unix ms). */
	expiresAt: number;
}

/** In-memory map keyed by issued authorization code. */
const pendingByCode = new Map<string, PendingAuth>();

/** Default fake user for auto-approved sign-ins. */
function defaultUser(providerName: string): StubUser {
	return {
		sub: `stub-${providerName}-user`,
		email: `${providerName}-user@stub.invalid`,
		name: `Stub ${providerName} User`,
	};
}

/**
 * The local identity directory for `onAuthorize` and the login screen.
 *
 * Reads `users.json` from `dataDir` (mock runtime only) when present; falls
 * back to the single deterministic default when absent or malformed, so the
 * AWS runtime and un-configured apps are unchanged.
 */
function stubUserDirectory(providerName: string, dataDir?: string): StubUser[] {
	if (dataDir) {
		try {
			const parsed = JSON.parse(readFileSync(join(dataDir, 'users.json'), 'utf8'));
			const users = Array.isArray(parsed)
				? parsed.filter((u): u is StubUser =>
					u && typeof u.sub === 'string' && typeof u.email === 'string' && typeof u.name === 'string')
				: [];
			if (users.length > 0) return users;
		} catch {
			// No file or bad JSON: fall through to the default.
		}
	}
	return [defaultUser(providerName)];
}

/**
 * Return the OIDC discovery document for the provider. `openid-client`
 * fetches this as the first step of `discovery()`.
 */
export async function handleDiscovery(
	providerName: string,
	ctx: BlocksContext,
): Promise<void> {
	const issuer = stubIssuerUrl(providerName, ctx);
	await getKeyMaterial(providerName); // Ensure keys exist before JWKS is advertised.
	const doc = {
		issuer,
		authorization_endpoint: `${issuer}/authorize`,
		token_endpoint: `${issuer}/token`,
		jwks_uri: `${issuer}/jwks.json`,
		userinfo_endpoint: `${issuer}/userinfo`,
		revocation_endpoint: `${issuer}/revoke`,
		response_types_supported: ['code'],
		subject_types_supported: ['public'],
		id_token_signing_alg_values_supported: ['RS256'],
		scopes_supported: ['openid', 'email', 'profile'],
		token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
		code_challenge_methods_supported: ['S256'],
	};
	ctx.response.headers.set('Content-Type', 'application/json');
	ctx.response.send(doc);
}

/** Return the JWKS containing the public key. */
export async function handleJwks(providerName: string, ctx: BlocksContext): Promise<void> {
	const { publicJwk } = await getKeyMaterial(providerName);
	ctx.response.headers.set('Content-Type', 'application/json');
	ctx.response.headers.set('Cache-Control', 'no-store');
	ctx.response.send({ keys: [publicJwk] });
}

/**
 * Auto-approving authorize endpoint. Validates required params, allocates an
 * authorization code tied to the PKCE challenge, and 302-redirects back to
 * the RP's callback URL with `code` + `state`.
 */
export async function handleAuthorize(provider: StubProvider, ctx: BlocksContext, dataDir?: string): Promise<void> {
	const req = parseAuthorizeRequest(ctx.request.url.searchParams, ctx);
	if (!req) return; // parse/validate failure already responded

	let user: StubUser | undefined;
	if (provider.onAuthorize) {
		try {
			user = await provider.onAuthorize({
				provider: provider.name,
				scopes: req.scopes,
				redirectUri: req.redirectUri,
				state: req.state,
				nonce: req.nonce,
				loginHint: req.loginHint,
				users: stubUserDirectory(provider.name, dataDir),
			});
		} catch {
			redirectWithError(ctx, req.redirectUri, req.state, 'access_denied', 'sign-in denied by onAuthorize');
			return;
		}
	}

	if (user) {
		issueCodeRedirect(ctx, req, user);
		return;
	}

	// No onAuthorize, or it returned undefined: show the interactive login screen.
	// Build the form action from the stage-aware issuer URL (not the bare path) so
	// the picker POST keeps the API Gateway stage prefix behind a deployed gateway.
	const authorizeAction = `${stubIssuerUrl(provider.name, ctx)}/authorize`;
	ctx.response.status = 200;
	ctx.response.headers.set('Content-Type', 'text/html');
	ctx.response.send(renderLoginPage(provider.name, stubUserDirectory(provider.name, dataDir), req, authorizeAction));
}

/** Login-screen form submission: resolve the picked user and issue the code. */
export async function handleAuthorizeSubmit(provider: StubProvider, ctx: BlocksContext, dataDir?: string): Promise<void> {
	const form = new URLSearchParams(await ctx.request.text());
	const req = parseAuthorizeRequest(form, ctx);
	if (!req) return;
	const user = stubUserDirectory(provider.name, dataDir).find((u) => u.sub === form.get('sub'))
		?? defaultUser(provider.name);
	issueCodeRedirect(ctx, req, user);
}

interface AuthorizeRequest {
	clientId: string;
	redirectUri: string;
	state: string;
	nonce: string;
	scopes: string[];
	codeChallenge: string;
	loginHint?: string;
}

/**
 * Parse + validate authorize params from either the GET query or the login
 * form's hidden fields (both `URLSearchParams`). Responds + returns null on
 * failure. The login form re-submits `response_type`/`code_challenge_method`
 * as hidden fields so this one validator covers both entry points.
 */
function parseAuthorizeRequest(params: URLSearchParams, ctx: BlocksContext): AuthorizeRequest | null {
	const clientId = params.get('client_id');
	const redirectUri = params.get('redirect_uri');
	const codeChallenge = params.get('code_challenge');

	if (!clientId || !redirectUri || params.get('response_type') !== 'code'
		|| !codeChallenge || params.get('code_challenge_method') !== 'S256') {
		ctx.response.status = 400;
		ctx.response.headers.set('Content-Type', 'text/plain');
		ctx.response.send('stub IdP: missing or invalid authorize request');
		return null;
	}

	// Reject redirect URIs the way real IdPs do — custom schemes, and query
	// strings carrying a reserved OAuth/OIDC response param. Without this the
	// stub gives a false green: tests pass while Google would refuse the URL.
	const rejection = redirectUriRejectionReason(redirectUri);
	if (rejection) {
		ctx.response.status = 400;
		ctx.response.headers.set('Content-Type', 'application/json');
		ctx.response.send({
			error: 'invalid_request',
			error_description: rejection,
		});
		return null;
	}

	return {
		clientId,
		redirectUri,
		state: params.get('state') ?? '',
		nonce: params.get('nonce') ?? '',
		scopes: (params.get('scope') ?? '').split(' ').filter(Boolean),
		codeChallenge,
		loginHint: params.get('login_hint') ?? undefined,
	};
}

/** Mint a self-contained code for `user` and 302 back to the RP callback. */
function issueCodeRedirect(ctx: BlocksContext, req: AuthorizeRequest, user: StubUser): void {
	// Self-contained HMAC-signed code: only the same stub IdP verifies it, so
	// no external validation and no server-side state across invocations.
	const code = stubCodeEncode({
		clientId: req.clientId,
		codeChallenge: req.codeChallenge,
		codeChallengeMethod: 'S256',
		state: req.state,
		nonce: req.nonce,
		redirectUri: req.redirectUri,
		scopes: req.scopes,
		user,
		exp: Math.floor(Date.now() / 1000) + 300, // 5 min
	});

	const target = new URL(req.redirectUri);
	target.searchParams.set('code', code);
	if (req.state) target.searchParams.set('state', req.state);

	ctx.response.status = 302;
	ctx.response.headers.set('Location', target.toString());
	ctx.response.send('');
}

/** 302 back to the RP callback with an OIDC error (e.g. user-denied consent). */
function redirectWithError(ctx: BlocksContext, redirectUri: string, state: string, error: string, description: string): void {
	const target = new URL(redirectUri);
	target.searchParams.set('error', error);
	target.searchParams.set('error_description', description);
	if (state) target.searchParams.set('state', state);
	ctx.response.status = 302;
	ctx.response.headers.set('Location', target.toString());
	ctx.response.send('');
}

/**
 * Token endpoint. Exchanges an authorization code for an ID token + access
 * token. Verifies PKCE, client credentials, and redirect URI.
 */
export async function handleToken(providerName: string, ctx: BlocksContext): Promise<void> {
	const body = await ctx.request.text();
	const form = new URLSearchParams(body);
	// `client_secret_basic` puts credentials in the Authorization header.
	const authHeader = ctx.request.headers.get('authorization') ?? '';
	const basic = parseBasicAuth(authHeader);
	const clientId = form.get('client_id') ?? basic?.user ?? null;

	const grantType = form.get('grant_type');
	if (grantType === 'refresh_token') {
		await handleRefreshGrant(providerName, form, clientId, ctx);
		return;
	}
	if (grantType !== 'authorization_code') {
		ctx.response.status = 400;
		ctx.response.send({ error: 'unsupported_grant_type' });
		return;
	}
	const code = form.get('code');
	const redirectUri = form.get('redirect_uri');
	const codeVerifier = form.get('code_verifier');

	// Decode the self-contained code JWT (no in-memory state needed).
	let pending: PendingAuth | null = null;
	if (code) {
		pending = stubCodeDecode(code);
	}
	if (!pending) {
		ctx.response.status = 400;
		ctx.response.send({ error: 'invalid_grant', error_description: 'unknown or expired code' });
		return;
	}

	if (!clientId || clientId !== pending.clientId) {
		ctx.response.status = 400;
		ctx.response.send({ error: 'invalid_client' });
		return;
	}
	if (redirectUri !== pending.redirectUri) {
		ctx.response.status = 400;
		ctx.response.send({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
		return;
	}
	// Reject custom schemes at the token endpoint as defense in depth — if
	// a code somehow slipped through with a bad redirect_uri, catch it here
	// before issuing tokens.
	const tokenRejection = redirectUri ? redirectUriRejectionReason(redirectUri) : null;
	if (tokenRejection) {
		ctx.response.status = 400;
		ctx.response.send({ error: 'invalid_request', error_description: tokenRejection });
		return;
	}
	if (!codeVerifier || (await s256(codeVerifier)) !== pending.codeChallenge) {
		ctx.response.status = 400;
		ctx.response.send({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
		return;
	}

	const issuer = stubIssuerUrl(providerName, ctx);
	const { privateKey, kid } = await getKeyMaterial(providerName);
	const now = Math.floor(Date.now() / 1000);

	const idToken = await buildStubIdToken({
		issuer,
		audience: pending.clientId,
		subject: pending.user.sub,
		nonce: pending.nonce,
		claims: {
			email: pending.user.email,
			email_verified: true,
			name: pending.user.name,
			...pending.user.extra,
		},
		now,
		privateKey,
		kid,
	});

	const accessToken = await signAccessToken(providerName, issuer, pending.clientId, pending.user.sub, now);
	const refreshToken = randomToken();
	refreshTokens.set(refreshToken, {
		clientId: pending.clientId,
		sub: pending.user.sub,
		email: pending.user.email,
		name: pending.user.name,
		uses: 0,
	});

	ctx.response.headers.set('Content-Type', 'application/json');
	ctx.response.headers.set('Cache-Control', 'no-store');
	ctx.response.send({
		access_token: accessToken,
		token_type: 'Bearer',
		expires_in: 3600,
		refresh_token: refreshToken,
		id_token: idToken,
		scope: pending.scopes.join(' '),
	});
}

/** OAuth-2.0-only userinfo for providers that don't issue ID tokens. */
export async function handleUserInfo(providerName: string, ctx: BlocksContext): Promise<void> {
	// Access-token → user binding isn't tracked; always return the default user.
	const user = defaultUser(providerName);
	ctx.response.headers.set('Content-Type', 'application/json');
	ctx.response.send({ sub: user.sub, email: user.email, name: user.name });
}

/**
 * In-memory ledger of refresh tokens the stub has issued. Each entry
 * remembers the original `clientId` (so token-endpoint calls can be
 * validated) and the `sub` to embed in rotated ID tokens.
 */
interface RefreshEntry {
	clientId: string;
	sub: string;
	email: string;
	name: string;
	/** Number of times this entry has been used for a refresh grant. */
	uses: number;
}

const refreshTokens = new Map<string, RefreshEntry>();

/**
 * Handle a `grant_type=refresh_token` request.
 *
 * - Validates the refresh token against the in-memory ledger
 * - Rotates the refresh token (matches Google, Cognito with rotation on, and
 *   most current providers)
 * - Signs a new ID token + returns a new access token
 */
async function handleRefreshGrant(
	providerName: string,
	form: URLSearchParams,
	clientId: string | null,
	ctx: BlocksContext,
): Promise<void> {
	const refreshToken = form.get('refresh_token');
	const entry = refreshToken ? refreshTokens.get(refreshToken) : null;
	if (!refreshToken || !entry) {
		ctx.response.status = 400;
		ctx.response.send({ error: 'invalid_grant', error_description: 'unknown refresh token' });
		return;
	}
	if (!clientId || clientId !== entry.clientId) {
		ctx.response.status = 400;
		ctx.response.send({ error: 'invalid_client' });
		return;
	}
	entry.uses += 1;

	const issuer = stubIssuerUrl(providerName, ctx);
	const { privateKey, kid } = await getKeyMaterial(providerName);
	const now = Math.floor(Date.now() / 1000);

	// Rotate: mint a new refresh token, invalidate the old one.
	refreshTokens.delete(refreshToken);
	const newRefresh = randomToken();
	refreshTokens.set(newRefresh, { ...entry, uses: 0 });

	const idToken = await buildStubIdToken({
		issuer,
		audience: entry.clientId,
		subject: entry.sub,
		nonce: '',
		claims: { email: entry.email, email_verified: true, name: entry.name },
		now,
		privateKey,
		kid,
	});
	const accessToken = await signAccessToken(providerName, issuer, entry.clientId, entry.sub, now);
	ctx.response.headers.set('Content-Type', 'application/json');
	ctx.response.headers.set('Cache-Control', 'no-store');
	ctx.response.send({
		access_token: accessToken,
		token_type: 'Bearer',
		expires_in: 3600,
		refresh_token: newRefresh,
		id_token: idToken,
		scope: 'openid email profile',
	});
}

/**
 * Revocation endpoint. Accepts a `token` + `token_type_hint` and
 * invalidates the refresh token from the in-memory ledger. Always
 * returns 200 (per RFC 7009 — even for unknown tokens).
 */
export async function handleRevoke(providerName: string, ctx: BlocksContext): Promise<void> {
	const body = await ctx.request.text();
	const form = new URLSearchParams(body);
	const token = form.get('token');
	if (token) {
		refreshTokens.delete(token);
	}
	ctx.response.status = 200;
	ctx.response.headers.set('Content-Type', 'application/json');
	ctx.response.send({});
}

/**
 * Fixed HMAC secret for signing authorization codes. This is NOT a security
 * boundary — the stub IdP is a test double. The secret just ensures codes
 * can't be forged by test code that doesn't know it.
 */
const STUB_CODE_SECRET = 'blocks-stub-idp-code-signing-secret-not-for-production';

/** Encode a PendingAuth payload into a self-contained HMAC-signed code. */
function stubCodeEncode(payload: object): string {
	const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
	const mac = createHmac('sha256', STUB_CODE_SECRET).update(body).digest('base64url');
	return `${body}.${mac}`;
}

/** Decode and verify a self-contained code. Returns null if invalid or expired. */
function stubCodeDecode(code: string): PendingAuth | null {
	try {
		const dotIdx = code.lastIndexOf('.');
		if (dotIdx < 0) return null;
		const body = code.slice(0, dotIdx);
		const mac = code.slice(dotIdx + 1);
		const expected = createHmac('sha256', STUB_CODE_SECRET).update(body).digest('base64url');
		if (mac !== expected) return null;
		const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
		if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
		return {
			clientId: payload.clientId,
			codeChallenge: payload.codeChallenge,
			codeChallengeMethod: payload.codeChallengeMethod,
			state: payload.state,
			nonce: payload.nonce,
			redirectUri: payload.redirectUri,
			scopes: payload.scopes,
			user: payload.user,
			expiresAt: payload.exp * 1000,
		};
	} catch {
		return null;
	}
}

/** Crypto-strong URL-safe token. */
function randomToken(): string {
	const bytes = new Uint8Array(32);
	globalThis.crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString('base64url');
}

/** SHA-256 → base64url, matching PKCE S256. */
async function s256(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const hash = await globalThis.crypto.subtle.digest('SHA-256', data);
	return Buffer.from(hash).toString('base64url');
}

function parseBasicAuth(header: string): { user: string; pass: string } | null {
	if (!header.toLowerCase().startsWith('basic ')) return null;
	try {
		const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
		const idx = decoded.indexOf(':');
		if (idx < 0) return null;
		return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
	} catch {
		return null;
	}
}

interface BuildStubIdTokenArgs {
	issuer: string;
	audience: string;
	subject: string;
	nonce: string;
	claims: Record<string, unknown>;
	now: number;
	privateKey: CryptoKey;
	kid: string;
}

async function buildStubIdToken(args: BuildStubIdTokenArgs): Promise<string> {
	const { issuer, audience, subject, nonce, privateKey, kid } = args;
	const claims: Record<string, unknown> = {
		...args.claims,
		nonce: nonce || undefined,
	};

	return new SignJWT(claims)
		.setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
		.setIssuer(issuer)
		.setSubject(subject)
		.setAudience(audience)
		.setIssuedAt(args.now)
		.setExpirationTime(args.now + 3600)
		.sign(privateKey);
}

/** The bearer verifier requires a JWT it can validate against the JWKS, so `/token` issues one (not an opaque string). */
async function signAccessToken(providerName: string, issuer: string, audience: string, sub: string, now: number): Promise<string> {
	const { privateKey, kid } = await getKeyMaterial(providerName);
	return new SignJWT({})
		.setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
		.setIssuer(issuer)
		.setSubject(sub)
		.setAudience(audience)
		.setIssuedAt(now)
		.setExpirationTime(now + 3600)
		.sign(privateKey);
}

/** HTML-escape a value for safe interpolation into the login page. */
function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * Render the stub IdP's account-picker login screen. Server-rendered HTML
 * string (this runs at the `/authorize` endpoint, not in a browser). The
 * form POSTs the picked `sub` back to the same path along with the authorize
 * params as hidden fields, so the submit handler can issue the code.
 *
 * Styling mirrors the inline-style convention used by the local dev pages in
 * `core/src/builtin-routes.ts`.
 */
function renderLoginPage(providerName: string, users: StubUser[], req: AuthorizeRequest, action: string): string {
	const hidden = (name: string, value: string) =>
		`<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;

	const options = users.map((u, i) => `
		<label style="display:flex;align-items:center;gap:8px;padding:8px;border:1px solid #ddd;border-radius:6px;margin-bottom:8px;cursor:pointer">
			<input type="radio" name="sub" value="${escapeHtml(u.sub)}"${i === 0 ? ' checked' : ''}>
			<span><strong>${escapeHtml(u.name)}</strong><br><span style="color:#666;font-size:13px">${escapeHtml(u.email)}</span></span>
		</label>`).join('');

	return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sign in — Blocks stub IdP</title>`
		+ `<style>body{font-family:system-ui,sans-serif;max-width:400px;margin:4rem auto;padding:0 1rem;color:#1a1a1a}`
		+ `h1{font-size:1.25rem}button{padding:8px 16px;cursor:pointer;border:0;border-radius:6px;background:#1a1a1a;color:#fff}</style>`
		+ `</head><body>`
		+ `<h1>Blocks stub IdP: sign in</h1>`
		+ `<p style="color:#666;font-size:14px">Local sign-in for <strong>${escapeHtml(providerName)}</strong>. No real credentials.</p>`
		+ `<form method="POST" action="${escapeHtml(action)}">`
		+ options
		+ hidden('client_id', req.clientId)
		+ hidden('redirect_uri', req.redirectUri)
		+ hidden('response_type', 'code')
		+ hidden('state', req.state)
		+ hidden('nonce', req.nonce)
		+ hidden('scope', req.scopes.join(' '))
		+ hidden('code_challenge', req.codeChallenge)
		+ hidden('code_challenge_method', 'S256')
		+ (req.loginHint ? hidden('login_hint', req.loginHint) : '')
		+ `<button type="submit">Continue</button>`
		+ `</form></body></html>`;
}

/**
 * Check whether a redirect_uri is acceptable to the stub IdP.
 *
 * Real IdPs (Google, Microsoft Entra, Okta, Auth0) reject anything that
 * isn't `https://` or loopback `http://` at the authorize endpoint. This
 * function replicates that behavior so the stub catches the regression
 * that motivated the relay design: if someone accidentally sends
 * `myapp://callback` as the redirect_uri to the IdP, the test fails the
 * same way production would.
 *
 * Loopback hosts: `127.0.0.1`, `[::1]`, and `localhost` (per RFC 8252
 * §7.3 and Google's OAuth implementation which accepts localhost for
 * development flows).
 */
function isAllowedRedirectUri(uri: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		return false;
	}
	const scheme = parsed.protocol.slice(0, -1).toLowerCase();
	if (scheme === 'https') return true;
	if (scheme === 'http') {
		const host = parsed.hostname.toLowerCase();
		return host === '127.0.0.1' || host === '[::1]' || host === 'localhost';
	}
	return false;
}

/**
 * OAuth 2.0 / OIDC response parameters that an authorization server itself
 * appends to the redirect_uri. Google rejects a registered or requested
 * redirect_uri whose query already contains any of these, because the IdP
 * would otherwise have to duplicate or clobber the parameter on the way back.
 */
const RESERVED_RESPONSE_PARAMS = new Set([
	'scope',
	'code',
	'state',
	'error',
	'response_type',
	'access_token',
	'token_type',
	'id_token',
	'expires_in',
	'session_state',
	'iss',
]);

/**
 * Validate a redirect_uri the way a real IdP does, returning an
 * `error_description` string when it must be rejected, or `null` when it is
 * acceptable.
 *
 * Two rules are enforced:
 * 1. Scheme — HTTPS or loopback HTTP only (see {@link isAllowedRedirectUri}).
 * 2. No reserved OAuth/OIDC response parameter in the query string. Google
 *    fails with "Invalid redirect_uri: contains reserved response param
 *    scope"; the stub mirrors that wording so a test failure here reads the
 *    same as the production failure.
 *
 * Known remaining permissiveness vs. Google (deliberate, documented gaps):
 * - No exact-match registration check: the stub has no registered
 *   redirect_uri allowlist (providers are declared by name only, and the app
 *   derives its own callback URL at runtime), so it cannot reject an
 *   otherwise-valid URI that a real IdP would refuse for not exactly matching
 *   a pre-registered value — including extra non-reserved query params.
 * - Custom schemes are rejected outright here, whereas real IdPs accept them
 *   only for registered native/installed-app clients.
 * - PKCE is required unconditionally by the stub and is not validated against
 *   per-client registration policy.
 */
function redirectUriRejectionReason(uri: string): string | null {
	if (!isAllowedRedirectUri(uri)) return 'redirect_uri must be HTTPS or loopback HTTP';
	const { searchParams } = new URL(uri);
	for (const name of searchParams.keys()) {
		if (RESERVED_RESPONSE_PARAMS.has(name.toLowerCase())) {
			return `Invalid redirect_uri: contains reserved response param ${name.toLowerCase()}`;
		}
	}
	return null;
}

