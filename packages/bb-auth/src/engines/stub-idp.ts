// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The **stub IdP** — a real, spec-conformant OIDC provider served in-process
 * by the local dev server, carried over from `bb-auth-oidc` (mock entry only).
 *
 * Mock entry, plus — only for a provider with `unsafeAllowDeployed: true` — the
 * AWS entry, which loads this module lazily (`stub-idp-routes.ts` mounts the
 * routes; `index.aws.ts` dynamically imports this file only on that path).
 *
 * Each `stubIdp()` provider gets its own issuer, mounted as `RawRoute`s:
 *
 * | Method | Path (under `/aws-blocks/auth/idp/<id>`) | |
 * |---|---|---|
 * | GET  | `/.well-known/openid-configuration` | discovery document |
 * | GET  | `/jwks.json` | the ES256 public key |
 * | GET  | `/authorize` | validates the request (PKCE S256 required), then the account picker |
 * | POST | `/authorize` | the picker's submit → `302 redirect_uri?code&state` |
 * | POST | `/token` | `authorization_code` (real PKCE S256 check) and `refresh_token` (rotating) |
 * | GET  | `/userinfo` | verifies the bearer access token, returns the profile |
 * | POST | `/revoke` | RFC 7009 |
 * | GET  | `/logout` | `end_session_endpoint` → `302 post_logout_redirect_uri` (registered URIs only, else `400`) |
 *
 * Both `/authorize` routes, like a real IdP, accept only the registered client:
 * its `client_id`, and a `redirect_uri` registered for it — the app's own
 * federation callback (see {@link registeredRedirectUris}). Anything else is a
 * `400` error page, never a redirect (RFC 6749 §4.1.2.1: the server "MUST NOT
 * automatically redirect" to a mismatching redirection URI), checked before the
 * account picker renders, `onAuthorize` runs, or any code or error is sent.
 *
 * Tokens are signed with a real ES256 key pair (`jose`), so the direct engine
 * runs exactly the JWKS-fetch + signature-verify path it runs against a real
 * IdP. Authorization codes are self-contained and HMAC-signed (no server
 * state between `/authorize` and `/token`).
 *
 * **No per-process state is needed to verify anything.** The signing key, the
 * code-signing key and the refresh-token key are all derived (HKDF-SHA256)
 * from the `Auth` block's session secret — on AWS the `session-secret` SSM
 * parameter, locally `.bb-data/<fullId>/state.json` — with a per-provider
 * label. So every Lambda instance (and every dev-server restart) signs with
 * the same key and serves the same JWKS: a token minted by one instance
 * verifies on another, and an authorize answered by one instance redeems at
 * another's `/token`. Refresh tokens are self-contained too; rotation and
 * revocation are remembered per process (exact on the single-process dev
 * server, best-effort across Lambda instances). And because the keys are a
 * deployment's own secret, not a constant in this file, nobody can mint a
 * code or token for a user the stub did not sign in.
 *
 * The user directory: the provider's inline `users` → `.bb-data/<fullId>/users.json`
 * (the `bb-auth-oidc` fixture file) → one deterministic default user.
 *
 * Not a security boundary — a test double. `bb-auth-oidc`'s keys and refresh
 * tokens lived in process memory, so a dev-server restart signed stub sessions
 * out; these keys derive from the session secret, so a restart no longer does.
 * Deployed with `unsafeAllowDeployed`, it is still not a security boundary: its
 * account picker signs anyone in as the stub's users.
 *
 * @internal
 */

import {
	createECDH,
	createHash,
	createHmac,
	createPrivateKey,
	createPublicKey,
	hkdfSync,
	type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BlocksContext } from '@aws-blocks/core';
import { constantTimeEquals } from '@aws-blocks/core/bb-utils';
import { type JWK, jwtVerify, SignJWT } from 'jose';
import type { StubIdpSettings, StubUser } from '../types.js';
import { appBaseUrl, pkceChallenge } from './federation-direct.js';
import { type StubIdpHandlers, stubIssuerPath } from './stub-idp-routes.js';

export { STUB_ROOT, stubIssuerPath, stubIssuerUrl } from './stub-idp-routes.js';

/** The JWS algorithm of every token the stub signs (a P-256 key derives deterministically; RSA does not). */
const SIGNING_ALG = 'ES256';

/** HKDF-SHA256 of the session secret, under a stub-IdP salt and `label`. */
function derive(secret: string, label: string): Buffer {
	return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), 'aws-blocks-stub-idp', label, 32));
}

