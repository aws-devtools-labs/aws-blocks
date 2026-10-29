// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only: an in-process fake of a Cognito user-pool **domain** over real
 * HTTP — the managed-login endpoints the hosted-UI engine talks to:
 *
 * - `GET /oauth2/authorize` — checks the client, the registered `redirect_uri`,
 *   `response_type=code`, PKCE `S256` and that `identity_provider` is one of the
 *   client's supported providers; then, standing in for the IdP round trip,
 *   302s back to `redirect_uri` with a code (or an `error`). It sets the
 *   managed-login session cookie (`cognito`) and records whether a request
 *   arrived carrying it (a *silent* re-authentication).
 * - `POST /oauth2/token` — `authorization_code` (real S256 check of the
 *   verifier, exact `redirect_uri`, single-use codes) and `refresh_token`.
 *   Mints RS256 Cognito-shaped tokens (`iss` = the pool, `aud` = the client,
 *   `token_use`, `cognito:username`, `identities`, `cognito:groups`).
 * - `POST /oauth2/revoke`, `GET /logout` (checks the registered `logout_uri`,
 *   clears the managed-login cookie, 302s to `logout_uri`).
 * - `GET /<poolId>/.well-known/jwks.json` — the pool's JWKS.
 *
 * With {@link FakeCognito.preSignUp} set it also plays the pool's PreSignUp
 * trigger (decision Q10): a federated user's **first** authorize invokes it
 * with a `PreSignUp_ExternalProvider` event, as Cognito does before creating
 * the pool user; a throw becomes Cognito's redirect with `error=invalid_request`
 * and `error_description=PreSignUp failed with error <message>. `.
 *
 * Knobs make it misbehave (a tampered, expired, foreign-audience or
 * foreign-pool ID token; an ID token for another IdP; a rejected or failing
 * refresh), so each of the engine's checks can be proven to fire.
 *
 * @internal
 */

import crypto from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const FAKE_REGION = 'us-east-1';
export const FAKE_POOL_ID = 'us-east-1_D6bHostedUi';
export const FAKE_HOSTED_UI_CLIENT_ID = 'd6bhosteduiclient0000000';
export const FAKE_NATIVE_CLIENT_ID = 'd6bnativeclient000000000';
const KID = 'd6b-fake-kid';
/** The managed-login session cookie name. */
export const MANAGED_LOGIN_COOKIE = 'cognito';

/** The federated user the "IdP" signs in next. */
export interface FakeFederatedUser {
	/** The IdP's subject (`identities[0].userId`). */
	idpSub: string;
	email?: string;
	name?: string;
	/** Cognito groups in the ID token (`cognito:groups`). */
	groups?: string[];
}

/** Per-test misbehaviour of the next token responses. */
export interface FakeTokenOverrides {
	/** Flip a byte of the ID token's signature. */
	tamper?: boolean;
	/** ID-token lifetime in seconds (negative = already expired). */
	idTokenExpiresIn?: number;
	audience?: string;
	issuer?: string;
	/** The `identities[0].providerName` to claim (default: the requested `identity_provider`). */
	identityProvider?: string;
}

/** A recorded request to the fake domain. */
export interface FakeCognitoRequest {
	method: string;
	path: string;
	query: URLSearchParams;
	form: URLSearchParams;
	/** Whether the request carried the managed-login cookie. */
	managedLoginCookie: boolean;
}

interface CodeGrant {
	clientId: string;
	redirectUri: string;
	challenge: string;
	providerName: string;
	user: FakeFederatedUser;
}

function b64url(v: object): string {
	return Buffer.from(JSON.stringify(v)).toString('base64url');
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	return Buffer.concat(chunks).toString('utf8');
}

