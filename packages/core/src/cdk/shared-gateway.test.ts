// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the stack-level shared HTTP API v2 gateway. Exercises
 * `createSharedGateway` directly with stub computes + presets, pinning the
 * single-API shape, the `$default` catch-all → default-compute integration, the
 * multi-compute per-namespace fan-out (one integration per non-default compute,
 * explicit routes for its namespaces), stage throttling, optional access logging
 * (with NO account-level CloudWatch role), and the stage-less `apiUrl` shape.
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

describe('createSharedGateway — single shared HTTP API v2', () => {
	test('provisions exactly one HTTP API with a catch-all integration to the function', () => {
		const { stack, compute } = setup('SharedGwShape');
		const gw = createSharedGateway(stack, {
			computes: [compute],
			defaultCompute: compute,
			defaults: BlocksPresets.production,
		});

		assert.ok(gw.httpApi, 'returns the HttpApi');

		const template = Template.fromStack(stack);
		// Exactly one HTTP API v2, and NO REST (v1) API.
		template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
		template.resourceCountIs('AWS::ApiGateway::RestApi', 0);
		// A single compute → a single integration (no per-namespace fan-out routes).
		template.resourceCountIs('AWS::ApiGatewayV2::Integration', 1);
		template.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
			IntegrationType: 'AWS_PROXY',
			PayloadFormatVersion: '2.0',
		});
		template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: '$default' });
	});

	test('grants a {apiId}/*/* invoke permission so the $default route can reach the function', () => {
		const { stack, compute } = setup('SharedGwDefaultPerm');
		createSharedGateway(stack, { computes: [compute], defaultCompute: compute, defaults: BlocksPresets.production });

		// CDK's HttpLambdaIntegration grants a REST-style {apiId}/*/*/* source ARN that
		// does NOT match the HTTP API `$default` route's invoke ARN; createSharedGateway
		// adds an explicit {apiId}/*/* permission so `$default` traffic can invoke the
		// default compute's function. Regression guard for a deploy-only 500 the local
		// tests cannot surface.
		const perms = Template.fromStack(stack).findResources('AWS::Lambda::Permission');
		const sourceArns = Object.values(perms).map((p) => JSON.stringify(p.Properties?.SourceArn));
		assert.ok(
			sourceArns.some((a) => a.includes('/*/*') && !a.includes('/*/*/*')),
			`expected a $default-covering {apiId}/*/* permission, got: ${sourceArns.join(' ; ')}`,
		);
	});

	test('apiUrl ends with /aws-blocks/api and carries no stage path segment', () => {
		const { stack, compute } = setup('SharedGwUrl');
		const gw = createSharedGateway(stack, {
			computes: [compute],
			defaultCompute: compute,
			defaults: BlocksPresets.production,
		});

		assert.ok(gw.apiUrl.endsWith('/aws-blocks/api'), `apiUrl should end with the RPC prefix, got: ${gw.apiUrl}`);
		assert.ok(!gw.apiUrl.includes('$default'), 'the $default stage must not appear in the URL');
	});
});

