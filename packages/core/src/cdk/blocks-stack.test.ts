// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';
import type { ScopeParent } from '../common/index.js';
import { BLOCKS_RPC_PREFIX } from '../constants.js';
import { BlocksBackend } from './blocks-backend.js';
import { Compute } from './compute/compute.js';
import { getComputes } from './compute/compute-registry.js';
import type { DefaultComputeFactory } from './compute/default-compute-factory.js';
import { BlocksStack, BlocksPresets, Scope } from './index.js';

// A real app gets its default compute from @aws-blocks/bb-lambda-compute (via
// @aws-blocks/blocks), which core's own tests can't depend on. Use an
// equivalent inline stub: a Compute that owns a NodejsFunction + API Gateway,
// so create() can build the default and the handler/gateway/apiUrl accessors
// and synth-shape assertions have something real to resolve to. It is passed to
// each create() via the internal `defaultComputeFactory` option (see makeStack /
// makeBackend), exactly as @aws-blocks/blocks injects LambdaCompute.
class StubLambdaCompute extends Compute {
	readonly fn: lambda.NodejsFunction;
	readonly apiGateway: apigateway.RestApi;
	readonly apiUrl: string;
	readonly logGroup: cdk.aws_logs.LogGroup;

	constructor(scope: ScopeParent, id: string) {
		super(id, { parent: scope });
		this.logGroup = new cdk.aws_logs.LogGroup(this, 'HandlerLogGroup', {
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		});
		this.fn = new lambda.NodejsFunction(this, 'Handler', {
			entry: this.backendHandlerPath,
			runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
			handler: 'handler',
			role: this.executionRole,
			logGroup: this.logGroup,
			environment: { BLOCKS_STACK_NAME: this.backendStackName },
			bundling: { minify: true, esbuildArgs: { '--conditions': 'aws-runtime' } },
		});
		this.apiGateway = new apigateway.RestApi(this, 'API', { restApiName: 'Blocks API' });
		this.apiGateway.root.addProxy({
			defaultIntegration: new apigateway.LambdaIntegration(this.fn),
			anyMethod: true,
		});
		this.apiUrl = `${this.apiGateway.url}${BLOCKS_RPC_PREFIX.slice(1)}`;
	}

	setEnv(key: string, value: string): void {
		this.fn.addEnvironment(key, value);
	}
}

const stubComputeFactory: DefaultComputeFactory = (root) => new StubLambdaCompute(root as never, 'DefaultCompute');

// Simulate the CDK condition being active (tests import CDK files directly)
before(() => {
	process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS ?? '') + ' --conditions=cdk';
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const handlerPath = join(__dirname, '__fixtures__', 'handler.js');
const sideEffectBackendPath = join(__dirname, '__fixtures__', 'side-effect-backend.js');
const factoryBackendPath = join(__dirname, '__fixtures__', 'factory-backend.js');

// Wrap create(), injecting the stub default-compute factory the way
// @aws-blocks/blocks injects LambdaCompute — so tests don't repeat it.
const makeStack = (scope: Construct, id: string, backendCDKPath: string) =>
	BlocksStack.create(scope, id, { backendHandlerPath: handlerPath, backendCDKPath, defaults: BlocksPresets.production, defaultComputeFactory: stubComputeFactory });
const makeBackend = (scope: Construct, id: string, backendCDKPath: string) =>
	BlocksBackend.create(scope, id, { backendHandlerPath: handlerPath, backendCDKPath, defaults: BlocksPresets.production, defaultComputeFactory: stubComputeFactory });

describe('ESM cache-busting (multi-stage)', () => {
	test('BlocksStack.create() with same backendCDKPath but different IDs produces constructs in each', async () => {
		const app = new cdk.App();

		const stack1 = await makeStack(app, 'PipelineStage1', sideEffectBackendPath);

		const stack2 = await makeStack(app, 'PipelineStage2', sideEffectBackendPath);

		const findMarker = (scope: any) => scope.node.tryFindChild('SideEffectMarker');

		assert.ok(findMarker(stack1), 'First stack should have SideEffectMarker from module side effect');
		assert.ok(
			findMarker(stack2),
			'Second stack should have SideEffectMarker from re-executed module (cache busted)',
		);
	});
});

describe('factory function support', () => {
	test('BlocksStack.create() calls default export function with the stack instance', async () => {
		const app = new cdk.App();

		const stack = await makeStack(app, 'FactoryBlocksStack', factoryBackendPath);

		const marker = stack.node.tryFindChild('FactoryMarker');
		assert.ok(marker, 'Factory function should have created FactoryMarker on the stack');
	});
});

describe('legacy side-effect mode (no default export)', () => {
	test('module with only side effects still registers constructs via globalThis', async () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'LegacyTestStack');

		const backend = await makeBackend(stack, 'LegacyStage', sideEffectBackendPath);

		const marker = backend.node.tryFindChild('SideEffectMarker');
		assert.ok(marker, 'Side-effect-only module should register construct via globalThis.CURRENT_BLOCKS_STACK');
	});
});

