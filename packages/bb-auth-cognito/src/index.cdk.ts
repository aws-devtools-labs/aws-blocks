// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * @aws-blocks/bb-auth-cognito — CDK construct.
 *
 * Provisions a Cognito User Pool + User Pool Client, optional user-pool
 * groups and custom attributes, a session KVStore (nested child scope),
 * and an AppSetting-backed SSM SecureString holding the session HMAC
 * secret. Writes discovery env vars to the customer's Lambda so the
 * aws-runtime code can look them up.
 *
 * Supports username/password sign-in with MFA (SMS / TOTP / Email OTP),
 * user-pool groups for RBAC, custom attributes, device tracking, and
 * password reset.
 *
 * The runtime code lives in `./index.aws.ts`; conditional exports keep
 * this CDK-only file out of the Lambda bundle.
 */

import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import { Scope } from '@aws-blocks/core/cdk';
import { registerConfig } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import { KVStore } from '@aws-blocks/bb-kv-store';
import { AppSetting } from '@aws-blocks/bb-app-setting';
import type {
	AdminOptions,
	AuthCognitoOptions,
	PasswordPolicy,
	SignInWith,
	UserAttribute,
} from './types.js';
import { envVarNames, makeExternalUserPoolRef } from './types.js';

export * from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// AuthCognito (CDK)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CDK construct for AuthCognito. Same constructor signature as the mock and
 * AWS runtime so customer code works unchanged under `--conditions=cdk`.
 *
 * Creates:
 * - `cognito.UserPool` with the configured MFA mode, password policy, and
 *   custom attributes.
 * - `cognito.UserPoolClient` (no secret; `USER_PASSWORD_AUTH` +
 *   `REFRESH_TOKEN_AUTH` flows enabled; hosted-UI / OAuth redirect flows
 *   disabled via `disableOAuth`).
 * - One `cognito.CfnUserPoolGroup` per entry in `options.groups`.
 * - `KVStore(scope, 'sessions')` for the opaque server-side session store.
 * - `AppSetting(scope, 'session-secret', { secret: true })` — SSM
 *   SecureString holding the HMAC used to sign session cookies. AppSetting
 *   handles the custom-resource wiring and IAM grants.
 *
 * Writes `BLOCKS_AUTH_COGNITO_<UPPER_FULLID>_*` env vars to the Lambda handler
 * so the runtime can discover pool/client IDs + region.
 *
 * Grants the Lambda `cognito-idp:*` scoped to this pool's ARN; the SSM
 * secret's IAM is granted by AppSetting itself.
 */
export class AuthCognito<const O extends AuthCognitoOptions = AuthCognitoOptions> extends Scope {
	public readonly userPool: cognito.IUserPool;
	public readonly userPoolClient: cognito.IUserPoolClient;
	private readonly sessions: KVStore;
	/** Admin opt-in, captured for the IAM grant in `grantCognitoPermissions`. */
	private readonly adminOptions?: AdminOptions;

