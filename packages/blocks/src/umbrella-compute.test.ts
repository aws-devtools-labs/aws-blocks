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
import { ApiNamespace, Compute, CronJob, Scope } from '@aws-blocks/blocks';
import { BlocksBackend, BlocksPresets, BlocksStack } from '@aws-blocks/blocks/cdk';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

const __dirname = dirname(fileURLToPath(import.meta.url));
let handlerPath: string;
let backendPath: string;
let earlyReadBackendPath: string;
let throwingBackendPath: string;
let computeBackendPath: string;
let scopeComputeBackendPath: string;
let containerScopeApiBackendPath: string;
let containerScopeCronBackendPath: string;
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
	// Scope-level compute: everything under `reports` runs on `scoped`, except
	// what sets its own compute, and the blocks that always run on the default.
	const schema = "{ '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) } }";
	scopeComputeBackendPath = join(tmpDir, 'backend-scope-compute.mjs');
	writeFileSync(
		scopeComputeBackendPath,
		"import { ApiNamespace, AsyncJob, Compute, CronJob, RawRoute, Realtime, Scope } from '@aws-blocks/blocks';\n" +
			"const scope = new Scope('app');\n" +
			"const scoped = new Compute(scope, 'scoped', { type: 'serverless', memory: 640 });\n" +
			"const own = new Compute(scope, 'own', { type: 'serverless', memory: 768 });\n" +
			"const cronOnly = new Compute(scope, 'cron-only', { type: 'serverless', memory: 896 });\n" +
			"const reports = new Scope('reports', { parent: scope, compute: scoped });\n" +
			"const nested = new Scope('nested', { parent: reports });\n" +
			"export const pingApi = new ApiNamespace(scope, 'ping', () => ({ async ping() { return 'pong'; } }));\n" +
			"export const reportsApi = new ApiNamespace(reports, 'reports', () => ({ async build() { return 'ok'; } }));\n" +
			"export const nestedApi = new ApiNamespace(nested, 'nested', () => ({ async go() { return 'ok'; } }));\n" +
			"export const ownApi = new ApiNamespace(reports, 'own', () => ({ async go() { return 'ok'; } }), { compute: own });\n" +
			"export const reportsJob = new AsyncJob(reports, 'reports-job', { handler: async () => {} });\n" +
			"new CronJob(reports, 'nightly', { schedule: 'rate(1 hour)', handler: async () => {} });\n" +
			"new CronJob(scope, 'hourly', { schedule: 'rate(1 hour)', compute: cronOnly, handler: async () => {} });\n" +
			`new Realtime(reports, 'rt', { namespaces: { chat: Realtime.namespace(${schema}) } });\n` +
			"new RawRoute(reports, 'hook', { method: 'GET', path: '/hooks/scoped', handler: async () => {} });\n",
	);
	// A container compute set on a scope: blocks that can't run on it yet fail synth.
	containerScopeApiBackendPath = join(tmpDir, 'backend-container-scope-api.mjs');
	writeFileSync(
		containerScopeApiBackendPath,
		"import { ApiNamespace, Compute, Scope } from '@aws-blocks/blocks';\n" +
			"const scope = new Scope('app');\n" +
			"const worker = new Compute(scope, 'worker', { type: 'container' });\n" +
			"const jobs = new Scope('jobs', { parent: scope, compute: worker });\n" +
			"export const jobsApi = new ApiNamespace(jobs, 'jobs', () => ({ async go() { return 'ok'; } }));\n",
	);
	containerScopeCronBackendPath = join(tmpDir, 'backend-container-scope-cron.mjs');
	writeFileSync(
		containerScopeCronBackendPath,
		"import { Compute, CronJob, Scope } from '@aws-blocks/blocks';\n" +
			"const scope = new Scope('app');\n" +
			"const worker = new Compute(scope, 'worker', { type: 'container' });\n" +
			"const jobs = new Scope('jobs', { parent: scope, compute: worker });\n" +
			"new CronJob(jobs, 'nightly', { schedule: 'rate(1 hour)', handler: async () => {} });\n",
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

describe('Scope-level compute', () => {
	type Resources = Record<string, { Type: string; Properties: Record<string, unknown>; DependsOn?: unknown }>;

	/** The function a `Compute` block backs, found by its construct path. */
	const functionOf = (resources: Resources, computeId: string) => {
		const pattern = new RegExp(`app${computeId.replace('-', '')}backing`, 'i');
		const ids = Object.keys(resources).filter((id) => resources[id].Type === 'AWS::Lambda::Function' && pattern.test(id));
		assert.strictEqual(ids.length, 1, `one ${computeId} function, got ${ids.join(', ')}`);
		return ids[0];
	};
	const defaultFunctionOf = (resources: Resources) => {
		const ids = Object.keys(resources).filter(
			(id) => resources[id].Type === 'AWS::Lambda::Function' && /^DefaultComputeHandler/.test(id),
		);
		assert.strictEqual(ids.length, 1, `one default function, got ${ids.join(', ')}`);
		return ids[0];
	};
	/** The function each literal `/aws-blocks/api/{name}` resource integrates. */
	const routedFunction = (resources: Resources, pathPart: string) => {
		const resource = Object.entries(resources).find(
			([, r]) => r.Type === 'AWS::ApiGateway::Resource' && r.Properties.PathPart === pathPart,
		);
		if (!resource) return undefined;
		const method = Object.values(resources).find(
			(r) => r.Type === 'AWS::ApiGateway::Method' && (r.Properties.ResourceId as { Ref?: string }).Ref === resource[0],
		);
		return JSON.stringify(method?.Properties.Integration);
	};

	let resources: Resources;
	before(async () => {
		const stack = await BlocksStack.create(new cdk.App(), 'ScopeComputeStack', {
			backendHandlerPath: handlerPath,
			backendCDKPath: scopeComputeBackendPath,
			defaults: BlocksPresets.production,
		});
		resources = Template.fromStack(stack).toJSON().Resources as Resources;
	});

	test("API namespaces in the scope, and in its child scopes, run on the scope's compute", () => {
		const scopedFn = functionOf(resources, 'scoped');
		assert.ok(routedFunction(resources, 'reportsApi')?.includes(scopedFn), 'reportsApi → the scoped compute');
		assert.ok(routedFunction(resources, 'nestedApi')?.includes(scopedFn), 'nestedApi inherits through its parent');
		assert.strictEqual(resources[scopedFn].Properties.MemorySize, 640);
	});

	test("a block's own compute wins over its scope's", () => {
		assert.ok(routedFunction(resources, 'ownApi')?.includes(functionOf(resources, 'own')));
	});

	test('a namespace outside the scope stays on the default compute', () => {
		assert.strictEqual(routedFunction(resources, 'pingApi'), undefined, 'no literal resource: the catch-all carries it');
	});

	test("an AsyncJob in the scope is delivered to the scope's compute", () => {
		const scopedFn = functionOf(resources, 'scoped');
		const mappings = Object.values(resources).filter((r) => r.Type === 'AWS::Lambda::EventSourceMapping');
		assert.ok(mappings.some((m) => JSON.stringify(m.Properties.FunctionName).includes(scopedFn)));
	});

	test("CronJobs target their compute, and the scheduler role may invoke each one's function", () => {
		const schedules = Object.values(resources).filter((r) => r.Type === 'AWS::Scheduler::Schedule');
		const targetOf = (name: string) =>
			JSON.stringify(schedules.find((r) => String(r.Properties.Name).includes(name))?.Properties.Target);
		const scopedFn = functionOf(resources, 'scoped');
		const cronFn = functionOf(resources, 'cron-only');
		assert.ok(targetOf('nightly').includes(scopedFn), "the scope's CronJob targets the scoped compute");
		assert.ok(targetOf('hourly').includes(cronFn), "the CronJob's own compute");

		const policies = Object.values(resources).filter(
			(r) => r.Type === 'AWS::IAM::Policy' && JSON.stringify(r.Properties.Roles).includes('BlocksSchedulerRole'),
		);
		const invokable = JSON.stringify(policies.map((p) => p.Properties.PolicyDocument));
		assert.ok(invokable.includes(scopedFn) && invokable.includes(cronFn), 'the role may invoke both functions');
	});

	test('Realtime stays on the default compute inside the scope', () => {
		const defaultFn = defaultFunctionOf(resources);
		const integrations = Object.values(resources).filter((r) => r.Type === 'AWS::ApiGatewayV2::Integration');
		assert.ok(integrations.length > 0, 'the WebSocket API has integrations');
		assert.ok(
			integrations.every((r) => JSON.stringify(r.Properties).includes(defaultFn)),
			'every WebSocket route integrates the default function',
		);
	});

	test("a container scope fails synth for an ApiNamespace, naming the compute and the fix", async () => {
		await assert.rejects(
			BlocksStack.create(new cdk.App(), 'ContainerScopeApiStack', {
				backendHandlerPath: handlerPath,
				backendCDKPath: containerScopeApiBackendPath,
				defaults: BlocksPresets.production,
			}),
			/Compute 'ContainerScopeApiStack\/app\/worker\/backing' hosts API namespaces \(jobsApi\) but accepts no API traffic\. API namespaces run only on a serverless compute today/,
		);
	});

	test('a container scope fails synth for a CronJob, naming the compute', async () => {
		await assert.rejects(
			BlocksStack.create(new cdk.App(), 'ContainerScopeCronStack', {
				backendHandlerPath: handlerPath,
				backendCDKPath: containerScopeCronBackendPath,
				defaults: BlocksPresets.production,
			}),
			/CronJob "ContainerScopeCronStack-app-jobs-nightly" runs only on a serverless compute, but resolves to container compute 'ContainerScopeCronStack\/app\/worker\/backing'/,
		);
	});
});

// Compile-time only (never called): a scope takes either kind of compute; a
// CronJob's own `compute` takes only a serverless one.
function _scopeAndCronComputeTypeChecks(scope: InstanceType<typeof Scope>) {
	const serverless = new Compute(scope, 'serverless', { type: 'serverless' });
	const container = new Compute(scope, 'container', { type: 'container' });
	new Scope('a', { parent: scope, compute: serverless });
	new Scope('b', { parent: scope, compute: container });
	new CronJob(scope, 'ok', { schedule: 'rate(1 hour)', compute: serverless, handler: async () => {} });
	// @ts-expect-error — only a serverless compute can run a CronJob
	new CronJob(scope, 'notYet', { schedule: 'rate(1 hour)', compute: container, handler: async () => {} });
}
void _scopeAndCronComputeTypeChecks;

// Compile-time only (never called): `ApiNamespaceOptions.compute` takes a
// serverless `Compute` and rejects other compute types.
function _apiNamespaceComputeTypeChecks(scope: InstanceType<typeof Scope>) {
	const serverless = new Compute(scope, 'serverless', { type: 'serverless' });
	new ApiNamespace(scope, 'ok', () => ({}), { compute: serverless });

	const container = new Compute(scope, 'container', { type: 'container' });
	// @ts-expect-error — only a serverless compute can serve an API namespace
	new ApiNamespace(scope, 'notYet', () => ({}), { compute: container });
}
void _apiNamespaceComputeTypeChecks;
