// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AuthUser } from '@aws-blocks/auth-common';
import type { ChildLogger } from '@aws-blocks/bb-logger';

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Auth flow the User Pool Client advertises.
 *
 * Supported:
 * - `USER_PASSWORD_AUTH` — classic username + password on the first call.
 * - `USER_AUTH` — Cognito's "choice-based" flow that opens with either the
 *   user picking a first factor (`SELECT_CHALLENGE`) or the client hinting
 *   one via {@link AuthCognitoOptions.preferredChallenge}. Lets the app offer
 *   passwordless email-OTP / SMS-OTP / plain password as siblings.
 *
 * Not yet implemented (CDK synth + runtime both throw):
 * - `USER_SRP_AUTH` / `CUSTOM_AUTH` — tracked separately.
 */
export type AuthFlowType =
	| 'USER_PASSWORD_AUTH'
	| 'USER_SRP_AUTH'
	| 'USER_AUTH'
	| 'CUSTOM_AUTH';

/**
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

/**
 * WebAuthn relying-party configuration for passkey sign-in.
 *
 * Cognito requires both `id` (the relying-party identifier — typically your
 * apex domain) and `origins` (the exact `https://...` origins the browser
 * may submit assertions from). There is no safe default for either: an
 * incorrect rpId silently breaks every browser prompt because the
 * authenticator scopes credentials to the rpId at registration time.
 *
 * @example
 * ```ts
 * webAuthnRelyingParty: {
 *   id: 'example.com',
 *   origins: ['https://example.com', 'https://app.example.com'],
 *   userVerification: 'preferred',
 * }
 * ```
 */
export interface WebAuthnRelyingPartyConfig {
	/** Relying-party ID. Typically the apex domain (no scheme, no port). */
	id: string;
	/** Allowed origins. Each must be an exact `https://host[:port]` string. */
	origins: string[];
	/**
	 * Authenticator user-verification policy. Default: `'preferred'`.
	 * - `'required'` — authenticator must perform UV (PIN, biometric, …) per assertion.
	 * - `'preferred'` — authenticator should perform UV when available.
	 * - `'discouraged'` — UV is not requested.
	 */
	userVerification?: 'required' | 'preferred' | 'discouraged';
}

/**
 * The identifier(s) end users sign in with. See
 * {@link AuthCognitoOptions.signInWith} for the per-value semantics
 * (username-as-identifier vs. email-as-username vs. alias mode).
 */
export type SignInWith = 'username' | 'email' | 'phone';

/**
 * Password policy for the Cognito User Pool. Cognito enforces these
 * server-side; the mock enforces them in-process to match.
 */
export interface PasswordPolicy {
	/** Minimum length. Default: 8. */
	minLength?: number;
	/** Require at least one uppercase letter. Default: true. */
	requireUppercase?: boolean;
	/** Require at least one lowercase letter. Default: true. */
	requireLowercase?: boolean;
	/** Require at least one digit. Default: true. */
	requireDigits?: boolean;
	/** Require at least one symbol. Default: true. */
	requireSymbols?: boolean;
}

/**
 * Custom user-pool attribute declaration. Built-in attributes
 * (`email`, `phone_number`, etc.) are implicit and should not be listed.
 */
export interface UserAttribute {
	/** Attribute name without the `custom:` prefix. */
	name: string;
	/** Attribute type. Default: `'String'`. */
	type?: 'String' | 'Number';
	/** Whether the attribute is mutable after creation. Default: true. */
	mutable?: boolean;
	/** Whether the attribute is required at sign-up. Default: false. */
	required?: boolean;
}

/**
 * Reference to an externally-provisioned Cognito User Pool. Returned by
 * `AuthCognito.fromExisting()`; pass in `AuthCognitoOptions.userPool` to
 * wrap a pre-existing pool instead of creating one.
 */
export interface ExternalUserPoolRef {
	readonly __brand: 'ExternalUserPoolRef';
	readonly userPoolId: string;
	readonly clientId?: string;
}

/**
 * Build an {@link ExternalUserPoolRef}. The branded shape is the same in
 * every runtime, so each `AuthCognito` class exposes `static fromExisting`
 * as a thin alias to this helper — one source of truth for the brand
 * string.
 */
export function makeExternalUserPoolRef(
	userPoolId: string,
	clientId?: string,
): ExternalUserPoolRef {
	return { __brand: 'ExternalUserPoolRef', userPoolId, clientId };
}

/**
 * Callback invoked whenever the mock generates a verification code
 * (sign-up, password reset, MFA, attribute verification).
 *
 * In the AWS runtime Cognito handles delivery via email/SMS; this hook is
 * mock-only. Useful for e2e tests that need to retrieve the code out-of-band.
 */
export type CodeDeliveryFn = (
	username: string,
	code: string,
	purpose: 'signUp' | 'resetPassword' | 'mfa' | 'attribute',
) => Promise<void>;

// ─────────────────────────────────────────────────────────────────────────────
// Options-literal projections
// ─────────────────────────────────────────────────────────────────────────────
//
// These helper types project the generic parameter `O extends AuthCognitoOptions`
// into the narrow literal unions `requireRole`, `updateUserAttribute`, and
// `updateMFAPreference` should accept for a given pool configuration.
//
// Customers opt in by passing their options `as const`:
//
//   const auth = new AuthCognito(scope, 'auth', {
//     groups: ['admin', 'editor'],
//     userAttributes: [{ name: 'department' }],
//     mfaTypes: ['EMAIL'],
//   } as const);
//
//   auth.requireRole(context, 'admin');   // ✓ typechecks
//   auth.requireRole(context, 'viewer');  // ✗ compile error
//
// Without `as const`, TypeScript widens the literal arrays to `string[]` and
// these helpers fall back to their defaults — the non-const call sites keep
// today's wide typing for backward-compat.