describe('createSharedGateway — multi-compute fan-out', () => {
	test('routes a non-default compute namespace to its own integration; $default stays on the default', () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'FanOut');
		const defaultCompute = new StubCompute(stack, 'DefaultCompute', makeFn(stack, 'DefaultFn'));
		const ordersCompute = new StubCompute(stack, 'OrdersCompute', makeFn(stack, 'OrdersFn'));

		// Assign a namespace to the second compute via the internal `_compute` seam
		// (exactly what the future compute-assignment surface will do), then build the
		// ApiNamespace so the real recordNamespaceOnCompute path populates its list.
		const apiScope = new Scope('orders-scope', { parent: stack as never });
		apiScope._compute = ordersCompute;
		new ApiNamespace(apiScope, 'orders', () => ({
			async ping() {
				return 'pong';
			},
		}));
		assert.deepStrictEqual(ordersCompute.namespaces, ['orders'], 'namespace recorded on the second compute');

		createSharedGateway(stack, {
			computes: getComputes(stack),
			defaultCompute,
			defaults: BlocksPresets.production,
		});

		const template = Template.fromStack(stack);
		// Two integrations: the default `$default` + the orders compute's.
		template.resourceCountIs('AWS::ApiGatewayV2::Integration', 2);
		// Explicit namespace routes (base path + greedy subtree) + the $default catch-all.
		template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'ANY /aws-blocks/api/orders' });
		template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'ANY /aws-blocks/api/orders/{proxy+}' });
		template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: '$default' });

		// Correlate route → integration → function so we PROVE the fan-out: the
		// orders route targets the orders function's integration; $default the default.
		const resources = template.toJSON().Resources as Record<
			string,
			{ Type: string; Properties: Record<string, unknown> }
		>;
		const defaultFnId = stack.getLogicalId(defaultCompute.fn.node.defaultChild as cdk.CfnElement);
		const ordersFnId = stack.getLogicalId(ordersCompute.fn.node.defaultChild as cdk.CfnElement);

		const integrationFnId = (integrationLogicalId: string): string => {
			const uri = JSON.stringify(resources[integrationLogicalId].Properties.IntegrationUri);
			if (uri.includes(ordersFnId)) return ordersFnId;
			if (uri.includes(defaultFnId)) return defaultFnId;
			throw new Error(`integration ${integrationLogicalId} points at neither function: ${uri}`);
		};
		const routeTargetFnId = (routeKey: string): string => {
			const route = Object.values(resources).find(
				(r) => r.Type === 'AWS::ApiGatewayV2::Route' && r.Properties.RouteKey === routeKey,
			);
			assert.ok(route, `route ${routeKey} exists`);
			// Target is "integrations/<Ref:IntegrationLogicalId>" — pull the ref out.
			const target = JSON.stringify(route.Properties.Target);
			const integrationLogicalId = Object.keys(resources).find(
				(id) => resources[id].Type === 'AWS::ApiGatewayV2::Integration' && target.includes(id),
			);
			assert.ok(integrationLogicalId, `route ${routeKey} targets an integration`);
			return integrationFnId(integrationLogicalId);
		};

		assert.strictEqual(routeTargetFnId('ANY /aws-blocks/api/orders'), ordersFnId, 'orders route → orders function');
		assert.strictEqual(
			routeTargetFnId('ANY /aws-blocks/api/orders/{proxy+}'),
			ordersFnId,
			'orders subtree → orders function',
		);
		assert.strictEqual(routeTargetFnId('$default'), defaultFnId, '$default → default function');
	});

	test('a non-default compute route-throttle override lands as stage RouteSettings', () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'FanOutThrottle');
		const defaultCompute = new StubCompute(stack, 'DefaultCompute', makeFn(stack, 'DefaultFn'));
		const reports = new StubCompute(stack, 'ReportsCompute', makeFn(stack, 'ReportsFn'), {
			rateLimit: 5,
			burstLimit: 7,
		});
		const apiScope = new Scope('reports-scope', { parent: stack as never });
		apiScope._compute = reports;
		new ApiNamespace(apiScope, 'reports', () => ({
			async run() {
				return 'ok';
			},
		}));

		createSharedGateway(stack, {
			computes: getComputes(stack),
			defaultCompute,
			defaults: BlocksPresets.production,
		});

		Template.fromStack(stack).hasResourceProperties('AWS::ApiGatewayV2::Stage', {
			RouteSettings: Match.objectLike({
				'ANY /aws-blocks/api/reports': { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 7 },
			}),
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
		Template.fromStack(stack).hasResourceProperties('AWS::ApiGatewayV2::Stage', {
			DefaultRouteSettings: Match.objectLike({ ThrottlingRateLimit: 1000, ThrottlingBurstLimit: 2000 }),
		});
	});

	test('sandbox caps the stage tighter (200/400)', () => {
		const { stack, compute } = setup('SharedGwThrottleSandbox');
		createSharedGateway(stack, { computes: [compute], defaultCompute: compute, defaults: BlocksPresets.sandbox });
		Template.fromStack(stack).hasResourceProperties('AWS::ApiGatewayV2::Stage', {
			DefaultRouteSettings: Match.objectLike({ ThrottlingRateLimit: 200, ThrottlingBurstLimit: 400 }),
		});
	});

	test('a per-stack throttling override wins over the preset', () => {
		const { stack, compute } = setup('SharedGwThrottleOverride');
		createSharedGateway(stack, {
			computes: [compute],
			defaultCompute: compute,
			defaults: { ...BlocksPresets.production, throttling: { rateLimit: 50, burstLimit: 75 } },
		});
		Template.fromStack(stack).hasResourceProperties('AWS::ApiGatewayV2::Stage', {
			DefaultRouteSettings: Match.objectLike({ ThrottlingRateLimit: 50, ThrottlingBurstLimit: 75 }),
		});
	});
});

describe('createSharedGateway — stage access logging (defaults.accessLogging)', () => {
	const withAccessLogging = { ...BlocksPresets.production, accessLogging: true };

	test('opt-in enables JSON access logging and needs NO ApiGateway::Account role', () => {
		const { stack, compute } = setup('SharedGwAccessLogProd');
		createSharedGateway(stack, { computes: [compute], defaultCompute: compute, defaults: withAccessLogging });
		const template = Template.fromStack(stack);
		// HTTP API access logging grants via the log-group resource policy — no
		// account-level CloudWatch role (unlike REST v1).
		template.resourceCountIs('AWS::ApiGateway::Account', 0);
		template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
			AccessLogSettings: Match.objectLike({ DestinationArn: Match.anyValue(), Format: Match.anyValue() }),
		});
	});

	test('the production access-log group is RETAINed (audit trail survives teardown)', () => {
		const { stack, compute } = setup('SharedGwAccessLogRetain');
		createSharedGateway(stack, { computes: [compute], defaultCompute: compute, defaults: withAccessLogging });
		Template.fromStack(stack).hasResource('AWS::Logs::LogGroup', { DeletionPolicy: 'Retain' });
	});

	test('off by default (production preset) — no stage AccessLogSettings, no account role', () => {
		const { stack, compute } = setup('SharedGwAccessLogDefaultOff');
		createSharedGateway(stack, {
			computes: [compute],
			defaultCompute: compute,
			defaults: BlocksPresets.production,
		});
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::ApiGateway::Account', 0);
		template.hasResourceProperties('AWS::ApiGatewayV2::Stage', { AccessLogSettings: Match.absent() });
	});

	test('sandbox disables access logging (no stage AccessLogSettings)', () => {
		const { stack, compute } = setup('SharedGwAccessLogSandbox');
		createSharedGateway(stack, { computes: [compute], defaultCompute: compute, defaults: BlocksPresets.sandbox });
		Template.fromStack(stack).hasResourceProperties('AWS::ApiGatewayV2::Stage', {
			AccessLogSettings: Match.absent(),
		});
	});
});
