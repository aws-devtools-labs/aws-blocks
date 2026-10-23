// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the stack-level shared REST API gateway. Exercises
 * `createSharedGateway` and `resolveNamespaceRoutes` directly with stub computes
 * + presets, pinning the single-API shape, the catch-all resource tree →
 * default-compute integration, the multi-compute per-namespace fan-out (keyed by
 * export name, one API-scoped invoke permission per function), stage throttling,
 * optional access logging (with the account-level CloudWatch role), and the
 * `apiUrl` shape.
 */

import assert from 'node:assert';
import { before, describe, test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import { Code, type IFunction, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';
import { API_NAMESPACE_COMPUTE, ApiNamespace } from '../api.js';
import { BlocksPresets } from './blocks-defaults.js';
import { ComputeBase } from './compute/compute.js';
import { getComputes } from './compute/compute-registry.js';
import { Scope } from './index.js';
import { createSharedGateway, resolveNamespaceRoutes } from './shared-gateway.js';

before(() => {
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
});

// Minimal stand-in for a real HTTP compute (e.g. LambdaCompute, which core's own
// tests can't depend on): a Compute that owns a function and exposes it via
// apiHandler(), so the gateway has something to integrate — or, with
// `servesApi: false`, a worker-only compute that takes no API traffic. The
// `scope as never` cast is test plumbing — a plain cdk.Stack isn't a ScopeParent,
// but ComputeBase only needs it as a construct-tree parent here (it never reads
// root-derived state).
class StubCompute extends ComputeBase {
	constructor(
		scope: Construct,
		id: string,
		readonly fn: IFunction,
		private readonly servesApi = true,
	) {
		super(id, { parent: scope as never });
	}

	override apiHandler(): IFunction | undefined {
		return this.servesApi ? this.fn : undefined;
	}

	setEnv(): void {}
	protected applyTracing(): void {}
	protected healthWidgets(): IWidget[][] {
		return [];
	}
	protected loggingWidgets(): IWidget[][] {
		return [];
	}
	protected tracingWidgets(): IWidget[][] {
		return [];
	}
}

function makeFn(scope: Construct, id: string): IFunction {
	return new LambdaFunction(scope, id, {
		runtime: Runtime.NODEJS_22_X,
		handler: 'index.handler',
		code: Code.fromInline('exports.handler = async () => ({ statusCode: 200, body: "{}" });'),
	});
}

function setup(id: string) {
	const app = new cdk.App();
	const stack = new cdk.Stack(app, id);
	const fn = makeFn(stack, 'Handler');
	const compute = new StubCompute(stack, 'DefaultCompute', fn);
	return { stack, fn, compute };
}

let scopeCount = 0;
/**
 * A real `ApiNamespace` constructed as `name` in a fresh scope, assigned to
 * `compute` through the internal `_compute` seam (exactly what the future
 * compute-assignment surface will do). Returns the namespace object a backend
 * module would export.
 */
function namespaceOn(stack: cdk.Stack, compute: ComputeBase, name: string): object {
	const apiScope = new Scope(`scope-${scopeCount++}`, { parent: stack as never });
	apiScope._compute = compute;
	return new ApiNamespace(apiScope, name, () => ({
		async ping() {
			return 'pong';
		},
	}));
}

type CfnResources = Record<string, { Type: string; Properties: Record<string, unknown> }>;

/** Full resource path (`/aws-blocks/api/orders`) for every ApiGateway::Resource, keyed by logical id. */
function resourcePaths(resources: CfnResources): Record<string, string> {
	const paths: Record<string, string> = {};
	const resolve = (id: string): string => {
		if (paths[id]) return paths[id];
		const { ParentId, PathPart } = resources[id].Properties as { ParentId: unknown; PathPart: string };
		const parentRef = (ParentId as { Ref?: string }).Ref;
		const parentPath =
			parentRef && resources[parentRef]?.Type === 'AWS::ApiGateway::Resource' ? resolve(parentRef) : '';
		paths[id] = `${parentPath}/${PathPart}`;
		return paths[id];
	};
	for (const [id, r] of Object.entries(resources)) if (r.Type === 'AWS::ApiGateway::Resource') resolve(id);
	return paths;
}

/** The logical id of the Lambda function the `httpMethod` method on resource `path` integrates. */
function methodTargetFnId(stack: cdk.Stack, path: string, httpMethod: string, fnIds: string[]): string {
	const resources = Template.fromStack(stack).toJSON().Resources as CfnResources;
	const paths = resourcePaths(resources);
	const resourceId = Object.keys(paths).find((id) => paths[id] === path);
	assert.ok(resourceId, `resource ${path} exists`);
	const method = Object.values(resources).find(
		(r) =>
			r.Type === 'AWS::ApiGateway::Method' &&
			r.Properties.HttpMethod === httpMethod &&
			(r.Properties.ResourceId as { Ref?: string }).Ref === resourceId,
	);
	assert.ok(method, `${httpMethod} ${path} exists`);
	const uri = JSON.stringify((method.Properties.Integration as { Uri: unknown }).Uri);
	const fnId = fnIds.find((id) => uri.includes(id));
	assert.ok(fnId, `${httpMethod} ${path} integrates one of ${fnIds.join(', ')}: ${uri}`);
	return fnId;
}

describe('createSharedGateway — single shared REST API', () => {
	test('provisions exactly one REST API with proxy integrations to the function', () => {
		const { stack, compute } = setup('SharedGwShape');
		const gw = createSharedGateway(stack, {
			defaultCompute: compute,
			defaults: BlocksPresets.production,
		});

		assert.ok(gw.restApi, 'returns the RestApi');

		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
		template.hasResourceProperties('AWS::ApiGateway::Method', {
			HttpMethod: 'ANY',
			Integration: Match.objectLike({ Type: 'AWS_PROXY' }),
		});
	});

	test('caps every Lambda integration at API Gateway’s 29s request ceiling', () => {
		const { stack, compute } = setup('SharedGwIntegrationTimeout');
		createSharedGateway(stack, {
			defaultCompute: compute,
			defaults: BlocksPresets.production,
		});

		const template = Template.fromStack(stack);
		// Every Lambda (AWS_PROXY) integration carries TimeoutInMillis: 29000 — the
		// function timeout (up to 900s for async work) is unreachable on the
		// synchronous HTTP path, so the integration pins the real boundary. The
		// root MOCK method CDK auto-creates has no Lambda and no timeout.
		const methods = template.findResources('AWS::ApiGateway::Method');
		const proxyIntegrations = Object.values(methods)
			.map((m) => (m.Properties as { Integration?: { Type?: string; TimeoutInMillis?: number } }).Integration)
			.filter((i): i is { Type?: string; TimeoutInMillis?: number } => i?.Type === 'AWS_PROXY');
		assert.ok(proxyIntegrations.length > 0, 'at least one Lambda integration is created');
		for (const integration of proxyIntegrations) {
			assert.strictEqual(
				integration.TimeoutInMillis,
				29000,
				'each Lambda integration is pinned to the 29s API Gateway request ceiling',
			);
		}
	});

	test('routes the RPC endpoint, per-namespace RPC paths, RawRoute sub-paths, and every other path', () => {
		const { stack, compute } = setup('SharedGwTree');
		createSharedGateway(stack, {
			defaultCompute: compute,
			defaults: BlocksPresets.production,
		});
		const resources = Template.fromStack(stack).toJSON().Resources as CfnResources;

		// A single compute ⇒ no per-namespace resources, only the catch-all tree.
		assert.deepStrictEqual(Object.values(resourcePaths(resources)).sort(), [
			'/aws-blocks',
			'/aws-blocks/api',
			'/aws-blocks/api/{proxy+}',
			'/aws-blocks/{proxy+}',
			'/{proxy+}',
		]);

		const methods = Object.values(resources)
			.filter((r) => r.Type === 'AWS::ApiGateway::Method')
			.map((m) => m.Properties.HttpMethod);
		assert.ok(methods.includes('POST'), 'RPC endpoint has POST');
		assert.ok(methods.includes('OPTIONS'), 'RPC endpoint has OPTIONS');
		// ANY on /aws-blocks/{proxy+}, /aws-blocks/api/{proxy+}, the root /{proxy+},
		// and / itself (a root proxy also adds ANY to the root so `/` is reachable).
		assert.strictEqual(methods.filter((m) => m === 'ANY').length, 4, 'four ANY proxy methods');
	});

	test('builds under the given scope with the per-compute gateway construct ids', () => {
		// The scope is the default compute; keeping the old `API` id there keeps the
		// logical IDs a deployed app's REST API was created with.
		const { compute } = setup('SharedGwIds');
		const gw = createSharedGateway(compute, {
			defaultCompute: compute,
			defaults: BlocksPresets.production,
		});
		assert.strictEqual(gw.restApi.node.path, `${compute.node.path}/API`);
	});

	test('apiUrl is the stage URL plus the RPC prefix', () => {
		const { stack, compute } = setup('SharedGwUrl');
		const gw = createSharedGateway(stack, {
			defaultCompute: compute,
			defaults: BlocksPresets.production,
		});

		assert.ok(gw.apiUrl.endsWith('/aws-blocks/api'), `apiUrl should end with the RPC prefix, got: ${gw.apiUrl}`);
		assert.ok(gw.apiUrl.startsWith(gw.restApi.url), 'apiUrl is built from the stage URL');
	});
});

describe('createSharedGateway — multi-compute fan-out', () => {
	function fanOut(id: string) {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, id);
		const defaultCompute = new StubCompute(stack, 'DefaultCompute', makeFn(stack, 'DefaultFn'));
		const ordersCompute = new StubCompute(stack, 'OrdersCompute', makeFn(stack, 'OrdersFn'));
		const defaultFnId = stack.getLogicalId(defaultCompute.fn.node.defaultChild as cdk.CfnElement);
		const ordersFnId = stack.getLogicalId(ordersCompute.fn.node.defaultChild as cdk.CfnElement);
		return { stack, defaultCompute, ordersCompute, defaultFnId, ordersFnId };
	}

	test('routes a non-default namespace by its export name to its own function; the rest stays on the default', () => {
		const { stack, defaultCompute, ordersCompute, defaultFnId, ordersFnId } = fanOut('FanOut');
		// Constructed as 'orders', exported as 'shop' — the client calls /aws-blocks/api/shop.
		const backendModule = { shop: namespaceOn(stack, ordersCompute, 'orders') };

		createSharedGateway(stack, {
			namespaceRoutes: resolveNamespaceRoutes(backendModule, defaultCompute, getComputes(stack)),
			defaultCompute,
			defaults: BlocksPresets.production,
		});

		// Correlate method → integration → function so we PROVE the fan-out.
		const fnIds = [defaultFnId, ordersFnId];
		assert.strictEqual(methodTargetFnId(stack, '/aws-blocks/api/shop', 'ANY', fnIds), ordersFnId);
		// Everything else stays on the default compute.
		assert.strictEqual(methodTargetFnId(stack, '/aws-blocks/api', 'POST', fnIds), defaultFnId);
		assert.strictEqual(methodTargetFnId(stack, '/aws-blocks/api/{proxy+}', 'ANY', fnIds), defaultFnId);
		assert.strictEqual(methodTargetFnId(stack, '/aws-blocks/{proxy+}', 'ANY', fnIds), defaultFnId);
		assert.strictEqual(methodTargetFnId(stack, '/{proxy+}', 'ANY', fnIds), defaultFnId);

		// Exactly the catch-all tree plus one literal resource: no constructor-name
		// resource, and no `{proxy+}` subtree (the client POSTs to exactly
		// /aws-blocks/api/{name}).
		const paths = Object.values(resourcePaths(Template.fromStack(stack).toJSON().Resources as CfnResources));
		assert.deepStrictEqual(paths.sort(), [
			'/aws-blocks',
			'/aws-blocks/api',
			'/aws-blocks/api/shop',
			'/aws-blocks/api/{proxy+}',
			'/aws-blocks/{proxy+}',
			'/{proxy+}',
		]);
	});

	test('pins the 29s integration timeout on the per-compute fan-out integration too', () => {
		// The single-compute path and the per-compute fan-out build their Lambda
		// integrations on separate code paths; this covers the fan-out loop so a
		// dropped `timeout:` on the per-compute integration is caught.
		const { stack, defaultCompute, ordersCompute } = fanOut('FanOutTimeout');
		const backendModule = { orders: namespaceOn(stack, ordersCompute, 'orders') };

		createSharedGateway(stack, {
			namespaceRoutes: resolveNamespaceRoutes(backendModule, defaultCompute, getComputes(stack)),
			defaultCompute,
			defaults: BlocksPresets.production,
		});

		const methods = Template.fromStack(stack).findResources('AWS::ApiGateway::Method');
		const proxyIntegrations = Object.values(methods)
			.map((m) => (m.Properties as { Integration?: { Type?: string; TimeoutInMillis?: number } }).Integration)
			.filter((i): i is { Type?: string; TimeoutInMillis?: number } => i?.Type === 'AWS_PROXY');
		// Two computes ⇒ more than the single-compute count; every one pinned.
		assert.ok(proxyIntegrations.length > 1, 'fan-out creates Lambda integrations on both computes');
		for (const integration of proxyIntegrations) {
			assert.strictEqual(
				integration.TimeoutInMillis,
				29000,
				'each fan-out Lambda integration is pinned to the 29s API Gateway request ceiling',
			);
		}
	});

	test('gives each routed function one API-scoped invoke permission, however many namespaces it hosts', () => {
		const { stack, defaultCompute, ordersCompute, ordersFnId } = fanOut('FanOutPermission');
		const backendModule = {
			orders: namespaceOn(stack, ordersCompute, 'orders'),
			invoices: namespaceOn(stack, ordersCompute, 'invoices'),
			refunds: namespaceOn(stack, ordersCompute, 'refunds'),
		};

		createSharedGateway(stack, {
			namespaceRoutes: resolveNamespaceRoutes(backendModule, defaultCompute, getComputes(stack)),
			defaultCompute,
			defaults: BlocksPresets.production,
		});

		// CDK's default is two statements (stage + test-invoke) per method, which would
		// grow the function's 20 KB resource policy with every namespace.
		const ordersPermissions = Object.values(Template.fromStack(stack).findResources('AWS::Lambda::Permission')).filter(
			(p) => JSON.stringify(p.Properties.FunctionName).includes(ordersFnId),
		);
		assert.strictEqual(ordersPermissions.length, 1, 'one API-scoped permission, not one per method');
		// …and all three namespaces are still routed to that function.
		const fnIds = [stack.getLogicalId(defaultCompute.fn.node.defaultChild as cdk.CfnElement), ordersFnId];
		for (const name of ['orders', 'invoices', 'refunds']) {
			assert.strictEqual(methodTargetFnId(stack, `/aws-blocks/api/${name}`, 'ANY', fnIds), ordersFnId, name);
		}
		assert.match(JSON.stringify(ordersPermissions[0].Properties.SourceArn), /\/\*\/\*\/\*/);
	});

	test('a compute hosting no namespace contributes no resources', () => {
		const { stack, defaultCompute } = fanOut('FanOutIdle');

		createSharedGateway(stack, {
			namespaceRoutes: resolveNamespaceRoutes({}, defaultCompute, getComputes(stack)),
			defaultCompute,
			defaults: BlocksPresets.production,
		});

		const resources = Template.fromStack(stack).toJSON().Resources as CfnResources;
		assert.strictEqual(Object.keys(resourcePaths(resources)).length, 5, 'only the catch-all tree');
	});

	test('rejects a namespace on a compute that accepts no API traffic', () => {
		const { stack, defaultCompute } = fanOut('FanOutWorker');
		const workerCompute = new StubCompute(stack, 'WorkerCompute', makeFn(stack, 'WorkerFn'), false);
		const backendModule = { jobs: namespaceOn(stack, workerCompute, 'jobs') };

		assert.throws(
			() =>
				createSharedGateway(stack, {
					namespaceRoutes: resolveNamespaceRoutes(backendModule, defaultCompute, getComputes(stack)),
					defaultCompute,
					defaults: BlocksPresets.production,
				}),
			/Compute 'WorkerCompute' hosts API namespaces \(jobs\) but accepts no API traffic/,
		);
	});

	test('rejects an export name API Gateway cannot use as a path segment', () => {
		const { stack, defaultCompute, ordersCompute } = fanOut('FanOutBadName');
		const backendModule = { café: namespaceOn(stack, ordersCompute, 'cafe') };

		assert.throws(
			() =>
				createSharedGateway(stack, {
					namespaceRoutes: resolveNamespaceRoutes(backendModule, defaultCompute, getComputes(stack)),
					defaultCompute,
					defaults: BlocksPresets.production,
				}),
			/API namespace export 'café' can't be routed to compute 'OrdersCompute'/,
		);
	});
});

describe('resolveNamespaceRoutes', () => {
	function computes(id: string) {
		const stack = new cdk.Stack(new cdk.App(), id);
		const defaultCompute = new StubCompute(stack, 'DefaultCompute', makeFn(stack, 'DefaultFn'));
		const ordersCompute = new StubCompute(stack, 'OrdersCompute', makeFn(stack, 'OrdersFn'));
		return { stack, defaultCompute, ordersCompute };
	}

	test('keys on the export name, not the ApiNamespace constructor name', () => {
		const { stack, defaultCompute, ordersCompute } = computes('RoutesExportName');
		// Like `export const authApi = auth.createApi()`, constructed as 'auth'.
		const routes = resolveNamespaceRoutes({ authApi: namespaceOn(stack, ordersCompute, 'auth') }, defaultCompute, getComputes(stack));
		assert.deepStrictEqual([...routes], [[ordersCompute, ['authApi']]]);
	});

	test('routes a namespace exported under several names under each', () => {
		const { stack, defaultCompute, ordersCompute } = computes('RoutesReExport');
		const orders = namespaceOn(stack, ordersCompute, 'orders');
		const routes = resolveNamespaceRoutes({ orders, shop: orders }, defaultCompute, getComputes(stack));
		assert.deepStrictEqual(routes.get(ordersCompute), ['orders', 'shop']);
	});

	// An unassigned namespace (no `_compute` up its scope chain) resolves to the
	// default compute too; that needs a real Blocks root, so it is covered by the
	// create()-level test in blocks-stack.test.ts.
	test('skips namespaces on the default compute', () => {
		const { stack, defaultCompute } = computes('RoutesDefault');
		const routes = resolveNamespaceRoutes({ api: namespaceOn(stack, defaultCompute, 'api') }, defaultCompute, getComputes(stack));
		assert.strictEqual(routes.size, 0);
	});

	test('skips plain exports, private exports, and unexported namespaces', () => {
		const { stack, defaultCompute, ordersCompute } = computes('RoutesSkip');
		namespaceOn(stack, ordersCompute, 'unexported');
		const routes = resolveNamespaceRoutes(
			{
				plainFn: () => ({ async ping() {} }),
				plainObject: { async ping() {} },
				_private: namespaceOn(stack, ordersCompute, 'private'),
			},
			defaultCompute,
			getComputes(stack),
		);
		assert.strictEqual(routes.size, 0);
	});

	test('inherits the compute from an ancestor scope', () => {
		const { stack, defaultCompute, ordersCompute } = computes('RoutesInherit');
		const parent = new Scope('parent', { parent: stack as never });
		parent._compute = ordersCompute;
		const child = new Scope('child', { parent });
		const orders = new ApiNamespace(child, 'orders', () => ({ async ping() {} }));
		assert.deepStrictEqual(resolveNamespaceRoutes({ orders }, defaultCompute, getComputes(stack)).get(ordersCompute), ['orders']);
	});

	test("uses the namespace's own compute resolver, not its scope's compute", () => {
		// Stands in for the future per-namespace compute option: the namespace
		// resolves to a different compute than its scope does, and routing follows
		// the namespace.
		const { stack, defaultCompute, ordersCompute } = computes('RoutesOwnResolver');
		const orders = namespaceOn(stack, defaultCompute, 'orders') as Record<symbol, unknown>;
		orders[API_NAMESPACE_COMPUTE] = () => ordersCompute;
		assert.deepStrictEqual(resolveNamespaceRoutes({ orders }, defaultCompute, getComputes(stack)).get(ordersCompute), ['orders']);
	});

	test("skips a compute that isn't one of the owner's — another backend's", () => {
		const { stack, defaultCompute } = computes('RoutesForeign');
		const otherStack = new cdk.Stack(new cdk.App(), 'RoutesForeignOther');
		const foreignCompute = new StubCompute(otherStack, 'ForeignCompute', makeFn(otherStack, 'ForeignFn'));
		const routes = resolveNamespaceRoutes(
			{ reports: namespaceOn(otherStack, foreignCompute, 'reports') },
			defaultCompute,
			getComputes(stack),
		);
		assert.strictEqual(routes.size, 0);
	});

	test('resolves the compute when called, not when the namespace was constructed', () => {
		const { stack, defaultCompute, ordersCompute } = computes('RoutesLate');
		const scope = new Scope('late', { parent: stack as never });
		const orders = new ApiNamespace(scope, 'orders', () => ({ async ping() {} }));
		scope._compute = ordersCompute; // assigned after the namespace exists
		assert.deepStrictEqual(resolveNamespaceRoutes({ orders }, defaultCompute, getComputes(stack)).get(ordersCompute), ['orders']);
	});
});

describe('createSharedGateway — stage throttling (defaults.throttling)', () => {
	test('production carries the 1000/2000 rate + burst default', () => {
		const { stack, compute } = setup('SharedGwThrottleProd');
		createSharedGateway(stack, {
			defaultCompute: compute,
			defaults: BlocksPresets.production,
		});
		Template.fromStack(stack).hasResourceProperties('AWS::ApiGateway::Stage', {
			MethodSettings: Match.arrayWith([
				Match.objectLike({
					HttpMethod: '*',
					ResourcePath: '/*',
					ThrottlingRateLimit: 1000,
					ThrottlingBurstLimit: 2000,
				}),
			]),
		});
	});

	test('sandbox caps the stage tighter (200/400)', () => {
		const { stack, compute } = setup('SharedGwThrottleSandbox');
		createSharedGateway(stack, { defaultCompute: compute, defaults: BlocksPresets.sandbox });
		Template.fromStack(stack).hasResourceProperties('AWS::ApiGateway::Stage', {
			MethodSettings: Match.arrayWith([
				Match.objectLike({ ThrottlingRateLimit: 200, ThrottlingBurstLimit: 400 }),
			]),
		});
	});

	test('a per-stack throttling override wins over the preset', () => {
		const { stack, compute } = setup('SharedGwThrottleOverride');
		createSharedGateway(stack, {
			defaultCompute: compute,
			defaults: { ...BlocksPresets.production, throttling: { rateLimit: 50, burstLimit: 75 } },
		});
		Template.fromStack(stack).hasResourceProperties('AWS::ApiGateway::Stage', {
			MethodSettings: Match.arrayWith([Match.objectLike({ ThrottlingRateLimit: 50, ThrottlingBurstLimit: 75 })]),
		});
	});
});

describe('createSharedGateway — stage access logging (defaults.accessLogging)', () => {
	// Access logging is opt-in (off in both presets), so enable it explicitly.
	const withAccessLogging = { ...BlocksPresets.production, accessLogging: true };

	test('opt-in enables JSON access logging + the account CloudWatch role', () => {
		const { stack, compute } = setup('SharedGwAccessLogProd');
		createSharedGateway(stack, { defaultCompute: compute, defaults: withAccessLogging });
		const template = Template.fromStack(stack);
		// The account-level CloudWatch role is provisioned exactly once.
		template.resourceCountIs('AWS::ApiGateway::Account', 1);
		template.hasResourceProperties('AWS::ApiGateway::Stage', {
			AccessLogSetting: Match.objectLike({ DestinationArn: Match.anyValue(), Format: Match.anyValue() }),
		});
	});

	test('the stage depends on the account so a clean-account first deploy succeeds', () => {
		const { stack, compute } = setup('SharedGwAccessLogDependsOn');
		createSharedGateway(stack, { defaultCompute: compute, defaults: withAccessLogging });
		const template = Template.fromStack(stack);
		const [accountId] = Object.keys(template.findResources('AWS::ApiGateway::Account'));
		const [stage] = Object.values(template.findResources('AWS::ApiGateway::Stage'));
		assert.ok(
			(stage.DependsOn as string[] | undefined)?.includes(accountId),
			'stage DependsOn the ApiGateway::Account',
		);
	});

	test('the production access-log group is RETAINed (audit trail survives teardown)', () => {
		const { stack, compute } = setup('SharedGwAccessLogRetain');
		createSharedGateway(stack, { defaultCompute: compute, defaults: withAccessLogging });
		Template.fromStack(stack).hasResource('AWS::Logs::LogGroup', { DeletionPolicy: 'Retain' });
	});

	test('off by default (production preset) — no stage AccessLogSetting, no account role', () => {
		const { stack, compute } = setup('SharedGwAccessLogDefaultOff');
		createSharedGateway(stack, {
			defaultCompute: compute,
			defaults: BlocksPresets.production,
		});
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::ApiGateway::Account', 0);
		template.hasResourceProperties('AWS::ApiGateway::Stage', { AccessLogSetting: Match.absent() });
	});

	test('sandbox disables access logging (no stage AccessLogSetting, no account role)', () => {
		const { stack, compute } = setup('SharedGwAccessLogSandbox');
		createSharedGateway(stack, { defaultCompute: compute, defaults: BlocksPresets.sandbox });
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::ApiGateway::Account', 0);
		template.hasResourceProperties('AWS::ApiGateway::Stage', { AccessLogSetting: Match.absent() });
	});
});