/**
 * Standard Cognito user-attribute names. Hand-rolled to avoid a runtime
 * dependency on Amplify-JS v6. Covers the OIDC-standard set
 * plus Cognito's `_verified` pairs and `address`.
 */
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

/**
 * Narrow a literal group list from `AuthCognitoOptions.groups` down to the
 * union of group names. Falls back to `string` when the list is widened to
 * `string[]` (i.e. the customer didn't use `as const`).
 *
 * Narrowing only triggers for literal tuples (`readonly [_, ..._[]]`) — a
 * plain `string[]` widens to `string`.
 */
export type GroupOf<O extends AuthCognitoOptions> =
	O extends { groups: readonly [unknown, ...unknown[]] }
		? O extends { groups: readonly (infer G)[] }
			? G extends string
				? G
				: G extends { name: infer N extends string }
					? N
					: string
			: string
		: string;

/**
 * Narrow the custom-attribute names declared in `userAttributes`. Returns
 * a union of `name` strings; `never` when no custom attrs are declared.
 *
 * @internal Exposed only for use in {@link AttrOf}.
 */
export type CustomAttrNames<O extends AuthCognitoOptions> =
	O extends { userAttributes: readonly (infer U)[] }
		? U extends { name: infer N extends string }
			? N
			: never
		: never;

/**
 * Attribute names accepted on **write** APIs — `signUp` attributes,
 * `updateUserAttributes`, `updateUserAttribute`, `confirmUserAttribute`,
 * `sendUserAttributeVerificationCode`. Accepts both the unprefixed
 * custom-attr name (e.g. `'department'`, matching the `userAttributes`
 * declaration) and the `custom:`-prefixed form (matching how Cognito
 * stores it). The runtime auto-prefixes unprefixed declared attrs before
 * calling Cognito.
 *
 * Falls back to `string` when `userAttributes` isn't a literal tuple
 * (i.e. customers who don't pass options `as const` keep today's wide
 * signature).
 */
export type AttrOf<O extends AuthCognitoOptions> =
	O extends { userAttributes: readonly [unknown, ...unknown[]] }
		? StandardUserAttributeKey | CustomAttrNames<O> | `custom:${CustomAttrNames<O>}`
		: string;

/**
 * Attribute names as returned from **read** APIs — `fetchUserAttributes`
 * and `CognitoUser.attributes`. Cognito always stores custom attrs with
 * the `custom:` prefix, so reads only see the prefixed form.
 */
export type ReadAttrOf<O extends AuthCognitoOptions> =
	O extends { userAttributes: readonly [unknown, ...unknown[]] }
		? StandardUserAttributeKey | `custom:${CustomAttrNames<O>}`
		: string;

/**
 * Narrow MFA types to the configured subset. Falls back to the full
 * `'SMS' | 'TOTP' | 'EMAIL'` union when `mfaTypes` isn't a literal tuple.
 */
export type MfaTypeOf<O extends AuthCognitoOptions> =
	O extends { mfaTypes: readonly [unknown, ...unknown[]] }
		? O extends { mfaTypes: readonly (infer M)[] }
			? M extends 'SMS' | 'TOTP' | 'EMAIL'
				? M
				: 'SMS' | 'TOTP' | 'EMAIL'
			: 'SMS' | 'TOTP' | 'EMAIL'
		: 'SMS' | 'TOTP' | 'EMAIL';

/**
 * Options for `AuthCognito`.
 */
