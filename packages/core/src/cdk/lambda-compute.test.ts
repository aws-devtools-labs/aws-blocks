// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal unit tests for the compute abstraction.
 *
 * LambdaCompute is not yet instantiated by the default app and is not reachable
 * by customers. These tests exercise it directly through the internal path to
 * pin its shape: function + gateway, shared role, owner-scoped registry
 * self-registration, and owner-derived identity.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { BlocksBackend } from './blocks-backend.js';
import { Scope } from './index.js';
import { ComputeBlock, LambdaCompute } from './internal.js';

before(() => {
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const handlerPath = join(__dirname, '__fixtures__', 'handler.js');
const sideEffectBackendPath = join(__dirname, '__fixtures__', 'side-effect-backend.js');

async function makeBackend(stackId: string): Promise<{ backend: BlocksBackend; stack: cdk.Stack }> {
	const app = new cdk.App();
	const stack = new cdk.Stack(app, stackId);
	const backend = await BlocksBackend.create(stack, 'Blocks', {
		backendHandlerPath: handlerPath,
		backendCDKPath: sideEffectBackendPath,
	});
	return { backend, stack };
}

describe('LambdaCompute (internal)', () => {
	test('provisions a Lambda function and its own API Gateway', async () => {
		const { stack } = await makeBackend('LambdaComputeShape');

		const compute = new LambdaCompute(new Scope('app'), 'extra');

		assert.ok(compute.fn, 'LambdaCompute should expose .fn');
		assert.ok(compute.apiGateway, 'LambdaCompute should expose .apiGateway');
		assert.ok(compute instanceof ComputeBlock, 'LambdaCompute should be a ComputeBlock');

		const template = Template.fromStack(stack);
		// Two REST APIs: the default backend's, plus this compute's. (Function
		// count also includes CDK-managed helper Lambdas — BucketDeployment,
		// S3 auto-delete — so we assert on the two Blocks handlers via their
		// shared role below rather than a raw function count.)
		template.resourceCountIs('AWS::ApiGateway::RestApi', 2);

		const roles = template.findResources('AWS::IAM::Role');
		const blocksRoleId = Object.keys(roles).find(k => k.includes('BlocksRole'));
		const fns = template.findResources('AWS::Lambda::Function');
		const blocksFns = Object.values(fns).filter(
			(fn: any) => fn.Properties?.Role?.['Fn::GetAtt']?.[0] === blocksRoleId,
		);
		assert.strictEqual(blocksFns.length, 2, 'default handler + compute function on the shared role');
	});

	test('the function assumes the shared execution role', async () => {
		const { backend, stack } = await makeBackend('LambdaComputeRole');

		const compute = new LambdaCompute(new Scope('app'), 'extra');

		// The compute resolves the same shared role the default handler uses.
		assert.strictEqual(compute.executionRole, backend.executionRole);

		const template = Template.fromStack(stack);
		const roles = template.findResources('AWS::IAM::Role');
		const blocksRoleId = Object.keys(roles).find(k => k.includes('BlocksRole'));
		assert.ok(blocksRoleId, 'expected the shared BlocksRole');
		// The default handler and the compute's function both reference the
		// shared role (CDK-managed helper Lambdas have their own roles).
		const fns = template.findResources('AWS::Lambda::Function');
		const onSharedRole = Object.values(fns).filter(
			(fn: any) => fn.Properties?.Role?.['Fn::GetAtt']?.[0] === blocksRoleId,
		);
		assert.strictEqual(
			onSharedRole.length,
			2,
			'default handler + compute function should assume the shared BlocksRole',
		);
	});

	test('multiple computes under one backend get distinct construct paths', async () => {
		const { stack } = await makeBackend('LambdaComputeMultiple');

		const scope = new Scope('app');
		const a = new LambdaCompute(scope, 'a');
		const b = new LambdaCompute(scope, 'b');

		assert.notStrictEqual(a.node.path, b.node.path, 'distinct ids → distinct construct paths');
		// Both synthesize without a logical-id collision.
		assert.doesNotThrow(() => Template.fromStack(stack));
	});

	test('setEnv adds an environment variable to the function', async () => {
		const { stack } = await makeBackend('LambdaComputeSetEnv');

		const compute = new LambdaCompute(new Scope('app'), 'extra');
		compute.setEnv('BLOCKS_THING', 'value-123');

		const template = Template.fromStack(stack);
		template.hasResourceProperties('AWS::Lambda::Function', {
			Environment: { Variables: { BLOCKS_THING: 'value-123' } },
		});
	});

	test('derives BLOCKS_STACK_NAME from the owner (matches the default handler)', async () => {
		const { backend, stack } = await makeBackend('LambdaComputeStackName');

		new LambdaCompute(new Scope('app'), 'extra');

		// The compute's function must agree with the owner's token-free identity,
		// exactly like the default handler — otherwise the runtime derives
		// physical resource names that were never created.
		const template = Template.fromStack(stack);
		const fns = template.findResources('AWS::Lambda::Function');
		const computeFnId = Object.keys(fns).find(k => k.includes('extra'));
		assert.ok(computeFnId, 'expected the compute function in the template');
		assert.strictEqual(
			fns[computeFnId].Properties.Environment.Variables.BLOCKS_STACK_NAME,
			backend.fullId,
		);
	});

	test('throws when created outside a BlocksStack/BlocksBackend', () => {
		// With no real BlocksStack/BlocksBackend in the tree or as the ambient
		// owner (a plain cdk.Stack exposes none of backendHandlerPath / a Blocks
		// identity), the compute cannot derive its entry or BLOCKS_STACK_NAME and
		// fails at construction.
		const app = new cdk.App();
		const bareStack = new cdk.Stack(app, 'BareStack');
		(globalThis as any).CURRENT_BLOCKS_STACK = bareStack;

		assert.throws(() => new LambdaCompute(new Scope('app'), 'orphan'));
	});
});