interface KeyMaterial {
	privateKey: KeyObject;
	publicKey: KeyObject;
	publicJwk: JWK;
	kid: string;
	/** HMAC key of the self-contained authorization codes. */
	codeKey: Buffer;
	/** HMAC key of the self-contained refresh tokens. */
	refreshKey: Buffer;
}

/**
 * The provider's keys, derived from `secret`: the same secret always yields
 * the same P-256 signing key (and `kid`), so every process serving this
 * provider signs and publishes the same key.
 */
export function deriveStubKeys(secret: string, providerId: string): KeyMaterial {
	const ecdh = createECDH('prime256v1');
	let d: Buffer | undefined;
	// A 32-byte HKDF output is a valid P-256 scalar unless it is 0 or ≥ n
	// (probability ~2^-32); the counter makes the derivation total.
	for (let i = 0; !d; i++) {
		const candidate = derive(secret, `signing-key:${providerId}:${i}`);
		try {
			ecdh.setPrivateKey(candidate);
			d = candidate;
		} catch {
			// out of range: try the next counter
		}
	}
	const point = ecdh.getPublicKey(); // uncompressed: 0x04 || X || Y
	const x = point.subarray(1, 33).toString('base64url');
	const y = point.subarray(33, 65).toString('base64url');
	const privateKey = createPrivateKey({
		key: { kty: 'EC', crv: 'P-256', x, y, d: d.toString('base64url') },
		format: 'jwk',
	});
	const publicKey = createPublicKey(privateKey);
	const thumb = createHash('sha256').update(point).digest('base64url').slice(0, 16);
	const kid = `stub-${providerId}-${thumb}`;
	const publicJwk: JWK = { kty: 'EC', crv: 'P-256', x, y, kid, use: 'sig', alg: SIGNING_ALG };
	return {
		privateKey,
		publicKey,
		publicJwk,
		kid,
		codeKey: derive(secret, `code:${providerId}`),
		refreshKey: derive(secret, `refresh-token:${providerId}`),
	};
}

/** The default user when no directory is configured. */
export function defaultStubUser(providerId: string): StubUser {
	return {
		sub: `stub-${providerId}-user`,
		email: `${providerId}-user@stub.invalid`,
		name: `Stub ${providerId} User`,
	};
}

function isStubUser(u: unknown): u is StubUser {
	if (typeof u !== 'object' || u === null) return false;
	const sub: unknown = Reflect.get(u, 'sub');
	const email: unknown = Reflect.get(u, 'email');
	const name: unknown = Reflect.get(u, 'name');
	return typeof sub === 'string' && typeof email === 'string' && typeof name === 'string';
}

/** Inline users → `users.json` in `dataDir` → the default user. Never throws. */
export function stubUserDirectory(providerId: string, settings: StubIdpSettings, dataDir?: string): StubUser[] {
	if (settings.users && settings.users.length > 0) return [...settings.users];
	if (dataDir) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(join(dataDir, 'users.json'), 'utf8'));
			const users = Array.isArray(parsed) ? parsed.filter(isStubUser) : [];
			if (users.length > 0) return users;
		} catch {
			// No file, or bad JSON: the default user.
		}
	}
	return [defaultStubUser(providerId)];
}

// ── Codes and refresh tokens ────────────────────────────────────────────────

interface CodePayload {
	clientId: string;
	codeChallenge: string;
	state: string;
	nonce: string;
	redirectUri: string;
	scopes: string[];
	user: StubUser;
	exp: number;
}

/** `<base64url JSON>.<HMAC-SHA256>` under `key`. */
function seal(key: Buffer, payload: object): string {
	const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
	return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}

/** The JSON object {@link seal} wrapped, or `null` if the MAC does not verify. */
function unseal(key: Buffer, sealed: string): object | null {
	const dot = sealed.lastIndexOf('.');
	if (dot <= 0) return null;
	const body = sealed.slice(0, dot);
	if (!constantTimeEquals(sealed.slice(dot + 1), createHmac('sha256', key).update(body).digest('base64url'))) {
		return null;
	}
	try {
		const raw: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
		return typeof raw === 'object' && raw !== null ? raw : null;
	} catch {
		return null;
	}
}

function encodeCode(key: Buffer, payload: CodePayload): string {
	return seal(key, payload);
}

