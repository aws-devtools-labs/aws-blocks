// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Template } from 'aws-cdk-lib/assertions';
import type { ScopeParent } from '@aws-blocks/core';
import { clearRouteRegistry } from '@aws-blocks/core';
import { finalizeConfigRegistry, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import { AuthCognito } from './index.cdk.js';

beforeEach(() => {
	clearRouteRegistry();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function synth(build: (stack: cdk.Stack) => void) {
	const app = new cdk.App();
	// BlocksStack has a private ctor; build a plain Stack + placeholder Handler
	// Lambda so AuthCognito can register config via the config registry.
	const stack = new cdk.Stack(app, 'TestStack');
	const handler = new lambda.Function(stack, 'Handler', {
		runtime: DEFAULT_NODE_RUNTIME,
		handler: 'index.handler',
		code: lambda.Code.fromInline('exports.handler = async () => {};'),
	});
	(stack as any).handler = handler;
	(globalThis as any).CURRENT_BLOCKS_STACK = stack;
	try {
		build(stack);
		finalizeConfigRegistry(stack, handler);
		return Template.fromStack(stack);
	} finally {
		delete (globalThis as any).CURRENT_BLOCKS_STACK;
	}
}

/** The CDK `Stack` has a `.id` property exactly like a BlocksStack, so `ScopeParent` accepts it once cast. */
function scope(stack: cdk.Stack): ScopeParent {
	return stack as unknown as ScopeParent;
}

// ─── User Pool ──────────────────────────────────────────────────────────────

describe('AuthCognito (CDK) — user pool', () => {
	test('creates a User Pool with defaults', () => {
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth');
		});
		template.resourceCountIs('AWS::Cognito::UserPool', 1);
		template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
	});

	test('user pool is configured for self-sign-up by default', () => {
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth');
		});
		template.hasResourceProperties('AWS::Cognito::UserPool', {
			AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
		});
	});

	test('selfSignUp: false produces admin-only pool', () => {
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth', { selfSignUp: false });
		});
		template.hasResourceProperties('AWS::Cognito::UserPool', {
			AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
		});
	});

	test('MFA required + TOTP', () => {
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth', { mfa: 'required', mfaTypes: ['TOTP'] });
		});
		template.hasResourceProperties('AWS::Cognito::UserPool', {
			MfaConfiguration: 'ON',
			EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
		});
	});

	test('password policy flows through', () => {
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth', {
				passwordPolicy: { minLength: 12, requireSymbols: false },
			});
		});
		template.hasResourceProperties('AWS::Cognito::UserPool', {
			Policies: {
				PasswordPolicy: {
					MinimumLength: 12,
					RequireSymbols: false,
				},
			},
		});
	});

	test('custom attributes become String/Number schema entries', () => {
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth', {
				userAttributes: [
					{ name: 'department' },
					{ name: 'employeeId', type: 'Number', mutable: false },
				],
			});
		});
		template.hasResourceProperties('AWS::Cognito::UserPool', {
			Schema: [
				{ Name: 'department', AttributeDataType: 'String' },
				{ Name: 'employeeId', AttributeDataType: 'Number', Mutable: false },
			],
		});
	});
});

// ─── Client ─────────────────────────────────────────────────────────────────

describe('AuthCognito (CDK) — user pool client', () => {
	test('default client has USER_PASSWORD_AUTH + REFRESH_TOKEN_AUTH', () => {
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth');
		});
		template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
			ExplicitAuthFlows: [
				'ALLOW_USER_PASSWORD_AUTH',
				'ALLOW_REFRESH_TOKEN_AUTH',
			],
			GenerateSecret: false,
		});
	});

	test('hosted-UI / OAuth flows are disabled (no implicit grant, no placeholder callback)', () => {
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth');
		});
		template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
			AllowedOAuthFlowsUserPoolClient: false,
		});
		const clients = template.findResources('AWS::Cognito::UserPoolClient');
		for (const { Properties } of Object.values(clients)) {
			assert.strictEqual(Properties.CallbackURLs, undefined);
			assert.strictEqual(Properties.AllowedOAuthFlows, undefined);
		}
	});
});

// ─── UserPoolDomain ─────────────────────────────────────────────────────────

describe('AuthCognito (CDK) — UserPoolDomain', () => {
	test('does not provision a UserPoolDomain', () => {
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth');
		});
		template.resourceCountIs('AWS::Cognito::UserPoolDomain', 0);
	});
});

