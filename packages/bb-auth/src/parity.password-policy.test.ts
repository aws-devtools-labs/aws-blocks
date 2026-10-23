// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock ↔ AWS parity for **the weak-password message** (L71, decided by the
 * maintainer on 2026-10-12): a client that sends a password the policy
 * rejects gets one message built from the block's own
 * `emailPassword.passwordPolicy` (`passwordPolicyMessage`), the same on the
 * local engine (`./index.mock.js`) and on the AWS entry (`./index.aws.js`,
 * offline through `test-support/aws-harness.ts`). Cognito's text — "Password
 * did not conform with policy: …" — never reaches the client (FX59), and nor
 * does the local engine's own list of what was missing.
 *
 * An imported pool (`userPool: Auth.fromExisting(…)`) has a policy the block
 * does not know, so it keeps the fixed message.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { ScopeParent } from '@aws-blocks/core';
import { CLIENT_ERROR_MESSAGES, passwordPolicyMessage } from './error-mapping.js';
import { AuthErrors } from './errors.js';
import { Auth as AwsAuth } from './index.aws.js';
import { Auth as MockAuth } from './index.mock.js';
import { cognitoError, makeAwsAuth, wireView } from './test-support/aws-harness.js';
import type { AuthOptions, CodeDeliveryPurpose, PasswordPolicy } from './types.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const GOOD = 'Passw0rd!long';
const WEAK = 'weak';
const COGNITO_TEXT = 'Password did not conform with policy: Password not long enough';
let n = 0;
const root = (): ScopeParent => ({ id: `paritypw${process.pid}x${++n}` });

const failure = (p: Promise<unknown>) =>
	p.then(
		() => assert.fail('expected the weak password to be rejected'),
		(e: unknown) => wireView(e),
	);

/** A local `Auth` that records the codes it delivers. */
function localAuth(options: AuthOptions) {
	const codes: { purpose: CodeDeliveryPurpose; code: string }[] = [];
	const auth: MockAuth = new MockAuth(root(), 'auth', {
		...options,
		codeDelivery: async (_u: string, code: string, purpose: CodeDeliveryPurpose) => {
			codes.push({ purpose, code });
		},
	});
	const last = (purpose: CodeDeliveryPurpose) => [...codes].reverse().find((c) => c.purpose === purpose)?.code ?? '';
	return { auth, last };
}

const POLICIES: { label: string; policy: PasswordPolicy | undefined }[] = [
	{ label: 'the default policy', policy: undefined },
	{ label: 'a custom policy', policy: { minLength: 12, requireSymbols: false, requireUppercase: false } },
];

describe('parity: a weak password gets the message for the block’s own policy (L71)', () => {
	for (const { label, policy } of POLICIES) {
		const options: AuthOptions = policy ? { emailPassword: { passwordPolicy: policy } } : {};
		const expected = passwordPolicyMessage(policy);

		test(`signUp, ${label}`, async () => {
			const local = localAuth(options);
			const mock = await failure(local.auth.signUp('alice', WEAK));

			const h = makeAwsAuth(options);
			h.on('SignUpCommand', () => {
				throw cognitoError('InvalidPasswordException', COGNITO_TEXT);
			});
			const wide: MockAuth = h.auth;
			const aws = await failure(wide.signUp('alice', WEAK));

			assert.deepStrictEqual(mock, aws, 'same name, status, retriable and message');
			assert.strictEqual(aws.name, AuthErrors.InvalidPassword);
			assert.strictEqual(aws.message, expected);
			assert.ok(!String(aws.message).includes('conform'), 'Cognito’s text stays off the wire');
			assert.ok(!String(mock.message).includes('must contain'), 'the local engine’s own text stays off the wire');
		});

		test(`confirmResetPassword, ${label}`, async () => {
			const local = localAuth(options);
			await local.auth.signUp('alice', GOOD, { attributes: { email: 'alice@example.com' } });
			await local.auth.confirmSignUp('alice', local.last('signUp'));
			await local.auth.resetPassword('alice');
			const mock = await failure(local.auth.confirmResetPassword('alice', local.last('resetPassword'), WEAK));

			const h = makeAwsAuth(options);
			h.on('ConfirmForgotPasswordCommand', () => {
				throw cognitoError('InvalidPasswordException', COGNITO_TEXT);
			});
			const wide: MockAuth = h.auth;
			const aws = await failure(wide.confirmResetPassword('alice', '123456', WEAK));

			assert.deepStrictEqual(mock, aws);
			assert.strictEqual(aws.message, expected);
		});
	}

	test('an imported pool keeps the fixed message: its policy is not the block’s', async () => {
		const h = makeAwsAuth({ userPool: AwsAuth.fromExisting('us-east-1_Imported', 'importedclient') });
		h.on('SignUpCommand', () => {
			throw cognitoError('InvalidPasswordException', COGNITO_TEXT);
		});
		const wide: MockAuth = h.auth;
		const aws = await failure(wide.signUp('alice', WEAK));
		assert.strictEqual(aws.name, AuthErrors.InvalidPassword);
		assert.strictEqual(aws.message, CLIENT_ERROR_MESSAGES[AuthErrors.InvalidPassword]);
	});
});