	constructor(scope: ScopeParent, id: string, options?: O) {
		super(id, { parent: scope });
		// `AuthCognitoOptions` is all-optional; the cast is sound by the type bound.
		const opts: AuthCognitoOptions = options ?? ({} as O);
		this.adminOptions = opts.admin;
		const env = envVarNames(this.fullId);

		// 0. Validate options. `USER_PASSWORD_AUTH` (classic) and `USER_AUTH`
		// (choice-based, passwordless-capable) are supported. `USER_SRP_AUTH`
		// and `CUSTOM_AUTH` still throw at synth so the customer doesn't get
		// a working CDK deploy with a runtime that rejects every sign-in.
		if (
			opts.authFlowType &&
			opts.authFlowType !== 'USER_PASSWORD_AUTH' &&
			opts.authFlowType !== 'USER_AUTH'
		) {
			throw new Error(
				`AuthCognito: authFlowType '${opts.authFlowType}' is not yet supported. Supported: 'USER_PASSWORD_AUTH', 'USER_AUTH'.`,
			);
		}
		// Passkey prerequisites. `enablePasskeys` requires USER_AUTH (only
		// flow that surfaces the WEB_AUTHN challenge) and an explicit
		// relying-party config — Cognito has no safe default for `rpId` or
		// `origins`, and an incorrect rpId silently breaks every browser
		// prompt at the authenticator layer.
		if (opts.enablePasskeys) {
			if (opts.authFlowType !== 'USER_AUTH') {
				throw new Error(
					'AuthCognito: enablePasskeys requires `authFlowType: \'USER_AUTH\'`. Passkeys ride on the USER_AUTH choice-based flow.',
				);
			}
			if (!opts.webAuthnRelyingParty) {
				throw new Error(
					'AuthCognito: enablePasskeys requires `webAuthnRelyingParty` (id + origins). There is no safe default — an incorrect rpId silently breaks every browser passkey prompt.',
				);
			}
			if (!opts.webAuthnRelyingParty.id) {
				throw new Error('AuthCognito: webAuthnRelyingParty.id is required.');
			}
			if (!opts.webAuthnRelyingParty.origins?.length) {
				throw new Error('AuthCognito: webAuthnRelyingParty.origins must be a non-empty list of `https://...` URLs.');
			}
			if (opts.featurePlan === 'lite') {
				throw new Error(
					'AuthCognito: enablePasskeys requires `featurePlan: \'essentials\'` or `\'plus\'`. The `lite` tier does not include WebAuthn support.',
				);
			}
		}

		// 1. User Pool
		// Cognito caps UserPool names at 128 chars. Fail loudly at synth time
		// rather than silently truncating — two BBs with long fullIds that
		// differ only past position 128 would otherwise produce identical pool
		// names.
		if (this.fullId.length > 128) {
			throw new Error(
				`AuthCognito: computed userPoolName '${this.fullId}' is ${this.fullId.length} chars; Cognito's limit is 128. Shorten the BB id or stack name.`,
			);
		}
		// AWS Cognito requires Email MFA to be backed by SES (Cognito's
		// internal sender has a 50-msg/day quota and Cognito's own
		// validator rejects it for Email MFA). Fail fast at synth time
		// with a pointer at the workaround instead of propagating the
		// raw CDK "EnableEmailBased" error.
		//
		// Only trips when Email MFA would actually get advertised on
		// the pool — `mfa !== 'off'` AND 'EMAIL' in `mfaTypes`.
		// With `mfa: 'off'` we don't pass `mfaSecondFactor` at all (see
		// below), so the CDK validator never sees EMAIL and the guard
		// doesn't need to fire.
		const mfaTypes = opts.mfaTypes ?? [];
		const mfaMode = opts.mfa ?? 'off';
		const emailMfaAdvertised = mfaMode !== 'off' && mfaTypes.includes('EMAIL');
		if (emailMfaAdvertised && !opts.userPool) {
			throw new Error(
				'AuthCognito: Email MFA on a BB-created pool requires an SES `email` configuration on `cognito.UserPool`. '
				+ 'AuthCognitoOptions does not yet expose an `email` passthrough (Part 2). '
				+ 'Workarounds: (a) omit EMAIL from `mfaTypes` and use TOTP / SMS, or '
				+ '(b) bring a pre-configured pool via `AuthCognito.fromExisting(userPoolId, clientId)`.',
			);
		}

		// `signInWith` resolves to Cognito's `signInAliases` flag map.
		// Default `['username', 'email']` preserves the historical AuthCognito
		// behavior — username is primary, email is a secondary alias. See
		// {@link AuthCognitoOptions.signInWith} for the per-value semantics.
		const signInAliases = mapSignInWith(opts.signInWith);
		// `autoVerify` mirrors `signInAliases` so phone-only / email-only
		// pools get the right attribute auto-verified. (Cognito's L2
		// default-derives `autoVerify` from `signInAliases` already, but
		// being explicit keeps synth output stable across CDK upgrades.)
		const autoVerify = mapAutoVerify(signInAliases);
		this.userPool = opts.userPool
			? cognito.UserPool.fromUserPoolId(this, 'pool', opts.userPool.userPoolId)
			: new cognito.UserPool(this, 'pool', {
				userPoolName: this.fullId,
				selfSignUpEnabled: opts.selfSignUp ?? true,
				signInAliases,
				autoVerify,
				passwordPolicy: mapPasswordPolicy(opts.passwordPolicy),
				mfa: mapMfaMode(opts.mfa),
				// Pass `mfaSecondFactor` only when MFA is actually on —
				// setting `{ email: true }` with `mfa: 'off'` still trips
				// CDK's EMAIL-requires-SES validator.
				mfaSecondFactor: mfaMode !== 'off' ? mapMfaTypes(opts.mfaTypes) : undefined,
				customAttributes: mapCustomAttributes(opts.userAttributes),
				deviceTracking: opts.deviceTracking
					? {
						challengeRequiredOnNewDevice: opts.deviceTracking.challengeRequiredOnNewDevice ?? false,
						deviceOnlyRememberedOnUserPrompt: opts.deviceTracking.deviceOnlyRememberedOnUserPrompt ?? false,
					}
					: undefined,
				// Explicit feature plan — Cognito otherwise defaults to
				// `ESSENTIALS` and re-applies the tier as a side effect on
				// every `UpdateUserPool`, which silently resets
				// `AdminCreateUserConfig.AllowAdminCreateUserOnly` back to
				// `true` (breaking self-signup on every deploy after the
				// first). Setting it pinpoint here keeps subsequent
				// `UpdateUserPool` calls a no-op for the tier and stops the
				// reset cascade. Defaults to `'essentials'` so customers on
				// the prior implicit-default tier don't see a billable
				// upgrade or downgrade.
				featurePlan: mapFeaturePlan(opts.featurePlan),
				// USER_AUTH first-factor list. CDK 2.246+ exposes this as the
				// `signInPolicy.allowedFirstAuthFactors` L2 — see the source
				// at `aws-cognito/lib/user-pool.ts:configureSignInPolicy`,
				// which translates these flags to CFN's
				// `Policies.SignInPolicy.AllowedFirstAuthFactors` array.
				// `password` is required by the API; the choice-based factors
				// (emailOtp / smsOtp / passkey) are optional and gated on the
				// matching options.
				signInPolicy: opts.authFlowType === 'USER_AUTH' ? {
					allowedFirstAuthFactors: {
						password: true,
						emailOtp: opts.mfaTypes?.includes('EMAIL') || opts.preferredChallenge === 'EMAIL_OTP',
						smsOtp: opts.mfaTypes?.includes('SMS') || opts.preferredChallenge === 'SMS_OTP',
						passkey: opts.enablePasskeys === true,
					},
				} : undefined,
				// Native L2 passkey relying-party config. CDK 2.246+
				// translates these to the CFN top-level
				// `WebAuthnRelyingPartyId` + `WebAuthnUserVerification`
				// properties on `AWS::Cognito::UserPool` (NOT under a
				// `WebAuthnConfiguration` envelope — that name was used in
				// some early docs but Cognito rejects it on `CreateUserPool`).
				// Matches what `@aws-amplify/auth-construct` does for its
				// `loginWith.webAuthn` option.
				...(opts.enablePasskeys && opts.webAuthnRelyingParty ? {
					passkeyRelyingPartyId: opts.webAuthnRelyingParty.id,
					passkeyUserVerification: opts.webAuthnRelyingParty.userVerification === 'required'
						? cognito.PasskeyUserVerification.REQUIRED
						: cognito.PasskeyUserVerification.PREFERRED,
				} : {}),
				// Default DESTROY for sandbox ergonomics; customers MUST set 'retain' for production deploys.
				removalPolicy: opts.removalPolicy === 'retain'
					? cdk.RemovalPolicy.RETAIN
					: cdk.RemovalPolicy.DESTROY,
			});

		// 2. App client (no secret). Default flow is `USER_PASSWORD_AUTH` +
		// `REFRESH_TOKEN_AUTH`. When `USER_AUTH` is picked we additionally
		// enable the `user` (USER_AUTH) flow — CDK's cognito.UserPool l2
		// construct auto-adds the `ALLOW_REFRESH_TOKEN_AUTH` flow alongside.
		const enableUserAuth = opts.authFlowType === 'USER_AUTH';
		this.userPoolClient = new cognito.UserPoolClient(this, 'client', {
			userPool: this.userPool,
			generateSecret: false,
			// SDK + session-cookie auth only; the hosted UI is never used.
			// Off by default CDK would enable the implicit grant and a
			// placeholder example.com callback — unused attack surface.
			disableOAuth: true,
			authFlows: {
				userPassword: true,
				userSrp: false,
				custom: false,
				adminUserPassword: false,
				user: enableUserAuth,
			},
		});

		// USER_AUTH first-factor list + passkey relying-party config flow
		// through CDK's native L2 props (`signInPolicy.allowedFirstAuthFactors`
		// and `passkeyRelyingPartyId`/`passkeyUserVerification`). See the
		// `cognito.UserPool` instantiation above. No L1 escape hatch needed
		// in CDK 2.246+; same shape `@aws-amplify/auth-construct` uses.

		// 3. Groups
		for (const g of opts.groups ?? []) {
			const spec = typeof g === 'string' ? { name: g } : g;
			new cognito.CfnUserPoolGroup(this, `group-${spec.name}`, {
				userPoolId: this.userPool.userPoolId,
				groupName: spec.name,
				description: spec.description,
				precedence: spec.precedence,
			});
		}

		// 4. Session HMAC secret — SSM SecureString via AppSetting. The
		// construct generates a random value on first deploy, wires the
		// custom resource, and grants `this.handler` ssm:GetParameter +
		// kms:Decrypt automatically. The runtime (`index.aws.ts`) reads it
		// by instantiating its own `AppSetting` at the same scope path, so
		// no env var is needed.
		new AppSetting(this, 'session-secret', { secret: true });

		// 5. Session store (KVStore). Propagate `removalPolicy` so retain-mode
		// customers don't lose live sessions on stack delete.
		this.sessions = new KVStore(this, 'sessions', { removalPolicy: opts.removalPolicy });

		// 6. Env vars + IAM
		const fn = this.handler as lambda.Function;
		registerConfig(this, env.USER_POOL_ID, this.userPool.userPoolId);
		registerConfig(this, env.CLIENT_ID, this.userPoolClient.userPoolClientId);
		registerConfig(this, env.REGION, cdk.Stack.of(this).region);
		this.grantCognitoPermissions(fn);
	}

