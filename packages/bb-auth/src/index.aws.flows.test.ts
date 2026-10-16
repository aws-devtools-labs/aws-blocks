// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS runtime — the core flows B5 did not cover, against a spied Cognito
 * client (no network): every sign-in challenge the engine maps, the MFA-setup
 * and USER_AUTH multi-step ceremonies, passkey sign-in and management,
 * password reset / change command shapes, and the engine's construction
 * contract (lazy SDK client, identifiers registered in the constructor and
 * resolved at call time, the user-agent chain, no pool → no engine).
 * Harness: `test-support/aws-harness.ts`.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { AuthStateApi } from '@aws-blocks/auth-common';
import type { BlocksContext } from '@aws-blocks/core';
import { getSdkIdentifiers, registerSdkIdentifiers } from '@aws-blocks/core';
import { cognitoConfigKeys } from './cdk/contract.js';
import { INTERNAL_ERROR_MESSAGE } from './error-mapping.js';
import { Auth, AuthErrors, type SignInNextStep, type SignInResult } from './index.aws.js';
import {
	Browser,
	captureLogger,
	cognitoError,
	makeAwsAuth,
	signInAs,
	TEST_CLIENT_ID,
	TEST_POOL_ID,
	TEST_REGION,
	wireView,
} from './test-support/aws-harness.js';
import type { AuthOptions } from './types.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

function apiFor<O extends AuthOptions>(auth: Auth<O>, ctx: BlocksContext): AuthStateApi {
	return (auth.createApi() as unknown as (c: BlocksContext) => AuthStateApi)(ctx);
}

function nextStepOf(r: SignInResult): SignInNextStep {
	assert.strictEqual(r.status, 'continueSignIn');
	if (r.status !== 'continueSignIn') throw new Error('unreachable');
	return r.nextStep;
}

function sessionOf(step: SignInNextStep): string {
	assert.ok('session' in step, `${step.name} carries a session`);
	return 'session' in step ? step.session : '';
}

