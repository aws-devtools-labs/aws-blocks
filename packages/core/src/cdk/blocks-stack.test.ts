// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';
import type { ScopeParent } from '../common/index.js';
import { AUDIT_WARNING } from './audit-warning-matcher.js';
import { BlocksBackend } from './blocks-backend.js';
import { ComputeBase } from './compute/compute.js';
import { getComputes } from './compute/compute-registry.js';
import type { DefaultComputeFactory } from './compute/default-compute-factory.js';
import { BlocksPresets, BlocksStack, Scope } from './index.js';

// A real app gets its default compute from @aws-blocks/bb-lambda-compute (via
// @aws-blocks/blocks), which core's own tests can't depend on. Use an
// equivalent inline stub: a Compute that owns a NodejsFunction and exposes it
// via apiHandler(), so create() can build the default + the shared REST API
// gateway and the handler/gateway/apiUrl accessors have something real to
// resolve to. It is passed to each create() via the internal
// `defaultComputeFactory` option (see makeStack / makeBackend), exactly as
// @aws-blocks/blocks injects LambdaCompute.
class StubLambdaCompute extends ComputeBase {
	readonly fn: lambda.NodejsFunction;
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
	}

	setEnv(key: string, value: string): void {
		this.fn.addEnvironment(key, value);
	}

	override apiHandler(): IFunction {
		return this.fn;
	}

	protected applyTracing(): void {}
	protected healthWidgets(_region: string): IWidget[][] {
		return [];
	}
	protected loggingWidgets(_region: string): IWidget[][] {
		return [];
	}
	protected tracingWidgets(_region: string): IWidget[][] {
		return [];
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
const gatewayReadingBackendPath = join(__dirname, '__fixtures__', 'gateway-reading-backend.js');
const namespaceRoutingBackendPath = join(__dirname, '__fixtures__', 'namespace-routing-backend.js');
const reexportBackendPath = join(__dirname, '__fixtures__', 'reexport-backend.js');

// Wrap create(), injecting the stub default-compute factory the way
// @aws-blocks/blocks injects LambdaCompute — so tests don't repeat it.
const makeStack = (scope: Construct, id: string, backendCDKPath: string) =>
	BlocksStack.create(scope, id, {
		backendHandlerPath: handlerPath,
		backendCDKPath,
		defaults: BlocksPresets.production,
		defaultComputeFactory: stubComputeFactory,
	});
const makeBackend = (scope: Construct, id: string, backendCDKPath: string) =>
	BlocksBackend.create(scope, id, {
		backendHandlerPath: handlerPath,
		backendCDKPath,
		defaults: BlocksPresets.production,
		defaultComputeFactory: stubComputeFactory,
	});

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

describe('ApiUrl output and the Hosting front-door claim', () => {
	// Hosting claims the front-door role whenever it fronts the API. Only the
	// `cloudfront` tier may move the ApiUrl output to that distribution; under
	// `apigateway` it stays the gateway URL, so adding Hosting never changes the
	// domain a client is bound to.
	const apiUrlOutput = (stack: BlocksStack): string =>
		JSON.stringify(Object.values(Template.fromStack(stack).findOutputs('ApiUrl'))[0]?.Value);

	test('apigateway: a Hosting claim leaves ApiUrl on the gateway', async () => {
		const app = new cdk.App();
		const stack = await makeStack(app, 'ApiGatewayClaimStack', sideEffectBackendPath);
		stack.claimApiFrontDoor('https://d123.cloudfront.net');
		const value = apiUrlOutput(stack);
		assert.ok(!value.includes('d123.cloudfront.net'), `apigateway ApiUrl must not follow the claim, got ${value}`);
		assert.ok(value.includes('execute-api'), `apigateway ApiUrl should be the gateway URL, got ${value}`);
	});

	test('cloudfront: a Hosting claim moves ApiUrl to that distribution', async () => {
		const app = new cdk.App();
		const stack = await BlocksStack.create(app, 'CloudFrontClaimStack', {
			backendHandlerPath: handlerPath,
			backendCDKPath: sideEffectBackendPath,
			defaults: BlocksPresets.production,
			defaultComputeFactory: stubComputeFactory,
			apiFrontDoor: 'cloudfront',
		});
		stack.claimApiFrontDoor('https://d123.cloudfront.net');
		const value = apiUrlOutput(stack);
		assert.ok(
			value.includes('https://d123.cloudfront.net/aws-blocks/api'),
			`cloudfront ApiUrl should follow the claim, got ${value}`,
		);
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

			await assert.rejects(makeStack(app, 'MissingConditionStack', sideEffectBackendPath), (err: Error) => {
				assert.ok(
					err.message.includes('Missing --conditions=cdk'),
					`Expected condition error, got: ${err.message}`,
				);
				return true;
			});
		} finally {
			process.env.NODE_OPTIONS = origNodeOptions;
			process.execArgv = origExecArgv;
		}
	});
});

describe('production access-logging audit-gap synth warning (BlocksStack path)', () => {
	// setupBlocksInfra runs the warning on the scope it is passed. BlocksStack
	// (index.ts) passes itself, so the annotation lands on the stack node — a
	// different node than the BlocksBackend construct path. This covers the path a
	// real create-blocks-app takes (`BlocksStack.create` with a durable posture).
	// AUDIT_WARNING is the shared matcher (see audit-warning-matcher.ts).

	test('BlocksStack with a durable posture and accessLogging off warns at synth', async () => {
		const app = new cdk.App();

		// makeStack uses BlocksPresets.production (durable, accessLogging: false).
		const stack = await makeStack(app, 'AuditWarnStackLevel', sideEffectBackendPath);

		Annotations.fromStack(stack).hasWarning('*', AUDIT_WARNING);
	});
});

