// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Public types for the unified `Auth` Building Block.
 *
 * TYPES ONLY: this module uses `import type` exclusively and declares no
 * values (no `const`, `function` or `class`), so every entry point — mock,
 * AWS, CDK and browser — can re-export it without pulling in runtime code.
 *
 * Status: published as `@aws-blocks/bb-auth` and exported from the
 * `@aws-blocks/blocks` umbrella (designed in tasks D1/D2 of the
 * auth-unification plan). The option groups and the gated method surface
 * below are the contract the runtime layers (D3–D7) implement. `types-test.ts` is the compile-time proof
 * that the mode gates work and that `Auth<O>` stays covariant in `O`.
 */

import type { AuthStateApi, AuthUser, BlocksAuth } from '@aws-blocks/auth-common';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import type { BlocksContext } from '@aws-blocks/core';

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options for the `Auth` Building Block.
 *
 * Every capability is opt-in through its own named group, and the groups are
 * independent: enabling federation does not disable email+password, and
 * `emailPassword: false` does not stop you from configuring other providers.
 *
 * **The zero-config default is email + password.** `new Auth(scope, 'auth')`
 * gives you self-service sign-up (with an emailed confirmation code), sign-in
 * and password reset, with no AWS account needed locally.
 *
 * **What gets provisioned.** A Cognito user pool is created only when the
 * configuration needs one: email + password (the default), any
 * {@link AuthOptions.socialProviders} or {@link AuthOptions.samlProviders}
 * entry, or an {@link AuthOptions.oidcProviders} entry with
 * `federateVia: 'cognito'`. A configuration whose only sign-in method is a
 * directly federated OIDC provider provisions **no** Cognito resources — only
 * the session table and the session-signing secret. Enabling one of the
 * pool-backed methods later adds the pool; it never replaces anything.
 *
 * **Type narrowing.** `Auth` captures the options literal (`const O`), so the
 * compiler knows which methods your configuration supports. Pass the options
 * inline (or with `satisfies AuthOptions`), not through a variable annotated
 * `: AuthOptions`, or the narrowing is lost.
 *
 * **Unknown options are an error.** The constructor rejects any key it does not
 * recognise, at any nesting level, naming its path and the likely intended
 * option (`preferredChallenge` → `users.preferredChallenge`). The compiler alone
 * cannot catch these: TypeScript does no excess-property check on the inferred
 * options type.
 *
 * @example Minimal (email + password)
 * ```ts
 * const auth = new Auth(scope, 'auth');
 * export const authApi = auth.createApi();
 * ```
 *
 * @example Okta only, no native users, no Cognito pool
 * ```ts
 * const auth = new Auth(scope, 'auth', {
 *   emailPassword: false,
 *   oidcProviders: { okta: { issuer: 'https://dev-12345.okta.com', clientId: '0oa…' } },
 * });
 * ```
 */
export interface AuthOptions {
	/**
	 * Email/username + password sign-in, backed by a Cognito user pool.
	 *
	 * `true` (or omitted) enables it with defaults; an {@link EmailPasswordOptions}
	 * object enables it with settings. `false` disables it: the password
	 * methods (`signUp`, `signIn`, `resetPassword`, …) become **compile errors**
	 * on this instance (see {@link PasswordGate}), and the sign-in UI offers only
	 * the configured federated providers. If another configured provider still
	 * needs a pool (social, SAML or `federateVia: 'cognito'`), the pool is
	 * created with self-service sign-up turned off; otherwise no pool is created.
	 *
	 * Sign-up always verifies the user's email with an emailed code.
	 *
	 * @default true
	 */
	emailPassword?: boolean | EmailPasswordOptions;

	/**
	 * Social identity providers that Cognito supports natively, keyed by provider
	 * id. Closed set — each provider's options are fully typed.
	 *
	 * Social sign-in always federates through Cognito, so configuring any social
	 * provider provisions the user pool.
	 *
	 * The user signs in through Cognito managed login (the sign-in button goes
	 * straight to the provider) and becomes a user-pool user: Cognito groups,
	 * `requireRole()` and `auth.admin` work as for email + password users.
	 * Locally (`npm run dev`) managed login is unavailable — sign-in answers an
	 * actionable `501`; use a direct OIDC provider or `stubIdp()` offline. MFA is
	 * the provider's: Cognito never challenges a federated user, so enforce MFA
	 * at your IdP.
	 *
	 * **Billing:** social sign-in shares Cognito's 10,000-free-MAU tier with
	 * direct (email + password) sign-in. It does not move you onto the separate,
	 * much smaller meter that Cognito-federated OIDC and SAML use.
	 *
	 * For any other IdP that speaks OIDC, use {@link AuthOptions.oidcProviders}.
	 */
	socialProviders?: SocialProviders;

	/**
	 * Generic OIDC identity providers, keyed by the id you use in
	 * `getSignInUrl(context, '<id>')` and in the `signIn:<id>` UI action.
	 *
	 * Each provider is federated **directly** by default (`federateVia: 'direct'`):
	 * your backend performs OIDC discovery, PKCE and JWKS verification itself.
	 * That path involves no Cognito resources, works offline in `npm run dev`
	 * against the built-in stub IdP, and supports public (PKCE-only) clients.
	 * Set `federateVia: 'cognito'` on a provider to have Cognito federate it
	 * instead; see {@link OidcProviderOptions} for the trade-offs.
	 *
	 * ⚠️ **Billing for `federateVia: 'cognito'`.** Cognito meters federated OIDC
	 * and SAML users separately from direct and social sign-in: 50 free MAUs,
	 * then a per-MAU charge. Check current Cognito pricing before shipping.
	 *
	 * Ids must not collide with {@link AuthOptions.socialProviders} or
	 * {@link AuthOptions.samlProviders} keys — the constructor throws at synth if
	 * they do.
	 */
	oidcProviders?: Record<string, OidcProviderOptions>;

	/**
	 * SAML 2.0 identity providers, keyed by provider id. SAML always federates
	 * through Cognito, so configuring one provisions the user pool.
	 *
	 * Signs in through Cognito managed login, like {@link AuthOptions.socialProviders}
	 * (a user-pool user; unavailable in `npm run dev`). Enforce MFA at your IdP.
	 *
	 * ⚠️ Metered on the same separate 50-free-MAU tier as Cognito-federated
	 * OIDC (see {@link AuthOptions.oidcProviders}).
	 */
	samlProviders?: Record<string, SamlProviderOptions>;

	/**
	 * Multi-factor authentication. `'off' | 'optional' | 'required'` is shorthand
	 * for `{ mode }`.
	 *
	 * ⚠️ **Email + password sign-in only.** Cognito hands authentication of
	 * federated users entirely to their IdP and offers them no additional
	 * factors, so MFA never applies to a user who signed in through
	 * `socialProviders`, `oidcProviders` or `samlProviders`. Enforce MFA at the
	 * IdP for those users.
	 *
	 * @default 'off'
	 */
	mfa?: MfaMode | MfaOptions;

	/**
	 * WebAuthn passkeys. Requires `users.authFlow: 'USER_AUTH'` and a
	 * `featurePlan` above `'lite'`; both are checked at synth.
	 *
	 * ⚠️ Email + password sign-in only — see {@link AuthOptions.mfa}.
	 *
	 * @default false
	 */
	passkeys?: false | PasskeyOptions;

	/** User pool shape: what counts as a username, which attributes exist, which groups exist. */
	users?: UserPoolOptions;

	/**
	 * A single policy hook called for **every** sign-in and sign-up, whatever the
	 * mechanism — email + password, social, OIDC or SAML. Throw to reject; a
	 * thrown `ApiError` reaches the client by its `name`.
	 *
	 * This is the one place a rule such as "corporate domains only" or "must be
	 * on the allowlist" can live without being repeated per provider.
	 *
	 * @remarks
	 * On the **sign-in** path this runs in your own Lambda after the token
	 * exchange and before the session cookie is issued, so rejecting prevents
	 * the session. On the **self-service sign-up** path, blocking before the
	 * user record exists needs a Cognito PreSignUp trigger; the CDK layer
	 * provisions that trigger **only when this option is set**.
	 *
	 * In detail (`phase` tells the two apart):
	 * - **`phase: 'signUp'`** — `auth.signUp()` and `auth.admin.createUser()`
	 *   call it first, in-process, before anything reaches Cognito, so a
	 *   rejection reaches the client exactly as locally. On a pool this block
	 *   creates, the CDK layer also wires the pool's Cognito PreSignUp trigger to
	 *   your backend Lambda, which calls it for every pool user Cognito is about
	 *   to create that the app did not: a `SignUp` sent straight to Cognito with
	 *   the app client id, an `AdminCreateUser` from the console or CLI, and the
	 *   **first** sign-in of a social, SAML or `federateVia: 'cognito'` user.
	 *   One sign-up runs it once: the in-process call marks the Cognito request
	 *   (a signed `ClientMetadata` entry), and the trigger skips a marked one. A
	 *   rejection in the trigger reaches the client with the same `name` and
	 *   message. The trigger never confirms or verifies a user.
	 * - **`phase: 'signIn'`** — every sign-in, whatever the mechanism, including
	 *   a federated user's first one (which therefore runs both phases).
	 *
	 * Directly federated OIDC providers (the default transport, and `stubIdp()`)
	 * create no pool user, so they only ever see `phase: 'signIn'`. A pool
	 * wrapped with `userPool` gets no trigger (its triggers are its owner's):
	 * the in-process checks still run, users created directly in Cognito are not
	 * seen, and synth warns. The trigger runs in your backend Lambda and Cognito
	 * waits at most 5 seconds for it, so keep the check fast; a cold start counts.
	 *
	 * **Limitation — the 5-second trigger timeout.** Cognito gives a trigger 5
	 * seconds, and that budget includes a cold start of your shared backend
	 * Lambda (loading its config and importing your backend). If the trigger
	 * does not answer in time, the sign-up fails with a generic 500
	 * (`InternalErrorException`) and no user is created; nothing is let through.
	 * Mitigation: keep `validateUser` fast (no slow network calls; cache any
	 * allowlist you fetch), and if cold starts still exceed the budget, configure
	 * provisioned concurrency on the backend Lambda.
	 *
	 * @example
	 * ```ts
	 * validateUser: async ({ email, provider }) => {
	 *   if (provider !== 'password' && !email?.endsWith('@example.com')) {
	 *     throw new ApiError('Corporate accounts only', 403, { name: AuthErrors.NotAuthorized });
	 *   }
	 * }
	 * ```
	 */
	validateUser?: (candidate: UserCandidate) => Promise<void>;

	/** Session cookie and server-side session record behaviour. */
	session?: SessionOptions;

	/** HTTP paths for the federated redirect flow. All must sit under `/aws-blocks/auth/`. */
	redirects?: RedirectOptions;

	/** Cognito hosted-UI settings, used only when a provider federates through Cognito. */
	hostedUi?: HostedUiOptions;

	/**
	 * Enables the privileged `auth.admin` handle and grants the matching
	 * `Admin*`/`List*` IAM on the pool. Omit for the client-facing surface with
	 * no admin grant — the default. Carried over from `AuthCognito`, where it is
	 * already compiler-verified.
	 */
	admin?: AdminOptions;

	/**
	 * Accept `Authorization: Bearer <access token>` in addition to the session
	 * cookie, for native and CLI clients that cannot hold a cookie.
	 *
	 * Bearer tokens are validated from their claims and are **not** checked
	 * against the session store, so a bearer token outlives `signOut()` until it
	 * expires.
	 *
	 * What is accepted (the same as `AuthOIDC`, so the native SDKs work
	 * unchanged): a directly federated OIDC provider's JWT access token — the
	 * one `/aws-blocks/auth/exchange` returns and `/aws-blocks/auth/refresh`
	 * renews — verified against the provider's JWKS (issuer, audience = its
	 * client id, expiry); or, for a user-pool user, the Cognito access token.
	 * The session cookie takes precedence when a request carries both. A token
	 * that does not verify is answered like a missing session: 401
	 * `NotAuthenticatedException`. Only the guards (`requireAuth`, `requireRole`,
	 * `checkAuth`, `getCurrentUser`, `getAuthSession`) accept a bearer token; the
	 * signed-in user's account methods still need the session cookie. When
	 * `false`, an `Authorization` header is ignored.
	 *
	 * @default false
	 */
	allowBearerAuth?: boolean;

	/** Wrap a pre-existing Cognito user pool instead of provisioning one. Build the reference with `Auth.fromExisting()`. */
	userPool?: ExternalUserPoolRef;

	/** Called after a successful sign-in, before the response is returned. Throwing rolls the sign-in back. */
	onSignIn?: (user: AuthenticatedUser, context: BlocksContext) => Promise<void>;

	/** Called before the session is destroyed. Errors are logged and never block sign-out. */
	onSignOut?: (user: AuthenticatedUser, context: BlocksContext) => Promise<void>;

	/**
	 * What happens to the user pool and the session table when the block is
	 * removed from the stack.
	 *
	 * When omitted, the stack's defaults apply — the same as every other
	 * Building Block (for example, `BlocksPresets.production` retains,
	 * `BlocksPresets.sandbox` destroys). Set `'retain'` explicitly for any pool
	 * holding real users.
	 *
	 * @default the stack's `defaults.removalPolicy`
	 */
	removalPolicy?: 'destroy' | 'retain';

