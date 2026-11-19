// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Who owns `BLOCKS_PUBLIC_ORIGIN`: the origin browsers reach the backend's
 * `/cdk-blocks/*` at (the OIDC callback lands there; the session cookie's
 * `Secure` follows its scheme).
 *
 * A real `BlocksStack.create({ apiFrontDoor })` + `Hosting`, read after
 * `Template.fromStack` so the managed API front door's aspect has run:
 *
 * - a same-origin door publishes its own URL, and the managed API
 *   distribution (built for native clients when the door doesn't claim the
 *   API front-door role) never overwrites it;
 * - `'none'` (an S3 website, which serves no `/cdk-blocks/*`) publishes none:
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
import { cf, defineFrontDoor } from '@aws-cdk-blocks/hosting/constructs';
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

/**
 * Synthesize a stack + Hosting behind `frontDoor`; return what the browser and the runtime get.
 * `sandbox` synthesizes a sandbox deploy (`sandboxMode` context): a plain-HTTP ALB door with an API
 * fails synth in production (`PlainHttpFrontDoorError`).
 */
const synth = async (
	tier: Tier,
	frontDoor: HostingProps['frontDoor'] | ((stack: cdk.Stack) => HostingProps['frontDoor']),
	sandbox = false,
) => {
	const app = new cdk.App(sandbox ? { context: { sandboxMode: 'true' } } : undefined);
	const stack = await BlocksStack.create(app, `Origin${tier}`, {
		backendHandlerPath: join(fixtures, 'handler.js'),
		backendCDKPath: join(fixtures, 'side-effect-backend.js'),
		defaults: BlocksPresets.production,
		defaultComputeFactory: stubComputeFactory,
		apiFrontDoor: tier,
		env: { account: '111111111111', region: 'us-west-2' },
	});
	const hostingProps: HostingProps = {
		root,
		buildOutputDir: 'dist',
		framework: 'spa',
		api: stack,
		frontDoor: typeof frontDoor === 'function' ? frontDoor(stack) : frontDoor,
	};
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
		allowPlainHttp: entries?.get('BLOCKS_ALLOW_PLAIN_HTTP'),
		apiUrlOutput: resolve(template.findOutputs('ApiUrl').ApiUrl?.Value),
		browserApiUrl: resolve(buildConfigJson(hostingProps, 'b1').apiUrl),
	};
};

describe('BLOCKS_PUBLIC_ORIGIN belongs to whoever serves /cdk-blocks/* to browsers', () => {
	test("ALB without a certificate under 'cloudfront': the ALB stays the public origin (the API distribution doesn't overwrite it)", async () => {
		const r = await synth('cloudfront', { kind: 'alb' }, true);
		assert.ok(r.apiFrontDoorBuilt, 'an http:// door does not claim, so native clients keep an HTTPS ApiUrl');
		assert.match(r.publicOrigin ?? '', /"http:\/\/",\{"Fn::GetAtt":\["HostingAlb[0-9A-F]+","DNSName"\]\}/);
		assert.match(r.apiUrlOutput, /ApiFrontDoor/);
	});

	test('`allowPlainHttp: true` on a plain-HTTP door registers BLOCKS_ALLOW_PLAIN_HTTP, so `Auth` issues its cookie without `Secure`', async () => {
		const r = await synth('apigateway', { kind: 'alb', allowPlainHttp: true });
		assert.match(r.publicOrigin ?? '', /"http:\/\/"/);
		assert.strictEqual(r.allowPlainHttp, 'true');
		// Without the opt-out (a sandbox deploy), or over HTTPS, nothing is registered: `Auth` fails closed.
		assert.strictEqual((await synth('apigateway', { kind: 'alb' }, true)).allowPlainHttp, undefined);
		assert.strictEqual((await synth('apigateway', { kind: 'alb', allowPlainHttp: true }, true)).allowPlainHttp, undefined);
		assert.strictEqual((await synth('apigateway', { kind: 'apiGateway' })).allowPlainHttp, undefined);
	});

	// The registration rule needs both the opt-out AND a door that serves plain HTTP: an opted-out door
	// whose public origin is HTTPS registers nothing, so `Auth` keeps `Secure`.
	describe('`allowPlainHttp: true` registers BLOCKS_ALLOW_PLAIN_HTTP only where the public origin is plain HTTP', () => {
		const domain = { domainName: 'app.example.com', hostedZone: 'example.com', hostedZoneId: 'Z123' };
		test('an ALB with a `certificate` and `features.domain` serves HTTPS: nothing is registered', async () => {
			const r = await synth('apigateway', (stack) => ({
				kind: 'alb',
				allowPlainHttp: true,
				certificate: cdk.aws_certificatemanager.Certificate.fromCertificateArn(
					stack,
					'Cert',
					'arn:aws:acm:us-west-2:111111111111:certificate/c',
				),
				features: { domain },
			}));
			assert.match(r.publicOrigin ?? '', /https:\/\/app\.example\.com/);
			assert.strictEqual(r.allowPlainHttp, undefined);
		});

		test('the stacked door: its public origin is the HTTPS edge, so nothing is registered', async () => {
			const r = await synth('apigateway', { kind: 'stacked', edge: 'cloudfront', router: 'alb', allowPlainHttp: true });
			assert.doesNotMatch(r.publicOrigin ?? '', /"http:\/\/"/);
			assert.strictEqual(r.allowPlainHttp, undefined);
		});

		// A literal url: the scheme of a token url (`Fn.join`) is not readable at synth.
		const customDoor = (scheme: 'http' | 'https') =>
			defineFrontDoor({
				service: `custom-${scheme}`,
				build(scope, { origins }) {
					new Distribution(scope, 'Cdn', { defaultBehavior: { origin: cf.origin(origins.assets) } });
					for (const api of origins.api ? [origins.api] : []) cf.recordWired(api, api.paths);
					return { url: `${scheme}://proxy.example.com` };
				},
			});
		test('a custom door returning an `http://` url: registered', async () => {
			const r = await synth('apigateway', { kind: 'custom', door: customDoor('http'), allowPlainHttp: true });
			assert.strictEqual(r.allowPlainHttp, 'true');
		});
		test('a custom door returning an `https://` url: nothing is registered', async () => {
			const r = await synth('apigateway', { kind: 'custom', door: customDoor('https'), allowPlainHttp: true });
			assert.strictEqual(r.allowPlainHttp, undefined);
		});
	});

	test("ALB without a certificate under 'apigateway': the ALB is the public origin", async () => {
		const r = await synth('apigateway', { kind: 'alb' }, true);
		assert.ok(!r.apiFrontDoorBuilt);
		assert.match(r.publicOrigin ?? '', /HostingAlb[0-9A-F]+","DNSName"/);
	});

	test("'none' under 'apigateway': no public origin (the bucket serves no /cdk-blocks/*; the request's own host is the real one)", async () => {
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
			['stacked edge', { kind: 'stacked', edge: 'cloudfront', router: 'alb', internal: true }, true],
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

