// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the stack-level shared REST API gateway. Exercises
 * `createSharedGateway` directly with stub computes + presets, pinning the
 * single-API shape, the catch-all resource tree → default-compute integration,
 * the multi-compute per-namespace fan-out, stage throttling (stack-wide and
 * per-namespace), optional access logging (with the account-level CloudWatch
 * role), and the `apiUrl` shape.
 */

import assert from 'node:assert';
import { before, describe, test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import { Code, type IFunction, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';
import { ApiNamespace } from '../api.js';
import type { BlocksThrottling } from './blocks-defaults.js';
import { BlocksPresets } from './blocks-defaults.js';
import { Compute } from './compute/compute.js';
import { getComputes } from './compute/compute-registry.js';
import { Scope } from './index.js';
import { createSharedGateway } from './shared-gateway.js';

before(() => {
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
});

// Minimal stand-in for a real HTTP compute (e.g. LambdaCompute, which core's own
// tests can't depend on): a Compute that owns a function and exposes it via
// apiHandler(), so the gateway has something to integrate. The `scope as never`
// cast is test plumbing — a plain cdk.Stack isn't a ScopeParent, but Compute only
// needs it as a construct-tree parent here (it never reads root-derived state).
class StubCompute extends Compute {
	constructor(
		scope: Construct,
		id: string,
		readonly fn: IFunction,
		throttle?: BlocksThrottling,
	) {
		super(id, { parent: scope as never });
		this._routeThrottle = throttle;
	}

	override apiHandler(): IFunction {
		return this.fn;
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

/** Assign `name` to `compute` through the internal `_compute` seam and record it via a real ApiNamespace. */
function assignNamespace(stack: cdk.Stack, compute: Compute, name: string): void {
	const apiScope = new Scope(`${name}-scope`, { parent: stack as never });
	apiScope._compute = compute;
	new ApiNamespace(apiScope, name, () => ({
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
			computes: [compute],
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

	test('routes the RPC endpoint, per-namespace RPC paths, RawRoute sub-paths, and every other path', () => {
		const { stack, compute } = setup('SharedGwTree');
		createSharedGateway(stack, {
			computes: [compute],
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
			computes: [compute],
			defaultCompute: compute,
			defaults: BlocksPresets.production,
		});
		assert.strictEqual(gw.restApi.node.path, `${compute.node.path}/API`);
	});

	test('apiUrl is the stage URL plus the RPC prefix', () => {
		const { stack, compute } = setup('SharedGwUrl');
		const gw = createSharedGateway(stack, {
			computes: [compute],
			defaultCompute: compute,
			defaults: BlocksPresets.production,
		});

		assert.ok(gw.apiUrl.endsWith('/aws-blocks/api'), `apiUrl should end with the RPC prefix, got: ${gw.apiUrl}`);
		assert.ok(gw.apiUrl.startsWith(gw.restApi.url), 'apiUrl is built from the stage URL');
	});
});

describe('createSharedGateway — multi-compute fan-out', () => {
	test('routes a non-default compute namespace to its own function; the rest stays on the default', () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'FanOut');
		const defaultCompute = new StubCompute(stack, 'DefaultCompute', makeFn(stack, 'DefaultFn'));
		const ordersCompute = new StubCompute(stack, 'OrdersCompute', makeFn(stack, 'OrdersFn'));

		// Assign a namespace to the second compute via the internal `_compute` seam
		// (exactly what the future compute-assignment surface will do); the real
		// recordNamespaceOnCompute path populates its list.
		assignNamespace(stack, ordersCompute, 'orders');
		assert.deepStrictEqual(ordersCompute.namespaces, ['orders'], 'namespace recorded on the second compute');

		createSharedGateway(stack, {
			computes: getComputes(stack),
			defaultCompute,
			defaults: BlocksPresets.production,
		});

		// Correlate method → integration → function so we PROVE the fan-out.
		const defaultFnId = stack.getLogicalId(defaultCompute.fn.node.defaultChild as cdk.CfnElement);
		const ordersFnId = stack.getLogicalId(ordersCompute.fn.node.defaultChild as cdk.CfnElement);
		const fnIds = [defaultFnId, ordersFnId];

		assert.strictEqual(methodTargetFnId(stack, '/aws-blocks/api/orders', 'ANY', fnIds), ordersFnId);
		assert.strictEqual(methodTargetFnId(stack, '/aws-blocks/api/orders/{proxy+}', 'ANY', fnIds), ordersFnId);
		// Everything else stays on the default compute.
		assert.strictEqual(methodTargetFnId(stack, '/aws-blocks/api', 'POST', fnIds), defaultFnId);
		assert.strictEqual(methodTargetFnId(stack, '/aws-blocks/api/{proxy+}', 'ANY', fnIds), defaultFnId);
		assert.strictEqual(methodTargetFnId(stack, '/aws-blocks/{proxy+}', 'ANY', fnIds), defaultFnId);
		assert.strictEqual(methodTargetFnId(stack, '/{proxy+}', 'ANY', fnIds), defaultFnId);
	});

	test('a compute hosting no namespace contributes no resources', () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'FanOutIdle');
		const defaultCompute = new StubCompute(stack, 'DefaultCompute', makeFn(stack, 'DefaultFn'));
		new StubCompute(stack, 'IdleCompute', makeFn(stack, 'IdleFn'));

		createSharedGateway(stack, {
			computes: getComputes(stack),
			defaultCompute,
			defaults: BlocksPresets.production,
		});

		const resources = Template.fromStack(stack).toJSON().Resources as CfnResources;
		assert.strictEqual(Object.keys(resourcePaths(resources)).length, 5, 'only the catch-all tree');
	});

	test('a non-default compute throttle override lands as per-namespace method settings', () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'FanOutThrottle');
		const defaultCompute = new StubCompute(stack, 'DefaultCompute', makeFn(stack, 'DefaultFn'));
		const reports = new StubCompute(stack, 'ReportsCompute', makeFn(stack, 'ReportsFn'), {
			rateLimit: 5,
			burstLimit: 7,
		});
		assignNamespace(stack, reports, 'reports');

		createSharedGateway(stack, {
			computes: getComputes(stack),
			defaultCompute,
			defaults: BlocksPresets.production,
		});

		Template.fromStack(stack).hasResourceProperties('AWS::ApiGateway::Stage', {
			MethodSettings: Match.arrayWith([
				// The stack-wide default on every method…
				Match.objectLike({ HttpMethod: '*', ResourcePath: '/*', ThrottlingRateLimit: 1000 }),
				// …and the namespace override on its resources (CDK encodes `/` as `~1`).
				Match.objectLike({
					HttpMethod: '*',
					ResourcePath: '/~1aws-blocks~1api~1reports',
					ThrottlingRateLimit: 5,
					ThrottlingBurstLimit: 7,
				}),
				Match.objectLike({
					HttpMethod: '*',
					ResourcePath: '/~1aws-blocks~1api~1reports~1{proxy+}',
					ThrottlingRateLimit: 5,
					ThrottlingBurstLimit: 7,
				}),
			]),
		});
	});
});

