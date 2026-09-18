// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-synth tests for the managed CloudFront API front door.
 *
 * The front door is scheduled by core's `scheduleApiFrontDoor` and resolved at
 * synth by a one-shot aspect (`ApiFrontDoorAspect`). Because the aspect runs at
 * synth — after the whole tree, including any `Hosting` construct built after
 * `create()`, exists — these tests must synthesize (`Template.fromStack`) to
 * exercise it. The aspect's branches:
 *   • no Hosting + `provisionApiFrontDoor` (prod) → create one Blocks-owned
 *     distribution; the `ApiUrl` output resolves to the front-door origin.
 *   • no Hosting + off (sandbox) → no distribution; `ApiUrl` = the API Gateway.
 *   • Hosting present → no Blocks-owned distribution (Hosting is the front door).
 *
 * Hosting presence is simulated with `registerHostingDistribution` (the aspect
 * only checks presence in that branch), so no real Hosting distribution is
 * needed here.
 *
 * `scheduleApiFrontDoor` / `ApiFrontDoorAspect` / `httpOriginFromApiUrl` are all core
 * code, so these tests live in core. A real app's default compute comes from
 * `@aws-blocks/bb-lambda-compute` (which core can't depend on), so — exactly
 * like `blocks-stack.test.ts` — this uses an inline `StubLambdaCompute` that
 * owns a `NodejsFunction` + API Gateway, giving `create()` a real default to
 * build and the synth-shape assertions something to resolve against.
 */
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import type { Distribution } from 'aws-cdk-lib/aws-cloudfront';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import type { ScopeParent } from '../common/index.js';
import { BLOCKS_RPC_PREFIX } from '../constants.js';
import { Compute } from './compute/compute.js';
import type { DefaultComputeFactory } from './compute/default-compute-factory.js';
import { httpOriginFromApiUrl, registerHostingDistribution } from './api-front-door.js';
import { type BlocksDefaults, BlocksBackend, BlocksPresets, BlocksStack } from './index.js';

// Inline stand-in for the real LambdaCompute (which lives in bb-lambda-compute,
// off-limits to core). Owns a NodejsFunction + API Gateway so create() can build
// the default compute and the apiUrl/handler accessors resolve to real CDK.
class StubLambdaCompute extends Compute {
	readonly fn: lambda.NodejsFunction;
	readonly apiGateway: apigateway.RestApi;
	readonly apiUrl: string;
	/** Origin base — mirrors LambdaCompute: apiUrl minus the reserved RPC suffix. */
	override readonly endpoint: string;
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
		this.endpoint = cdk.Fn.select(0, cdk.Fn.split(BLOCKS_RPC_PREFIX, this.apiUrl));
	}
	setEnv(key: string, value: string): void {
		this.fn.addEnvironment(key, value);
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

const __dirname = dirname(fileURLToPath(import.meta.url));
let handlerPath: string;
let backendPath: string;
let tmpDir: string;

before(() => {
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
	tmpDir = mkdtempSync(join(__dirname, 'tmp-frontdoor-cdk-'));
	handlerPath = join(tmpDir, 'handler.mjs');
	writeFileSync(handlerPath, "export const handler = async () => ({ statusCode: 200, body: '{}' });\n");
	backendPath = join(tmpDir, 'backend.mjs');
	writeFileSync(backendPath, 'export default () => {};\n');
});

after(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

async function makeStack(
	id: string,
	defaults: BlocksDefaults,
	apiFrontDoor?: 'cloudfront' | 'none',
): Promise<BlocksStack> {
	const app = new cdk.App();
	return BlocksStack.create(app, id, {
		backendHandlerPath: handlerPath,
		backendCDKPath: backendPath,
		defaults,
		apiFrontDoor,
		defaultComputeFactory: stubComputeFactory,
	});
}

/** The `ApiUrl` output value as a searchable string (references are tokens). */
function apiUrlOutput(template: Template): string {
	return JSON.stringify(template.findOutputs('ApiUrl'));
}

describe('API front door (scheduled aspect, gated on defaults.provisionApiFrontDoor)', () => {
	test('production, no Hosting: one distribution + ApiUrl points at the front door', async () => {
		const stack = await makeStack('ApiFrontDoorProd', BlocksPresets.production);
		const template = Template.fromStack(stack);

		template.resourceCountIs('AWS::CloudFront::Distribution', 1);
		template.hasOutput('ApiFrontDoorUrl', {});
		// The client-facing ApiUrl output now resolves to the front-door origin —
		// its value references the front-door distribution, not the raw gateway.
		assert.ok(
			apiUrlOutput(template).includes('BlocksApiFrontDoor'),
			'ApiUrl output should reference the CloudFront front door',
		);
	});

	test('sandbox, no Hosting: no front door; ApiUrl stays the API Gateway', async () => {
		const stack = await makeStack('ApiFrontDoorSandbox', BlocksPresets.sandbox);
		const template = Template.fromStack(stack);

		template.resourceCountIs('AWS::CloudFront::Distribution', 0);
		assert.ok(
			!apiUrlOutput(template).includes('BlocksApiFrontDoor'),
			'ApiUrl output should not reference a front door in sandbox',
		);
	});

	test('explicit provisionApiFrontDoor:false opts a prod app out', async () => {
		const stack = await makeStack('ApiFrontDoorProdOptOut', {
			...BlocksPresets.production,
			provisionApiFrontDoor: false,
		});
		Template.fromStack(stack).resourceCountIs('AWS::CloudFront::Distribution', 0);
	});

	test("apiFrontDoor: 'none' opts a prod app out (prop overrides the preset default)", async () => {
		const stack = await makeStack('ApiFrontDoorPropNone', BlocksPresets.production, 'none');
		Template.fromStack(stack).resourceCountIs('AWS::CloudFront::Distribution', 0);
	});

	test("apiFrontDoor: 'cloudfront' forces a front door on in sandbox (prop overrides the preset default)", async () => {
		const stack = await makeStack('ApiFrontDoorPropCloudfront', BlocksPresets.sandbox, 'cloudfront');
		Template.fromStack(stack).resourceCountIs('AWS::CloudFront::Distribution', 1);
	});

	test('Hosting present: reuse it — no Blocks-owned distribution is created', async () => {
		const stack = await makeStack('ApiFrontDoorWithHosting', BlocksPresets.production);
		// Simulate a Hosting construct publishing its distribution after create().
		// The aspect only checks presence in this branch, so a stub suffices.
		registerHostingDistribution(stack, {} as unknown as Distribution);

		const template = Template.fromStack(stack);
		// No Blocks-owned distribution — Hosting's own distribution is the front door.
		template.resourceCountIs('AWS::CloudFront::Distribution', 0);
	});
});

describe('multiple front-door-enabled BlocksBackends in one stack', () => {
	test('each backend gets its own distribution + output (no stack-level id collision)', async () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'MultiBackendStack');

		await BlocksBackend.create(stack, 'BackendA', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
			defaultComputeFactory: stubComputeFactory,
		});
		await BlocksBackend.create(stack, 'BackendB', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
			defaultComputeFactory: stubComputeFactory,
		});

		const template = Template.fromStack(stack);
		// One distribution per backend — the aspect scopes each under its owning
		// backend, so the shared `BlocksApiFrontDoor` construct id does not collide
		// at the stack level.
		template.resourceCountIs('AWS::CloudFront::Distribution', 2);
		const apiFrontDoorOutputs = Object.values(template.findOutputs('*')).filter(
			(o) => o.Description === 'Blocks API CloudFront front door URL',
		);
		assert.strictEqual(apiFrontDoorOutputs.length, 2, 'one FrontDoorUrl output per backend');
	});
});

