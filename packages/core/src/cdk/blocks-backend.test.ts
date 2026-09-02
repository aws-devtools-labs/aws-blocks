// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import type { RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import type { Construct } from 'constructs';
import type { ScopeParent } from '../common/index.js';
import { BLOCKS_RPC_PREFIX } from '../constants.js';
import { BlocksBackend } from './blocks-backend.js';
import { BlocksPresets } from './blocks-defaults.js';
import { Compute } from './compute/compute.js';
import type { DefaultComputeFactory } from './compute/default-compute-factory.js';
import { Scope } from './index.js';

// A real app gets its default compute from @aws-blocks/bb-lambda-compute (via
// @aws-blocks/blocks), which core's own tests can't depend on. Use an
// equivalent inline stub: a Compute that owns a NodejsFunction + API Gateway,
// so create() can build the default and the handler/gateway/apiUrl accessors
// and synth-shape assertions have something real to resolve to. It is passed to
// each create() via the internal `defaultComputeFactory` option (see
// makeBackend), exactly as @aws-blocks/blocks injects LambdaCompute.
class StubLambdaCompute extends Compute {
	readonly fn: lambda.NodejsFunction;
	readonly apiGateway: apigateway.RestApi;
	readonly apiUrl: string;

	constructor(scope: ScopeParent, id: string) {
		super(id, { parent: scope });
		this.fn = new lambda.NodejsFunction(this, 'Handler', {
			entry: this.backendHandlerPath,
			runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
			handler: 'handler',
			role: this.executionRole,
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

	protected provisionLogGroup(_retention: RetentionDays): void {}
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
const fullIdConstructBackendPath = join(__dirname, '__fixtures__', 'fullid-construct-backend.js');
const EXECUTION_ROLE_MARKER_ACTION = 'blocks-test:MarkerAction';
const importMetaHandlerPath = join(__dirname, '__fixtures__', 'import-meta-handler.js');

// Wraps BlocksBackend.create, injecting the stub default-compute factory the way
// @aws-blocks/blocks injects LambdaCompute — so tests don't repeat it 15 times.
const makeBackend = (scope: Construct, id: string, backendCDKPath: string) =>
	BlocksBackend.create(scope, id, { backendHandlerPath: handlerPath, backendCDKPath, defaults: BlocksPresets.production, defaultComputeFactory: stubComputeFactory });

describe('ESM cache-busting (multi-stage)', () => {
	test('BlocksBackend.create() with same backendCDKPath but different IDs produces constructs in each', async () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'TestStack');

		const backend1 = await makeBackend(stack, 'Stage1', sideEffectBackendPath);

		const backend2 = await makeBackend(stack, 'Stage2', sideEffectBackendPath);

		const findMarker = (scope: cdk.aws_lambda_nodejs.NodejsFunction | any) =>
			scope.node.tryFindChild('SideEffectMarker');

		assert.ok(
			findMarker(backend1),
			'Stage1 backend should have SideEffectMarker construct from module side effect',
		);
		assert.ok(
			findMarker(backend2),
			'Stage2 backend should have SideEffectMarker construct from re-executed module',
		);
	});
});

describe('synth shape (drop into existing stack)', () => {
	test('BlocksBackend lives inside the parent stack and synthesizes Lambda + API Gateway', async () => {
		const app = new cdk.App();
		const parent = new cdk.Stack(app, 'MyExistingStack');

		const backend = await makeBackend(parent, 'Blocks', sideEffectBackendPath);

		// Public surface mirrors BlocksStack.
		assert.ok(backend.handler, 'BlocksBackend should expose .handler');
		assert.ok(backend.gateway, 'BlocksBackend should expose .gateway');
		assert.ok(backend.apiUrl, 'BlocksBackend should expose .apiUrl');

		// Synth produces the expected resources inside the parent stack —
		// no separate stack is created.
		const template = Template.fromStack(parent);
		template.hasResourceProperties('AWS::Lambda::Function', {});
		template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
	});

	test('multiple BlocksBackends in the same parent stack do not collide', async () => {
		const app = new cdk.App();
		const parent = new cdk.Stack(app, 'MultiBackendStack');

		await makeBackend(parent, 'BackendA', sideEffectBackendPath);
		await makeBackend(parent, 'BackendB', sideEffectBackendPath);

		const template = Template.fromStack(parent);
		template.resourceCountIs('AWS::ApiGateway::RestApi', 2);
	});
});

describe('shared execution role', () => {
	test('exposes executionRole on the backend', async () => {
		const app = new cdk.App();
		const parent = new cdk.Stack(app, 'RoleSurfaceStack');

		const backend = await makeBackend(parent, 'Blocks', sideEffectBackendPath);

		assert.ok(backend.executionRole, 'BlocksBackend should expose .executionRole');
	});

	test('synth produces a Lambda-assumable role with basic execution, and the handler uses it', async () => {
		const app = new cdk.App();
		const parent = new cdk.Stack(app, 'RoleSynthStack');

		await makeBackend(parent, 'Blocks', sideEffectBackendPath);

		const template = Template.fromStack(parent);

		// The shared role (logical id derived from the 'BlocksRole' construct id)
		// is assumable by Lambda and carries AWSLambdaBasicExecutionRole (so
		// CloudWatch Logs keep working after swapping off the auto-role). Other
		// roles exist (API Gateway CloudWatch role, config BucketDeployment role),
		// so we target ours by logical id.
		const roles = template.findResources('AWS::IAM::Role');
		const blocksRoleId = Object.keys(roles).find((k) => k.includes('BlocksRole'));
		assert.ok(blocksRoleId, 'expected a role from the BlocksRole construct');
		const blocksRole = roles[blocksRoleId];
		assert.deepStrictEqual(blocksRole.Properties.AssumeRolePolicyDocument.Statement[0], {
			Action: 'sts:AssumeRole',
			Effect: 'Allow',
			Principal: { Service: 'lambda.amazonaws.com' },
		});
		assert.ok(
			JSON.stringify(blocksRole.Properties.ManagedPolicyArns ?? []).includes('AWSLambdaBasicExecutionRole'),
			'BlocksRole should attach AWSLambdaBasicExecutionRole',
		);

		// The Blocks handler references the shared role, not an auto-generated one.
		template.hasResourceProperties('AWS::Lambda::Function', {
			Role: { 'Fn::GetAtt': [blocksRoleId, 'Arn'] },
		});
	});

	test('a nested block resolves executionRole via the construct-tree walk', async () => {
		const app = new cdk.App();
		const parent = new cdk.Stack(app, 'RoleResolveStack');

		const backend = await makeBackend(parent, 'Blocks', sideEffectBackendPath);

		// Build nested Scopes under the backend (outer → inner), the same shape a
		// real Building Block tree has, and grant a uniquely-named marker action to
		// `this.executionRole` from the innermost scope. If the getter's tree-walk
		// failed, it would resolve the wrong role (or throw), and the marker would
		// not land on the backend's shared role.
		// `create()` sets globalThis.CURRENT_BLOCKS_STACK = backend, so a parent-less
		// Scope attaches under the backend (the same way a real backend module's
		// top-level blocks do); `inner` is then nested one level deeper.
		const outer = new Scope('outer');
		const inner = new Scope('inner', { parent: outer });

		// Resolves to the backend's shared role from two levels deep.
		assert.strictEqual(inner.executionRole, backend.executionRole);

		inner.executionRole.addToPrincipalPolicy(
			new PolicyStatement({ actions: [EXECUTION_ROLE_MARKER_ACTION], resources: ['*'] }),
		);

		// The grant lands on the shared role's default inline policy (AWS::IAM::Policy).
		const template = Template.fromStack(parent);
		template.hasResourceProperties('AWS::IAM::Policy', {
			PolicyDocument: {
				Statement: Match.arrayWith([Match.objectLike({ Action: EXECUTION_ROLE_MARKER_ACTION })]),
			},
		});
	});
});

describe('CJS bundle: import.meta.url in the handler is shimmed (no Lambda-load crash)', () => {
  test('a handler that uses import.meta.url bundles successfully instead of throwing at load', async () => {
    // The handler is bundled to CJS, where `import.meta` is empty. Left unshimmed,
    // `fileURLToPath(import.meta.url)` compiles to `fileURLToPath(undefined)` and
    // throws at Lambda load (esbuild only warns, so the broken bundle would deploy).
    // blocksNodejsBundling shims import.meta.* to CommonJS equivalents, so bundling
    // (which runs synchronously during construction) succeeds. The runtime behaviour
    // of the emitted shim is verified directly in bundling.test.ts.
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'ImportMetaStack');

    await assert.doesNotReject(() =>
      BlocksBackend.create(stack, 'blocks', {
        backendHandlerPath: importMetaHandlerPath,
        backendCDKPath: sideEffectBackendPath,
        defaults: BlocksPresets.production,
        defaultComputeFactory: stubComputeFactory,
      }),
    );
  });
});

describe('factory function support', () => {
	test('BlocksBackend.create() calls default export function with the backend instance', async () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'FactoryTestStack');

		const backend = await makeBackend(stack, 'FactoryStage', factoryBackendPath);

		const marker = backend.node.tryFindChild('FactoryMarker');
		assert.ok(marker, 'Factory function should have created FactoryMarker on the backend');
	});
});

