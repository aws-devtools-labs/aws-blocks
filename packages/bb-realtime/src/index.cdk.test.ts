// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side tests for Realtime synth guards.
 *
 * Validates that calling runtime data methods (publish/subscribe/getChannel)
 * on the CDK construct throws an actionable error instead of a cryptic
 * `X is not a function` TypeError.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { BlocksStack, BlocksPresets, type BlocksDefaults } from '@aws-blocks/core/cdk';
import type { DefaultComputeFactory } from '@aws-blocks/core/cdk/internal';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute/cdk';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { Realtime } from './index.cdk.js';

test('CDK: calling a runtime method throws an actionable error (not a cryptic TypeError)', () => {
	// Unlike KVStore/DistributedTable tests which instantiate the construct directly,
	// Realtime's constructor requires complex shared infrastructure (WebSocket API,
	// DynamoDB connections table, AppSetting) that is impractical to stand up in a
	// unit test. We access the prototype directly instead — the synth-guard stubs
	// are plain methods and don't depend on instance state.
	for (const method of ['publish', 'subscribe', 'getChannel']) {
		assert.throws(
			() => (Realtime.prototype as any)[method]('arg'),
			/cannot be called during CDK synth/,
			`${method}() should throw the actionable synth-time error`,
		);
	}
});

// ── WebSocket stage throttling (defaults.throttling) ────────────────────────

const passthroughSchema: StandardSchemaV1<any> = {
	'~standard': {
		version: 1,
		vendor: 'blocks-test',
		validate: (value: unknown) => ({ value }),
	},
};

const lambdaFactory: DefaultComputeFactory = (root) => new LambdaCompute(root as never, 'DefaultCompute');

const __dirname = dirname(fileURLToPath(import.meta.url));
let handlerPath: string;
let backendPath: string;
let tmpDir: string;

before(() => {
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
	tmpDir = mkdtempSync(join(__dirname, 'tmp-rt-cdk-'));
	handlerPath = join(tmpDir, 'handler.mjs');
	writeFileSync(handlerPath, "export const handler = async () => ({ statusCode: 200, body: '{}' });\n");
	backendPath = join(tmpDir, 'backend.mjs');
	writeFileSync(backendPath, 'export default () => {};\n');
});

after(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// Realtime resolves `this.compute` in its constructor, so it must be built on a
// real BlocksStack.create harness (which initializes the default compute) rather
// than a handler-only stub. The per-test `defaults` drive the WebSocket stage's
// throttle/access-logging config.
async function setup(
	defaults: BlocksDefaults = BlocksPresets.production,
	stackId = 'RtThrottleStack',
): Promise<BlocksStack> {
	const app = new cdk.App();
	const stack = await BlocksStack.create(app, stackId, {
		backendHandlerPath: handlerPath,
		backendCDKPath: backendPath,
		defaults,
		defaultComputeFactory: lambdaFactory,
	});
	new Realtime(stack, 'rt', { namespaces: { chat: Realtime.namespace(passthroughSchema) } });
	return stack;
}

test('CDK: the WebSocket stage carries the production message throttle (1000/2000)', async () => {
	const stack = await setup();
	const template = Template.fromStack(stack);
	// On a WebSocket stage the throttle unit is messages/sec across the connection.
	template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
		DefaultRouteSettings: Match.objectLike({
			ThrottlingRateLimit: 1000,
			ThrottlingBurstLimit: 2000,
		}),
	});
});

test('CDK: sandbox caps the WebSocket stage tighter (200/400)', async () => {
	const stack = await setup(BlocksPresets.sandbox, 'RtThrottleSandboxStack');
	const template = Template.fromStack(stack);
	template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
		DefaultRouteSettings: Match.objectLike({
			ThrottlingRateLimit: 200,
			ThrottlingBurstLimit: 400,
		}),
	});
});

test('CDK: a per-stack throttling override wins on the WebSocket stage', async () => {
	const stack = await setup({ ...BlocksPresets.production, throttling: { rateLimit: 25, burstLimit: 60 } });
	const template = Template.fromStack(stack);
	template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
		DefaultRouteSettings: Match.objectLike({
			ThrottlingRateLimit: 25,
			ThrottlingBurstLimit: 60,
		}),
	});
});

test('CDK: opt-in enables WebSocket access logging + the account CloudWatch role', async () => {
	// Access logging is opt-in (off in both presets), so enable it explicitly.
	const stack = await setup({ ...BlocksPresets.production, accessLogging: true }, 'RtAccessLogProdStack');
	const template = Template.fromStack(stack);
	template.resourceCountIs('AWS::ApiGateway::Account', 1);
	template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
		AccessLogSettings: Match.objectLike({ DestinationArn: Match.anyValue(), Format: Match.anyValue() }),
	});
});

test('CDK: access logging is off by default (production preset) — no account role', async () => {
	const stack = await setup(BlocksPresets.production, 'RtAccessLogDefaultOffStack');
	const template = Template.fromStack(stack);
	template.resourceCountIs('AWS::ApiGateway::Account', 0);
	template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
		AccessLogSettings: Match.absent(),
	});
});

test('CDK: sandbox leaves the WebSocket stage without access logging', async () => {
	const stack = await setup(BlocksPresets.sandbox, 'RtAccessLogSandboxStack');
	const template = Template.fromStack(stack);
	template.resourceCountIs('AWS::ApiGateway::Account', 0);
	template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
		AccessLogSettings: Match.absent(),
	});
});
