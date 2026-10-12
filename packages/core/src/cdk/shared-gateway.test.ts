// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the stack-level shared REST API gateway. Exercises
 * `createSharedGateway` directly with a stub Lambda function + presets, pinning
 * the single-API shape, the proxy resource tree → function integration, stage
 * throttling, optional access logging (with the account-level CloudWatch role),
 * and the `apiUrl` shape.
 */

import assert from 'node:assert';
import { before, describe, test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { BlocksPresets } from './blocks-defaults.js';
import { createSharedGateway } from './shared-gateway.js';

before(() => {
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
});

function setup(id: string) {
	const app = new cdk.App();
	const stack = new cdk.Stack(app, id);
	const fn = new LambdaFunction(stack, 'Handler', {
		runtime: Runtime.NODEJS_22_X,
		handler: 'index.handler',
		code: Code.fromInline('exports.handler = async () => ({ statusCode: 200, body: "{}" });'),
	});
	return { stack, fn };
}

describe('createSharedGateway — single shared REST API', () => {
	test('provisions exactly one REST API with proxy integrations to the function', () => {
		const { stack, fn } = setup('SharedGwShape');
		const gw = createSharedGateway(stack, { handler: fn, defaults: BlocksPresets.production });

		assert.ok(gw.restApi, 'returns the RestApi');

		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
		template.hasResourceProperties('AWS::ApiGateway::Method', {
			HttpMethod: 'ANY',
			Integration: Match.objectLike({ Type: 'AWS_PROXY' }),
		});
	});

	test('routes the RPC endpoint, RawRoute sub-paths, and every other path to the function', () => {
		const { stack, fn } = setup('SharedGwTree');
		createSharedGateway(stack, { handler: fn, defaults: BlocksPresets.production });
		const template = Template.fromStack(stack);

		const paths = Object.values(template.findResources('AWS::ApiGateway::Resource')).map(
			(r) => r.Properties?.PathPart,
		);
		// /aws-blocks, /aws-blocks/{proxy+}, /aws-blocks/api, and the root /{proxy+}.
		assert.deepStrictEqual(paths.sort(), ['aws-blocks', 'api', '{proxy+}', '{proxy+}'].sort());

		// /aws-blocks/api carries explicit POST + OPTIONS.
		const methods = Object.values(template.findResources('AWS::ApiGateway::Method')).map(
			(m) => m.Properties?.HttpMethod,
		);
		assert.ok(methods.includes('POST'), 'RPC endpoint has POST');
		assert.ok(methods.includes('OPTIONS'), 'RPC endpoint has OPTIONS');
		// ANY on /aws-blocks/{proxy+}, on the root /{proxy+}, and on / itself (a root
		// proxy also adds ANY to the root so `/` is reachable).
		assert.strictEqual(methods.filter((m) => m === 'ANY').length, 3, 'three ANY proxy methods');
	});

	test('builds under the given scope with the per-compute gateway construct ids', () => {
		// The scope is the default compute; keeping the old `API` id there keeps the
		// logical IDs a deployed app's REST API was created with.
		const { stack, fn } = setup('SharedGwIds');
		const owner = new Construct(stack, 'DefaultCompute');
		const gw = createSharedGateway(owner, { handler: fn, defaults: BlocksPresets.production });
		assert.strictEqual(gw.restApi.node.path, `${owner.node.path}/API`);
	});

	test('apiUrl is the stage URL plus the RPC prefix', () => {
		const { stack, fn } = setup('SharedGwUrl');
		const gw = createSharedGateway(stack, { handler: fn, defaults: BlocksPresets.production });

		assert.ok(gw.apiUrl.endsWith('/aws-blocks/api'), `apiUrl should end with the RPC prefix, got: ${gw.apiUrl}`);
		assert.ok(gw.apiUrl.startsWith(gw.restApi.url), 'apiUrl is built from the stage URL');
	});
});

describe('createSharedGateway — stage throttling (defaults.throttling)', () => {
	test('production carries the 1000/2000 rate + burst default', () => {
		const { stack, fn } = setup('SharedGwThrottleProd');
		createSharedGateway(stack, { handler: fn, defaults: BlocksPresets.production });
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
		const { stack, fn } = setup('SharedGwThrottleSandbox');
		createSharedGateway(stack, { handler: fn, defaults: BlocksPresets.sandbox });
		Template.fromStack(stack).hasResourceProperties('AWS::ApiGateway::Stage', {
			MethodSettings: Match.arrayWith([
				Match.objectLike({ ThrottlingRateLimit: 200, ThrottlingBurstLimit: 400 }),
			]),
		});
	});

	test('a per-stack throttling override wins over the preset', () => {
		const { stack, fn } = setup('SharedGwThrottleOverride');
		createSharedGateway(stack, {
			handler: fn,
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
		const { stack, fn } = setup('SharedGwAccessLogProd');
		createSharedGateway(stack, { handler: fn, defaults: withAccessLogging });
		const template = Template.fromStack(stack);
		// The account-level CloudWatch role is provisioned exactly once.
		template.resourceCountIs('AWS::ApiGateway::Account', 1);
		template.hasResourceProperties('AWS::ApiGateway::Stage', {
			AccessLogSetting: Match.objectLike({ DestinationArn: Match.anyValue(), Format: Match.anyValue() }),
		});
	});

	test('the stage depends on the account so a clean-account first deploy succeeds', () => {
		const { stack, fn } = setup('SharedGwAccessLogDependsOn');
		createSharedGateway(stack, { handler: fn, defaults: withAccessLogging });
		const template = Template.fromStack(stack);
		const [accountId] = Object.keys(template.findResources('AWS::ApiGateway::Account'));
		const [stage] = Object.values(template.findResources('AWS::ApiGateway::Stage'));
		assert.ok(
			(stage.DependsOn as string[] | undefined)?.includes(accountId),
			'stage DependsOn the ApiGateway::Account',
		);
	});

	test('the production access-log group is RETAINed (audit trail survives teardown)', () => {
		const { stack, fn } = setup('SharedGwAccessLogRetain');
		createSharedGateway(stack, { handler: fn, defaults: withAccessLogging });
		Template.fromStack(stack).hasResource('AWS::Logs::LogGroup', { DeletionPolicy: 'Retain' });
	});

	test('off by default (production preset) — no stage AccessLogSetting, no account role', () => {
		const { stack, fn } = setup('SharedGwAccessLogDefaultOff');
		createSharedGateway(stack, { handler: fn, defaults: BlocksPresets.production });
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::ApiGateway::Account', 0);
		template.hasResourceProperties('AWS::ApiGateway::Stage', { AccessLogSetting: Match.absent() });
	});

	test('sandbox disables access logging (no stage AccessLogSetting, no account role)', () => {
		const { stack, fn } = setup('SharedGwAccessLogSandbox');
		createSharedGateway(stack, { handler: fn, defaults: BlocksPresets.sandbox });
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::ApiGateway::Account', 0);
		template.hasResourceProperties('AWS::ApiGateway::Stage', { AccessLogSetting: Match.absent() });
	});
});
