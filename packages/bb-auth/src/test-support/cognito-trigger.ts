// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only: Cognito's side of the PreSignUp trigger (decision Q10) for the
 * offline AWS harness (`aws-harness.ts`). On `SignUp` / `AdminCreateUser` the
 * responders build the event Cognito would send and invoke **core's real
 * Lambda handler** (`createLambdaHandler`), which routes it by user pool id to
 * the `Auth` instance; a throw becomes `UserLambdaValidationException`
 * (`PreSignUp failed with error <message>.`) and no user is created — what the
 * service does.
 *
 * Never imported by an entry point.
 *
 * @internal
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import { unlockRouteRegistry } from '@aws-blocks/core';
import { createLambdaHandler } from '@aws-blocks/core/lambda-handler';
import type { AuthOptions } from '../types.js';
import { type AwsAuthHarness, cognitoError, TEST_POOL_ID, TEST_REGION } from './aws-harness.js';

const lambda = createLambdaHandler(async () => ({}));

/** Invoke the shared backend Lambda, as Cognito does for a trigger. */
export async function invokeLambda(event: Record<string, unknown>): Promise<unknown> {
	try {
		return await lambda(event);
	} finally {
		// The handler locks route registration on first use, as in Lambda.
		unlockRouteRegistry();
	}
}

const NO_AUTO = { autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false };

/**
 * The PreSignUp event for a `SignUp` / `AdminCreateUser` input. On a
 * username-attribute pool (`usernameAttributes`), Cognito stores a generated
 * UUID as the username and fills the email / phone attribute from the value
 * given as `Username` — and the event says so.
 */
export function preSignUpEvent(
	triggerSource: string,
	input: Record<string, unknown>,
	userPoolId = TEST_POOL_ID,
	usernameAttributes = false,
): Record<string, unknown> {
	const list = Array.isArray(input.UserAttributes) ? (input.UserAttributes as { Name: string; Value: string }[]) : [];
	const userAttributes: Record<string, string> = Object.fromEntries(list.map((a) => [a.Name, a.Value]));
	let userName = String(input.Username);
	if (usernameAttributes) {
		const attr = userName.includes('@') ? 'email' : 'phone_number';
		userAttributes[attr] ??= userName;
		userName = crypto.randomUUID();
	}
	const meta = input.ClientMetadata;
	return {
		version: '1',
		region: TEST_REGION,
		userPoolId,
		userName,
		callerContext: { awsSdkVersion: 'aws-sdk-js-3', clientId: String(input.ClientId ?? 'console') },
		triggerSource,
		request: { userAttributes, validationData: null, ...(meta ? { clientMetadata: meta } : {}) },
		response: { ...NO_AUTO },
	};
}

/**
 * Play Cognito for `h`: `SignUp` / `AdminCreateUser` run the PreSignUp trigger
 * through the Lambda first. `created` lists the users Cognito created;
 * `invocations` every trigger event.
 *
 * `dropClientMetadata` delivers no `ClientMetadata` to the trigger (so it does
 * not see the "validated in-process" marker and validates itself).
 */
export function cognitoWithTrigger<O extends AuthOptions>(
	h: AwsAuthHarness<O>,
	opts: { dropClientMetadata?: boolean; usernameAttributes?: boolean } = {},
) {
	const created: string[] = [];
	const invocations: Record<string, unknown>[] = [];
	const run = async (triggerSource: string, input: Record<string, unknown>) => {
		const sent = opts.dropClientMetadata ? { ...input, ClientMetadata: undefined } : input;
		const event = preSignUpEvent(triggerSource, sent, TEST_POOL_ID, opts.usernameAttributes === true);
		invocations.push(event);
		let result: unknown;
		try {
			result = await invokeLambda(event);
		} catch (e) {
			throw cognitoError(
				'UserLambdaValidationException',
				`PreSignUp failed with error ${e instanceof Error ? e.message : String(e)}.`,
			);
		}
		// Cognito reads the returned event's `response`: the trigger never auto-confirms or auto-verifies.
		assert.deepStrictEqual(Reflect.get(Object(result), 'response'), NO_AUTO);
		created.push(String(input.Username));
	};
	h.on('SignUpCommand', async (input) => {
		await run('PreSignUp_SignUp', input);
		return { UserConfirmed: false, UserSub: `sub-${String(input.Username)}` };
	});
	h.on('AdminCreateUserCommand', async (input) => {
		await run('PreSignUp_AdminCreateUser', input);
		return {
			User: { Username: input.Username, Enabled: true, UserStatus: 'FORCE_CHANGE_PASSWORD', Attributes: [] },
		};
	});
	return {
		created,
		invocations,
		/** A `SignUp` made straight against Cognito (e.g. with the client id from an authorize URL). */
		directSignUp: (input: Record<string, unknown>) => run('PreSignUp_SignUp', input),
	};
}
