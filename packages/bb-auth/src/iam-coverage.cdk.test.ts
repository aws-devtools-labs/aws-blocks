// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * IAM coverage (D5c2): every Cognito command the AWS engine sends is granted by
 * the policy the CDK layer synthesizes for that configuration — and the admin
 * grant stays scoped by `admin.actions`.
 *
 * The commands are **observed**, not listed by hand: each public method is
 * driven through the real AWS entry (`test-support/aws-harness.ts`, spied SDK
 * client, no network) and the sent command names are mapped to
 * `cognito-idp:<Action>`. The policy is a real synth under `--conditions=cdk`
 * (`test-support/identity.ts`). A new engine call without a grant fails here,
 * before it fails in production with `AccessDeniedException`.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { Browser, makeAwsAuth, signInAs } from './test-support/aws-harness.js';
import type { CfnTemplateJson } from './test-support/cdk-synth.js';
import { synthIdentity } from './test-support/identity.js';
import type { AuthOptions } from './types.js';

before(() => rmSync('.bb-data', { recursive: true, force: true }));
after(() => rmSync('.bb-data', { recursive: true, force: true }));

/** A plausible answer for every command the engine may send. */
const REPLIES: Record<string, () => unknown> = {
	GetUserCommand: () => ({ Username: 'alice', UserAttributes: [] }),
	UpdateUserAttributesCommand: () => ({}),
	VerifyUserAttributeCommand: () => ({}),
	GetUserAttributeVerificationCodeCommand: () => ({}),
	DeleteUserCommand: () => ({}),
	AssociateSoftwareTokenCommand: () => ({ SecretCode: 'SECRET' }),
	VerifySoftwareTokenCommand: () => ({ Status: 'SUCCESS' }),
	SetUserMFAPreferenceCommand: () => ({}),
	ListDevicesCommand: () => ({ Devices: [] }),
	ForgetDeviceCommand: () => ({}),
	ChangePasswordCommand: () => ({}),
	GlobalSignOutCommand: () => ({}),
	StartWebAuthnRegistrationCommand: () => ({ CredentialCreationOptions: {} }),
	CompleteWebAuthnRegistrationCommand: () => ({}),
	ListWebAuthnCredentialsCommand: () => ({ Credentials: [] }),
	DeleteWebAuthnCredentialCommand: () => ({}),
	AdminAddUserToGroupCommand: () => ({}),
	AdminRemoveUserFromGroupCommand: () => ({}),
	AdminListGroupsForUserCommand: () => ({ Groups: [] }),
	ListUsersInGroupCommand: () => ({ Users: [] }),
	AdminCreateUserCommand: () => ({ User: { Username: 'bob', Attributes: [] } }),
	AdminDeleteUserCommand: () => ({}),
	AdminDisableUserCommand: () => ({}),
	AdminEnableUserCommand: () => ({}),
	AdminResetUserPasswordCommand: () => ({}),
	AdminSetUserPasswordCommand: () => ({}),
	AdminGetUserCommand: () => ({ Username: 'bob', UserAttributes: [] }),
	ListUsersCommand: () => ({ Users: [] }),
	AdminUserGlobalSignOutCommand: () => ({}),
};

const OPTIONS = {
	users: { groups: ['admins'], authFlow: 'USER_AUTH' },
	mfa: { mode: 'optional', types: ['SMS', 'TOTP'] },
	passkeys: { relyingPartyId: 'example.com', origins: ['https://example.com'] },
	admin: {},
} as const satisfies AuthOptions;

/** Drive `run` against the AWS entry and return the `cognito-idp:` actions it sent. */
async function observedActions(
	run: (h: ReturnType<typeof makeAwsAuth<typeof OPTIONS>>, b: Browser) => Promise<unknown>,
): Promise<string[]> {
	const h = makeAwsAuth(OPTIONS);
	const b = new Browser();
	await signInAs(h, b, 'alice');
	for (const [name, reply] of Object.entries(REPLIES)) h.on(name, reply);
	await run(h, b);
	return [...new Set(h.sentNames().map((n) => `cognito-idp:${n.replace(/Command$/, '')}`))].sort();
}

/** Every `cognito-idp:` action the synthesized policies grant. */
function grantedActions(template: CfnTemplateJson): Set<string> {
	const out = new Set<string>();
	for (const r of Object.values(template.Resources)) {
		if (r.Type !== 'AWS::IAM::Policy') continue;
		const doc = r.Properties?.PolicyDocument as { Statement: { Action: string | string[] }[] };
		for (const s of doc.Statement) for (const a of [s.Action].flat()) if (a.startsWith('cognito-idp:')) out.add(a);
	}
	return out;
}

const synthCache: Record<string, Set<string>> = {};
function granted(construct: string): Set<string> {
	synthCache[construct] ??= grantedActions(synthIdentity(construct).template);
	return synthCache[construct];
}

const BASE = "new Auth(stack, 'auth', { users: { groups: ['admins'], authFlow: 'USER_AUTH' } })";
const GROUPS =
	"new Auth(stack, 'auth', { users: { groups: ['admins'], authFlow: 'USER_AUTH' }, admin: { actions: ['groups'] } })";
