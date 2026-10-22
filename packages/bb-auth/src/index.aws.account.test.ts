// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS runtime — the signed-in user's account (D5c2): attributes, `deleteUser`,
 * TOTP setup, MFA preferences, devices and the passkey description fields,
 * against a spied Cognito client (no network). Each test pins the exact SDK
 * command + input the engine sends and what the caller sees, including the
 * error contract: a deleted user's token signs the session out (401), every
 * other service error is mapped (no `$metadata`, no ARN, non-enumerable
 * `cause`). Harness: `test-support/aws-harness.ts`.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ApiError } from '@aws-blocks/core';
import { ACCESS_DENIED_MESSAGE, clientMessageFor } from './error-mapping.js';
import { AuthErrors } from './index.aws.js';
import { Browser, captureLogger, cognitoError, makeAwsAuth, signInAs, wireView } from './test-support/aws-harness.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

async function rejection(p: Promise<unknown>): Promise<unknown> {
	return p.then(
		() => assert.fail('expected rejection'),
		(e: unknown) => e,
	);
}

/** No SDK metadata, no enumerable `cause`, nothing AWS-identifying in what serializes. */
function assertWireClean(e: unknown): void {
	assert.ok(e instanceof ApiError, `an ApiError, got ${String(e)}`);
	assert.ok(!Object.keys(e).includes('cause'), 'cause is not enumerable');
	const json = JSON.stringify(e);
	for (const leak of ['$metadata', 'requestId', '$fault', 'cause']) assert.ok(!json.includes(leak), leak);
	assert.doesNotMatch(json, /arn:aws/);
	assert.doesNotMatch(json, /(?<!\d)\d{12}(?!\d)/);
}

const MFA = { mfa: { mode: 'optional', types: ['SMS', 'TOTP'] } } as const;