function decodeCode(key: Buffer, code: string): CodePayload | null {
	const raw = unseal(key, code);
	if (!raw) return null;
	const get = (k: string): unknown => Reflect.get(raw, k);
	const exp = get('exp');
	const user = get('user');
	const scopes = get('scopes');
	if (typeof exp !== 'number' || exp <= Math.floor(Date.now() / 1000) || !isStubUser(user)) return null;
	const str = (k: string): string => {
		const v = get(k);
		return typeof v === 'string' ? v : '';
	};
	return {
		clientId: str('clientId'),
		codeChallenge: str('codeChallenge'),
		state: str('state'),
		nonce: str('nonce'),
		redirectUri: str('redirectUri'),
		scopes: Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === 'string') : [],
		user,
		exp,
	};
}

/** Refresh tokens live 30 days, like a typical IdP's. */
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 3600;

interface RefreshEntry {
	/** The token's id, remembered once it is spent (rotated or revoked). */
	jti: string;
	clientId: string;
	user: StubUser;
	exp: number;
}

function encodeRefreshToken(key: Buffer, entry: RefreshEntry): string {
	return seal(key, entry);
}

function decodeRefreshToken(key: Buffer, token: string): RefreshEntry | null {
	const raw = unseal(key, token);
	if (!raw) return null;
	const jti: unknown = Reflect.get(raw, 'jti');
	const clientId: unknown = Reflect.get(raw, 'clientId');
	const user: unknown = Reflect.get(raw, 'user');
	const exp: unknown = Reflect.get(raw, 'exp');
	if (typeof jti !== 'string' || typeof clientId !== 'string' || !isStubUser(user) || typeof exp !== 'number') {
		return null;
	}
	if (exp <= Math.floor(Date.now() / 1000)) return null;
	return { jti, clientId, user, exp };
}

/**
 * Whether a value the client presented equals the one the stub bound into a
 * code or token (PKCE challenge, client id, redirect URI), in constant time —
 * the stub can be deployed (`unsafeAllowDeployed`), so it compares like a real
 * IdP. A missing value, an empty expected value, or one of another length or
 * encoding is a mismatch, never a throw.
 */
export function stubValueMatches(presented: string | null | undefined, expected: string): boolean {
	if (typeof presented !== 'string' || presented.length === 0 || expected.length === 0) return false;
	return constantTimeEquals(presented, expected);
}

function randomToken(): string {
	const bytes = new Uint8Array(32);
	globalThis.crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString('base64url');
}

// ── Redirect-URI policy (what real IdPs enforce) ────────────────────────────

/**
 * Reserved OAuth/OIDC response parameters a real IdP (Google) refuses in a
 * `redirect_uri`'s query, since it would have to clobber them. Case-sensitive,
 * like OAuth parameter names.
 */
const RESERVED_RESPONSE_PARAMS = new Set([
	'scope',
	'code',
	'state',
	'error',
	'error_description',
	'error_uri',
	'response_type',
	'access_token',
	'token_type',
	'id_token',
	'expires_in',
	'session_state',
	'iss',
]);

/**
 * Why a real IdP would reject `uri` as a `redirect_uri`, or `null`: HTTPS or
 * loopback HTTP only, no fragment, no reserved response parameter. Custom
 * schemes are rejected — which is what forces native apps onto the relay.
 */
export function redirectUriRejectionReason(uri: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		return 'redirect_uri must be HTTPS or loopback HTTP';
	}
	const scheme = parsed.protocol.slice(0, -1).toLowerCase();
	const host = parsed.hostname.toLowerCase();
	const loopback = host === '127.0.0.1' || host === '[::1]' || host === 'localhost';
	if (!(scheme === 'https' || (scheme === 'http' && loopback))) return 'redirect_uri must be HTTPS or loopback HTTP';
	if (parsed.hash) return 'Invalid redirect_uri: must not contain a fragment';
	for (const name of parsed.searchParams.keys()) {
		if (RESERVED_RESPONSE_PARAMS.has(name)) return `Invalid redirect_uri: contains reserved response param ${name}`;
	}
	return null;
}

// ── Handlers ────────────────────────────────────────────────────────────────

/** What one stub provider's handlers share (built by {@link createStubIdp}). */
interface StubInstance {
	providerId: string;
	settings: StubIdpSettings;
	/** `.bb-data/<fullId>/` for the `users.json` fixture; `undefined` when deployed. */
	dataDir: () => string | undefined;
	client: StubClientRegistration;
	/** The issuer URL for a request (see `stubIssuerUrl`). */
	issuer: (ctx: BlocksContext) => string;
	keys: () => Promise<KeyMaterial>;
	/** Spent refresh-token ids (rotated or revoked) → their expiry, in seconds. This process only. */
	spent: Map<string, number>;
}

