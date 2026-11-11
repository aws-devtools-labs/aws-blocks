// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ensureApiGatewayAccount } from './apigateway-account.js';

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
});