// ─── Groups ─────────────────────────────────────────────────────────────────

describe('AuthCognito (CDK) — groups', () => {
	test('emits one UserPoolGroup per string entry', () => {
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth', { groups: ['admins', 'readers'] });
		});
		template.resourceCountIs('AWS::Cognito::UserPoolGroup', 2);
		template.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'admins' });
		template.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'readers' });
	});

	test('accepts detailed group spec', () => {
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth', {
				groups: [{ name: 'super-admin', description: 'root', precedence: 1 }],
			});
		});
		template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
			GroupName: 'super-admin',
			Description: 'root',
			Precedence: 1,
		});
	});
});

// ─── Session store + secret ─────────────────────────────────────────────────

describe('AuthCognito (CDK) — session store', () => {
	// NOTE: Under `node --test` this file resolves `@aws-blocks/bb-kv-store`
	// and `@aws-blocks/bb-app-setting` to their mock entry points (neither
	// emits CloudFormation), so we can't assert on the nested DynamoDB table or
	// the SSM SecureString CustomResource here. The nested-resource contract is
	// validated end-to-end in the sandbox e2e (Phase K).

	test('Lambda handler gets config via S3 config registry (BLOCKS_CONFIG_BUCKET + BLOCKS_CONFIG_KEY)', () => {
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth');
		});
		// Config entries (USER_POOL_ID, CLIENT_ID, REGION) are now stored in the S3
		// config registry rather than as direct Lambda env vars. Verify the registry
		// creates the S3 config deployment infrastructure.
		const customResources = template.findResources('Custom::CDKBucketDeployment');
		const crKeys = Object.keys(customResources);
		assert.ok(crKeys.length >= 1, 'Should have a BucketDeployment for config');
	});
});

// ─── createApi sentinel contract ────────────────────────────────────────────

describe('AuthCognito (CDK) — createApi sentinel', () => {
	test('createApi() returns a function tagged with Symbol.for("blocks:ApiNamespace") = "auth"', () => {
		let result: any;
		synth((stack) => {
			const auth = new AuthCognito(scope(stack), 'auth');
			result = auth.createApi();
		});
		assert.strictEqual(typeof result, 'function');
		assert.strictEqual(result[Symbol.for('blocks:ApiNamespace')], 'auth');
	});
});

// ─── AuthFlowType guard ─────────────────────────────────────────────────────

describe('AuthCognito (CDK) — authFlowType guard', () => {
	test('USER_PASSWORD_AUTH synths cleanly', () => {
		assert.doesNotThrow(() =>
			synth((stack) => {
				new AuthCognito(scope(stack), 'auth', { authFlowType: 'USER_PASSWORD_AUTH' });
			}),
		);
	});

	test('USER_SRP_AUTH throws at synth time', () => {
		assert.throws(
			() =>
				synth((stack) => {
					new AuthCognito(scope(stack), 'auth', { authFlowType: 'USER_SRP_AUTH' });
				}),
			/USER_SRP_AUTH.*not yet supported/,
		);
	});
});