function json(ctx: BlocksContext, status: number, body: unknown): void {
	ctx.response.status = status;
	ctx.response.headers.set('Content-Type', 'application/json');
	ctx.response.headers.set('Cache-Control', 'no-store');
	ctx.response.send(body);
}

function redirect(ctx: BlocksContext, location: string): void {
	ctx.response.status = 302;
	ctx.response.headers.set('Location', location);
	ctx.response.send('');
}

async function handleDiscovery(stub: StubInstance, ctx: BlocksContext): Promise<void> {
	const issuer = stub.issuer(ctx);
	await stub.keys();
	json(ctx, 200, {
		issuer,
		authorization_endpoint: `${issuer}/authorize`,
		token_endpoint: `${issuer}/token`,
		jwks_uri: `${issuer}/jwks.json`,
		userinfo_endpoint: `${issuer}/userinfo`,
		revocation_endpoint: `${issuer}/revoke`,
		end_session_endpoint: `${issuer}/logout`,
		response_types_supported: ['code'],
		subject_types_supported: ['public'],
		id_token_signing_alg_values_supported: [SIGNING_ALG],
		scopes_supported: ['openid', 'email', 'profile'],
		token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
		code_challenge_methods_supported: ['S256'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
	});
}

async function handleJwks(stub: StubInstance, ctx: BlocksContext): Promise<void> {
	const { publicJwk } = await stub.keys();
	json(ctx, 200, { keys: [publicJwk] });
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
 * The `redirect_uri`s registered for the stub's client, for this request: each
 * of the client's registered paths (the `Auth` instance's
 * `redirects.callbackPath`) on every front door the app's callback is reached
 * through — the same two origins hosted-UI federation registers as Cognito
 * callback URLs (`frontDoorUrls` in `cdk/federation.ts`):
 *
 * - the app base, `appBaseUrl(ctx)` (`BLOCKS_PUBLIC_ORIGIN`, else this request's
 *   origin plus stage) — what the direct engine builds its `redirect_uri` from,
 *   and the base `/logout` checks `post_logout_redirect_uri` against;
 * - the stub's own issuer base (the issuer URL minus its `/aws-blocks/auth/idp/<id>`
 *   path): locally this request's origin, deployed the API Gateway URL the CDK
 *   layer registered — the server the native SDKs (Kotlin, Swift, Dart) build
 *   their relay `redirect_uri` from (`<server>/aws-blocks/auth/callback`).
 *
 * Compared exactly, as a real IdP compares a registered redirect URI.
 */
export function registeredRedirectUris(
	client: StubClientRegistration,
	providerId: string,
	issuer: string,
	ctx: BlocksContext,
): string[] {
	const issuerPath = stubIssuerPath(providerId);
	const issuerBase = issuer.endsWith(issuerPath) ? issuer.slice(0, -issuerPath.length) : issuer;
	const bases = [...new Set([appBaseUrl(ctx), issuerBase])];
	return [...new Set(bases.flatMap((base) => client.redirectPaths.map((path) => `${base}${path}`)))];
}

/**
 * Validate an authorize request (query or the picker's hidden fields); respond + `null` on failure.
 * A foreign `client_id` or an unregistered `redirect_uri` is a `400` with no redirect.
 */
