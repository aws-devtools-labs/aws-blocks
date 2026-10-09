// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The CDK ↔ runtime contract of `Auth`: what gets provisioned for a given
 * options object, and the names every layer derives from `fullId`.
 *
 * Pure and dependency-free (no `aws-cdk-lib`, no SDK), so the runtime layers
 * (D5/D6) import the same functions the CDK layer uses. Each layer computes
 * these independently from the same inputs — the CDK layer does not hand them
 * to the runtime — so they must never diverge.
 *
 * Everything here is part of the frozen contract with `AuthCognito`
 * deployments: the config-key names and the cookie name are pinned by
 * `resource-identity.cdk.test.ts`. Renaming one signs every user out or makes
 * the runtime look up a pool that it can no longer find.
 *
 * @internal
 */

import type { AuthOptions } from '../types.js';

/**
 * The `registerConfig()` keys the CDK layer writes when a user pool exists —
 * byte-identical to `AuthCognito`'s `envVarNames()`, so an app that switches
 * from `AuthCognito` keeps reading the same keys.
 *
 * When the configuration provisions **no** pool (see {@link requiresUserPool}),
 * none of these keys is registered.
 *
 * @internal
 */
export function cognitoConfigKeys(fullId: string) {
	const upper = fullId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
	return {
		USER_POOL_ID: `BLOCKS_AUTH_COGNITO_${upper}_USER_POOL_ID`,
		CLIENT_ID: `BLOCKS_AUTH_COGNITO_${upper}_CLIENT_ID`,
		REGION: `BLOCKS_AUTH_COGNITO_${upper}_REGION`,
	} as const;
}

/**
 * The `registerConfig()` key that carries the backend's API Gateway URL (its
 * `apiUrl`, `https://<id>.execute-api.<region>.amazonaws.com/<stage>/aws-blocks/api`)
 * to the runtime, registered only when a `stubIdp()` provider sets
 * `unsafeAllowDeployed`. The deployed stub IdP builds its issuer from it, so
 * the issuer is the same HTTPS URL whichever front door a request came through
 * (CloudFront, the gateway, or the sandbox dev server's loopback proxy) and the
 * Lambda can always reach it.
 *
 * @internal
 */
export function stubIdpConfigKeys(fullId: string) {
	const upper = fullId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
	return { API_URL: `BLOCKS_AUTH_STUB_IDP_${upper}_API_URL` } as const;
}

/**
 * The session cookie name — `auth_<fullId>`, the same as `AuthCognito`, so a
 * signed-in session survives the switch. The runtime's cookie writer and reader
 * (D5) must derive the name from here.
 *
 * @internal
 */
export function sessionCookieName(fullId: string): string {
	return `auth_${fullId}`;
}

/**
 * The ids of the configured providers that federate **through Cognito**: every
 * `socialProviders` and `samlProviders` key, plus each `oidcProviders` key whose
 * entry sets `federateVia: 'cognito'`. Directly federated OIDC providers are
 * excluded — they involve no Cognito resources.
 *
 * Only entries whose value is set count: `{ google: undefined }` is not a
 * configured provider.
 *
 * @internal
 */
export function cognitoFederatedProviderIds(options: AuthOptions | undefined): string[] {
	const ids: string[] = [];
	for (const [id, value] of Object.entries(options?.socialProviders ?? {})) {
		if (value) ids.push(id);
	}
	for (const [id, value] of Object.entries(options?.samlProviders ?? {})) {
		if (value) ids.push(id);
	}
	for (const [id, value] of Object.entries(options?.oidcProviders ?? {})) {
		if (value?.federateVia === 'cognito') ids.push(id);
	}
	return ids;
}

/**
 * Whether email + password sign-in is enabled. `emailPassword` defaults to on;
 * only a literal `false` disables it.
 *
 * @internal
 */
export function emailPasswordEnabled(options: AuthOptions | undefined): boolean {
	return options?.emailPassword !== false;
}