export class FakeCognito {
	/** `http://127.0.0.1:<port>` — what the `DOMAIN` config key is set to. */
	origin = '';
	readonly issuer = `https://cognito-idp.${FAKE_REGION}.amazonaws.com/${FAKE_POOL_ID}`;
	readonly requests: FakeCognitoRequest[] = [];
	readonly revoked: string[] = [];
	/** The client's registered callback / logout URLs (D3b's front doors). */
	callbackUrls: string[] = [];
	logoutUrls: string[] = [];
	/** `SupportedIdentityProviders` of the hosted-UI client. */
	supportedProviders: string[] = [];
	/** The user the IdP signs in next, per Cognito provider name. */
	users = new Map<string, FakeFederatedUser>();
	/** Answer the next authorize with this OAuth `error` instead of a code. */
	authorizeError?: string;
	/** The pool's PreSignUp trigger (a Lambda invocation): resolve to accept, throw to reject. */
	preSignUp?: (event: Record<string, unknown>) => Promise<unknown>;
	/** Federated pool users Cognito has created (their first sign-in ran the trigger). */
	readonly poolUsers = new Set<string>();
	overrides: FakeTokenOverrides = {};
	refreshBehavior: 'ok' | 'invalid_grant' | 'server_error' = 'ok';
	/** The JWKS URIs the verifier asked for (via the test fetcher). */
	readonly jwksFetches: string[] = [];

	private server?: Server;
	private readonly privateKey: crypto.KeyObject;
	readonly jwks: { keys: Array<Record<string, unknown>> };
	private readonly codes = new Map<string, CodeGrant>();
	private readonly refreshTokens = new Map<string, { providerName: string; user: FakeFederatedUser }>();

