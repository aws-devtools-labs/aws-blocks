// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `AuthOptions` → CDK prop mappers for the user pool, carried over from
 * `AuthCognito` (`bb-auth-cognito/src/index.cdk.ts`). Each one must produce
 * exactly the CloudFormation `AuthCognito` produces for the equivalent
 * configuration — `property-snapshot.cdk.test.ts` compares the two templates.
 *
 * @internal
 */

import * as cognito from 'aws-cdk-lib/aws-cognito';
import type { AdminAction, MfaMode, MfaOptions, PasswordPolicy, UserAttribute } from '../types.js';

/** The second factors {@link AuthOptions.mfa} enables when `types` is omitted (see `MfaOptions.types`). */
const DEFAULT_MFA_TYPES: readonly ('SMS' | 'TOTP' | 'EMAIL')[] = ['SMS', 'TOTP'];

/** `AuthOptions.mfa` normalized: the mode, the resolved second factors, and the types the caller listed. */
export interface ResolvedMfa {
	mode: MfaMode;
	/** Second factors offered when `mode !== 'off'` — `MfaOptions.types`, defaulted. */
	types: readonly ('SMS' | 'TOTP' | 'EMAIL')[];
	/** `MfaOptions.types` exactly as given (`undefined` when omitted) — drives the `USER_AUTH` first factors. */
	explicitTypes: readonly ('SMS' | 'TOTP' | 'EMAIL')[] | undefined;
}

export function resolveMfa(mfa: MfaMode | MfaOptions | undefined): ResolvedMfa {
	if (mfa === undefined || typeof mfa === 'string') {
		return { mode: mfa ?? 'off', types: DEFAULT_MFA_TYPES, explicitTypes: undefined };
	}
	return { mode: mfa.mode ?? 'off', types: mfa.types ?? DEFAULT_MFA_TYPES, explicitTypes: mfa.types };
}

export function mapPasswordPolicy(p?: PasswordPolicy): cognito.PasswordPolicy | undefined {
	if (!p) return undefined;
	return {
		minLength: p.minLength,
		requireLowercase: p.requireLowercase,
		requireUppercase: p.requireUppercase,
		requireDigits: p.requireDigits,
		requireSymbols: p.requireSymbols,
	};
}

export function mapMfaMode(m: MfaMode): cognito.Mfa {
	switch (m) {
		case 'required':
			return cognito.Mfa.REQUIRED;
		case 'optional':
			return cognito.Mfa.OPTIONAL;
		default:
			return cognito.Mfa.OFF;
	}
}

export function mapMfaTypes(types: readonly ('SMS' | 'TOTP' | 'EMAIL')[]): cognito.MfaSecondFactor | undefined {
	if (types.length === 0) return undefined;
	return {
		sms: types.includes('SMS'),
		otp: types.includes('TOTP'),
		email: types.includes('EMAIL'),
	};
}

/**
 * Custom attributes. `UserAttribute.required` is not mapped: Cognito cannot
 * make a custom attribute required (the same as `AuthCognito`).
 */
export function mapCustomAttributes(
	attrs?: readonly UserAttribute[],
): Record<string, cognito.ICustomAttribute> | undefined {
	if (!attrs || attrs.length === 0) return undefined;
	const out: Record<string, cognito.ICustomAttribute> = {};
	for (const attr of attrs) {
		const mutable = attr.mutable ?? true;
		out[attr.name] =
			attr.type === 'Number'
				? new cognito.NumberAttribute({ mutable })
				: new cognito.StringAttribute({ mutable });
	}
	return out;
}

/**
 * Resolve `users.signInWith` to Cognito's `signInAliases`. `undefined` falls
 * back to `['username', 'email']` — `AuthCognito`'s default, so the zero-config
 * pool is unchanged (a changed `signInWith` is a rollback-on-update, not a
 * visible diff).
 */
export function mapSignInWith(value?: readonly ('username' | 'email' | 'phone')[]): cognito.SignInAliases {
	const list = value ?? ['username', 'email'];
	if (list.length === 0) {
		throw new Error("Auth: users.signInWith must contain at least one of 'username', 'email', or 'phone'.");
	}
	return {
		...(list.includes('username') ? { username: true } : {}),
		...(list.includes('email') ? { email: true } : {}),
		...(list.includes('phone') ? { phone: true } : {}),
	};
}

/**
 * Mirror `signInAliases` into `autoVerify`: only contact attributes (email,
 * phone) can be verified. Explicit rather than left to CDK's derivation, so
 * synth output stays stable across CDK upgrades.
 */
export function mapAutoVerify(aliases: cognito.SignInAliases): cognito.AutoVerifiedAttrs {
	return {
		...(aliases.email ? { email: true } : {}),
		...(aliases.phone ? { phone: true } : {}),
	};
}

/**
 * Resolve `featurePlan`, defaulting to `'essentials'`. Always passed
 * explicitly: left implicit, Cognito re-applies the tier on every
 * `UpdateUserPool`, which resets `AllowAdminCreateUserOnly` to `true` and
 * silently breaks self-sign-up after the first deploy.
 */
export function mapFeaturePlan(plan?: 'lite' | 'essentials' | 'plus'): cognito.FeaturePlan {
	switch (plan) {
		case 'lite':
			return cognito.FeaturePlan.LITE;
		case 'plus':
			return cognito.FeaturePlan.PLUS;
		default:
			return cognito.FeaturePlan.ESSENTIALS;
	}
}

/**
 * The client-facing Cognito actions, granted on every provisioned or wrapped
 * pool. Identical to `AuthCognito`'s base statement, including
 * `AdminListGroupsForUser`: `requireRole` reads live group membership (#583;
 * `DESIGN.md`, "Guards"), independent of the opt-in `admin` surface.
 */
export const CLIENT_IAM_ACTIONS: readonly string[] = [
	'cognito-idp:AdminListGroupsForUser',
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
	// WebAuthn / passkey ops — always granted, as in `AuthCognito`: a pool
	// without passkeys answers `WebAuthnNotEnabledException`.
	'cognito-idp:StartWebAuthnRegistration',
	'cognito-idp:CompleteWebAuthnRegistration',
	'cognito-idp:ListWebAuthnCredentials',
	'cognito-idp:DeleteWebAuthnCredential',
];

/**
 * Map `AdminOptions.actions` to the Cognito `Admin*` / `List*` IAM actions.
 * Omitted `actions` grants both slices. Identical to `AuthCognito`'s
 * `adminIamActions`; keep in lockstep with the runtime admin method sets.
 */
export function adminIamActions(actions?: readonly AdminAction[]): string[] {
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
		// getUser also reports group memberships (AdminGetUser does not), so the
		// lifecycle slice must be self-sufficient for that read.
		'cognito-idp:AdminListGroupsForUser',
		'cognito-idp:ListUsers',
		'cognito-idp:AdminUserGlobalSignOut',
	];
	const enabled = actions ?? ['groups', 'lifecycle'];
	const out: string[] = [];
	if (enabled.includes('groups')) out.push(...groups);
	if (enabled.includes('lifecycle')) out.push(...lifecycle);
	return out;
}