describe('AWS account — attributes', () => {
	test('confirmUserAttribute sends VerifyUserAttribute with the prefixed name and the code', async () => {
		const h = makeAwsAuth({ users: { attributes: [{ name: 'backup' }] } });
		const b = new Browser();
		const tokens = h.idp.authResult('alice');
		await signInAs(h, b, 'alice', tokens);
		h.on('VerifyUserAttributeCommand', () => ({}));
		await b.request((ctx) => h.auth.confirmUserAttribute(ctx, 'email', '123456'));
		await b.request((ctx) => h.auth.confirmUserAttribute(ctx, 'backup', '654321'));
		assert.deepStrictEqual(h.sent, [
			{
				name: 'VerifyUserAttributeCommand',
				input: { AccessToken: tokens.AccessToken, AttributeName: 'email', Code: '123456' },
			},
			{
				name: 'VerifyUserAttributeCommand',
				input: { AccessToken: tokens.AccessToken, AttributeName: 'custom:backup', Code: '654321' },
			},
		]);
	});

	test('confirmUserAttribute: a wrong code is CodeMismatch 400, retriable; the session survives', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		const sid = await signInAs(h, b, 'alice');
		h.on('VerifyUserAttributeCommand', () => {
			throw cognitoError('CodeMismatchException', 'Invalid verification code provided, please try again.');
		});
		const e = await rejection(b.request((ctx) => h.auth.confirmUserAttribute(ctx, 'email', '000000')));
		assert.deepStrictEqual(wireView(e), {
			code: 400,
			message: 'Invalid verification code provided, please try again.',
			name: AuthErrors.CodeMismatch,
			retriable: true,
		});
		assertWireClean(e);
		assert.ok(await h.lookupSession(sid), 'not signed out');
	});

	test('sendUserAttributeVerificationCode sends GetUserAttributeVerificationCode', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		const tokens = h.idp.authResult('alice');
		await signInAs(h, b, 'alice', tokens);
		h.on('GetUserAttributeVerificationCodeCommand', () => ({
			CodeDeliveryDetails: { Destination: 'a***@e***', DeliveryMedium: 'EMAIL', AttributeName: 'email' },
		}));
		await b.request((ctx) => h.auth.sendUserAttributeVerificationCode(ctx, 'email'));
		assert.deepStrictEqual(h.sent, [
			{
				name: 'GetUserAttributeVerificationCodeCommand',
				input: { AccessToken: tokens.AccessToken, AttributeName: 'email' },
			},
		]);
	});

	test('the token’s user no longer exists → signed out: row deleted, cookie cleared, 401 NotAuthenticated', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		const sid = await signInAs(h, b, 'alice');
		h.on('GetUserCommand', () => {
			throw cognitoError('UserNotFoundException', 'User does not exist.');
		});
		const e = await rejection(b.request((ctx) => h.auth.getUserAttributes(ctx)));
		assert.strictEqual(wireView(e).name, AuthErrors.NotAuthenticated);
		assert.strictEqual(wireView(e).code, 401);
		assertWireClean(e);
		assert.strictEqual(await h.lookupSession(sid), null);
		assert.strictEqual(b.jar.get(h.cookieName), undefined, 'cookie cleared');
	});

	test('a revoked access token passes through as 401 NotAuthorized (the session row stays for refresh)', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		await signInAs(h, b, 'alice');
		h.on('UpdateUserAttributesCommand', () => {
			throw cognitoError('NotAuthorizedException', 'Access Token has been revoked');
		});
		const e = await rejection(b.request((ctx) => h.auth.updateUserAttributes(ctx, { name: 'Alice' })));
		assert.deepStrictEqual(wireView(e), {
			code: 401,
			// FX59 (#678): the name's fixed message; Cognito's text is logged server-side.
			message: clientMessageFor(AuthErrors.NotAuthorized),
			name: AuthErrors.NotAuthorized,
			retriable: false,
		});
		assertWireClean(e);
	});

	test('an IAM denial on an account call is the generic message, never the role ARN', async () => {
		const h = makeAwsAuth({ logger: captureLogger().logger });
		const b = new Browser();
		await signInAs(h, b, 'alice');
		h.on('GetUserCommand', () => {
			throw cognitoError(
				'AccessDeniedException',
				'User: arn:aws:sts::123456789012:assumed-role/app/fn is not authorized to perform: cognito-idp:GetUser',
			);
		});
		const e = await rejection(b.request((ctx) => h.auth.getUserAttributes(ctx)));
		assert.strictEqual(wireView(e).message, ACCESS_DENIED_MESSAGE);
		assertWireClean(e);
	});
});

describe('AWS account — deleteUser', () => {
	test('sends DeleteUser with the access token, then deletes the session row and clears the cookie', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		const tokens = h.idp.authResult('alice');
		const sid = await signInAs(h, b, 'alice', tokens);
		h.on('DeleteUserCommand', () => ({}));
		await b.request((ctx) => h.auth.deleteUser(ctx));
		assert.deepStrictEqual(h.sent, [{ name: 'DeleteUserCommand', input: { AccessToken: tokens.AccessToken } }]);
		assert.strictEqual(await h.lookupSession(sid), null);
		assert.strictEqual(b.jar.get(h.cookieName), undefined);
	});

	test('a failed DeleteUser keeps the session (nothing was deleted)', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		const sid = await signInAs(h, b, 'alice');
		h.on('DeleteUserCommand', () => {
			throw cognitoError('TooManyRequestsException', 'Rate exceeded');
		});
		const e = await rejection(b.request((ctx) => h.auth.deleteUser(ctx)));
		assert.strictEqual(wireView(e).code, 429);
		assert.ok(await h.lookupSession(sid));
		assert.ok(b.jar.get(h.cookieName));
	});
});