describe('AWS sign-in challenges → next steps → ChallengeResponses', () => {
	test('SMS_MFA → CONFIRM_SIGN_IN_WITH_SMS_CODE; the code is sent as SMS_MFA_CODE', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({
			ChallengeName: 'SMS_MFA',
			Session: 'cog-sms',
			ChallengeParameters: { CODE_DELIVERY_DESTINATION: '+*******0100' },
		}));
		const step = nextStepOf(await b.request((ctx) => h.auth.signIn('alice', 'pw', ctx)));
		assert.deepStrictEqual(
			{ ...step, session: '' },
			{
				name: 'CONFIRM_SIGN_IN_WITH_SMS_CODE',
				session: '',
				codeDeliveryDetails: {
					destination: '+*******0100',
					deliveryMedium: 'SMS',
					attributeName: 'phone_number',
				},
			},
		);
		h.on('RespondToAuthChallengeCommand', () => ({ AuthenticationResult: h.idp.authResult('alice') }));
		const r = await b.request((ctx) => h.auth.confirmSignIn(sessionOf(step), '424242', ctx));
		assert.strictEqual(r.status, 'signedIn');
		assert.deepStrictEqual(h.sent[1].input, {
			ClientId: TEST_CLIENT_ID,
			ChallengeName: 'SMS_MFA',
			Session: 'cog-sms',
			ChallengeResponses: { USERNAME: 'alice', SMS_MFA_CODE: '424242' },
		});
	});

	test('EMAIL_OTP is second-factor MFA under USER_PASSWORD_AUTH and a first factor under USER_AUTH', async () => {
		const reply = () => ({
			ChallengeName: 'EMAIL_OTP',
			Session: 'cog-email',
			ChallengeParameters: { CODE_DELIVERY_DESTINATION: 'a***@e***' },
		});
		const mfa = makeAwsAuth();
		mfa.on('InitiateAuthCommand', reply);
		const mfaStep = nextStepOf(await new Browser().request((ctx) => mfa.auth.signIn('alice', 'pw', ctx)));
		assert.strictEqual(mfaStep.name, 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE');

		const first = makeAwsAuth({ users: { authFlow: 'USER_AUTH' } });
		const b = new Browser();
		first.on('InitiateAuthCommand', reply);
		const step = nextStepOf(
			await b.request((ctx) => first.auth.signIn('alice', '', ctx, { preferredChallenge: 'EMAIL_OTP' })),
		);
		assert.strictEqual(step.name, 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP');
		first.on('RespondToAuthChallengeCommand', () => ({ AuthenticationResult: first.idp.authResult('alice') }));
		await b.request((ctx) => first.auth.confirmSignIn(sessionOf(step), '11111111', ctx));
		assert.deepStrictEqual(first.sent[1].input.ChallengeResponses, {
			USERNAME: 'alice',
			EMAIL_OTP_CODE: '11111111',
		});
	});

	test('SMS_OTP → CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP; the code is sent as SMS_OTP_CODE', async () => {
		const h = makeAwsAuth({ users: { authFlow: 'USER_AUTH' } });
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({
			ChallengeName: 'SMS_OTP',
			Session: 'cog-smsotp',
			ChallengeParameters: { CODE_DELIVERY_DESTINATION: '+*******0100' },
		}));
		const step = nextStepOf(
			await b.request((ctx) => h.auth.signIn('alice', '', ctx, { preferredChallenge: 'SMS_OTP' })),
		);
		assert.strictEqual(step.name, 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP');
		h.on('RespondToAuthChallengeCommand', () => ({ AuthenticationResult: h.idp.authResult('alice') }));
		await b.request((ctx) => h.auth.confirmSignIn(sessionOf(step), '222222', ctx));
		assert.deepStrictEqual(h.sent[1].input.ChallengeResponses, { USERNAME: 'alice', SMS_OTP_CODE: '222222' });
	});

	test('a challenge without CODE_DELIVERY_DESTINATION shows a visible placeholder and logs a warning', async () => {
		const { logger, entries } = captureLogger();
		const h = makeAwsAuth({ logger });
		h.on('InitiateAuthCommand', () => ({ ChallengeName: 'SMS_MFA', Session: 'cog-sms' }));
		const step = nextStepOf(await new Browser().request((ctx) => h.auth.signIn('alice', 'pw', ctx)));
		assert.ok(step.name === 'CONFIRM_SIGN_IN_WITH_SMS_CODE' && step.codeDeliveryDetails.destination === '***');
		assert.ok(entries.some((e) => e.level === 'warn' && /CODE_DELIVERY_DESTINATION/.test(e.message)));
	});

	test('SELECT_MFA_TYPE → allowed types; the pick is sent as the Cognito MFA name', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({
			ChallengeName: 'SELECT_MFA_TYPE',
			Session: 'cog-sel-mfa',
			ChallengeParameters: { MFAS_CAN_CHOOSE: '["SMS_MFA","SOFTWARE_TOKEN_MFA"]' },
		}));
		const step = nextStepOf(await b.request((ctx) => h.auth.signIn('alice', 'pw', ctx)));
		assert.ok(step.name === 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION');
		if (step.name === 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION')
			assert.deepStrictEqual(step.allowedMFATypes, ['SMS', 'TOTP']);
		h.on('RespondToAuthChallengeCommand', () => ({ ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'cog-totp' }));
		const next = nextStepOf(await b.request((ctx) => h.auth.confirmSignIn(sessionOf(step), 'TOTP', ctx)));
		assert.strictEqual(next.name, 'CONFIRM_SIGN_IN_WITH_TOTP_CODE');
		assert.deepStrictEqual(h.sent[1].input.ChallengeResponses, { USERNAME: 'alice', ANSWER: 'SOFTWARE_TOKEN_MFA' });
	});

	test('NEW_PASSWORD_REQUIRED → required attributes; the answer carries NEW_PASSWORD + prefixed attributes', async () => {
		const h = makeAwsAuth({ users: { attributes: [{ name: 'department', type: 'String' }] } });
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({
			ChallengeName: 'NEW_PASSWORD_REQUIRED',
			Session: 'cog-npr',
			ChallengeParameters: { requiredAttributes: '["userAttributes.name"]' },
		}));
		const step = nextStepOf(await b.request((ctx) => h.auth.signIn('alice', 'Temp!1234', ctx)));
		assert.ok(step.name === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED');
		if (step.name === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
			assert.deepStrictEqual(step.requiredAttributes, ['userAttributes.name']);
		}
		h.on('RespondToAuthChallengeCommand', () => ({ AuthenticationResult: h.idp.authResult('alice') }));
		const r = await b.request((ctx) =>
			h.auth.confirmSignIn(sessionOf(step), 'New!pass1', ctx, {
				userAttributes: { name: 'Alice', department: 'eng' },
			}),
		);
		assert.strictEqual(r.status, 'signedIn');
		assert.deepStrictEqual(h.sent[1].input.ChallengeResponses, {
			USERNAME: 'alice',
			NEW_PASSWORD: 'New!pass1',
			'userAttributes.name': 'Alice',
			'userAttributes.custom:department': 'eng',
		});
	});

	test('CUSTOM_CHALLENGE is refused as not implemented (501), before any RespondToAuthChallenge', async () => {
		const h = makeAwsAuth();
		h.on('InitiateAuthCommand', () => ({ ChallengeName: 'CUSTOM_CHALLENGE', Session: 's' }));
		const e = await new Browser()
			.request((ctx) => h.auth.signIn('alice', 'pw', ctx))
			.then(
				() => assert.fail('expected rejection'),
				(err: unknown) => err,
			);
		assert.deepStrictEqual(wireView(e), {
			code: 501,
			message: 'CUSTOM_AUTH / CUSTOM_CHALLENGE is not yet supported.',
			name: AuthErrors.InvalidParameter,
			retriable: false,
		});
		assert.deepStrictEqual(h.sentNames(), ['InitiateAuthCommand']);
	});

	test('USER_AUTH SELECT_CHALLENGE → PASSWORD: the pick makes no call; the password goes with ANSWER in one call', async () => {
		const h = makeAwsAuth({ users: { authFlow: 'USER_AUTH' } });
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({
			ChallengeName: 'SELECT_CHALLENGE',
			Session: 'cog-sel',
			ChallengeParameters: { AVAILABLE_CHALLENGES: '["PASSWORD","EMAIL_OTP"]' },
		}));
		const pick = nextStepOf(await b.request((ctx) => h.auth.signIn('alice', '', ctx)));
		const pw = nextStepOf(await b.request((ctx) => h.auth.confirmSignIn(sessionOf(pick), 'PASSWORD', ctx)));
		assert.strictEqual(pw.name, 'CONFIRM_SIGN_IN_WITH_PASSWORD');
		assert.deepStrictEqual(h.sentNames(), ['InitiateAuthCommand'], 'picking PASSWORD calls nothing');
		h.on('RespondToAuthChallengeCommand', () => ({ AuthenticationResult: h.idp.authResult('alice') }));
		const r = await b.request((ctx) => h.auth.confirmSignIn(sessionOf(pw), 'Password!1', ctx));
		assert.strictEqual(r.status, 'signedIn');
		assert.deepStrictEqual(h.sent[1].input, {
			ClientId: TEST_CLIENT_ID,
			ChallengeName: 'SELECT_CHALLENGE',
			Session: 'cog-sel',
			ChallengeResponses: { USERNAME: 'alice', ANSWER: 'PASSWORD', PASSWORD: 'Password!1' },
		});
	});

	test('USER_AUTH SELECT_CHALLENGE → EMAIL_OTP: the flow survives the round trip (first-factor labelling)', async () => {
		const h = makeAwsAuth({ users: { authFlow: 'USER_AUTH' } });
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({
			ChallengeName: 'SELECT_CHALLENGE',
			Session: 'cog-sel',
			ChallengeParameters: { AVAILABLE_CHALLENGES: '["PASSWORD","EMAIL_OTP"]' },
		}));
		const pick = nextStepOf(await b.request((ctx) => h.auth.signIn('alice', '', ctx)));
		h.on('RespondToAuthChallengeCommand', () => ({
			ChallengeName: 'EMAIL_OTP',
			Session: 'cog-otp',
			ChallengeParameters: { CODE_DELIVERY_DESTINATION: 'a***@e***' },
		}));
		const otp = nextStepOf(await b.request((ctx) => h.auth.confirmSignIn(sessionOf(pick), 'EMAIL_OTP', ctx)));
		assert.strictEqual(otp.name, 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP');
		assert.deepStrictEqual(h.sent[1].input.ChallengeResponses, { USERNAME: 'alice', ANSWER: 'EMAIL_OTP' });
	});

	test('a challenge envelope signed by another Auth instance is refused', async () => {
		const a = makeAwsAuth();
		const other = makeAwsAuth();
		a.on('InitiateAuthCommand', () => ({ ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'cog-1' }));
		const step = nextStepOf(await new Browser().request((ctx) => a.auth.signIn('alice', 'pw', ctx)));
		const e = await new Browser()
			.request((ctx) => other.auth.confirmSignIn(sessionOf(step), '123456', ctx))
			.then(
				() => assert.fail('expected rejection'),
				(err: unknown) => err,
			);
		assert.strictEqual(wireView(e).name, AuthErrors.ExpiredCode);
		assert.deepStrictEqual(other.sent, []);
	});

	test('a challenge answer whose ID token fails verification writes no session', async () => {
		const h = makeAwsAuth({ logger: captureLogger().logger });
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({ ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'cog-1' }));
		const step = nextStepOf(await b.request((ctx) => h.auth.signIn('alice', 'pw', ctx)));
		h.on('RespondToAuthChallengeCommand', () => ({
			AuthenticationResult: { ...h.idp.authResult('alice'), IdToken: h.idp.idToken('alice', { aud: 'other' }) },
		}));
		await assert.rejects(() => b.request((ctx) => h.auth.confirmSignIn(sessionOf(step), '123456', ctx)));
		assert.strictEqual(h.sessionWrites.length, 0);
		assert.strictEqual(b.jar.get(h.cookieName), undefined);
	});
});