/**
 * Whether users may register themselves (`SignUp`): email + password is
 * enabled and `emailPassword.selfSignUp` is not `false`. The CDK layer
 * provisions the pool with `selfSignUpEnabled` set to this
 * (`AllowAdminCreateUserOnly` is its negation), and both engines refuse
 * `signUp` with `NotAuthorizedException` when it is `false`, before any
 * attribute rule (FX44, R79) — on a wrapped pool too, where the option is the
 * app's promise that "users are created only through `auth.admin`".
 *
 * Only `false` disables it, so a non-boolean `selfSignUp` (`0`) would enable
 * it: every entry's option validator rejects one at construction, before this
 * is read (`option-validation.ts`, FX53, R85).
 *
 * @internal
 */
export function selfSignUpEnabled(options: AuthOptions | undefined): boolean {
	if (!emailPasswordEnabled(options)) return false;
	const ep = options?.emailPassword;
	return typeof ep === 'object' ? ep.selfSignUp !== false : true;
}

/**
 * Whether options need a Cognito user pool (decision Q6).
 *
 * `true` when email + password is enabled (the default), when any provider
 * federates through Cognito (see {@link cognitoFederatedProviderIds}), or when
 * an existing pool is wrapped via `userPool`. `false` only for a configuration
 * whose sign-in methods are all directly federated OIDC providers: the CDK
 * layer then synthesizes **no** Cognito resources — only `sessions` and
 * `session-secret` — and registers no `BLOCKS_AUTH_COGNITO_*` config key.
 *
 * **How the runtime tells that no pool exists:** it calls this function on its
 * own copy of the options (the backend module, and so the options object, is
 * evaluated identically in every layer). It must not infer "no pool" from a
 * missing config key alone: a missing key when this returns `true` is a
 * deployment/config error and must fail loudly, never degrade to pool-less.
 *
 * @internal
 */