describe('AWS account — TOTP setup', () => {
	test('setUpTotp sends AssociateSoftwareToken with the access token and returns the secret', async () => {
		const h = makeAwsAuth(MFA);
		const b = new Browser();
		const tokens = h.idp.authResult('alice');
		await signInAs(h, b, 'alice', tokens);
		h.on('AssociateSoftwareTokenCommand', () => ({ SecretCode: 'JBSWY3DPEHPK3PXP' }));
		const r = await b.request((ctx) => h.auth.setUpTotp(ctx));
		assert.deepStrictEqual(r, { sharedSecret: 'JBSWY3DPEHPK3PXP' });
		assert.deepStrictEqual(h.sent, [
			{ name: 'AssociateSoftwareTokenCommand', input: { AccessToken: tokens.AccessToken } },
		]);
	});

	test('verifyTotpSetup verifies, then enrols TOTP as preferred when nothing is preferred yet', async () => {
		const h = makeAwsAuth(MFA);
		const b = new Browser();
		const tokens = h.idp.authResult('alice');
		await signInAs(h, b, 'alice', tokens);
		h.on('VerifySoftwareTokenCommand', () => ({ Status: 'SUCCESS' }));
		h.on('GetUserCommand', () => ({ Username: 'alice', UserAttributes: [] }));
		h.on('SetUserMFAPreferenceCommand', () => ({}));
		await b.request((ctx) => h.auth.verifyTotpSetup(ctx, '123456'));
		assert.deepStrictEqual(h.sent, [
			{ name: 'VerifySoftwareTokenCommand', input: { AccessToken: tokens.AccessToken, UserCode: '123456' } },
			{ name: 'GetUserCommand', input: { AccessToken: tokens.AccessToken } },
			{
				name: 'SetUserMFAPreferenceCommand',
				input: {
					AccessToken: tokens.AccessToken,
					SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
				},
			},
		]);
	});

	test('verifyTotpSetup keeps an existing preferred factor (TOTP enabled, not preferred)', async () => {
		const h = makeAwsAuth(MFA);
		const b = new Browser();
		await signInAs(h, b, 'alice');
		h.on('VerifySoftwareTokenCommand', () => ({ Status: 'SUCCESS' }));
		h.on('GetUserCommand', () => ({
			Username: 'alice',
			PreferredMfaSetting: 'SMS_MFA',
			UserMFASettingList: ['SMS_MFA'],
		}));
		h.on('SetUserMFAPreferenceCommand', () => ({}));
		await b.request((ctx) => h.auth.verifyTotpSetup(ctx, '123456'));
		assert.deepStrictEqual(h.sent[2].input.SoftwareTokenMfaSettings, { Enabled: true, PreferredMfa: false });
	});

	test("verifyTotpSetup: a Status 'ERROR' answer is EnableSoftwareTokenMFA 400, retriable, and enrols nothing", async () => {
		const h = makeAwsAuth(MFA);
		const b = new Browser();
		await signInAs(h, b, 'alice');
		h.on('VerifySoftwareTokenCommand', () => ({ Status: 'ERROR' }));
		const e = await rejection(b.request((ctx) => h.auth.verifyTotpSetup(ctx, '123456')));
		assert.strictEqual(wireView(e).name, AuthErrors.EnableSoftwareTokenMFA);
		assert.strictEqual(wireView(e).code, 400);
		assert.strictEqual(wireView(e).retriable, true);
		assertWireClean(e);
		assert.deepStrictEqual(h.sentNames(), ['VerifySoftwareTokenCommand']);
	});

	test('verifyTotpSetup: Cognito’s own rejections pass through mapped', async () => {
		for (const [name, status, retriable] of [
			['EnableSoftwareTokenMFAException', 400, true],
			['CodeMismatchException', 400, true],
			['SoftwareTokenMFANotFoundException', 400, false],
		] as const) {
			const h = makeAwsAuth(MFA);
			const b = new Browser();
			await signInAs(h, b, 'alice');
			h.on('VerifySoftwareTokenCommand', () => {
				throw cognitoError(name, `msg for ${name}`);
			});
			const e = await rejection(b.request((ctx) => h.auth.verifyTotpSetup(ctx, '123456')));
			// FX59 (#678): the name's fixed message; Cognito's text is logged server-side.
			assert.deepStrictEqual(wireView(e), { code: status, message: clientMessageFor(name), name, retriable });
			assertWireClean(e);
		}
	});
});

