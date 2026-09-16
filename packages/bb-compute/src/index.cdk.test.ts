// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Verifies the generic `Compute` block selects the correct backing compute from
 * capability attributes and returns the concrete, branded instance (not a
 * wrapper) — so the framework's delivery logic recognizes it.
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
	// The default compute is irrelevant to these selection tests; a tiny stub with
	// the members the stack's accessors touch keeps create() happy.
	return new LambdaCompute(root as never, 'DefaultCompute');
}

async function makeStack(): Promise<cdk.Stack> {
	const app = new cdk.App();
	// A real BlocksStack so `new Compute(stack, ...)` has a proper root, VPC
	// registry, and compute registry.
	const stack = await BlocksStack.create(app, 'ComputeSelStack', {
		backendHandlerPath: `${process.cwd()}/dist/index.cdk.js`,
		backendCDKPath: `${process.cwd()}/dist/index.cdk.js`,
		defaults: BlocksPresets.production,
		defaultComputeFactory: stubFactory as never,
	} as never);
	return stack as unknown as cdk.Stack;
}

describe('Compute — capability-driven selection', () => {
	test('a modest workload selects a LambdaCompute', async () => {
		const stack = await makeStack();
		const c = new Compute(stack as never, 'lambda-ish', { memory: 512 });
		assert.ok(LambdaCompute.isLambdaCompute(c), 'should be a LambdaCompute');
		assert.ok(!ContainerCompute.isContainerCompute(c), 'should not be a ContainerCompute');
	});

	test('a long timeout selects a ContainerCompute', async () => {
		const stack = await makeStack();
		const c = new Compute(stack as never, 'long', { timeoutSeconds: 1800 });
		assert.ok(ContainerCompute.isContainerCompute(c), 'over-15-min budget → container');
	});

	test('longLived selects a ContainerCompute', async () => {
		const stack = await makeStack();
		const c = new Compute(stack as never, 'lived', { longLived: true });
		assert.ok(ContainerCompute.isContainerCompute(c), 'long-lived → container');
	});

	test('an explicit cpu request selects a ContainerCompute', async () => {
		const stack = await makeStack();
		const c = new Compute(stack as never, 'cpu', { cpu: 1024 });
		assert.ok(ContainerCompute.isContainerCompute(c), 'explicit cpu → container');
	});
});