	/**
	 * Wrap a pre-provisioned Cognito User Pool instead of creating one.
	 * Pass the result via `AuthCognitoOptions.userPool`.
	 */
	static fromExisting = makeExternalUserPoolRef;

	/**
	 * Stub for CDK synth. The real state-machine `ApiNamespace` is emitted
	 * by the runtime entries (`./index.ts`, `./index.aws.ts`). This no-op
	 * keeps `customer.createApi()` calls in the IFC layer compilable under
	 * `--conditions=cdk` without emitting a second (broken) ApiNamespace.
	 *
	 * Returns a function tagged with `Symbol.for('blocks:ApiNamespace')` so
	 * core's synth-time route discovery recognizes it as a namespace
	 * stub. The shape is contract-level — a test in `index.cdk.test.ts`
	 * locks it so core refactors can't silently break synth.
	 */
	createApi() {
		return Object.assign(() => ({}), { [Symbol.for('blocks:ApiNamespace')]: 'auth' });
	}

	// ─── IAM helpers ──────────────────────────────────────────────────────

	private grantCognitoPermissions(fn: lambda.Function): void {
		const poolArn = this.userPool.userPoolArn;
		// Client-facing actions — work on the signed-in user via their access token.
		fn.addToRolePolicy(new iam.PolicyStatement({
			actions: [
				'cognito-idp:SignUp',
				'cognito-idp:ConfirmSignUp',
				'cognito-idp:ResendConfirmationCode',
				'cognito-idp:InitiateAuth',
				'cognito-idp:RespondToAuthChallenge',
				'cognito-idp:GetUser',
				'cognito-idp:ChangePassword',
				'cognito-idp:UpdateUserAttributes',
				'cognito-idp:GetUserAttributeVerificationCode',
				'cognito-idp:VerifyUserAttribute',
				'cognito-idp:DeleteUser',
				'cognito-idp:AssociateSoftwareToken',
				'cognito-idp:VerifySoftwareToken',
				'cognito-idp:SetUserMFAPreference',
				'cognito-idp:ForgotPassword',
				'cognito-idp:ConfirmForgotPassword',
				'cognito-idp:GlobalSignOut',
				'cognito-idp:ListDevices',
				'cognito-idp:UpdateDeviceStatus',
				'cognito-idp:ForgetDevice',
				// WebAuthn / passkey ops. Always granted because the runtime
				// surfaces the four passkey methods unconditionally — a
				// customer that never enables passkeys at the pool level
				// just gets `WebAuthnNotEnabledException` from Cognito on
				// the first call, which the BB rethrows verbatim.
				'cognito-idp:StartWebAuthnRegistration',
				'cognito-idp:CompleteWebAuthnRegistration',
				'cognito-idp:ListWebAuthnCredentials',
				'cognito-idp:DeleteWebAuthnCredential',
			],
			resources: [poolArn],
		}));

		// Admin surface — opt-in only. Omitting `admin` grants NO Admin*/List*
		// actions, so the synthesized role is byte-identical to today. When
		// present, `admin.actions` scopes the grant; an omitted `actions`
		// grants both groups + lifecycle. The same `actions` value scopes the
		// typed `auth.admin` surface, so grant and types cannot drift.
		const admin = this.adminOptions;
		if (admin) {
			const adminActions = adminIamActions(admin.actions);
			if (adminActions.length > 0) {
				fn.addToRolePolicy(new iam.PolicyStatement({
					actions: adminActions,
					resources: [poolArn],
				}));
			}
		}
	}

}