describe('AWS MFA setup during sign-in', () => {
	test('TOTP only: AssociateSoftwareToken → shared secret; the code → VerifySoftwareToken → RespondToAuthChallenge', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({
			ChallengeName: 'MFA_SETUP',
			Session: 'cog-setup',
			ChallengeParameters: { MFAS_CAN_SETUP: '["SOFTWARE_TOKEN_MFA"]' },
		}));
		h.on('AssociateSoftwareTokenCommand', () => ({ SecretCode: 'JBSWY3DPEHPK3PXP', Session: 'cog-assoc' }));
		const step = nextStepOf(await b.request((ctx) => h.auth.signIn('alice', 'pw', ctx)));
		assert.ok(step.name === 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP');
		if (step.name === 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP') assert.strictEqual(step.sharedSecret, 'JBSWY3DPEHPK3PXP');
		assert.deepStrictEqual(h.sent[1], { name: 'AssociateSoftwareTokenCommand', input: { Session: 'cog-setup' } });

		h.on('VerifySoftwareTokenCommand', () => ({ Status: 'SUCCESS', Session: 'cog-verified' }));
		h.on('RespondToAuthChallengeCommand', () => ({ AuthenticationResult: h.idp.authResult('alice') }));
		const r = await b.request((ctx) =>
			h.auth.confirmSignIn(sessionOf(step), '123456', ctx, { friendlyDeviceName: 'Phone' }),
		);
		assert.strictEqual(r.status, 'signedIn');
		assert.deepStrictEqual(h.sent.slice(2), [
			{
				name: 'VerifySoftwareTokenCommand',
				input: { Session: 'cog-assoc', UserCode: '123456', FriendlyDeviceName: 'Phone' },
			},
			{
				name: 'RespondToAuthChallengeCommand',
				input: {
					ClientId: TEST_CLIENT_ID,
					ChallengeName: 'MFA_SETUP',
					Session: 'cog-verified',
					ChallengeResponses: { USERNAME: 'alice' },
				},
			},
		]);
		assert.ok(b.jar.get(h.cookieName), 'signed in');
	});

	test('TOTP + EMAIL: selection; EMAIL → email setup (no call) → address → EMAIL_OTP challenge', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({
			ChallengeName: 'MFA_SETUP',
			Session: 'cog-setup',
			ChallengeParameters: { MFAS_CAN_SETUP: '["SOFTWARE_TOKEN_MFA","EMAIL_OTP"]' },
		}));
		const sel = nextStepOf(await b.request((ctx) => h.auth.signIn('alice', 'pw', ctx)));
		assert.ok(sel.name === 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION');
		if (sel.name === 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION') {
			assert.deepStrictEqual(sel.allowedMFATypes, ['TOTP', 'EMAIL']);
		}
		const email = nextStepOf(await b.request((ctx) => h.auth.confirmSignIn(sessionOf(sel), 'EMAIL', ctx)));
		assert.strictEqual(email.name, 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP');
		assert.deepStrictEqual(h.sentNames(), ['InitiateAuthCommand'], 'picking EMAIL calls nothing');

		h.on('RespondToAuthChallengeCommand', () => ({
			ChallengeName: 'EMAIL_OTP',
			Session: 'cog-otp',
			ChallengeParameters: { CODE_DELIVERY_DESTINATION: 'a***@e***' },
		}));
		const otp = nextStepOf(
			await b.request((ctx) => h.auth.confirmSignIn(sessionOf(email), 'alice@example.com', ctx)),
		);
		assert.strictEqual(otp.name, 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE');
		assert.deepStrictEqual(h.sent[1].input, {
			ClientId: TEST_CLIENT_ID,
			ChallengeName: 'MFA_SETUP',
			Session: 'cog-setup',
			ChallengeResponses: { USERNAME: 'alice', EMAIL: 'alice@example.com' },
		});
	});

	test('TOTP + EMAIL: picking TOTP starts the authenticator setup (AssociateSoftwareToken)', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({
			ChallengeName: 'MFA_SETUP',
			Session: 'cog-setup',
			ChallengeParameters: { MFAS_CAN_SETUP: '["SOFTWARE_TOKEN_MFA","EMAIL_OTP"]' },
		}));
		h.on('AssociateSoftwareTokenCommand', () => ({ SecretCode: 'SECRET', Session: 'cog-assoc' }));
		const sel = nextStepOf(await b.request((ctx) => h.auth.signIn('alice', 'pw', ctx)));
		const totp = nextStepOf(await b.request((ctx) => h.auth.confirmSignIn(sessionOf(sel), 'TOTP', ctx)));
		assert.strictEqual(totp.name, 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP');
		assert.deepStrictEqual(h.sent[1], { name: 'AssociateSoftwareTokenCommand', input: { Session: 'cog-setup' } });
	});

	test('a rejected TOTP setup code keeps the step (EnableSoftwareTokenMFAException is retriable)', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({
			ChallengeName: 'MFA_SETUP',
			Session: 'cog-setup',
			ChallengeParameters: { MFAS_CAN_SETUP: '["SOFTWARE_TOKEN_MFA"]' },
		}));
		h.on('AssociateSoftwareTokenCommand', () => ({ SecretCode: 'SECRET', Session: 'cog-assoc' }));
		const step = nextStepOf(await b.request((ctx) => h.auth.signIn('alice', 'pw', ctx)));
		h.on('VerifySoftwareTokenCommand', () => {
			throw cognitoError('EnableSoftwareTokenMFAException', 'Code mismatch');
		});
		const s = await b.request((ctx) =>
			apiFor(h.auth, ctx).setAuthState({
				action: 'confirmSignIn',
				challenge: 'totpSetup',
				session: sessionOf(step),
				sharedSecret: 'SECRET',
				code: '000000',
			}),
		);
		assert.strictEqual(s.retriable, true);
		assert.strictEqual(s.errorName, AuthErrors.EnableSoftwareTokenMFA);
	});
});