describe('createSharedGateway — stage throttling (defaults.throttling)', () => {
	test('production carries the 1000/2000 rate + burst default', () => {
		const { stack, compute } = setup('SharedGwThrottleProd');
		createSharedGateway(stack, {
			computes: [compute],
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
		createSharedGateway(stack, { computes: [compute], defaultCompute: compute, defaults: BlocksPresets.sandbox });
		Template.fromStack(stack).hasResourceProperties('AWS::ApiGateway::Stage', {
			MethodSettings: Match.arrayWith([
				Match.objectLike({ ThrottlingRateLimit: 200, ThrottlingBurstLimit: 400 }),
			]),
		});
	});

	test('a per-stack throttling override wins over the preset', () => {
		const { stack, compute } = setup('SharedGwThrottleOverride');
		createSharedGateway(stack, {
			computes: [compute],
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
		createSharedGateway(stack, { computes: [compute], defaultCompute: compute, defaults: withAccessLogging });
		const template = Template.fromStack(stack);
		// The account-level CloudWatch role is provisioned exactly once.
		template.resourceCountIs('AWS::ApiGateway::Account', 1);
		template.hasResourceProperties('AWS::ApiGateway::Stage', {
			AccessLogSetting: Match.objectLike({ DestinationArn: Match.anyValue(), Format: Match.anyValue() }),
		});
	});

	test('the stage depends on the account so a clean-account first deploy succeeds', () => {
		const { stack, compute } = setup('SharedGwAccessLogDependsOn');
		createSharedGateway(stack, { computes: [compute], defaultCompute: compute, defaults: withAccessLogging });
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
		createSharedGateway(stack, { computes: [compute], defaultCompute: compute, defaults: withAccessLogging });
		Template.fromStack(stack).hasResource('AWS::Logs::LogGroup', { DeletionPolicy: 'Retain' });
	});

	test('off by default (production preset) — no stage AccessLogSetting, no account role', () => {
		const { stack, compute } = setup('SharedGwAccessLogDefaultOff');
		createSharedGateway(stack, {
			computes: [compute],
			defaultCompute: compute,
			defaults: BlocksPresets.production,
		});
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::ApiGateway::Account', 0);
		template.hasResourceProperties('AWS::ApiGateway::Stage', { AccessLogSetting: Match.absent() });
	});

	test('sandbox disables access logging (no stage AccessLogSetting, no account role)', () => {
		const { stack, compute } = setup('SharedGwAccessLogSandbox');
		createSharedGateway(stack, { computes: [compute], defaultCompute: compute, defaults: BlocksPresets.sandbox });
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::ApiGateway::Account', 0);
		template.hasResourceProperties('AWS::ApiGateway::Stage', { AccessLogSetting: Match.absent() });
	});
});