describe('AuthCognito (CDK) — signInWith', () => {
	test('default emits AliasAttributes:[email] (username + email alias)', () => {
		// Backward-compat lock: customers who never set `signInWith` keep
		// the historical pool shape. Cognito emits AliasAttributes when
		// both username and email are set in signInAliases — username is
		// primary, email is the secondary alias.
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth');
		});
		template.hasResourceProperties('AWS::Cognito::UserPool', {
			AliasAttributes: ['email'],
			AutoVerifiedAttributes: ['email'],
		});
	});

	test("'email' alone emits UsernameAttributes:[email] (email-as-username)", () => {
		// The Deploy2AWS request: email-as-username. Cognito emits
		// UsernameAttributes (not AliasAttributes) when only email is
		// set. SignUp accepts an email value in the username field
		// without throwing the "Username cannot be of email format" error.
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth', { signInWith: 'email' });
		});
		template.hasResourceProperties('AWS::Cognito::UserPool', {
			UsernameAttributes: ['email'],
			AutoVerifiedAttributes: ['email'],
		});
	});

	test("'phone' alone emits UsernameAttributes:[phone_number]", () => {
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth', { signInWith: 'phone' });
		});
		template.hasResourceProperties('AWS::Cognito::UserPool', {
			UsernameAttributes: ['phone_number'],
			AutoVerifiedAttributes: ['phone_number'],
		});
	});

	test("'username' alone has no contact attribute auto-verified", () => {
		// Username-only pool. Customer can still verify email/phone
		// post-signup via updateUserAttributes + confirmUserAttribute.
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth', { signInWith: 'username' });
		});
		// CDK serializes an empty `autoVerify` map as `[]` (not omitted).
		// Either form is semantically "no auto-verification"; assert
		// emptiness rather than absence.
		const pool = Object.values(template.findResources('AWS::Cognito::UserPool'))[0] as { Properties: Record<string, unknown> };
		const autoVerify = pool.Properties.AutoVerifiedAttributes;
		assert.ok(
			autoVerify === undefined || (Array.isArray(autoVerify) && autoVerify.length === 0),
			`username-only pool must not auto-verify any attribute, got: ${JSON.stringify(autoVerify)}`,
		);
		assert.strictEqual(pool.Properties.UsernameAttributes, undefined);
		assert.strictEqual(pool.Properties.AliasAttributes, undefined);
	});

	test("['email', 'phone'] emits both as alias attributes", () => {
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth', { signInWith: ['email', 'phone'] });
		});
		template.hasResourceProperties('AWS::Cognito::UserPool', {
			UsernameAttributes: ['email', 'phone_number'],
			AutoVerifiedAttributes: ['email', 'phone_number'],
		});
	});

	test("['username', 'email', 'phone'] emits both contact aliases auto-verified", () => {
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth', { signInWith: ['username', 'email', 'phone'] });
		});
		template.hasResourceProperties('AWS::Cognito::UserPool', {
			AliasAttributes: ['email', 'phone_number'],
			AutoVerifiedAttributes: ['email', 'phone_number'],
		});
	});

	test("explicit ['username', 'email'] matches the default", () => {
		// Spelling out the default explicitly should produce identical
		// synthesis — guards against drift between the implicit fallback
		// and what callers write to be safe.
		const a = synth((stack) => { new AuthCognito(scope(stack), 'auth'); });
		const b = synth((stack) => {
			new AuthCognito(scope(stack), 'auth', { signInWith: ['username', 'email'] });
		});
		const aPool = Object.values(a.findResources('AWS::Cognito::UserPool'))[0];
		const bPool = Object.values(b.findResources('AWS::Cognito::UserPool'))[0];
		assert.deepStrictEqual(
			(aPool as { Properties: { AliasAttributes?: string[]; AutoVerifiedAttributes?: string[] } }).Properties.AliasAttributes,
			(bPool as { Properties: { AliasAttributes?: string[]; AutoVerifiedAttributes?: string[] } }).Properties.AliasAttributes,
		);
		assert.deepStrictEqual(
			(aPool as { Properties: { AliasAttributes?: string[]; AutoVerifiedAttributes?: string[] } }).Properties.AutoVerifiedAttributes,
			(bPool as { Properties: { AliasAttributes?: string[]; AutoVerifiedAttributes?: string[] } }).Properties.AutoVerifiedAttributes,
		);
	});

	test('empty array throws at synth time', () => {
		// Runtime-only validation. The option type accepts an empty array
		// as a structurally-valid `SignInWith[]`; pass it through `as any`
		// to skip the no-op TS check and exercise the synth-time guard.
		assert.throws(
			() =>
				synth((stack) => {
					new AuthCognito(scope(stack), 'auth', { signInWith: ([] as unknown) as 'email' });
				}),
			/at least one of/i,
		);
	});

	test('signInWith ignored when wrapping an existing pool', () => {
		// Bring-your-own pool: AuthCognito doesn't synthesize a pool, so
		// signInWith has no effect (the existing pool's aliases are
		// whatever the customer configured). This test locks the behavior
		// so a future "merge signInWith with existing pool" patch is a
		// deliberate decision, not a silent bug.
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth', {
				signInWith: 'email',
				userPool: { __brand: 'ExternalUserPoolRef', userPoolId: 'us-east-1_imported' },
			});
		});
		template.resourceCountIs('AWS::Cognito::UserPool', 0);
	});
});

