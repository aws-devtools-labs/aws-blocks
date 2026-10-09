// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bearer-token authentication for the guards (`allowBearerAuth`, task D6c).
 *
 * The native SDKs (Dart's `BlocksClient` with an `AuthProvider`, or app code
 * on Swift / Kotlin) send `Authorization: Bearer <access token>` instead of a
 * cookie. With `allowBearerAuth: true`, `requireAuth` / `requireRole` /
 * `checkAuth` / `getCurrentUser` / `getAuthSession` accept such a token —
 * matching `AuthOIDC` on the wire, so the SDKs work unchanged:
 *
 * - **Precedence** (`AuthOIDC`'s): the session cookie first. The bearer token
 *   is consulted only when the request has no valid cookie session.
 * - **Direct-OIDC users**: the IdP's JWT access token — what `/exchange`
 *   returns as `accessToken` and `/exchange/refresh` renews — verified by the
 *   provider's engine against the IdP's JWKS (issuer, `aud` = client id,
 *   expiry, asymmetric algorithms only): {@link FederationEngine.verifyBearer}.
 *   Identity is `` `${iss}:${sub}` `` (Q1); groups come from `groupsClaim`.
 * - **Pool users** (email + password, or federated through Cognito): the
 *   Cognito access token, verified by the entry's {@link PoolBearerVerifier}
 *   (AWS: `aws-jwt-verify`, `token_use: access`, the native or the hosted-UI
 *   client). `requireRole` still reads live groups.
 * - **Errors** (`AuthOIDC`'s): any token that does not verify — malformed,
 *   unsigned, wrong issuer or audience, expired — is simply "no user": the
 *   guards answer 401 `NotAuthenticatedException`. `TokenExpiredException` is
 *   only ever sent by the `/refresh` routes, as `AuthOIDC` sends it.
 * - **Not checked against the session store**: a bearer token outlives
 *   `signOut()` until it expires. `AuthOIDC` documents the same.
 *
 * Only the guards accept a bearer token. The signed-in user's account surface
 * (attributes, password, MFA, devices, passkeys) still needs the session
 * cookie.
 *
 * This module holds the engine-agnostic, pure part; the verifiers live with
 * their layer (`bearer-cognito.ts` for AWS, `bearer-mock.ts` locally) and the
 * direct engine.
 *
 * @internal
 */

import { cognitoFederatedProviders } from './cdk/contract.js';
import type { SessionIdentity } from './sessions.js';
import type { AuthOptions } from './types.js';

/**
 * The token of an `Authorization: Bearer <token>` header (scheme matched
 * case-insensitively, RFC 7235), or `null` when there is none.
 *
 * @internal
 */
export function bearerTokenOf(headers: Headers): string | null {
	const value = headers.get('authorization');
	if (!value) return null;
	const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(value);
	return match ? match[1] : null;
}

/**
 * The JOSE header's `alg` of a compact JWT, or `''` when it has none or does
 * not parse.
 *
 * @internal
 */
export function jwtHeaderAlg(token: string): string {
	try {
		const header: unknown = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'));
		const alg: unknown = typeof header === 'object' && header !== null ? Reflect.get(header, 'alg') : undefined;
		return typeof alg === 'string' ? alg : '';
	} catch {
		return '';
	}
}

function stringClaim(claims: Record<string, unknown>, key: string): string {
	const v = claims[key];
	return typeof v === 'string' ? v : '';
}

function numberClaim(claims: Record<string, unknown>, key: string): number {
	const v = claims[key];
	return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * The configured Cognito-federated provider a pool username belongs to.
 * Cognito names a federated user `<ProviderName>_<idp user id>`; the match on
 * the provider name is case-insensitive. `undefined` for a pool (password)
 * user, or a prefix no configured provider owns.
 *
 * @internal
 */
export function federatedProviderOfUsername(username: string, options: AuthOptions): string | undefined {
	const lower = username.toLowerCase();
	for (const { id, providerName } of cognitoFederatedProviders(options)) {
		if (lower.startsWith(`${providerName.toLowerCase()}_`)) return id;
	}
	return undefined;
}

/**
 * The identity a verified Cognito **access token** represents — the same
 * `userId` / `username` / `userSub` a cookie session for that user has
 * (`identityOf` reads them from the ID token; the access token carries the
 * same `username` and `sub`). An access token carries no profile claims, so
 * `attributes` is empty; `groups` is the token's `cognito:groups` snapshot
 * (`requireRole` reads live groups instead). `null` without a `username` and
 * a `sub`.
 *
 * @internal
 */
export function poolBearerIdentity(
	claims: Record<string, unknown>,
	hostedUi: boolean,
	options: AuthOptions,
): SessionIdentity | null {
	const username = stringClaim(claims, 'username');
	const userSub = stringClaim(claims, 'sub');
	if (!username || !userSub) return null;
	const rawGroups = claims['cognito:groups'];
	const groups = Array.isArray(rawGroups) ? rawGroups.filter((g): g is string => typeof g === 'string') : [];
	return {
		userId: username,
		username,
		userSub,
		groups,
		attributes: {},
		signInProvider: (hostedUi && federatedProviderOfUsername(username, options)) || 'password',
		authTime: numberClaim(claims, 'auth_time') || numberClaim(claims, 'iat'),
		expiresAt: numberClaim(claims, 'exp') * 1000,
		// Nor the ID token's `*_verified` flags.
		verified: {},
	};
}
