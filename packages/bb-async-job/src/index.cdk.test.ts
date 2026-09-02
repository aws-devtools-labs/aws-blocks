// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side tests for AsyncJob's SQS event source.
 *
 * Compute targeting: AsyncJob attaches its SQS event source to `this.compute`'s
 * function rather than the stack's shared handler. By default `this.compute`
 * resolves to the stack's default LambdaCompute, so the event source lands on
 * the same function as before. When a nearer scope assigns a different compute
 * (internal `_compute`, the seam a future customer-facing option will drive),
 * the event source follows it to that compute's function.
 *
 * Mapping regressions: the event source shipped with BatchSize 1 and no
 * partial-batch reporting, so every message cost a full Lambda invocation.
 * Raising the batch size alone is unsafe — without FunctionResponseTypes
 * containing ReportBatchItemFailures, SQS deletes an entire batch when any
 * single record fails. These tests pin both halves of the fix together.
 * (Ported onto the BlocksStack harness: under compute targeting, AsyncJob
 * resolves `this.compute`, so a handler-only stub stack can no longer
 * synthesize it.)
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { BlocksStack, BlocksPresets, Scope } from '@aws-blocks/core/cdk';
import type { DefaultComputeFactory } from '@aws-blocks/core/cdk/internal';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute/cdk';
import { AsyncJob, AsyncJobErrors } from './index.cdk.js';

const lambdaFactory: DefaultComputeFactory = (root) => new LambdaCompute(root as never, 'DefaultCompute');

const __dirname = dirname(fileURLToPath(import.meta.url));
let handlerPath: string;
let backendPath: string;
let tmpDir: string;

before(() => {
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
	tmpDir = mkdtempSync(join(__dirname, 'tmp-async-cdk-'));
	handlerPath = join(tmpDir, 'handler.mjs');
	writeFileSync(handlerPath, "export const handler = async () => ({ statusCode: 200, body: '{}' });\n");
	backendPath = join(tmpDir, 'backend.mjs');
	writeFileSync(backendPath, 'export default () => {};\n');
});