describe('AuthCognito (CDK) — featurePlan', () => {
	test('defaults to ESSENTIALS — pinned in CFN, not implicit', () => {
		// Cognito picks ESSENTIALS implicitly when `UserPoolTier` is
		// omitted, but applies the tier as a side effect on every
		// `UpdateUserPool` and resets `AllowAdminCreateUserOnly` back to
		// `true`. We always emit the field explicitly to stop the
		// reset cascade. This test guards against regressing back to the
		// implicit shape.
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth');
		});
		template.hasResourceProperties('AWS::Cognito::UserPool', {
			UserPoolTier: 'ESSENTIALS',
		});
	});

	test("'lite' emits UserPoolTier:LITE", () => {
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth', { featurePlan: 'lite' });
		});
		template.hasResourceProperties('AWS::Cognito::UserPool', {
			UserPoolTier: 'LITE',
		});
	});

	test("'plus' emits UserPoolTier:PLUS", () => {
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth', { featurePlan: 'plus' });
		});
		template.hasResourceProperties('AWS::Cognito::UserPool', {
			UserPoolTier: 'PLUS',
		});
	});

	test('AllowAdminCreateUserOnly stays false alongside an explicit tier', () => {
		// The whole point of pinning the tier — paired with
		// `selfSignUpEnabled` it must reach the live pool as
		// `AdminCreateUserConfig.AllowAdminCreateUserOnly: false` AND
		// stay there across deploys. CFN-template assertion (the deploy-
		// time drift only manifests at `UpdateUserPool` and isn't
		// observable from synth alone — the matching live-pool drift
		// guard lives in user-auth-integration.test.ts).
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth');
		});
		template.hasResourceProperties('AWS::Cognito::UserPool', {
			AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
			UserPoolTier: 'ESSENTIALS',
		});
	});
});

// ─── Passkeys (WebAuthn) ────────────────────────────────────────────────────

describe('AuthCognito (CDK) — enablePasskeys', () => {
	test('without USER_AUTH throws at synth time', () => {
		assert.throws(() => synth((stack) => {
			new AuthCognito(scope(stack), 'auth', {
				enablePasskeys: true,
				webAuthnRelyingParty: { id: 'example.com', origins: ['https://example.com'] },
			});
		}), /USER_AUTH/);
	});

	test('without webAuthnRelyingParty throws at synth time', () => {
		assert.throws(() => synth((stack) => {
			new AuthCognito(scope(stack), 'auth', {
				authFlowType: 'USER_AUTH',
				enablePasskeys: true,
			});
		}), /webAuthnRelyingParty/);
	});

	test('with empty origins throws at synth time', () => {
		assert.throws(() => synth((stack) => {
			new AuthCognito(scope(stack), 'auth', {
				authFlowType: 'USER_AUTH',
				enablePasskeys: true,
				webAuthnRelyingParty: { id: 'example.com', origins: [] },
			});
		}), /origins/);
	});

	test('lite tier rejected at synth time', () => {
		assert.throws(() => synth((stack) => {
			new AuthCognito(scope(stack), 'auth', {
				authFlowType: 'USER_AUTH',
				featurePlan: 'lite',
				enablePasskeys: true,
				webAuthnRelyingParty: { id: 'example.com', origins: ['https://example.com'] },
			});
		}), /featurePlan/);
	});

	test('writes WebAuthn relying-party + WEB_AUTHN first-factor on the pool', () => {
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth', {
				authFlowType: 'USER_AUTH',
				enablePasskeys: true,
				webAuthnRelyingParty: {
					id: 'example.com',
					origins: ['https://example.com'],
					userVerification: 'required',
				},
			});
		});
		// CFN top-level `WebAuthnRelyingPartyId` + `WebAuthnUserVerification`,
		// not nested under a `WebAuthnConfiguration` envelope. CDK's
		// `passkeyRelyingPartyId` L2 maps to this shape — same as
		// `@aws-amplify/auth-construct` uses. Cognito rejects the nested
		// envelope on `CreateUserPool` (verified empirically against the
		// IdP API).
		template.hasResourceProperties('AWS::Cognito::UserPool', {
			Policies: {
				SignInPolicy: {
					AllowedFirstAuthFactors: ['PASSWORD', 'WEB_AUTHN'],
				},
			},
			// CFN's resource type uses `WebAuthnRelyingPartyID` (capital ID,
			// per the CloudFormation spec), not `…PartyId`. Cognito rejects
			// the lower-case form silently — the L2 generates the right
			// shape, this assertion locks the contract.
			WebAuthnRelyingPartyID: 'example.com',
			WebAuthnUserVerification: 'required',
		});
	});

	test('userVerification defaults to "preferred"', () => {
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth', {
				authFlowType: 'USER_AUTH',
				enablePasskeys: true,
				webAuthnRelyingParty: { id: 'example.com', origins: ['https://example.com'] },
			});
		});
		template.hasResourceProperties('AWS::Cognito::UserPool', {
			WebAuthnUserVerification: 'preferred',
		});
	});

	test('Lambda role gets the four WebAuthn IAM actions', () => {
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth');
		});
		// Walk the IAM::Policy resources and find the statement that
		// grants the cognito-idp:* surface — assert all four passkey
		// actions are present alongside the existing ones.
		const policies = template.findResources('AWS::IAM::Policy');
		const statements = Object.values(policies).flatMap(
			(p) => ((p as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } })
				.Properties?.PolicyDocument?.Statement ?? []) as { Action?: unknown }[],
		);
		const flat = new Set<string>();
		for (const s of statements) {
			const actions = Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : [];
			for (const a of actions) if (typeof a === 'string') flat.add(a);
		}
		for (const a of [
			'cognito-idp:StartWebAuthnRegistration',
			'cognito-idp:CompleteWebAuthnRegistration',
			'cognito-idp:ListWebAuthnCredentials',
			'cognito-idp:DeleteWebAuthnCredential',
		]) {
			assert.ok(flat.has(a), `missing IAM action ${a}`);
		}
	});
});

