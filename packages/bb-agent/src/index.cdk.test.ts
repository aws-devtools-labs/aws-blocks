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
import { test } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Template } from 'aws-cdk-lib/assertions';
import { Scope, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import { Agent } from './index.cdk.js';

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

function synthAgent(): any {
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, 'teststack');
	const parent = new Scope('app');
	new Agent(parent, 'agent', { inferenceOnly: true });

	const mappings = Template.fromStack(stack).findResources('AWS::Lambda::EventSourceMapping');
	const keys = Object.keys(mappings);
	assert.strictEqual(keys.length, 1, 'exactly one event source mapping expected for the agent job');
	return mappings[keys[0]].Properties;
}

test('CDK: the Agent job takes one message per invocation (no batching on the interactive path)', () => {
	assert.strictEqual(synthAgent().BatchSize, 1);
});

test('CDK: the Agent job has no SQS batching window (no added latency for the caller)', () => {
	assert.strictEqual(synthAgent().MaximumBatchingWindowInSeconds, 0);
});

test('CDK: the Agent job still reports partial batch failures', () => {
	assert.deepStrictEqual(synthAgent().FunctionResponseTypes, ['ReportBatchItemFailures']);
});