describe('AWS passkeys', () => {
	const PASSKEYS = {
		users: { authFlow: 'USER_AUTH' },
		passkeys: { relyingPartyId: 'example.com', origins: ['https://example.com'] },
	} as const;

	test('passkey sign-in: WEB_AUTHN preferred, no password; the assertion is sent as CREDENTIAL', async () => {
		const h = makeAwsAuth(PASSKEYS);
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({
			ChallengeName: 'WEB_AUTHN',
			Session: 'cog-webauthn',
			ChallengeParameters: { CREDENTIAL_REQUEST_OPTIONS: '{"challenge":"abc"}' },
		}));
		const s = await b.request((ctx) =>
			apiFor(h.auth, ctx).setAuthState({ action: 'signInWithPasskey', username: 'alice' }),
		);
		assert.deepStrictEqual(h.sent[0].input.AuthParameters, { USERNAME: 'alice', PREFERRED_CHALLENGE: 'WEB_AUTHN' });
		assert.strictEqual(s.state, 'confirmingSignIn');
		const step = nextStepOf(
			await b.request((ctx) => h.auth.signIn('alice', '', ctx, { preferredChallenge: 'WEB_AUTHN' })),
		);
		assert.ok(step.name === 'CONFIRM_SIGN_IN_WITH_WEB_AUTHN');
		if (step.name === 'CONFIRM_SIGN_IN_WITH_WEB_AUTHN') {
			assert.strictEqual(step.credentialRequestOptions, '{"challenge":"abc"}');
		}
		h.on('RespondToAuthChallengeCommand', () => ({ AuthenticationResult: h.idp.authResult('alice') }));
		const r = await b.request((ctx) => h.auth.confirmSignIn(sessionOf(step), '{"id":"cred-1"}', ctx));
		assert.strictEqual(r.status, 'signedIn');
		assert.deepStrictEqual(h.sent[2].input.ChallengeResponses, {
			USERNAME: 'alice',
			CREDENTIAL: '{"id":"cred-1"}',
		});
	});

	test('registration: StartWebAuthnRegistration options are stringified; completion sends the parsed credential', async () => {
		const h = makeAwsAuth(PASSKEYS);
		const b = new Browser();
		const tokens = h.idp.authResult('alice');
		await signInAs(h, b, 'alice', tokens);
		h.on('StartWebAuthnRegistrationCommand', () => ({ CredentialCreationOptions: { challenge: 'xyz', rp: {} } }));
		const started = await b.request((ctx) =>
			apiFor(h.auth, ctx).setAuthState({ action: 'startPasskeyRegistration' }),
		);
		assert.strictEqual(started.state, 'signedIn');
		assert.strictEqual(started.actions[0]?.name, 'completePasskeyRegistration');
		assert.ok(JSON.stringify(started).includes(JSON.stringify(JSON.stringify({ challenge: 'xyz', rp: {} }))));
		assert.deepStrictEqual(h.sent[0], {
			name: 'StartWebAuthnRegistrationCommand',
			input: { AccessToken: tokens.AccessToken },
		});

		h.on('CompleteWebAuthnRegistrationCommand', () => ({}));
		h.on('ListWebAuthnCredentialsCommand', () => ({ Credentials: [] }));
		await b.request((ctx) =>
			apiFor(h.auth, ctx).setAuthState({
				action: 'completePasskeyRegistration',
				credential: '{"id":"cred-1","type":"public-key"}',
			}),
		);
		assert.deepStrictEqual(h.sent[1], {
			name: 'CompleteWebAuthnRegistrationCommand',
			input: { AccessToken: tokens.AccessToken, Credential: { id: 'cred-1', type: 'public-key' } },
		});
	});

	test('a credential that is not a JSON object → 400 InvalidParameter, Cognito never called', async () => {
		const h = makeAwsAuth(PASSKEYS);
		const b = new Browser();
		await signInAs(h, b, 'alice');
		for (const bad of ['not json', '"a string"', '[1,2]', 'null']) {
			const s = await b.request((ctx) =>
				apiFor(h.auth, ctx).setAuthState({ action: 'completePasskeyRegistration', credential: bad }),
			);
			assert.strictEqual(s.errorName, AuthErrors.InvalidParameter, bad);
		}
		assert.deepStrictEqual(h.sent, []);
	});

	test('listPasskeys paginates and maps to { credentialId, friendlyName, createdAt (ISO) }', async () => {
		const h = makeAwsAuth(PASSKEYS);
		const created = new Date('2026-01-02T03:04:05.000Z');
		h.on('ListWebAuthnCredentialsCommand', (input) =>
			input.NextToken
				? { Credentials: [{ CredentialId: 'c2', CreatedAt: created }] }
				: {
						Credentials: [
							{
								CredentialId: 'c1',
								FriendlyCredentialName: 'Laptop',
								CreatedAt: created,
								RelyingPartyId: 'x',
							},
						],
						NextToken: 'n2',
					},
		);
		const list = await h.engine.listPasskeys('access-token');
		assert.deepStrictEqual(list, [
			{ credentialId: 'c1', friendlyName: 'Laptop', createdAt: '2026-01-02T03:04:05.000Z' },
			{ credentialId: 'c2', createdAt: '2026-01-02T03:04:05.000Z' },
		]);
		assert.deepStrictEqual(
			h.sent.map((c) => c.input),
			[{ AccessToken: 'access-token' }, { AccessToken: 'access-token', NextToken: 'n2' }],
		);
	});

	test('deletePasskey sends DeleteWebAuthnCredential with the access token and credential id', async () => {
		const h = makeAwsAuth(PASSKEYS);
		const b = new Browser();
		const tokens = h.idp.authResult('alice');
		await signInAs(h, b, 'alice', tokens);
		h.on('DeleteWebAuthnCredentialCommand', () => ({}));
		h.on('ListWebAuthnCredentialsCommand', () => ({ Credentials: [] }));
		const s = await b.request((ctx) =>
			apiFor(h.auth, ctx).setAuthState({ action: 'deletePasskey', credentialId: 'cred-9' }),
		);
		assert.strictEqual(s.state, 'signedIn');
		assert.deepStrictEqual(h.sent[0], {
			name: 'DeleteWebAuthnCredentialCommand',
			input: { AccessToken: tokens.AccessToken, CredentialId: 'cred-9' },
		});
	});

	test('a pool without WebAuthn answers WebAuthnNotEnabledException by name', async () => {
		const h = makeAwsAuth(PASSKEYS);
		const b = new Browser();
		await signInAs(h, b, 'alice');
		h.on('StartWebAuthnRegistrationCommand', () => {
			throw cognitoError('WebAuthnNotEnabledException', 'WebAuthn is not enabled');
		});
		const s = await b.request((ctx) => apiFor(h.auth, ctx).setAuthState({ action: 'startPasskeyRegistration' }));
		assert.strictEqual(s.errorName, AuthErrors.WebAuthnNotEnabled);
	});
});

