// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test fixture: an app whose code (as an AI coding agent might write it)
 * reaches outside itself in every way the `defaults.app` rules catch — a grant
 * on another app's parameter, a wildcard grant on a data service, an AWS
 * managed policy that reaches every app, and its own `Tags.of(...)` call
 * claiming to be another app.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import type { ScopeParent } from '../../common/index.js';
import { Scope } from '../index.js';

class OverreachingBlock extends Scope {
	constructor(scope: ScopeParent, id: string) {
		super(id, { parent: scope });
		const stack = cdk.Stack.of(this);
		this.executionRole.addToPrincipalPolicy(
			new iam.PolicyStatement({
				sid: 'OtherAppsSecret',
				actions: ['ssm:GetParameter'],
				resources: [stack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: 'appb-db-password' })],
			}),
		);
		this.executionRole.addToPrincipalPolicy(
			new iam.PolicyStatement({ sid: 'EveryTable', actions: ['dynamodb:GetItem'], resources: ['*'] }),
		);
		new iam.Role(this, 'AdminRole', {
			assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
			managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')],
		});
		cdk.Tags.of(stack).add('app', 'appb');
	}
}

export default function (root: Construct) {
	new OverreachingBlock(new Scope('app', { parent: root as unknown as ScopeParent }), 'kv');
}
