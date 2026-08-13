// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side regression tests for AsyncJob's SQS event source mapping.
 *
 * History: the event source shipped with BatchSize 1 and no partial-batch
 * reporting, so every message cost a full Lambda invocation. Raising the batch
 * size alone is unsafe — without FunctionResponseTypes containing
 * ReportBatchItemFailures, SQS deletes an entire batch when any single record
 * fails. These tests pin both halves of the fix together.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Template } from 'aws-cdk-lib/assertions';
import { Scope, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import { AsyncJob } from './index.cdk.js';

class StubBlocksStack extends cdk.Stack {
	public readonly handler: cdk.aws_lambda.Function;
	public readonly id: string;
	constructor(scope: Construct, id: string) {
		super(scope, id);
		this.id = id;
		(globalThis as any).CURRENT_BLOCKS_STACK = this;
		this.handler = new cdk.aws_lambda.Function(this, 'StubHandler', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
		});
	}
}

function setup(): { stack: StubBlocksStack; parent: Scope } {
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, 'teststack');
	const parent = new Scope('app');
	return { stack, parent };
}

function eventSourceMapping(template: Template): any {
	const mappings = template.findResources('AWS::Lambda::EventSourceMapping');
	const keys = Object.keys(mappings);
	assert.strictEqual(keys.length, 1, 'exactly one event source mapping expected');
	return mappings[keys[0]].Properties;
}

test('CDK: AsyncJob batches 10 messages per invocation by default', () => {
	const { stack, parent } = setup();
	new AsyncJob(parent, 'jobs', { handler: async () => {} });

	const props = eventSourceMapping(Template.fromStack(stack));
	assert.strictEqual(props.BatchSize, 10);
});

test('CDK: AsyncJob enables partial batch failure reporting (prevents silent message loss)', () => {
	const { stack, parent } = setup();
	new AsyncJob(parent, 'jobs', { handler: async () => {} });

	const props = eventSourceMapping(Template.fromStack(stack));
	assert.deepStrictEqual(props.FunctionResponseTypes, ['ReportBatchItemFailures']);
});

test('CDK: AsyncJob sets a 5 second batching window by default', () => {
	const { stack, parent } = setup();
	new AsyncJob(parent, 'jobs', { handler: async () => {} });

	const props = eventSourceMapping(Template.fromStack(stack));
	assert.strictEqual(props.MaximumBatchingWindowInSeconds, 5);
});

test('CDK: an explicit batchSize still wins over the default', () => {
	const { stack, parent } = setup();
	new AsyncJob(parent, 'jobs', { handler: async () => {}, batchSize: 3 });

	const props = eventSourceMapping(Template.fromStack(stack));
	assert.strictEqual(props.BatchSize, 3);
	// Partial batch reporting stays on even for caller-chosen batch sizes.
	assert.deepStrictEqual(props.FunctionResponseTypes, ['ReportBatchItemFailures']);
});

test('CDK: maxBatchingWindowSeconds is overridable', () => {
	const { stack, parent } = setup();
	new AsyncJob(parent, 'jobs', { handler: async () => {}, maxBatchingWindowSeconds: 30 });

	const props = eventSourceMapping(Template.fromStack(stack));
	assert.strictEqual(props.MaximumBatchingWindowInSeconds, 30);
});

test('CDK: maxBatchingWindowSeconds 0 disables the batching window', () => {
	const { stack, parent } = setup();
	new AsyncJob(parent, 'jobs', { handler: async () => {}, maxBatchingWindowSeconds: 0 });

	const props = eventSourceMapping(Template.fromStack(stack));
	assert.ok(
		props.MaximumBatchingWindowInSeconds === undefined || props.MaximumBatchingWindowInSeconds === 0,
		`expected no batching window, got ${props.MaximumBatchingWindowInSeconds}`
	);
});

test('CDK: reportBatchItemFailures can be opted out of explicitly', () => {
	const { stack, parent } = setup();
	new AsyncJob(parent, 'jobs', { handler: async () => {}, reportBatchItemFailures: false });

	const props = eventSourceMapping(Template.fromStack(stack));
	assert.strictEqual(props.FunctionResponseTypes, undefined);
});
