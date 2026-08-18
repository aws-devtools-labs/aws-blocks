// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side tests for Logger.
 *
 * Logger no longer creates its own `/aws/lambda/<fn>` LogGroup (which would
 * collide with the framework-owned handler log group). Instead it reconfigures
 * retention on the single shared group, resolving
 * `options.retention ?? scope.defaults.logRetention`.
 */
import { test, describe } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Template } from 'aws-cdk-lib/assertions';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Scope, DEFAULT_NODE_RUNTIME, BlocksPresets, type BlocksDefaults } from '@aws-blocks/core/cdk';
import { Logger } from './index.cdk.js';

class StubBlocksStack extends cdk.Stack {
	public readonly handler: cdk.aws_lambda.Function;
	public readonly handlerLogGroup: cdk.aws_logs.ILogGroup;
	public readonly id: string;
	public defaults: BlocksDefaults = BlocksPresets.production;
	constructor(scope: Construct, id: string) {
		super(scope, id);
		this.id = id;
		(globalThis as any).CURRENT_BLOCKS_STACK = this;
		// The framework-owned handler log group carries defaults.logRetention.
		this.handlerLogGroup = new cdk.aws_logs.LogGroup(this, 'HandlerLogGroup', {
			retention: this.defaults.logRetention,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		});
		this.handler = new cdk.aws_lambda.Function(this, 'StubHandler', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
			logGroup: this.handlerLogGroup,
		});
	}
}

function setup(defaults: BlocksDefaults = BlocksPresets.production): { stack: StubBlocksStack; parent: Scope } {
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, 'LoggerStack');
	stack.defaults = defaults;
	const parent = new Scope('app');
	return { stack, parent };
}

describe('Logger CDK retention', () => {
	test('does not create a second (colliding) log group', () => {
		const { stack, parent } = setup();
		new Logger(parent, 'log', { level: 'info' });
		const template = Template.fromStack(stack);
		// Only the framework-owned handler log group exists.
		template.resourceCountIs('AWS::Logs::LogGroup', 1);
	});

	test('leaves the stack-wide default retention when no per-Logger retention is set', () => {
		const { stack, parent } = setup(BlocksPresets.production);
		new Logger(parent, 'log');
		const template = Template.fromStack(stack);
		template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 365 });
	});

	test('a per-Logger retention overrides the shared group retention', () => {
		const { stack, parent } = setup(BlocksPresets.production);
		new Logger(parent, 'log', { retention: 30 });
		const template = Template.fromStack(stack);
		template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
		// Still one group — the override mutates the shared group, not a new one.
		template.resourceCountIs('AWS::Logs::LogGroup', 1);
	});

	test('sandbox default retention (one week) applies via the shared group', () => {
		const { stack, parent } = setup(BlocksPresets.sandbox);
		new Logger(parent, 'log');
		const template = Template.fromStack(stack);
		template.hasResourceProperties('AWS::Logs::LogGroup', {
			RetentionInDays: RetentionDays.ONE_WEEK,
		});
	});
});