const LIFECYCLE =
	"new Auth(stack, 'auth', { users: { groups: ['admins'], authFlow: 'USER_AUTH' }, admin: { actions: ['lifecycle'] } })";

function assertCovered(sent: string[], grants: Set<string>, what: string): void {
	assert.ok(sent.length > 0, `${what}: drove at least one command`);
	const missing = sent.filter((a) => !grants.has(a));
	assert.deepStrictEqual(missing, [], `${what}: sent but not granted`);
}

describe('IAM coverage — the account surface needs only the base statement', () => {
	test('attributes, deleteUser, TOTP, MFA preference, devices and passkeys are all granted without admin', async () => {
		const sent = await observedActions(async (h, b) => {
			await b.request((c) => h.auth.getUserAttributes(c));
			await b.request((c) => h.auth.updateUserAttributes(c, { name: 'Alice' }));
			await b.request((c) => h.auth.confirmUserAttribute(c, 'email', '123456'));
			await b.request((c) => h.auth.sendUserAttributeVerificationCode(c, 'email'));
			await b.request((c) => h.auth.setUpTotp(c));
			await b.request((c) => h.auth.verifyTotpSetup(c, '123456'));
			await b.request((c) => h.auth.updateMfaPreference(c, { totp: 'PREFERRED' }));
			await b.request((c) => h.auth.getMfaPreference(c));
			await b.request((c) => Array.fromAsync(h.auth.scanDevices(c)));
			await b.request((c) => h.auth.forgetDevice(c, 'dev-1'));
			await b.request((c) => h.auth.listPasskeys(c));
			await b.request((c) => h.auth.deletePasskey(c, 'cred-1'));
			await b.request((c) => h.auth.deleteUser(c));
		});
		assert.deepStrictEqual(sent, [
			'cognito-idp:AssociateSoftwareToken',
			'cognito-idp:DeleteUser',
			'cognito-idp:DeleteWebAuthnCredential',
			'cognito-idp:ForgetDevice',
			'cognito-idp:GetUser',
			'cognito-idp:GetUserAttributeVerificationCode',
			'cognito-idp:ListDevices',
			'cognito-idp:ListWebAuthnCredentials',
			'cognito-idp:SetUserMFAPreference',
			'cognito-idp:UpdateUserAttributes',
			'cognito-idp:VerifySoftwareToken',
			'cognito-idp:VerifyUserAttribute',
		]);
		assertCovered(sent, granted(BASE), 'account surface');
	});
});

describe("IAM coverage — admin: { actions: ['groups'] }", () => {
	test('every groups method is granted', async () => {
		const sent = await observedActions(async (h) => {
			await h.auth.admin.addUserToGroup('bob', 'admins');
			await h.auth.admin.removeUserFromGroup('bob', 'admins');
			await h.auth.admin.listGroupsForUser('bob');
			await h.auth.admin.listUsersInGroup('admins');
		});
		assertCovered(sent, granted(GROUPS), 'admin groups');
	});

	test('no lifecycle-only action is granted', () => {
		const grants = granted(GROUPS);
		for (const a of ['AdminCreateUser', 'AdminDeleteUser', 'AdminGetUser', 'ListUsers', 'AdminUserGlobalSignOut']) {
			assert.ok(!grants.has(`cognito-idp:${a}`), `${a} must not be granted`);
		}
	});
});

describe("IAM coverage — admin: { actions: ['lifecycle'] }", () => {
	test('every lifecycle method is granted (getUser’s group read included)', async () => {
		const sent = await observedActions(async (h) => {
			await h.auth.admin.createUser('bob', { temporaryPassword: 'Temp!1234', suppressInvite: true });
			await h.auth.admin.getUser('bob');
			await Array.fromAsync(h.auth.admin.scan({ attribute: 'email', match: 'startsWith', value: 'b' }));
			await h.auth.admin.disableUser('bob');
			await h.auth.admin.enableUser('bob');
			await h.auth.admin.resetUserPassword('bob');
			await h.auth.admin.setUserPassword('bob', 'Final!1234', { permanent: true });
			await h.auth.admin.revokeUserSessions('bob');
			await h.auth.admin.deleteUser('bob');
		});
		assert.ok(sent.includes('cognito-idp:AdminListGroupsForUser'), 'getUser reads groups');
		assertCovered(sent, granted(LIFECYCLE), 'admin lifecycle');
	});

	test('no groups-only mutation is granted', () => {
		const grants = granted(LIFECYCLE);
		for (const a of ['AdminAddUserToGroup', 'AdminRemoveUserFromGroup', 'ListUsersInGroup']) {
			assert.ok(!grants.has(`cognito-idp:${a}`), `${a} must not be granted`);
		}
	});
});

describe('IAM coverage — no admin option', () => {
	test('grants no Admin* mutation and no List* user enumeration', () => {
		const grants = granted(BASE);
		for (const a of grants) {
			if (a === 'cognito-idp:AdminListGroupsForUser') continue; // requireRole's live group read (#583)
			assert.ok(!/^cognito-idp:(Admin|ListUsers)/.test(a), `${a} must not be granted without admin`);
		}
	});
});