describe('AWS account — MFA preference', () => {
	test('updateMfaPreference maps each setting to Cognito’s *MfaSettings; omitted factors are left out', async () => {
		const h = makeAwsAuth({ mfa: { mode: 'optional', types: ['SMS', 'TOTP', 'EMAIL'] } });
		const b = new Browser();
		const tokens = h.idp.authResult('alice');
		await signInAs(h, b, 'alice', tokens);
		h.on('SetUserMFAPreferenceCommand', () => ({}));
		await b.request((ctx) => h.auth.updateMfaPreference(ctx, { totp: 'PREFERRED', sms: 'DISABLED' }));
		await b.request((ctx) => h.auth.updateMfaPreference(ctx, { email: 'ENABLED' }));
		await b.request((ctx) => h.auth.updateMfaPreference(ctx, { sms: 'NOT_PREFERRED' }));
		assert.deepStrictEqual(
			h.sent.map((c) => c.input),
			[
				{
					AccessToken: tokens.AccessToken,
					SMSMfaSettings: { Enabled: false, PreferredMfa: false },
					SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
				},
				{ AccessToken: tokens.AccessToken, EmailMfaSettings: { Enabled: true, PreferredMfa: false } },
				{ AccessToken: tokens.AccessToken, SMSMfaSettings: { Enabled: true, PreferredMfa: false } },
			],
		);
	});

	test('updateMfaPreference: enabling an unverified TOTP → SoftwareTokenMFANotFound 400', async () => {
		const h = makeAwsAuth(MFA);
		const b = new Browser();
		await signInAs(h, b, 'alice');
		h.on('SetUserMFAPreferenceCommand', () => {
			throw cognitoError('SoftwareTokenMFANotFoundException', 'Software Token MFA has not been enabled.');
		});
		const e = await rejection(b.request((ctx) => h.auth.updateMfaPreference(ctx, { totp: 'ENABLED' })));
		assert.strictEqual(wireView(e).name, AuthErrors.SoftwareTokenMFANotFound);
		assert.strictEqual(wireView(e).code, 400);
	});

	test('getMfaPreference reads GetUser’s MFA lists and narrows them to mfa.types', async () => {
		const h = makeAwsAuth(MFA);
		const b = new Browser();
		const tokens = h.idp.authResult('alice');
		await signInAs(h, b, 'alice', tokens);
		h.on('GetUserCommand', () => ({
			Username: 'alice',
			UserMFASettingList: ['SMS_MFA', 'SOFTWARE_TOKEN_MFA', 'EMAIL_OTP'],
			PreferredMfaSetting: 'SOFTWARE_TOKEN_MFA',
		}));
		const pref = await b.request((ctx) => h.auth.getMfaPreference(ctx));
		// EMAIL is not in this instance's `mfa.types`, so it is narrowed out.
		assert.deepStrictEqual(pref, { enabled: ['SMS', 'TOTP'], preferred: 'TOTP' });
		assert.deepStrictEqual(h.sent, [{ name: 'GetUserCommand', input: { AccessToken: tokens.AccessToken } }]);
	});

	test('getMfaPreference: no MFA settings → nothing enabled, no preferred factor', async () => {
		const h = makeAwsAuth(MFA);
		const b = new Browser();
		await signInAs(h, b, 'alice');
		h.on('GetUserCommand', () => ({ Username: 'alice', UserAttributes: [] }));
		assert.deepStrictEqual(await b.request((ctx) => h.auth.getMfaPreference(ctx)), { enabled: [] });
	});
});