function parseAuthorizeRequest(
	stub: StubInstance,
	params: URLSearchParams,
	ctx: BlocksContext,
): AuthorizeRequest | null {
	const clientId = params.get('client_id');
	const redirectUri = params.get('redirect_uri');
	const codeChallenge = params.get('code_challenge');
	if (
		!clientId ||
		!redirectUri ||
		params.get('response_type') !== 'code' ||
		!codeChallenge ||
		params.get('code_challenge_method') !== 'S256'
	) {
		ctx.response.status = 400;
		ctx.response.headers.set('Content-Type', 'text/plain');
		ctx.response.send('AWS Blocks stub IdP: missing or invalid authorize request (PKCE S256 is required)');
		return null;
	}
	// RFC 6749 §4.1.2.1: an unknown client or an unregistered redirect URI is
	// reported to the user, never redirected to.
	if (!stubValueMatches(clientId, stub.client.clientId)) {
		json(ctx, 400, { error: 'invalid_request', error_description: 'unknown client_id' });
		return null;
	}
	const rejection = redirectUriRejectionReason(redirectUri);
	if (rejection) {
		json(ctx, 400, { error: 'invalid_request', error_description: rejection });
		return null;
	}
	const registered = registeredRedirectUris(stub.client, stub.providerId, stub.issuer(ctx), ctx);
	if (!registered.some((uri) => stubValueMatches(redirectUri, uri))) {
		json(ctx, 400, {
			error: 'invalid_request',
			error_description:
				'redirect_uri is not registered for this client. The AWS Blocks stub IdP accepts only the ' +
				`app's own sign-in callback (redirects.callbackPath): ${registered.join(', ')}.`,
		});
		return null;
	}
	const loginHint = params.get('login_hint');
	return {
		clientId,
		redirectUri,
		state: params.get('state') ?? '',
		nonce: params.get('nonce') ?? '',
		scopes: (params.get('scope') ?? '').split(' ').filter(Boolean),
		codeChallenge,
		...(loginHint ? { loginHint } : {}),
	};
}

async function issueCodeRedirect(
	stub: StubInstance,
	ctx: BlocksContext,
	req: AuthorizeRequest,
	user: StubUser,
): Promise<void> {
	const { codeKey } = await stub.keys();
	const code = encodeCode(codeKey, {
		clientId: req.clientId,
		codeChallenge: req.codeChallenge,
		state: req.state,
		nonce: req.nonce,
		redirectUri: req.redirectUri,
		scopes: req.scopes,
		user,
		exp: Math.floor(Date.now() / 1000) + 300,
	});
	const target = new URL(req.redirectUri);
	target.searchParams.set('code', code);
	if (req.state) target.searchParams.set('state', req.state);
	redirect(ctx, target.toString());
}

