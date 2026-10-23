// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * In-process tests of the `Auth` CDK class: the `synthGuard` stubs, the
 * `createApi()` sentinel, `fromExisting()`, and the synth-time option checks.
 * None of these needs a template, so they run without the child-process
 * harness; everything that inspects CloudFormation lives in the `*.cdk.test.ts`
 * files that synth under `--conditions=cdk`.
 */

import assert from 'node:assert';
import { describe, test } from 'node:test';
import type { ScopeParent } from '@aws-blocks/core';
import * as cdk from 'aws-cdk-lib';
import { requiresUserPool } from './cdk/contract.js';
import { Auth, stubIdp } from './index.cdk.js';
import { synthIdentity } from './test-support/identity.js';
import type { AuthOptions, AuthShape } from './types.js';

/**
 * Every runtime method of {@link AuthShape} (`createApi` has its own CDK stand-in).
 * The type below fails to compile when `AuthShape` gains a method that is not
 * listed — i.e. one without a `synthGuard` stub on the CDK class.
 */
const RUNTIME_METHODS = [
	'requireAuth',
	'requireRole',
	'checkAuth',
	'getCurrentUser',
	'getAuthSession',
	'signOut',
	'getSignInUrl',
	'signUp',
	'confirmSignUp',
	'resendSignUpCode',
	'signIn',
	'confirmSignIn',
	'autoSignIn',
	'resetPassword',
	'confirmResetPassword',
	'updatePassword',
	'getUserAttributes',
	'updateUserAttributes',
	'confirmUserAttribute',
	'sendUserAttributeVerificationCode',
	'deleteUser',
	'setUpTotp',
	'verifyTotpSetup',
	'updateMfaPreference',
	'getMfaPreference',
	'scanDevices',
	'rememberDevice',
	'forgetDevice',
	'startPasskeyRegistration',
	'completePasskeyRegistration',
	'listPasskeys',
	'deletePasskey',
] as const satisfies readonly (keyof AuthShape)[];
/** `admin` is a getter, stubbed separately (see its test below). */
type Unlisted = Exclude<keyof AuthShape, (typeof RUNTIME_METHODS)[number] | 'createApi' | 'admin'>;
const everyMethodListed: [Unlisted] extends [never] ? true : Unlisted = true;

/** A bare stack that the CDK `Scope` accepts as a parent (test plumbing). */
function newStack(): ScopeParent {
	const stack = Object.assign(new cdk.Stack(new cdk.App(), 'TestStack'), { id: 'TestStack' });
	return stack as unknown as ScopeParent;
}

