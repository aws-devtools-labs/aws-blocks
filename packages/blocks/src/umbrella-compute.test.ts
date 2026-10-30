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

import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute';
import { ApiNamespace, Compute, type Scope } from '@aws-blocks/blocks';
import { BlocksBackend, BlocksPresets, BlocksStack } from '@aws-blocks/blocks/cdk';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

const __dirname = dirname(fileURLToPath(import.meta.url));
let handlerPath: string;
let backendPath: string;
let earlyReadBackendPath: string;
let throwingBackendPath: string;
let computeBackendPath: string;
let containerBackendPath: string;
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
	// Reads `publicApiUrl` from inside the backend module — before create() has
	// built the gateway — and emits it as an `Early` output.
	earlyReadBackendPath = join(tmpDir, 'backend-early-read.mjs');
	writeFileSync(
		earlyReadBackendPath,
		"import { CfnOutput, Stack } from 'aws-cdk-lib';\n" +
			"export default (root) => { new CfnOutput(Stack.of(root), 'Early', { value: root.publicApiUrl }); };\n",
	);
	throwingBackendPath = join(tmpDir, 'backend-throwing.mjs');
	writeFileSync(throwingBackendPath, "throw new Error('backend module was imported');\n");
	// A customer-shaped backend: `api` on the default compute, and a `reports`
	// namespace (constructed as 'reportsApi') plus an AsyncJob on one `Compute`.
	computeBackendPath = join(tmpDir, 'backend-compute.mjs');
	writeFileSync(
		computeBackendPath,
		"import { ApiNamespace, AsyncJob, Compute, Scope } from '@aws-blocks/blocks';\n" +
			"const scope = new Scope('app');\n" +
			"const reportsCompute = new Compute(scope, 'reports', { type: 'serverless', memory: 512 });\n" +
			"export const api = new ApiNamespace(scope, 'api', () => ({ async ping() { return 'pong'; } }));\n" +
			"export const reports = new ApiNamespace(scope, 'reportsApi', () => ({ async build() { return 'ok'; } }), { compute: reportsCompute });\n" +
			"export const reportsJob = new AsyncJob(scope, 'reports-job', { compute: reportsCompute, handler: async () => {} });\n",
	);
	// A `render` namespace (constructed as 'renderApi') and an AsyncJob on one
	// container `Compute`, a `preview` namespace on a second, and a container that
	// only runs a job.
	containerBackendPath = join(tmpDir, 'backend-container.mjs');
	writeFileSync(
		containerBackendPath,
		"import { ApiNamespace, AsyncJob, Compute, Scope } from '@aws-blocks/blocks';\n" +
			"const scope = new Scope('app');\n" +
			"const renderCompute = new Compute(scope, 'render', { type: 'container', size: { vcpu: 1, memory: 2048 } });\n" +
			"const batchCompute = new Compute(scope, 'batch', { type: 'container' });\n" +
			"const previewCompute = new Compute(scope, 'preview', { type: 'container' });\n" +
			"export const api = new ApiNamespace(scope, 'api', () => ({ async ping() { return 'pong'; } }));\n" +
			"export const render = new ApiNamespace(scope, 'renderApi', () => ({ async build() { return 'ok'; } }), { compute: renderCompute });\n" +
			"export const preview = new ApiNamespace(scope, 'preview', () => ({ async show() { return 'ok'; } }), { compute: previewCompute });\n" +
			"export const renderJob = new AsyncJob(scope, 'render-job', { compute: renderCompute, handler: async () => {} });\n" +
			"export const batchJob = new AsyncJob(scope, 'batch-job', { compute: batchCompute, handler: async () => {} });\n",
	);
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
	test('apigateway (the default) exposes the shared gateway directly — no CloudFront', async () => {
		const app = new cdk.App();
		const stack = await BlocksStack.create(app, 'ApiGatewayStack', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
			// apiFrontDoor omitted ⇒ resolveApiFrontDoor defaults it to 'apigateway'.
		});

		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::CloudFront::Distribution', 0);

		// ApiUrl is the raw gateway URL — references execute-api, no CloudFront.
		const apiUrl = Object.values(template.findOutputs('ApiUrl'))[0];
		assert.ok(apiUrl, 'expected an ApiUrl output');
		const value = JSON.stringify(apiUrl.Value);
		assert.ok(value.includes('execute-api'), `apigateway ApiUrl should be the gateway URL, got ${value}`);
		assert.ok(value.includes('aws-blocks/api'), 'ApiUrl should carry the RPC prefix');
	});

	test('cloudfront provisions one CloudFront distribution whose origin is the shared gateway host', async () => {
		const app = new cdk.App();
		const stack = await BlocksStack.create(app, 'CloudFrontStack', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
			apiFrontDoor: 'cloudfront',
		});

		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::CloudFront::Distribution', 1);

		const distribution = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0];
		const origins = (
			distribution as { Properties: { DistributionConfig: { Origins: Array<Record<string, unknown>> } } }
		).Properties.DistributionConfig.Origins;
		assert.strictEqual(origins.length, 1, 'cloudfront front door forwards to a single origin');
		const domainName = JSON.stringify(origins[0].DomainName);
		// The origin host is sliced from the gateway URL in-template (Fn::Select over
		// the execute-api domain) — it is the shared gateway, not a baked string.
		assert.ok(domainName.includes('Fn::Select'), `origin host should be derived in-template, got ${domainName}`);
		assert.ok(domainName.includes('execute-api'), `origin host should be the gateway, got ${domainName}`);
		// The REST API stage (part of the gateway URL) is carried as the OriginPath.
		const originPath = JSON.stringify(origins[0].OriginPath);
		assert.ok(originPath.includes('Fn::Select'), `OriginPath should be the gateway stage, got ${originPath}`);
	});

	test('BlocksBackend.create({ apiFrontDoor: "cloudfront" }) provisions one CloudFront distribution in the parent stack', async () => {
		const app = new cdk.App();
		const parent = new cdk.Stack(app, 'BackendCloudFrontParent');
		await BlocksBackend.create(parent, 'Blocks', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
			apiFrontDoor: 'cloudfront',
		});

		// BlocksBackend is a construct nested in a caller-owned stack, so the managed
		// cloudfront distribution lands in the PARENT stack's template — a different topology
		// from the BlocksStack path above (where the stack IS the owner).
		const template = Template.fromStack(parent);
		template.resourceCountIs('AWS::CloudFront::Distribution', 1);
	});

	test('cloudfront: the ApiUrl output resolves to the CloudFront front-door URL, not the raw gateway', async () => {
		const app = new cdk.App();
		const stack = await BlocksStack.create(app, 'CloudFrontApiUrlStack', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
			apiFrontDoor: 'cloudfront',
		});

		const template = Template.fromStack(stack);
		const distId = Object.keys(template.findResources('AWS::CloudFront::Distribution'))[0];
		assert.ok(distId, 'expected a CloudFront distribution');

		const apiUrl = Object.values(template.findOutputs('ApiUrl'))[0];
		const value = JSON.stringify(apiUrl.Value);
		assert.ok(value.includes(distId), `ApiUrl should reference the CloudFront distribution, got ${value}`);
		assert.ok(value.includes('DomainName'), 'ApiUrl should resolve the distribution domain');
		assert.ok(value.includes('/aws-blocks/api'), 'ApiUrl should carry the RPC prefix');
		assert.ok(
			!value.includes('execute-api'),
			'cloudfront ApiUrl should be the CloudFront URL, not the raw gateway',
		);
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

// The `cloudfront` tier, end to end through the real LambdaCompute.
describe('apiFrontDoor: cloudfront', () => {
	const create = async (tier: 'apigateway' | 'cloudfront') => {
		const stackApp = new cdk.App();
		const stack = await BlocksStack.create(stackApp, 'TierStack', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
			apiFrontDoor: tier,
		});
		const backendApp = new cdk.App();
		const parent = new cdk.Stack(backendApp, 'TierParent');
		const backend = await BlocksBackend.create(parent, 'Blocks', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
			apiFrontDoor: tier,
		});
		new cdk.CfnOutput(parent, 'PublicApiUrl', { value: backend.publicApiUrl });
		return { stack: Template.fromStack(stack), parent: Template.fromStack(parent) };
	};
	const distributionIds = (template: Template) =>
		Object.keys(template.findResources('AWS::CloudFront::Distribution'));
	const restApi = (template: Template) =>
		Object.values(template.findResources('AWS::ApiGateway::RestApi'))[0] as { Properties: Record<string, unknown> };
	const configBlob = (template: Template) => JSON.stringify(template.findResources('Custom::CDKBucketDeployment'));
	// The config JSON is one Lazy, so it lands as a single `Fn::Join` in the config
	// deployment's `SourceMarkers`. Returns the join part right after `"KEY":"https://`
	// — for a token value, the token itself.
	const configValueAfterHttps = (template: Template, key: string): unknown => {
		const [deployment] = Object.values(template.findResources('Custom::CDKBucketDeployment'));
		const markers: Record<string, { 'Fn::Join': [string, unknown[]] }> = deployment.Properties.SourceMarkers[0];
		const [, parts] = Object.values(markers)[0]['Fn::Join'];
		const i = parts.findIndex((part) => typeof part === 'string' && part.endsWith(`"${key}":"https://`));
		return i === -1 ? undefined : parts[i + 1];
	};
	const domainOf = (distributionId: string) => ({ 'Fn::GetAtt': [distributionId, 'DomainName'] });

	// Renaming the distribution's construct id or moving its scope replaces it: a new
	// *.cloudfront.net domain, so the public URL moves and users are signed out.
	test('keeps the distribution logical IDs for BlocksStack and BlocksBackend', async () => {
		const { stack, parent } = await create('cloudfront');
		assert.deepStrictEqual(distributionIds(stack), ['ApiFrontDoorA48CED56']);
		assert.deepStrictEqual(distributionIds(parent), ['BlocksApiFrontDoor9F3D9B2C']);
	});

	test('BlocksBackend.publicApiUrl resolves to the distribution', async () => {
		const { parent } = await create('cloudfront');
		const value = JSON.stringify(Object.values(parent.findOutputs('PublicApiUrl'))[0].Value);
		assert.ok(value.includes('BlocksApiFrontDoor9F3D9B2C') && value.includes('DomainName'), value);
		assert.ok(value.includes('/aws-blocks/api'), value);
		assert.ok(!value.includes('execute-api'), `publicApiUrl should not be the gateway URL, got ${value}`);
	});

	test('apigateway: BlocksBackend.publicApiUrl is the gateway URL', async () => {
		const { parent } = await create('apigateway');
		const value = JSON.stringify(Object.values(parent.findOutputs('PublicApiUrl'))[0].Value);
		assert.ok(value.includes('execute-api'), value);
	});

	// A Blocks distribution in front of an edge-optimized endpoint would be two
	// CloudFront layers; the gateway becomes REGIONAL only under `cloudfront`, so
	// existing `apigateway` apps synthesize exactly as before.
	test('the gateway is a REGIONAL endpoint under cloudfront and unchanged under apigateway', async () => {
		const cloudfront = await create('cloudfront');
		assert.deepStrictEqual(restApi(cloudfront.stack).Properties.EndpointConfiguration, { Types: ['REGIONAL'] });
		const apigateway = await create('apigateway');
		assert.strictEqual(restApi(apigateway.stack).Properties.EndpointConfiguration, undefined);
	});

	// CloudFront forwards with ALL_VIEWER_EXCEPT_HOST_HEADER, so the runtime only
	// learns the public origin (e.g. for AuthOIDC's callback URL) from config.
	test('publishes BLOCKS_PUBLIC_ORIGIN as the distribution URL, under cloudfront only', async () => {
		const cloudfront = await create('cloudfront');
		assert.deepStrictEqual(
			configValueAfterHttps(cloudfront.stack, 'BLOCKS_PUBLIC_ORIGIN'),
			domainOf('ApiFrontDoorA48CED56'),
			'stack',
		);
		assert.deepStrictEqual(
			configValueAfterHttps(cloudfront.parent, 'BLOCKS_PUBLIC_ORIGIN'),
			domainOf('BlocksApiFrontDoor9F3D9B2C'),
			'backend',
		);
		const apigateway = await create('apigateway');
		assert.ok(!configBlob(apigateway.stack).includes('BLOCKS_PUBLIC_ORIGIN'));
	});

	// The backend module runs before create() builds the gateway, so a read there
	// must still resolve to the front door, not to the execute-api URL.
	test('publicApiUrl read inside the backend module resolves to the distribution', async () => {
		const stack = await BlocksStack.create(new cdk.App(), 'EarlyReadStack', {
			backendHandlerPath: handlerPath,
			backendCDKPath: earlyReadBackendPath,
			defaults: BlocksPresets.production,
			apiFrontDoor: 'cloudfront',
		});
		const stackOutputs = Template.fromStack(stack).findOutputs('*');
		assert.deepStrictEqual(stackOutputs.Early.Value, stackOutputs.ApiUrl.Value, 'matches the ApiUrl output');
		assert.ok(JSON.stringify(stackOutputs.Early.Value).includes('ApiFrontDoorA48CED56'), 'stack');

		const parent = new cdk.Stack(new cdk.App(), 'EarlyReadParent');
		await BlocksBackend.create(parent, 'Blocks', {
			backendHandlerPath: handlerPath,
			backendCDKPath: earlyReadBackendPath,
			defaults: BlocksPresets.production,
			apiFrontDoor: 'cloudfront',
		});
		const early = JSON.stringify(Template.fromStack(parent).findOutputs('Early').Early.Value);
		assert.ok(early.includes('BlocksApiFrontDoor9F3D9B2C') && !early.includes('execute-api'), early);
	});

	// TypeScript rejects other values, but plain-JS apps and `any`-typed callers
	// (the Amplify template's `backend`) don't; they must fail, not lose the tier.
	test('rejects an unknown tier before the backend module is imported', async () => {
		const invalid = /apiFrontDoor must be 'apigateway' or 'cloudfront' \(got "edge"\)/;
		await assert.rejects(
			BlocksStack.create(new cdk.App(), 'BadTierStack', {
				backendHandlerPath: handlerPath,
				backendCDKPath: throwingBackendPath,
				defaults: BlocksPresets.production,
				apiFrontDoor: 'edge' as never,
			}),
			invalid,
		);
		await assert.rejects(
			BlocksBackend.create(new cdk.Stack(new cdk.App(), 'BadTierParent'), 'Blocks', {
				backendHandlerPath: handlerPath,
				backendCDKPath: throwingBackendPath,
				defaults: BlocksPresets.production,
				apiFrontDoor: 'edge' as never,
			}),
			invalid,
		);
	});
});

