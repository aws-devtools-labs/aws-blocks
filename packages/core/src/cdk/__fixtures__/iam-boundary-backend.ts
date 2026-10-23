// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test fixture: a backend module whose single "block" creates the three kinds of
 * IAM role a real Building Block can cause, so the permissions-boundary tests can
 * assert every one of them is capped:
 *
 * 1. A grant onto the shared execution role (`table.grantReadWriteData`), like
 *    every data block — this is also the statement the IAM report must list.
 * 2. A block-owned helper role inside the block's own scope, like
 *    bb-knowledge-base's Bedrock service role.
 * 3. A role CDK creates at **stack** scope on the block's behalf — the
 *    `Custom::S3AutoDeleteObjects` singleton provider a FileBucket triggers. In a
 *    `BlocksBackend` this lands outside the backend's construct subtree.
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { ScopeParent } from '../../common/index.js';
import { Scope } from '../index.js';

class FakeDataBlock extends Scope {
	constructor(scope: ScopeParent, id: string) {
		super(id, { parent: scope });
		const table = new dynamodb.Table(this, 'table', {
			partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		});
		table.grantReadWriteData(this.executionRole);
		new iam.Role(this, 'HelperRole', { assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com') });
		new s3.Bucket(this, 'bucket', { autoDeleteObjects: true, removalPolicy: cdk.RemovalPolicy.DESTROY });
	}
}

export default function (root: Construct) {
	new FakeDataBlock(root as unknown as ScopeParent, 'kv');
}