after(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

async function makeStack(id: string): Promise<BlocksStack> {
	const app = new cdk.App();
	return BlocksStack.create(app, id, {
		backendHandlerPath: handlerPath,
		backendCDKPath: backendPath,
		defaults: BlocksPresets.production,
		defaultComputeFactory: lambdaFactory,
	});
}

function fnLogicalId(stack: BlocksStack, compute: LambdaCompute): string {
	return stack.getLogicalId(compute.fn.node.defaultChild as cdk.CfnElement);
}

function eventSourceTargets(template: Template, logicalId: string): boolean {
	return JSON.stringify(template.findResources('AWS::Lambda::EventSourceMapping')).includes(logicalId);
}

describe('AsyncJob compute targeting', () => {
	test('default: SQS event source attaches to the stack default compute function', async () => {
		const stack = await makeStack('AsyncDefault');
		new AsyncJob(stack, 'jobs', { handler: async () => {}, trackStatus: false });

		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
		assert.ok(
			eventSourceTargets(template, fnLogicalId(stack, stack._defaultCompute as LambdaCompute)),
			'event source targets the default compute function',
		);
	});

	test('targeted: event source follows an ancestor scope _compute to that function', async () => {
		const stack = await makeStack('AsyncTargeted');
		const lambdaB = new LambdaCompute(stack, 'LambdaB');
		const scoped = new Scope('scoped', { parent: stack });
		scoped._compute = lambdaB;
		new AsyncJob(scoped, 'jobs', { handler: async () => {}, trackStatus: false });

		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
		assert.ok(eventSourceTargets(template, fnLogicalId(stack, lambdaB)), 'event source targets lambdaB');
		assert.ok(
			!eventSourceTargets(template, fnLogicalId(stack, stack._defaultCompute as LambdaCompute)),
			'event source does NOT target the default compute',
		);
	});
});

// ── Event source mapping properties ─────────────────────────────────────────

function eventSourceMapping(template: Template): any {
	const mappings = template.findResources('AWS::Lambda::EventSourceMapping');
	const keys = Object.keys(mappings);
	assert.strictEqual(keys.length, 1, 'exactly one event source mapping expected');
	return mappings[keys[0]].Properties;
}

describe('AsyncJob event source mapping', () => {
	test('CDK: AsyncJob batches 10 messages per invocation by default', async () => {
		const stack = await makeStack('AsyncBatchDefault');
		new AsyncJob(stack, 'jobs', { handler: async () => {}, trackStatus: false });
		const props = eventSourceMapping(Template.fromStack(stack));
		assert.strictEqual(props.BatchSize, 10);
	});

	test('CDK: AsyncJob enables partial batch failure reporting (prevents silent message loss)', async () => {
		const stack = await makeStack('AsyncPartialBatch');
		new AsyncJob(stack, 'jobs', { handler: async () => {}, trackStatus: false });
		const props = eventSourceMapping(Template.fromStack(stack));
		assert.deepStrictEqual(props.FunctionResponseTypes, ['ReportBatchItemFailures']);
	});

	test('CDK: AsyncJob sets a 5 second batching window by default', async () => {
		const stack = await makeStack('AsyncWindowDefault');
		new AsyncJob(stack, 'jobs', { handler: async () => {}, trackStatus: false });
		const props = eventSourceMapping(Template.fromStack(stack));
		assert.strictEqual(props.MaximumBatchingWindowInSeconds, 5);
	});

	test('CDK: an explicit batchSize still wins over the default', async () => {
		const stack = await makeStack('AsyncBatchExplicit');
		new AsyncJob(stack, 'jobs', { handler: async () => {}, batchSize: 3, trackStatus: false });
		const props = eventSourceMapping(Template.fromStack(stack));
		assert.strictEqual(props.BatchSize, 3);
		// Partial batch reporting stays on even for caller-chosen batch sizes.
		assert.deepStrictEqual(props.FunctionResponseTypes, ['ReportBatchItemFailures']);
	});

	test('CDK: maxBatchingWindowSeconds is overridable', async () => {
		const stack = await makeStack('AsyncWindowOverride');
		new AsyncJob(stack, 'jobs', { handler: async () => {}, maxBatchingWindowSeconds: 30, trackStatus: false });
		const props = eventSourceMapping(Template.fromStack(stack));
		assert.strictEqual(props.MaximumBatchingWindowInSeconds, 30);
	});

	test('CDK: maxBatchingWindowSeconds 0 renders an explicit zero window (no batching wait)', async () => {
		const stack = await makeStack('AsyncWindowZero');
		new AsyncJob(stack, 'jobs', { handler: async () => {}, maxBatchingWindowSeconds: 0, trackStatus: false });
		const props = eventSourceMapping(Template.fromStack(stack));
		assert.strictEqual(props.MaximumBatchingWindowInSeconds, 0);
	});

	test('CDK guard: a valid batchSize + window combination still synthesizes', async () => {
		const stack = await makeStack('AsyncValidCombo');
		new AsyncJob(stack, 'jobs', {
			handler: async () => {},
			batchSize: 10,
			maxBatchingWindowSeconds: 300,
			trackStatus: false,
		});
		const props = eventSourceMapping(Template.fromStack(stack));
		assert.strictEqual(props.BatchSize, 10);
		assert.strictEqual(props.MaximumBatchingWindowInSeconds, 300);
		assert.deepStrictEqual(props.FunctionResponseTypes, ['ReportBatchItemFailures']);
	});

	test('CDK guard: batchSize above 10 is accepted with a batching window', async () => {
		const stack = await makeStack('AsyncBigBatch');
		new AsyncJob(stack, 'jobs', {
			handler: async () => {},
			batchSize: 500,
			maxBatchingWindowSeconds: 30,
			trackStatus: false,
		});
		const props = eventSourceMapping(Template.fromStack(stack));
		assert.strictEqual(props.BatchSize, 500);
		assert.strictEqual(props.MaximumBatchingWindowInSeconds, 30);
	});
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

describe('AsyncJob option guards', () => {
	test('CDK guard: batchSize 0 is rejected', async () => {
		const stack = await makeStack('AsyncGuardZero');
		assertInvalidOption(
			() => new AsyncJob(stack, 'jobs', { handler: async () => {}, batchSize: 0, trackStatus: false }),
			/batchSize/,
			/got: 0/,
		);
	});

	test('CDK guard: batchSize 11 is rejected when there is no batching window', async () => {
		const stack = await makeStack('AsyncGuardNoWindow');
		assertInvalidOption(
			() =>
				new AsyncJob(stack, 'jobs', {
					handler: async () => {},
					batchSize: 11,
					maxBatchingWindowSeconds: 0,
					trackStatus: false,
				}),
			/batchSize/,
			/got: 11/,
		);
	});

	test('CDK guard: batchSize 10001 is rejected even with a batching window', async () => {
		const stack = await makeStack('AsyncGuardHuge');
		assertInvalidOption(
			() =>
				new AsyncJob(stack, 'jobs', {
					handler: async () => {},
					batchSize: 10001,
					maxBatchingWindowSeconds: 30,
					trackStatus: false,
				}),
			/batchSize/,
			/got: 10001/,
		);
	});

	test('CDK guard: maxBatchingWindowSeconds 301 is rejected', async () => {
		const stack = await makeStack('AsyncGuardWindow301');
		assertInvalidOption(
			() => new AsyncJob(stack, 'jobs', { handler: async () => {}, maxBatchingWindowSeconds: 301, trackStatus: false }),
			/maxBatchingWindowSeconds/,
			/got: 301/,
		);
	});

	test('CDK guard: a negative maxBatchingWindowSeconds is rejected', async () => {
		const stack = await makeStack('AsyncGuardWindowNeg');
		assertInvalidOption(
			() => new AsyncJob(stack, 'jobs', { handler: async () => {}, maxBatchingWindowSeconds: -1, trackStatus: false }),
			/maxBatchingWindowSeconds/,
			/got: -1/,
		);
	});

	test('CDK guard: a fractional maxBatchingWindowSeconds is rejected', async () => {
		const stack = await makeStack('AsyncGuardWindowFrac');
		assertInvalidOption(
			() => new AsyncJob(stack, 'jobs', { handler: async () => {}, maxBatchingWindowSeconds: 2.5, trackStatus: false }),
			/maxBatchingWindowSeconds/,
			/got: 2.5/,
		);
	});

	test('CDK guard: NaN maxBatchingWindowSeconds is rejected', async () => {
		const stack = await makeStack('AsyncGuardWindowNaN');
		assertInvalidOption(
			() => new AsyncJob(stack, 'jobs', { handler: async () => {}, maxBatchingWindowSeconds: NaN, trackStatus: false }),
			/maxBatchingWindowSeconds/,
			/got: NaN/,
		);
	});

	test('CDK guard: a fractional batchSize is rejected', async () => {
		const stack = await makeStack('AsyncGuardBatchFrac');
		assertInvalidOption(
			() => new AsyncJob(stack, 'jobs', { handler: async () => {}, batchSize: 2.5, trackStatus: false }),
			/batchSize/,
			/got: 2.5/,
		);
	});

	test('CDK guard: NaN batchSize is rejected', async () => {
		const stack = await makeStack('AsyncGuardBatchNaN');
		assertInvalidOption(
			() => new AsyncJob(stack, 'jobs', { handler: async () => {}, batchSize: NaN, trackStatus: false }),
			/batchSize/,
			/got: NaN/,
		);
	});
});

// ── Visibility timeout ──────────────────────────────────────────────────────
// A message becomes invisible when the poller receives it, which happens before
// the batching window elapses and before the handler runs. The queue's
// visibility timeout must therefore cover the window plus the handler's full
// budget, or SQS redelivers a message that is still being processed.

function jobQueueVisibilityTimeout(template: Template): number {
	const queues = template.findResources('AWS::SQS::Queue');
	const jobQueue = Object.values(queues).find((q: any) => q.Properties.RedrivePolicy !== undefined) as any;
	assert.ok(jobQueue, 'the job queue (the one with a redrive policy) should exist');
	return jobQueue.Properties.VisibilityTimeout;
}

describe('AsyncJob visibility timeout', () => {
	test('CDK: visibility timeout covers the Lambda timeout plus the batching window', async () => {
		const stack = await makeStack('AsyncVisDefault');
		new AsyncJob(stack, 'jobs', { handler: async () => {}, trackStatus: false });
		assert.strictEqual(jobQueueVisibilityTimeout(Template.fromStack(stack)), 905);
	});

	test('CDK: visibility timeout grows with a larger batching window', async () => {
		const stack = await makeStack('AsyncVisGrow');
		new AsyncJob(stack, 'jobs', { handler: async () => {}, maxBatchingWindowSeconds: 300, trackStatus: false });
		assert.strictEqual(jobQueueVisibilityTimeout(Template.fromStack(stack)), 1200);
	});

	test('CDK: visibility timeout is the bare Lambda timeout with no batching window', async () => {
		const stack = await makeStack('AsyncVisBare');
		new AsyncJob(stack, 'jobs', {
			handler: async () => {},
			batchSize: 1,
			maxBatchingWindowSeconds: 0,
			trackStatus: false,
		});
		assert.strictEqual(jobQueueVisibilityTimeout(Template.fromStack(stack)), 900);
	});
});
