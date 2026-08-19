// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side tests for Logger.
 *
 * Logger no longer creates its own `/aws/lambda/<fn>` LogGroup (which would
 * collide with the framework-owned handler log group). Instead it reconfigures
 * retention on the single shared group — but ONLY when an explicit
 * `options.retention` is given, so a bare Logger can't clobber a retention set
 * by another Logger or the stack default.
 */
import { test, describe } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Template } from 'aws-cdk-lib/assertions';
import { Scope, DEFAULT_NODE_RUNTIME, BlocksPresets, type BlocksDefaults } from '@aws-blocks/core/cdk';
import { Logger } from './index.cdk.js';

class StubBlocksStack extends cdk.Stack {
	public readonly handler: cdk.aws_lambda.Function;
	public readonly handlerLogGroup: cdk.aws_logs.ILogGroup;
	public readonly id: string;
	public readonly defaults: BlocksDefaults;
	constructor(scope: Construct, id: string, defaults: BlocksDefaults) {
		super(scope, id);
		this.id = id;
		this.defaults = defaults;
		(globalThis as any).CURRENT_BLOCKS_STACK = this;
		// The framework-owned handler log group carries defaults.logRetention,
		// exactly as setupBlocksInfra creates it.
		this.handlerLogGroup = new cdk.aws_logs.LogGroup(this, 'HandlerLogGroup', {
			retention: defaults.logRetention,
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
	const stack = new StubBlocksStack(app, 'LoggerStack', defaults);
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

	test('a bare Logger leaves the stack-wide default retention untouched (no clobber)', () => {
		const { stack, parent } = setup(BlocksPresets.production);
		new Logger(parent, 'log');
		const template = Template.fromStack(stack);
		// Retention is whatever setupBlocksInfra set (production → 365); Logger
		// must not rewrite it.
		template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 365 });
	});

	test('an explicit per-Logger retention overrides the shared group retention', () => {
		const { stack, parent } = setup(BlocksPresets.production);
		new Logger(parent, 'log', { retention: 30 });
		const template = Template.fromStack(stack);
		template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
		// Still one group — the override mutates the shared group, not a new one.
		template.resourceCountIs('AWS::Logs::LogGroup', 1);
	});

	test('the last explicit retention wins; a later bare Logger does not reset it', () => {
		const { stack, parent } = setup(BlocksPresets.production);
		new Logger(parent, 'explicit', { retention: 14 });
		new Logger(parent, 'bare'); // must NOT clobber the 14 above
		const template = Template.fromStack(stack);
		template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 14 });
	});
});