// A namespace given its own `Compute` through the public `compute` option, end
// to end through the real Compute block and LambdaCompute.
describe('ApiNamespace compute option', () => {
	type Resources = Record<string, { Type: string; Properties: Record<string, unknown> }>;

	// The Compute block's backing function, found by its construct path.
	const reportsFunctionId = (resources: Resources) => {
		const ids = Object.keys(resources).filter(
			(id) => resources[id].Type === 'AWS::Lambda::Function' && /reportsbacking/i.test(id),
		);
		assert.strictEqual(ids.length, 1, `one reports-compute function, got ${ids.join(', ')}`);
		return ids[0];
	};

	const assertRoutedToReportsCompute = (template: Template) => {
		const resources = template.toJSON().Resources as Resources;
		const fnId = reportsFunctionId(resources);

		// Routed by the export name, to the reports compute's function only.
		const parts = Object.entries(resources).filter(([, r]) => r.Type === 'AWS::ApiGateway::Resource');
		const reportsResource = parts.find(([, r]) => r.Properties.PathPart === 'reports');
		assert.ok(reportsResource, 'a /aws-blocks/api/reports resource');
		assert.ok(!parts.some(([, r]) => r.Properties.PathPart === 'reportsApi'), 'not the constructor name');
		const method = Object.values(resources).find(
			(r) =>
				r.Type === 'AWS::ApiGateway::Method' &&
				(r.Properties.ResourceId as { Ref?: string }).Ref === reportsResource[0],
		);
		assert.ok(JSON.stringify(method?.Properties.Integration).includes(fnId), 'integrates the reports function');

		// Nothing else reaches the reports function: every other method (the default
		// namespace's catch-alls included) integrates a different function.
		const otherMethods = Object.values(resources).filter(
			(r) =>
				r.Type === 'AWS::ApiGateway::Method' &&
				(r.Properties.ResourceId as { Ref?: string }).Ref !== reportsResource[0] &&
				r.Properties.Integration !== undefined,
		);
		assert.ok(otherMethods.length > 0, 'the catch-all methods exist');
		assert.ok(
			otherMethods.every((m) => !JSON.stringify(m.Properties.Integration).includes(fnId)),
			'only /aws-blocks/api/reports integrates the reports function',
		);

		// The compute's options apply, and the same function also runs the AsyncJob.
		assert.strictEqual(resources[fnId].Properties.MemorySize, 512);
		const mappings = Object.values(resources).filter((r) => r.Type === 'AWS::Lambda::EventSourceMapping');
		assert.ok(
			mappings.some((m) => JSON.stringify(m.Properties.FunctionName).includes(fnId)),
			'the AsyncJob on the same compute is delivered to the same function',
		);

		// One API-scoped invoke permission, not one per method.
		const permissions = Object.values(resources).filter(
			(r) =>
				r.Type === 'AWS::Lambda::Permission' &&
				r.Properties.Principal === 'apigateway.amazonaws.com' &&
				JSON.stringify(r.Properties.FunctionName).includes(fnId),
		);
		assert.strictEqual(permissions.length, 1);
	};

	test('BlocksStack', async () => {
		const stack = await BlocksStack.create(new cdk.App(), 'ComputeOptionStack', {
			backendHandlerPath: handlerPath,
			backendCDKPath: computeBackendPath,
			defaults: BlocksPresets.production,
		});
		assertRoutedToReportsCompute(Template.fromStack(stack));
	});

	test('BlocksBackend', async () => {
		const parent = new cdk.Stack(new cdk.App(), 'ComputeOptionParent');
		await BlocksBackend.create(parent, 'Blocks', {
			backendHandlerPath: handlerPath,
			backendCDKPath: computeBackendPath,
			defaults: BlocksPresets.production,
		});
		assertRoutedToReportsCompute(Template.fromStack(parent));
	});

	// The front door has a single origin (the gateway) under `cloudfront`, so
	// fan-out stays inside the gateway: still exactly one distribution.
	test('cloudfront tier: same routing, one distribution', async () => {
		const stack = await BlocksStack.create(new cdk.App(), 'ComputeOptionCloudFront', {
			backendHandlerPath: handlerPath,
			backendCDKPath: computeBackendPath,
			defaults: BlocksPresets.production,
			apiFrontDoor: 'cloudfront',
		});
		const template = Template.fromStack(stack);
		assertRoutedToReportsCompute(template);
		template.resourceCountIs('AWS::CloudFront::Distribution', 1);
	});
});