	/**
	 * Whether CloudFormation deletion protection is enabled on the user pool and
	 * the session table.
	 *
	 * On the user pool, only `true` is written to the template (`DeletionProtection:
	 * ACTIVE`); `false` leaves the property out, which Cognito treats as inactive.
	 * Changing an already-protected pool to `false` deactivates its protection on
	 * the next deploy.
	 *
	 * @default the stack's `defaults.deletionProtection`
	 */
	deletionProtection?: boolean;

	/**
	 * Cognito feature plan for the user pool. Always set explicitly on the pool
	 * (never left to the service default) so the pool cannot drift on
	 * `UpdateUserPool`.
	 *
	 * ⚠️ **This option is a pricing decision.** `'lite'` is the cheapest but
	 * cannot run passkeys, `USER_AUTH` (choice-based / passwordless) sign-in,
	 * email MFA, password history, refresh-token rotation or managed login — the
	 * block throws at synth if you combine `'lite'` with any of them.
	 *
	 * Ignored when no user pool is provisioned.
	 *
	 * @default 'essentials'
	 */
	featurePlan?: 'lite' | 'essentials' | 'plus';

	/** Optional logger. When omitted, a default `Logger` at `error` level is created. */
	logger?: ChildLogger;
}

/** Settings for {@link AuthOptions.emailPassword}. */
export interface EmailPasswordOptions {
	/**
	 * Allow users to register themselves. When `false`, users are created only
	 * through `auth.admin`.
	 *
	 * @default true
	 */
	selfSignUp?: boolean;

	/** Password strength requirements enforced by the pool. */
	passwordPolicy?: PasswordPolicy;

	/**
	 * Sign the user in automatically once they enter the emailed confirmation
	 * code, instead of asking them to type their password again.
	 *
	 * This does **not** skip email verification — every sign-up still confirms
	 * the address with an emailed code. It only removes the second password
	 * entry after `confirmSignUp`.
	 *
	 * @default true
	 */
	autoSignIn?: boolean;

	/**
	 * Whether the sign-in UI's sign-up form may tell the visitor that a username
	 * is already registered.
	 *
	 * With the default `false`, submitting the sign-up form for an existing
	 * account answers exactly like a new sign-up — "enter the code we emailed
	 * you" — so the form cannot be used to discover which accounts exist.
	 * Set `true` to surface `UsernameExistsException` instead (friendlier when
	 * account existence is not sensitive for your app).
	 *
	 * Applies to the `setAuthState({ action: 'signUp' })` path the UI drives.
	 * Calling `auth.signUp()` from your own server code always throws
	 * `UsernameExistsException` for an existing user: that code is inside your
	 * trust boundary and usually needs to know.
	 *
	 * The steps that follow the sign-up form are covered too, both through
	 * `setAuthState` and when you call the methods directly: with the default
	 * `false`, an unknown user, an unconfirmed user and an already-confirmed
	 * user get identical answers from `confirmSignUp` (a wrong code — also for
	 * an expired code), `resendSignUpCode` (a silent success; no code is sent
	 * to a confirmed user), `resetPassword` (the same delivery details) and
	 * `confirmResetPassword` (a wrong code). Set `true` to surface Cognito's
	 * informative answers there as well (for example `NotAuthorizedException`
	 * "User cannot be confirmed. Current status is CONFIRMED", or
	 * `ExpiredCodeException`).
	 *
	 * @default false
	 */
	revealExistingUsers?: boolean;
}

/** Password strength requirements. */
export interface PasswordPolicy {
	/** @default 8 */
	minLength?: number;
	/** @default true */
	requireUppercase?: boolean;
	/** @default true */
	requireLowercase?: boolean;
	/** @default true */
	requireDigits?: boolean;
	/** @default true */
	requireSymbols?: boolean;
}

/**
 * A reference to an `AppSetting` holding a secret.
 *
 * Provider secrets are `AppSetting` references rather than strings: a literal
 * string in your backend module would be committed to source and baked into
 * the CloudFormation template. The reference also exposes `fullId`, so the CDK
 * layer can grant read access to the underlying parameter.
 *
 * Pass an `AppSetting` created with `secret: true` — at its default name, with
 * an explicit `name`, or via `AppSetting.fromExisting(scope, id, { name, secret: true })`.
 * At synth `Auth` reads the SSM name from the `AppSetting`'s `parameterName`,
 * and refuses a non-secret `AppSetting` or an object that is not an `AppSetting`.
 */
export interface AppSettingRef {
	/** The `AppSetting`'s scoped id. */
	readonly fullId: string;
	/** Read the secret value at request time. */
	get(): Promise<string>;
}

/** The social providers Cognito registers natively. */
export type SocialProviderId = 'google' | 'apple' | 'facebook' | 'amazon';

/** Configuration for {@link AuthOptions.socialProviders}, keyed by provider. */
export interface SocialProviders {
	/** Sign in with Google. */
	google?: OAuthCredentials & ProviderCommon;
	/** Sign in with Facebook. */
	facebook?: OAuthCredentials & ProviderCommon;
	/** Login with Amazon. */
	amazon?: OAuthCredentials & ProviderCommon;
	/** Sign in with Apple. Apple uses a signed JWT client assertion instead of a shared secret. */
	apple?: AppleCredentials & ProviderCommon;
}

/** Client credentials for an OAuth 2.0 / OIDC provider. */
export interface OAuthCredentials {
	/** Public client identifier. Not a secret; a literal string is fine. */
	clientId: string;
	/** Client secret, as an `AppSetting` reference. @see AppSettingRef */
	clientSecret: AppSettingRef;
}

/** Sign in with Apple credentials. */
export interface AppleCredentials {
	/** Services ID. */
	clientId: string;
	/** Apple Developer team id. */
	teamId: string;
	/** Key id for `privateKey`. */
	keyId: string;
	/** The `.p8` signing key, as an `AppSetting` reference. */
	privateKey: AppSettingRef;
}

/** Settings shared by every federated provider. */
export interface ProviderCommon {
	/**
	 * Scopes requested from the IdP. Defaults to `['openid', 'email', 'profile']`
	 * for OIDC providers and to the provider's documented minimum for social ones.
	 */
	scopes?: readonly string[];

	/**
	 * Maps IdP claims onto **profile** attributes, e.g. `{ email: 'email', name: 'name' }`.
	 *
	 * Identity is deliberately not mappable: `userId`, `userSub` and `sub` are
	 * typed `never`, so a mapping can change only what is known *about* a user,
	 * never *who* the user is. Identity comes from the provider's subject.
	 *
	 * ⚠️ For providers federated through Cognito, claims are mapped, not passed
	 * through, and mapping loses data: unmapped claims are dropped, multi-valued
	 * claims are flattened to a string, each attribute is capped at 2,048 bytes,
	 * and a mapped email is unverified unless `email_verified` is mapped too.
	 */
	attributeMapping?: Readonly<ProfileAttributeMapping>;

	/** Label for the generated `signIn:<id>` UI action. @default the provider id, title-cased */
	label?: string;
}

/** Profile-only claim mapping. Identity keys are closed off at the type level. */
export type ProfileAttributeMapping = Record<string, string> & {
	sub?: never;
	userSub?: never;
	userId?: never;
};

/** What {@link AuthOptions.validateUser} receives. Identity fields are read-only. */
export interface UserCandidate {
	/**
	 * `'password'` for email + password, otherwise the provider id. A user
	 * created with `auth.admin.createUser()` (or `AdminCreateUser`) is `'password'`.
	 */
	readonly provider: string;
	/**
	 * The provider's immutable subject. Empty on the email + password sign-up
	 * path, where no account (and so no subject) exists yet. Empty on every
	 * other `phase: 'signUp'` check too (an admin-created user, a federated
	 * first sign-in seen by the PreSignUp trigger), for the same reason.
	 */
	readonly subject: string;
	/** The user's email address, when known. */
	readonly email: string | null;
	/**
	 * The username the user signs in with. On a pool that signs in with email
	 * or phone only (`users.signInWith` without `'username'`), that address. For
	 * a federated first sign-in (PreSignUp trigger), Cognito's
	 * `<ProviderName>_<provider user id>` username.
	 */
	readonly username: string;
	/**
	 * Which path triggered the check: `'signUp'` before a pool user is created
	 * (sign-up, admin-created user, a federated user's first sign-in), `'signIn'`
	 * before a session is issued. See {@link AuthOptions.validateUser}.
	 */
	readonly phase: 'signUp' | 'signIn';
	/**
	 * Claims as received from the IdP, before any attribute mapping. On a
	 * `phase: 'signUp'` check these are the user attributes Cognito is about to
	 * store (for a federated first sign-in: after the provider's attribute
	 * mapping, which is all Cognito passes to the trigger).
	 */
	readonly claims: Readonly<Record<string, unknown>>;
}

/** Settings shared by both {@link OidcProviderOptions} engines. */
export interface OidcProviderBase extends ProviderCommon {
	/** Issuer URL. Endpoints are discovered from `{issuer}/.well-known/openid-configuration`. */
	issuer: string;
	/** Public client identifier. Not a secret; a literal string is fine. */
	clientId: string;
	/** Override discovery for a non-conformant IdP. All four are required together. */
	endpoints?: {
		authorization: string;
		token: string;
		userInfo: string;
		jwks: string;
	};
}

/**
 * An OIDC provider federated directly by your backend — the default.
 *
 * Your backend performs OIDC discovery, PKCE and JWKS verification itself. No
 * Cognito resources are involved, it works fully offline in `npm run dev`
 * against the built-in stub IdP, and it supports public (PKCE-only) clients.
 * The user has no Cognito pool record, so `auth.admin` does not apply to them;
 * their `userId` is `` `${issuer}:${sub}` ``.
 */
export interface DirectOidcProviderOptions extends OidcProviderBase {
	/** Federate this provider directly from your backend. @default 'direct' */
	federateVia?: 'direct';
	/** Client secret, as an `AppSetting` reference. Omit for a public (PKCE-only) client. */
	clientSecret?: AppSettingRef;
	/**
	 * ID-token claim to read group membership from, so `requireRole()` works for
	 * this provider's users (they have no Cognito groups). Read at sign-in and
	 * narrowed to the groups declared in `users.groups`.
	 *
	 * @example groupsClaim: 'groups'   // Okta, Entra ID
	 */
	groupsClaim?: string;
}

/**
 * An OIDC provider federated through Cognito.
 *
 * The user becomes a Cognito pool record, so Cognito groups and `auth.admin`
 * work the same as for email + password users, and your backend receives
 * Cognito-issued tokens. In exchange: a client secret is mandatory (Cognito
 * acts as a confidential client and performs no PKCE toward the IdP, so a
 * PKCE-only IdP cannot be federated this way), the user is billed on Cognito's
 * federated-MAU meter, and the hosted sign-in hop cannot run offline.
 *
 * Cognito delegates authentication of federated users to the IdP and never
 * challenges them with MFA: enforce MFA at your IdP.
 */
export interface CognitoOidcProviderOptions extends OidcProviderBase {
	/** Federate this provider through the Cognito user pool. */
	federateVia: 'cognito';
	/** Client secret, as an `AppSetting` reference. Required: Cognito is a confidential client. */
	clientSecret: AppSettingRef;
	/** How Cognito fetches the userinfo endpoint. @default 'GET' */
	attributesRequestMethod?: 'GET' | 'POST';
}

/**
 * Options for one {@link AuthOptions.oidcProviders} entry. `federateVia`
 * selects the engine and defaults to `'direct'`.
 */
export type OidcProviderOptions = DirectOidcProviderOptions | CognitoOidcProviderOptions;

/**
 * What a bare OAuth 2.0 provider's `mapClaims` returns: the identity and the
 * profile, read from the provider's userinfo response.
 */
export interface MappedClaims {
	/** The provider-local subject; the `sub` in `` userId = `${issuer}:${sub}` ``. */
	providerSub: string;
	/** The user's email address, or `null` if the provider did not supply one. */
	email: string | null;
	/** The user's display name, or `null` if the provider did not supply one. */
	name: string | null;
}

/**
 * A bare OAuth 2.0 provider (no ID token — e.g. GitHub), federated directly.
 * Build one with `github()` or `customOauth2()` and put it in
 * {@link AuthOptions.oidcProviders}; Cognito cannot federate bare OAuth 2.0.
 *
 * There is no ID token to verify, so the identity comes from the provider's
 * userinfo endpoint, called with the access token over TLS, and `mapClaims`
 * turns that response into a user. `issuer` is the synthetic
 * `` `oauth2:${name}` ``, so `userId` is `` `oauth2:${name}:${providerSub}` `` —
 * the same value `AuthOIDC` produced.
 */
