// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Template } from 'aws-cdk-lib/assertions';
import { Scope } from '@aws-blocks/core/cdk';
import { __BB_CLASS__ } from './index.cdk.js';

// Minimal BlocksStack-shaped parent so __BB_CLASS__ can grant IAM on this.handler
// and synth into a real stack. Mirrors the shape a real BlocksStack exposes.
class StubBlocksStack extends cdk.Stack {
	public readonly handler: cdk.aws_lambda.Function;
	public readonly id: string;
	constructor(scope: Construct, id: string) {
		super(scope, id);
		this.id = id;
		(globalThis as { CURRENT_BLOCKS_STACK?: unknown }).CURRENT_BLOCKS_STACK = this;
		this.handler = new cdk.aws_lambda.Function(this, 'StubHandler', {
			runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
			handler: 'index.handler',
			code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
		});
	}
}

function setup(): { stack: StubBlocksStack; parent: Scope } {
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, 'TestStack');
	const parent = new Scope('app');
	return { stack, parent };
}

test('CDK: provisions a DynamoDB table', () => {
	const { stack, parent } = setup();
	new __BB_CLASS__(parent, 'store');
	Template.fromStack(stack).resourceCountIs('AWS::DynamoDB::Table', 1);
});

test('CDK: fromExisting does not provision a table', () => {
	const { stack, parent } = setup();
	new __BB_CLASS__(parent, 'store', { table: __BB_CLASS__.fromExisting('preexisting-123') });
	Template.fromStack(stack).resourceCountIs('AWS::DynamoDB::Table', 0);
});

test('CDK: runtime methods throw during synth (synthGuard)', () => {
	const { parent } = setup();
	const store = new __BB_CLASS__(parent, 'store');
	assert.throws(() => (store as unknown as { get: (k: string) => never }).get('k'), /synth/i);
});