// A namespace on a container `Compute`: the gateway reaches the container's tasks
// through a VPC link to an internal load balancer the compute provisions.
describe('ApiNamespace on a container compute', () => {
	type Resource = { Type: string; Properties: Record<string, any>; DependsOn?: string[] };
	type Resources = Record<string, Resource>;
	const ofType = (resources: Resources, type: string) =>
		Object.entries(resources).filter(([, r]) => r.Type === type);
	const one = (resources: Resources, type: string) => {
		const found = ofType(resources, type);
		assert.strictEqual(found.length, 1, `one ${type}, got ${found.length}`);
		return found[0];
	};

	let resources: Resources;
	before(async () => {
		const stack = await BlocksStack.create(new cdk.App(), 'ContainerApiStack', {
			backendHandlerPath: handlerPath,
			backendCDKPath: containerBackendPath,
			defaults: BlocksPresets.production,
		});
		resources = Template.fromStack(stack).toJSON().Resources as Resources;
	});

	/** The target group (logical id) of the container compute whose construct path contains `compute`. */
	const targetGroupOf = (compute: string) => {
		const [id] = ofType(resources, 'AWS::ElasticLoadBalancingV2::TargetGroup').find(([tgId]) =>
			tgId.toLowerCase().includes(`${compute}backing`),
		) ?? [];
		assert.ok(id, `a target group for ${compute}`);
		return id;
	};

	test('one internal load balancer and one listener; 404 for paths no container serves', () => {
		const [lbId, lb] = one(resources, 'AWS::ElasticLoadBalancingV2::LoadBalancer');
		assert.strictEqual(lb.Properties.Scheme, 'internal');
		assert.strictEqual(lb.Properties.Type, 'application');
		const [, listener] = one(resources, 'AWS::ElasticLoadBalancingV2::Listener');
		assert.deepStrictEqual(listener.Properties.LoadBalancerArn, { Ref: lbId });
		assert.strictEqual(listener.Properties.Protocol, 'HTTP');
		assert.strictEqual(listener.Properties.Port, 10_000);
		assert.strictEqual(listener.Properties.DefaultActions[0].Type, 'fixed-response');
		assert.strictEqual(listener.Properties.DefaultActions[0].FixedResponseConfig.StatusCode, '404');
		// The two API containers get a target group each; the job-only one none.
		assert.strictEqual(ofType(resources, 'AWS::ElasticLoadBalancingV2::TargetGroup').length, 2);
	});

	test('each namespace path forwards to its own compute', () => {
		const [listenerId] = one(resources, 'AWS::ElasticLoadBalancingV2::Listener');
		const rules = ofType(resources, 'AWS::ElasticLoadBalancingV2::ListenerRule').map(([, r]) => r.Properties);
		const forwards = Object.fromEntries(
			rules.map((r) => {
				assert.deepStrictEqual(r.ListenerArn, { Ref: listenerId });
				return [r.Conditions[0].PathPatternConfig.Values.join(','), r.Actions[0].TargetGroupArn.Ref];
			}),
		);
		assert.deepStrictEqual(forwards, {
			'/aws-blocks/api/render': targetGroupOf('render'),
			'/aws-blocks/api/preview': targetGroupOf('preview'),
		});
		assert.strictEqual(new Set(rules.map((r) => r.Priority)).size, 2, 'distinct priorities');
	});

	test('target groups: API port 8080, health-checked on readiness port 8081', () => {
		for (const compute of ['render', 'preview']) {
			const tg = resources[targetGroupOf(compute)].Properties;
			assert.strictEqual(tg.Port, 8080);
			assert.strictEqual(tg.TargetType, 'ip');
			assert.strictEqual(tg.HealthCheckPort, '8081');
			assert.strictEqual(tg.HealthCheckPath, '/');
			// Past the longest call a front door allows (60 s), so a deploy or scale-in never cuts one short.
			const attributes = Object.fromEntries(tg.TargetGroupAttributes.map((a: { Key: string; Value: string }) => [a.Key, a.Value]));
			assert.strictEqual(attributes['deregistration_delay.timeout_seconds'], '65');
		}
		const services = ofType(resources, 'AWS::ECS::Service');
		const withLb = services.filter(([, s]) => s.Properties.LoadBalancers.length > 0);
		assert.strictEqual(withLb.length, 2, 'the two API services are load balanced');
		// The job-only one says so explicitly, so a compute that stops serving API traffic detaches its target group.
		const jobOnly = services.find(([id]) => id.toLowerCase().includes('batchbacking'));
		assert.ok(jobOnly);
		assert.deepStrictEqual(jobOnly[1].Properties.LoadBalancers, []);
		const render = withLb.find(([id]) => id.toLowerCase().includes('renderbacking'));
		assert.ok(render);
		assert.deepStrictEqual(render[1].Properties.LoadBalancers, [
			{ ContainerName: 'Backend', ContainerPort: 8080, TargetGroupArn: { Ref: targetGroupOf('render') } },
		]);
		assert.strictEqual(render[1].Properties.HealthCheckGracePeriodSeconds, 60);
	});

	test('/aws-blocks/api/render proxies to the load balancer through a VPC link', () => {
		const [lbId] = one(resources, 'AWS::ElasticLoadBalancingV2::LoadBalancer');
		const [linkId] = one(resources, 'AWS::ApiGatewayV2::VpcLink');
		const parts = ofType(resources, 'AWS::ApiGateway::Resource');
		const renderPart = parts.find(([, r]) => r.Properties.PathPart === 'render');
		assert.ok(renderPart, 'routed by the export name');
		assert.ok(!parts.some(([, r]) => r.Properties.PathPart === 'renderApi'), 'not the constructor name');
		const methods = ofType(resources, 'AWS::ApiGateway::Method').filter(
			([, m]) => m.Properties.ResourceId?.Ref === renderPart[0],
		);
		assert.strictEqual(methods.length, 1);
		const integration = methods[0][1].Properties.Integration;
		assert.strictEqual(methods[0][1].Properties.HttpMethod, 'ANY');
		assert.strictEqual(integration.Type, 'HTTP_PROXY');
		assert.strictEqual(integration.ConnectionType, 'VPC_LINK');
		assert.deepStrictEqual(integration.ConnectionId, { Ref: linkId });
		assert.deepStrictEqual(integration.IntegrationTarget, { Ref: lbId }, 'the load balancer ARN, not a listener ARN');
		assert.deepStrictEqual(integration.Uri, {
			'Fn::Join': ['', ['http://', { 'Fn::GetAtt': [lbId, 'DNSName'] }, ':10000/aws-blocks/api/render']],
		});
		assert.deepStrictEqual(integration.RequestParameters, {
			'integration.request.header.x-blocks-forwarded-host': 'context.domainName',
			'integration.request.header.x-blocks-forwarded-stage': 'context.stage',
		});
	});

	test('the API port is open to the load balancer only, on a security group of its own', () => {
		const [lbId, lb] = one(resources, 'AWS::ElasticLoadBalancingV2::LoadBalancer');
		const lbSg = lb.Properties.SecurityGroups[0]['Fn::GetAtt'][0];
		const ingress = ofType(resources, 'AWS::EC2::SecurityGroupIngress').map(([, r]) => r.Properties);
		const into = (sg: string) => ingress.filter((r) => r.GroupId?.['Fn::GetAtt']?.[0] === sg);
		const fromSg = (r: Record<string, any>) => r.SourceSecurityGroupId?.['Fn::GetAtt']?.[0];

		// Tasks: 8080 + 8081 from the load balancer, on the API group only.
		const [, service] = ofType(resources, 'AWS::ECS::Service').find(([id]) => id.toLowerCase().includes('renderbacking')) ?? [];
		const serviceSgs: string[] = service?.Properties.NetworkConfiguration.AwsvpcConfiguration.SecurityGroups.map(
			(g: Record<string, string[]>) => g['Fn::GetAtt'][0],
		);
		assert.strictEqual(serviceSgs.length, 2, 'shared compute group + the API group');
		const apiSg = serviceSgs.find((g) => /renderbackingApiSg/.test(g));
		const sharedSg = serviceSgs.find((g) => /BlocksLambdaSg/.test(g));
		assert.ok(apiSg && sharedSg, `API + shared compute groups, got ${serviceSgs.join(', ')}`);
		assert.deepStrictEqual(
			into(apiSg).map((r) => [r.FromPort, r.ToPort, fromSg(r)]),
			[[8080, 8081, lbSg]],
		);
		assert.deepStrictEqual(into(sharedSg), [], 'the shared compute group admits nothing');
		// Nor inline: CDK writes a CIDR peer's rule into the group itself, not as a standalone resource.
		for (const sg of [apiSg, sharedSg, lbSg]) {
			assert.deepStrictEqual(resources[sg].Properties.SecurityGroupIngress ?? [], [], `${sg} has no inline ingress`);
		}

		// Load balancer: the listener port range from the VPC link only, in one rule.
		const [linkSgId] = ofType(resources, 'AWS::EC2::SecurityGroup').find(([id]) => /ApiVpcLinkSg/.test(id)) ?? [];
		assert.ok(linkSgId, 'the VPC link has its own security group');
		assert.deepStrictEqual(
			into(lbSg).map((r) => [r.FromPort, r.ToPort, fromSg(r)]),
			[[10_000, 10_999, linkSgId]],
		);
		void lbId;
	});

	test('a Lambda-only app gets no VPC link or load balancer', async () => {
		const stack = await BlocksStack.create(new cdk.App(), 'LambdaOnlyStack', {
			backendHandlerPath: handlerPath,
			backendCDKPath: computeBackendPath,
			defaults: BlocksPresets.production,
		});
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::ApiGatewayV2::VpcLink', 0);
		template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
	});
});

// Compile-time only (never called): `ApiNamespaceOptions.compute` takes a
// serverless or a container `Compute`.
function _apiNamespaceComputeTypeChecks(scope: InstanceType<typeof Scope>) {
	const serverless = new Compute(scope, 'serverless', { type: 'serverless' });
	new ApiNamespace(scope, 'ok', () => ({}), { compute: serverless });

	const container = new Compute(scope, 'container', { type: 'container' });
	new ApiNamespace(scope, 'onContainer', () => ({}), { compute: container });
}
void _apiNamespaceComputeTypeChecks;
