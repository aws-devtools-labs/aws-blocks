// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Who owns `BLOCKS_PUBLIC_ORIGIN`: the origin browsers reach the backend's
 * `/aws-blocks/*` at (the OIDC callback lands there; the session cookie's
 * `Secure` follows its scheme).
 *
 * A real `BlocksStack.create({ apiFrontDoor })` + `Hosting`, read after
 * `Template.fromStack` so the managed API front door's aspect has run:
 *
 * - a same-origin door publishes its own URL, and the managed API
 *   distribution (built for native clients when the door doesn't claim the
 *   API front-door role) never overwrites it;
 * - `'none'` (an S3 website, which serves no `/aws-blocks/*`) publishes none:
 *   the managed distribution's URL under `cloudfront`, the request's own host
 *   under `apigateway`; and the browser calls the same API URL `ApiUrl` names;
 * - a door whose URL is plain HTTP never claims the role, even when the URL is
 *   a token (`Fn.join('', ['http://', host])`).
 */
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import { Distribution } from 'aws-cdk-lib/aws-cloudfront';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import { cf, defineFrontDoor } from '@aws-blocks/hosting/constructs';
import type { ScopeParent } from '../common/index.js';
import { buildConfigJson, Hosting, type HostingProps } from '../hosting.js';
import { ComputeBase } from './compute/compute.js';
import type { DefaultComputeFactory } from './compute/default-compute-factory.js';
import { BlocksPresets, BlocksStack } from './index.js';

class StubLambdaCompute extends ComputeBase {
	readonly fn: lambda.NodejsFunction;
	constructor(scope: ScopeParent, id: string) {
		super(id, { parent: scope });
		this.fn = new lambda.NodejsFunction(this, 'Handler', {
			entry: this.backendHandlerPath,
			runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
			handler: 'handler',
			role: this.executionRole,
			bundling: { minify: true, esbuildArgs: { '--conditions': 'aws-runtime' } },
		});
	}
	setEnv(key: string, value: string): void {
		this.fn.addEnvironment(key, value);
	}
	override apiHandler(): IFunction {
		return this.fn;
	}
	protected applyTracing(): void {}
	protected healthWidgets(_region: string): IWidget[][] {
		return [];
	}
	protected metricsWidgets(_region: string): IWidget[][] {
		return [];
	}
	protected loggingWidgets(_region: string): IWidget[][] {
		return [];
	}
	protected tracingWidgets(_region: string): IWidget[][] {
		return [];
	}
}
const stubComputeFactory: DefaultComputeFactory = (root) => new StubLambdaCompute(root as never, 'DefaultCompute');

before(() => {
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
});

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
let root: string;
before(() => {
	root = fs.mkdtempSync(join(os.tmpdir(), 'public-origin-'));
	fs.mkdirSync(join(root, 'dist'));
	fs.writeFileSync(join(root, 'dist', 'index.html'), '<!DOCTYPE html><html></html>');
	fs.writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'spa', dependencies: { react: '^18' } }));
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

type Tier = 'cloudfront' | 'apigateway';

/** Synthesize a stack + Hosting behind `frontDoor`; return what the browser and the runtime get. */
const synth = async (tier: Tier, frontDoor: HostingProps['frontDoor']) => {
	const app = new cdk.App();
	const stack = await BlocksStack.create(app, `Origin${tier}`, {
		backendHandlerPath: join(fixtures, 'handler.js'),
		backendCDKPath: join(fixtures, 'side-effect-backend.js'),
		defaults: BlocksPresets.production,
		defaultComputeFactory: stubComputeFactory,
		apiFrontDoor: tier,
		env: { account: '111111111111', region: 'us-west-2' },
	});
	const hostingProps: HostingProps = { root, buildOutputDir: 'dist', framework: 'spa', api: stack, frontDoor };
	new Hosting(stack, 'Hosting', hostingProps);
	const template = Template.fromStack(stack);
	const entries = (stack as unknown as Record<symbol, { entries: Map<string, unknown> } | undefined>)[
		Symbol.for('BLOCKS_CONFIG_REGISTRY')
	]?.entries;
	const resolve = (v: unknown) => JSON.stringify(stack.resolve(v));
	const apiDistributions = Object.keys(template.findResources('AWS::CloudFront::Distribution')).filter((id) =>
		id.startsWith('ApiFrontDoor'),
	);
	return {
		apiFrontDoorBuilt: apiDistributions.length === 1,
		publicOrigin: entries?.has('BLOCKS_PUBLIC_ORIGIN') ? resolve(entries.get('BLOCKS_PUBLIC_ORIGIN')) : undefined,
		apiUrlOutput: resolve(template.findOutputs('ApiUrl').ApiUrl?.Value),
		browserApiUrl: resolve(buildConfigJson(hostingProps, 'b1').apiUrl),
	};
};

