// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-synth tests for the managed CloudFront API front door (Track D, D2 + D3).
 *
 * The front door is scheduled by core's `scheduleFrontDoor` and resolved at
 * synth by a one-shot aspect (`FrontDoorAspect`). Because the aspect runs at
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
 */
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { BlocksDefaults } from '@aws-blocks/core/cdk';
import { BlocksBackend, BlocksPresets, BlocksStack } from '@aws-blocks/core/cdk';
import {
	type DefaultComputeFactory,
	httpOriginFromApiUrl,
	registerHostingDistribution,
} from '@aws-blocks/core/cdk/internal';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type { Distribution } from 'aws-cdk-lib/aws-cloudfront';
import { LambdaCompute } from './index.cdk.js';

const lambdaFactory: DefaultComputeFactory = (root) => new LambdaCompute(root as never, 'DefaultCompute');

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

async function makeStack(id: string, defaults: BlocksDefaults): Promise<BlocksStack> {
	const app = new cdk.App();
	return BlocksStack.create(app, id, {
		backendHandlerPath: handlerPath,
		backendCDKPath: backendPath,
		defaults,
		defaultComputeFactory: lambdaFactory,
	});
}

/** The `ApiUrl` output value as a searchable string (references are tokens). */
function apiUrlOutput(template: Template): string {
	return JSON.stringify(template.findOutputs('ApiUrl'));
}

describe('API front door (scheduled aspect, gated on defaults.provisionApiFrontDoor)', () => {
	test('production, no Hosting: one distribution + ApiUrl points at the front door', async () => {
		const stack = await makeStack('FrontDoorProd', BlocksPresets.production);
		const template = Template.fromStack(stack);

		template.resourceCountIs('AWS::CloudFront::Distribution', 1);
		template.hasOutput('FrontDoorUrl', {});
		// The client-facing ApiUrl output now resolves to the front-door origin —
		// its value references the front-door distribution, not the raw gateway.
		assert.ok(
			apiUrlOutput(template).includes('BlocksApiFrontDoor'),
			'ApiUrl output should reference the CloudFront front door',
		);
	});

	test('sandbox, no Hosting: no front door; ApiUrl stays the API Gateway', async () => {
		const stack = await makeStack('FrontDoorSandbox', BlocksPresets.sandbox);
		const template = Template.fromStack(stack);

		template.resourceCountIs('AWS::CloudFront::Distribution', 0);
		assert.ok(
			!apiUrlOutput(template).includes('BlocksApiFrontDoor'),
			'ApiUrl output should not reference a front door in sandbox',
		);
	});

	test('explicit provisionApiFrontDoor:false opts a prod app out', async () => {
		const stack = await makeStack('FrontDoorProdOptOut', {
			...BlocksPresets.production,
			provisionApiFrontDoor: false,
		});
		Template.fromStack(stack).resourceCountIs('AWS::CloudFront::Distribution', 0);
	});

	test('Hosting present: reuse it — no Blocks-owned distribution is created', async () => {
		const stack = await makeStack('FrontDoorWithHosting', BlocksPresets.production);
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
			defaultComputeFactory: lambdaFactory,
		});
		await BlocksBackend.create(stack, 'BackendB', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
			defaultComputeFactory: lambdaFactory,
		});

		const template = Template.fromStack(stack);
		// One distribution per backend — the aspect scopes each under its owning
		// backend, so the shared `BlocksApiFrontDoor` construct id does not collide
		// at the stack level.
		template.resourceCountIs('AWS::CloudFront::Distribution', 2);
		const frontDoorOutputs = Object.values(template.findOutputs('*')).filter(
			(o) => o.Description === 'Blocks API CloudFront front door URL',
		);
		assert.strictEqual(frontDoorOutputs.length, 2, 'one FrontDoorUrl output per backend');
	});
});

describe('httpOriginFromApiUrl', () => {
	test('builds an HTTP origin from a Blocks API URL', () => {
		const origin = httpOriginFromApiUrl('https://abc123.execute-api.us-east-1.amazonaws.com/prod/aws-blocks/api');
		assert.ok(origin, 'returns an origin');
		assert.strictEqual(typeof origin.bind, 'function', 'is a CloudFront IOrigin');
	});
});