describe('shared execution role (BlocksStack)', () => {
	// The role synth shape and the Scope.executionRole tree-walk are shared code
	// (setupBlocksInfra + the getter), covered in blocks-backend.test.ts. The only
	// BlocksStack-specific behavior is that its own constructor wires
	// executionRole — a separate code path from BlocksBackend's constructor.
	test('BlocksStack wires executionRole via its constructor', async () => {
		const app = new cdk.App();
		const stack = await makeStack(app, 'StackRoleStack', sideEffectBackendPath);

		assert.ok(stack.executionRole, 'BlocksStack should expose a populated .executionRole');
	});
});

describe('executionRole globalThis fallback', () => {
	test('resolves via globalThis.CURRENT_BLOCKS_STACK when no owner is in the tree', async () => {
		const app = new cdk.App();
		const stack = await makeStack(app, 'FallbackStack', sideEffectBackendPath);

		// A Scope whose construct-tree ancestry has no BlocksStack/BlocksBackend
		// (parented under a plain cdk.Stack) exhausts the tree-walk and falls back
		// to globalThis.CURRENT_BLOCKS_STACK. The `as any` is test plumbing — a
		// plain Stack isn't a ScopeParent, but it IS a valid Construct parent.
		const plainStack = new cdk.Stack(app, 'PlainStack');
		(globalThis as any).CURRENT_BLOCKS_STACK = stack;
		const orphan = new Scope('orphan', { parent: plainStack as any });

		assert.strictEqual(orphan.executionRole, stack.executionRole, 'fallback resolves to the ambient stack role');
	});
});

describe('root is bound to the owning stack (multi-stack synth)', () => {
	test('a block under each of two stacks resolves its OWN stack, not the last globalThis', async () => {
		// `root` is resolved once at Scope construction (not re-walked per getter),
		// and `create()` mutates globalThis.CURRENT_BLOCKS_STACK for each stack it
		// builds. With two stacks in one synth, a block constructed under the first
		// must stay bound to the first even after the second stack is created and
		// overwrites globalThis — otherwise its root-derived accessors (handler,
		// executionRole, backendStackName) would silently point at the wrong stack.
		const app = new cdk.App();

		const stackA = await makeStack(app, 'RootBindingA', sideEffectBackendPath);
		// A block explicitly parented under stackA (construct-tree walk resolves
		// stackA regardless of the ambient globalThis).
		const blockA = new Scope('blockA', { parent: stackA });

		// Building the second stack overwrites globalThis.CURRENT_BLOCKS_STACK.
		const stackB = await makeStack(app, 'RootBindingB', sideEffectBackendPath);
		const blockB = new Scope('blockB', { parent: stackB });

		assert.strictEqual(blockA.executionRole, stackA.executionRole, 'blockA stays bound to stackA');
		assert.strictEqual(blockB.executionRole, stackB.executionRole, 'blockB binds to stackB');
		assert.notStrictEqual(stackA.executionRole, stackB.executionRole, 'the two stacks have distinct roles');
		assert.strictEqual(blockA.backendStackName, 'RootBindingA', 'blockA derives its own stack name');
		assert.strictEqual(blockB.backendStackName, 'RootBindingB', 'blockB derives its own stack name');
	});

	test('each stack owns an isolated compute registry (no cross-stack bleed)', async () => {
		// Computes self-register on their owning stack (keyed per stack, not a
		// process-global list), so a multi-stack synth keeps each stack's computes
		// separate — finalize steps for one stack never see another's compute.
		const app = new cdk.App();

		const stackA = await makeStack(app, 'ComputeRegistryA', sideEffectBackendPath);
		const stackB = await makeStack(app, 'ComputeRegistryB', sideEffectBackendPath);

		const computesA = getComputes(stackA);
		const computesB = getComputes(stackB);

		assert.strictEqual(computesA.length, 1, 'stackA registered exactly its default compute');
		assert.strictEqual(computesB.length, 1, 'stackB registered exactly its default compute');
		assert.strictEqual(computesA[0], stackA._defaultCompute, 'stackA lists its own default');
		assert.strictEqual(computesB[0], stackB._defaultCompute, 'stackB lists its own default');
		assert.notStrictEqual(computesA[0], computesB[0], 'the two stacks hold distinct computes');
	});
});

describe('assertCdkConditionActive', () => {
	test('BlocksStack.create() throws when --conditions=cdk is missing', async () => {
		const origNodeOptions = process.env.NODE_OPTIONS;
		const origExecArgv = process.execArgv;
		process.env.NODE_OPTIONS = '';
		process.execArgv = [];

		try {
			const app = new cdk.App();

			await assert.rejects(
				makeStack(app, 'MissingConditionStack', sideEffectBackendPath),
				(err: Error) => {
					assert.ok(
						err.message.includes('Missing --conditions=cdk'),
						`Expected condition error, got: ${err.message}`,
					);
					return true;
				},
			);
		} finally {
			process.env.NODE_OPTIONS = origNodeOptions;
			process.execArgv = origExecArgv;
		}
	});
});
