// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `AuthOptions.email` (L75) → the user pool's SES email configuration.
 *
 * {@link assertEmailSender} refuses, at synth, a sender Cognito could never use
 * (with the reason, instead of a failed deploy or silent fallback);
 * {@link mapEmailSender} builds the `UserPoolEmail.withSES()` value.
 *
 * `EmailConfiguration` is not one of the pool's service-immutable properties
 * (CloudFormation: "Update requires: No interruption"), so it is not guarded:
 * adding, changing or removing it updates the pool in place
 * (`ses-email.cdk.test.ts`, `immutability-guard.cdk.test.ts`).
 *
 * @internal
 */

import * as cognito from 'aws-cdk-lib/aws-cognito';
import type { AuthOptions, EmailSenderOptions } from '../types.js';
import { isCdkToken } from './contract.js';

const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+$/;
const AWS_REGION = /^[a-z]{2}(-[a-z]+)+-\d+$/;

/** A string option is checked only when it is a literal: a CDK token resolves at deploy time. */
function literal(value: unknown): value is string {
	return typeof value === 'string' && !isCdkToken(value);
}

/**
 * Refuse, at synth, an `email` option that cannot work: on a pool this block
 * doesn't create, on a configuration with no pool, or with a malformed field.
 * Fields given as CDK tokens are passed through unchecked.
 */
export function assertEmailSender(fullId: string, options: AuthOptions, needsPool: boolean): void {
	const email: EmailSenderOptions | undefined = options.email;
	if (email === undefined) return;
	const fail = (reason: string): never => {
		throw new Error(`Auth '${fullId}': ${reason}`);
	};
	if (options.userPool) {
		fail(
			'`email` configures the email sender of a user pool this block creates, but `userPool` wraps an existing pool ' +
				'(`Auth.fromExisting`), whose email configuration belongs to its owner. Configure SES on that pool directly, ' +
				'or remove `email`.',
		);
	}
	if (!needsPool) {
		fail(
			"`email` configures the user pool's email sender, but this configuration creates no user pool (its only " +
				'sign-in methods are directly federated OIDC providers, which send no email). Remove `email`, or enable a ' +
				'pool-backed sign-in method.',
		);
	}
	const fromAddress: unknown = email.fromAddress;
	if (!isCdkToken(fromAddress) && !(literal(fromAddress) && EMAIL_ADDRESS.test(fromAddress))) {
		fail(
			`\`email.fromAddress\` must be an email address (a verified SES identity), got ${JSON.stringify(fromAddress)}.`,
		);
	}
	if (email.replyTo !== undefined && literal(email.replyTo) && !EMAIL_ADDRESS.test(email.replyTo)) {
		fail(`\`email.replyTo\` must be an email address, got ${JSON.stringify(email.replyTo)}.`);
	}
	if (email.sesRegion !== undefined && literal(email.sesRegion) && !AWS_REGION.test(email.sesRegion)) {
		fail(`\`email.sesRegion\` must be an AWS Region such as 'us-east-1', got ${JSON.stringify(email.sesRegion)}.`);
	}
	if (email.sesVerifiedDomain !== undefined && literal(email.sesVerifiedDomain) && literal(fromAddress)) {
		const domain = fromAddress.split('@').pop();
		if (email.sesVerifiedDomain !== domain) {
			fail(
				`\`email.sesVerifiedDomain\` ('${email.sesVerifiedDomain}') must be the domain of \`email.fromAddress\` ('${domain}'): ` +
					'Cognito sends from the address, authorized by the domain identity.',
			);
		}
	}
	if (
		email.configurationSetName !== undefined &&
		literal(email.configurationSetName) &&
		email.configurationSetName.trim() === ''
	) {
		fail('`email.configurationSetName` must be a non-empty SES configuration set name, or omitted.');
	}
}

/**
 * The pool's `email` prop: `undefined` when the option is unset (no
 * `EmailConfiguration`, Cognito's default sender), else SES "developer"
 * sending from `fromAddress`. `sesRegion` defaults to `poolRegion` — the
 * stack's Region, a token in an environment-agnostic stack — which is also
 * what keeps `withSES` from requiring it.
 */
export function mapEmailSender(
	email: EmailSenderOptions | undefined,
	poolRegion: string,
): cognito.UserPoolEmail | undefined {
	if (email === undefined) return undefined;
	return cognito.UserPoolEmail.withSES({
		fromEmail: email.fromAddress,
		fromName: email.fromName,
		replyTo: email.replyTo,
		sesRegion: email.sesRegion ?? poolRegion,
		sesVerifiedDomain: email.sesVerifiedDomain,
		configurationSetName: email.configurationSetName,
	});
}