export interface OAuth2ProviderOptions extends DirectOidcProviderOptions {
	/** Synthetic issuer `` `oauth2:${name}` `` — the identity namespace for `userId`. */
	issuer: `oauth2:${string}`;
	/** The OAuth 2.0 endpoints and the userinfo → user mapping. */
	oauth2: {
		endpoints: {
			/** Authorization endpoint (`response_type=code` + PKCE S256). */
			authorization: string;
			/** Token endpoint. */
			token: string;
			/** Userinfo endpoint, called with `Authorization: Bearer <access token>`. */
			userInfo: string;
		};
		/** Turn the userinfo response into the user's identity and profile. */
		mapClaims: (raw: unknown) => MappedClaims;
	};
}

/** A local identity the stub IdP can sign in. */
export interface StubUser {
	/** The provider-local subject identifier, surfaced as the ID token `sub`. */
	readonly sub: string;
	/** The user's email address, folded into the ID token `email` claim. */
	readonly email: string;
	/** The user's display name, folded into the ID token `name` claim. */
	readonly name: string;
	/** Extra claims folded into the ID token (e.g. `{ groups: ['admin'] }`). */
	readonly extra?: Record<string, unknown>;
}

/**
 * The authorize request handed to `stubIdp({ onAuthorize })`. `users` is the
 * configured local directory, so the callback can pick from it; `loginHint`
 * is the standard OIDC `login_hint` parameter.
 */
export interface StubAuthorizeRequest {
	/** The provider id this authorize request targets. */
	readonly provider: string;
	/** The OAuth scopes requested by the client. */
	readonly scopes: readonly string[];
	/** The client's redirect URI the stub sends the code back to. */
	readonly redirectUri: string;
	/** The opaque OAuth `state` parameter, round-tripped to the callback. */
	readonly state: string;
	/** The OIDC `nonce` parameter, echoed into the issued ID token. */
	readonly nonce: string;
	/** The standard OIDC `login_hint` parameter, if the client supplied one. */
	readonly loginHint?: string;
	/** The configured local directory the callback can pick a user from. */
	readonly users: readonly StubUser[];
}

/**
 * Decide what the stub IdP's `/authorize` does:
 *   return a user    → sign in as them, skip the account picker
 *   return undefined → show the account picker (default)
 *   throw            → deny the sign-in (`error=access_denied`)
 */
export type OnStubAuthorize = (req: StubAuthorizeRequest) => StubUser | undefined | Promise<StubUser | undefined>;

/** Settings of a {@link StubOidcProviderOptions} provider. */
export interface StubIdpSettings {
	/**
	 * The local identity directory for the account picker and `onAuthorize`.
	 * When set (and non-empty) it wins over a `.bb-data/<fullId>/users.json`
	 * fixture, which in turn wins over the single built-in default user.
	 */
	users?: readonly StubUser[];
	/** Decide the `/authorize` response. See {@link OnStubAuthorize}. */
	onAuthorize?: OnStubAuthorize;
	/**
	 * **Unsafe — for disposable test stacks only, never production.** Let a stack
	 * with this provider synthesize and deploy, and serve the stub IdP from the
	 * deployed backend (under `/aws-blocks/auth/idp/<id>/`) instead of only from
	 * `npm run dev`.
	 *
	 * What it exposes: the stub signs users in **without credentials**. Anyone
	 * who can reach the app can open the account picker (or hit `onAuthorize`)
	 * and sign in as any of the stub's users — the inline `users`, or the one
	 * built-in default user — with every claim in their `extra`, so a user with
	 * `extra: { groups: ['admin'] }` passes `requireRole('admin')`. Its signing
	 * keys are derived from the block's session secret, so its tokens cannot be
	 * forged without it, but the account picker itself is an open door. A
	 * deployed stub's refresh tokens are self-contained and revocation is
	 * remembered per Lambda instance only, so a revoked refresh token keeps
	 * working on other instances until it expires (30 days).
	 *
	 * Without it (the default), synthesizing a stack that contains this provider
	 * fails with "`stubIdp()` is local-only". With it, synth succeeds and emits a
	 * `@aws-blocks/bb-auth:StubIdpDeployed` warning. Use it for an e2e stack that
	 * needs a sign-in with no external IdP; remove it (or swap in the real
	 * provider) before anything real is deployed.
	 *
	 * @default false
	 */
	unsafeAllowDeployed?: boolean;
}

/**
 * A provider served by the built-in **stub IdP** — a real, local OIDC
 * provider (ES256-signed ID tokens, discovery, JWKS, PKCE S256) mounted on the
 * dev server under `/aws-blocks/auth/idp/<id>/`. Build one with `stubIdp()`.
 *
 * Local only: in `npm run dev` it gives `emailPassword: false` apps an offline
 * sign-in; a deployed stub provider answers every sign-in with an actionable
 * error. Users' `userId` is `` `${issuer}:${sub}` `` with the stub's local
 * issuer URL.
 *
 * Local only **by default**: synth refuses the provider unless it sets
 * {@link StubIdpSettings.unsafeAllowDeployed}, which serves the stub from the
 * deployed backend too (for disposable e2e stacks — anyone who can reach the
 * app can then sign in as the stub's users). Deployed, the issuer is the API
 * Gateway's own HTTPS URL plus `/aws-blocks/auth/idp/<id>`, the same value
 * `AuthOIDC`'s deployed stub used, so `userId`s carry over.
 */
export interface StubOidcProviderOptions extends DirectOidcProviderOptions {
	/** Placeholder; the real issuer is the stub's local URL, derived per request. */
	issuer: 'aws-blocks:stub-idp';
	/** The stub's user directory and authorize hook. */
	stubIdp: StubIdpSettings;
}

/** Options for `stubIdp()`. */
export interface StubIdpOptions extends StubIdpSettings {
	/** Scopes requested from the stub. @default ['openid', 'email', 'profile'] */
	scopes?: readonly string[];
	/** Label for the generated `signIn:<id>` UI action. */
	label?: string;
	/**
	 * ID-token claim the stub's groups are read from (set it per user with
	 * `extra: { groups: [...] }`), so `requireRole()` works locally.
	 *
	 * @default 'groups'
	 */
	groupsClaim?: string;
	/** Profile-attribute mapping, as for any OIDC provider. */
	attributeMapping?: Readonly<ProfileAttributeMapping>;
}

/** Credentials for `github()`. */
export interface GitHubOptions {
	/** The OAuth app's client id. Not a secret; a literal string is fine. */
	clientId: string;
	/** The OAuth app's client secret, as an `AppSetting` reference. */
	clientSecret: AppSettingRef;
	/** @default ['read:user', 'user:email'] */
	scopes?: readonly string[];
	/** Label for the generated `signIn:<id>` UI action. @default 'Sign in with GitHub' */
	label?: string;
}

/** Options for `customOauth2()`. */
export interface CustomOauth2Options {
	/**
	 * The identity namespace: users get `` userId = `oauth2:${name}:${providerSub}` ``.
	 * Use the same value as the `oidcProviders` key (and as `AuthOIDC`'s
	 * provider `name`, so existing user ids are unchanged).
	 */
	name: string;
	/** Public client id. Not a secret; a literal string is fine. */
	clientId: string;
	/** Client secret, as an `AppSetting` reference. Omit for a public (PKCE-only) client. */
	clientSecret?: AppSettingRef;
	/** The provider's authorization, token and userinfo endpoints. */
	endpoints: OAuth2ProviderOptions['oauth2']['endpoints'];
	/** Scopes requested from the provider. */
	scopes: readonly string[];
	/** Turn the userinfo response into the user's identity and profile. */
	mapClaims: (raw: unknown) => MappedClaims;
	/** Label for the generated `signIn:<id>` UI action. */
	label?: string;
}

/**
 * A validated relay-target origin for native and CLI clients (e.g.
 * `myapp://auth`). Build one with `relayOrigin()`; a plain string is rejected
 * at compile time so every entry has been checked.
 */
export type RelayOrigin = string & { readonly __brand: 'RelayOrigin' };

/** Options for one {@link AuthOptions.samlProviders} entry. */
export interface SamlProviderOptions extends ProviderCommon {
	/** IdP metadata document URL. Mutually exclusive with `metadataFile`. */
	metadataUrl?: string;
	/** Inline IdP metadata XML. Mutually exclusive with `metadataUrl`. */
	metadataFile?: string;
	/** Require signed SAML requests. @default false */
	signRequest?: boolean;
}

/** MFA enforcement level. */
export type MfaMode = 'off' | 'optional' | 'required';

/** Settings for {@link AuthOptions.mfa}. */
export interface MfaOptions {
	/** @default 'off' */
	mode?: MfaMode;
	/**
	 * Permitted second factors. `'EMAIL'` requires an existing pool with a
	 * configured email sender — the CDK layer throws at synth otherwise and
	 * points at `Auth.fromExisting`.
	 *
	 * @default ['SMS', 'TOTP']
	 */
	types?: readonly ('SMS' | 'TOTP' | 'EMAIL')[];
}

/** Settings for {@link AuthOptions.passkeys}. */
export interface PasskeyOptions {
	/** Relying-party id: the apex domain, no scheme and no port. There is no safe default. */
	relyingPartyId: string;
	/** Exact allowed origins, e.g. `['https://example.com']`. */
	origins: readonly string[];
	/**
	 * Whether the authenticator must verify the user (biometric or PIN).
	 * Cognito supports only `'required'` and `'preferred'`; WebAuthn's
	 * `'discouraged'` is deliberately not accepted (`AuthCognito` silently
	 * treated it as `'preferred'`).
	 *
	 * @default 'preferred'
	 */
	userVerification?: 'required' | 'preferred';
}

/** A custom user-pool attribute. */
export interface UserAttribute {
	/** Attribute name without the `custom:` prefix. */
	name: string;
	/** Attribute type. @default 'String' */
	type?: 'String' | 'Number';
	/** Whether the attribute is mutable after creation. @default true */
	mutable?: boolean;
	/** Whether the attribute is required at sign-up. @default false */
	required?: boolean;
}

/** Settings for {@link AuthOptions.users}. */
export interface UserPoolOptions {
	/**
	 * What a user types as their username.
	 *
	 * ⚠️ **Fixed once the pool exists.** Cognito cannot change sign-in or alias
	 * attributes on an existing pool. CloudFormation reports the change as
	 * "No interruption", then `UpdateUserPool` rejects it and the stack rolls
	 * back. Changing this means a new pool and a user migration, so the block
	 * refuses the change at synth.
	 *
	 * Without `'username'` (e.g. `['email']`), users sign up and in with their
	 * email / phone, but Cognito stores a **generated** username equal to
	 * `userSub` — so `username` / `userId` is that id, not the email; read the
	 * email from `attributes.email`. With `'username'`, the email / phone is an
	 * alias: it signs in only once verified, and a username may not look like
	 * one. The local runtime behaves the same way.
	 *
	 * @default ['username', 'email']
	 */
	signInWith?: readonly ('username' | 'email' | 'phone')[];

	/**
	 * **Custom** attributes only — standard OIDC attributes are implicit.
	 *
	 * ⚠️ **Additive only.** Existing custom attributes and required attributes
	 * cannot be renamed, retyped or removed (the same "No interruption", then
	 * rollback trap as `signInWith`). Limits: 50 custom attributes, 20-character
	 * names, 2,048 bytes each.
	 *
	 * Writes (`signUp`, `updateUserAttributes`, `admin.createUser`) may name
	 * only standard attributes and the attributes declared here, with string
	 * values; anything else is rejected with `InvalidParameterException`, by
	 * the local runtime as by Cognito.
	 *
	 * ⚠️ **Not a profile database.** Keep profile data in `KVStore` or
	 * `DistributedTable`, keyed on `user.userSub`.
	 */
	attributes?: readonly UserAttribute[];

	/**
	 * Groups to create. `requireRole()`'s `role` parameter narrows to this
	 * literal union (see {@link GroupOf}).
	 *
	 * @remarks `requireRole()` reads the user's **current** group membership on
	 * each guarded request (deduplicated within a request), so a group change
	 * applies on the user's next request without a re-login. The `groups` on the
	 * user returned by `requireAuth()` / `getCurrentUser()` is the snapshot taken
	 * at sign-in. Users of a directly federated OIDC provider have no pool
	 * record; their groups come from that provider's `groupsClaim`.
	 */
	groups?: readonly (string | { name: string; description?: string; precedence?: number })[];

	/**
	 * The Cognito authentication flow for email + password sign-in.
	 * `'USER_AUTH'` is required for passkeys and choice-based / passwordless
	 * sign-in, and itself requires a `featurePlan` above `'lite'`.
	 *
	 * @default 'USER_PASSWORD_AUTH'
	 */
	authFlow?: 'USER_PASSWORD_AUTH' | 'USER_AUTH';

	/**
	 * Default first-factor hint for {@link UserPoolOptions.authFlow} `'USER_AUTH'`. When
	 * omitted, the first `signIn` call returns
	 * `CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION` and the user picks a
	 * factor. When set, that factor is requested directly (e.g.
	 * `'EMAIL_OTP'` → Cognito sends a code and `signIn` returns
	 * `CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP`).
	 *
	 * Ignored for `'USER_PASSWORD_AUTH'` (the classic flow has no factor
	 * choice). The per-call override on `auth.signIn` takes precedence.
	 *
	 * @remarks Carried over from `AuthCognito`'s top-level `preferredChallenge`
	 * (D3 rename: it sits next to `authFlow`). As there, `'EMAIL_OTP'` /
	 * `'SMS_OTP'` also enable that factor in the pool's `USER_AUTH`
	 * `AllowedFirstAuthFactors`, alongside the factors `mfa.types` lists.
	 * Cognito sends the `'EMAIL_OTP'` code only through Amazon SES, so under
	 * `'USER_AUTH'` it needs a pool with an SES sender: on a pool this block
	 * creates, synth fails and points at `Auth.fromExisting`.
	 */
	preferredChallenge?: PreferredChallenge;