/**
 * Map `AdminOptions.actions` to the Cognito `Admin*` / `List*` IAM actions.
 * Omitted `actions` grants both slices. Keep in lockstep with the runtime
 * `GroupAdmin` / `LifecycleAdmin` method sets.
 */
function adminIamActions(actions?: readonly ('groups' | 'lifecycle')[]): string[] {
	const groups = [
		'cognito-idp:AdminAddUserToGroup',
		'cognito-idp:AdminRemoveUserFromGroup',
		'cognito-idp:AdminListGroupsForUser',
		'cognito-idp:ListUsersInGroup',
	];
	const lifecycle = [
		'cognito-idp:AdminCreateUser',
		'cognito-idp:AdminDeleteUser',
		'cognito-idp:AdminEnableUser',
		'cognito-idp:AdminDisableUser',
		'cognito-idp:AdminResetUserPassword',
		'cognito-idp:AdminSetUserPassword',
		'cognito-idp:AdminGetUser',
		'cognito-idp:ListUsers',
		'cognito-idp:AdminUserGlobalSignOut',
	];
	const enabled = actions ?? ['groups', 'lifecycle'];
	const out: string[] = [];
	if (enabled.includes('groups')) out.push(...groups);
	if (enabled.includes('lifecycle')) out.push(...lifecycle);
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Option → CDK mappers
// ─────────────────────────────────────────────────────────────────────────────

function mapPasswordPolicy(p?: PasswordPolicy): cognito.PasswordPolicy | undefined {
	if (!p) return undefined;
	return {
		minLength: p.minLength,
		requireLowercase: p.requireLowercase,
		requireUppercase: p.requireUppercase,
		requireDigits: p.requireDigits,
		requireSymbols: p.requireSymbols,
	};
}

function mapMfaMode(m?: 'off' | 'optional' | 'required'): cognito.Mfa {
	switch (m) {
		case 'required': return cognito.Mfa.REQUIRED;
		case 'optional': return cognito.Mfa.OPTIONAL;
		default: return cognito.Mfa.OFF;
	}
}

function mapMfaTypes(types?: readonly ('SMS' | 'TOTP' | 'EMAIL')[]): cognito.MfaSecondFactor | undefined {
	if (!types || types.length === 0) return undefined;
	return {
		sms: types.includes('SMS'),
		otp: types.includes('TOTP'),
		email: types.includes('EMAIL'),
	};
}

function mapCustomAttributes(
	attrs?: readonly UserAttribute[],
): Record<string, cognito.ICustomAttribute> | undefined {
	if (!attrs || attrs.length === 0) return undefined;
	const out: Record<string, cognito.ICustomAttribute> = {};
	for (const attr of attrs) {
		const mutable = attr.mutable ?? true;
		out[attr.name] = attr.type === 'Number'
			? new cognito.NumberAttribute({ mutable })
			: new cognito.StringAttribute({ mutable });
	}
	return out;
}

/**
 * Resolve the {@link AuthCognitoOptions.signInWith} option to Cognito's
 * `signInAliases` flag map. `undefined` falls back to the historical
 * default `['username', 'email']`. A bare `SignInWith` value is treated
 * as a single-element list. Phone is normalized to Cognito's
 * `phone_number` shape via the L2 `phone` boolean.
 *
 * @internal
 */
function mapSignInWith(value?: SignInWith | SignInWith[]): cognito.SignInAliases {
	const list: readonly SignInWith[] = value === undefined
		? ['username', 'email']
		: Array.isArray(value)
			? value
			: [value];
	if (list.length === 0) {
		// Empty array would synthesize an unusable pool — Cognito requires
		// at least one identifier. Fail loudly at synth time.
		throw new Error(
			'AuthCognito: signInWith must contain at least one of \'username\', \'email\', or \'phone\'.',
		);
	}
	return {
		...(list.includes('username') ? { username: true } : {}),
		...(list.includes('email') ? { email: true } : {}),
		...(list.includes('phone') ? { phone: true } : {}),
	};
}

/**
 * Mirror `signInAliases` into `autoVerify` so contact-attribute
 * verification fires automatically on the same set the user signs in
 * with. CDK's L2 derives this when `autoVerify` is omitted, but a
 * `signInAliases: { phone: true }` pool would otherwise skip
 * `autoVerify: { phone: true }` because earlier code passed
 * `{ email: true }` literally — this helper makes the relationship
 * explicit and stable across CDK versions.
 *
 * @internal
 */
/**
 * Resolve {@link AuthCognitoOptions.featurePlan} to CDK's
 * `cognito.FeaturePlan` enum. Default `'essentials'` matches what
 * Cognito would pick implicitly — but we always pass it explicitly so
 * subsequent `UpdateUserPool` calls don't re-apply the tier as a side
 * effect (which resets `AdminCreateUserConfig.AllowAdminCreateUserOnly`
 * back to `true` and silently breaks self-signup).
 *
 * @internal
 */
function mapFeaturePlan(plan?: 'lite' | 'essentials' | 'plus'): cognito.FeaturePlan {
	switch (plan) {
		case 'lite': return cognito.FeaturePlan.LITE;
		case 'plus': return cognito.FeaturePlan.PLUS;
		default: return cognito.FeaturePlan.ESSENTIALS;
	}
}

function mapAutoVerify(aliases: cognito.SignInAliases): cognito.AutoVerifiedAttrs {
	// Username can't be "verified" — it's just a chosen identifier. Only
	// contact attributes (email, phone) flow into autoVerify. Username-
	// only pools get an empty `autoVerify` object — the customer can
	// still verify email/phone explicitly through `updateUserAttributes`
	// + `confirmUserAttribute` later. Building with spreads sidesteps
	// CDK's readonly types on the literal flag map.
	return {
		...(aliases.email ? { email: true } : {}),
		...(aliases.phone ? { phone: true } : {}),
	};
}

