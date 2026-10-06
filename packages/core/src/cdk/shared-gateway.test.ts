// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the stack-level shared HTTP API v2 gateway. Exercises
 * `createSharedGateway` directly with a stub Lambda function + presets, pinning
 * the single-API shape, the `$default` catch-all → function integration, stage
 * throttling, optional access logging (with NO account-level CloudWatch role),
 * and the stage-less `apiUrl` shape.
 */

import assert from 'node:assert';
import { before, describe, test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
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

describe('createSharedGateway — single shared HTTP API v2', () => {
	test('provisions exactly one HTTP API with a catch-all integration to the function', () => {
		const { stack, fn } = setup('SharedGwShape');
		const gw = createSharedGateway(stack, { handler: fn, defaults: BlocksPresets.production });

		assert.ok(gw.httpApi, 'returns the HttpApi');

		const template = Template.fromStack(stack);
		// Exactly one HTTP API v2, and NO REST (v1) API.
		template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
		template.resourceCountIs('AWS::ApiGateway::RestApi', 0);
		// A proxy integration to the function + the `$default` catch-all route.
		template.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
			IntegrationType: 'AWS_PROXY',
			PayloadFormatVersion: '2.0',
		});
		template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: '$default' });
	});

	test('grants a {apiId}/*/* invoke permission so the $default route can reach the function', () => {
		const { stack, fn } = setup('SharedGwDefaultPerm');
		createSharedGateway(stack, { handler: fn, defaults: BlocksPresets.production });

		// CDK's HttpLambdaIntegration grants a REST-style {apiId}/*/*/* source ARN that
		// does NOT match the HTTP API `$default` route's invoke ARN; createSharedGateway
		// adds an explicit {apiId}/*/* permission so `$default` traffic can invoke the
		// function. Regression guard for a deploy-only 500 the local tests cannot surface.
		const perms = Template.fromStack(stack).findResources('AWS::Lambda::Permission');
		const sourceArns = Object.values(perms).map((p) => JSON.stringify(p.Properties?.SourceArn));
		assert.ok(
			sourceArns.some((a) => a.includes('/*/*') && !a.includes('/*/*/*')),
			`expected a $default-covering {apiId}/*/* permission, got: ${sourceArns.join(' ; ')}`,
		);
	});

	test('apiUrl ends with /aws-blocks/api and carries no stage path segment', () => {
		const { stack, fn } = setup('SharedGwUrl');
		const gw = createSharedGateway(stack, { handler: fn, defaults: BlocksPresets.production });

		assert.ok(gw.apiUrl.endsWith('/aws-blocks/api'), `apiUrl should end with the RPC prefix, got: ${gw.apiUrl}`);
		assert.ok(!gw.apiUrl.includes('$default'), 'the $default stage must not appear in the URL');
	});
});

describe('createSharedGateway — stage throttling (defaults.throttling)', () => {
	test('production carries the 1000/2000 rate + burst default', () => {
		const { stack, fn } = setup('SharedGwThrottleProd');
		createSharedGateway(stack, { handler: fn, defaults: BlocksPresets.production });
		Template.fromStack(stack).hasResourceProperties('AWS::ApiGatewayV2::Stage', {
			DefaultRouteSettings: Match.objectLike({ ThrottlingRateLimit: 1000, ThrottlingBurstLimit: 2000 }),
		});
	});

	test('sandbox caps the stage tighter (200/400)', () => {
		const { stack, fn } = setup('SharedGwThrottleSandbox');
		createSharedGateway(stack, { handler: fn, defaults: BlocksPresets.sandbox });
		Template.fromStack(stack).hasResourceProperties('AWS::ApiGatewayV2::Stage', {
			DefaultRouteSettings: Match.objectLike({ ThrottlingRateLimit: 200, ThrottlingBurstLimit: 400 }),
		});
	});

	test('a per-stack throttling override wins over the preset', () => {
		const { stack, fn } = setup('SharedGwThrottleOverride');
		createSharedGateway(stack, {
			handler: fn,
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
		const { stack, fn } = setup('SharedGwAccessLogProd');
		createSharedGateway(stack, { handler: fn, defaults: withAccessLogging });
		const template = Template.fromStack(stack);
		// HTTP API access logging grants via the log-group resource policy — no
		// account-level CloudWatch role (unlike REST v1).
		template.resourceCountIs('AWS::ApiGateway::Account', 0);
		template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
			AccessLogSettings: Match.objectLike({ DestinationArn: Match.anyValue(), Format: Match.anyValue() }),
		});
	});

	test('the production access-log group is RETAINed (audit trail survives teardown)', () => {
		const { stack, fn } = setup('SharedGwAccessLogRetain');
		createSharedGateway(stack, { handler: fn, defaults: withAccessLogging });
		Template.fromStack(stack).hasResource('AWS::Logs::LogGroup', { DeletionPolicy: 'Retain' });
	});

	test('off by default (production preset) — no stage AccessLogSettings, no account role', () => {
		const { stack, fn } = setup('SharedGwAccessLogDefaultOff');
		createSharedGateway(stack, { handler: fn, defaults: BlocksPresets.production });
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::ApiGateway::Account', 0);
		template.hasResourceProperties('AWS::ApiGatewayV2::Stage', { AccessLogSettings: Match.absent() });
	});

	test('sandbox disables access logging (no stage AccessLogSettings)', () => {
		const { stack, fn } = setup('SharedGwAccessLogSandbox');
		createSharedGateway(stack, { handler: fn, defaults: BlocksPresets.sandbox });
		Template.fromStack(stack).hasResourceProperties('AWS::ApiGatewayV2::Stage', {
			AccessLogSettings: Match.absent(),
		});
	});
});