	/** Remember devices to skip MFA on a known device. ⚠️ Email + password sign-in only. */
	deviceTracking?: { challengeRequiredOnNewDevice?: boolean; deviceOnlyRememberedOnUserPrompt?: boolean };
}

/** Settings for {@link AuthOptions.session}. */
export interface SessionOptions {
	/** Session record and cookie lifetime, in seconds. @default 34_560_000 (400 days) */
	ttlSeconds?: number;
	/**
	 * Set `true` only when the frontend and the API are on different registrable
	 * domains. Switches the cookie to `SameSite=None; Secure; Partitioned`.
	 *
	 * @default false
	 */
	crossDomain?: boolean;
	/**
	 * How recently the user must have signed in for
	 * `requireAuth(context, { fresh: true })` to succeed, in seconds. Use it to
	 * demand a recent sign-in before destructive actions without keeping a
	 * second session.
	 *
	 * @default 900 (15 minutes)
	 */
	freshAgeSeconds?: number;
}

/** Settings for {@link AuthOptions.redirects}. */
export interface RedirectOptions {
	/** @default '/aws-blocks/auth/callback' — must start with `/aws-blocks/auth/`. */
	callbackPath?: string;
	/** @default '/aws-blocks/auth/signout' — must start with `/aws-blocks/auth/`. */
	signOutPath?: string;
	/** Where the browser lands after a successful federated sign-in. @default '/' */
	postSignInPath?: string;
	/**
	 * Where the browser lands after a federated sign-out: the sign-out route
	 * redirects here, and — for a provider with an `end_session_endpoint` — it is
	 * sent to the IdP as `post_logout_redirect_uri` (as `<app origin><path>`),
	 * so register that URI with the IdP. Must be a same-origin path starting
	 * with `/`.
	 *
	 * For a provider federated through Cognito (social, SAML,
	 * `federateVia: 'cognito'`), sign-out first goes to Cognito's `/logout`, which
	 * returns to `<app origin><signOutPath>` (the URL registered on the Cognito
	 * app client); that route then redirects here.
	 *
	 * @default '/'
	 */
	postSignOutPath?: string;
	/**
	 * Origins a native or CLI client's relay sign-in may redirect back to
	 * (`POST /aws-blocks/auth/authorize-params/<id>` with `relayTo`), each built
	 * with `relayOrigin()`. Loopback (`http://127.0.0.1`, `http://[::1]`, any
	 * port) and the API's own origin are always allowed.
	 *
	 * @example allowedRelayOrigins: [relayOrigin('myapp://auth')]
	 * @default []
	 */
	allowedRelayOrigins?: readonly RelayOrigin[];
}

/** Settings for {@link AuthOptions.hostedUi}. */
export interface HostedUiOptions {
	/**
	 * The Cognito domain prefix: the hosted UI is served at
	 * `https://<domainPrefix>.auth.<region>.amazoncognito.com`, and each upstream
	 * IdP must allow `https://<domainPrefix>.auth.<region>.amazoncognito.com/oauth2/idpresponse`
	 * (`/saml2/idpresponse` for SAML) as its redirect URI. 1–63 lowercase letters,
	 * digits and hyphens, not starting or ending with a hyphen, and not containing
	 * `aws`, `amazon` or `cognito`.
	 *
	 * ⚠️ **Create-only.** `UserPoolDomain.Domain` is replace-only and globally
	 * unique: changing this after the first deploy deletes the domain, signs out
	 * every hosted-UI session, and breaks the redirect URI registered in every
	 * upstream IdP console until you register the new one. Set it before the first
	 * deploy that adds a social, SAML or `federateVia: 'cognito'` provider, or not
	 * at all.
	 *
	 * @default derived from the block's `fullId` plus a short hash — deterministic and stable
	 */
	domainPrefix?: string;
}

/** The admin action groups that {@link AdminOptions.actions} can scope. */
export type AdminAction = 'groups' | 'lifecycle';

/**
 * Opt-in configuration for the admin surface. Presence of this object on
 * {@link AuthOptions.admin} enables `auth.admin` and the matching IAM grant.
 */
export interface AdminOptions {
	/**
	 * Scopes the IAM grant and the compile-time method gate. Omit to grant
	 * everything. `['groups']` grants only the group-membership actions;
	 * `['lifecycle']` grants only the user-lifecycle actions.
	 */
	actions?: readonly AdminAction[];
}

/**
 * Reference to an externally provisioned Cognito user pool. Returned by
 * `Auth.fromExisting()`; pass it as {@link AuthOptions.userPool}.
 */