describe('fullId is token-free (construct IDs / env-var keys)', () => {
	test('top-level stack: fullId is {stackName}-{id} and resolvable', async () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'TopLevelStack');

		const backend = await makeBackend(stack, 'blocks', sideEffectBackendPath);

		assert.strictEqual(backend.fullId, 'TopLevelStack-blocks');
		assert.ok(!cdk.Token.isUnresolved(backend.fullId), 'fullId must not contain a token');
	});

	test('nested stack: fullId stays token-free (regression for #714 / Amplify Gen2)', async () => {
		// Amplify Gen2 wires Blocks into a NestedStack via backend.createStack('blocks').
		// A NestedStack has a tokenized stackName that only resolves at deploy time —
		// embedding it in fullId broke construct IDs with
		// "ID components may not include unresolved tokens".
		const app = new cdk.App();
		const parent = new cdk.Stack(app, 'ParentStack');
		const nested = new cdk.NestedStack(parent, 'blocks');

		// Sanity: the nested stack's own name really is a token.
		assert.ok(
			cdk.Token.isUnresolved(nested.stackName),
			'precondition: NestedStack.stackName should be an unresolved token',
		);

		const backend = await makeBackend(nested, 'blocks', sideEffectBackendPath);

		assert.ok(
			!cdk.Token.isUnresolved(backend.fullId),
			`fullId must be token-free inside a nested stack, got: ${backend.fullId}`,
		);
		// Falls back to the top-level (concrete) stack name, keeping uniqueness.
		assert.strictEqual(backend.fullId, 'ParentStack-blocks');
	});

	test('child Scope can use fullId as a construct ID inside a nested stack', async () => {
		// The fixture mirrors bb-distributed-data: it builds a construct whose ID is
		// `${this.fullId}Marker`. If fullId carried a token, synth would throw.
		const app = new cdk.App();
		const parent = new cdk.Stack(app, 'Gen2ParentStack');
		const nested = new cdk.NestedStack(parent, 'blocks');

		const backend = await makeBackend(nested, 'blocks', fullIdConstructBackendPath);

		// The construct ID is `${scope.fullId}Marker` → `ParentStack-blocks-blocks-dbMarker`.
		const expectedId = `${backend.fullId}-dbMarker`;
		assert.ok(nested.node.tryFindChild(expectedId), `expected a child construct with id "${expectedId}"`);

		// Full synth must not throw on unresolved-token-in-construct-id.
		assert.doesNotThrow(() => app.synth());
	});

	test('BLOCKS_STACK_NAME env var equals fullId (CDK-time ↔ runtime invariant)', async () => {
		// Physical resource names (DynamoDB tables, DSQL env-var keys, IAM ARNs) are
		// derived from fullId on BOTH sides: at synth via BlocksBackend.fullId, and at
		// runtime via the root parent `{ id: process.env.BLOCKS_STACK_NAME }`. They MUST
		// be byte-for-byte identical, otherwise the runtime looks up names/grants that
		// were never created. BlocksBackend keeps them in sync by writing fullId into the
		// handler's BLOCKS_STACK_NAME env var — assert that contract holds and is token-free.
		const app = new cdk.App();
		const parent = new cdk.Stack(app, 'InvariantParent');
		const nested = new cdk.NestedStack(parent, 'blocks');

		const backend = await makeBackend(nested, 'blocks', sideEffectBackendPath);

		const template = Template.fromStack(nested);
		const fns = template.findResources('AWS::Lambda::Function');
		const envValues = Object.values(fns)
			.map((fn: any) => fn.Properties?.Environment?.Variables?.BLOCKS_STACK_NAME)
			.filter((v): v is string => typeof v === 'string');

		assert.ok(envValues.length > 0, 'expected a Lambda with a BLOCKS_STACK_NAME env var');
		for (const value of envValues) {
			assert.strictEqual(
				value,
				backend.fullId,
				'BLOCKS_STACK_NAME must equal BlocksBackend.fullId so runtime names match synth',
			);
			assert.ok(!cdk.Token.isUnresolved(value), `BLOCKS_STACK_NAME must be token-free, got: ${value}`);
		}
	});
});

