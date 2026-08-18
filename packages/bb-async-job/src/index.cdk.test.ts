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
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Template } from 'aws-cdk-lib/assertions';
import { Scope, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import { AsyncJob, AsyncJobErrors } from './index.cdk.js';

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

// setup() installs its own stack as the ambient CURRENT_BLOCKS_STACK; clear it
// afterwards so no test observes a stack left behind by the previous one (node
// --test isolates files by default, so this is hygiene against future sharing).
afterEach(() => {
	delete (globalThis as any).CURRENT_BLOCKS_STACK;
});

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

test('CDK: maxBatchingWindowSeconds 0 renders an explicit zero window (no batching wait)', () => {
	const { stack, parent } = setup();
	new AsyncJob(parent, 'jobs', { handler: async () => {}, maxBatchingWindowSeconds: 0 });

	const props = eventSourceMapping(Template.fromStack(stack));
	assert.strictEqual(props.MaximumBatchingWindowInSeconds, 0);
});

// ── Option guards ───────────────────────────────────────────────────────────
// AWS rejects these ranges when the event source mapping is created, which
// surfaces as an opaque CloudFormation failure mid-deployment. The constructor
// checks them at synth time instead, naming the offending option and value.

function assertInvalidOption(fn: () => void, option: RegExp, value: RegExp): void {
	assert.throws(fn, (err: Error) => {
		assert.strictEqual(err.name, AsyncJobErrors.InvalidOption);
		assert.match(err.message, option);
		assert.match(err.message, value);
		assert.match(err.message, /AsyncJob "/);
		return true;
	});
}

test('CDK guard: batchSize 0 is rejected', () => {
	const { parent } = setup();
	assertInvalidOption(
		() => new AsyncJob(parent, 'jobs', { handler: async () => {}, batchSize: 0 }),
		/batchSize/,
		/got: 0/
	);
});

test('CDK guard: batchSize 11 is rejected when there is no batching window', () => {
	const { parent } = setup();
	assertInvalidOption(
		() =>
			new AsyncJob(parent, 'jobs', {
				handler: async () => {},
				batchSize: 11,
				maxBatchingWindowSeconds: 0,
			}),
		/batchSize/,
		/got: 11/
	);
});

test('CDK guard: batchSize above 10 is accepted with a batching window', () => {
	const { stack, parent } = setup();
	new AsyncJob(parent, 'jobs', {
		handler: async () => {},
		batchSize: 500,
		maxBatchingWindowSeconds: 30,
	});

	const props = eventSourceMapping(Template.fromStack(stack));
	assert.strictEqual(props.BatchSize, 500);
	assert.strictEqual(props.MaximumBatchingWindowInSeconds, 30);
});

test('CDK guard: batchSize 10001 is rejected even with a batching window', () => {
	const { parent } = setup();
	assertInvalidOption(
		() =>
			new AsyncJob(parent, 'jobs', {
				handler: async () => {},
				batchSize: 10001,
				maxBatchingWindowSeconds: 30,
			}),
		/batchSize/,
		/got: 10001/
	);
});

test('CDK guard: maxBatchingWindowSeconds 301 is rejected', () => {
	const { parent } = setup();
	assertInvalidOption(
		() =>
			new AsyncJob(parent, 'jobs', { handler: async () => {}, maxBatchingWindowSeconds: 301 }),
		/maxBatchingWindowSeconds/,
		/got: 301/
	);
});

test('CDK guard: a negative maxBatchingWindowSeconds is rejected', () => {
	const { parent } = setup();
	assertInvalidOption(
		() => new AsyncJob(parent, 'jobs', { handler: async () => {}, maxBatchingWindowSeconds: -1 }),
		/maxBatchingWindowSeconds/,
		/got: -1/
	);
});

test('CDK guard: a fractional maxBatchingWindowSeconds is rejected', () => {
	const { parent } = setup();
	assertInvalidOption(
		() => new AsyncJob(parent, 'jobs', { handler: async () => {}, maxBatchingWindowSeconds: 2.5 }),
		/maxBatchingWindowSeconds/,
		/got: 2.5/
	);
});

test('CDK guard: NaN maxBatchingWindowSeconds is rejected', () => {
	const { parent } = setup();
	assertInvalidOption(
		() => new AsyncJob(parent, 'jobs', { handler: async () => {}, maxBatchingWindowSeconds: NaN }),
		/maxBatchingWindowSeconds/,
		/got: NaN/
	);
});

test('CDK guard: a fractional batchSize is rejected', () => {
	const { parent } = setup();
	assertInvalidOption(
		() => new AsyncJob(parent, 'jobs', { handler: async () => {}, batchSize: 2.5 }),
		/batchSize/,
		/got: 2.5/
	);
});

test('CDK guard: NaN batchSize is rejected', () => {
	const { parent } = setup();
	assertInvalidOption(
		() => new AsyncJob(parent, 'jobs', { handler: async () => {}, batchSize: NaN }),
		/batchSize/,
		/got: NaN/
	);
});

// ── Visibility timeout ──────────────────────────────────────────────────────
// A message becomes invisible when the poller receives it, which happens before
// the batching window elapses and before the handler runs. The queue's
// visibility timeout must therefore cover the window plus the handler's full
// budget, or SQS redelivers a message that is still being processed.

function jobQueueVisibilityTimeout(template: Template): number {
	const queues = template.findResources('AWS::SQS::Queue');
	const jobQueue = Object.values(queues).find(
		(q: any) => q.Properties.RedrivePolicy !== undefined
	) as any;
	assert.ok(jobQueue, 'the job queue (the one with a redrive policy) should exist');
	return jobQueue.Properties.VisibilityTimeout;
}

test('CDK: visibility timeout covers the Lambda timeout plus the batching window', () => {
	const { stack, parent } = setup();
	new AsyncJob(parent, 'jobs', { handler: async () => {} });

	assert.strictEqual(jobQueueVisibilityTimeout(Template.fromStack(stack)), 905);
});

test('CDK: visibility timeout grows with a larger batching window', () => {
	const { stack, parent } = setup();
	new AsyncJob(parent, 'jobs', { handler: async () => {}, maxBatchingWindowSeconds: 300 });

	assert.strictEqual(jobQueueVisibilityTimeout(Template.fromStack(stack)), 1200);
});

test('CDK: visibility timeout is the bare Lambda timeout with no batching window', () => {
	const { stack, parent } = setup();
	new AsyncJob(parent, 'jobs', {
		handler: async () => {},
		batchSize: 1,
		maxBatchingWindowSeconds: 0,
	});

	assert.strictEqual(jobQueueVisibilityTimeout(Template.fromStack(stack)), 900);
});

test('CDK guard: a valid batchSize + window combination still synthesizes', () => {
	const { stack, parent } = setup();
	new AsyncJob(parent, 'jobs', {
		handler: async () => {},
		batchSize: 10,
		maxBatchingWindowSeconds: 300,
	});

	const props = eventSourceMapping(Template.fromStack(stack));
	assert.strictEqual(props.BatchSize, 10);
	assert.strictEqual(props.MaximumBatchingWindowInSeconds, 300);
	assert.deepStrictEqual(props.FunctionResponseTypes, ['ReportBatchItemFailures']);
});
