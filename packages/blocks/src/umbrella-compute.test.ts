// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Exercises the real production wiring: `@aws-blocks/blocks`'s `BlocksStack` /
 * `BlocksBackend` wrappers inject `LambdaCompute` as the default-compute factory
 * into core's `create()`. Core's own tests use an inline stub compute and
 * `bb-lambda-compute`'s tests inject a factory by hand, so nothing else covers
 * the umbrella path — a dropped factory argument or a wrong construct id here
 * would otherwise ship uncaught.
 *
 * Must run under `--conditions=cdk` so the BB packages resolve their CDK entries
 * (real infra) rather than the default mock stubs.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { BlocksStack, BlocksBackend, BlocksPresets } from '@aws-blocks/blocks/cdk';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute';

const __dirname = dirname(fileURLToPath(import.meta.url));
let handlerPath: string;
let backendPath: string;
let tmpDir: string;

before(() => {
	// This file is run with `--conditions=cdk` (see package.json test script) so
	// the BB imports above resolve their CDK entries. The handler entry (for the
	// NodejsFunction) and a no-op backend module (imported by create()) go in a
	// temp dir under the package — the handler entry must live under the project
	// root, which CDK's NodejsFunction requires.
	tmpDir = mkdtempSync(join(__dirname, 'tmp-umbrella-'));
	handlerPath = join(tmpDir, 'handler.mjs');
	writeFileSync(handlerPath, "export const handler = async () => ({ statusCode: 200, body: '{}' });\n");
	backendPath = join(tmpDir, 'backend.mjs');
	writeFileSync(backendPath, 'export default () => {};\n');
});

after(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe('umbrella injects the Lambda default compute', () => {
	test('BlocksStack.create() resolves the default to a LambdaCompute fronted by one shared REST API', async () => {
		const app = new cdk.App();
		const stack = await BlocksStack.create(app, 'UmbrellaStack', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
		});

		// The umbrella wrapper injected LambdaCompute (not a stub); the stack's
		// gateway/apiUrl resolve to the stack's single
		// shared REST API. (The `fn` member lives on the CDK-typed LambdaCompute;
		// TS resolves the import to the mock type here, so we assert through the
		// stack's typed getters instead.)
		assert.ok(stack._defaultCompute instanceof LambdaCompute, 'default compute should be a LambdaCompute');
		assert.ok(stack.gateway, 'stack.gateway resolves to the shared REST API');
		assert.ok(stack.apiUrl, 'stack.apiUrl resolves to the shared REST API');

		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
		template.hasResourceProperties('AWS::Lambda::Function', {});
	});

	test('BlocksBackend.create() resolves the default to a LambdaCompute', async () => {
		const app = new cdk.App();
		const parent = new cdk.Stack(app, 'UmbrellaBackendParent');
		const backend = await BlocksBackend.create(parent, 'Blocks', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
		});

		assert.ok(backend._defaultCompute instanceof LambdaCompute, 'default compute should be a LambdaCompute');
		assert.ok(backend.apiUrl, 'backend.apiUrl resolves to the shared REST API');

		const template = Template.fromStack(parent);
		template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
	});
});

