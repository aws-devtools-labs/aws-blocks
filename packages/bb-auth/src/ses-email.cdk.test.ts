// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `email` (L75): the user pool sends its email (sign-up and reset codes, email
 * MFA, `EMAIL_OTP`) through the app's own Amazon SES identity instead of
 * Cognito's default sender, which is capped at 50 emails a day.
 *
 * Pinned here, against real synths under `--conditions=cdk`:
 * - the `EmailConfiguration` the option produces (`UserPoolEmail.withSES`);
 * - unset, the pool has no `EmailConfiguration` (the zero-config template is
 *   pinned byte-for-byte by `property-snapshot.cdk.test.ts`);
 * - adding it later is an in-place update: same logical ids and physical
 *   names, and `EmailConfiguration` (CloudFormation: "Update requires: No
 *   interruption") is the only pool property that changes. The immutability
 *   guard lets it through (`immutability-guard.cdk.test.ts`, PERMITTED);
 * - it unlocks email MFA and the `EMAIL_OTP` first factor on a pool this block
 *   creates, which Cognito sends only through SES.
 */

import assert from 'node:assert';
import { describe, test } from 'node:test';
import type { CfnResourceJson } from './test-support/cdk-synth.js';
import { diffIdentity, type SynthesizedAuth, synthIdentity } from './test-support/identity.js';

function poolOf(synth: SynthesizedAuth): CfnResourceJson {
	const pools = Object.values(synth.template.Resources).filter((r) => r.Type === 'AWS::Cognito::UserPool');
	assert.strictEqual(pools.length, 1, 'exactly one user pool');
	return pools[0];
}

const SENDER = "{ fromAddress: 'no-reply@example.com' }";

describe('email: the pool sends through SES', () => {
	test("fromAddress alone: DEVELOPER sending from that identity, in the pool's own Region", () => {
		const pool = poolOf(synthIdentity(`new Auth(stack, 'auth', { email: ${SENDER} })`));
		assert.deepStrictEqual(pool.Properties?.EmailConfiguration, {
			EmailSendingAccount: 'DEVELOPER',
			From: 'no-reply@example.com',
			SourceArn: {
				'Fn::Join': [
					'',
					[
						'arn:',
						{ Ref: 'AWS::Partition' },
						':ses:',
						{ Ref: 'AWS::Region' },
						':',
						{ Ref: 'AWS::AccountId' },
						':identity/no-reply@example.com',
					],
				],
			},
		});
	});

	test('every field: display name, reply-to, another Region, a verified domain, a configuration set', () => {
		const pool = poolOf(
			synthIdentity(
				"new Auth(stack, 'auth', { email: { fromAddress: 'no-reply@example.com', fromName: 'Example App', replyTo: 'support@example.com', sesRegion: 'us-west-2', sesVerifiedDomain: 'example.com', configurationSetName: 'auth-mail' } })",
			),
		);
		assert.deepStrictEqual(pool.Properties?.EmailConfiguration, {
			EmailSendingAccount: 'DEVELOPER',
			From: 'Example App <no-reply@example.com>',
			ReplyToEmailAddress: 'support@example.com',
			ConfigurationSet: 'auth-mail',
			SourceArn: {
				'Fn::Join': [
					'',
					[
						'arn:',
						{ Ref: 'AWS::Partition' },
						':ses:us-west-2:',
						{ Ref: 'AWS::AccountId' },
						':identity/example.com',
					],
				],
			},
		});
	});

	test('unset: no EmailConfiguration (Cognito default sender)', () => {
		const pool = poolOf(synthIdentity("new Auth(stack, 'auth')"));
		assert.strictEqual(pool.Properties?.EmailConfiguration, undefined);
	});
});

describe('email: adding it to a deployed pool is an in-place update', () => {
	const before = synthIdentity("new Auth(stack, 'auth')");
	const after = synthIdentity(`new Auth(stack, 'auth', { email: ${SENDER} })`);

	test('same resources, logical ids and physical names', () => {
		assert.deepStrictEqual(diffIdentity(before.identity, after.identity), []);
	});

	test('EmailConfiguration is the only pool property that changes', () => {
		const a = { ...(poolOf(before).Properties ?? {}) };
		const b = { ...(poolOf(after).Properties ?? {}) };
		delete b.EmailConfiguration;
		assert.deepStrictEqual(b, a);
	});

	test('no IAM change: Cognito sends through its own service-linked role, not the backend role', () => {
		const policies = (s: SynthesizedAuth) =>
			JSON.stringify(Object.values(s.template.Resources).filter((r) => r.Type === 'AWS::IAM::Policy'));
		assert.strictEqual(policies(after), policies(before));
	});
});

describe('email: unlocks the email factors on a pool this block creates', () => {
	test('email MFA', () => {
		const pool = poolOf(
			synthIdentity(
				`new Auth(stack, 'auth', { email: ${SENDER}, mfa: { mode: 'optional', types: ['EMAIL', 'TOTP'] } })`,
			),
		);
		const enabled = pool.Properties?.EnabledMfas;
		assert.ok(Array.isArray(enabled) && enabled.includes('EMAIL_OTP'), JSON.stringify(enabled));
	});

	test("users.preferredChallenge: 'EMAIL_OTP' with USER_AUTH", () => {
		const pool = poolOf(
			synthIdentity(
				`new Auth(stack, 'auth', { email: ${SENDER}, users: { authFlow: 'USER_AUTH', preferredChallenge: 'EMAIL_OTP' } })`,
			),
		);
		const factors = JSON.stringify(pool.Properties?.Policies);
		assert.match(factors, /EMAIL_OTP/);
	});
});
