// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `AuthCognito` → `Auth` configuration pairs the property-level snapshot
 * compares (test-only). The `AuthCognito` side was synthesized from the real
 * block and frozen into `__fixtures__/authcognito-templates.json` before the
 * package was deleted (F1b); `property-snapshot.cdk.test.ts` asserts each
 * fixture entry was captured from exactly the `cognito` string below.
 */

export interface Pair {
	/** The `AuthCognito` construct (synthesized at the freeze; now the fixture's label). */
	cognito: string;
	/** The equivalent `Auth` construct (synthesized live). */
	auth: string;
}

/** `AuthCognito` configuration → the equivalent `Auth` configuration. */
export const PAIRS: Record<string, Pair> = {
	default: {
		cognito: "new AuthCognito(stack, 'auth')",
		auth: "new Auth(stack, 'auth')",
	},
	// B1's `configured` variant.
	configured: {
		cognito:
			"new AuthCognito(stack, 'auth', { groups: ['admins', { name: 'readers', description: 'Read-only', precedence: 2 }], selfSignUp: false, signInWith: 'email', mfa: 'optional', mfaTypes: ['TOTP'], removalPolicy: 'retain' })",
		auth: "new Auth(stack, 'auth', { users: { groups: ['admins', { name: 'readers', description: 'Read-only', precedence: 2 }], signInWith: ['email'] }, emailPassword: { selfSignUp: false }, mfa: { mode: 'optional', types: ['TOTP'] }, removalPolicy: 'retain' })",
	},
	existingPool: {
		cognito: "new AuthCognito(stack, 'auth', { userPool: AuthCognito.fromExisting('us-east-1_existing') })",
		auth: "new Auth(stack, 'auth', { userPool: Auth.fromExisting('us-east-1_existing') })",
	},
	passkeys: {
		cognito:
			"new AuthCognito(stack, 'auth', { authFlowType: 'USER_AUTH', enablePasskeys: true, webAuthnRelyingParty: { id: 'example.com', origins: ['https://example.com'], userVerification: 'required' }, featurePlan: 'plus' })",
		auth: "new Auth(stack, 'auth', { users: { authFlow: 'USER_AUTH' }, passkeys: { relyingPartyId: 'example.com', origins: ['https://example.com'], userVerification: 'required' }, featurePlan: 'plus' })",
	},
	// Every remaining pool-shaping option at once, plus a scoped admin grant.
	everything: {
		cognito:
			"new AuthCognito(stack, 'auth', { passwordPolicy: { minLength: 12, requireSymbols: false }, userAttributes: [{ name: 'tenant' }, { name: 'age', type: 'Number', mutable: false }], deviceTracking: { challengeRequiredOnNewDevice: true }, mfa: 'required', mfaTypes: ['SMS', 'TOTP'], signInWith: ['email', 'phone'], groups: ['ops'], admin: { actions: ['groups'] }, removalPolicy: 'destroy' })",
		auth: "new Auth(stack, 'auth', { emailPassword: { passwordPolicy: { minLength: 12, requireSymbols: false } }, users: { attributes: [{ name: 'tenant' }, { name: 'age', type: 'Number', mutable: false }], deviceTracking: { challengeRequiredOnNewDevice: true }, signInWith: ['email', 'phone'], groups: ['ops'] }, mfa: { mode: 'required', types: ['SMS', 'TOTP'] }, admin: { actions: ['groups'] }, removalPolicy: 'destroy' })",
	},
	// `AuthCognito`'s `mfa: 'optional'` with no `mfaTypes` leaves the second factors
	// to CDK (SMS only). `AuthOptions.mfa.types` defaults to ['SMS', 'TOTP'], so the
	// equivalent `Auth` configuration lists SMS explicitly.
	mfaDefaultTypes: {
		cognito: "new AuthCognito(stack, 'auth', { mfa: 'optional' })",
		auth: "new Auth(stack, 'auth', { mfa: { mode: 'optional', types: ['SMS'] } })",
	},
	fullAdminLite: {
		cognito: "new AuthCognito(stack, 'auth', { admin: {}, featurePlan: 'lite', selfSignUp: true })",
		auth: "new Auth(stack, 'auth', { admin: {}, featurePlan: 'lite', emailPassword: { selfSignUp: true } })",
	},
	// L22 (D5c2): the pool-wide first-factor hint, restored as `users.preferredChallenge`.
	// The OTP hints also enable that first factor in `AllowedFirstAuthFactors`.
	// 'EMAIL_OTP' needs an SES sender, so `Auth` accepts it only on a wrapped pool
	// (`AuthCognito` also synthesized it on a created one — a pool Cognito cannot
	// send the code from; `index.cdk.test.ts` pins the refusal).
	preferredChallengeEmailOtp: {
		cognito:
			"new AuthCognito(stack, 'auth', { userPool: AuthCognito.fromExisting('us-east-1_existing'), authFlowType: 'USER_AUTH', preferredChallenge: 'EMAIL_OTP' })",
		auth: "new Auth(stack, 'auth', { userPool: Auth.fromExisting('us-east-1_existing'), users: { authFlow: 'USER_AUTH', preferredChallenge: 'EMAIL_OTP' } })",
	},
	preferredChallengeSmsOtp: {
		cognito:
			"new AuthCognito(stack, 'auth', { authFlowType: 'USER_AUTH', preferredChallenge: 'SMS_OTP', mfa: 'optional', mfaTypes: ['TOTP'] })",
		auth: "new Auth(stack, 'auth', { users: { authFlow: 'USER_AUTH', preferredChallenge: 'SMS_OTP' }, mfa: { mode: 'optional', types: ['TOTP'] } })",
	},
	userAuthExistingPoolEmailMfa: {
		cognito:
			"new AuthCognito(stack, 'auth', { userPool: AuthCognito.fromExisting('us-east-1_existing'), authFlowType: 'USER_AUTH', mfa: 'optional', mfaTypes: ['EMAIL'] })",
		auth: "new Auth(stack, 'auth', { userPool: Auth.fromExisting('us-east-1_existing'), users: { authFlow: 'USER_AUTH' }, mfa: { mode: 'optional', types: ['EMAIL'] } })",
	},
};