describe('apiFrontDoor tier selection', () => {
	test('regional (the default) exposes the shared gateway directly — no CloudFront', async () => {
		const app = new cdk.App();
		const stack = await BlocksStack.create(app, 'RegionalStack', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
			// apiFrontDoor omitted ⇒ resolveApiFrontDoor defaults it to 'regional'.
		});

		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::CloudFront::Distribution', 0);

		// ApiUrl is the raw gateway URL — references execute-api, no CloudFront.
		const apiUrl = Object.values(template.findOutputs('ApiUrl'))[0];
		assert.ok(apiUrl, 'expected an ApiUrl output');
		const value = JSON.stringify(apiUrl.Value);
		assert.ok(value.includes('execute-api'), `regional ApiUrl should be the gateway URL, got ${value}`);
		assert.ok(value.includes('aws-blocks/api'), 'ApiUrl should carry the RPC prefix');
	});

	test('edge provisions one CloudFront distribution whose origin is the shared gateway host', async () => {
		const app = new cdk.App();
		const stack = await BlocksStack.create(app, 'EdgeStack', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
			apiFrontDoor: 'edge',
		});

		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::CloudFront::Distribution', 1);

		const distribution = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0];
		const origins = (
			distribution as { Properties: { DistributionConfig: { Origins: Array<Record<string, unknown>> } } }
		).Properties.DistributionConfig.Origins;
		assert.strictEqual(origins.length, 1, 'edge front door forwards to a single origin');
		const domainName = JSON.stringify(origins[0].DomainName);
		// The origin host is sliced from the gateway URL in-template (Fn::Select over
		// the execute-api domain) — it is the shared gateway, not a baked string.
		assert.ok(domainName.includes('Fn::Select'), `origin host should be derived in-template, got ${domainName}`);
		assert.ok(domainName.includes('execute-api'), `origin host should be the gateway, got ${domainName}`);
		// The REST API stage (part of the gateway URL) is carried as the OriginPath.
		const originPath = JSON.stringify(origins[0].OriginPath);
		assert.ok(originPath.includes('Fn::Select'), `OriginPath should be the gateway stage, got ${originPath}`);
	});

	test('BlocksBackend.create({ apiFrontDoor: "edge" }) provisions one CloudFront distribution in the parent stack', async () => {
		const app = new cdk.App();
		const parent = new cdk.Stack(app, 'BackendEdgeParent');
		await BlocksBackend.create(parent, 'Blocks', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
			apiFrontDoor: 'edge',
		});

		// BlocksBackend is a construct nested in a caller-owned stack, so the managed
		// edge distribution lands in the PARENT stack's template — a different topology
		// from the BlocksStack path above (where the stack IS the owner).
		const template = Template.fromStack(parent);
		template.resourceCountIs('AWS::CloudFront::Distribution', 1);
	});

	test('edge: the ApiUrl output resolves to the CloudFront front-door URL, not the raw gateway', async () => {
		const app = new cdk.App();
		const stack = await BlocksStack.create(app, 'EdgeApiUrlStack', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
			apiFrontDoor: 'edge',
		});

		const template = Template.fromStack(stack);
		const distId = Object.keys(template.findResources('AWS::CloudFront::Distribution'))[0];
		assert.ok(distId, 'expected a CloudFront distribution');

		const apiUrl = Object.values(template.findOutputs('ApiUrl'))[0];
		const value = JSON.stringify(apiUrl.Value);
		assert.ok(value.includes(distId), `ApiUrl should reference the CloudFront distribution, got ${value}`);
		assert.ok(value.includes('DomainName'), 'ApiUrl should resolve the distribution domain');
		assert.ok(value.includes('/aws-blocks/api'), 'ApiUrl should carry the RPC prefix');
		assert.ok(!value.includes('execute-api'), 'edge ApiUrl should be the CloudFront URL, not the raw gateway');
	});
});

// The shared gateway replaced a gateway each LambdaCompute owned. It is built in
// the default compute's scope with the same construct ids, so CloudFormation sees
// the same logical IDs and an upgrade keeps the deployed REST API, its stage, and
// its execute-api URL (and, in production, the RETAINed access-log group's audit
// trail). These are the IDs `main` synthesized before the move — a change here
// replaces the REST API for every deployed app, so it must be deliberate.
describe('shared gateway keeps the pre-move logical IDs', () => {
	const defaults = { ...BlocksPresets.production, accessLogging: true };
	const gatewayIds = (stack: cdk.Stack) => {
		const resources = Template.fromStack(stack).toJSON().Resources as Record<string, { Type: string }>;
		const ids = (type: string, filter: (id: string) => boolean = () => true) =>
			Object.keys(resources)
				.filter((id) => resources[id].Type === type && filter(id))
				.sort();
		return {
			restApi: ids('AWS::ApiGateway::RestApi'),
			stage: ids('AWS::ApiGateway::Stage'),
			accessLogs: ids('AWS::Logs::LogGroup', (id) => id.includes('ApiAccessLogs')),
		};
	};

	test('BlocksStack', async () => {
		const app = new cdk.App();
		const stack = await BlocksStack.create(app, 'PinStack', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults,
		});
		assert.deepStrictEqual(gatewayIds(stack), {
			restApi: ['DefaultComputeAPI5E5CE44A'],
			stage: ['DefaultComputeAPIDeploymentStageprodBEAFD421'],
			accessLogs: ['DefaultComputeApiAccessLogs6AADB91E'],
		});
	});

	test('BlocksBackend', async () => {
		const app = new cdk.App();
		const parent = new cdk.Stack(app, 'PinParent');
		await BlocksBackend.create(parent, 'Blocks', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults,
		});
		assert.deepStrictEqual(gatewayIds(parent), {
			restApi: ['BlocksDefaultComputeAPI11DA76BF'],
			stage: ['BlocksDefaultComputeAPIDeploymentStageprod70A875D5'],
			accessLogs: ['BlocksDefaultComputeApiAccessLogsBEFB0011'],
		});
	});
});
