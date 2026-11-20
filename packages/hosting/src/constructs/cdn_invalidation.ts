// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Lets the server function invalidate the CloudFront distribution after an
 * on-demand revalidation (Next.js `revalidateTag` / `revalidatePath`; the
 * runtime side is `adapters/nextjs_cdn_invalidation.ts`).
 *
 * The distribution's origin depends on the server function, so the function
 * can't reference the distribution id in its environment (a dependency cycle).
 * Instead:
 *
 * - an SSM parameter with a name derived at synth (no reference to the
 *   distribution) holds the distribution id; the function gets the NAME in
 *   `HOSTING_CDN_INVALIDATION_PARAM` and reads the id at the first
 *   revalidation;
 * - the grants live in a standalone IAM policy attached to the function's role.
 *   The function doesn't depend on that policy (it would on the role's default
 *   policy), so the policy can reference the distribution without a cycle.
 *
 * Least privilege: `cloudfront:CreateInvalidation` on this one distribution and
 * `ssm:GetParameter` on this one parameter.
 *
 * @module
 */

import { Stack } from 'aws-cdk-lib';
import type { IDistribution } from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { CDN_INVALIDATION_BASE_PATH_ENV, CDN_INVALIDATION_PARAM_ENV } from '../adapters/shared/cdn_invalidation_env.js';
import { HostingError } from '../hosting_error.js';

/** A server function the invalidation can be wired to. */
export interface CdnInvalidationTarget {
	/** The role the server runs as. */
	readonly role?: iam.IRole;
	/** Add an environment variable to the server. */
	addEnvironment(key: string, value: string): unknown;
}

/** Props for {@link CdnInvalidationConstruct}. */
export interface CdnInvalidationConstructProps {
	/** The distribution to invalidate. */
	readonly distribution: IDistribution;
	/** The server function that runs the revalidation. */
	readonly server: CdnInvalidationTarget;
	/** The app's `basePath` (prefixed to every invalidation path), if any. */
	readonly basePath?: string;
}

/**
 * The SSM parameter, the server's environment and the scoped IAM policy that
 * let the server invalidate one distribution.
 */
export class CdnInvalidationConstruct extends Construct {
	/** The parameter holding the distribution id. */
	readonly parameter: StringParameter;
	/** The policy granting the server the invalidation. */
	readonly policy: iam.Policy;

	constructor(scope: Construct, id: string, props: CdnInvalidationConstructProps) {
		super(scope, id);
		const role = props.server.role;
		if (!role) {
			throw new HostingError('CdnInvalidationRoleMissingError', {
				message:
					'The server function has no execution role, so it cannot be granted the CloudFront invalidation.',
				resolution: 'Give the server function an execution role (the Hosting construct always creates one).',
			});
		}
		const stack = Stack.of(this);

		// Unique per construct path within the stack; built from synth-time
		// strings only, so the server's environment doesn't reference the
		// distribution.
		const parameterName = `/cdk-blocks/hosting/${stack.stackName}/${this.node.addr}/distribution-id`;
		this.parameter = new StringParameter(this, 'DistributionId', {
			parameterName,
			stringValue: props.distribution.distributionId,
			description: 'CloudFront distribution id the server invalidates after an on-demand revalidation.',
		});

		props.server.addEnvironment(CDN_INVALIDATION_PARAM_ENV, parameterName);
		if (props.basePath) props.server.addEnvironment(CDN_INVALIDATION_BASE_PATH_ENV, props.basePath);

		this.policy = new iam.Policy(this, 'Policy', {
			roles: [role],
			statements: [
				new iam.PolicyStatement({
					actions: ['cloudfront:CreateInvalidation'],
					resources: [
						stack.formatArn({
							service: 'cloudfront',
							region: '',
							resource: 'distribution',
							resourceName: props.distribution.distributionId,
						}),
					],
				}),
				new iam.PolicyStatement({
					actions: ['ssm:GetParameter'],
					resources: [this.parameter.parameterArn],
				}),
			],
		});
	}
}