export function requiresUserPool(options: AuthOptions | undefined): boolean {
	return (
		options?.userPool !== undefined ||
		emailPasswordEnabled(options) ||
		cognitoFederatedProviderIds(options).length > 0
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// validateUser's PreSignUp trigger (Q10, R2-1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether the CDK layer wires the pool's Cognito PreSignUp trigger
 * (`LambdaConfig.PreSignUp`) for these options: `validateUser` is set and the
 * block **creates** its pool. A pool wrapped with `userPool` belongs to its
 * owner, triggers included, and a pool-less configuration has none.
 *
 * Only the CDK layer calls this. The runtime does not re-derive it: it reads
 * the {@link preSignUpTriggerConfigKey} flag the CDK layer registered.
 *
 * @internal
 */
export function ownsPreSignUpTrigger(options: AuthOptions | undefined): boolean {
	return requiresUserPool(options) && options?.validateUser !== undefined && options.userPool === undefined;
}

/**
 * The `registerConfig()` key that marks this block as the owner of its pool's
 * PreSignUp trigger (value `'true'`). Registered only when
 * {@link ownsPreSignUpTrigger} holds, so the runtime registers the trigger's
 * Lambda event handler (keyed by user pool id) for exactly the block the
 * trigger was wired for — never for a second `Auth` wrapping the same pool,
 * which would otherwise take the handler over (R2-1).
 *
 * Kept apart from {@link cognitoConfigKeys}, whose three keys are pinned
 * against `AuthCognito`.
 *
 * @internal
 */
export function preSignUpTriggerConfigKey(fullId: string): string {
	const upper = fullId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
	return `BLOCKS_AUTH_COGNITO_${upper}_PRE_SIGN_UP_TRIGGER`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hosted-UI federation (D3b)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The reserved route subtree every auth route lives under. Identical to
 * `BLOCKS_AUTH_PREFIX` in `@aws-blocks/core` (kept a literal so this module stays
 * dependency-free; `federation.cdk.test.ts` pins the two together). Core's
 * Hosting proxies the whole subtree to the API with one CloudFront behavior.
 *
 * @internal
 */
export const AUTH_ROUTE_PREFIX = '/aws-blocks/auth';

/** Default federated-sign-in callback path (`RedirectOptions.callbackPath`). @internal */
export const DEFAULT_CALLBACK_PATH = `${AUTH_ROUTE_PREFIX}/callback`;

/** Default post-sign-out landing path (`RedirectOptions.signOutPath`). @internal */
export const DEFAULT_SIGNOUT_PATH = `${AUTH_ROUTE_PREFIX}/signout`;

/**
 * The callback and sign-out paths, with defaults applied. The CDK layer
 * registers `<front door><path>` on the hosted-UI app client as its callback /
 * logout URLs; the runtime (D6) must send exactly these as `redirect_uri` /
 * `logout_uri`, or Cognito rejects the request.
 *
 * @internal
 */
export function federationRedirectPaths(options: AuthOptions | undefined): {
	callbackPath: string;
	signOutPath: string;
} {
	return {
		callbackPath: options?.redirects?.callbackPath ?? DEFAULT_CALLBACK_PATH,
		signOutPath: options?.redirects?.signOutPath ?? DEFAULT_SIGNOUT_PATH,
	};
}

/**
 * The `registerConfig()` keys the CDK layer writes **only when hosted-UI
 * federation is enabled** (see {@link cognitoFederatedProviderIds}). A
 * configuration without a Cognito-federated provider registers neither.
 *
 * - `DOMAIN` — the hosted-UI host, `<prefix>.auth.<region>.amazoncognito.com`
 *   (no scheme). The runtime builds `https://<DOMAIN>/oauth2/authorize`,
 *   `/oauth2/token`, `/oauth2/revoke` and `/logout` from it.
 * - `HOSTED_UI_CLIENT_ID` — the separate hosted-UI app client (public client,
 *   authorization-code grant with PKCE). Never the native `client`.
 *
 * Kept apart from {@link cognitoConfigKeys}, whose three keys are pinned
 * against `AuthCognito`.
 *
 * @internal
 */
export function federationConfigKeys(fullId: string) {
	const upper = fullId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
	return {
		DOMAIN: `BLOCKS_AUTH_COGNITO_${upper}_DOMAIN`,
		HOSTED_UI_CLIENT_ID: `BLOCKS_AUTH_COGNITO_${upper}_HOSTED_UI_CLIENT_ID`,
	} as const;
}

/** Which options record a Cognito-federated provider comes from. @internal */
export type CognitoFederatedKind = 'social' | 'saml' | 'oidc';

/** Cognito's fixed `ProviderName` for each social provider (the name is the type). */
const SOCIAL_PROVIDER_NAMES: Readonly<Record<string, string>> = {
	google: 'Google',
	facebook: 'Facebook',
	amazon: 'LoginWithAmazon',
	apple: 'SignInWithApple',
};

/**
 * The Cognito `ProviderName` for a provider: the fixed name for a social
 * provider (`google` → `Google`, `amazon` → `LoginWithAmazon`, `apple` →
 * `SignInWithApple`, …), otherwise the provider id itself. It is what the
 * hosted-UI client lists in `SupportedIdentityProviders` and what the runtime
 * passes as `identity_provider=` to `/oauth2/authorize` to skip Cognito's own
 * page and go straight to the IdP.
 *
 * @internal
 */
export function cognitoProviderName(kind: CognitoFederatedKind, id: string): string {
	return kind === 'social' ? (SOCIAL_PROVIDER_NAMES[id] ?? id) : id;
}

/**
 * Every provider that federates through Cognito, in a stable order (social,
 * then SAML, then `federateVia: 'cognito'` OIDC — the order of
 * {@link cognitoFederatedProviderIds}), with its Cognito provider name.
 *
 * @internal
 */
export function cognitoFederatedProviders(
	options: AuthOptions | undefined,
): { id: string; kind: CognitoFederatedKind; providerName: string }[] {
	const out: { id: string; kind: CognitoFederatedKind; providerName: string }[] = [];
	for (const [id, value] of Object.entries(options?.socialProviders ?? {})) {
		if (value) out.push({ id, kind: 'social', providerName: cognitoProviderName('social', id) });
	}
	for (const [id, value] of Object.entries(options?.samlProviders ?? {})) {
		if (value) out.push({ id, kind: 'saml', providerName: id });
	}
	for (const [id, value] of Object.entries(options?.oidcProviders ?? {})) {
		if (value?.federateVia === 'cognito') out.push({ id, kind: 'oidc', providerName: id });
	}
	return out;
}