/** Construct `Auth` with `options` and return the thrown message (or fail). */
function constructError(options: AuthOptions, id = 'auth'): string {
	try {
		new Auth(newStack(), id, options);
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
	assert.fail('expected the Auth constructor to throw');
}

/** Options as an untyped JavaScript caller might pass them (test plumbing). */
function untyped(options: unknown): AuthOptions {
	return options as AuthOptions;
}

const OKTA = { okta: { issuer: 'https://dev-1.okta.com', clientId: '0oa1' } };

describe('Auth (CDK) — synthGuard stubs', () => {
	test('the stub list covers every AuthShape runtime method (compile-time)', () => {
		assert.strictEqual(everyMethodListed, true);
	});

	for (const method of RUNTIME_METHODS) {
		test(`${method}() throws the actionable synthGuard message`, () => {
			const fn: unknown = Reflect.get(Auth.prototype, method);
			assert.strictEqual(typeof fn, 'function', `Auth (CDK) has no ${method}() stub`);
			assert.throws(
				() => (fn as () => unknown).call(undefined),
				new RegExp(`^Error: Auth\\.${method}\\(\\) cannot be called during CDK synth`),
			);
		});
	}
});

describe('Auth (CDK) — the admin getter', () => {
	test('reading auth.admin during synth throws the actionable synthGuard message', () => {
		const getter = Object.getOwnPropertyDescriptor(Auth.prototype, 'admin')?.get;
		assert.strictEqual(typeof getter, 'function', 'Auth (CDK) has an admin getter stub');
		assert.throws(() => getter?.call(undefined), /^Error: Auth\.admin\(\) cannot be called during CDK synth/);
	});
});

describe('Auth (CDK) — createApi and fromExisting', () => {
	test('createApi() returns a function tagged Symbol.for("blocks:ApiNamespace") = "auth"', () => {
		const api = Auth.prototype.createApi.call(undefined);
		assert.strictEqual(typeof api, 'function');
		assert.strictEqual(Reflect.get(api, Symbol.for('blocks:ApiNamespace')), 'auth');
	});

	test('fromExisting() returns a reference object, not an Auth', () => {
		assert.deepStrictEqual(Auth.fromExisting('us-east-1_abc', 'client-1'), {
			__brand: 'ExternalUserPoolRef',
			userPoolId: 'us-east-1_abc',
			clientId: 'client-1',
		});
	});
});

describe('Auth (CDK) — requiresUserPool (Q6)', () => {
	const secret = { fullId: 's', get: async () => 'x' };
	const cases: [string, AuthOptions | undefined, boolean][] = [
		['zero-config (email + password default)', undefined, true],
		['emailPassword: true', { emailPassword: true }, true],
		['emailPassword options object', { emailPassword: { selfSignUp: false } }, true],
		['direct OIDC only', { emailPassword: false, oidcProviders: OKTA }, false],
		[
			"OIDC with federateVia: 'cognito'",
			{
				emailPassword: false,
				oidcProviders: {
					okta: {
						issuer: 'https://dev-1.okta.com',
						clientId: '0oa1',
						clientSecret: secret,
						federateVia: 'cognito',
					},
				},
			},
			true,
		],
		[
			'social',
			{ emailPassword: false, socialProviders: { google: { clientId: 'g', clientSecret: secret } } },
			true,
		],
		['SAML', { emailPassword: false, samlProviders: { corp: { metadataUrl: 'https://idp.example.com/m' } } }, true],
		['wrapped existing pool', { emailPassword: false, userPool: Auth.fromExisting('us-east-1_x') }, true],
		[
			'an unset social entry does not count',
			{ emailPassword: false, oidcProviders: OKTA, socialProviders: {} },
			false,
		],
	];
	for (const [name, options, expected] of cases) {
		test(`${name} → ${expected}`, () => assert.strictEqual(requiresUserPool(options), expected));
	}
});

describe('Auth (CDK) — synth-time option checks', () => {
	test('an unsupported users.authFlow throws (untyped callers)', () => {
		assert.match(
			constructError(untyped({ users: { authFlow: 'USER_SRP_AUTH' } })),
			/users\.authFlow 'USER_SRP_AUTH'/,
		);
	});

	test("passkeys without users.authFlow: 'USER_AUTH' throws", () => {
		const message = constructError({
			passkeys: { relyingPartyId: 'example.com', origins: ['https://example.com'] },
		});
		assert.match(message, /passkeys requires `users\.authFlow: 'USER_AUTH'`/);
	});

	test('passkeys without a relyingPartyId or origins throws', () => {
		const users = { authFlow: 'USER_AUTH' } as const;
		assert.match(
			constructError({ users, passkeys: { relyingPartyId: '', origins: ['https://example.com'] } }),
			/relyingPartyId is required/,
		);
		assert.match(constructError({ users, passkeys: { relyingPartyId: 'example.com', origins: [] } }), /origins/);
	});

	test("featurePlan: 'lite' with passkeys, USER_AUTH or EMAIL MFA throws", () => {
		assert.match(
			constructError({ featurePlan: 'lite', users: { authFlow: 'USER_AUTH' } }),
			/users\.authFlow: 'USER_AUTH' require `featurePlan: 'essentials'`/,
		);
		assert.match(
			constructError({
				featurePlan: 'lite',
				users: { authFlow: 'USER_AUTH' },
				passkeys: { relyingPartyId: 'example.com', origins: ['https://example.com'] },
			}),
			/passkeys/,
		);
		assert.match(
			constructError({
				featurePlan: 'lite',
				userPool: Auth.fromExisting('us-east-1_x'),
				mfa: { mode: 'optional', types: ['EMAIL'] },
			}),
			/mfa\.types: \['EMAIL'\]/,
		);
	});

	test('Email MFA on a BB-created pool throws and points at fromExisting', () => {
		assert.match(constructError({ mfa: { mode: 'optional', types: ['EMAIL'] } }), /Auth\.fromExisting/);
	});

	test("users.preferredChallenge: 'EMAIL_OTP' on a BB-created USER_AUTH pool throws and points at fromExisting", () => {
		const message = constructError({ users: { authFlow: 'USER_AUTH', preferredChallenge: 'EMAIL_OTP' } });
		assert.match(message, /preferredChallenge: 'EMAIL_OTP'/);
		assert.match(message, /SES/);
		assert.match(message, /Auth\.fromExisting/);
	});

	test("users.preferredChallenge: 'EMAIL_OTP' is allowed on a wrapped pool, and wherever it enables nothing", () => {
		// A real synth (child process, `--conditions=cdk`): it must succeed.
		const ok = (construct: string) => assert.ok(synthIdentity(construct).template.Resources, construct);
		ok(
			"new Auth(stack, 'auth', { users: { authFlow: 'USER_AUTH', preferredChallenge: 'EMAIL_OTP' }, userPool: Auth.fromExisting('us-east-1_x') })",
		);
		// USER_PASSWORD_AUTH ignores the hint: no first factor is enabled, so no SES is needed.
		ok("new Auth(stack, 'auth', { users: { preferredChallenge: 'EMAIL_OTP' } })");
		for (const preferredChallenge of ['PASSWORD', 'SMS_OTP']) {
			ok(
				`new Auth(stack, 'auth', { users: { authFlow: 'USER_AUTH', preferredChallenge: '${preferredChallenge}' } })`,
			);
		}
	});

	test('empty users.signInWith throws', () => {
		assert.match(constructError({ users: { signInWith: [] } }), /signInWith must contain at least one/);
	});

	test('emailPassword: false with mfa, passkeys or deviceTracking throws (email + password only)', () => {
		assert.match(
			constructError({ emailPassword: false, oidcProviders: OKTA, mfa: 'optional' }),
			/^Auth: mfa apply only/,
		);
		assert.match(
			constructError({ emailPassword: false, oidcProviders: OKTA, users: { deviceTracking: {} } }),
			/users\.deviceTracking apply only/,
		);
	});

	test('a stubIdp() provider throws at synth: the stub IdP is local-only', () => {
		const configs: AuthOptions[] = [
			{ emailPassword: false, oidcProviders: { corp: stubIdp() } },
			{ oidcProviders: { ...OKTA, corp: stubIdp({ users: [{ sub: 'u', email: 'u@example.com', name: 'U' }] }) } },
		];
		for (const options of configs) {
			const message = constructError(options);
			assert.match(message, /`stubIdp\(\)` is local-only; use a real `oidcProviders` entry for deployed stacks/);
			assert.match(message, /oidcProviders\.corp/);
			// …and points at the explicit, alarming opt-in (FX8).
			assert.match(message, /`stubIdp\(\{ unsafeAllowDeployed: true \}\)` deploys it anyway/);
			assert.match(message, /anyone who can reach the app can sign in as the stub's users/);
		}
	});

	test('emailPassword: false with no provider at all throws (no way to sign in)', () => {
		assert.match(constructError({ emailPassword: false }), /leaves no way to sign in/);
	});

	test('admin on a pool-less (direct-only) configuration throws', () => {
		assert.match(
			constructError({ emailPassword: false, oidcProviders: OKTA, admin: {} }),
			/provisions no user pool/,
		);
	});

	test('a fullId over 128 chars throws even when no pool is provisioned', () => {
		const longId = 'a'.repeat(130);
		assert.match(constructError({ emailPassword: false, oidcProviders: OKTA }, longId), /Cognito's limit is 128/);
	});
});