describe('httpOriginFromApiUrl', () => {
	test('builds an HTTP origin from a Blocks API URL', () => {
		const origin = httpOriginFromApiUrl('https://abc123.execute-api.us-east-1.amazonaws.com/prod/aws-blocks/api');
		assert.ok(origin, 'returns an origin');
		assert.strictEqual(typeof origin.bind, 'function', 'is a CloudFront IOrigin');
	});
});

describe('API front door: multi-compute namespace fan-out', () => {
	/**
	 * A prod stack with a second compute, each hosting one namespace.
	 *
	 * `ApiNamespace` records itself on its compute during the backend import;
	 * these push directly so the test needs no real backend module. The aspect
	 * reads the map at synth (inside `Template.fromStack`), so mutating here is
	 * seen by the fan-out.
	 */
	async function twoComputeStack(id: string): Promise<BlocksStack> {
		const stack = await makeStack(id, BlocksPresets.production);
		const worker = new StubLambdaCompute(stack as never, 'WorkerCompute');
		stack._defaultCompute?.namespaces.push('api');
		worker.namespaces.push('authApi');
		return stack;
	}

	/** The front door's `DistributionConfig`. */
	function frontDoorConfig(stack: BlocksStack): any {
		const distributions = Template.fromStack(stack).findResources('AWS::CloudFront::Distribution');
		const keys = Object.keys(distributions);
		assert.strictEqual(keys.length, 1, 'expected exactly one front-door distribution');
		return (distributions[keys[0]] as any).Properties.DistributionConfig;
	}

	function behaviorFor(config: any, pattern: string): any {
		const found = (config.CacheBehaviors ?? []).find((b: any) => b.PathPattern === pattern);
		assert.ok(found, `expected a cache behavior for ${pattern}`);
		return found;
	}

	test('each namespace behavior targets the compute that hosts it', async () => {
		const config = frontDoorConfig(await twoComputeStack('FanOutTargets'));
		/** Origin id → its DomainName as JSON (an intrinsic referencing the gateway). */
		const domainById = new Map<string, string>(
			(config.Origins ?? []).map((o: any) => [o.Id, JSON.stringify(o.DomainName)]),
		);

		// The second compute's namespace routes to the second compute's gateway.
		const authBehavior = behaviorFor(config, `${BLOCKS_RPC_PREFIX}/authApi`);
		assert.match(
			domainById.get(authBehavior.TargetOriginId) ?? '',
			/WorkerComputeAPI/,
			'authApi should route to the WorkerCompute gateway',
		);

		// The default compute's namespace routes to the default compute — the same
		// origin the fallback (default) behavior uses.
		const apiBehavior = behaviorFor(config, `${BLOCKS_RPC_PREFIX}/api`);
		assert.match(
			domainById.get(apiBehavior.TargetOriginId) ?? '',
			/DefaultComputeAPI/,
			'api should route to the DefaultCompute gateway',
		);
		assert.strictEqual(
			apiBehavior.TargetOriginId,
			config.DefaultCacheBehavior.TargetOriginId,
			'a namespace on the default compute should reuse the fallback origin',
		);

		// Subtrees follow their namespace (RawRoutes may hang below it).
		assert.strictEqual(
			behaviorFor(config, `${BLOCKS_RPC_PREFIX}/authApi/*`).TargetOriginId,
			authBehavior.TargetOriginId,
		);
	});

	test('builds one origin per distinct compute, not per namespace', async () => {
		// Two computes → two origins. Without the shared-origin cache the default
		// compute would get a second, duplicate origin (fallback + its namespace).
		const config = frontDoorConfig(await twoComputeStack('FanOutOriginDedupe'));
		assert.strictEqual((config.Origins ?? []).length, 2, 'expected one origin per compute');
	});

	test('the default behavior stays the fallback for unrouted namespaces', async () => {
		// A namespace on a compute with no `endpoint` (worker-only) is absent from
		// the map; it must still reach the default compute via the default behavior.
		const stack = await makeStack('FanOutFallback', BlocksPresets.production);
		stack._defaultCompute?.namespaces.push('api');
		const config = frontDoorConfig(stack);

		assert.ok(config.DefaultCacheBehavior.TargetOriginId, 'default behavior must have an origin');
		// Single compute → a single origin shared by the fallback and the namespace.
		assert.strictEqual((config.Origins ?? []).length, 1);
		assert.strictEqual(
			behaviorFor(config, `${BLOCKS_RPC_PREFIX}/api`).TargetOriginId,
			config.DefaultCacheBehavior.TargetOriginId,
		);
	});
});
