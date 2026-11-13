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
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { BlocksStack, BlocksPresets, Scope, type BlocksDefaults } from '@aws-blocks/core/cdk';
import type { DefaultComputeFactory } from '@aws-blocks/core/cdk/internal';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute/cdk';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { Realtime } from './index.cdk.js';

test('CDK: calling a runtime method throws an actionable error (not a cryptic TypeError)', () => {
	// Unlike the KVStore tests which instantiate the construct directly,
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

// Note: Realtime's "requires a Lambda compute" guard reads the stack DEFAULT
// compute, and BlocksStack.create requires that default to be Lambda-shaped
// (it wires the ApiUrl output from it), so a non-Lambda default can't be stood
// up to trip the guard here. The guard's discriminator — LambdaCompute's brand
// check — is unit-tested directly in bb-lambda-compute (isLambdaCompute).

// ── One handler per event key, at synth ─────────────────────────────────────
// The Lambda runtime registers each Realtime's WebSocket handler under
// `blocks.websocket:<fullId>`. `fullId` joins ids with '-', so `a-b`/`c` and
// `a`/`b-c` share one; CDK accepts both construct paths, and the second runtime
// registration would throw on every cold start. Synth must refuse it.

test('CDK: two Realtime blocks that share a fullId fail synth, naming the key and both blocks', async () => {
	const stack = await setup(BlocksPresets.production, 'RtCollide');
	const namespaces = { chat: Realtime.namespace(passthroughSchema) };
	new Realtime(new Scope('a-b', { parent: stack }), 'c', { namespaces });
	const other = new Scope('a', { parent: stack });
	assert.throws(
		() => new Realtime(other, 'b-c', { namespaces }),
		(e: unknown) => {
			assert.ok(e instanceof Error);
			assert.match(e.message, /"blocks\.websocket:RtCollide-a-b-c"/);
			assert.match(e.message, /Scope 'RtCollide-a-b-c'/);
			assert.match(e.message, /already registered by Building Block 'RtCollide-a-b-c'/);
			return true;
		},
	);
});

test('CDK: distinct Realtime blocks in one stack synthesize (setup already adds `rt`)', async () => {
	const stack = await setup(BlocksPresets.production, 'RtDistinct');
	new Realtime(stack, 'rt2', { namespaces: { chat: Realtime.namespace(passthroughSchema) } });
	// Shared per-stack infra: still one WebSocket API.
	Template.fromStack(stack).resourceCountIs('AWS::ApiGatewayV2::Api', 1);
});

// ── Connections table key schema ────────────────────────────────────────────
// The key attribute types are probed from the connections schema. Pin them, so a
// change to the probe or to the schema cannot change the provisioned table.

/**
 * Synth a Realtime stack in a child process started with `--conditions=cdk` and return
 * its DynamoDB tables and custom resources.
 *
 * Needed because this file imports `./index.cdk.js` directly, which leaves the
 * nested `KVStore` resolving to its mock entry: that emits no CloudFormation.
 * Only the condition-based resolution shows the table that a customer deploys.
 */
function synthUnderCdkConditions(): { type: string; properties: any }[] {
	const probe = join(tmpDir, 'key-schema-probe.mjs');
	writeFileSync(
		probe,
		`
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { BlocksStack, BlocksPresets } from '@aws-blocks/core/cdk';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute/cdk';
import { Realtime } from '@aws-blocks/bb-realtime';

const stack = await BlocksStack.create(new cdk.App(), 'KeySchemaProbeStack', {
	backendHandlerPath: ${JSON.stringify(handlerPath)},
	backendCDKPath: ${JSON.stringify(backendPath)},
	defaults: BlocksPresets.production,
	defaultComputeFactory: (root) => new LambdaCompute(root, 'DefaultCompute'),
});
new Realtime(stack, 'rt', {
	namespaces: { chat: Realtime.namespace({ '~standard': { version: 1, vendor: 'blocks-test', validate: (value) => ({ value }) } }) },
});
const resources = Object.values(Template.fromStack(stack).toJSON().Resources)
	.filter((r) => r.Type === 'AWS::DynamoDB::Table' || r.Type === 'AWS::CloudFormation::CustomResource')
	.map((r) => ({ type: r.Type, properties: r.Properties }));
console.log('__RESOURCES__' + JSON.stringify(resources));
`,
	);
	const result = spawnSync(process.execPath, ['--conditions=cdk', probe], { encoding: 'utf8' });
	assert.strictEqual(result.status, 0, result.stderr);
	const line = result.stdout.split('\n').find((l) => l.startsWith('__RESOURCES__'));
	assert.ok(line, `the probe printed no resources: ${result.stdout}`);
	return JSON.parse(line.slice('__RESOURCES__'.length));
}

test('CDK: the connections table is keyed by connectionId (S) + channel (S), with channel-index and TTL on expiresAt', () => {
	const resources = synthUnderCdkConditions();
	const tables = resources.filter((r) => r.type === 'AWS::DynamoDB::Table');
	assert.strictEqual(tables.length, 1, 'Realtime provisions one table');
	assert.deepStrictEqual(tables[0].properties.KeySchema, [
		{ AttributeName: 'connectionId', KeyType: 'HASH' },
		{ AttributeName: 'channel', KeyType: 'RANGE' },
	]);
	assert.deepStrictEqual(tables[0].properties.AttributeDefinitions, [
		{ AttributeName: 'connectionId', AttributeType: 'S' },
		{ AttributeName: 'channel', AttributeType: 'S' },
	]);
	assert.deepStrictEqual(tables[0].properties.TimeToLiveSpecification, { AttributeName: 'expiresAt', Enabled: true });
	const indexResources = resources.filter((r) => r.type === 'AWS::CloudFormation::CustomResource');
	assert.strictEqual(indexResources.length, 1);
	assert.deepStrictEqual(indexResources[0].properties.Indexes, {
		'channel-index': { partitionKey: 'channel', sortKey: 'connectionId', partitionKeyType: 'S', sortKeyType: 'S' },
	});
});
