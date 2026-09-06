// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for LambdaCompute.
 *
 * LambdaCompute is not yet instantiated by the default app and is not reachable
 * by customers. These tests exercise it directly to pin its shape: function +
 * gateway, shared role, distinct construct paths, and owner-derived identity.
 */

import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type BlocksDefaults, BlocksPresets, Scope } from '@aws-blocks/core/cdk';
import { Compute } from '@aws-blocks/core/cdk/internal';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Architecture } from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';
import { LambdaCompute } from './index.cdk.js';

// A trivial handler entry for the NodejsFunction to bundle. Written to a temp
// dir under the package (rather than a checked-in fixture) so the package
// carries no test scaffolding on disk. It must live under the project root —
// CDK's NodejsFunction rejects an entry outside it.
const __dirname = dirname(fileURLToPath(import.meta.url));
let handlerPath: string;
let tmpDir: string;

before(() => {
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
	tmpDir = mkdtempSync(join(__dirname, 'tmp-handler-'));
	handlerPath = join(tmpDir, 'handler.mjs');
	writeFileSync(handlerPath, "export const handler = async () => ({ statusCode: 200, body: '{}' });\n");
});

after(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// Minimal BlocksStack-shaped owner. LambdaCompute (via Compute → Scope) reads
// `backendHandlerPath`, `executionRole`, and the owner's `id` (for
// BLOCKS_STACK_NAME) from the nearest BlocksStack/BlocksBackend — or, absent
// one in the tree, from the ambient `globalThis.CURRENT_BLOCKS_STACK`. We
// reproduce that surface here so the compute synthesizes into a real stack
// without spinning up a full BlocksBackend.
class StubBlocksStack extends cdk.Stack {
	public readonly id: string;
	public readonly executionRole: cdk.aws_iam.IRole;
	public readonly backendHandlerPath: string;
	public readonly defaults: BlocksDefaults;
	constructor(scope: Construct, id: string, defaults: BlocksDefaults = BlocksPresets.production) {
		super(scope, id);
		this.id = id;
		this.backendHandlerPath = handlerPath;
		this.defaults = defaults;
		(globalThis as any).CURRENT_BLOCKS_STACK = this;
		this.executionRole = new cdk.aws_iam.Role(this, 'BlocksRole', {
			assumedBy: new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com'),
		});
	}
}

function setup(stackId: string, defaults?: BlocksDefaults): { stack: StubBlocksStack; parent: Scope } {
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, stackId, defaults);
	const parent = new Scope('app');
	return { stack, parent };
}