describe('AWS password reset and change — command shapes', () => {
	test('resetPassword → ForgotPassword; the delivery details are mapped', async () => {
		const h = makeAwsAuth();
		h.on('ForgotPasswordCommand', () => ({
			CodeDeliveryDetails: { Destination: 'a***@e***', DeliveryMedium: 'EMAIL', AttributeName: 'email' },
		}));
		const r = await h.auth.resetPassword('alice');
		assert.deepStrictEqual(h.sent, [
			{ name: 'ForgotPasswordCommand', input: { ClientId: TEST_CLIENT_ID, Username: 'alice' } },
		]);
		assert.deepStrictEqual(r, {
			isPasswordReset: false,
			nextStep: {
				name: 'CONFIRM_RESET_PASSWORD_WITH_CODE',
				codeDeliveryDetails: { destination: 'a***@e***', deliveryMedium: 'EMAIL', attributeName: 'email' },
			},
		});
	});

	test('confirmResetPassword → ConfirmForgotPassword with the code and new password', async () => {
		const h = makeAwsAuth();
		h.on('ConfirmForgotPasswordCommand', () => ({}));
		await h.auth.confirmResetPassword('alice', '424242', 'New!pass1');
		assert.deepStrictEqual(h.sent[0].input, {
			ClientId: TEST_CLIENT_ID,
			Username: 'alice',
			ConfirmationCode: '424242',
			Password: 'New!pass1',
		});
	});

	test('updatePassword → ChangePassword with the session access token', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		const tokens = h.idp.authResult('alice');
		await signInAs(h, b, 'alice', tokens);
		h.on('ChangePasswordCommand', () => ({}));
		await b.request((ctx) => h.auth.updatePassword(ctx, 'Old!pass1', 'New!pass1'));
		assert.deepStrictEqual(h.sent, [
			{
				name: 'ChangePasswordCommand',
				input: {
					AccessToken: tokens.AccessToken,
					PreviousPassword: 'Old!pass1',
					ProposedPassword: 'New!pass1',
				},
			},
		]);
	});

	test('a wrong old password is a 401 NotAuthorizedException with Cognito’s message', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		await signInAs(h, b, 'alice');
		h.on('ChangePasswordCommand', () => {
			throw cognitoError('NotAuthorizedException', 'Incorrect username or password.');
		});
		const e = await b
			.request((ctx) => h.auth.updatePassword(ctx, 'wrong', 'New!pass1'))
			.then(
				() => assert.fail('expected rejection'),
				(err: unknown) => err,
			);
		assert.strictEqual(wireView(e).code, 401);
		assert.strictEqual(wireView(e).name, AuthErrors.NotAuthorized);
	});
});