export interface AuthCognitoOptions {
	/** MFA mode. Default: `'off'`. */
	mfa?: 'off' | 'optional' | 'required';
	/**
	 * Allowed MFA types. Default: `['SMS', 'TOTP']`. Declared `readonly` so
	 * callers can pass the array `as const` and get narrowed method
	 * signatures (see `MfaTypeOf<O>`).
	 */
	mfaTypes?: readonly ('SMS' | 'TOTP' | 'EMAIL')[];
	passwordPolicy?: PasswordPolicy;
	/**
	 * Custom user-pool attributes. Built-in standard OIDC attrs (`email`,
	 * `phone_number`, `name`, …) are implicit and should NOT be listed here.
	 *
	 * The `<Authenticator>` sign-up form renders fields ONLY for attributes
	 * with `required: true`. Optional attributes (`required: false`, the
	 * default) must be set post-sign-up via `auth.updateUserAttributes`.
	 *
	 * Declared `readonly` so callers can pass the array `as const` and get
	 * narrowed attribute-name signatures (see `AttrOf<O>` / `ReadAttrOf<O>`).
	 */
	userAttributes?: readonly UserAttribute[];
	/**
	 * Groups to create up-front. Admin APIs can still create groups later.
	 *
	 * Declared `readonly` so callers can pass the array `as const` and get
	 * narrowed group-name signatures on `requireRole`, `CognitoUser.groups`
	 * (see `GroupOf<O>`).
	 */
	groups?: readonly (string | { name: string; description?: string; precedence?: number })[];
	/** Whether users can self-register. Default: true. */
	selfSignUp?: boolean;
	/**
	 * What identifier(s) end users sign in with — username, email, phone, or
	 * a combination. Default: `['username', 'email']` (a username plus an
	 * email *alias* — the historical AuthCognito default).
	 *
	 * Picks the right Cognito flag underneath:
	 *
	 *   - **`'username'`** — Cognito `signInAliases: { username: true }`.
	 *     Username is its own attribute; no email alias. `signUp` requires
	 *     a non-email username string.
	 *   - **`'email'`** — Cognito `signInAliases: { email: true }` →
	 *     `UsernameAttributes: ['email']`. Email *is* the username; sign-up
	 *     accepts (and requires) an email value in the `username` field.
	 *     Use this for email-only sign-up flows.
	 *   - **`'phone'`** — Cognito `signInAliases: { phone: true }` →
	 *     `UsernameAttributes: ['phone_number']`. Phone is the username.
	 *     Pool needs an SNS-backed SMS sender.
	 *   - **`['username', 'email']`** (default) — Cognito
	 *     `signInAliases: { username: true, email: true }` →
	 *     `AliasAttributes: ['email']`. Username is the primary identifier;
	 *     email is a *secondary alias* you can also use to sign in with.
	 *     **Sign-up requires a non-email value in the `username` field** —
	 *     this is Cognito's quirk, not a BB choice. Pass an email here and
	 *     Cognito throws *"Username cannot be of email format, since user
	 *     pool is configured for email alias."* If you want email-as-
	 *     username, use `'email'` (singular) instead.
	 *   - **`['username', 'email', 'phone']`** — username + both aliases.
	 *
	 * Affects only the CDK construct's `signInAliases` and `autoVerify`
	 * passthroughs. The AWS runtime is alias-agnostic — it forwards
	 * whatever the caller passes in `signUp(username, …)` verbatim.
	 *
	 * **Backward compatibility:** Changing this on a deployed pool is a
	 * destructive change. Existing users may not be able to sign in with
	 * the new identifier set, and Cognito will reject the
	 * `cloudformation` update with `InvalidParameterException` on alias-
	 * shape transitions. Pick the right value for your initial deploy.
	 */
	signInWith?: SignInWith | SignInWith[];
	/** Enable Cognito device tracking. */
	deviceTracking?: {
		challengeRequiredOnNewDevice?: boolean;
		deviceOnlyRememberedOnUserPrompt?: boolean;
	};
	/** Wrap an existing Cognito User Pool instead of creating one. */
	userPool?: ExternalUserPoolRef;
	/**
	 * Auth flow the User Pool Client will advertise. Server-side decision;
	 * the browser cannot override.
	 *
	 * `'USER_PASSWORD_AUTH'` (default) and `'USER_AUTH'` are supported.
	 * `'USER_SRP_AUTH'` / `'CUSTOM_AUTH'` throw at synth + runtime.
	 */
	authFlowType?: AuthFlowType;
	/**
	 * Default first-factor hint for {@link AuthFlowType} `'USER_AUTH'`. When
	 * omitted, the first `signIn` call returns
	 * `CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION` and the user picks a
	 * factor. When set, that factor is requested directly (e.g.
	 * `'EMAIL_OTP'` → Cognito sends a code and `signIn` returns
	 * `CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP`).
	 *
	 * Ignored for `'USER_PASSWORD_AUTH'` (the classic flow has no factor
	 * choice). The per-call override on `auth.signIn` takes precedence.
	 */
	preferredChallenge?: PreferredChallenge;
	/**
	 * Enable WebAuthn / passkey sign-in. Requires
	 * `authFlowType: 'USER_AUTH'` and a `featurePlan` of `'essentials'` or
	 * `'plus'` (the BB defaults to `'essentials'`).
	 *
	 * When enabled the BB:
	 *   - adds `WEB_AUTHN` to the pool's `AllowedFirstAuthFactors` (CDK),
	 *   - configures the User Pool's `WebAuthnConfiguration` from
	 *     {@link webAuthnRelyingParty} (CDK),
	 *   - exposes `startPasskeyRegistration` / `completePasskeyRegistration` /
	 *     `listPasskeys` / `deletePasskey` on the runtime, and
	 *   - emits the `CONFIRM_SIGN_IN_WITH_WEB_AUTHN` next-step from `signIn`
	 *     when `preferredChallenge` is `'WEB_AUTHN'`.
	 *
	 * The pool's relying-party config has no safe default; you MUST also
	 * provide {@link webAuthnRelyingParty}. CDK synth throws when
	 * `enablePasskeys: true` is set without it.
	 */
	enablePasskeys?: boolean;
	/**
	 * WebAuthn relying-party configuration. Required when
	 * {@link enablePasskeys} is `true`. See {@link WebAuthnRelyingPartyConfig}.
	 */
	webAuthnRelyingParty?: WebAuthnRelyingPartyConfig;
	/**
	 * CDK removal behavior for the User Pool. Default: `'destroy'` — matches
	 * sandbox ergonomics. **For production deploys, set to `'retain'`** to
	 * prevent accidental user-data loss on stack deletion.
	 *
	 * Ignored by the mock runtime.
	 */
	removalPolicy?: 'destroy' | 'retain';
	/**
	 * Cognito feature plan tier for the User Pool. Default: `'essentials'`.
	 *
	 * **Why this is set explicitly and not left to Cognito's default.**
	 * Cognito picks `ESSENTIALS` when no tier is specified at create time,
	 * but applies the tier as a *side effect* on every subsequent
	 * `UpdateUserPool` call — and that side effect resets
	 * `AdminCreateUserConfig.AllowAdminCreateUserOnly` back to `true`,
	 * silently breaking self-signup on every deploy after the first.
	 * Setting `UserPoolTier` explicitly keeps the field stable across
	 * CFN updates and prevents the override.
	 *
	 * Tiers (see Cognito docs at
	 * https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-sign-in-feature-plans.html):
	 *   - **`'lite'`** — basic auth without advanced security or risk
	 *     monitoring. Cheapest. No user-pool-level threat protection.
	 *   - **`'essentials'`** *(default)* — adds risk-based threat
	 *     protection in audit / enforced mode. Matches what Cognito picks
	 *     when nothing is specified.
	 *   - **`'plus'`** — adds password history, advanced security
	 *     features, and threat-protection auto-blocking.
	 *
	 * Ignored by the mock runtime.
	 */
	featurePlan?: 'lite' | 'essentials' | 'plus';
	/**
	 * Browser-cookie `Max-Age` for the opaque session cookie, in seconds.
	 * Defaults to 400 days — the modern cross-browser upper bound.
	 *
	 * This controls **cookie lifetime only**. The cookie is a pointer to a
	 * server-side session record; the server is the single source of truth
	 * for whether the session is still valid. Every request re-validates:
	 * if the access token is still good, the request proceeds; if only the
	 * refresh token is valid, the BB silently refreshes; if neither, the
	 * caller sees a 401 and the cookie is cleared immediately.
	 *
	 * Lower this when you want aggressive re-auth (regulated apps where
	 * stepping away from a workstation for `N` seconds should force a new
	 * login, independent of token validity). Most apps should leave it at
	 * the default — cookie-side expiry can't end a still-valid session early
	 * if the customer raises the UserPoolClient's refresh-token validity
	 * after deploy.
	 */
	sessionTtlSeconds?: number;
	/**
	 * Set `true` only when the frontend and API are served from different
	 * registrable domains in production (e.g. frontend on Vercel, API on
	 * AWS). Switches session cookies to `SameSite=None; Secure; Partitioned`
	 * so they survive the cross-site request. Not needed for same-origin
	 * apps or the local dev proxy, which work with the `SameSite=Lax`
	 * default.
	 *
	 * @default false
	 */
	crossDomain?: boolean;
	/** Optional logger for internal operations. When omitted, a default Logger at error level is created. */
	logger?: ChildLogger;
}