describe('LambdaCompute', () => {
	test('provisions a Lambda function and its own API Gateway', () => {
		const { stack, parent } = setup('LambdaComputeShape');

		const compute = new LambdaCompute(parent, 'extra');

		assert.ok(compute.fn, 'LambdaCompute should expose .fn');
		assert.ok(compute.apiGateway, 'LambdaCompute should expose .apiGateway');
		assert.ok(compute instanceof Compute, 'LambdaCompute should be a Compute');

		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::ApiGateway::RestApi', 1);

		const roles = template.findResources('AWS::IAM::Role');
		const blocksRoleId = Object.keys(roles).find((k) => k.includes('BlocksRole'));
		const fns = template.findResources('AWS::Lambda::Function');
		const blocksFns = Object.values(fns).filter(
			(fn: any) => fn.Properties?.Role?.['Fn::GetAtt']?.[0] === blocksRoleId,
		);
		assert.strictEqual(blocksFns.length, 1, 'the compute function runs on the shared role');
	});

	test('the function assumes the shared execution role', () => {
		const { stack, parent } = setup('LambdaComputeRole');

		const compute = new LambdaCompute(parent, 'extra');

		// The compute resolves the same shared role the owner exposes.
		assert.strictEqual(compute.executionRole, stack.executionRole);

		const template = Template.fromStack(stack);
		const roles = template.findResources('AWS::IAM::Role');
		const blocksRoleId = Object.keys(roles).find((k) => k.includes('BlocksRole'));
		assert.ok(blocksRoleId, 'expected the shared BlocksRole');
		const fns = template.findResources('AWS::Lambda::Function');
		const onSharedRole = Object.values(fns).filter(
			(fn: any) => fn.Properties?.Role?.['Fn::GetAtt']?.[0] === blocksRoleId,
		);
		assert.strictEqual(onSharedRole.length, 1, 'the compute function should assume the shared BlocksRole');
	});

	test('multiple computes under one owner get distinct construct paths', () => {
		const { stack, parent } = setup('LambdaComputeMultiple');

		const a = new LambdaCompute(parent, 'a');
		const b = new LambdaCompute(parent, 'b');

		assert.notStrictEqual(a.node.path, b.node.path, 'distinct ids → distinct construct paths');
		// Both synthesize without a logical-id collision.
		assert.doesNotThrow(() => Template.fromStack(stack));
	});

	test('isLambdaCompute recognizes a LambdaCompute and rejects everything else', () => {
		const { parent } = setup('LambdaComputeBrand');
		const compute = new LambdaCompute(parent, 'branded');

		// A real instance is recognized...
		assert.ok(LambdaCompute.isLambdaCompute(compute));
		// ...and it's a brand check, not an `instanceof` — so a plausible duck
		// (a Compute-shaped object without the Symbol.for brand) is rejected,
		// which is exactly how it survives a duplicate bb-lambda-compute copy.
		assert.ok(!LambdaCompute.isLambdaCompute({ fn: {}, apiGateway: {} }));
		assert.ok(!LambdaCompute.isLambdaCompute({}));
		assert.ok(!LambdaCompute.isLambdaCompute(null));
		assert.ok(!LambdaCompute.isLambdaCompute(undefined));
	});

	test('setEnv adds an environment variable to the function', () => {
		const { stack, parent } = setup('LambdaComputeSetEnv');

		const compute = new LambdaCompute(parent, 'extra');
		compute.setEnv('BLOCKS_THING', 'value-123');

		const template = Template.fromStack(stack);
		template.hasResourceProperties('AWS::Lambda::Function', {
			Environment: { Variables: { BLOCKS_THING: 'value-123' } },
		});
	});

	test('derives BLOCKS_STACK_NAME from the owner', () => {
		const { stack, parent } = setup('LambdaComputeStackName');

		new LambdaCompute(parent, 'extra');

		// The compute's function must agree with the owner's token-free identity
		// — otherwise the runtime derives physical resource names that were never
		// created.
		const template = Template.fromStack(stack);
		const fns = template.findResources('AWS::Lambda::Function');
		const computeFnId = Object.keys(fns).find((k) => k.includes('extra'));
		assert.ok(computeFnId, 'expected the compute function in the template');
		assert.strictEqual(fns[computeFnId].Properties.Environment.Variables.BLOCKS_STACK_NAME, stack.id);
	});

	test('throws when created outside a BlocksStack/BlocksBackend', () => {
		// With no real BlocksStack/BlocksBackend in the tree or as the ambient
		// owner (a plain cdk.Stack exposes none of backendHandlerPath / a Blocks
		// identity), the compute cannot derive its entry or BLOCKS_STACK_NAME and
		// fails at construction.
		const app = new cdk.App();
		const bareStack = new cdk.Stack(app, 'BareStack');
		(globalThis as any).CURRENT_BLOCKS_STACK = bareStack;

		assert.throws(() => new LambdaCompute(new Scope('app'), 'orphan'));
	});
});

// The compute reads its allowed CORS origins from the stack's `defaults`
// (item 3), replacing the old `sandboxMode` context read.
describe('LambdaCompute CORS origins from defaults', () => {
	test('sandbox posture sets CORS_ALLOWED_ORIGINS to the allowed origins (comma-joined)', () => {
		const { stack, parent } = setup('LambdaComputeCorsSandbox', BlocksPresets.sandbox);

		new LambdaCompute(parent, 'extra');

		Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
			Environment: {
				Variables: Match.objectLike({
					CORS_ALLOWED_ORIGINS: '^https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?$',
				}),
			},
		});
	});

	test('production posture sets no CORS_ALLOWED_ORIGINS (no allowed origins)', () => {
		const { stack, parent } = setup('LambdaComputeCorsProd', BlocksPresets.production);

		new LambdaCompute(parent, 'extra');

		const fns = Template.fromStack(stack).findResources('AWS::Lambda::Function');
		assert.ok(
			!JSON.stringify(fns).includes('CORS_ALLOWED_ORIGINS'),
			'no function should carry CORS_ALLOWED_ORIGINS under the production posture',
		);
	});
});

// arm64 (Graviton) is ~20% cheaper and the backend is a pure-JS bundle, so the
// compute defaults to it; `architecture` overrides for x86-only native addons.
describe('LambdaCompute architecture (Graviton default)', () => {
	test('defaults the function to arm64', () => {
		const { stack, parent } = setup('LambdaComputeArch');

		new LambdaCompute(parent, 'extra');

		Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
			Architectures: ['arm64'],
		});
	});

	test('respects an architecture override (x86_64)', () => {
		const { stack, parent } = setup('LambdaComputeArchOverride');

		new LambdaCompute(parent, 'extra', { architecture: Architecture.X86_64 });

		Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
			Architectures: ['x86_64'],
		});
	});
});

// The compute owns the handler log group + the API Gateway stage, so the
// stack-wide logRetention / throttling / accessLogging defaults are adopted here.
describe('LambdaCompute handler log-group retention (defaults.logRetention)', () => {
	test('production keeps handler logs for a year (365 days)', () => {
		const { stack, parent } = setup('LambdaComputeLogProd', BlocksPresets.production);
		const compute = new LambdaCompute(parent, 'extra');
		assert.ok(compute.logGroup, 'LambdaCompute should expose .logGroup');
		// The function points at the framework-owned group (not Lambda's
		// infinite-retention auto group).
		Template.fromStack(stack).hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 365 });
	});

	test('sandbox keeps handler logs for a week (7 days)', () => {
		const { stack, parent } = setup('LambdaComputeLogSandbox', BlocksPresets.sandbox);
		new LambdaCompute(parent, 'extra');
		Template.fromStack(stack).hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
	});
});