/** An error back to the client. Only ever for a request {@link parseAuthorizeRequest} validated (registered `redirect_uri`). */
function redirectWithError(ctx: BlocksContext, req: AuthorizeRequest, error: string, description: string): void {
	const target = new URL(req.redirectUri);
	target.searchParams.set('error', error);
	target.searchParams.set('error_description', description);
	if (req.state) target.searchParams.set('state', req.state);
	redirect(ctx, target.toString());
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** The server-rendered account picker. Its form re-submits the authorize parameters. */
function renderLoginPage(providerId: string, users: StubUser[], req: AuthorizeRequest, action: string): string {
	const hidden = (name: string, value: string) =>
		`<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
	const options = users
		.map(
			(u, i) =>
				`<label style="display:flex;align-items:center;gap:8px;padding:8px;border:1px solid #ddd;border-radius:6px;margin-bottom:8px;cursor:pointer">` +
				`<input type="radio" name="sub" value="${escapeHtml(u.sub)}"${i === 0 ? ' checked' : ''}>` +
				`<span><strong>${escapeHtml(u.name)}</strong><br><span style="color:#666;font-size:13px">${escapeHtml(u.email)}</span></span>` +
				'</label>',
		)
		.join('');
	return (
		'<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sign in — AWS Blocks stub IdP</title>' +
		'<style>body{font-family:system-ui,sans-serif;max-width:400px;margin:4rem auto;padding:0 1rem;color:#1a1a1a}' +
		'h1{font-size:1.25rem}button{padding:8px 16px;cursor:pointer;border:0;border-radius:6px;background:#1a1a1a;color:#fff}</style>' +
		'</head><body>' +
		'<h1>AWS Blocks stub IdP: sign in</h1>' +
		`<p style="color:#666;font-size:14px">Local sign-in for <strong>${escapeHtml(providerId)}</strong>. No real credentials.</p>` +
		`<form method="POST" action="${escapeHtml(action)}">` +
		options +
		hidden('client_id', req.clientId) +
		hidden('redirect_uri', req.redirectUri) +
		hidden('response_type', 'code') +
		hidden('state', req.state) +
		hidden('nonce', req.nonce) +
		hidden('scope', req.scopes.join(' ')) +
		hidden('code_challenge', req.codeChallenge) +
		hidden('code_challenge_method', 'S256') +
		(req.loginHint ? hidden('login_hint', req.loginHint) : '') +
		'<button type="submit">Continue</button>' +
		'</form></body></html>'
	);
}

async function handleAuthorize(stub: StubInstance, ctx: BlocksContext): Promise<void> {
	const { providerId, settings } = stub;
	const req = parseAuthorizeRequest(stub, ctx.request.url.searchParams, ctx);
	if (!req) return;
	const users = stubUserDirectory(providerId, settings, stub.dataDir());
	if (settings.onAuthorize) {
		let user: StubUser | undefined;
		try {
			user = await settings.onAuthorize({
				provider: providerId,
				scopes: req.scopes,
				redirectUri: req.redirectUri,
				state: req.state,
				nonce: req.nonce,
				...(req.loginHint ? { loginHint: req.loginHint } : {}),
				users,
			});
		} catch {
			redirectWithError(ctx, req, 'access_denied', 'sign-in denied by onAuthorize');
			return;
		}
		if (user) {
			await issueCodeRedirect(stub, ctx, req, user);
			return;
		}
	}
	// Post back to the stage-aware issuer URL, so the picker works behind a gateway stage.
	const action = `${stub.issuer(ctx)}/authorize`;
	ctx.response.status = 200;
	ctx.response.headers.set('Content-Type', 'text/html; charset=utf-8');
	ctx.response.send(renderLoginPage(providerId, users, req, action));
}

async function handleAuthorizeSubmit(stub: StubInstance, ctx: BlocksContext): Promise<void> {
	const { providerId, settings } = stub;
	const form = new URLSearchParams(await ctx.request.text());
	const req = parseAuthorizeRequest(stub, form, ctx);
	if (!req) return;
	const users = stubUserDirectory(providerId, settings, stub.dataDir());
	const user = users.find((u) => u.sub === form.get('sub')) ?? users[0] ?? defaultStubUser(providerId);
	await issueCodeRedirect(stub, ctx, req, user);
}

function parseBasicAuth(header: string): { user: string; pass: string } | null {
	if (!header.toLowerCase().startsWith('basic ')) return null;
	try {
		const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
		const idx = decoded.indexOf(':');
		if (idx < 0) return null;
		return { user: decodeURIComponent(decoded.slice(0, idx)), pass: decodeURIComponent(decoded.slice(idx + 1)) };
	} catch {
		return null;
	}
}

async function signIdToken(
	keys: KeyMaterial,
	issuer: string,
	audience: string,
	user: StubUser,
	nonce: string,
	now: number,
): Promise<string> {
	const { privateKey, kid } = keys;
	return new SignJWT({
		email: user.email,
		email_verified: true,
		name: user.name,
		...user.extra,
		auth_time: now,
		...(nonce ? { nonce } : {}),
	})
		.setProtectedHeader({ alg: SIGNING_ALG, kid, typ: 'JWT' })
		.setIssuer(issuer)
		.setSubject(user.sub)
		.setAudience(audience)
		.setIssuedAt(now)
		.setExpirationTime(now + 3600)
		.sign(privateKey);
}

/**
 * A JWT access token, so `/userinfo` (and a bearer verifier) can validate it.
 * Carries the user's `extra` claims too (e.g. `groups`), so `requireRole` with
 * an `allowBearerAuth` bearer token sees the same `groupsClaim` locally that an
 * IdP configured to put groups in its access tokens sends (D6c).
 */
async function signAccessToken(
	keys: KeyMaterial,
	issuer: string,
	audience: string,
	user: StubUser,
	now: number,
): Promise<string> {
	const { privateKey, kid } = keys;
	return new SignJWT({ email: user.email, name: user.name, ...user.extra, token_use: 'access' })
		.setProtectedHeader({ alg: SIGNING_ALG, kid, typ: 'at+jwt' })
		.setIssuer(issuer)
		.setSubject(user.sub)
		.setAudience(audience)
		.setIssuedAt(now)
		.setExpirationTime(now + 3600)
		.sign(privateKey);
}

async function tokenResponse(
	stub: StubInstance,
	ctx: BlocksContext,
	clientId: string,
	user: StubUser,
	nonce: string,
	scopes: string[],
): Promise<void> {
	const keys = await stub.keys();
	const issuer = stub.issuer(ctx);
	const now = Math.floor(Date.now() / 1000);
	const refreshToken = encodeRefreshToken(keys.refreshKey, {
		jti: randomToken(),
		clientId,
		user,
		exp: now + REFRESH_TOKEN_TTL_SECONDS,
	});
	json(ctx, 200, {
		access_token: await signAccessToken(keys, issuer, clientId, user, now),
		token_type: 'Bearer',
		expires_in: 3600,
		refresh_token: refreshToken,
		id_token: await signIdToken(keys, issuer, clientId, user, nonce, now),
		scope: scopes.join(' '),
	});
}

/** Remember a spent refresh token (rotated or revoked) until it would have expired anyway. */
function spend(stub: StubInstance, entry: RefreshEntry): void {
	const now = Math.floor(Date.now() / 1000);
	for (const [jti, exp] of stub.spent) if (exp <= now) stub.spent.delete(jti);
	stub.spent.set(entry.jti, entry.exp);
}

async function handleToken(stub: StubInstance, ctx: BlocksContext): Promise<void> {
	const form = new URLSearchParams(await ctx.request.text());
	const basic = parseBasicAuth(ctx.request.headers.get('authorization') ?? '');
	const clientId = form.get('client_id') ?? basic?.user ?? null;
	const grantType = form.get('grant_type');
	const keys = await stub.keys();

	if (grantType === 'refresh_token') {
		const token = form.get('refresh_token');
		const entry = token ? decodeRefreshToken(keys.refreshKey, token) : null;
		if (!entry || stub.spent.has(entry.jti)) {
			json(ctx, 400, { error: 'invalid_grant', error_description: 'unknown refresh token' });
			return;
		}
		if (!stubValueMatches(clientId, entry.clientId)) {
			json(ctx, 401, { error: 'invalid_client' });
			return;
		}
		spend(stub, entry); // rotate
		await tokenResponse(stub, ctx, entry.clientId, entry.user, '', ['openid', 'email', 'profile']);
		return;
	}
	if (grantType !== 'authorization_code') {
		json(ctx, 400, { error: 'unsupported_grant_type' });
		return;
	}
	const code = form.get('code');
	const pending = code ? decodeCode(keys.codeKey, code) : null;
	if (!pending) {
		json(ctx, 400, { error: 'invalid_grant', error_description: 'unknown or expired code' });
		return;
	}
	if (!stubValueMatches(clientId, pending.clientId)) {
		json(ctx, 401, { error: 'invalid_client' });
		return;
	}
	if (!stubValueMatches(form.get('redirect_uri'), pending.redirectUri)) {
		json(ctx, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
		return;
	}
	const verifier = form.get('code_verifier');
	if (!verifier || !stubValueMatches(pkceChallenge(verifier), pending.codeChallenge)) {
		json(ctx, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
		return;
	}
	await tokenResponse(stub, ctx, pending.clientId, pending.user, pending.nonce, pending.scopes);
}

async function handleUserInfo(stub: StubInstance, ctx: BlocksContext): Promise<void> {
	const header = ctx.request.headers.get('authorization') ?? '';
	const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
	if (!token) {
		ctx.response.headers.set('WWW-Authenticate', 'Bearer');
		json(ctx, 401, { error: 'invalid_token' });
		return;
	}
	try {
		const { publicKey } = await stub.keys();
		const { payload } = await jwtVerify(token, publicKey, { issuer: stub.issuer(ctx), algorithms: [SIGNING_ALG] });
		json(ctx, 200, {
			sub: payload.sub,
			...(typeof payload.email === 'string' ? { email: payload.email, email_verified: true } : {}),
			...(typeof payload.name === 'string' ? { name: payload.name } : {}),
		});
	} catch {
		ctx.response.headers.set('WWW-Authenticate', 'Bearer error="invalid_token"');
		json(ctx, 401, { error: 'invalid_token' });
	}
}

async function handleRevoke(stub: StubInstance, ctx: BlocksContext): Promise<void> {
	const token = new URLSearchParams(await ctx.request.text()).get('token');
	const entry = token ? decodeRefreshToken((await stub.keys()).refreshKey, token) : null;
	if (entry) spend(stub, entry);
	json(ctx, 200, {});
}

/**
 * What the stub knows about its one client, as a real IdP knows a registered
 * client: its id, the paths registered (on the app's origin) as
 * `redirect_uri`s, and the paths registered (on the app's origin) as
 * `post_logout_redirect_uri`s.
 */
export interface StubClientRegistration {
	/** The provider's `clientId` (`stubIdp()` uses `stub-client-id`). */
	clientId: string;
	/**
	 * Same-origin paths registered as `redirect_uri`s: the `Auth` instance's
	 * `redirects.callbackPath` (the federation callback every transport —
	 * server-initiated, browser PKCE and the native relay — returns to).
	 * `/authorize` accepts only these, on the origins {@link registeredRedirectUris} lists.
	 */
	redirectPaths: readonly string[];
	/**
	 * Same-origin paths registered as post-logout redirect URIs, already
	 * normalised: the `Auth` instance's `redirects.postSignOutPath` and
	 * `redirects.signOutPath`.
	 */
	postLogoutPaths: readonly string[];
}

/**
 * `end_session_endpoint` (OIDC RP-Initiated Logout 1.0). There is no IdP
 * session to end, so this only sends the browser back — and, like a real IdP
 * (§3: the URI "MUST have been previously registered with the OP"), only to a
 * registered `post_logout_redirect_uri`, compared exactly: `<app origin>` (the
 * same base the direct engine builds it from) plus one of the client's
 * registered paths. Anything else, or another `client_id`, is a `400` with no
 * redirect (§4: on a failed validation the OP "MUST NOT" redirect and "SHOULD
 * display an error page"). No `post_logout_redirect_uri` shows the signed-out
 * page.
 */
function handleLogout(ctx: BlocksContext, client: StubClientRegistration): void {
	const params = ctx.request.url.searchParams;
	const target = params.get('post_logout_redirect_uri');
	const clientId = params.get('client_id');
	if (clientId !== null && !stubValueMatches(clientId, client.clientId)) {
		json(ctx, 400, { error: 'invalid_request', error_description: 'unknown client_id' });
		return;
	}
	if (target !== null) {
		const base = appBaseUrl(ctx);
		if (!client.postLogoutPaths.some((path) => `${base}${path}` === target)) {
			json(ctx, 400, {
				error: 'invalid_request',
				error_description:
					'post_logout_redirect_uri is not registered for this client. The AWS Blocks stub IdP accepts ' +
					`only the app origin plus redirects.postSignOutPath or redirects.signOutPath (${client.postLogoutPaths
						.map((path) => `${base}${path}`)
						.join(', ')}).`,
			});
			return;
		}
		redirect(ctx, target);
		return;
	}
	ctx.response.status = 200;
	ctx.response.headers.set('Content-Type', 'text/html; charset=utf-8');
	ctx.response.send('<!DOCTYPE html><html><body><p>Signed out of the AWS Blocks stub IdP.</p></body></html>');
}

/** What {@link createStubIdp} needs to serve one `stubIdp()` provider. */
export interface StubIdpConfig {
	/** The `oidcProviders` key. */
	providerId: string;
	/** The provider's `stubIdp` settings. */
	settings: StubIdpSettings;
	/**
	 * `.bb-data/<fullId>/`, resolved per request so `users.json` edits apply
	 * without a restart. The deployed stub has none (`() => undefined`).
	 */
	dataDir: () => string | undefined;
	/**
	 * The stub's client registration (see {@link StubClientRegistration}); `/authorize` and
	 * `/logout` redirect only to its URIs.
	 */
	client: StubClientRegistration;
	/** The issuer URL for a request: `stubIssuerUrl` (locally) or the registered gateway URL's (deployed). */
	issuer: (ctx: BlocksContext) => string;
	/** The `Auth` block's session secret, the root every stub key is derived from. */
	secret: () => Promise<string>;
}

/**
 * Build one provider's stub IdP handlers, for `mountStubIdpRoutes()` in
 * `stub-idp-routes.ts`. Keys are derived from `config.secret()` on first use
 * and cached; a failed secret read is retried on the next request.
 */
export function createStubIdp(config: StubIdpConfig): StubIdpHandlers {
	let keys: Promise<KeyMaterial> | undefined;
	const stub: StubInstance = {
		providerId: config.providerId,
		settings: config.settings,
		dataDir: config.dataDir,
		client: config.client,
		issuer: config.issuer,
		keys: () => {
			if (!keys) {
				const attempt = config.secret().then((secret) => deriveStubKeys(secret, config.providerId));
				keys = attempt;
				attempt.catch(() => {
					if (keys === attempt) keys = undefined;
				});
			}
			return keys;
		},
		spent: new Map(),
	};
	return {
		discovery: (ctx) => handleDiscovery(stub, ctx),
		jwks: (ctx) => handleJwks(stub, ctx),
		authorize: (ctx) => handleAuthorize(stub, ctx),
		authorizeSubmit: (ctx) => handleAuthorizeSubmit(stub, ctx),
		token: (ctx) => handleToken(stub, ctx),
		userinfo: (ctx) => handleUserInfo(stub, ctx),
		revoke: (ctx) => handleRevoke(stub, ctx),
		logout: async (ctx) => handleLogout(ctx, stub.client),
	};
}
