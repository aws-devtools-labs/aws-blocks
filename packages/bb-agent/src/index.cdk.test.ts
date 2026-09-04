// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side regression tests for the Agent's internal AsyncJob event source.
 *
 * `stream()` submits one job per interactive turn (and a second on HITL resume),
 * so the caller is blocked on that job starting. AsyncJob's defaults
 * (batchSize 10 / maxBatchingWindowSeconds 5) would add up to 5s of SQS
 * batching delay to that human-blocking path, so the Agent opts out at both
 * construction sites. These tests pin the opt-out to the synthesized template:
 * if the defaults are ever inherited again, the latency regression fails here
 * instead of surfacing as a slow agent in production.
 *
 * Must run under `--conditions=cdk`; otherwise the internal BBs resolve to
 * their mock implementations and no CloudFormation resources are produced.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { BlocksStack, BlocksPresets } from '@aws-blocks/core/cdk';
import type { DefaultComputeFactory } from '@aws-blocks/core/cdk/internal';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute/cdk';
import { Agent } from './index.cdk.js';

// Inject LambdaCompute as the stack's default compute, the same way
// @aws-blocks/blocks does for real apps. The Agent builds AsyncJob and Realtime
// internally, both of which resolve `this.compute`, so a handler-only stub
// stack (no default compute) can no longer synthesize it — `BlocksStack.create`
// initializes the default compute the getter resolves to.
const lambdaFactory: DefaultComputeFactory = (root) => new LambdaCompute(root as never, 'DefaultCompute');

const __dirname = dirname(fileURLToPath(import.meta.url));
let handlerPath: string;
let backendPath: string;
let tmpDir: string;

before(() => {
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
	tmpDir = mkdtempSync(join(__dirname, 'tmp-agent-cdk-'));
	handlerPath = join(tmpDir, 'handler.mjs');
	writeFileSync(handlerPath, "export const handler = async () => ({ statusCode: 200, body: '{}' });\n");
	backendPath = join(tmpDir, 'backend.mjs');
	writeFileSync(backendPath, 'export default () => {};\n');
});

after(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

async function synthAgent(id: string): Promise<any> {
	const app = new cdk.App();
	const stack = await BlocksStack.create(app, id, {
		backendHandlerPath: handlerPath,
		backendCDKPath: backendPath,
		defaults: BlocksPresets.production,
		defaultComputeFactory: lambdaFactory,
	});
	new Agent(stack, 'agent', { inferenceOnly: true });

	const mappings = Template.fromStack(stack).findResources('AWS::Lambda::EventSourceMapping');
	const keys = Object.keys(mappings);
	assert.strictEqual(keys.length, 1, 'exactly one event source mapping expected for the agent job');
	return mappings[keys[0]].Properties;
}

test('CDK: the Agent job takes one message per invocation (no batching on the interactive path)', async () => {
	assert.strictEqual((await synthAgent('agent-batch')).BatchSize, 1);
});

test('CDK: the Agent job has no SQS batching window (no added latency for the caller)', async () => {
	assert.strictEqual((await synthAgent('agent-window')).MaximumBatchingWindowInSeconds, 0);
});

test('CDK: the Agent job still reports partial batch failures', async () => {
	assert.deepStrictEqual((await synthAgent('agent-partial')).FunctionResponseTypes, ['ReportBatchItemFailures']);
});