// `create()` hands the stack's `defaults` to the shared gateway: throttling and
// access logging on the stage must follow them (sandbox preset ⇒ 200/400).
describe('shared gateway stage follows the stack defaults (BlocksStack)', () => {
	test('sandbox throttling + opt-in access logging reach the stage', async () => {
		const app = new cdk.App();
		const stack = await BlocksStack.create(app, 'DefaultsToStageStack', {
			backendHandlerPath: handlerPath,
			backendCDKPath: sideEffectBackendPath,
			defaults: { ...BlocksPresets.sandbox, accessLogging: true },
			defaultComputeFactory: stubComputeFactory,
		});
		Template.fromStack(stack).hasResourceProperties('AWS::ApiGateway::Stage', {
			MethodSettings: Match.arrayWith([
				Match.objectLike({ ThrottlingRateLimit: 200, ThrottlingBurstLimit: 400 }),
			]),
			AccessLogSetting: Match.objectLike({ DestinationArn: Match.anyValue() }),
		});
	});
});

// The shared gateway is built after the backend module import, so `.gateway` /
// `.apiUrl` are only available once `create()` resolves — including inside the
// backend's default export.
describe('gateway is not available during the backend import (BlocksStack)', () => {
	test('reading .gateway in the default export fails with the "not fully initialized" error', async () => {
		const app = new cdk.App();
		await assert.rejects(
			makeStack(app, 'GatewayDuringImportStack', gatewayReadingBackendPath),
			/not fully initialized/,
		);
	});
});

describe('shared gateway routes namespaces by export name (create())', () => {
	// The fixture exports `api` (default compute) and `shop` — constructed as
	// 'orders' — on a second compute. The routing table is built from the module
	// create() imported, so this covers the real wiring for both entry points.
	before(() => {
		(globalThis as Record<string, unknown>).__BLOCKS_TEST_MAKE_COMPUTE__ = (parent: ScopeParent, id: string) =>
			new StubLambdaCompute(parent, id);
	});

	const assertRoutedByExportName = (stackOfGateway: cdk.Stack, owner: Construct) => {
		const resources = Template.fromStack(stackOfGateway).toJSON().Resources as Record<
			string,
			{ Type: string; Properties: Record<string, unknown> }
		>;
		const pathParts = Object.entries(resources)
			.filter(([, r]) => r.Type === 'AWS::ApiGateway::Resource')
			.map(([id, r]) => [id, r.Properties.PathPart as string] as const);
		// Exactly the catch-all tree plus `shop`: routed by export name (not the
		// constructor name 'orders'), and the default-compute `api` namespace adds
		// no resource of its own.
		const parts = pathParts.map(([, part]) => part).sort();
		assert.deepStrictEqual(parts, ['aws-blocks', 'api', 'shop', '{proxy+}', '{proxy+}', '{proxy+}'].sort());

		const orders = getComputes(owner).find((c) => c.node.id === 'OrdersCompute') as StubLambdaCompute;
		const ordersFnId = stackOfGateway.getLogicalId(orders.fn.node.defaultChild as cdk.CfnElement);
		const shopId = pathParts.find(([, part]) => part === 'shop')?.[0];
		const shopMethod = Object.values(resources).find(
			(r) => r.Type === 'AWS::ApiGateway::Method' && (r.Properties.ResourceId as { Ref?: string }).Ref === shopId,
		);
		assert.ok(JSON.stringify(shopMethod?.Properties.Integration).includes(ordersFnId), 'shop → the orders function');
	};

	test('BlocksStack', async () => {
		const stack = await makeStack(new cdk.App(), 'NamespaceRoutingStack', namespaceRoutingBackendPath);
		assertRoutedByExportName(stack, stack);
	});

	test('BlocksBackend', async () => {
		const parent = new cdk.Stack(new cdk.App(), 'NamespaceRoutingParent');
		const backend = await makeBackend(parent, 'Blocks', namespaceRoutingBackendPath);
		assertRoutedByExportName(parent, backend);
	});
});

describe('a namespace bound to another backend is not routed (multi-backend synth)', () => {
	// create() re-runs only the top-level backend module per backend; a namespace
	// from a cached sub-module stays bound to the first backend. A second backend
	// must serve it from its own catch-all — never route its path to the first
	// backend's Lambda (that would be a cross-stack reference and a silent misroute).
	const routedPathParts = (template: Template) =>
		Object.values(template.findResources('AWS::ApiGateway::Resource')).map((r) => r.Properties.PathPart as string);

	// One app, so a misroute would synthesize silently (CDK wires a cross-stack
	// Export/Fn::ImportValue) rather than fail.
	test('two BlocksStacks in one app', async () => {
		const app = new cdk.App();
		const first = await makeStack(app, 'ReexportStackOne', reexportBackendPath);
		const second = await makeStack(app, 'ReexportStackTwo', reexportBackendPath);
		for (const stack of [first, second]) {
			const template = Template.fromStack(stack);
			assert.ok(!routedPathParts(template).includes('reports'), `${stack.stackName}: no route for 'reports'`);
			assert.ok(!JSON.stringify(template.toJSON()).includes('Fn::ImportValue'), `${stack.stackName}: no cross-stack import`);
		}
	});

	// The sub-module is cached for the whole process, so here the namespace is
	// still bound to the first test's stack — foreign to both backends below.
	test('two BlocksBackends in one stack', async () => {
		const parent = new cdk.Stack(new cdk.App(), 'ReexportParent');
		await makeBackend(parent, 'BackendOne', reexportBackendPath);
		await makeBackend(parent, 'BackendTwo', reexportBackendPath);
		assert.ok(!routedPathParts(Template.fromStack(parent)).includes('reports'), "no route for 'reports'");
	});
});