describe('AWS engine construction contract', () => {
	let n = 0;
	const fresh = () => `lazy${process.pid}x${++n}`;

	test('outside Lambda (no config keys) Auth constructs without throwing and creates no SDK client', () => {
		const auth = new Auth({ id: 'codegen' }, fresh());
		const engine = Reflect.get(auth, 'native');
		assert.ok(engine, 'a password configuration builds the native engine');
		assert.strictEqual(Reflect.get(engine, 'sdk'), undefined, 'the SDK client is created lazily');
		assert.strictEqual(Reflect.get(engine, 'verifierCache'), undefined, 'and so is the verifier');
	});

	test('with no pool identifiers a call is a 500 InternalError before any SDK client exists', async () => {
		const auth = new Auth({ id: 'codegen' }, fresh(), { logger: captureLogger().logger });
		const engine = Reflect.get(auth, 'native');
		const e = await auth.signUp('bob', 'Password!1').then(
			() => assert.fail('expected rejection'),
			(err: unknown) => err,
		);
		assert.deepStrictEqual(wireView(e), {
			code: 500,
			message: INTERNAL_ERROR_MESSAGE,
			name: AuthErrors.InternalError,
			retriable: true,
		});
		assert.strictEqual(Reflect.get(engine, 'sdk'), undefined);
	});

	test('the constructor registers the config keys as SDK identifiers', () => {
		const h = makeAwsAuth();
		assert.deepStrictEqual(getSdkIdentifiers(h.auth), {
			userPoolId: TEST_POOL_ID,
			clientId: TEST_CLIENT_ID,
			region: TEST_REGION,
		});
	});

	test('identifiers are resolved at call time, not captured in the constructor', async () => {
		const h = makeAwsAuth();
		registerSdkIdentifiers(h.fullId, { clientId: 'rotated-client-id' });
		h.on('SignUpCommand', () => ({ UserConfirmed: true, UserSub: 'sub-x' }));
		await h.auth.signUp('x', 'Password!1');
		assert.strictEqual(h.sent[0].input.ClientId, 'rotated-client-id');
	});

	test('the SDK client uses the region config key and the block user-agent chain', async () => {
		const h = makeAwsAuth();
		const client = Reflect.get(h.engine, 'client');
		assert.strictEqual(await client.config.region(), TEST_REGION);
		const chain: unknown = Reflect.get(h.auth, 'buildUserAgentChain').call(h.auth);
		assert.deepStrictEqual(client.config.customUserAgent, chain);
		assert.ok(Array.isArray(chain) && chain.length > 0 && chain[0][0] === 'aws-blocks');
	});

	test('a pool-less configuration (Q6) builds no native engine and reads no pool config key', () => {
		const id = fresh();
		const root = { id: 'q6' };
		const keys = cognitoConfigKeys(`q6-${id}`);
		// Even if keys were (wrongly) present, nothing reads them.
		process.env[keys.USER_POOL_ID] = TEST_POOL_ID;
		process.env[keys.CLIENT_ID] = TEST_CLIENT_ID;
		try {
			const auth = new Auth(root, id, {
				emailPassword: false,
				oidcProviders: { okta: { issuer: 'https://example.okta.com', clientId: 'okta-client' } },
			});
			assert.strictEqual(auth.fullId, `q6-${id}`);
			assert.strictEqual(Reflect.get(auth, 'native'), undefined);
			assert.deepStrictEqual(getSdkIdentifiers(auth), {}, 'no Cognito identifiers registered');
		} finally {
			delete process.env[keys.USER_POOL_ID];
			delete process.env[keys.CLIENT_ID];
		}
	});

	test('an unsupported users.authFlow from an untyped caller is refused before any Cognito call', async () => {
		const options: AuthOptions = {};
		Reflect.set(options, 'users', { authFlow: 'CUSTOM_AUTH' });
		const h = makeAwsAuth(options);
		const e = await new Browser()
			.request((ctx) => h.auth.signIn('alice', 'pw', ctx))
			.then(
				() => assert.fail('expected rejection'),
				(err: unknown) => err,
			);
		assert.strictEqual(wireView(e).code, 501);
		assert.deepStrictEqual(h.sent, []);
	});
});
