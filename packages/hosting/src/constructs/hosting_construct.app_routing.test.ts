// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A bring-your-own door that routes at the app (`routing: 'app'`), through
 * `HostingConstruct`:
 *
 * - the door receives `origins.entry`, the one function to attach;
 * - a static app gets exactly one new function (the router); an SSR app gets
 *   none: its server function carries the router as its handler, reads the
 *   assets bucket and names the build prefix;
 * - the entry switches to a new build only after its uploads (the cutover);
 * - an app the router can't serve fails synth with an actionable error.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { App, CfnResource, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { LambdaTarget } from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import type { DeployManifest } from '../manifest/types.js';
import { APP_ROUTER_FILE, APP_ROUTER_HANDLER } from './app_router.js';
import { type DoorInput, defineFrontDoor, type EntryOrigin, type FrontDoor } from './front_door.js';
import { HostingConstruct, type HostingConstructProps } from './hosting_construct.js';

const API_URL = 'https://abc123.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api';

type Template_ = ReturnType<typeof Template.fromStack>;
type FnResource = {
	Properties: {
		Handler: string;
		Layers?: unknown[];
		Code: { ZipFile?: string };
		Environment?: { Variables?: Record<string, unknown> };
	};
	DependsOn?: string[];
};

const functions = (t: Template_): Record<string, FnResource> =>
	t.findResources('AWS::Lambda::Function') as Record<string, FnResource>;

/** A door that records its input and attaches nothing (the url is a fixed domain). */
const recordingDoor = (seen: { input?: DoorInput; entry?: EntryOrigin }) =>
	defineFrontDoor({
		service: 'recording',
		routing: 'app',
		build(scope, input) {
			seen.input = input;
			// `origins.entry` is always present under routing: 'app' (no assertion needed).
			seen.entry = input.origins.entry;
			new CfnResource(scope, 'Marker', { type: 'AWS::CloudFormation::WaitConditionHandle' });
			return { url: 'https://app.example.com' };
		},
	});

/** The same door, routing at the door (the baseline a function count is compared with). */
const baselineDoor = defineFrontDoor({
	service: 'baseline',
	build(scope) {
		new CfnResource(scope, 'Marker', { type: 'AWS::CloudFormation::WaitConditionHandle' });
		return { url: 'https://app.example.com' };
	},
});

