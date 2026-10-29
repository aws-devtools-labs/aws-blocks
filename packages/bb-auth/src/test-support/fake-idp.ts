// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only: an in-process OIDC identity provider over real HTTP (discovery,
 * JWKS, token, userinfo, revocation, end-session), with knobs to make it
 * misbehave — wrong audience, wrong nonce, a foreign signing key, an expired
 * ID token, a rejected or failing refresh — so the direct engine's checks can
 * each be proven to fire.
 *
 * @internal
 */

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';

interface CodeGrant {
	clientId: string;
	redirectUri: string;
	challenge: string;
	nonce?: string;
	sub: string;
	claims: Record<string, unknown>;
}

/** Per-request misbehaviour for the next token responses. */
export interface TokenOverrides {
	audience?: string;
	nonce?: string | null;
	/** ID-token lifetime in seconds (negative = already expired). */
	idTokenExpiresIn?: number;
	/** Sign the ID token with a key the JWKS does not publish. */
	foreignKey?: boolean;
	/** Omit `id_token`. */
	omitIdToken?: boolean;
	/** Override the `iss` claim. */
	issuer?: string;
}

/** A recorded request to the fake IdP. */
export interface IdpRequest {
	method: string;
	path: string;
	form: URLSearchParams;
	authorization: string | null;
}

export class FakeIdp {
	origin = '';
	/** The issuer URL (`<origin>/tenant`). */
	issuer = '';
	readonly requests: IdpRequest[] = [];
	readonly revoked: string[] = [];
	overrides: TokenOverrides = {};
	refreshBehavior: 'rotate' | 'invalid_grant' | 'server_error' = 'rotate';
	/** When set, discovery advertises this issuer instead of the real one. */
	advertisedIssuer?: string;
	/** Advertise `end_session_endpoint` / `revocation_endpoint`. */
	endSession = true;
	revocation = true;
	/** The client secret the token endpoint requires (`undefined` = public client). */
	clientSecret?: string;
	/** Extra claims userinfo returns (always with the subject's `sub`). */
	userInfoClaims: Record<string, unknown> = {};
	/** When set, the token endpoint answers every request with this response (a failing IdP). */
	tokenResponse?: { status: number; body: unknown };

	private server?: Server;
	private key?: { privateKey: CryptoKey; jwk: JWK };
	private foreign?: CryptoKey;
	private readonly codes = new Map<string, CodeGrant>();
	private readonly refreshTokens = new Map<string, { sub: string; clientId: string }>();
	private readonly accessTokens = new Map<string, string>();
	private counter = 0;