describe('LambdaCompute stage throttling (defaults.throttling)', () => {
	test('production carries the 1000/2000 rate + burst default', () => {
		const { stack, parent } = setup('LambdaComputeThrottleProd', BlocksPresets.production);
		new LambdaCompute(parent, 'extra');
		Template.fromStack(stack).hasResourceProperties('AWS::ApiGateway::Stage', {
			MethodSettings: Match.arrayWith([
				Match.objectLike({ HttpMethod: '*', ResourcePath: '/*', ThrottlingRateLimit: 1000, ThrottlingBurstLimit: 2000 }),
			]),
		});
	});

	test('sandbox caps the stage tighter (200/400)', () => {
		const { stack, parent } = setup('LambdaComputeThrottleSandbox', BlocksPresets.sandbox);
		new LambdaCompute(parent, 'extra');
		Template.fromStack(stack).hasResourceProperties('AWS::ApiGateway::Stage', {
			MethodSettings: Match.arrayWith([
				Match.objectLike({ ThrottlingRateLimit: 200, ThrottlingBurstLimit: 400 }),
			]),
		});
	});

	test('a per-stack throttling override wins over the preset', () => {
		const { stack, parent } = setup('LambdaComputeThrottleOverride', {
			...BlocksPresets.production,
			throttling: { rateLimit: 50, burstLimit: 75 },
		});
		new LambdaCompute(parent, 'extra');
		Template.fromStack(stack).hasResourceProperties('AWS::ApiGateway::Stage', {
			MethodSettings: Match.arrayWith([
				Match.objectLike({ ThrottlingRateLimit: 50, ThrottlingBurstLimit: 75 }),
			]),
		});
	});
});

describe('LambdaCompute stage access logging (defaults.accessLogging)', () => {
	// Access logging is opt-in (off in both presets), so enable it explicitly.
	const withAccessLogging = { ...BlocksPresets.production, accessLogging: true };

	test('opt-in enables JSON access logging + the account CloudWatch role', () => {
		const { stack, parent } = setup('LambdaComputeAccessLogProd', withAccessLogging);
		new LambdaCompute(parent, 'extra');
		const template = Template.fromStack(stack);
		// The account-level CloudWatch role is provisioned exactly once.
		template.resourceCountIs('AWS::ApiGateway::Account', 1);
		template.hasResourceProperties('AWS::ApiGateway::Stage', {
			AccessLogSetting: Match.objectLike({ DestinationArn: Match.anyValue(), Format: Match.anyValue() }),
		});
	});

	test('the production access-log group is RETAINed (audit trail survives teardown)', () => {
		const { stack, parent } = setup('LambdaComputeAccessLogRetain', withAccessLogging);
		new LambdaCompute(parent, 'extra');
		// The access-log group follows defaults.removalPolicy (RETAIN in prod).
		Template.fromStack(stack).hasResource('AWS::Logs::LogGroup', {
			DeletionPolicy: 'Retain',
		});
	});

	test('off by default (production preset) — no stage AccessLogSetting, no account role', () => {
		const { stack, parent } = setup('LambdaComputeAccessLogDefaultOff', BlocksPresets.production);
		new LambdaCompute(parent, 'extra');
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::ApiGateway::Account', 0);
		template.hasResourceProperties('AWS::ApiGateway::Stage', {
			AccessLogSetting: Match.absent(),
		});
	});

	test('sandbox disables access logging (no stage AccessLogSetting, no account role)', () => {
		const { stack, parent } = setup('LambdaComputeAccessLogSandbox', BlocksPresets.sandbox);
		new LambdaCompute(parent, 'extra');
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::ApiGateway::Account', 0);
		template.hasResourceProperties('AWS::ApiGateway::Stage', {
			AccessLogSetting: Match.absent(),
		});
	});

	test('two access-logging stages in one stack share a single ApiGateway::Account', () => {
		// The `ensureApiGatewayAccount` Symbol.for sharing exists so multiple
		// access-logging stages in one stack (e.g. the default compute + a
		// bb-realtime WebSocket stage, both calling the same helper) emit exactly
		// one account-level role rather than colliding. Two computes exercise the
		// identical shared-account path.
		const { stack, parent } = setup('LambdaComputeSharedAccount', withAccessLogging);
		new LambdaCompute(parent, 'a');
		new LambdaCompute(parent, 'b');
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::ApiGateway::Account', 1);
		// Both stages still get access logging.
		template.resourceCountIs('AWS::ApiGateway::Stage', 2);
	});
});
