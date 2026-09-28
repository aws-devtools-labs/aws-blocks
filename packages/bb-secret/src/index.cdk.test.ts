// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
/**
 * CDK-side tests for Secret: provisions a Secrets Manager secret, honors the
 * removal-policy defaults + per-instance override, does not provision when
 * wrapping an existing secret, grants scoped read/write, and stubs runtime
 * methods with an actionable synth-time error.
 */
import { test } from 'node:test';
import { type BlocksDefaults, BlocksPresets, DEFAULT_NODE_RUNTIME, Scope } from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import type { Construct } from 'constructs';
import { Secret } from './index.cdk.js';

class StubBlocksStack extends cdk.Stack {
	public readonly handler: cdk.aws_lambda.Function;
	public readonly executionRole: cdk.aws_iam.IRole;
	public readonly id: string;
	public defaults: BlocksDefaults = BlocksPresets.production;
	constructor(scope: Construct, id: string) {
		super(scope, id);
		this.id = id;
		(globalThis as unknown as { CURRENT_BLOCKS_STACK: unknown }).CURRENT_BLOCKS_STACK = this;
		this.executionRole = new cdk.aws_iam.Role(this, 'BlocksRole', {
			assumedBy: new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com'),
		});
		this.handler = new cdk.aws_lambda.Function(this, 'StubHandler', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
			role: this.executionRole,
		});
	}
}

function setup(
	defaults: BlocksDefaults = BlocksPresets.production,
	stackId = 'TestStack',
): { stack: StubBlocksStack; parent: Scope } {
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, stackId);
	stack.defaults = defaults;
	const parent = new Scope('app');
	return { stack, parent };
}

test('CDK: default Secret provisions a Secrets Manager secret', () => {
	const { stack, parent } = setup();
	new Secret(parent, 'stripe-key');
	Template.fromStack(stack).resourceCountIs('AWS::SecretsManager::Secret', 1);
});

test('CDK: Secret.fromExisting does NOT provision a secret', () => {
	const { stack, parent } = setup();
	new Secret(parent, 'legacy-key', {
		secret: Secret.fromExisting('arn:aws:secretsmanager:us-east-1:123456789012:secret:legacy-AbCdEf'),
	});
	Template.fromStack(stack).resourceCountIs('AWS::SecretsManager::Secret', 0);
});

test('CDK: Secret.fromExisting returns a branded ref', () => {
	const ref = Secret.fromExisting('arn:aws:secretsmanager:us-east-1:123456789012:secret:x-AbCdEf');
	assert.strictEqual(ref.__brand, 'ExternalSecretRef');
	assert.strictEqual(ref.secretArn, 'arn:aws:secretsmanager:us-east-1:123456789012:secret:x-AbCdEf');
});

test('CDK: secret adopts the sandbox default removal policy (DESTROY)', () => {
	const { stack, parent } = setup(BlocksPresets.sandbox, 'SandboxStack');
	new Secret(parent, 'stripe-key');
	Template.fromStack(stack).hasResource('AWS::SecretsManager::Secret', { DeletionPolicy: 'Delete' });
});

test('CDK: secret adopts the production default removal policy (RETAIN)', () => {
	const { stack, parent } = setup(BlocksPresets.production, 'ProdStack');
	new Secret(parent, 'stripe-key');
	Template.fromStack(stack).hasResource('AWS::SecretsManager::Secret', { DeletionPolicy: 'Retain' });
});

test('CDK: per-block removalPolicy overrides the resolved default', () => {
	const { stack, parent } = setup(BlocksPresets.production, 'OverrideStack');
	new Secret(parent, 'stripe-key', { removalPolicy: 'destroy' });
	Template.fromStack(stack).hasResource('AWS::SecretsManager::Secret', { DeletionPolicy: 'Delete' });
});

test('CDK: grants the execution role GetSecretValue + PutSecretValue', () => {
	const { stack, parent } = setup();
	new Secret(parent, 'stripe-key');
	Template.fromStack(stack).hasResourceProperties('AWS::IAM::Policy', {
		PolicyDocument: {
			Statement: Match.arrayWith([
				Match.objectLike({
					Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
				}),
				Match.objectLike({
					Action: Match.arrayWith(['secretsmanager:PutSecretValue']),
				}),
			]),
		},
	});
});

test('CDK: calling a runtime data method throws an actionable synth-time error', () => {
	const { parent } = setup();
	const secret = new Secret(parent, 'stripe-key') as unknown as Record<string, (k: string) => never>;
	for (const method of ['get', 'put']) {
		assert.throws(
			() => secret[method]('v'),
			/cannot be called during CDK synth/,
			`${method}() should throw the actionable synth-time error`,
		);
	}
});