describe("HostingConstruct — a door with routing: 'app'", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-app-routing-'));
		fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>');
	});
	afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

	const spaManifest = (): DeployManifest => ({
		version: 1,
		buildId: 'approute-spa',
		compute: {},
		staticAssets: { directory: tmpDir, spaFallback: true },
		routes: [{ pattern: '/*', target: 'static' }],
		redirects: [{ source: '/old', destination: '/new', statusCode: 301 }],
	});

	const handlerManifest = (opts: { streaming?: boolean; image?: boolean } = {}): DeployManifest => {
		const bundle = path.join(tmpDir, 'server');
		fs.mkdirSync(bundle, { recursive: true });
		fs.writeFileSync(path.join(bundle, 'index.mjs'), 'export const handler = async () => ({ statusCode: 200 });\n');
		const imageBundle = path.join(tmpDir, 'image');
		fs.mkdirSync(imageBundle, { recursive: true });
		fs.writeFileSync(
			path.join(imageBundle, 'index.mjs'),
			'export const handler = async () => ({ statusCode: 200 });\n',
		);
		return {
			version: 1,
			buildId: 'approute-ssr',
			compute: {
				default: {
					type: 'handler',
					bundle,
					handler: 'index.handler',
					placement: 'regional',
					streaming: opts.streaming ?? false,
				},
				...(opts.image
					? {
							'image-optimization': {
								type: 'handler' as const,
								bundle: imageBundle,
								handler: 'index.handler',
								placement: 'regional' as const,
							},
						}
					: {}),
			},
			staticAssets: { directory: tmpDir },
			routes: [
				{ pattern: '/_next/static/*', target: 'static' },
				...(opts.image ? [{ pattern: '/_next/image', target: 'image-optimization' }] : []),
				{ pattern: '/*', target: 'default' },
			],
		};
	};

	const lwaManifest = (): DeployManifest => {
		const bundle = path.join(tmpDir, 'lwa');
		fs.mkdirSync(bundle, { recursive: true });
		fs.writeFileSync(path.join(bundle, 'run.sh'), '#!/bin/sh\nexec node index.mjs\n');
		return {
			version: 1,
			buildId: 'approute-lwa',
			compute: {
				default: {
					type: 'http-server',
					bundle,
					entrypoint: 'run.sh',
					port: 4321,
					placement: 'regional',
					environment: { HOST_HEADER: 'x-forwarded-host' },
				},
			},
			staticAssets: { directory: tmpDir },
			routes: [
				{ pattern: '/_astro/*', target: 'static' },
				{ pattern: '/*', target: 'default' },
			],
		};
	};

	const synth = (manifest: DeployManifest, door: FrontDoor, extra: Partial<HostingConstructProps> = {}) => {
		const stack = new Stack(new App(), 'AppRouting', { env: { account: '111111111111', region: 'us-west-2' } });
		const hosting = new HostingConstruct(stack, 'Hosting', {
			manifest,
			frontDoor: { kind: 'custom', door },
			skipRegionValidation: true,
			backendApi: { url: API_URL, paths: ['/hooks/*'] },
			...extra,
		});
		return { stack, hosting, t: Template.fromStack(stack) };
	};

	/** The resources of the build's asset uploads. */
	const uploads = (t: Template_): string[] => Object.keys(t.findResources('Custom::CDKBucketDeployment'));

	it('a static app: the door gets origins.entry, and exactly one new function (the router)', () => {
		const seen: { input?: DoorInput; entry?: EntryOrigin } = {};
		const { t } = synth(spaManifest(), recordingDoor(seen));
		const { t: baseline } = synth(spaManifest(), baselineDoor, {
			frontDoor: { kind: 'custom', door: baselineDoor, wiringCheck: false },
		});

		assert.equal(seen.entry?.kind, 'entry');
		assert.equal(seen.entry?.streaming, false);
		// The app facts stay present for reference.
		assert.equal(seen.input?.app.spaFallback, true);
		assert.equal(seen.input?.origins.server, undefined);

		const added = Object.keys(functions(t)).filter((id) => !(id in functions(baseline)));
		assert.equal(added.length, 1, `one new function, got ${added.join(', ')}`);
		const router = functions(t)[added[0]];
		assert.equal(router.Properties.Handler, 'index.handler');
		assert.match(router.Properties.Code.ZipFile ?? '', /the app router/);
		const env = router.Properties.Environment?.Variables ?? {};
		assert.equal(env.ASSET_KEY_PREFIX, 'builds/approute-spa');
		assert.ok(env.ASSET_BUCKET);
		assert.ok(env.API_GW_BASE, 'the backend base, for the same-origin API');
		// The router is the build cutover: it updates only after every upload.
		for (const upload of uploads(t)) assert.ok(router.DependsOn?.includes(upload), `depends on ${upload}`);
		// It reads the assets bucket.
		const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
		assert.match(policies, /s3:GetObject/);
	});

	it('an SSR app: no new function; the server carries the router, reads the bucket and names the build', () => {
		const seen: { input?: DoorInput; entry?: EntryOrigin } = {};
		const manifest = handlerManifest();
		const { t, hosting } = synth(manifest, recordingDoor(seen));
		const { t: baseline } = synth(handlerManifest(), baselineDoor, {
			frontDoor: { kind: 'custom', door: baselineDoor, wiringCheck: false },
		});

		assert.equal(Object.keys(functions(t)).length, Object.keys(functions(baseline)).length);
		const server = hosting.computeFunctions.get('default');
		assert.equal(seen.entry?.fn, server);
		assert.equal(seen.input?.origins.server?.fn, server);

		const [serverId, serverFn] = Object.entries(functions(t)).find(
			([, r]) => r.Properties.Handler === APP_ROUTER_HANDLER,
		) ?? ['', undefined];
		assert.ok(serverFn, 'the server function runs the router');
		const env = serverFn.Properties.Environment?.Variables ?? {};
		assert.equal(env.ASSET_KEY_PREFIX, 'builds/approute-ssr');
		assert.ok(env.ASSET_BUCKET);
		assert.ok(env.API_GW_BASE);
		for (const upload of uploads(t)) assert.ok(serverFn.DependsOn?.includes(upload), `depends on ${upload}`);

		// The router sits next to the handler and delegates server routes to it.
		const router = fs.readFileSync(path.join(manifest.compute.default.bundle, APP_ROUTER_FILE), 'utf-8');
		assert.match(router, /"\.\/index\.mjs"/);
		assert.match(router, /const ROUTER_SERVER = "handler"/);

		// The server's role reads the assets bucket.
		const role = (
			t.findResources('AWS::Lambda::Function')[serverId] as { Properties: { Role: { 'Fn::GetAtt': [string] } } }
		).Properties.Role['Fn::GetAtt'][0];
		const policies = Object.values(t.findResources('AWS::IAM::Policy')).filter((p) =>
			JSON.stringify(p.Properties.Roles).includes(role),
		);
		assert.match(JSON.stringify(policies), /s3:GetObject/);
	});

	it('a Lambda Web Adapter server becomes a Node.js handler that starts it (no Web Adapter layer)', () => {
		const manifest = lwaManifest();
		const { t } = synth(manifest, recordingDoor({}));
		const server = Object.values(functions(t)).find((r) => r.Properties.Handler === APP_ROUTER_HANDLER);
		assert.ok(server);
		assert.equal(server.Properties.Layers, undefined);
		const env = server.Properties.Environment?.Variables ?? {};
		assert.equal(env.AWS_LAMBDA_EXEC_WRAPPER, undefined);
		assert.equal(env.AWS_LWA_INVOKE_MODE, undefined);
		assert.equal(env.HOST_HEADER, 'x-forwarded-host');
		const router = fs.readFileSync(path.join(manifest.compute.default.bundle, APP_ROUTER_FILE), 'utf-8');
		assert.match(router, /const ROUTER_SERVER = "http"/);
		assert.match(router, /const ROUTER_SERVER_PORT = 4321;/);
		assert.match(router, /const ROUTER_SERVER_START = "run.sh";/);
	});

	it('names the image function to the router and lets it invoke it', () => {
		const { t, hosting } = synth(handlerManifest({ image: true }), recordingDoor({}));
		const server = Object.values(functions(t)).find((r) => r.Properties.Handler === APP_ROUTER_HANDLER);
		assert.ok(server?.Properties.Environment?.Variables?.BLOCKS_IMAGE_FUNCTION);
		const image = hosting.computeFunctions.get('image-optimization');
		assert.ok(image);
		assert.match(JSON.stringify(t.findResources('AWS::IAM::Policy')), /lambda:InvokeFunction/);
	});

	it('entry.url is created on first read (BUFFERED), and is the server URL for an SSR app', () => {
		let urls: [unknown, unknown] = [undefined, undefined];
		const door = defineFrontDoor({
			service: 'url-door',
			routing: 'app',
			build(_scope, { origins }) {
				urls = [origins.entry.url, origins.server?.url];
				return { url: 'https://app.example.com' };
			},
		});
		const { t } = synth(handlerManifest(), door);
		assert.equal(urls[0], urls[1]);
		const fnUrls = Object.values(t.findResources('AWS::Lambda::Url'));
		assert.equal(fnUrls.length, 1);
		assert.equal(fnUrls[0].Properties.InvokeMode, 'BUFFERED');
		assert.equal(fnUrls[0].Properties.AuthType, 'AWS_IAM');
	});

	it('a shared-ALB door: one listener rule and one Lambda target group per app', () => {
		const stack = new Stack(new App(), 'Shared', { env: { account: '111111111111', region: 'us-west-2' } });
		const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2, natGateways: 0 });
		const alb = new elbv2.ApplicationLoadBalancer(stack, 'Alb', { vpc, internetFacing: true });
		const listener = alb.addListener('Http', {
			port: 80,
			defaultAction: elbv2.ListenerAction.fixedResponse(404),
		});
		const sharedAlbDoor = (host: string, priority: number) =>
			defineFrontDoor({
				service: 'shared-alb',
				routing: 'app',
				build(scope, { origins }) {
					const target = new elbv2.ApplicationTargetGroup(scope, 'Tg', {
						targetType: elbv2.TargetType.LAMBDA,
						targets: [new LambdaTarget(origins.entry.fn)],
						multiValueHeadersEnabled: true,
					});
					new elbv2.ApplicationListenerRule(scope, 'Rule', {
						listener,
						priority,
						conditions: [elbv2.ListenerCondition.hostHeaders([host])],
						action: elbv2.ListenerAction.forward([target]),
					});
					return { url: `http://${host}` };
				},
			});
		new HostingConstruct(stack, 'Spa', {
			manifest: spaManifest(),
			frontDoor: { kind: 'custom', door: sharedAlbDoor('spa.example.com', 10) },
		});
		new HostingConstruct(stack, 'Ssr', {
			manifest: handlerManifest(),
			frontDoor: { kind: 'custom', door: sharedAlbDoor('ssr.example.com', 20) },
			skipRegionValidation: true,
		});
		const t = Template.fromStack(stack);
		t.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 2);
		t.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 2);
		for (const tg of Object.values(t.findResources('AWS::ElasticLoadBalancingV2::TargetGroup'))) {
			assert.equal(tg.Properties.TargetType, 'lambda');
		}
	});

	it('runs no routes/API wiring check (the entry serves the assets and the API)', () => {
		// The recording door wires nothing with the cf.* helpers; the default check would fail it.
		assert.doesNotThrow(() => synth(spaManifest(), recordingDoor({})));
	});

	it('fails synth for a streaming server handler, naming the fix', () => {
		assert.throws(
			() => synth(handlerManifest({ streaming: true }), recordingDoor({})),
			(err: Error) => err.name === 'AppRoutingNeedsBufferedServerError' && /buffered/.test(err.message),
		);
	});

	it("fails synth for a door that declares serverResponse: 'streaming'", () => {
		const door = defineFrontDoor({
			service: 'streaming-app-door',
			routing: 'app',
			serverResponse: 'streaming',
			build: () => ({ url: 'https://app.example.com' }),
		});
		assert.throws(
			() => synth(spaManifest(), door),
			(err: Error) => err.name === 'InvalidPropsError' && /serverResponse/.test(err.message),
		);
	});

	it('fails synth for an unknown routing mode', () => {
		// A JS door can carry any value; the runtime check is the guard.
		const door = { service: 'odd', routing: 'edge', build: () => ({ url: 'https://app.example.com' }) };
		assert.throws(
			() => synth(spaManifest(), door as unknown as FrontDoor),
			(err: Error) => err.name === 'InvalidPropsError' && /routing/.test(err.message),
		);
	});

	it('fails synth for a route to a compute the router cannot reach (a regional edge route)', () => {
		const manifest = handlerManifest();
		const edgeBundle = path.join(tmpDir, 'edge1');
		fs.mkdirSync(edgeBundle);
		fs.writeFileSync(path.join(edgeBundle, 'index.mjs'), 'export const handler = async () => ({});\n');
		manifest.compute.edge1 = {
			type: 'handler',
			bundle: edgeBundle,
			handler: 'index.handler',
			placement: 'regional',
		};
		manifest.routes.unshift({ pattern: '/api/edge', target: 'edge1' });
		assert.throws(
			() => synth(manifest, recordingDoor({})),
			(err: Error) => err.name === 'AppRoutingUnsupportedRouteError' && /edge1/.test(err.message),
		);
	});
});