describe('infrastructure defaults (backend-anchored)', () => {
  test('each backend exposes its own defaults', async () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TwoBackendsStack');

    const a = await BlocksBackend.create(stack, 'A', {
      backendHandlerPath: handlerPath,
      backendCDKPath: sideEffectBackendPath,
      defaults: BlocksPresets.production,
      defaultComputeFactory: stubComputeFactory,
    });
    const b = await BlocksBackend.create(stack, 'B', {
      backendHandlerPath: handlerPath,
      backendCDKPath: sideEffectBackendPath,
      defaults: BlocksPresets.sandbox,
      defaultComputeFactory: stubComputeFactory,
    });

    // Two backends in one stack must NOT clobber each other — defaults are
    // anchored on the backend, not the shared stack.
    assert.strictEqual(a.defaults, BlocksPresets.production);
    assert.strictEqual(b.defaults, BlocksPresets.sandbox);
  });

  test('a nested block resolves its owning backend defaults via the tree-walk', async () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'ResolveDefaultsStack');

    const backend = await BlocksBackend.create(stack, 'Blocks', {
      backendHandlerPath: handlerPath,
      backendCDKPath: sideEffectBackendPath,
      defaults: BlocksPresets.sandbox,
      defaultComputeFactory: stubComputeFactory,
    });

    // A Scope under the backend resolves scope.defaults by walking up to it.
    const outer = new Scope('outer');
    const inner = new Scope('inner', { parent: outer });
    assert.strictEqual(inner.defaults, backend.defaults);
    assert.strictEqual(inner.defaults, BlocksPresets.sandbox);
  });
});
