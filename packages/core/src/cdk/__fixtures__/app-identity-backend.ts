// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test fixture: a well-behaved app for the `defaults.app` tests. Its one block
 * creates the kinds of resource and role a real Building Block does — a table
 * named from its `fullId` and granted to the shared execution role, a parameter
 * named from its `fullId` (as AppSetting names its default parameter) and
 * granted by literal ARN, a block-owned helper role, and a bucket whose
 * auto-delete provider role CDK adds at stack scope. Nothing reaches outside the
 * app, so the IAM report must list no violations.
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Construct } from 'constructs';
import type { ScopeParent } from '../../common/index.js';
import { Scope } from '../index.js';

class WellBehavedBlock extends Scope {
	constructor(scope: ScopeParent, id: string) {
		super(id, { parent: scope });
		const table = new dynamodb.Table(this, 'table', {
			tableName: this.fullId,
			partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		});
		table.grantReadWriteData(this.executionRole);
		this.executionRole.addToPrincipalPolicy(
			new iam.PolicyStatement({
				actions: ['ssm:GetParameter'],
				resources: [
					cdk.Stack.of(this).formatArn({ service: 'ssm', resource: 'parameter', resourceName: this.fullId }),
				],
			}),
		);
		new iam.Role(this, 'HelperRole', { assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com') });
		new s3.Bucket(this, 'bucket', { autoDeleteObjects: true, removalPolicy: cdk.RemovalPolicy.DESTROY });
		// A layer with no name of its own, like the AWS CLI layer CDK's BucketDeployment adds.
		new lambda.LayerVersion(this, 'layer', { code: lambda.Code.fromAsset(dirname(fileURLToPath(import.meta.url))) });
	}
}

export default function (root: Construct) {
	new WellBehavedBlock(new Scope('app', { parent: root as unknown as ScopeParent }), 'kv');
}