export interface ExternalUserPoolRef {
	readonly __brand: 'ExternalUserPoolRef';
	readonly userPoolId: string;
	readonly clientId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Options-literal projections
// ─────────────────────────────────────────────────────────────────────────────
//
// These project `O` (the options literal captured by `Auth<const O>`) into the
// narrow unions individual methods accept. Each falls back to a wide type when
// `O` is the wide `AuthOptions` (or was widened by a `: AuthOptions` variable),
// so `Auth` with no type argument stays a supertype of every configured
// instance. That covariance is load-bearing — `types-test.ts` pins it.

/**
 * The union of configured federated provider ids — the keys of
 * `socialProviders`, `oidcProviders` and `samlProviders`.
 *
 * `never` when `O` configures no provider; `string` for the wide
 * `AuthOptions` (any id may be configured).
 */
export type ProviderIdOf<O extends AuthOptions> =
	| (O extends { socialProviders?: infer S }
			? [S] extends [undefined]
				? never
				: keyof NonNullable<S> & string
			: never)
	| (O extends { oidcProviders?: infer S }
			? [S] extends [undefined]
				? never
				: keyof NonNullable<S> & string
			: never)
	| (O extends { samlProviders?: infer S }
			? [S] extends [undefined]
				? never
				: keyof NonNullable<S> & string
			: never);

/**
 * The declared group names: a literal union when `users.groups` is a literal
 * tuple (inline options, captured by `const O`), otherwise `string`.
 */
export type GroupOf<O extends AuthOptions> = O extends {
	users: { groups: infer L extends readonly [unknown, ...unknown[]] };
}
	? L[number] extends infer G
		? G extends string
			? G
			: G extends { name: infer N extends string }
				? N
				: string
		: never
	: string;

/** Standard Cognito user-attribute names. */
export type StandardUserAttributeKey =
	| 'address'
	| 'birthdate'
	| 'email'
	| 'email_verified'
	| 'family_name'
	| 'gender'
	| 'given_name'
	| 'locale'
	| 'middle_name'
	| 'name'
	| 'nickname'
	| 'phone_number'
	| 'phone_number_verified'
	| 'picture'
	| 'preferred_username'
	| 'profile'
	| 'sub'
	| 'updated_at'
	| 'website'
	| 'zoneinfo';

/** The custom-attribute names declared in `users.attributes`; `never` when none are. */
export type CustomAttrNames<O extends AuthOptions> = O extends { users: { attributes: readonly (infer U)[] } }
	? U extends { name: infer N extends string }
		? N
		: never
	: never;

/**
 * Attribute names accepted on **write** APIs (e.g. `signUp` attributes). Accepts
 * a declared custom attribute with or without its `custom:` prefix. `string`
 * when `users.attributes` is not a literal tuple.
 */
export type AttrOf<O extends AuthOptions> = O extends { users: { attributes: readonly [unknown, ...unknown[]] } }
	? StandardUserAttributeKey | CustomAttrNames<O> | `custom:${CustomAttrNames<O>}`
	: string;

/**
 * Attribute names as returned from **read** APIs. Cognito stores custom
 * attributes with the `custom:` prefix, so reads only see the prefixed form.
 */
export type ReadAttrOf<O extends AuthOptions> = O extends { users: { attributes: readonly [unknown, ...unknown[]] } }
	? StandardUserAttributeKey | `custom:${CustomAttrNames<O>}`
	: string;

// ─────────────────────────────────────────────────────────────────────────────
// Mode gates
// ─────────────────────────────────────────────────────────────────────────────
//
// A gated method takes a trailing rest parameter typed by a gate. When the mode
// is enabled the gate resolves to the method's ordinary trailing parameters, so
// the method reads and calls normally. When it is disabled the gate resolves to
// a single `never` parameter, so every call is a compile error — and the rest
// parameter is *named* after the error, so the compiler's diagnostic carries the
// message: "Arguments for the rest parameter
// 'ERROR_emailPassword_is_disabled_on_this_Auth_instance' were not provided."
//
// Why a parameter and not a conditional property type: a conditional over the
// class's own `O` in a property position makes the class invariant in `O`
// (that regressed 14 call sites when `AuthCognito`'s admin surface tried it).
// A rest parameter keeps `Auth<O>` assignable to `Auth`.
//
// Why the gate absorbs the trailing optional parameters (the `T` argument): if
// an optional parameter preceded the gate, a call that omits it would be
// reported as "An argument for 'options' was not provided" — pointing the user
// at the wrong fix.

/**
 * Whether email + password sign-in is enabled for options `O`.
 *
 * - `false` — the options literal says `emailPassword: false`.
 * - `true` — `emailPassword` is omitted, `true`, or an options object.
 * - `boolean` — unknown at compile time: the wide `AuthOptions`, or a
 *   `boolean`-typed value. Gated methods stay callable (a runtime check backs
 *   them) and every configured instance stays assignable to the wide type.
 */
export type EmailPasswordEnabled<O extends AuthOptions> = O extends { emailPassword: false }
	? false
	: 'emailPassword' extends keyof O
		? false extends O['emailPassword']
			? boolean
			: true
		: true;

/**
 * Compile-time gate for the email + password methods, used as their trailing
 * rest parameter. `T` is the method's ordinary trailing (optional) parameters.
 *
 * Resolves to `T` when email + password is enabled, and to
 * `[ERROR_emailPassword_is_disabled_on_this_Auth_instance: never]` when it is
 * disabled (`emailPassword: false`). When unknown at compile time it accepts
 * both, so calls compile and a runtime `EmailPasswordNotEnabledException`
 * backs the check.
 */
export type PasswordGate<O extends AuthOptions, T extends unknown[] = []> = [EmailPasswordEnabled<O>] extends [true]
	? T
	: [EmailPasswordEnabled<O>] extends [false]
		? [ERROR_emailPassword_is_disabled_on_this_Auth_instance: never]
		: T | [ERROR_emailPassword_is_disabled_on_this_Auth_instance: never];

/**
 * Whether options `O` configure at least one federated provider.
 *
 * `false` for the wide `AuthOptions`: an `Auth` whose configuration the
 * compiler cannot see is treated like the zero-config default, which has no
 * federated provider. That keeps the wide type a supertype of every configured
 * instance, and makes `new Auth(scope, 'auth').getSignInUrl(…)` a compile
 * error. Use the instance's own type (`typeof auth`) to call federation
 * methods through a helper.
 */
export type HasFederatedProvider<O extends AuthOptions> = [ProviderIdOf<O>] extends [never]
	? false
	: AuthOptions extends O
		? false
		: true;

/**
 * Compile-time gate for the federated sign-in methods, used as their trailing
 * rest parameter. `T` is the method's ordinary trailing (optional) parameters.
 *
 * Resolves to `T` when `O` configures at least one federated provider, and to
 * `[ERROR_no_federated_provider_is_configured: never]` otherwise.
 */
export type FederationGate<O extends AuthOptions, T extends unknown[] = []> = [HasFederatedProvider<O>] extends [true]
	? T
	: [ERROR_no_federated_provider_is_configured: never];

/** The {@link MfaMode} that options `O` select (`'off'` when `mfa` is omitted). A union when not a literal. */
export type MfaModeOf<O extends AuthOptions> = O extends { mfa?: infer M } ? MfaModeOfOption<M> : 'off';

/** The mode an `mfa` option value selects: `'optional'` is `{ mode: 'optional' }`; `{}` is `'off'`. */
export type MfaModeOfOption<M> = M extends MfaMode
	? M
	: M extends { mode?: infer X }
		? X extends MfaMode
			? X
			: 'off'
		: 'off';

/**
 * Whether options `O` turn MFA on (`mfa` is `'optional'` or `'required'`, and
 * email + password is enabled — MFA applies to email + password sign-in only).
 *
 * - `false` — `mfa` omitted, `'off'`, `{}` / `{ mode: 'off' }`, or
 *   `emailPassword: false`.
 * - `true` — MFA is on.
 * - `boolean` — unknown at compile time: a `MfaMode`-typed value, or the wide
 *   `AuthOptions` (including `new Auth(scope, id)` with no options, which the
 *   compiler cannot tell apart from it). The methods stay callable and a
 *   runtime `InvalidParameterException` backs them — the same trade-off as
 *   {@link EmailPasswordEnabled}. Resolving the wide type to *both* gate
 *   tuples, rather than closing it, is what keeps a generic `Auth<O>`
 *   assignable to the wide `Auth`: a closed `[never]` gate cannot be related
 *   to the deferred `MfaGate<O>` of a generic instance.
 */
export type MfaEnabled<O extends AuthOptions> = AuthOptions extends O
	? boolean
	: [EmailPasswordEnabled<O>] extends [false]
		? false
		: [EmailPasswordEnabled<O>] extends [true]
			? MfaModeEnabled<O>
			: MfaModeEnabled<O> extends false
				? false
				: boolean;

/** {@link MfaEnabled} without the email + password check. */
export type MfaModeEnabled<O extends AuthOptions> = [MfaModeOf<O>] extends ['off']
	? false
	: 'off' extends MfaModeOf<O>
		? boolean
		: true;

/**
 * Compile-time gate for the MFA management methods (`setUpTotp`,
 * `verifyTotpSetup`, `updateMfaPreference`, `getMfaPreference`), used as their
 * trailing rest parameter. `T` is the method's ordinary trailing (optional)
 * parameters.
 *
 * Resolves to `T` when MFA is on (see {@link MfaEnabled}), and to
 * `[ERROR_mfa_is_off_on_this_Auth_instance: never]` when it is off. When unknown
 * at compile time it accepts both, and a runtime `InvalidParameterException`
 * backs the check.
 */
export type MfaGate<O extends AuthOptions, T extends unknown[] = []> = [MfaEnabled<O>] extends [true]
	? T
	: [MfaEnabled<O>] extends [false]
		? [ERROR_mfa_is_off_on_this_Auth_instance: never]
		: T | [ERROR_mfa_is_off_on_this_Auth_instance: never];

/**
 * Whether options `O` enable passkeys (`passkeys` is an options object, and
 * email + password is enabled). `boolean` when unknown at compile time,
 * including the wide `AuthOptions` — see {@link MfaEnabled} for why.
 */
export type PasskeysEnabled<O extends AuthOptions> = AuthOptions extends O
	? boolean
	: [EmailPasswordEnabled<O>] extends [false]
		? false
		: [Extract<PasskeysOptionOf<O>, object>] extends [never]
			? false
			: [Exclude<PasskeysOptionOf<O>, object>] extends [never]
				? [EmailPasswordEnabled<O>] extends [true]
					? true
					: boolean
				: boolean;

/** The `passkeys` option value of `O` (`undefined` when omitted). */
export type PasskeysOptionOf<O extends AuthOptions> = O extends { passkeys?: infer P } ? P : undefined;

/**
 * Compile-time gate for the passkey management methods
 * (`startPasskeyRegistration`, `completePasskeyRegistration`, `listPasskeys`,
 * `deletePasskey`), used as their trailing rest parameter.
 *
 * Resolves to `T` when passkeys are enabled (see {@link PasskeysEnabled}), and
 * to `[ERROR_passkeys_are_not_enabled_on_this_Auth_instance: never]` otherwise.
 * When unknown at compile time it accepts both, and a runtime
 * `WebAuthnNotEnabledException` backs the check.
 */
export type PasskeyGate<O extends AuthOptions, T extends unknown[] = []> = [PasskeysEnabled<O>] extends [true]
	? T
	: [PasskeysEnabled<O>] extends [false]
		? [ERROR_passkeys_are_not_enabled_on_this_Auth_instance: never]
		: T | [ERROR_passkeys_are_not_enabled_on_this_Auth_instance: never];

// ─────────────────────────────────────────────────────────────────────────────
// Users and sessions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The signed-in user, as returned by `requireAuth`, `requireRole`,
 * `getCurrentUser` and a completed `signIn`.
 *
 * Identity by sign-in method:
 *
 * | Signed in with | `userId` | `userSub` |
 * |---|---|---|
 * | email + password, social, SAML, or OIDC with `federateVia: 'cognito'` | the username — on a pool whose `users.signInWith` omits `'username'`, the one Cognito generates, equal to `userSub` | the Cognito `sub` (a UUID) |
 * | OIDC with `federateVia: 'direct'` (no pool record) | `` `${issuer}:${sub}` `` | `` `${issuer}:${sub}` `` |
 *
 * Key your own data on `userSub`: it is stable for the user's lifetime.
 *
 * It has no `displayName`: that is the sign-in UI's value, set on
 * `AuthState.user` only. To show the user's email server-side, read
 * `attributes.email`.
 */
export interface AuthenticatedUser<O extends AuthOptions = AuthOptions> extends Omit<AuthUser, 'displayName'> {
	/** Stable unique identifier — key your data on this. See the table above. */
	userSub: string;
	/** Group memberships, narrowed to the declared `users.groups`. See {@link UserPoolOptions.groups}. */
	groups: GroupOf<O>[];
	/**
	 * Standard OIDC attributes plus `custom:*` attributes.
	 *
	 * For a user-pool session these are the ID token's string claims, so
	 * `email_verified` / `phone_number_verified` (boolean claims in a Cognito
	 * ID token) are not included — on AWS and locally alike. Read them with
	 * `getUserAttributes`, which returns them as `'true'` / `'false'`.
	 * Likewise `updated_at` (a number in the ID token) and `address` (an
	 * object, `{ formatted }`) are not included; `getUserAttributes` returns
	 * both as strings.
	 */
	attributes: Partial<Record<ReadAttrOf<O>, string>>;
	/** `'password'` for email + password sign-in, otherwise the federated provider id. */
	signInProvider: 'password' | ProviderIdOf<O>;
	/**
	 * The provider's verified identity claims, for a user who signed in
	 * through an `oidcProviders` entry with `federateVia: 'direct'` (the
	 * default) — what `AuthOIDC`'s user carried as `claims`. `sub` and `iss`
	 * are the provider's own, unprefixed (`userId` is `` `${iss}:${sub}` ``):
	 * the ID token's claims, or, from a provider that issued no ID token (an
	 * OAuth 2.0 provider), `iss`, `sub` and the profile claims it returned.
	 *
	 * Absent for every user-pool user (email + password, social, SAML,
	 * `federateVia: 'cognito'`): their Cognito ID-token claims are in
	 * `getAuthSession(context)`'s `tokens.idToken.payload`.
	 *
	 * Server-side only: `getAuthState()` and the sign-in routes never send it
	 * to the browser.
	 *
	 * @example
	 * ```typescript
	 * const user = await auth.requireAuth(context);
	 * const providerSub = user.claims?.sub ?? user.userId; // the IdP's raw `sub` when federated directly
	 * ```
	 */
	claims?: Readonly<Record<string, unknown>>;
}

/**
 * A decoded JWT. `payload` is the token's claims after signature verification;
 * `expiresAt` is the `exp` claim in milliseconds since the epoch.
 */
export interface JWT {
	toString(): string;
	payload: Record<string, unknown>;
	expiresAt: number;
}

/**
 * Return shape of `getAuthSession`. `tokens` is `undefined` when the caller is
 * not signed in.
 */
export interface AuthSession {
	tokens?: {
		idToken: JWT;
		accessToken: JWT;
	};
	userSub?: string;
}

/** Options for `requireAuth` / `requireRole`. */
export interface RequireAuthOptions {
	/**
	 * Require a recent sign-in (within `session.freshAgeSeconds`). Throws 401
	 * `ReauthenticationRequiredException` when the session is older.
	 */
	fresh?: boolean;
}

/** Options for `getAuthSession`. */
export interface GetAuthSessionOptions {
	/** Refresh the tokens even if the access token has not expired yet. */
	forceRefresh?: boolean;
}

/** Options for `signOut`. */
export interface SignOutOptions {
	/** Also revoke the user's sessions on every other device. */
	global?: boolean;
}

/** Options for `getSignInUrl`. */
export interface SignInUrlOptions {
	/** Path to land on after sign-in. Must be same-origin. */
	redirectPath?: string;
	/** Opaque application state, returned unchanged after the redirect. */
	state?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Email + password results
// ─────────────────────────────────────────────────────────────────────────────

/** Where a verification code was sent. */
export interface CodeDeliveryDetails {
	destination: string;
	deliveryMedium: 'EMAIL' | 'SMS' | 'PHONE_NUMBER';
	attributeName: string;
}

/** Options for `signUp`. */
export interface SignUpOptions<O extends AuthOptions = AuthOptions> {
	/** Standard or declared custom attributes. Custom attributes are auto-prefixed `custom:`. */
	attributes?: Partial<Record<AttrOf<O>, string>>;
	/** Passed through to Cognito's `ClientMetadata`, for any Lambda trigger on the pool. */
	clientMetadata?: Record<string, string>;
}

/** Result of `signUp`. Every sign-up continues with an emailed confirmation code. */
export interface SignUpResult {
	isSignUpComplete: boolean;
	userId?: string;
	nextStep?: {
		name: 'CONFIRM_SIGN_UP';
		codeDeliveryDetails: CodeDeliveryDetails;
	};
}

/**
 * Result of `confirmSignUp`. `COMPLETE_AUTO_SIGN_IN` means the user can be
 * signed in without re-entering their password (see
 * {@link EmailPasswordOptions.autoSignIn}).
 */
export interface ConfirmSignUpResult {
	isSignUpComplete: boolean;
	nextStep: {
		signUpStep: 'DONE' | 'COMPLETE_AUTO_SIGN_IN';
	};
}

/**
 * First-factor choices for the `USER_AUTH` flow.
 *
 * First-factor hint sent to Cognito's `USER_AUTH` `InitiateAuth` call. When
 * set, Cognito skips the `SELECT_CHALLENGE` step and issues the chosen
 * challenge directly — e.g. `EMAIL_OTP` delivers a code to the user's
 * verified email without asking for a password, and `WEB_AUTHN` issues a
 * passkey assertion challenge that the browser answers via
 * `navigator.credentials.get(...)`.
 *
 * `PASSWORD_SRP` is intentionally omitted: SRP is tracked as a separate PR.
 */
export type PreferredChallenge = 'PASSWORD' | 'EMAIL_OTP' | 'SMS_OTP' | 'WEB_AUTHN';

/** Options for `confirmSignIn`. */
export interface ConfirmSignInOptions<O extends AuthOptions = AuthOptions> {
	/** Passed through to Cognito's `ClientMetadata`, for any Lambda trigger on the pool. */
	clientMetadata?: Record<string, string>;
	/** Device name recorded when the answer completes an authenticator-app (TOTP) setup. */
	friendlyDeviceName?: string;
	/** Attributes to set when answering a new-password-required challenge. */
	userAttributes?: Partial<Record<AttrOf<O>, string>>;
}

/**
 * A registered passkey, as listed by the passkey management actions and
 * {@link AuthShape.listPasskeys}. Mirrors the fields Cognito's
 * `ListWebAuthnCredentials` response carries, normalised to camelCase.
 */
export interface PasskeyDescription {
	/** Server-assigned credential id, base64url-encoded. */
	credentialId: string;
	/** User-supplied friendly name (for example "iPhone"). May be empty. */
	friendlyName?: string;
	/** When the passkey was registered, as an ISO-8601 string. */
	createdAt?: string;
	/** Authenticator transports the credential supports. */
	transports?: ('usb' | 'nfc' | 'ble' | 'internal' | 'hybrid' | string)[];
	/**
	 * Authenticator attachment. Cognito reports the general category — e.g.
	 * `'platform'` for an on-device biometric, `'cross-platform'` for a
	 * roaming security key.
	 */
	authenticatorAttachment?: string;
}

/**
 * Result of {@link AuthShape.startPasskeyRegistration}. The browser must
 * pass `credentialCreationOptions` (a JSON-stringified
 * `PublicKeyCredentialCreationOptionsJSON`) to
 * `navigator.credentials.create(...)`, then forward the resulting
 * `PublicKeyCredential` back through {@link AuthShape.completePasskeyRegistration}.
 *
 * Cognito's `StartWebAuthnRegistration` returns the options as an object
 * with already-base64url-encoded fields (challenge, user.id, …). The BB
 * passes them through verbatim — the browser's `parseCreationOptionsFromJSON`
 * helper turns the JSON back into the structured form
 * `navigator.credentials.create` expects.
 */
export interface StartPasskeyRegistrationResult {
	/** JSON-stringified `PublicKeyCredentialCreationOptionsJSON` from Cognito. */
	credentialCreationOptions: string;
}

/**
 * Result of {@link AuthShape.completePasskeyRegistration}.
 */
export interface CompletePasskeyRegistrationResult {
	/** Server-assigned credential identifier, base64url-encoded. */
	credentialId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// User attributes, MFA, devices
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-attribute result of {@link AuthShape.updateUserAttributes}. Changing a
 * contact attribute (`email`, `phone_number`) does not take effect until the
 * user confirms it with the code sent to the new value
 * ({@link AuthShape.confirmUserAttribute}).
 */
export type UpdateAttributeOutcome =
	| { isUpdated: true }
	| {
			isUpdated: false;
			nextStep: { name: 'CONFIRM_ATTRIBUTE_WITH_CODE'; codeDeliveryDetails: CodeDeliveryDetails };
	  };

/** A second factor Cognito supports. */
export type MfaFactor = 'SMS' | 'TOTP' | 'EMAIL';

/**
 * Narrow MFA factors to the configured subset. Falls back to the full
 * `'SMS' | 'TOTP' | 'EMAIL'` union when `mfa.types` isn't a literal tuple.
 */
export type MfaTypeOf<O extends AuthOptions> = O extends { mfa: { types: readonly [unknown, ...unknown[]] } }
	? O extends { mfa: { types: readonly (infer M)[] } }
		? M extends MfaFactor
			? M
			: MfaFactor
		: MfaFactor
	: MfaFactor;

/**
 * Per-factor setting in {@link MfaPreferenceInput}. Compatible with Amplify-JS v6's
 * `updateMFAPreference` input vocabulary for interoperability.
 *
 * - `'ENABLED'` — factor is available for sign-in challenges but not preferred.
 * - `'DISABLED'` — factor is removed; the user cannot be challenged for it.
 * - `'PREFERRED'` — factor is enabled AND the default challenge for
 *   sign-in. Setting PREFERRED on one factor auto-demotes any previously
 *   preferred factor to `'NOT_PREFERRED'` (Cognito's documented behavior).
 * - `'NOT_PREFERRED'` — explicit alias of `'ENABLED'`. Mostly useful when
 *   you want to read as "present on the preference list but not default."
 */
export type MfaSetting = 'ENABLED' | 'DISABLED' | 'PREFERRED' | 'NOT_PREFERRED';

/**
 * Input for {@link AuthShape.updateMfaPreference}. Per-factor delta
 * matching Amplify-JS v6.
 *
 * Factors you omit are left unchanged. At most **one** factor may be
 * set to `'PREFERRED'` per call — setting two raises
 * `InvalidParameterException` at the call site (matches Cognito).
 *
 * When `mfa.types` is a literal tuple (inline options), factors the pool
 * doesn't advertise are compile errors: a pool declared
 * `mfa: { mode: 'optional', types: ['TOTP', 'EMAIL'] }` rejects
 * `updateMfaPreference(ctx, { sms: 'ENABLED' })` at compile time.
 */
export type MfaPreferenceInput<O extends AuthOptions = AuthOptions> = {
	sms?: 'SMS' extends MfaTypeOf<O> ? MfaSetting : never;
} & { totp?: 'TOTP' extends MfaTypeOf<O> ? MfaSetting : never } & {
	email?: 'EMAIL' extends MfaTypeOf<O> ? MfaSetting : never;
};

/**
 * Return shape of {@link AuthShape.getMfaPreference}.
 *
 * - `enabled` — any number of factors; order is stable across calls.
 * - `preferred` — exactly zero-or-one. When absent, the user has no
 *   default factor and sign-in with MFA asks the user to pick
 *   (`CONTINUE_SIGN_IN_WITH_MFA_SELECTION`).
 *
 * `'NOMFA'` on `preferred` is the sentinel returned when the user has
 * explicitly disabled MFA; Cognito itself doesn't surface this, but
 * Blocks uses it to distinguish "user chose no MFA" from "user has no
 * preference yet."
 */
export interface MfaPreference<O extends AuthOptions = AuthOptions> {
	enabled: MfaTypeOf<O>[];
	preferred?: MfaTypeOf<O> | 'NOMFA';
}

/** A device remembered for the signed-in user (see {@link AuthShape.scanDevices}). */
export interface DeviceRecord {
	deviceKey: string;
	deviceGroupKey?: string;
	attributes: Record<string, string>;
	createDate?: string;
	lastModifiedDate?: string;
	lastAuthenticatedDate?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Local development (mock runtime only)
// ─────────────────────────────────────────────────────────────────────────────

/** Which flow a locally generated verification code belongs to. */
export type CodeDeliveryPurpose = 'signUp' | 'resetPassword' | 'mfa' | 'attribute';

/**
 * Callback invoked whenever the mock generates a verification code
 * (sign-up, password reset, MFA, attribute verification).
 *
 * In the AWS runtime Cognito handles delivery via email/SMS; this hook is
 * mock-only. Useful for e2e tests that need to retrieve the code out-of-band.
 *
 * `username` is what the user signs in with: on a pool whose
 * `users.signInWith` omits `'username'`, their email / phone (not the
 * generated username).
 */
export type CodeDeliveryFn = (username: string, code: string, purpose: CodeDeliveryPurpose) => Promise<void>;

/**
 * Mock-only options. Extends the cross-runtime {@link AuthOptions} with fields
 * that only make sense for the local (mock) runtime — `npm run dev` and tests.
 *
 * The default entry's `Auth` accepts these; the AWS runtime ignores them
 * (Cognito delivers codes itself). Locally, every code is also written to
 * `.bb-data/<fullId>/last-code.json`.
 */
export interface AuthMockOptions extends AuthOptions {
	/**
	 * Mock-only hook. Called whenever the mock generates a verification code
	 * (sign-up, password reset, MFA, attribute verification).
	 *
	 * In AWS Cognito handles delivery via email/SMS natively — this hook is
	 * dev-only. Useful for e2e tests that need to retrieve the code
	 * out-of-band (e.g. by capturing it in a local variable).
	 */
	codeDelivery?: CodeDeliveryFn;
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin surface (opt-in `auth.admin` handle)
// ─────────────────────────────────────────────────────────────────────────────
//
// The server-side admin operations (group membership + user lifecycle) live on
// an opt-in handle, `auth.admin`, rather than a separate class/package. The
// handle is gated by the `admin` options object so:
//
//   - a pool that never opts in gets NO `Admin*` IAM grant (least privilege),
//     and `auth.admin` is a compile error whose message names the fix;
//   - `admin.actions` scopes the IAM grant (CDK) to just the group or just the
//     lifecycle actions.
//
// Group names on the admin methods narrow via `GroupOf<O>`, mirroring the
// literal-tuple projection style of `GroupOf` / `MfaTypeOf` above. Carried over
// from `AuthCognito`.

/**
 * Whether options `O` grant admin action group `A`. An omitted
 * `admin.actions` (or a widened `readonly AdminAction[]`) grants everything.
 */
export type AdminGrants<O extends AuthOptions, A extends AdminAction> = O extends {
	admin: { actions: infer L extends readonly string[] };
}
	? A extends L[number]
		? true
		: false
	: true;

/**
 * Compile-time gate applied as a trailing rest parameter on each admin method.
 * `T` is the method's ordinary trailing (optional) parameters. When `O` grants
 * action group `A`, this resolves to `T` (the method is callable normally).
 * When it doesn't, the method requires an extra argument of type `never`, so
 * the call is a type error whose parameter name explains why.
 *
 * This lives in a **parameter** position on individual methods (not as a
 * conditional over the surface *shape*), which is why it does not make
 * `Auth<O>` invariant — verified against the same call sites the earlier
 * shape-narrowing attempt regressed. It absorbs the trailing optional
 * parameters for the same reason as {@link PasswordGate}: the diagnostic then
 * names the gate, not an optional argument. For the wide `AuthOptions` it
 * accepts both resolutions, so an instance whose `actions` withhold a group
 * stays assignable to the wide `Auth`.
 */
export type AdminActionGate<
	O extends AuthOptions,
	A extends AdminAction,
	T extends unknown[] = [],
> = AuthOptions extends O
	? T | [ERROR_admin_action_not_granted: never]
	: [AdminGrants<O, A>] extends [true]
		? T
		: [ERROR_admin_action_not_granted: never];

/**
 * A user as seen by the admin surface (group + lifecycle reads). Mirrors the
 * client-side {@link AuthenticatedUser} narrowing: `groups` narrows to the
 * configured group union and `attributes` to the declared attribute keys when
 * `O` is narrowed (inline literal); both fall back to the wide types otherwise.
 */
export interface AdminUser<O extends AuthOptions = AuthOptions> {
	username: string;
	userSub: string;
	enabled: boolean;
	attributes: Partial<Record<ReadAttrOf<O>, string>>;
	/** Group memberships, narrowed to the declared `users.groups`. Absent when unknown. */
	groups?: GroupOf<O>[];
}

/** Initial state for {@link LifecycleAdmin.createUser}. */
export interface AdminCreateInit<O extends AuthOptions = AuthOptions> {
	/** Temporary password. When omitted, the runtime generates one. */
	temporaryPassword?: string;
	/**
	 * Attributes to seed on the new user. Narrows to the pool's declared
	 * attribute keys (standard + `custom:*`) when `O` is narrowed, catching
	 * typos the same way `signUp`'s attributes do.
	 */
	attributes?: Partial<Record<AttrOf<O>, string>>;
	/** Suppress the Cognito invitation email/SMS (AWS runtime only). */
	suppressInvite?: boolean;
}

/** Options for {@link LifecycleAdmin.setUserPassword}. */
export interface SetPasswordOptions {
	/**
	 * When `true`, the password is permanent and the user signs in with it
	 * directly. When `false`/omitted, the password is temporary and the user is
	 * forced to change it on next sign-in (Cognito `FORCE_CHANGE_PASSWORD`).
	 */
	permanent?: boolean;
}

/**
 * Server-side filter for {@link LifecycleAdmin.scan}. Maps to Cognito's
 * `ListUsers` `Filter` expression, so the pool does the filtering rather than
 * the caller pulling every user and filtering in memory.
 *
 * Cognito supports a single filter clause on one attribute; `match: 'startsWith'`
 * maps to the `^=` prefix operator and `match: 'equals'` to `=`.
 */
export interface AdminUserFilter {
	/** Attribute to filter on — e.g. `'email'`, `'username'`, `'status'`. */
	attribute: string;
	/** Comparison operator. Cognito supports prefix (`^=`) and exact (`=`). */
	match: 'startsWith' | 'equals';
	/** Value to compare against. */
	value: string;
}

/**
 * Group-membership admin operations. Group names narrow via `GroupOf<O>`, so
 * `addUserToGroup(user, 'typo')` is a compile error on a narrowed pool. Each
 * method is gated on the `'groups'` action (see {@link AdminActionGate}).
 *
 * `auth.admin` is inside your trust boundary: unlike the public flows, it
 * reports `UserNotFoundException` (404) for an unknown user and
 * `ResourceNotFoundException` (404) for an unknown group.
 */
export interface GroupAdmin<O extends AuthOptions = AuthOptions> {
	/** Add `username` to `group`. Idempotent. */
	addUserToGroup(
		username: string,
		group: GroupOf<O>,
		...ERROR_admin_action_not_granted: AdminActionGate<O, 'groups'>
	): Promise<void>;
	/** Remove `username` from `group`. Idempotent. */
	removeUserFromGroup(
		username: string,
		group: GroupOf<O>,
		...ERROR_admin_action_not_granted: AdminActionGate<O, 'groups'>
	): Promise<void>;
	/** The groups `username` belongs to, narrowed to the declared `users.groups`. */
	listGroupsForUser(
		username: string,
		...ERROR_admin_action_not_granted: AdminActionGate<O, 'groups'>
	): Promise<GroupOf<O>[]>;
	/** Every member of `group`. Paginates internally. */
	listUsersInGroup(
		group: GroupOf<O>,
		...ERROR_admin_action_not_granted: AdminActionGate<O, 'groups'>
	): Promise<AdminUser<O>[]>;
}

/**
 * User-lifecycle admin operations — create/delete/enable/disable, password
 * management, enumeration, and session revocation. Each method is gated on the
 * `'lifecycle'` action (see {@link AdminActionGate}).
 */
export interface LifecycleAdmin<O extends AuthOptions = AuthOptions> {
	/**
	 * Create a confirmed user with a temporary password. The user must choose a
	 * new password on first sign-in (`CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED`).
	 *
	 * @throws {ApiError} 409 `UsernameExistsException` when the username is taken.
	 * @throws {ApiError} 400 `AliasExistsException` when `attributes` marks an email / phone verified that is already
	 *   another user's verified sign-in alias (`signInWith` with `'username'`).
	 */
	createUser(
		username: string,
		...ERROR_admin_action_not_granted: AdminActionGate<O, 'lifecycle', [init?: AdminCreateInit<O>]>
	): Promise<AdminUser<O>>;
	/** Delete `username` from the pool. Their existing sessions end at the next refresh. */
	deleteUser(username: string, ...ERROR_admin_action_not_granted: AdminActionGate<O, 'lifecycle'>): Promise<void>;
	/** Disable `username`: sign-in is refused and existing sessions end at the next refresh. */
	disableUser(username: string, ...ERROR_admin_action_not_granted: AdminActionGate<O, 'lifecycle'>): Promise<void>;
	/** Re-enable a disabled user. */
	enableUser(username: string, ...ERROR_admin_action_not_granted: AdminActionGate<O, 'lifecycle'>): Promise<void>;
	/** Force a password reset: the user must reset their password before they can sign in again. */
	resetUserPassword(
		username: string,
		...ERROR_admin_action_not_granted: AdminActionGate<O, 'lifecycle'>
	): Promise<void>;
	/** Set `username`'s password. Temporary unless `{ permanent: true }`. */
	setUserPassword(
		username: string,
		password: string,
		...ERROR_admin_action_not_granted: AdminActionGate<O, 'lifecycle', [options?: SetPasswordOptions]>
	): Promise<void>;
	/** Look up a user. Returns `null` when the user does not exist (never throws `UserNotFoundException`). */
	getUser(
		username: string,
		...ERROR_admin_action_not_granted: AdminActionGate<O, 'lifecycle'>
	): Promise<AdminUser<O> | null>;
	/**
	 * Every user in the pool, optionally filtered server-side. Unbounded, so it
	 * is an `AsyncIterable` that pages through `ListUsers` lazily.
	 *
	 * @example
	 * ```ts
	 * for await (const u of auth.admin.scan({ attribute: 'email', match: 'startsWith', value: 'a' })) {
	 *   console.log(u.username);
	 * }
	 * ```
	 */
	scan(
		...ERROR_admin_action_not_granted: AdminActionGate<O, 'lifecycle', [filter?: AdminUserFilter]>
	): AsyncIterable<AdminUser<O>>;
	/**
	 * Sign `username` out everywhere: revokes their refresh tokens at the pool
	 * and deletes every session this block holds for them, so their next request
	 * is unauthenticated.
	 */
	revokeUserSessions(
		username: string,
		...ERROR_admin_action_not_granted: AdminActionGate<O, 'lifecycle'>
	): Promise<void>;
}

/**
 * The typed `auth.admin` surface for a given configuration — the full set of
 * group + lifecycle operations, each gated on its action group at compile time
 * via {@link AdminActionGate}. Group names narrow via `GroupOf<O>` and returned
 * user shapes narrow via {@link AdminUser}.
 *
 * The action gate lives in method **parameter** positions rather than as a
 * conditional over this surface's *shape*, so `Auth<O>` stays covariant
 * in `O` (an earlier shape-narrowing attempt made it invariant and regressed 14
 * call sites). `actions` therefore gates the methods AND scopes the CDK IAM
 * grant from the same source.
 */
export type AdminSurface<O extends AuthOptions = AuthOptions> = GroupAdmin<O> & LifecycleAdmin<O>;

/**
 * Returned by `auth.admin` when the configuration did NOT opt in. Touching any
 * member is a compile error whose key text names the fix — friendlier than a
 * bare `never`.
 */
export type AdminDisabled = {
	readonly __adminNotEnabled: 'construct Auth with { admin: {} }';
};

/**
 * The `auth.admin` getter's return type — the gate.
 *
 * - The check is `{ admin: object }`, NOT `{ admin: any }`: a primitive like
 *   `admin: true` fails the gate, so the opt-in MUST be an object (`admin: {}`).
 * - The gate condition tests a **fixed shape** and the positive branch is a
 *   plain generic interface (`AdminSurface<O>`), so `Auth<O>` stays
 *   covariant in `O`.
 * - For the wide `AuthOptions` (a helper typed `(auth: Auth)`) it is the union
 *   of both branches: no member is reachable without narrowing — like the
 *   zero-config default — and every configured instance, admin-enabled or not,
 *   stays assignable to the wide type. (`AuthCognito`'s gate made an
 *   admin-enabled instance unassignable to the wide type.)
 */
export type AdminGetterOf<O extends AuthOptions> = AuthOptions extends O
	? AdminSurface<O> | AdminDisabled
	: O extends { admin: object }
		? AdminSurface<O>
		: AdminDisabled;

/** Options for `signIn`. */
export interface SignInOptions {
	/** Passed through to Cognito's `ClientMetadata`, for any Lambda trigger on the pool. */
	clientMetadata?: Record<string, string>;
	/**
	 * First factor to request under `users.authFlow: 'USER_AUTH'`. Ignored otherwise.
	 *
	 * Per-call override of the pool's {@link UserPoolOptions.preferredChallenge}.
	 *
	 * Ignored by `USER_PASSWORD_AUTH` (classic flow). For `USER_AUTH`:
	 *   - When set, Cognito skips the `SELECT_CHALLENGE` step and issues the
	 *     chosen factor directly.
	 *   - When omitted here AND on the pool options, Cognito returns
	 *     `CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION`.
	 */
	preferredChallenge?: PreferredChallenge;
}

/**
 * Result of `signIn`. `status` is a string discriminator on purpose: the native
 * client generators (Swift, Kotlin, Dart) build named variants only from a
 * string discriminator, never from a boolean.
 */
export type SignInResult<O extends AuthOptions = AuthOptions> =
	| { status: 'signedIn'; user: AuthenticatedUser<O> }
	| { status: 'continueSignIn'; nextStep: SignInNextStep };

/** Every challenge or continuation `signIn` can return. Carried over unchanged from `AuthCognito`. */
export type SignInNextStep =
	| { name: 'CONFIRM_SIGN_IN_WITH_SMS_CODE'; session: string; codeDeliveryDetails: CodeDeliveryDetails }
	| { name: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE'; session: string }
	| { name: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE'; session: string; codeDeliveryDetails: CodeDeliveryDetails }
	| { name: 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION'; session: string; allowedMFATypes: ('SMS' | 'TOTP' | 'EMAIL')[] }
	| { name: 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION'; session: string; allowedMFATypes: ('TOTP' | 'EMAIL')[] }
	| { name: 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP'; session: string; sharedSecret: string }
	| { name: 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP'; session: string }
	| { name: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED'; session: string; requiredAttributes?: string[] }
	| {
			name: 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION';
			session: string;
			availableChallenges: PreferredChallenge[];
	  }
	| { name: 'CONFIRM_SIGN_IN_WITH_PASSWORD'; session: string }
	| { name: 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP'; session: string; codeDeliveryDetails: CodeDeliveryDetails }
	| { name: 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP'; session: string; codeDeliveryDetails: CodeDeliveryDetails }
	| { name: 'CONFIRM_SIGN_IN_WITH_WEB_AUTHN'; session: string; credentialRequestOptions: string }
	| { name: 'RESET_PASSWORD' }
	| { name: 'CONFIRM_SIGN_UP'; codeDeliveryDetails?: CodeDeliveryDetails };

/** Result of `resetPassword`. Never reveals whether the user exists. */
export interface ResetPasswordResult {
	isPasswordReset: boolean;
	nextStep?: {
		name: 'CONFIRM_RESET_PASSWORD_WITH_CODE';
		codeDeliveryDetails: CodeDeliveryDetails;
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// The class shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The public instance surface of `Auth<O>`, implemented by every entry point.
 *
 * Methods marked *email + password* end in a {@link PasswordGate} rest
 * parameter; methods marked *federated* end in a {@link FederationGate}. On a
 * configuration where the mode is off, calling them is a compile error.
 *
 * This is the surface tasks D1/D2 pin, plus `confirmSignIn` / `autoSignIn`
 * (D5a, which the sign-in UI's state machine needs), plus the native account
 * surface carried over from `AuthCognito` (D5b): user attributes,
 * `deleteUser`, MFA ({@link MfaGate}), devices, passkeys ({@link PasskeyGate})
 * and the opt-in `auth.admin` handle ({@link AdminGetterOf}). The federated
 * exchange/refresh methods land with D6, on the same gates.
 *
 * Renamed from `AuthCognito` (G14 — avoid `fetch`): `fetchAuthSession` →
 * `getAuthSession`, `fetchUserAttributes` → `getUserAttributes`,
 * `fetchMFAPreference` → `getMfaPreference`, `fetchDevices` → `scanDevices`;
 * and `setUpTOTP` / `verifyTOTPSetup` / `updateMFAPreference` →
 * `setUpTotp` / `verifyTotpSetup` / `updateMfaPreference`.
 */
export interface AuthShape<O extends AuthOptions = AuthOptions> extends BlocksAuth {
	// ── Session & identity — every configuration ────────────────────────────

	/**
	 * Require a signed-in user, or throw 401.
	 *
	 * | Session state | `requireAuth(ctx)` | `requireAuth(ctx, { fresh: true })` |
	 * |---|---|---|
	 * | no cookie, unknown session, or an unreadable cookie | throws 401 `NotAuthenticated` (an unreadable cookie is also cleared) | same |
	 * | valid, signed in within `session.freshAgeSeconds` | returns the user | returns the user |
	 * | valid, signed in longer ago than `session.freshAgeSeconds` | returns the user | throws 401 `ReauthenticationRequired` (session kept) |
	 * | valid, but the user was disabled or deleted upstream **after** the access token was issued | returns the user — not detected until the next refresh (below) | as the two rows above |
	 * | needs a refresh (access token expired) and the identity service **rejects** it: user disabled or deleted, refresh token revoked or expired | throws 401 `NotAuthenticated`; the session is deleted and the cookie cleared | same |
	 * | needs a refresh and the refresh fails **transiently** (throttling, a Cognito 5xx, a network error) | throws the mapped, typically retriable error (e.g. 500 `InternalError`); the session and cookie are kept | same |
	 *
	 * A disabled or deleted user is detected **only when the session next
	 * refreshes**, which happens once its access token expires: up to the
	 * access-token lifetime (Cognito's default is one hour). `requireAuth` makes no
	 * per-request call to the identity service to check that the user is still
	 * active — `AuthCognito` has the same limitation. `requireRole` reads live group
	 * membership on every call, so it fails closed (403) for a *deleted* user
	 * straight away; a *disabled* user keeps their memberships and is caught at the
	 * refresh, like everywhere else.
	 *
	 * @throws {ApiError} 401 `NotAuthenticatedException` when there is no valid session.
	 * @throws {ApiError} 401 `ReauthenticationRequiredException` with `{ fresh: true }` and a stale session.
	 */
	requireAuth(context: BlocksContext, options?: RequireAuthOptions): Promise<AuthenticatedUser<O>>;

	/**
	 * Require a signed-in user who belongs to `role`. Reads current group
	 * membership on each guarded request.
	 *
	 * @throws {ApiError} 401 `NotAuthenticatedException` when there is no valid session.
	 * @throws {ApiError} 403 `NotAuthorizedException` when the user is not in `role`, or no longer exists.
	 */
	requireRole(context: BlocksContext, role: GroupOf<O>, options?: RequireAuthOptions): Promise<AuthenticatedUser<O>>;

	/** `true` when the request carries a valid session. Never throws for a missing session. */
	checkAuth(context: BlocksContext): Promise<boolean>;

	/** The signed-in user, or `null` when there is no valid session. */
	getCurrentUser(context: BlocksContext): Promise<AuthenticatedUser<O> | null>;

	/** The current session's tokens. Never throws; `{ tokens: undefined }` when signed out. */
	getAuthSession(context: BlocksContext, options?: GetAuthSessionOptions): Promise<AuthSession>;

	/** End the session and clear the cookie. Federated sessions are also signed out at the provider. */
	signOut(context: BlocksContext, options?: SignOutOptions): Promise<void>;

	/** The two-method RPC surface (`getAuthState` / `setAuthState`) that drives the sign-in UI. */
	createApi(): AuthStateApi;

	// ── Federated sign-in ───────────────────────────────────────────────────

	/**
	 * Build the IdP authorize URL for `provider`. *Federated.* Most apps never
	 * call this — the `signIn:<id>` action in `getAuthState()` carries the URL.
	 *
	 * @throws {ApiError} 400 `ProviderNotConfiguredException` for an unknown provider id.
	 */
	getSignInUrl(
		context: BlocksContext,
		provider: ProviderIdOf<O>,
		...ERROR_no_federated_provider_is_configured: FederationGate<O, [options?: SignInUrlOptions]>
	): Promise<string>;

	// ── Email + password ────────────────────────────────────────────────────

	/** Register a user. An emailed confirmation code follows. *Email + password.* */
	signUp(
		username: string,
		password: string,
		...ERROR_emailPassword_is_disabled_on_this_Auth_instance: PasswordGate<
			O,
			[options?: SignUpOptions<O>, context?: BlocksContext]
		>
	): Promise<SignUpResult>;

	/**
	 * Confirm a sign-up with the emailed code. *Email + password.*
	 *
	 * @throws {ApiError} 400 `AliasExistsException` when the code is right but the email / phone it verifies is
	 *   already another user's verified sign-in alias (`signInWith` with `'username'`). The user stays unconfirmed.
	 */
	confirmSignUp(
		username: string,
		code: string,
		...ERROR_emailPassword_is_disabled_on_this_Auth_instance: PasswordGate<O, [context?: BlocksContext]>
	): Promise<ConfirmSignUpResult>;

	/** Send a new sign-up confirmation code. *Email + password.* */
	resendSignUpCode(
		username: string,
		...ERROR_emailPassword_is_disabled_on_this_Auth_instance: PasswordGate<O>
	): Promise<void>;

	/**
	 * Sign in with a username and password. *Email + password.*
	 *
	 * @throws {ApiError} 401 `NotAuthorizedException` for unknown user, wrong password or disabled user alike.
	 */
	signIn(
		username: string,
		password: string,
		context: BlocksContext,
		...ERROR_emailPassword_is_disabled_on_this_Auth_instance: PasswordGate<O, [options?: SignInOptions]>
	): Promise<SignInResult<O>>;

	/**
	 * Answer a sign-in challenge (an MFA code, a new password, an MFA choice, …)
	 * returned by `signIn` as `{ status: 'continueSignIn', nextStep }`.
	 * `session` is `nextStep.session`. *Email + password.*
	 *
	 * @throws {ApiError} 400 `CodeMismatchException` (retriable) for a wrong code.
	 */
	confirmSignIn(
		session: string,
		response: string,
		context: BlocksContext,
		...ERROR_emailPassword_is_disabled_on_this_Auth_instance: PasswordGate<O, [options?: ConfirmSignInOptions<O>]>
	): Promise<SignInResult<O>>;

	/**
	 * Sign the user in right after `confirmSignUp` returned
	 * `nextStep.signUpStep === 'COMPLETE_AUTO_SIGN_IN'`, without asking for the
	 * password again (see {@link EmailPasswordOptions.autoSignIn}). The
	 * short-lived bridge cookie `signUp` set is consumed and cleared whatever
	 * the outcome. *Email + password.*
	 *
	 * @throws {ApiError} 401 `NotAuthenticatedException` when no sign-up is pending on this browser.
	 */
	autoSignIn(
		context: BlocksContext,
		...ERROR_emailPassword_is_disabled_on_this_Auth_instance: PasswordGate<O>
	): Promise<SignInResult<O>>;

	/** Start a password reset. Never reveals whether the user exists. *Email + password.* */
	resetPassword(
		username: string,
		...ERROR_emailPassword_is_disabled_on_this_Auth_instance: PasswordGate<O>
	): Promise<ResetPasswordResult>;

	/** Finish a password reset with the emailed code. *Email + password.* */
	confirmResetPassword(
		username: string,
		code: string,
		newPassword: string,
		...ERROR_emailPassword_is_disabled_on_this_Auth_instance: PasswordGate<O>
	): Promise<void>;

	/** Change the signed-in user's password. *Email + password.* */
	updatePassword(
		context: BlocksContext,
		oldPassword: string,
		newPassword: string,
		...ERROR_emailPassword_is_disabled_on_this_Auth_instance: PasswordGate<O>
	): Promise<void>;

	// ── User attributes & account — every configuration ─────────────────────

	/**
	 * Read the signed-in user's attributes directly from the user pool
	 * (Cognito `GetUser`). Costs one extra call per invocation but always
	 * returns fresh data — the session's attributes (`requireAuth().attributes`)
	 * are only as current as the last ID-token issue, so `updateUserAttributes`
	 * followed by a read of the session would otherwise return stale values
	 * until the next refresh or sign-in.
	 *
	 * For a user of a directly federated OIDC provider (no pool record) this
	 * returns the profile claims captured at sign-in.
	 *
	 * @throws {ApiError} 401 `NotAuthenticatedException` when signed out, or when the user no longer exists.
	 */
	getUserAttributes(context: BlocksContext): Promise<Partial<Record<ReadAttrOf<O>, string>>>;

	/**
	 * Update the signed-in user's attributes. Declared custom attributes are
	 * auto-prefixed `custom:`. Changing a contact attribute (`email`,
	 * `phone_number`) sends a verification code to the new value; its entry in
	 * the result is `{ isUpdated: false, nextStep: { name:
	 * 'CONFIRM_ATTRIBUTE_WITH_CODE', … } }` until {@link AuthShape.confirmUserAttribute}
	 * is called. Every other attribute is `{ isUpdated: true }`. Result keys are
	 * the stored names (`custom:`-prefixed for custom attributes).
	 *
	 * @throws {ApiError} 401 `NotAuthenticatedException` when signed out.
	 * @throws {ApiError} 400 `InvalidParameterException` for a directly federated user (their profile lives at the IdP).
	 * @throws {ApiError} 400 `AliasExistsException` on a pool that signs in with email / phone instead of a username
	 *   (`signInWith` without `'username'`), when another user already has that email / phone.
	 */
	updateUserAttributes(
		context: BlocksContext,
		attributes: Partial<Record<AttrOf<O>, string>>,
	): Promise<Partial<Record<AttrOf<O>, UpdateAttributeOutcome>>>;

	/**
	 * Confirm a changed contact attribute (`email`, `phone_number`) with the code
	 * sent by `updateUserAttributes` or `sendUserAttributeVerificationCode`.
	 *
	 * On a pool with sign-in aliases (`signInWith` with `'username'`), confirming
	 * an email / phone that another user holds as a verified alias moves the
	 * alias to this user, as Cognito does: it becomes unverified on the other
	 * account, which can no longer sign in with it.
	 *
	 * @throws {ApiError} 400 `CodeMismatchException` (retriable) / `ExpiredCodeException`.
	 */
	confirmUserAttribute(context: BlocksContext, name: AttrOf<O>, code: string): Promise<void>;

	/** Send (or re-send) a verification code for a contact attribute of the signed-in user. */
	sendUserAttributeVerificationCode(context: BlocksContext, name: AttrOf<O>): Promise<void>;

	/**
	 * Delete the signed-in user's own account from the user pool, end their
	 * session and clear the cookie. Consider `requireAuth(context, { fresh: true })`
	 * first, so a stolen long-lived session cannot delete the account.
	 *
	 * @throws {ApiError} 401 `NotAuthenticatedException` when signed out.
	 * @throws {ApiError} 400 `InvalidParameterException` for a directly federated user (no pool record to delete).
	 */
	deleteUser(context: BlocksContext): Promise<void>;

	// ── MFA — email + password, `mfa` on ────────────────────────────────────

	/**
	 * Start authenticator-app (TOTP) enrolment for the signed-in user: returns
	 * the shared secret to show as a QR code / setup key (Cognito
	 * `AssociateSoftwareToken`). Finish with {@link AuthShape.verifyTotpSetup}.
	 * *Email + password, `mfa` on.*
	 */
	setUpTotp(
		context: BlocksContext,
		...ERROR_mfa_is_off_on_this_Auth_instance: MfaGate<O>
	): Promise<{ sharedSecret: string }>;

	/**
	 * Finish authenticator-app (TOTP) enrolment with a code from the app
	 * (Cognito `VerifySoftwareToken`), and enrol TOTP as an MFA factor so
	 * subsequent sign-ins can challenge it. *Email + password, `mfa` on.*
	 *
	 * @throws {ApiError} 400 `EnableSoftwareTokenMFAException` / `CodeMismatchException` (retriable) for a wrong code.
	 * @throws {ApiError} 400 `SoftwareTokenMFANotFoundException` when `setUpTotp` was not called first.
	 */
	verifyTotpSetup(
		context: BlocksContext,
		code: string,
		...ERROR_mfa_is_off_on_this_Auth_instance: MfaGate<O>
	): Promise<void>;

	/**
	 * Update the MFA preferences for the signed-in user.
	 *
	 * Per-factor delta compatible with Amplify-JS v6. Factors omitted from the
	 * input are left unchanged. At most one factor may be set to
	 * `'PREFERRED'` per call — setting two raises
	 * `InvalidParameterException`. Setting `'PREFERRED'` on a new factor
	 * automatically demotes the previously-preferred factor to
	 * `'NOT_PREFERRED'` (matches Cognito's documented behavior).
	 *
	 * *Email + password, `mfa` on.*
	 *
	 * @throws {ApiError} 400 `InvalidParameterException` for multiple `'PREFERRED'`
	 *   factors in one call, OR a factor the pool doesn't advertise in `mfa.types`.
	 * @throws {ApiError} 400 `SoftwareTokenMFANotFoundException` when enabling TOTP before `setUpTotp` + `verifyTotpSetup`.
	 */
	updateMfaPreference(
		context: BlocksContext,
		input: MfaPreferenceInput<O>,
		...ERROR_mfa_is_off_on_this_Auth_instance: MfaGate<O>
	): Promise<void>;

	/**
	 * Read the signed-in user's current MFA preferences.
	 *
	 * `enabled` may contain any number of factors. `preferred` is
	 * zero-or-one of those factors (or the `'NOMFA'` sentinel). Verified
	 * contact attributes (`email_verified`, `phone_number_verified`) are
	 * surfaced as enabled factors if the pool's `mfa.types` allows them —
	 * this matches Cognito's behavior where a verified email auto-enables
	 * Email MFA without an explicit preference call.
	 *
	 * *Email + password, `mfa` on.*
	 */
	getMfaPreference(
		context: BlocksContext,
		...ERROR_mfa_is_off_on_this_Auth_instance: MfaGate<O>
	): Promise<MfaPreference<O>>;

	// ── Devices — email + password ──────────────────────────────────────────

	/**
	 * The signed-in user's remembered devices (Cognito `ListDevices`), paged
	 * lazily. *Email + password.*
	 *
	 * @example
	 * ```ts
	 * const devices = await Array.fromAsync(auth.scanDevices(context));
	 * ```
	 */
	scanDevices(
		context: BlocksContext,
		...ERROR_emailPassword_is_disabled_on_this_Auth_instance: PasswordGate<O>
	): AsyncIterable<DeviceRecord>;

	/**
	 * Mark the current device as "remembered" so Cognito can skip MFA on
	 * future sign-ins from the same device. *Email + password.*
	 *
	 * ⚠️ Cognito's device-tracking flow needs the device key Cognito issues at
	 * sign-in (`NewDeviceMetadata`) plus a client-derived device verifier. The
	 * local mock implements a synthetic version (it mints a device key); on AWS
	 * this throws a `501` — a known gap carried over from `AuthCognito`, see
	 * `DESIGN.md` ("Known gaps").
	 */
	rememberDevice(
		context: BlocksContext,
		...ERROR_emailPassword_is_disabled_on_this_Auth_instance: PasswordGate<O>
	): Promise<void>;

	/** Forget one of the signed-in user's remembered devices. *Email + password.* */
	forgetDevice(
		context: BlocksContext,
		deviceKey: string,
		...ERROR_emailPassword_is_disabled_on_this_Auth_instance: PasswordGate<O>
	): Promise<void>;

	// ── Passkeys — email + password, `passkeys` set ─────────────────────────

	/**
	 * Begin a passkey enrolment. The signed-in user proves session ownership
	 * via the access token; Cognito returns a
	 * `PublicKeyCredentialCreationOptionsJSON` blob the browser passes to
	 * `navigator.credentials.create(...)`. Pair with
	 * {@link AuthShape.completePasskeyRegistration} to persist the resulting public
	 * key on the pool.
	 *
	 * Most apps never call this directly — the sign-in UI drives it through
	 * `createApi()`'s `startPasskeyRegistration` action.
	 *
	 * @throws {ApiError} `WebAuthnNotEnabledException` when passkeys are not configured — call sites
	 *   should surface this as "passkeys aren't configured for this app" rather than silently failing.
	 */
	startPasskeyRegistration(
		context: BlocksContext,
		...ERROR_passkeys_are_not_enabled_on_this_Auth_instance: PasskeyGate<O>
	): Promise<StartPasskeyRegistrationResult>;

	/**
	 * Complete a passkey enrolment. `credential` is the JSON-encoded
	 * `PublicKeyCredential` returned by `navigator.credentials.create(...)`.
	 *
	 * @throws {ApiError} 400 `InvalidParameterException` when `credential` is not JSON with an `id`.
	 */
	completePasskeyRegistration(
		context: BlocksContext,
		credential: string,
		...ERROR_passkeys_are_not_enabled_on_this_Auth_instance: PasskeyGate<O>
	): Promise<CompletePasskeyRegistrationResult>;

	/**
	 * List the signed-in user's registered passkeys. Paginates internally
	 * — callers receive the full set in one call.
	 */
	listPasskeys(
		context: BlocksContext,
		...ERROR_passkeys_are_not_enabled_on_this_Auth_instance: PasskeyGate<O>
	): Promise<PasskeyDescription[]>;

	/** Delete a registered passkey by `credentialId`. */
	deletePasskey(
		context: BlocksContext,
		credentialId: string,
		...ERROR_passkeys_are_not_enabled_on_this_Auth_instance: PasskeyGate<O>
	): Promise<void>;

	// ── Admin — opt-in ──────────────────────────────────────────────────────

	/**
	 * Opt-in server-side admin surface (group membership + user lifecycle).
	 *
	 * Returns `AdminDisabled` (any member access is a compile error) unless the
	 * block was constructed with an `admin` options object, and throws at
	 * runtime for untyped JS callers that reach past the type system. The set
	 * of methods is narrowed by `admin.actions`; the runtime object always
	 * carries every method (the type hides the ungranted ones), and an ungranted
	 * call fails fast with 403 `NotAuthorizedException` rather than a cryptic
	 * AWS `AccessDenied`.
	 *
	 * `auth.admin` is inside your trust boundary — never expose it to clients
	 * without your own authorization check (e.g. `requireRole(context, 'admins')`).
	 * It is the one surface that reports `UserNotFoundException` for an unknown
	 * user; every public flow hides whether an account exists.
	 *
	 * @example
	 * ```ts
	 * const auth = new Auth(scope, 'auth', { users: { groups: ['admins'] }, admin: {} });
	 * await auth.admin.addUserToGroup('alice', 'admins');
	 * ```
	 */
	readonly admin: AdminGetterOf<O>;
}
