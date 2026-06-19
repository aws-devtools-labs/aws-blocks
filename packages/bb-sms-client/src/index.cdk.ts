// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Scope } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';

// Re-export public types and errors (no runtime dependencies)
export { SmsErrors } from './errors.js';
export type { SmsOptions, SmsMessage, PushMessage, SmsType, SendResult, SendBatchResult } from './types.js';

import type { SmsOptions } from './types.js';

export class SmsClient extends Scope {
	constructor(scope: ScopeParent, id: string, _options: SmsOptions = {}) {
		super(id, { parent: scope });

		console.warn(
			`\n⚠️  [Sms] Prerequisite: new AWS accounts start in the SMS sandbox and can only\n` +
			`   message verified destination numbers. Request production access and set an\n` +
			`   account spend limit before going live.\n` +
			`   Guide: https://docs.aws.amazon.com/sns/latest/dg/sns-sms-sandbox.html\n`
		);

		// Grant the Lambda handler permission to publish SMS and push notifications.
		//
		// Direct-to-phone SMS publish (PhoneNumber) is an account-level action with
		// no topic/endpoint resource, so IAM requires Resource '*' — it cannot be
		// scoped to an ARN. Push publishes to topic/endpoint ARNs are also covered
		// by this statement.
		this.handler.addToRolePolicy(new PolicyStatement({
			effect: Effect.ALLOW,
			actions: [
				'sns:Publish',
				'sns:SetSMSAttributes',
			],
			resources: ['*'],
		}));
	}
}
