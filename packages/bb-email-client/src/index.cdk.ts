// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { CfnConfigurationSet } from 'aws-cdk-lib/aws-ses';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Stack } from 'aws-cdk-lib';
import { Scope } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';

// Re-export public types and errors (no runtime dependencies)
export { EmailErrors } from './errors.js';
export type { EmailOptions, EmailMessage, SendResult, SendBatchResult } from './types.js';

import type { EmailOptions } from './types.js';

export class EmailClient extends Scope {
	constructor(scope: ScopeParent, id: string, options: EmailOptions) {
		super(id, { parent: scope });

		// Register VPC endpoint requirements for SES access
		this.registerVpcRequirements({
			endpoints: [{ service: 'ses', type: 'interface' }],
		});

		console.warn(
			`\n⚠️  [Email] Prerequisite: Domain for "${options.fromAddress}" must be verified in SES.\n` +
			`   Guide: https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html\n`
		);

		// TODO: Add a CDK custom resource that validates the SES email identity at deploy time.
		// Deploy time is the earliest point where AWS credentials are available to check SES state.
		// The custom resource should:
		//   1. Call sesv2:GetEmailIdentity for the domain extracted from fromAddress
		//   2. If not verified: emit a CloudFormation warning (do not fail the deployment)
		//   3. Include a link to the SES identity setup guide in the warning message

		// Grant the Lambda handler permission to send emails
		// Scoped to this account's SES identities rather than '*'
		this.handler.addToRolePolicy(new PolicyStatement({
			effect: Effect.ALLOW,
			actions: [
				'ses:SendEmail',
				'ses:SendBulkEmail',
				'ses:SendRawEmail',
				'ses:SendTemplatedEmail',
				'ses:SendBulkTemplatedEmail',
			],
			resources: [
				`arn:aws:ses:*:${Stack.of(this).account}:identity/*`,
				`arn:aws:ses:*:${Stack.of(this).account}:configuration-set/*`,
			],
		}));
	}
}