describe('AWS account — devices', () => {
	test('scanDevices pages ListDevices (Limit 60, PaginationToken) and maps dates to ISO strings', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		const tokens = h.idp.authResult('alice');
		await signInAs(h, b, 'alice', tokens);
		const created = new Date('2026-01-02T03:04:05.000Z');
		h.on('ListDevicesCommand', (input) =>
			input.PaginationToken
				? { Devices: [{ DeviceKey: 'dev-2', DeviceAttributes: [] }] }
				: {
						Devices: [
							{
								DeviceKey: 'dev-1',
								DeviceAttributes: [{ Name: 'device_name', Value: 'Laptop' }, { Name: 'no_value' }],
								DeviceCreateDate: created,
								DeviceLastModifiedDate: created,
								DeviceLastAuthenticatedDate: created,
							},
						],
						PaginationToken: 'page-2',
					},
		);
		const devices = await b.request((ctx) => Array.fromAsync(h.auth.scanDevices(ctx)));
		assert.deepStrictEqual(devices, [
			{
				deviceKey: 'dev-1',
				attributes: { device_name: 'Laptop' },
				createDate: created.toISOString(),
				lastModifiedDate: created.toISOString(),
				lastAuthenticatedDate: created.toISOString(),
			},
			{ deviceKey: 'dev-2', attributes: {} },
		]);
		assert.deepStrictEqual(
			h.sent.map((c) => c.input),
			[
				{ AccessToken: tokens.AccessToken, Limit: 60 },
				{ AccessToken: tokens.AccessToken, Limit: 60, PaginationToken: 'page-2' },
			],
		);
	});

	test('forgetDevice sends ForgetDevice with the access token and the device key', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		const tokens = h.idp.authResult('alice');
		await signInAs(h, b, 'alice', tokens);
		h.on('ForgetDeviceCommand', () => ({}));
		await b.request((ctx) => h.auth.forgetDevice(ctx, 'dev-1'));
		assert.deepStrictEqual(h.sent, [
			{ name: 'ForgetDeviceCommand', input: { AccessToken: tokens.AccessToken, DeviceKey: 'dev-1' } },
		]);
	});

	test('rememberDevice is a 501 explaining why (L25), before any Cognito call', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		await signInAs(h, b, 'alice');
		const e = await rejection(b.request((ctx) => h.auth.rememberDevice(ctx)));
		assert.strictEqual(wireView(e).code, 501);
		assert.strictEqual(wireView(e).name, AuthErrors.InvalidParameter);
		assert.match(String(wireView(e).message), /NewDeviceMetadata.*ConfirmDevice/);
		assertWireClean(e);
		assert.deepStrictEqual(h.sent, []);
	});
});

describe('AWS account — passkey description fields (L22)', () => {
	const PASSKEYS = {
		users: { authFlow: 'USER_AUTH' },
		passkeys: { relyingPartyId: 'example.com', origins: ['https://example.com'] },
	} as const;

	test('listPasskeys carries transports and authenticatorAttachment from ListWebAuthnCredentials', async () => {
		const h = makeAwsAuth(PASSKEYS);
		const b = new Browser();
		await signInAs(h, b, 'alice');
		const created = new Date('2026-03-04T05:06:07.000Z');
		h.on('ListWebAuthnCredentialsCommand', () => ({
			Credentials: [
				{
					CredentialId: 'cred-1',
					FriendlyCredentialName: 'iPhone',
					RelyingPartyId: 'example.com',
					AuthenticatorTransports: ['internal', 'hybrid'],
					AuthenticatorAttachment: 'platform',
					CreatedAt: created,
				},
				{
					CredentialId: 'cred-2',
					RelyingPartyId: 'example.com',
					AuthenticatorTransports: [],
					CreatedAt: created,
				},
			],
		}));
		const list = await b.request((ctx) => h.auth.listPasskeys(ctx));
		assert.deepStrictEqual(list, [
			{
				credentialId: 'cred-1',
				friendlyName: 'iPhone',
				createdAt: created.toISOString(),
				transports: ['internal', 'hybrid'],
				authenticatorAttachment: 'platform',
			},
			{ credentialId: 'cred-2', createdAt: created.toISOString() },
		]);
	});
});
