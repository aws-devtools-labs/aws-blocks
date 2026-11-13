// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Annotations, Stack } from 'aws-cdk-lib';
import { BuildingBlockScope, isSandboxContext, synthGuard } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import type { IConstruct } from 'constructs';

// Re-export public types and errors (no runtime dependencies)
export { EmailErrors } from './errors.js';
export type { EmailOptions, EmailMessage, SendResult, SendBatchResult } from './types.js';

import type { EmailOptions } from './types.js';
import { BB_NAME } from './version.js';
import { reservedDomainOf, resolveMaxBatchSize } from './validation.js';

/**
 * Synth warning id for a `fromAddress` on a reserved domain (RFC 2606 / RFC 6761),
 * such as `example.com` or anything under `.invalid`. Such a domain can never be
 * verified as an SES identity, so every send fails with `DomainNotVerifiedException`.
 * Acknowledge it with `Annotations.of(scope).acknowledgeWarning(id)` when the
 * sender is deliberate (for example a stack that never sends).
 */
const UNVERIFIABLE_SENDER_WARNING_ID = '@aws-blocks/bb-email-client:UnverifiableSender';
/**
 * Synth warning id for a `replyTo` address on a reserved domain: replies to it
 * can never be delivered. Acknowledge it the same way.
 */
const UNDELIVERABLE_REPLY_TO_WARNING_ID = '@aws-blocks/bb-email-client:UndeliverableReplyTo';

/**
 * Flag a sender or reply-to address on a reserved domain. A warning, not an
 * error, on every stage: the app still synthesizes and the local mock still
 * works, but the message says that sends will fail once deployed.
 */
function warnOnReservedDomains(scope: IConstruct, options: EmailOptions): void {
	const stage = isSandboxContext(scope) ? 'this sandbox' : 'production';
	const senderDomain = reservedDomainOf(options.fromAddress);
	if (senderDomain) {
		Annotations.of(scope).addWarningV2(
			UNVERIFIABLE_SENDER_WARNING_ID,
			`EmailClient fromAddress ${JSON.stringify(options.fromAddress)} is on the reserved domain "${senderDomain}", ` +
				'which can never be verified as an SES identity, so every send from it fails in ' +
				`${stage} with DomainNotVerifiedException. Set fromAddress to an address on a domain you have ` +
				'verified in SES (https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html), or ' +
				'acknowledge this warning if the stack never sends email.',
		);
	}
	const reservedReplyTo = (options.replyTo ?? []).filter((address) => reservedDomainOf(address));
	if (reservedReplyTo.length > 0) {
		Annotations.of(scope).addWarningV2(
			UNDELIVERABLE_REPLY_TO_WARNING_ID,
			`EmailClient replyTo ${reservedReplyTo.map((a) => JSON.stringify(a)).join(', ')} is on a reserved ` +
				'domain, so replies to it can never be delivered. Use a reply-to address on a real domain, or ' +
				'acknowledge this warning if that is intended.',
		);
	}
}

export class EmailClient extends BuildingBlockScope {
	constructor(scope: ScopeParent, id: string, options: EmailOptions) {
		super(id, { parent: scope, bbName: BB_NAME, vpc: { interfaceEndpoints: [ec2.InterfaceVpcEndpointAwsService.SES] } });
		// Fail at synth on a bad maxBatchSize rather than at the first sendBatch() call.
		resolveMaxBatchSize(options.maxBatchSize);

		warnOnReservedDomains(this, options);

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
		// Scoped to this account's SES identities rather than '*', in this stack's
		// region and partition: the runtime SES client uses the Lambda's own region,
		// so no other region is ever called.
		// Only the two SESv2 actions the runtime calls: send() uses SendEmail and
		// sendBatch() uses SendBulkEmail with an inline template. No raw-MIME or
		// stored-template sends are made, so those actions are not granted.
		this.executionRole.addToPrincipalPolicy(new PolicyStatement({
			effect: Effect.ALLOW,
			actions: [
				'ses:SendEmail',
				'ses:SendBulkEmail',
			],
			resources: [
				Stack.of(this).formatArn({ service: 'ses', resource: 'identity', resourceName: '*' }),
				Stack.of(this).formatArn({ service: 'ses', resource: 'configuration-set', resourceName: '*' }),
			],
		}));
	}

	// Runtime-only methods throw during synth (see `synthGuard` in `@aws-blocks/core/cdk`).
	send(..._args: unknown[]): never { return synthGuard('EmailClient', 'send'); }
	sendBatch(..._args: unknown[]): never { return synthGuard('EmailClient', 'sendBatch'); }
}
