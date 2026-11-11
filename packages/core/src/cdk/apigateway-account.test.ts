// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ensureApiGatewayAccount } from './apigateway-account.js';

type EnsureApiGatewayAccount = (stack: cdk.Stack) => unknown;

/**
 * `@aws-blocks/hosting`'s own copy of `ensureApiGatewayAccount` (hosting does
 * not depend on core). It is not on hosting's export map, so it is loaded from
 * the module beside the `./constructs` entry that core already depends on.
 */
async function hostingEnsureApiGatewayAccount(): Promise<EnsureApiGatewayAccount> {
	const constructsEntry = import.meta.resolve('@aws-blocks/hosting/constructs');
	const mod = (await import(new URL('./server_origin.js', constructsEntry).href)) as {
		ensureApiGatewayAccount: EnsureApiGatewayAccount;
	};
	return mod.ensureApiGatewayAccount;
}

/** The rendered properties of each resource type the helper creates, keyed by type. */
function accountResources(ensure: EnsureApiGatewayAccount, env?: cdk.Environment): Record<string, unknown> {
	const stack = new cdk.Stack(new cdk.App(), 'ParityStack', { env });
	ensure(stack);
	const resources = Template.fromStack(stack).toJSON().Resources as Record<string, { Type: string }>;
	return Object.fromEntries(Object.entries(resources).map(([logicalId, r]) => [`${r.Type} ${logicalId}`, r]));
}

describe('ensureApiGatewayAccount', () => {
	test('the CloudWatch role trusts API Gateway with aws:SourceAccount and aws:SourceArn', () => {
		const stack = new cdk.Stack(new cdk.App(), 'ApiGatewayAccountStack');
		ensureApiGatewayAccount(stack);
		Template.fromStack(stack).hasResourceProperties('AWS::IAM::Role', {
			AssumeRolePolicyDocument: {
				Statement: [
					Match.objectLike({
						Effect: 'Allow',
						Action: 'sts:AssumeRole',
						Principal: { Service: 'apigateway.amazonaws.com' },
						Condition: {
							StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } },
							ArnLike: {
								'aws:SourceArn': {
									'Fn::Join': [
										'',
										[
											'arn:',
											{ Ref: 'AWS::Partition' },
											':apigateway:',
											{ Ref: 'AWS::Region' },
											'::*',
										],
									],
								},
							},
						},
					}),
				],
			},
		});
	});

	// The two copies create the same role under the same id and share one
	// `Symbol.for` registry key, so whichever runs first on a stack decides the
	// role's trust. They must stay identical.
	for (const [label, env] of [
		['an environment-agnostic stack', undefined],
		['a stack with an explicit account and region', { account: '123456789012', region: 'eu-west-1' }],
	] as const) {
		test(`matches @aws-blocks/hosting's copy on ${label}`, async () => {
			const hostingEnsure = await hostingEnsureApiGatewayAccount();
			const core = accountResources(ensureApiGatewayAccount, env);
			assert.ok(
				Object.keys(core).some((key) => key.startsWith('AWS::IAM::Role ')),
				'core creates the role',
			);
			assert.deepStrictEqual(accountResources(hostingEnsure, env), core);
		});
	}
});