	constructor() {
		const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
		this.privateKey = privateKey;
		this.jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }] };
	}

	/** The `jwksUri` `aws-jwt-verify` derives for the pool. */
	get jwksUri(): string {
		return `${this.issuer}/.well-known/jwks.json`;
	}

	/** The Cognito username Cognito gives a federated user (`<ProviderName>_<sub>`, lowercased: case-insensitive pool). */
	static username(providerName: string, user: FakeFederatedUser): string {
		return `${providerName}_${user.idpSub}`.toLowerCase();
	}

	async start(): Promise<this> {
		this.server = createServer((req, res) => {
			void this.handle(req).then(
				({ status, headers, body }) => {
					res.writeHead(status, headers);
					res.end(body);
				},
				(e: unknown) => {
					res.writeHead(500, { 'Content-Type': 'text/plain' });
					res.end(e instanceof Error ? e.message : String(e));
				},
			);
		});
		await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
		const { port } = this.server.address() as AddressInfo;
		this.origin = `http://127.0.0.1:${port}`;
		return this;
	}

	async close(): Promise<void> {
		await new Promise<void>((resolve) => {
			this.server?.closeAllConnections();
			this.server?.close(() => resolve());
		});
	}

	reset(): void {
		this.requests.length = 0;
		this.revoked.length = 0;
		this.jwksFetches.length = 0;
		this.overrides = {};
		this.refreshBehavior = 'ok';
		this.authorizeError = undefined;
		this.preSignUp = undefined;
		this.poolUsers.clear();
	}

	/** Sign a payload as an RS256 JWT with the pool's key. */
	sign(payload: Record<string, unknown>): string {
		const head = b64url({ alg: 'RS256', kid: KID, typ: 'JWT' });
		const body = b64url(payload);
		const sig = crypto
			.createSign('RSA-SHA256')
			.update(`${head}.${body}`)
			.sign(this.privateKey)
			.toString('base64url');
		return `${head}.${body}.${sig}`;
	}

	/** Cognito-shaped tokens for a native (email + password) sign-in, as `InitiateAuth` returns them. */
	nativeAuthResult(username: string): { IdToken: string; AccessToken: string; RefreshToken: string } {
		const now = Math.floor(Date.now() / 1000);
		return {
			IdToken: this.sign({
				sub: `sub-${username}`,
				'cognito:username': username,
				email: username,
				iss: this.issuer,
				aud: FAKE_NATIVE_CLIENT_ID,
				token_use: 'id',
				auth_time: now,
				iat: now,
				exp: now + 3600,
			}),
			AccessToken: this.sign({
				sub: `sub-${username}`,
				username,
				client_id: FAKE_NATIVE_CLIENT_ID,
				token_use: 'access',
				iss: this.issuer,
				iat: now,
				exp: now + 3600,
			}),
			RefreshToken: `native-refresh-${username}`,
		};
	}

	private mintTokens(
		providerName: string,
		user: FakeFederatedUser,
		withRefresh: boolean,
	): { id_token: string; access_token: string; refresh_token?: string; expires_in: number; token_type: string } {
		const now = Math.floor(Date.now() / 1000);
		const o = this.overrides;
		const username = FakeCognito.username(providerName, user);
		const sub = `pool-sub-${user.idpSub}`;
		const identity = o.identityProvider ?? providerName;
		let idToken = this.sign({
			sub,
			'cognito:username': username,
			...(user.groups ? { 'cognito:groups': user.groups } : {}),
			...(user.email ? { email: user.email, email_verified: false } : {}),
			...(user.name ? { name: user.name } : {}),
			identities: [
				{
					userId: user.idpSub,
					providerName: identity,
					providerType: identity,
					issuer: null,
					primary: 'true',
					dateCreated: String(now * 1000),
				},
			],
			iss: o.issuer ?? this.issuer,
			aud: o.audience ?? FAKE_HOSTED_UI_CLIENT_ID,
			token_use: 'id',
			auth_time: now,
			iat: now,
			exp: now + (o.idTokenExpiresIn ?? 3600),
			jti: crypto.randomUUID(),
		});
		if (o.tamper) {
			const [h, p, s] = idToken.split('.');
			const bytes = Buffer.from(s, 'base64url');
			bytes[0] ^= 0xff;
			idToken = `${h}.${p}.${bytes.toString('base64url')}`;
		}
		const accessToken = this.sign({
			sub,
			username,
			client_id: FAKE_HOSTED_UI_CLIENT_ID,
			token_use: 'access',
			scope: 'openid email profile',
			iss: this.issuer,
			iat: now,
			exp: now + 3600,
			jti: crypto.randomUUID(),
		});
		const out: {
			id_token: string;
			access_token: string;
			refresh_token?: string;
			expires_in: number;
			token_type: string;
		} = { id_token: idToken, access_token: accessToken, expires_in: 3600, token_type: 'Bearer' };
		if (withRefresh) {
			const refresh = `hosted-refresh-${crypto.randomBytes(8).toString('hex')}`;
			this.refreshTokens.set(refresh, { providerName, user });
			out.refresh_token = refresh;
		}
		return out;
	}

	private async handle(
		req: IncomingMessage,
	): Promise<{ status: number; headers: Record<string, string | string[]>; body: string }> {
		const url = new URL(req.url ?? '/', this.origin);
		const text = await readBody(req);
		const form = new URLSearchParams(req.method === 'POST' ? text : '');
		const cookie = req.headers.cookie ?? '';
		const managedLoginCookie = cookie.split(';').some((c) => c.trim().startsWith(`${MANAGED_LOGIN_COOKIE}=`));
		this.requests.push({
			method: req.method ?? 'GET',
			path: url.pathname,
			query: url.searchParams,
			form,
			managedLoginCookie,
		});
		const json = (status: number, body: unknown) => ({
			status,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		const redirect = (location: string, extra: Record<string, string | string[]> = {}) => ({
			status: 302,
			headers: { Location: location, ...extra },
			body: '',
		});

		if (req.method === 'GET' && url.pathname === `/${FAKE_POOL_ID}/.well-known/jwks.json`) {
			return json(200, this.jwks);
		}

		if (req.method === 'GET' && url.pathname === '/oauth2/authorize') {
			const q = url.searchParams;
			const redirectUri = q.get('redirect_uri') ?? '';
			if (q.get('client_id') !== FAKE_HOSTED_UI_CLIENT_ID) return json(400, { error: 'invalid_client' });
			if (!this.callbackUrls.includes(redirectUri)) return json(400, { error: 'redirect_mismatch' });
			if (q.get('response_type') !== 'code') return json(400, { error: 'unsupported_response_type' });
			const challenge = q.get('code_challenge');
			if (!challenge || q.get('code_challenge_method') !== 'S256') return json(400, { error: 'invalid_request' });
			const back = new URL(redirectUri);
			const state = q.get('state');
			if (state) back.searchParams.set('state', state);
			if (this.authorizeError) {
				back.searchParams.set('error', this.authorizeError);
				back.searchParams.set('error_description', 'the IdP said no');
				return redirect(back.toString());
			}
			const providerName = q.get('identity_provider') ?? '';
			if (!this.supportedProviders.includes(providerName)) return json(400, { error: 'unauthorized_client' });
			const user = this.users.get(providerName);
			if (!user) return json(500, { error: `fake: no user scripted for ${providerName}` });
			const username = FakeCognito.username(providerName, user);
			if (this.preSignUp && !this.poolUsers.has(username)) {
				try {
					await this.preSignUp({
						version: '1',
						region: FAKE_REGION,
						userPoolId: FAKE_POOL_ID,
						userName: username,
						callerContext: { awsSdkVersion: 'aws-sdk-unknown-unknown', clientId: FAKE_HOSTED_UI_CLIENT_ID },
						triggerSource: 'PreSignUp_ExternalProvider',
						request: {
							userAttributes: {
								...(user.email ? { email: user.email } : {}),
								...(user.name ? { name: user.name } : {}),
							},
							validationData: null,
						},
						response: { autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false },
					});
				} catch (e) {
					back.searchParams.set('error', 'invalid_request');
					back.searchParams.set(
						'error_description',
						`PreSignUp failed with error ${e instanceof Error ? e.message : String(e)}. `,
					);
					return redirect(back.toString());
				}
			}
			this.poolUsers.add(username);
			const code = crypto.randomBytes(16).toString('hex');
			this.codes.set(code, {
				clientId: FAKE_HOSTED_UI_CLIENT_ID,
				redirectUri,
				challenge,
				providerName,
				user,
			});
			back.searchParams.set('code', code);
			// Managed login's own session: present on a later authorize = silent re-auth.
			return redirect(back.toString(), {
				'Set-Cookie': `${MANAGED_LOGIN_COOKIE}=${encodeURIComponent(FakeCognito.username(providerName, user))}; Path=/; HttpOnly`,
			});
		}

		if (req.method === 'POST' && url.pathname === '/oauth2/token') {
			if (form.get('client_id') !== FAKE_HOSTED_UI_CLIENT_ID) return json(400, { error: 'invalid_client' });
			if (form.has('client_secret')) return json(400, { error: 'invalid_client' }); // public client
			const grant = form.get('grant_type');
			if (grant === 'authorization_code') {
				const code = form.get('code') ?? '';
				const entry = this.codes.get(code);
				this.codes.delete(code); // single use
				if (!entry) return json(400, { error: 'invalid_grant' });
				if (form.get('redirect_uri') !== entry.redirectUri) return json(400, { error: 'invalid_grant' });
				const verifier = form.get('code_verifier') ?? '';
				const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
				if (!verifier || expected !== entry.challenge) return json(400, { error: 'invalid_grant' });
				return json(200, this.mintTokens(entry.providerName, entry.user, true));
			}
			if (grant === 'refresh_token') {
				if (this.refreshBehavior === 'server_error') return json(503, { error: 'server_error' });
				const entry = this.refreshTokens.get(form.get('refresh_token') ?? '');
				if (!entry || this.refreshBehavior === 'invalid_grant') return json(400, { error: 'invalid_grant' });
				// Cognito returns no new refresh token unless rotation is on.
				return json(200, this.mintTokens(entry.providerName, entry.user, false));
			}
			return json(400, { error: 'unsupported_grant_type' });
		}

		if (req.method === 'POST' && url.pathname === '/oauth2/revoke') {
			if (form.get('client_id') !== FAKE_HOSTED_UI_CLIENT_ID) return json(400, { error: 'invalid_client' });
			const token = form.get('token') ?? '';
			this.revoked.push(token);
			this.refreshTokens.delete(token);
			return { status: 200, headers: {}, body: '' };
		}

		if (req.method === 'GET' && url.pathname === '/logout') {
			const logoutUri = url.searchParams.get('logout_uri') ?? '';
			if (url.searchParams.get('client_id') !== FAKE_HOSTED_UI_CLIENT_ID)
				return json(400, { error: 'invalid_client' });
			if (!this.logoutUrls.includes(logoutUri)) return json(400, { error: 'invalid logout_uri' });
			return redirect(logoutUri, { 'Set-Cookie': `${MANAGED_LOGIN_COOKIE}=; Path=/; Max-Age=0` });
		}

		return json(404, { error: 'not found' });
	}
}