// ─── Admin surface IAM grant (opt-in) ─────────────────────────────────────────

/** Collect every cognito-idp IAM action granted to any role in the template. */
function grantedActions(template: Template): Set<string> {
	const policies = template.findResources('AWS::IAM::Policy');
	const statements = Object.values(policies).flatMap(
		(p) => ((p as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } })
			.Properties?.PolicyDocument?.Statement ?? []) as { Action?: unknown }[],
	);
	const flat = new Set<string>();
	for (const s of statements) {
		const actions = Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : [];
		for (const a of actions) if (typeof a === 'string') flat.add(a);
	}
	return flat;
}

const GROUP_ADMIN_ACTIONS = [
	'cognito-idp:AdminAddUserToGroup',
	'cognito-idp:AdminRemoveUserFromGroup',
	'cognito-idp:AdminListGroupsForUser',
	'cognito-idp:ListUsersInGroup',
];
const LIFECYCLE_ADMIN_ACTIONS = [
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

describe('AuthCognito (CDK) — admin IAM grant', () => {
	test('no admin option → NO Admin* actions granted (least privilege)', () => {
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth', { groups: ['admins'] });
		});
		const actions = grantedActions(template);
		for (const a of [...GROUP_ADMIN_ACTIONS, ...LIFECYCLE_ADMIN_ACTIONS]) {
			assert.ok(!actions.has(a), `unexpected admin action granted without opt-in: ${a}`);
		}
	});

	test("admin: {} (no actions) → grants both group + lifecycle actions", () => {
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth', { groups: ['admins'], admin: {} });
		});
		const actions = grantedActions(template);
		for (const a of [...GROUP_ADMIN_ACTIONS, ...LIFECYCLE_ADMIN_ACTIONS]) {
			assert.ok(actions.has(a), `missing admin action ${a}`);
		}
	});

	test("actions: ['groups'] → grants group actions only", () => {
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth', { groups: ['admins'], admin: { actions: ['groups'] } });
		});
		const actions = grantedActions(template);
		for (const a of GROUP_ADMIN_ACTIONS) assert.ok(actions.has(a), `missing group action ${a}`);
		for (const a of LIFECYCLE_ADMIN_ACTIONS) assert.ok(!actions.has(a), `unexpected lifecycle action ${a}`);
	});

	test("actions: ['lifecycle'] → grants lifecycle actions only", () => {
		const template = synth((stack) => {
			new AuthCognito(scope(stack), 'auth', { groups: ['admins'], admin: { actions: ['lifecycle'] } });
		});
		const actions = grantedActions(template);
		for (const a of LIFECYCLE_ADMIN_ACTIONS) assert.ok(actions.has(a), `missing lifecycle action ${a}`);
		for (const a of GROUP_ADMIN_ACTIONS) assert.ok(!actions.has(a), `unexpected group action ${a}`);
	});
});