	async start(): Promise<this> {
		const pair = await generateKeyPair('RS256', { extractable: true });
		const jwk = await exportJWK(pair.publicKey);
		jwk.kid = 'fake-kid';
		jwk.alg = 'RS256';
		jwk.use = 'sig';
		this.key = { privateKey: pair.privateKey, jwk };
		this.foreign = (await generateKeyPair('RS256')).privateKey;
		this.server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (c: Buffer) => chunks.push(c));
			req.on('end', () => {
				void this.handle(
					req.method ?? 'GET',
					new URL(req.url ?? '/', this.origin),
					Buffer.concat(chunks).toString('utf8'),
					req.headers.authorization ?? null,
				).then(({ status, body, headers }) => {
					res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
					res.end(typeof body === 'string' ? body : JSON.stringify(body));
				});
			});
		});
		await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
		const { port } = this.server.address() as AddressInfo;
		this.origin = `http://127.0.0.1:${port}`;
		this.issuer = `${this.origin}/tenant`;
		return this;
	}

	async close(): Promise<void> {
		await new Promise<void>((resolve) => {
			this.server?.closeAllConnections();
			this.server?.close(() => resolve());
		});
	}

	/**
	 * Play the user's part at `/authorize`: read the PKCE challenge, nonce and
	 * redirect URI off an authorize URL and mint a code for `sub`.
	 */
	authorize(authorizeUrl: string, sub = 'user-1', claims: Record<string, unknown> = {}): string {
		const url = new URL(authorizeUrl);
		if (url.searchParams.get('code_challenge_method') !== 'S256') throw new Error('PKCE S256 required');
		const code = `code-${++this.counter}`;
		this.codes.set(code, {
			clientId: url.searchParams.get('client_id') ?? '',
			redirectUri: url.searchParams.get('redirect_uri') ?? '',
			challenge: url.searchParams.get('code_challenge') ?? '',
			...(url.searchParams.get('nonce') ? { nonce: url.searchParams.get('nonce') ?? '' } : {}),
			sub,
			claims,
		});
		return code;
	}

	/** Mint a code directly (the client ran PKCE itself). */
	codeFor(grant: CodeGrant): string {
		const code = `code-${++this.counter}`;
		this.codes.set(code, grant);
		return code;
	}

	private async idToken(clientId: string, sub: string, nonce: string | undefined, claims: Record<string, unknown>) {
		if (!this.key || !this.foreign) throw new Error('not started');
		const o = this.overrides;
		const now = Math.floor(Date.now() / 1000);
		const n = o.nonce === null ? undefined : (o.nonce ?? nonce);
		const jwt = new SignJWT({ ...claims, ...(n ? { nonce: n } : {}) })
			.setProtectedHeader({ alg: 'RS256', kid: 'fake-kid' })
			.setIssuer(o.issuer ?? this.issuer)
			.setSubject(sub)
			.setAudience(o.audience ?? clientId)
			.setIssuedAt(now - 5)
			.setExpirationTime(now + (o.idTokenExpiresIn ?? 3600));
		return jwt.sign(o.foreignKey ? this.foreign : this.key.privateKey);
	}

	/**
	 * Mint a JWT **access token** (as Okta / Entra / Keycloak issue them) for the
	 * bearer tests (D6c), signed with the published key unless `foreignKey`.
	 * `claims` are added; `audience`, `issuer` and `expiresIn` override the defaults.
	 */
	async accessJwt(
		sub: string,
		opts: {
			audience?: string;
			issuer?: string;
			expiresIn?: number;
			foreignKey?: boolean;
			claims?: Record<string, unknown>;
		} = {},
	): Promise<string> {
		if (!this.key || !this.foreign) throw new Error('not started');
		const now = Math.floor(Date.now() / 1000);
		return new SignJWT({ ...opts.claims })
			.setProtectedHeader({ alg: 'RS256', kid: 'fake-kid', typ: 'at+jwt' })
			.setIssuer(opts.issuer ?? this.issuer)
			.setSubject(sub)
			.setAudience(opts.audience ?? 'client-1')
			.setIssuedAt(now - 5)
			.setExpirationTime(now + (opts.expiresIn ?? 3600))
			.sign(opts.foreignKey ? this.foreign : this.key.privateKey);
	}

	/** The published public key as a JWKS document (for a test that serves it elsewhere). */
	get jwksDocument(): { keys: JWK[] } {
		if (!this.key) throw new Error('not started');
		return { keys: [this.key.jwk] };
	}

	private clientOk(form: URLSearchParams, authorization: string | null): boolean {
		if (this.clientSecret === undefined) return true;
		if (form.get('client_secret') === this.clientSecret) return true;
		if (authorization?.startsWith('Basic ')) {
			const [, pass] = Buffer.from(authorization.slice(6), 'base64').toString('utf8').split(':');
			return decodeURIComponent(pass ?? '') === this.clientSecret;
		}
		return false;
	}

	private async tokens(clientId: string, sub: string, nonce: string | undefined, claims: Record<string, unknown>) {
		const access = `at-${++this.counter}`;
		const refresh = `rt-${++this.counter}`;
		this.accessTokens.set(access, sub);
		this.refreshTokens.set(refresh, { sub, clientId });
		return {
			access_token: access,
			token_type: 'Bearer',
			expires_in: 3600,
			refresh_token: refresh,
			...(this.overrides.omitIdToken ? {} : { id_token: await this.idToken(clientId, sub, nonce, claims) }),
		};
	}

	private async handle(
		method: string,
		url: URL,
		text: string,
		authorization: string | null,
	): Promise<{ status: number; body: unknown; headers?: Record<string, string> }> {
		const form = new URLSearchParams(text);
		const path = url.pathname.replace(/^\/tenant/, '');
		this.requests.push({ method, path, form, authorization });
		if (path === '/.well-known/openid-configuration') {
			return {
				status: 200,
				body: {
					issuer: this.advertisedIssuer ?? this.issuer,
					authorization_endpoint: `${this.issuer}/authorize`,
					token_endpoint: `${this.issuer}/token`,
					jwks_uri: `${this.issuer}/jwks`,
					userinfo_endpoint: `${this.issuer}/userinfo`,
					...(this.revocation ? { revocation_endpoint: `${this.issuer}/revoke` } : {}),
					...(this.endSession ? { end_session_endpoint: `${this.issuer}/logout` } : {}),
				},
			};
		}
		if (path === '/jwks') return { status: 200, body: { keys: [this.key?.jwk] } };
		if (path === '/revoke') {
			this.revoked.push(form.get('token') ?? '');
			return { status: 200, body: {} };
		}
		if (path === '/userinfo') {
			const token = authorization?.replace(/^Bearer /, '') ?? '';
			const sub = this.accessTokens.get(token);
			if (!sub) return { status: 401, body: { error: 'invalid_token' } };
			return { status: 200, body: { sub, ...this.userInfoClaims } };
		}
		if (path === '/token') {
			if (this.tokenResponse) return this.tokenResponse;
			if (!this.clientOk(form, authorization)) return { status: 401, body: { error: 'invalid_client' } };
			if (form.get('grant_type') === 'authorization_code') {
				const grant = this.codes.get(form.get('code') ?? '');
				if (!grant) return { status: 400, body: { error: 'invalid_grant' } };
				this.codes.delete(form.get('code') ?? '');
				const verifier = form.get('code_verifier') ?? '';
				const challenge = createHash('sha256').update(verifier).digest('base64url');
				if (challenge !== grant.challenge) {
					return { status: 400, body: { error: 'invalid_grant', error_description: 'PKCE' } };
				}
				if (form.get('redirect_uri') !== grant.redirectUri || form.get('client_id') !== grant.clientId) {
					return { status: 400, body: { error: 'invalid_grant', error_description: 'redirect_uri' } };
				}
				return { status: 200, body: await this.tokens(grant.clientId, grant.sub, grant.nonce, grant.claims) };
			}
			if (form.get('grant_type') === 'refresh_token') {
				if (this.refreshBehavior === 'server_error')
					return { status: 503, body: { error: 'temporarily_unavailable' } };
				const entry = this.refreshTokens.get(form.get('refresh_token') ?? '');
				if (!entry || this.refreshBehavior === 'invalid_grant')
					return { status: 400, body: { error: 'invalid_grant' } };
				this.refreshTokens.delete(form.get('refresh_token') ?? '');
				return { status: 200, body: await this.tokens(entry.clientId, entry.sub, undefined, {}) };
			}
			return { status: 400, body: { error: 'unsupported_grant_type' } };
		}
		return { status: 404, body: { error: 'not_found' } };
	}
}
