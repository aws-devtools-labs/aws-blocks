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
	return { stack, parent: new Scope('app') };
}

test('CDK: the construct synthesizes within a stack', () => {
	const { stack, parent } = setup();
	new __BB_CLASS__(parent, 'thing');
	// TODO: once you provision infra, assert it here, e.g.:
	//   Template.fromStack(stack).resourceCountIs('AWS::DynamoDB::Table', 1);
	assert.doesNotThrow(() => Template.fromStack(stack));
});

test('CDK: runtime methods throw during synth (synthGuard)', () => {
	const { parent } = setup();
	const bb = new __BB_CLASS__(parent, 'thing');
	assert.throws(() => (bb as unknown as { echo: (s: string) => never }).echo('x'), /synth/i);
});
