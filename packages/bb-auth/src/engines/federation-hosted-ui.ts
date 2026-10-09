// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The **hosted-UI** federation engine (D6b): sign-in through Cognito managed
 * login, for every `socialProviders` and `samlProviders` entry and each
 * `oidcProviders` entry with `federateVia: 'cognito'`. AWS runtime only — the
 * managed-login endpoints exist only on a deployed user-pool domain.
 *
 * Federated sign-in works only through Cognito's Login / Authorize endpoints
 * (there is no server-to-server federation API), so this engine is an OAuth 2.0
 * client of the pool's domain, not of the IdP:
 *
 * - **Authorize** — `https://<domain>/oauth2/authorize` with the separate
 *   hosted-UI app client (D3b's `hosted-ui-client`), the authorization-code
 *   grant with **PKCE S256**, and `identity_provider=<Cognito provider name>`
 *   (`cognitoProviderName`), so the user goes straight to the IdP instead of
 *   Cognito's own page. `state`, the verifier and the exact `redirect_uri` ride
 *   in the shared signed pending-auth cookie (`pending-auth.ts`), so the one
 *   callback route serves this engine like any other.
 * - **Token** — the code is redeemed at `/oauth2/token`; the Cognito ID token is
 *   verified with `aws-jwt-verify` against the pool and the hosted-UI client
 *   (signature against the pool's JWKS, issuer, audience, `token_use: id`,
 *   expiry), exactly as the native engine verifies its tokens, and its
 *   `identities` claim must name this provider (so a user who swaps the IdP in
 *   the authorize URL cannot sign in under another provider's id).
 * - **Refresh** — `/oauth2/token` with `grant_type=refresh_token` (Cognito-issued);
 *   **revocation** — `/oauth2/revoke` (best-effort).
 * - **Sign-out** — returns `https://<domain>/logout?client_id=…&logout_uri=…`.
 *   Managed login keeps its own session cookie (one hour); without `/logout` the
 *   next sign-in would silently re-authenticate the user. `logout_uri` is
 *   `<app origin><redirects.signOutPath>` — the URL D3b registers on the client —
 *   and Cognito returns there with a **GET**, which the sign-out route answers
 *   with a redirect to `redirects.postSignOutPath`.
 *
 * A hosted-UI federated user **is a pool user**: `completeSignIn` returns
 * `{ kind: 'pool' }` with Cognito tokens, so the session row, live groups for
 * `requireRole`, `auth.admin` and `getAuthSession` behave exactly as for an
 * email + password user. **MFA is the IdP's**: Cognito delegates authentication
 * of federated users to their IdP and never challenges them, so this engine has
 * no challenge path — enforce MFA at your IdP.
 *
 * ## Configuration is resolved at call time
 *
 * The domain and the hosted-UI client id come from the config keys
 * `federationConfigKeys(fullId)` (`cdk/contract.ts`): the constructor registers
 * them with `registerSdkIdentifiers` (as the native engine registers the pool
 * keys) and every call resolves them with `getSdkIdentifiers(scope)`. Outside
 * Lambda (client code generation) they are empty; a call then fails with a
 * clear `500` naming the provider, the detail (the missing keys) in the log,
 * before any request is made. The pool id is the native engine's registration.
 *
 * Errors are `ApiError`s named from the `AuthErrors` vocabulary; detail that
 * should not reach a browser goes to the block's logger.
 *
 * @internal
 */

import crypto from 'node:crypto';
import { ApiError, type BlocksContext, getSdkIdentifiers, registerSdkIdentifiers } from '@aws-blocks/core';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import {
	FetchError,
	JwksNotAvailableInCacheError,
	NonRetryableFetchError,
	WaitPeriodNotYetEndedJwkError,
} from 'aws-jwt-verify/error';
import { SimpleJwksCache } from 'aws-jwt-verify/jwk';
import { type CognitoFederatedKind, cognitoProviderName, federationConfigKeys } from '../cdk/contract.js';
import { AuthErrors } from '../errors.js';
import { signInRedirectPath } from '../redirect-path.js';
import { decodeTriggerRejection } from '../trigger-rejection.js';
import type { SignInUrlOptions } from '../types.js';
import { appBaseUrl, computeCallbackUrl, pkceChallenge } from './federation-direct.js';
import { maskIdpCallbackError } from './idp-callback-error.js';
import { clearPendingAuth, pendingStateMatches, readPendingAuth, writePendingAuth } from './pending-auth.js';
import type {
	BearerTokens,
	CodeExchangeInput,
	EngineHost,
	FederatedIdentity,
	FederationEngine,
	PoolTokens,
	PublicAuthorizeParams,
	ResolvedProvider,
} from './types.js';

/** The scopes the hosted-UI client allows (D3b). The IdP's own scopes are part of its registration. */
const HOSTED_UI_SCOPES = ['openid', 'email', 'profile'] as const;
const DEFAULT_CALLBACK_PATH = '/aws-blocks/auth/callback';
const DEFAULT_SIGN_OUT_PATH = '/aws-blocks/auth/signout';
/** Default when Cognito reports no lifetime: one hour (Cognito's default). */
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;
const HTTP_TIMEOUT_MS = 10_000;
const USER_AGENT = 'aws-blocks-bb-auth';
/** The wire `kind` of a hosted-UI provider in `authorize-params` (`AuthOIDC`'s `cognitoFederated()` value). */
const AUTHORIZE_PARAMS_KIND = 'cognito-federated';
/** Hosts a plain-`http://` domain value may name (an in-process test server), as Cognito's own localhost exception. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

type IdTokenVerifier = ReturnType<typeof CognitoJwtVerifier.create>;

/** What a call needs, resolved at call time. */
interface HostedUiIdentifiers {
	/** `https://<domain>` (no trailing slash). */
	baseUrl: string;
	clientId: string;
	userPoolId: string;
}

/** The identifier names this engine registers under the block's `fullId`. @internal */
export const HOSTED_UI_IDENTIFIERS = { domain: 'hostedUiDomain', clientId: 'hostedUiClientId' } as const;

function idpError(message: string, status = 400, retriable = false): ApiError {
	return new ApiError(message, status, { name: AuthErrors.IdpError, ...(retriable ? { retriable: true } : {}) });
}

function invalidCallback(message: string): ApiError {
	return new ApiError(`Invalid sign-in callback: ${message}`, 400, { name: AuthErrors.InvalidCallback });
}

function invalidState(message: string): ApiError {
	return new ApiError(`Invalid sign-in state: ${message}`, 400, { name: AuthErrors.InvalidState });
}

function randomToken(): string {
	return crypto.randomBytes(32).toString('base64url');
}

function stringField(obj: object, key: string): string | undefined {
	const v: unknown = Reflect.get(obj, key);
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function numberField(obj: object, key: string): number | undefined {
	const v: unknown = Reflect.get(obj, key);
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** A verifier failure that is about *fetching* the JWKS, not about the token. */
function isTransientVerifyFailure(e: unknown): boolean {
	return (
		e instanceof FetchError ||
		e instanceof NonRetryableFetchError ||
		e instanceof JwksNotAvailableInCacheError ||
		e instanceof WaitPeriodNotYetEndedJwkError
	);
}

/**
 * `https://<domain>` from the `DOMAIN` config value (`<prefix>.auth.<region>.amazoncognito.com`,
 * no scheme — what D3b registers). An explicit `https://` value is accepted;
 * `http://` only for a loopback host (an in-process test server). `undefined`
 * for anything else.
 *
 * @internal
 */
export function hostedUiBaseUrl(domain: string): string | undefined {
	const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(domain) ? domain : `https://${domain}`;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return undefined;
	}
	if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return undefined;
	if (url.protocol === 'https:') return url.origin;
	if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url.origin;
	return undefined;
}

/** The `identities` claim of a Cognito ID token (federated users only). */
function identityProviderNames(claims: Record<string, unknown>): string[] {
	const raw: unknown = claims.identities;
	if (!Array.isArray(raw)) return [];
	const names: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== 'object' || entry === null) continue;
		const name: unknown = Reflect.get(entry, 'providerName');
		if (typeof name === 'string') names.push(name);
	}
	return names;
}

/**
 * One provider federated through Cognito managed login. See the module
 * documentation.
 *
 * @internal
 */
export class HostedUiFederationEngine implements FederationEngine {
	/** The Cognito `ProviderName` sent as `identity_provider` (`google` → `Google`). */
	readonly providerName: string;
	/**
	 * The JWKS cache behind the ID-token verifier — `aws-jwt-verify`'s default
	 * (fetches the pool's public JWKS). One per engine, so the verifier can be
	 * recreated (new pool or client id) without losing the cached keys.
	 */
	private readonly jwksCache = new SimpleJwksCache();
	private verifierCache?: { key: string; verifier: IdTokenVerifier };

	constructor(
		private readonly host: EngineHost,
		private readonly provider: ResolvedProvider,
	) {
		if (provider.transport !== 'hosted-ui') {
			throw new Error(`Auth: provider '${provider.id}' does not federate through Cognito managed login.`);
		}
		const kind: CognitoFederatedKind = provider.family;
		this.providerName = cognitoProviderName(kind, provider.id);
		const keys = federationConfigKeys(host.scope.fullId);
		// Config is loaded into the environment before the backend module is
		// imported in Lambda; outside Lambda (client codegen) these are empty and
		// every call fails with `notProvisioned()` instead. Resolved per call.
		registerSdkIdentifiers(host.scope.fullId, {
			[HOSTED_UI_IDENTIFIERS.domain]: process.env[keys.DOMAIN] ?? '',
			[HOSTED_UI_IDENTIFIERS.clientId]: process.env[keys.HOSTED_UI_CLIENT_ID] ?? '',
		});
	}

	// ── FederationEngine ────────────────────────────────────────────────────

	async buildSignInUrl(context: BlocksContext, options: SignInUrlOptions): Promise<string> {
		// Validated and normalised up front: the stored form is what the callback emits.
		const redirectPath = signInRedirectPath(options.redirectPath);
		const ids = this.ids();
		const callbackUrl = computeCallbackUrl(context, this.callbackPath);
		const codeVerifier = randomToken();
		const state = randomToken();

		const url = new URL(`${ids.baseUrl}/oauth2/authorize`);
		url.searchParams.set('response_type', 'code');
		url.searchParams.set('client_id', ids.clientId);
		url.searchParams.set('redirect_uri', callbackUrl);
		url.searchParams.set('scope', HOSTED_UI_SCOPES.join(' '));
		url.searchParams.set('state', state);
		// Straight to the IdP: skip Cognito's own provider-picker page.
		url.searchParams.set('identity_provider', this.providerName);
		url.searchParams.set('code_challenge', pkceChallenge(codeVerifier));
		url.searchParams.set('code_challenge_method', 'S256');

		writePendingAuth(
			context,
			this.host.scope.fullId,
			{
				provider: this.provider.id,
				state,
				codeVerifier,
				callbackUrl,
				...(redirectPath ? { redirectPath } : {}),
				...(options.state !== undefined ? { appState: options.state } : {}),
			},
			await this.host.sessionSecret(),
			this.crossDomain,
		);
		return url.toString();
	}

	async completeSignIn(context: BlocksContext): Promise<FederatedIdentity> {
		const pending = readPendingAuth(context, this.host.scope.fullId, await this.host.sessionSecret());
		// Single use, whatever happens next.
		clearPendingAuth(context, this.host.scope.fullId, this.crossDomain);
		if (!pending) {
			throw invalidCallback(
				'the pending sign-in cookie is missing or expired. Start the sign-in again; if this repeats, the ' +
					'callback is landing on a different origin than the sign-in started on.',
			);
		}
		if (pending.provider !== this.provider.id) throw invalidState('the callback is for another provider');
		const params = context.request.url.searchParams;
		// R2-2: `state` first, error response or not (RFC 6749 §4.1.2.1 returns it
		// on both). Only a redirect carrying this browser's pending state comes from
		// the sign-in it started; anything else — an attacker's link with a forged
		// `error_description` (even an encoded trigger rejection) — is the same
		// generic InvalidState, so a crafted URL never chooses the error, status or
		// message the app answers with.
		const returnedState = params.get('state');
		if (!pendingStateMatches(returnedState, pending)) throw invalidState('state mismatch');
		const err = params.get('error');
		if (err) {
			// Cognito reports every IdP-side failure this way (it cannot tell IdP
			// misconfiguration from IdP downtime).
			const description = params.get('error_description');
			// `validateUser` rejected this user's first sign-in in the PreSignUp
			// trigger: surface that rejection (its name and message), not an IdP error.
			const rejected = decodeTriggerRejection(description);
			if (rejected) {
				this.host.log.warn('[bb-auth] validateUser rejected a federated first sign-in', {
					provider: this.provider.id,
					error: rejected.name,
				});
				throw rejected;
			}
			// FX60: `description` is managed login's own text — it can quote the
			// request, name a trigger ARN or the pool — and `ApiError.message` is what
			// the `<Authenticator>` renders. So the client gets the fixed message and
			// the text goes to the log only, as FX59 does for every other engine error.
			throw idpError(
				maskIdpCallbackError(this.host.log, '[bb-auth] managed login returned an error', {
					provider: this.provider.id,
					error: err,
					description,
				}),
			);
		}
		const code = params.get('code');
		if (!code) throw invalidCallback('missing code parameter');
		return this.redeem(code, pending.codeVerifier, pending.callbackUrl);
	}

	async exchangeCode(_context: BlocksContext, input: CodeExchangeInput): Promise<FederatedIdentity> {
		let redirect: URL;
		try {
			redirect = new URL(input.redirectUri);
		} catch {
			throw invalidCallback('callbackUrl must be an absolute URL');
		}
		if (redirect.protocol !== 'https:' && redirect.protocol !== 'http:') {
			throw invalidCallback('callbackUrl must be an http(s) URL');
		}
		return this.redeem(input.code, input.codeVerifier, input.redirectUri);
	}

	async authorizeParams(): Promise<PublicAuthorizeParams> {
		const ids = this.ids();
		const url = new URL(`${ids.baseUrl}/oauth2/authorize`);
		url.searchParams.set('identity_provider', this.providerName);
		return {
			authorizeUrl: url.toString(),
			clientId: ids.clientId,
			scopes: [...HOSTED_UI_SCOPES],
			kind: AUTHORIZE_PARAMS_KIND,
			// Cognito verifies the IdP's tokens itself; no nonce is relied on here.
			usesNonce: false,
		};
	}

	async refresh(
		session: Parameters<FederationEngine['refresh']>[0],
	): Promise<{ kind: 'pool'; tokens: PoolTokens } | null> {
		if (session.kind !== 'pool') return null;
		const { tokens } = session;
		if (!tokens.refreshToken) return null;
		const ids = this.ids();
		const out = await this.tokenRequest(
			ids,
			{ grant_type: 'refresh_token', refresh_token: tokens.refreshToken },
			'refresh',
		);
		if (!out?.idToken) return null;
		let claims: Record<string, unknown>;
		try {
			claims = await this.verifyIdToken(ids, out.idToken);
		} catch (e) {
			if (e instanceof ApiError && e.retriable) throw e;
			return null;
		}
		// A refreshed ID token must still be about the same user.
		const previousSub = subjectOf(tokens.idToken);
		if (previousSub && claims.sub !== previousSub) {
			this.host.log.warn('[bb-auth] refreshed ID token names another subject; signing out', {
				provider: this.provider.id,
			});
			return null;
		}
		return {
			kind: 'pool',
			tokens: {
				idToken: out.idToken,
				accessToken: out.accessToken,
				// Cognito rotates the refresh token only when rotation is enabled.
				refreshToken: out.refreshToken ?? tokens.refreshToken,
			},
		};
	}

	async signOut(
		session: Parameters<FederationEngine['signOut']>[0],
		context: BlocksContext,
	): Promise<{ logoutUrl?: string }> {
		let ids: HostedUiIdentifiers;
		try {
			ids = this.ids();
		} catch {
			// Logged by `ids()`: the local session is still cleared by `AuthBase`.
			return {};
		}
		if (session.kind === 'pool' && session.tokens.refreshToken) {
			await this.revoke(ids, session.tokens.refreshToken);
		}
		const logout = new URL(`${ids.baseUrl}/logout`);
		logout.searchParams.set('client_id', ids.clientId);
		logout.searchParams.set('logout_uri', `${appBaseUrl(context)}${this.signOutPath}`);
		return { logoutUrl: logout.toString() };
	}

	async refreshBearer(_context: BlocksContext, refreshToken: string): Promise<BearerTokens | null> {
		const ids = this.ids();
		const out = await this.tokenRequest(
			ids,
			{ grant_type: 'refresh_token', refresh_token: refreshToken },
			'refresh',
		);
		if (!out) return null;
		return {
			accessToken: out.accessToken,
			refreshToken: out.refreshToken ?? refreshToken,
			expiresIn: out.expiresIn ?? DEFAULT_TOKEN_LIFETIME_SECONDS,
		};
	}

	// ── Internals ───────────────────────────────────────────────────────────

	private get callbackPath(): string {
		return this.host.options.redirects?.callbackPath ?? DEFAULT_CALLBACK_PATH;
	}

	private get signOutPath(): string {
		return this.host.options.redirects?.signOutPath ?? DEFAULT_SIGN_OUT_PATH;
	}

	private get crossDomain(): boolean {
		return this.host.options.session?.crossDomain ?? false;
	}

	/**
	 * The domain, the hosted-UI client id and the pool id, resolved now. Throws
	 * a clear `500` (detail in the log) when the deployment registered none —
	 * hosted-UI providers need the pool, the domain and the client D3b provisions.
	 */
	private ids(): HostedUiIdentifiers {
		const registered = getSdkIdentifiers(this.host.scope);
		const domain = registered[HOSTED_UI_IDENTIFIERS.domain] ?? '';
		const clientId = registered[HOSTED_UI_IDENTIFIERS.clientId] ?? '';
		const userPoolId = registered.userPoolId ?? '';
		const baseUrl = domain ? hostedUiBaseUrl(domain) : undefined;
		if (!baseUrl || !clientId || !userPoolId) {
			const keys = federationConfigKeys(this.host.scope.fullId);
			this.host.log.error(
				`[bb-auth] sign-in provider '${this.provider.id}' federates through Cognito managed login, but this ` +
					'runtime has no hosted-UI configuration. Redeploy the stack so the CDK layer provisions the user ' +
					'pool, its domain and the hosted-UI app client and registers their config keys.',
				{
					provider: this.provider.id,
					missing: [
						...(domain ? [] : [keys.DOMAIN]),
						...(domain && !baseUrl ? [`${keys.DOMAIN} (not an https host)`] : []),
						...(clientId ? [] : [keys.HOSTED_UI_CLIENT_ID]),
						...(userPoolId ? [] : ['the user pool id']),
					],
				},
			);
			throw new ApiError(
				`Sign-in provider '${this.provider.id}' is not available: this deployment has no Cognito managed-login ` +
					'configuration. Redeploy the stack.',
				500,
				{ name: AuthErrors.ProviderMisconfigured },
			);
		}
		return { baseUrl, clientId, userPoolId };
	}

	/** The ID-token verifier for the pool + hosted-UI client, recreated if either changes. */
	private verifier(ids: HostedUiIdentifiers): IdTokenVerifier {
		const key = `${ids.userPoolId}\n${ids.clientId}`;
		if (this.verifierCache?.key !== key) {
			this.verifierCache = {
				key,
				verifier: CognitoJwtVerifier.create(
					{ userPoolId: ids.userPoolId, clientId: ids.clientId, tokenUse: 'id' },
					{ jwksCache: this.jwksCache },
				),
			};
		}
		return this.verifierCache.verifier;
	}

	/**
	 * Verify a Cognito ID token (signature, issuer = the pool, audience = the
	 * hosted-UI client, `token_use: id`, expiry). A JWKS fetch failure is a
	 * retriable `502`; anything about the token itself is a `401`.
	 */
	private async verifyIdToken(ids: HostedUiIdentifiers, idToken: string): Promise<Record<string, unknown>> {
		try {
			const payload = await this.verifier(ids).verify(idToken);
			return { ...payload };
		} catch (e) {
			const transient = isTransientVerifyFailure(e);
			this.host.log.warn('[bb-auth] Cognito ID token verification failed', {
				provider: this.provider.id,
				error: e instanceof Error ? e.name : typeof e,
				message: e instanceof Error ? e.message : undefined,
			});
			if (transient) throw idpError('The sign-in service is unreachable. Please try again.', 502, true);
			throw idpError('Cognito returned an ID token that failed verification.', 401);
		}
	}

	/** Exchange a code (with its PKCE verifier) and turn the result into a verified pool identity. */
	private async redeem(code: string, codeVerifier: string, redirectUri: string): Promise<FederatedIdentity> {
		const ids = this.ids();
		const out = await this.tokenRequest(
			ids,
			{ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier },
			'code',
		);
		if (!out) throw idpError('Cognito rejected the authorization code. Start the sign-in again.');
		if (!out.idToken) throw idpError('Cognito did not return an ID token.');
		const claims = await this.verifyIdToken(ids, out.idToken);
		// The user picked the IdP in the authorize URL (`identity_provider`), which
		// the browser controls: the verified identity must come from this provider,
		// or `validateUser` / `signInProvider` would see the wrong one.
		const providers = identityProviderNames(claims);
		if (!providers.includes(this.providerName)) {
			this.host.log.warn('[bb-auth] Cognito ID token is for another identity provider', {
				provider: this.provider.id,
				expected: this.providerName,
				actual: providers,
			});
			throw idpError('The sign-in completed with a different identity provider than the one requested.', 401);
		}
		return {
			kind: 'pool',
			tokens: { idToken: out.idToken, accessToken: out.accessToken, refreshToken: out.refreshToken ?? '' },
		};
	}

	/**
	 * POST `/oauth2/token` as the public hosted-UI client (no secret: PKCE binds
	 * the code). Returns `null` when Cognito **rejected** the grant (an OAuth
	 * error); throws a retriable `IdpError` for a transport failure or a 5xx.
	 */
	private async tokenRequest(
		ids: HostedUiIdentifiers,
		params: Record<string, string>,
		purpose: 'code' | 'refresh',
	): Promise<{ accessToken: string; idToken?: string; refreshToken?: string; expiresIn?: number } | null> {
		let res: Response;
		try {
			res = await fetch(`${ids.baseUrl}/oauth2/token`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					Accept: 'application/json',
					'User-Agent': USER_AGENT,
				},
				body: new URLSearchParams({ ...params, client_id: ids.clientId }),
				signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
			});
		} catch (e) {
			this.host.log.error('[bb-auth] Cognito token endpoint unreachable', {
				provider: this.provider.id,
				purpose,
				error: e instanceof Error ? e.message : String(e),
			});
			throw idpError('The sign-in service is unreachable. Please try again.', 502, true);
		}
		let json: unknown = null;
		try {
			json = await res.json();
		} catch {
			json = null;
		}
		const obj = typeof json === 'object' && json !== null ? json : {};
		if (res.status >= 500) {
			this.host.log.error('[bb-auth] Cognito token endpoint failed', {
				provider: this.provider.id,
				purpose,
				status: res.status,
			});
			throw idpError('The sign-in service failed. Please try again.', 502, true);
		}
		const oauthError = stringField(obj, 'error');
		if (!res.ok || oauthError) {
			this.host.log.warn('[bb-auth] Cognito token request rejected', {
				provider: this.provider.id,
				purpose,
				status: res.status,
				error: oauthError,
			});
			return null;
		}
		const accessToken = stringField(obj, 'access_token');
		if (!accessToken) {
			this.host.log.warn('[bb-auth] Cognito token response has no access_token', {
				provider: this.provider.id,
				purpose,
			});
			return null;
		}
		const idToken = stringField(obj, 'id_token');
		const refreshToken = stringField(obj, 'refresh_token');
		const expiresIn = numberField(obj, 'expires_in');
		return {
			accessToken,
			...(idToken ? { idToken } : {}),
			...(refreshToken ? { refreshToken } : {}),
			...(expiresIn !== undefined ? { expiresIn } : {}),
		};
	}

	/** `/oauth2/revoke` for a refresh token, best-effort (never throws). */
	private async revoke(ids: HostedUiIdentifiers, refreshToken: string): Promise<void> {
		try {
			const res = await fetch(`${ids.baseUrl}/oauth2/revoke`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
				body: new URLSearchParams({ token: refreshToken, client_id: ids.clientId }),
				signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
			});
			if (!res.ok) {
				this.host.log.warn('[bb-auth] Cognito token revocation was refused (best-effort)', {
					provider: this.provider.id,
					status: res.status,
				});
			}
		} catch (e) {
			this.host.log.warn('[bb-auth] Cognito token revocation failed (best-effort)', {
				provider: this.provider.id,
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}
}

/** The `sub` of a stored (already verified) ID token, or `''`. */
function subjectOf(idToken: string): string {
	const part = idToken.split('.')[1];
	if (!part) return '';
	try {
		const payload: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
		if (typeof payload !== 'object' || payload === null) return '';
		const sub: unknown = Reflect.get(payload, 'sub');
		return typeof sub === 'string' ? sub : '';
	} catch {
		return '';
	}
}
