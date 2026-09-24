// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Verifies the generic `Compute` block returns the concrete, branded backing
 * compute for the stated `type` (not a wrapper) — so the framework's delivery
 * logic recognizes it.
 *
 * Runs under `--conditions=cdk` so the compute packages resolve their CDK
 * entries (real constructs) rather than the mock stubs.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import { BlocksStack, BlocksPresets } from '@aws-blocks/core/cdk';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute/cdk';
import { ContainerCompute } from '@aws-blocks/bb-container-compute/cdk';
import { Compute } from './index.cdk.js';

/** A minimal stub compute so BlocksStack.create wires a default without pulling the real one. */
function stubFactory(root: unknown): unknown {
	return new LambdaCompute(root as never, 'DefaultCompute');
}

async function makeStack(): Promise<cdk.Stack> {
	const app = new cdk.App();
	const stack = await BlocksStack.create(app, 'ComputeSelStack', {
		backendHandlerPath: `${process.cwd()}/dist/index.cdk.js`,
		backendCDKPath: `${process.cwd()}/dist/index.cdk.js`,
		defaults: BlocksPresets.production,
		defaultComputeFactory: stubFactory as never,
	} as never);
	return stack as unknown as cdk.Stack;
}

describe('Compute — explicit type selection', () => {
	test("type: 'serverless' returns a LambdaCompute", async () => {
		const stack = await makeStack();
		const c = new Compute(stack as never, 'api', { type: 'serverless', memory: 512 });
		assert.ok(LambdaCompute.isLambdaCompute(c), 'should be a LambdaCompute');
		assert.ok(!ContainerCompute.isContainerCompute(c), 'should not be a ContainerCompute');
	});

	test("type: 'container' returns a ContainerCompute", async () => {
		const stack = await makeStack();
		const c = new Compute(stack as never, 'worker', { type: 'container', size: { vcpu: 1, memory: 2048 } });
		assert.ok(ContainerCompute.isContainerCompute(c), 'should be a ContainerCompute');
		assert.ok(!LambdaCompute.isLambdaCompute(c), 'should not be a LambdaCompute');
	});

	test('container carries its vcpu for per-CPU concurrency math', async () => {
		const stack = await makeStack();
		const c = new Compute(stack as never, 'worker2', { type: 'container', size: { vcpu: 2, memory: 4096 } }) as unknown as {
			vcpu: number;
		};
		assert.strictEqual(c.vcpu, 2);
	});
});