describe('BLOCKS_PUBLIC_ORIGIN belongs to whoever serves /aws-blocks/* to browsers', () => {
	test("ALB without a certificate under 'cloudfront': the ALB stays the public origin (the API distribution doesn't overwrite it)", async () => {
		const r = await synth('cloudfront', { kind: 'alb' });
		assert.ok(r.apiFrontDoorBuilt, 'an http:// door does not claim, so native clients keep an HTTPS ApiUrl');
		assert.match(r.publicOrigin ?? '', /"http:\/\/",\{"Fn::GetAtt":\["HostingAlb[0-9A-F]+","DNSName"\]\}/);
		assert.match(r.apiUrlOutput, /ApiFrontDoor/);
	});

	test("ALB without a certificate under 'apigateway': the ALB is the public origin", async () => {
		const r = await synth('apigateway', { kind: 'alb' });
		assert.ok(!r.apiFrontDoorBuilt);
		assert.match(r.publicOrigin ?? '', /HostingAlb[0-9A-F]+","DNSName"/);
	});

	test("'none' under 'apigateway': no public origin (the bucket serves no /aws-blocks/*; the request's own host is the real one)", async () => {
		const r = await synth('apigateway', 'none');
		assert.strictEqual(r.publicOrigin, undefined);
		assert.doesNotMatch(r.browserApiUrl, /WebsiteURL/);
	});

	test("'none' under 'cloudfront': the API distribution owns the origin, and the browser calls that same API URL", async () => {
		const r = await synth('cloudfront', 'none');
		assert.ok(r.apiFrontDoorBuilt);
		assert.match(r.publicOrigin ?? '', /ApiFrontDoor/);
		assert.match(r.browserApiUrl, /ApiFrontDoor/, 'config.json names the API distribution, not the raw execute-api URL');
		assert.strictEqual(r.browserApiUrl, r.apiUrlOutput, 'the browser and ApiUrl use one API host');
	});

	test("the CloudFront default claims: one distribution, and it is the public origin", async () => {
		const r = await synth('cloudfront', undefined);
		assert.ok(!r.apiFrontDoorBuilt);
		assert.match(r.publicOrigin ?? '', /HostingCdnHostingDistribution/);
	});

	test('a custom door whose URL is a plain-HTTP token never claims the API front-door role', async () => {
		const httpDoor = defineFrontDoor({
			service: 'plain-http',
			build(scope, { origins }) {
				const dist = new Distribution(scope, 'Cdn', { defaultBehavior: { origin: cf.origin(origins.assets) } });
				for (const api of origins.api ? [origins.api] : []) cf.recordWired(api, api.paths);
				return { url: cdk.Fn.join('', ['http://', dist.distributionDomainName]) };
			},
		});
		const r = await synth('cloudfront', { kind: 'custom', door: httpDoor });
		assert.ok(r.apiFrontDoorBuilt, 'not claimed: the API distribution keeps ApiUrl on HTTPS');
		assert.match(r.apiUrlOutput, /ApiFrontDoor/);
		assert.match(r.publicOrigin ?? '', /"http:\/\/"/, 'the door still owns the browser origin');
	});

	// `apiFrontDoor: 'cloudfront'` makes CloudFront the API's public front door.
	// Only a CloudFront-backed Hosting door takes that role over; any other door
	// serves the browser same-origin and leaves the API its own distribution.
	describe("only CloudFront-backed doors take over the API front-door role under 'cloudfront'", () => {
		const domain = { domainName: 'app.example.com', hostedZone: 'example.com', hostedZoneId: 'Z123' };
		for (const [label, frontDoor, claims] of [
			['CloudFront default', undefined, true],
			['stacked edge', { kind: 'stacked', edge: 'cloudfront', router: 'alb' }, true],
			['API Gateway (HTTP)', { kind: 'apiGateway' }, false],
			['API Gateway (REST, domain)', { kind: 'apiGateway', api: 'rest', features: { domain } }, false],
		] as const) {
			test(`${label}: ${claims ? 'claims (one distribution)' : "doesn't claim (the API keeps its distribution)"}`, async () => {
				const r = await synth('cloudfront', frontDoor);
				assert.strictEqual(r.apiFrontDoorBuilt, !claims);
				if (claims) assert.doesNotMatch(r.apiUrlOutput, /ApiFrontDoor/);
				else assert.match(r.apiUrlOutput, /ApiFrontDoor/, 'native clients call the CloudFront distribution');
				assert.doesNotMatch(r.publicOrigin ?? '', /ApiFrontDoor/, 'the browser origin stays the door');
			});
		}
	});
});

