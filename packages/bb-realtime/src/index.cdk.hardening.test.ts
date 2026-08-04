// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Synth test: the Realtime WebSocket stage adopts the shared hardening defaults
 * (throttling + access logging), and a stack-level `hardening` override flows
 * through. Uses BlocksBackend.create with fixture handler/backend so the real
 * getOrCreateSharedInfra path runs.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { BlocksBackend } from '@aws-blocks/core/cdk';

before(() => {
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const handlerPath = join(__dirname, '__fixtures__', 'handler.js');
const backendPath = join(__dirname, '__fixtures__', 'realtime-backend.js');

describe('bb-realtime: WebSocket stage adopts shared hardening defaults', () => {
	test('framework defaults: stage has throttle 100/200 and access logging', async () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'RtDefaults');
		await BlocksBackend.create(stack, 'Backend', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
		});
		const template = Template.fromStack(stack);

		template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
			DefaultRouteSettings: { ThrottlingRateLimit: 100, ThrottlingBurstLimit: 200 },
			AccessLogSettings: { DestinationArn: Match.anyValue(), Format: Match.stringLikeRegexp('connectionId') },
		});
		// The access-log group exists with the framework default retention (30 days).
		template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
	});

	test('stack-level hardening override flows through to the stage', async () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'RtOverride');
		await BlocksBackend.create(stack, 'Backend', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			hardening: { apiThrottle: { rateLimit: 500, burstLimit: 1000 } },
		});
		const template = Template.fromStack(stack);

		template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
			DefaultRouteSettings: { ThrottlingRateLimit: 500, ThrottlingBurstLimit: 1000 },
		});
	});

	test('stack-level hardening can disable access logs', async () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'RtNoLogs');
		await BlocksBackend.create(stack, 'Backend', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			hardening: { apiAccessLogs: false },
		});
		const template = Template.fromStack(stack);

		const stages = template.findResources('AWS::ApiGatewayV2::Stage');
		for (const { Properties } of Object.values(stages)) {
			assert.strictEqual(
				(Properties as { AccessLogSettings?: unknown }).AccessLogSettings,
				undefined,
				'access logs should be off when hardening.apiAccessLogs is false',
			);
		}
	});
});