/**
 * Mock-only options. Extends the cross-runtime {@link AuthCognitoOptions}
 * with fields that only make sense for the in-memory mock (local dev, tests).
 *
 * Setting any of these on the AWS or CDK runtime is a TypeScript error by
 * design — the ergonomic hooks below are for dev fixtures, not production,
 * and silently accepting them in production would be a footgun.
 *
 * Customers who want one-source-of-truth options can define their own
 * `AuthCognitoMockOptions`-shaped object and pass it to the mock; pass a
 * slice (without mock-only fields) to the AWS runtime.
 */
export interface AuthCognitoMockOptions extends AuthCognitoOptions {
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
// Sign-up
// ─────────────────────────────────────────────────────────────────────────────

export interface SignUpOptions<O extends AuthCognitoOptions = AuthCognitoOptions> {
	/**
	 * Standard or custom user attributes. When `O` narrows via `as const`,
	 * this becomes a typed map keyed on the declared custom attrs + the
	 * Cognito-standard names; passing an undeclared attribute fails to
	 * compile. Without `as const` the parameter keeps the wide signature.
	 *
	 * Custom attrs are auto-prefixed `custom:` to match Cognito's storage.
	 */
	attributes?: Partial<Record<AttrOf<O>, string>>;
	/**
	 * Metadata passed through to Cognito's `ClientMetadata` parameter.
	 * Consumed by any Cognito Lambda trigger configured on the pool (the
	 * BB itself does not configure triggers; customers can attach their own
	 * via the underlying CDK `userPool` construct).
	 */
	clientMetadata?: Record<string, string>;
	/**
	 * Opt into the post-confirmation auto-sign-in bridge (compatible with Amplify Auth
	 * Cognito — see `Auth.autoSignIn()` in their Swift / Android
	 * docs).
	 *
	 * When `true`, the BB stashes the Cognito session token from `signUp`
	 * + `confirmSignUp` so a follow-up `autoSignIn(context)` call (or, in
	 * the state-machine UI, the auto-chained transition) can hand the
	 * customer a signed-in session without making them re-enter
	 * credentials. For passwordless email/SMS flows this is essential UX
	 * — without it, "confirm code → enter email → wait for second code"
	 * is two OTPs to land on the home screen.
	 *
	 * Default `false`; the existing `signUp` → `confirmSignUp` flow ends
	 * in signed-out and the customer drives a separate `signIn`.
	 */
	autoSignIn?: boolean;
}

export interface CodeDeliveryDetails {
	destination: string;
	deliveryMedium: 'EMAIL' | 'SMS' | 'PHONE_NUMBER';
	attributeName: string;
}

export interface SignUpResult {
	isSignUpComplete: boolean;
	userId?: string;
	nextStep?: {
		name: 'CONFIRM_SIGN_UP';
		codeDeliveryDetails: CodeDeliveryDetails;
	};
}

/**
 * Outcome of `confirmSignUp`. Compatible with Amplify Auth Cognito's shape.
 *
 *   - `isSignUpComplete: true` always — Cognito accepted the code.
 *   - `nextStep.signUpStep === 'DONE'` — the customer's flow ends here;
 *     the user must call `signIn` to start a session.
 *   - `nextStep.signUpStep === 'COMPLETE_AUTO_SIGN_IN'` — the prior
 *     `signUp` call opted into auto-sign-in (`{ autoSignIn: true }`) AND
 *     the BB has the bridging session needed to issue tokens. Caller
 *     finishes the bridge by calling `autoSignIn(context)`. The
 *     Authenticator state machine chains this automatically when present.
 */
export interface ConfirmSignUpResult {
	isSignUpComplete: boolean;
	nextStep: {
		signUpStep: 'DONE' | 'COMPLETE_AUTO_SIGN_IN';
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Sign-in + confirm-sign-in
// ─────────────────────────────────────────────────────────────────────────────

export interface SignInOptions {
	/**
	 * Metadata passed through to Cognito's `ClientMetadata` parameter.
	 * See `SignUpOptions.clientMetadata` for details.
	 */
	clientMetadata?: Record<string, string>;
	/**
	 * Per-call override of the pool's {@link AuthCognitoOptions.preferredChallenge}.
	 *
	 * Ignored by `USER_PASSWORD_AUTH` (classic flow). For `USER_AUTH`:
	 *   - When set, Cognito skips the `SELECT_CHALLENGE` step and issues the
	 *     chosen factor directly.
	 *   - When omitted here AND on the pool options, Cognito returns
	 *     `CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION`.
	 */
	preferredChallenge?: PreferredChallenge;
	/**
	 * Bridging Cognito session token from a prior `signUp` /
	 * `confirmSignUp` round-trip. When set, threaded into `InitiateAuth`
	 * so Cognito can short-circuit the email/SMS-OTP challenge — the user
	 * already proved ownership of the contact during sign-up
	 * confirmation, so a second OTP would be redundant. Used by
	 * `autoSignIn`; the public `signIn` API typically leaves this unset.
	 */
	cognitoSession?: string;
}

export interface ConfirmSignInOptions<O extends AuthCognitoOptions = AuthCognitoOptions> {
	clientMetadata?: Record<string, string>;
	/** Used on `CONTINUE_SIGN_IN_WITH_TOTP_SETUP`. */
	friendlyDeviceName?: string;
	/**
	 * Used on `CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED`. When `O` is
	 * narrowed via `as const`, attribute keys must match the pool's declared
	 * user-attribute set.
	 */
	userAttributes?: Partial<Record<AttrOf<O>, string>>;
}

/**
 * Discriminated payload for {@link AuthCognito.confirmSignIn}.
 *
 * Each branch corresponds to a disjoint group of `SignInNextStep` names:
 * - `{ code }` — SMS / TOTP / Email code challenges + TOTP-setup.
 * - `{ newPassword }` — `CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED`.
 * - `{ mfaType }` — `CONTINUE_SIGN_IN_WITH_MFA_SELECTION` / `..._SETUP_SELECTION`.
 * - `{ email }` — `CONTINUE_SIGN_IN_WITH_EMAIL_SETUP` (the first submit, where
 *   the user tells Cognito which address to send the OTP to). The follow-up
 *   code check uses `{ code }` against `CONFIRM_SIGN_IN_WITH_EMAIL_CODE`.
 *
 * Sending the wrong shape (e.g. `{ newPassword }` when the pool expected a
 * code) is now a compile-time error instead of a vague runtime
 * `CodeMismatch` from Cognito.
 */
export type ConfirmSignInResponse<O extends AuthCognitoOptions = AuthCognitoOptions> =
	| { code: string }
	| { newPassword: string }
	| { mfaType: MfaTypeOf<O> }
	| { email: string }
	// USER_AUTH-specific payloads.
	| { password: string }
	| { firstFactor: 'PASSWORD' | 'EMAIL_OTP' | 'SMS_OTP' | 'WEB_AUTHN' }
	/**
	 * USER_AUTH passkey assertion. The browser-encoded
	 * `PublicKeyCredential` returned by `navigator.credentials.get(...)`,
	 * stringified as JSON. Cognito accepts this verbatim via
	 * `RespondToAuthChallenge(WEB_AUTHN, { CREDENTIAL: <json> })`.
	 */
	| { credential: string };

/**
 * Tagged union on the string `status` field. TypeScript narrows the branch
 * automatically inside an `if (result.status === 'signedIn')` check, and the
 * `status` value is the discriminator native clients (Swift / Kotlin / Dart)
 * key off when generating their result types.
 *
 * `status` is a string literal rather than a boolean on purpose: the native
 * generators detect a discriminated union only when each arm carries a
 * single-value **string** `const`/`enum` field. A boolean discriminator
 * (`isSignedIn: true | false`) is invisible to them — they fall back to numeric
 * `_Variant0/1` structs and try-each-variant decoding that fails to compile —
 * and a boolean value can't name a variant (`true`/`false` are reserved words
 * in all three languages). A string discriminator emits clean, named,
 * switch-decoded variants on every platform.
 */
export type SignInResult<O extends AuthCognitoOptions = AuthCognitoOptions> =
	| { status: 'signedIn'; user: CognitoUser<O> }
	| { status: 'continueSignIn'; nextStep: SignInNextStep };

/**
 * Every challenge / continuation state `signIn` and `confirmSignIn` can
 * return. Additional Cognito challenge types (custom challenge, WebAuthn,
 * first-factor selection, OTP) may be added over time.
 */
export type SignInNextStep =
	| { name: 'CONFIRM_SIGN_IN_WITH_SMS_CODE'; session: string; codeDeliveryDetails: CodeDeliveryDetails }
	| { name: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE'; session: string }
	| { name: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE'; session: string; codeDeliveryDetails: CodeDeliveryDetails }
	| { name: 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION'; session: string; allowedMFATypes: ('SMS' | 'TOTP' | 'EMAIL')[] }
	| { name: 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION'; session: string; allowedMFATypes: ('TOTP' | 'EMAIL')[] }
	| { name: 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP'; session: string; sharedSecret: string }
	| { name: 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP'; session: string }
	| { name: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED'; session: string; requiredAttributes?: string[] }
	// USER_AUTH first-factor branches. Distinct from the MFA-challenge variants
	// above (SMS_MFA, EMAIL_OTP, SOFTWARE_TOKEN_MFA) even though Cognito's
	// ChallengeName is the same — these arrive as the *first* factor on a
	// USER_AUTH sign-in, not as the *second* factor after a password has
	// already been accepted.
	| { name: 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION'; session: string; availableChallenges: ('PASSWORD' | 'EMAIL_OTP' | 'SMS_OTP' | 'WEB_AUTHN')[] }
	| { name: 'CONFIRM_SIGN_IN_WITH_PASSWORD'; session: string }
	| { name: 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP'; session: string; codeDeliveryDetails: CodeDeliveryDetails }
	| { name: 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP'; session: string; codeDeliveryDetails: CodeDeliveryDetails }
	/**
	 * USER_AUTH passkey sign-in. Cognito returned a WebAuthn credential
	 * request — the browser must call `navigator.credentials.get(...)` with
	 * `credentialRequestOptions` and POST the encoded `PublicKeyCredential`
	 * back through `confirmSignIn` as `{ credential: <json> }`.
	 *
	 * The `credentialRequestOptions` value is the `PublicKeyCredentialRequestOptionsJSON`
	 * shape from the WebAuthn Level 3 spec — base64url-encoded challenge +
	 * allow-list. Forwarded verbatim from Cognito's
	 * `RespondToAuthChallenge` response.
	 */
	| { name: 'CONFIRM_SIGN_IN_WITH_WEB_AUTHN'; session: string; credentialRequestOptions: string }
	| { name: 'RESET_PASSWORD' }
	| { name: 'CONFIRM_SIGN_UP'; codeDeliveryDetails?: CodeDeliveryDetails };

// ─────────────────────────────────────────────────────────────────────────────
// User / session
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cognito user shape returned by `getCurrentUser`, `requireAuth`, admin
 * lookups, and the `AuthUser` base contract's `SignInResult`.
 *
 * `userId` and `username` come from the {@link AuthUser} base and are
 * **identical values** for Cognito — both carry the caller-chosen username
 * (email or otherwise). The Cognito-native unique identifier is `userSub`
 * (the `sub` claim, a UUID assigned by the pool). Use `userSub` for joining
 * across data stores; use `username` for display + admin-API lookups.
 *
 * The base requires both `userId` and `username` because other providers
 * (e.g. a hypothetical numeric-id auth BB) may distinguish them.
 */
/**
 * Resolved user identity returned from `requireAuth` / `getCurrentUser` /
 * `requireRole` / `signIn`.
 *
 * When the caller passes `AuthCognitoOptions` `as const`, `CognitoUser<O>`
 * narrows `groups` to the configured group literal union (typo detection
 * on `.includes(...)` checks) and `attributes` keys to the declared
 * custom-attr names plus the standard Cognito attrs. Default parameter
 * keeps today's wide typing for non-const callers.
 */
export interface CognitoUser<O extends AuthCognitoOptions = AuthCognitoOptions> extends AuthUser {
	/** Cognito-assigned UUID (`sub` claim). Unique per user across the pool lifetime. */
	userSub: string;
	/** Group memberships resolved from the `cognito:groups` claim. */
	groups: GroupOf<O>[];
	/** Standard OIDC attrs (`email`, `phone_number`, …) + `custom:*` attrs. */
	attributes: Partial<Record<ReadAttrOf<O>, string>>;
}

export type UpdateAttributeOutcome =
	| { isUpdated: true }
	| {
		isUpdated: false;
		nextStep: { name: 'CONFIRM_ATTRIBUTE_WITH_CODE'; codeDeliveryDetails: CodeDeliveryDetails };
	};

// ─────────────────────────────────────────────────────────────────────────────
// MFA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-factor setting in {@link MFAPreferenceInput}. Compatible with Amplify-JS v6's
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
export type MFASetting = 'ENABLED' | 'DISABLED' | 'PREFERRED' | 'NOT_PREFERRED';

/**
 * Input for {@link AuthCognito.updateMFAPreference}. Per-factor delta
 * matching Amplify-JS v6.
 *
 * Factors you omit are left unchanged. At most **one** factor may be
 * set to `'PREFERRED'` per call — setting two raises
 * `InvalidParameterException` at the call site (matches Cognito).
 *
 * When `O` narrows via `as const` on `AuthCognitoOptions.mfaTypes`,
 * factors the pool doesn't advertise are compile errors: a pool
 * declared `mfaTypes: ['TOTP', 'EMAIL'] as const` rejects
 * `updateMFAPreference(ctx, { sms: 'ENABLED' })` at compile time.
 */
export type MFAPreferenceInput<O extends AuthCognitoOptions = AuthCognitoOptions> =
	& { sms?: 'SMS' extends MfaTypeOf<O> ? MFASetting : never }
	& { totp?: 'TOTP' extends MfaTypeOf<O> ? MFASetting : never }
	& { email?: 'EMAIL' extends MfaTypeOf<O> ? MFASetting : never };

/**
 * Return shape of {@link AuthCognito.fetchMFAPreference}.
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
export interface MFAPreference<O extends AuthCognitoOptions = AuthCognitoOptions> {
	enabled: MfaTypeOf<O>[];
	preferred?: MfaTypeOf<O> | 'NOMFA';
}

// ─────────────────────────────────────────────────────────────────────────────
// Reset password
// ─────────────────────────────────────────────────────────────────────────────

export interface ResetPasswordResult {
	isPasswordReset: boolean;
	nextStep?: {
		name: 'CONFIRM_RESET_PASSWORD_WITH_CODE';
		codeDeliveryDetails: CodeDeliveryDetails;
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Devices
// ─────────────────────────────────────────────────────────────────────────────

export interface DeviceRecord {
	deviceKey: string;
	deviceGroupKey?: string;
	attributes: Record<string, string>;
	createDate?: string;
	lastModifiedDate?: string;
	lastAuthenticatedDate?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Passkeys (WebAuthn)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of {@link AuthCognito.startPasskeyRegistration}. The browser must
 * pass `credentialCreationOptions` (a JSON-stringified
 * `PublicKeyCredentialCreationOptionsJSON`) to
 * `navigator.credentials.create(...)`, then forward the resulting
 * `PublicKeyCredential` back through {@link AuthCognito.completePasskeyRegistration}.
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
 * Result of {@link AuthCognito.completePasskeyRegistration}.
 */
export interface CompletePasskeyRegistrationResult {
	/** Server-assigned credential identifier, base64url-encoded. */
	credentialId: string;
}

/**
 * Single entry returned by {@link AuthCognito.listPasskeys}. Mirrors the
 * fields Cognito's `ListWebAuthnCredentials` response carries, normalised
 * to camelCase + millisecond timestamps for parity with the rest of the BB.
 */
export interface PasskeyDescription {
	/** Server-assigned credential ID, base64url-encoded. */
	credentialId: string;
	/** User-supplied friendly name (e.g. "iPhone"). May be empty. */
	friendlyName?: string;
	/** Authenticator transports the credential supports. */
	transports?: ('usb' | 'nfc' | 'ble' | 'internal' | 'hybrid' | string)[];
	/**
	 * Authenticator attachment. Cognito reports the general category — e.g.
	 * `'platform'` for an on-device biometric, `'cross-platform'` for a
	 * roaming security key.
	 */
	authenticatorAttachment?: string;
	/** Creation timestamp in ms since epoch. */
	createdAt?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session tokens (fetchAuthSession)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decoded JWT returned by {@link AuthCognito.fetchAuthSession}. Shape mirrors
 * Amplify-JS v6's `JWT` type for interoperability.
 *
 * - `toString()` returns the raw JWT string (the thing Cognito actually
 *   issued). Use it as the `Authorization: Bearer <token>` value when
 *   calling a non-Blocks AWS service that accepts a Cognito ID/access token.
 * - `payload` is the decoded claims object typed as
 *   `Record<string, unknown>` — callers **must** narrow or verify each
 *   claim before trusting it, e.g. `const sub = payload.sub as string`
 *   or (safer) a typeof check. Reading claims from here is safe against
 *   forgery because the Blocks session cookie is HMAC-signed, but the
 *   shape of individual claims depends on Cognito version / user-pool
 *   config and can vary by token. Do **not** pass these claims back to
 *   a separate service without re-verifying the signature there.
 * - `expiresAt` is the `exp` claim in **milliseconds since epoch** (not
 *   the raw `exp` seconds).
 */
export interface JWT {
	toString(): string;
	payload: Record<string, unknown>;
	expiresAt: number;
}

/**
 * Return shape of {@link AuthCognito.fetchAuthSession}. Mirrors Amplify-JS v6
 * `AuthSession` but strips fields this BB doesn't populate:
 *
 * - `credentials` / `identityId` — Blocks uses User Pools only (no Identity
 *   Pool). Use the IAM role on the Lambda to call AWS; don't vend
 *   temporary credentials to the browser.
 * - `userSub` — lifted out of the ID token payload for ergonomics.
 *
 * `tokens` is `undefined` when the caller is not signed in. Callers that
 * require a session should call {@link AuthCognito.requireAuth} first, or
 * check `tokens` explicitly.
 */
export interface AuthSession {
	tokens?: {
		idToken: JWT;
		accessToken: JWT;
	};
	userSub?: string;
}

export interface FetchAuthSessionOptions {
	/**
	 * Force a token refresh even if the access token hasn't expired yet.
	 * Useful after an out-of-band group-membership change or an attribute
	 * update where the client wants to see the new claims immediately.
	 *
	 * If the refresh token has been revoked, this returns `{ tokens: undefined }`
	 * and clears the session cookie — the same behavior as a natural
	 * refresh failure.
	 */
	forceRefresh?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Typed error constants. Match Cognito's error names so customers familiar
 * with AWS encounter the same strings.
 *
 * @example
 * ```typescript
 * import { isBlocksError } from '@aws-blocks/core';
 * import { AuthCognitoErrors } from '@aws-blocks/bb-auth-cognito';
 *
 * try {
 *   await auth.signIn(username, password, context);
 * } catch (e) {
 *   if (isBlocksError(e, AuthCognitoErrors.NotAuthorized)) {
 *     // bad credentials
 *   }
 * }
 * ```
 */
export const AuthCognitoErrors = {
	NotAuthenticated: 'NotAuthenticatedException',
	NotAuthorized: 'NotAuthorizedException',
	UserNotFound: 'UserNotFoundException',
	UserAlreadyExists: 'UsernameExistsException',
	InvalidPassword: 'InvalidPasswordException',
	InvalidParameter: 'InvalidParameterException',
	CodeMismatch: 'CodeMismatchException',
	ExpiredCode: 'ExpiredCodeException',
	LimitExceeded: 'LimitExceededException',
	TooManyRequests: 'TooManyRequestsException',
	TooManyFailedAttempts: 'TooManyFailedAttemptsException',
	PasswordResetRequired: 'PasswordResetRequiredException',
	UserNotConfirmed: 'UserNotConfirmedException',
	MFAMethodNotFound: 'MFAMethodNotFoundException',
	SoftwareTokenMFANotFound: 'SoftwareTokenMFANotFoundException',
	GroupNotFound: 'ResourceNotFoundException',
	UnsupportedUserState: 'UnsupportedUserStateException',
	/** Email or phone alias already in use on another user in this pool. */
	AliasExists: 'AliasExistsException',
	/** Cognito Lambda trigger returned a malformed response. */
	InvalidLambdaResponse: 'InvalidLambdaResponseException',
	/** Cognito Lambda trigger threw; error wrapped by Cognito. */
	UserLambdaValidation: 'UserLambdaValidationException',
	/** Rare Cognito-side failure. Safe to retry with backoff. */
	InternalError: 'InternalErrorException',
	/**
	 * Thrown by `VerifySoftwareToken` when the submitted TOTP code does not
	 * match. Distinct from `CodeMismatchException` (which
	 * `RespondToAuthChallenge(SOFTWARE_TOKEN_MFA)` throws) despite the
	 * identical "Code mismatch" message — Cognito splits the error name so
	 * the setup path and post-enrollment path are distinguishable on the
	 * wire. Both are retriable on the same session.
	 */
	EnableSoftwareTokenMFA: 'EnableSoftwareTokenMFAException',
	/** Pool has no `WebAuthnConfiguration` — passkeys disabled. */
	WebAuthnNotEnabled: 'WebAuthnNotEnabledException',
	/** Browser submitted a passkey assertion from a non-allow-listed origin. */
	WebAuthnOriginNotAllowed: 'WebAuthnOriginNotAllowedException',
	/** Submitted credential's rpId does not match the pool's relying-party config. */
	WebAuthnRelyingPartyMismatch: 'WebAuthnRelyingPartyMismatchException',
	/** WebAuthn challenge expired or session lost — caller must restart. */
	WebAuthnChallengeNotFound: 'WebAuthnChallengeNotFoundException',
	/** Submitted credential type / algorithm not supported by the pool config. */
	WebAuthnCredentialNotSupported: 'WebAuthnCredentialNotSupportedException',
	/** Cognito refused the assertion because the client ID does not match. */
	WebAuthnClientMismatch: 'WebAuthnClientMismatchException',
	/** Pool is missing required `WebAuthnConfiguration` (rpId / origins). */
	WebAuthnConfigurationMissing: 'WebAuthnConfigurationMissingException',
} as const;

/**
 * Whether an auth error leaves the current challenge session usable — i.e.
 * the UI can keep the user on the same form, let them fix the input, and
 * resubmit without restarting the whole sign-in flow.
 *
 * Cognito's behavior (verified empirically against a live pool):
 *
 *   - `CodeMismatchException` (`RespondToAuthChallenge`) — session stays
 *     valid, user can resubmit. Cognito counts failed attempts internally
 *     and eventually escalates to `NotAuthorizedException` ("Invalid
 *     session for the user") at which point the session IS dead.
 *   - `EnableSoftwareTokenMFAException` (`VerifySoftwareToken` during
 *     MFA_SETUP) — same. Three failed codes before the session closes.
 *   - `InvalidParameterException` / `InvalidPasswordException` — the
 *     input shape was rejected before the session was consumed. Envelope
 *     is still valid; caller just has to submit a better input. Covers
 *     the BB's own pre-flight checks too.
 *
 * Non-retriable (session is gone, caller must restart):
 *
 *   - `NotAuthorizedException` / `ExpiredCodeException` — session dead.
 *   - `ResourceNotFoundException` — session reference lost.
 *   - `TooMany*` — caller is rate-limited; retry later with a new flow.
 *   - Any unknown name defaults to non-retriable (fail closed).
 *
 * Shared between the mock and AWS runtimes so parity is enforced in one
 * place.
 */
export function isRetriableAuthError(name: string): boolean {
	switch (name) {
		case AuthCognitoErrors.CodeMismatch:
		case AuthCognitoErrors.EnableSoftwareTokenMFA:
		case AuthCognitoErrors.InvalidParameter:
		case AuthCognitoErrors.InvalidPassword:
			return true;
		default:
			return false;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers (exported so every runtime entry can use them)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Environment-variable names the CDK layer sets on the customer's Lambda
 * so the AWS runtime can discover this BB's Cognito resources.
 */
export function envVarNames(fullId: string) {
	const upper = fullId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
	return {
		USER_POOL_ID: `BLOCKS_AUTH_COGNITO_${upper}_USER_POOL_ID`,
		CLIENT_ID: `BLOCKS_AUTH_COGNITO_${upper}_CLIENT_ID`,
		REGION: `BLOCKS_AUTH_COGNITO_${upper}_REGION`,
	} as const;
}
