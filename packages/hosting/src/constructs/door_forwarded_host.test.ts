// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `x-forwarded-host` reaches the server the same way behind every built-in
 * door: the viewer's `Host`, never a value the client sent. The CloudFront
 * door's router and the stacked door's edge set it at the edge; behind the
 * ALB and API Gateway doors, nothing in front does, so the server is fitted
 * instead (`DoorCapabilities.forwardedHost`):
 *
 * - a Lambda handler behind the ALB: the ALB event shim sets it from `Host`;
 * - a Lambda handler behind API Gateway: the forwarded-host shim does, and a
 *   streaming handler stays streaming;
 * - a Lambda Web Adapter server reading `HOST_HEADER` (adapter-node): reads
 *   `host` instead.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type { DeployManifest } from '../manifest/types.js';
import {
	ALB_EVENT_SHIM_FILE,
	ALB_EVENT_SHIM_HANDLER,
	FORWARDED_HOST_SHIM_FILE,
	FORWARDED_HOST_SHIM_HANDLER,
	generateAlbEventShimCode,
	generateForwardedHostShimCode,
} from './alb_lambda_event.js';
import { doorCapabilitiesFor, HostingConstruct, type HostingConstructProps } from './hosting_construct.js';

/** A handler that echoes the forwarded host it was given. */
const ECHO_HANDLER = `export const handler = async (event) => ({
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ single: event.headers['x-forwarded-host'] ?? null, multi: event.multiValueHeaders?.['x-forwarded-host'] ?? null }),
});
`;

/** A streaming handler, marked as `awslambda.streamifyResponse` marks one. */
const STREAMING_HANDLER = `const STREAMING = Symbol.for('aws.lambda.runtime.handler.streaming');
export const handler = async (event, stream) => { stream.write(event.headers['x-forwarded-host'] ?? ''); stream.end(); };
handler[STREAMING] = 'response';
`;

const albEvent = (forwardedHost?: string) => ({
	requestContext: { elb: { targetGroupArn: 'arn:aws:elasticloadbalancing:us-west-2:111111111111:targetgroup/x/y' } },
	httpMethod: 'GET',
	path: '/account',
	multiValueQueryStringParameters: {},
	multiValueHeaders: {
		host: ['app.example.com'],
		...(forwardedHost ? { 'X-Forwarded-Host': [forwardedHost] } : {}),
	},
	body: null,
	isBase64Encoded: false,
});

const apiGatewayEvent = (forwardedHost?: string) => ({
	resource: '/{proxy+}',
	path: '/account',
	httpMethod: 'GET',
	headers: { Host: 'app.example.com', ...(forwardedHost ? { 'X-Forwarded-Host': forwardedHost } : {}) },
	multiValueHeaders: { Host: ['app.example.com'], ...(forwardedHost ? { 'X-Forwarded-Host': [forwardedHost] } : {}) },
	requestContext: {},
	body: null,
	isBase64Encoded: false,
});

type Echo = { single: string | null; multi: string[] | null };
type Handler = ((event: unknown, ...rest: unknown[]) => Promise<{ body: string; multiValueHeaders?: unknown }>) &
	Record<symbol, unknown>;

describe('the server shims set x-forwarded-host from Host', () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fwd-host-'));
	});
	afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

	const load = async (inner: string, shimFile: string, shim: string): Promise<Handler> => {
		fs.writeFileSync(path.join(tmp, 'index.mjs'), inner);
		fs.writeFileSync(path.join(tmp, shimFile), shim);
		const mod = await import(pathToFileURL(path.join(tmp, shimFile)).href);
		return mod.handler;
	};

	it('ALB door: the shim replaces a client-sent x-forwarded-host with Host', async () => {
		const handler = await load(
			ECHO_HANDLER,
			ALB_EVENT_SHIM_FILE,
			generateAlbEventShimCode('./index.mjs', 'handler', { forwardedHostFromHost: true }),
		);
		for (const sent of ['evil.example', undefined]) {
			const echo: Echo = JSON.parse((await handler(albEvent(sent))).body);
			assert.equal(echo.single, 'app.example.com', `sent ${sent}`);
			assert.deepEqual(echo.multi, ['app.example.com']);
		}
	});

	it("stacked router: the shim keeps the edge's x-forwarded-host (the edge set it from the viewer's Host)", async () => {
		const handler = await load(ECHO_HANDLER, ALB_EVENT_SHIM_FILE, generateAlbEventShimCode('./index.mjs'));
		const echo: Echo = JSON.parse((await handler(albEvent('www.example.com'))).body);
		assert.equal(echo.single, 'www.example.com');
	});

	it("drops the stacked router's origin-verify secret before the handler runs (both header maps)", async () => {
		const keys = `export const handler = async (event) => ({ statusCode: 200, body: JSON.stringify({ h: Object.keys(event.headers), m: Object.keys(event.multiValueHeaders || {}) }) });\n`;
		const handler = await load(keys, ALB_EVENT_SHIM_FILE, generateAlbEventShimCode('./index.mjs'));
		const ev = albEvent();
		(ev.multiValueHeaders as Record<string, string[]>)['X-Blocks-Origin-Verify'] = ['s3cret'];
		const seen: { h: string[]; m: string[] } = JSON.parse((await handler(ev)).body);
		assert.ok(!seen.h.includes('x-blocks-origin-verify') && !seen.m.includes('x-blocks-origin-verify'), JSON.stringify(seen));
		assert.ok(seen.h.includes('host'));
	});

	it('API Gateway door: the shim replaces it in both header maps, whatever the case', async () => {
		const handler = await load(ECHO_HANDLER, FORWARDED_HOST_SHIM_FILE, generateForwardedHostShimCode('./index.mjs'));
		const echo: Echo = JSON.parse((await handler(apiGatewayEvent('evil.example'))).body);
		assert.equal(echo.single, 'app.example.com');
		assert.deepEqual(echo.multi, ['app.example.com']);
	});

	it('API Gateway door: a streaming handler stays streaming behind the shim', async () => {
		const handler = await load(STREAMING_HANDLER, FORWARDED_HOST_SHIM_FILE, generateForwardedHostShimCode('./index.mjs'));
		assert.equal(handler[Symbol.for('aws.lambda.runtime.handler.streaming')], 'response');
		const chunks: string[] = [];
		const stream = { write: (c: string) => chunks.push(c), end: () => {} };
		await handler(apiGatewayEvent('evil.example'), stream, {});
		assert.equal(chunks.join(''), 'app.example.com');
	});
});

describe('HostingConstruct fits the server to doors that do not set x-forwarded-host', () => {
	let tmp: string;
	let bundle: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fwd-host-hosting-'));
		fs.writeFileSync(path.join(tmp, 'index.html'), '<html></html>');
		bundle = path.join(tmp, 'server');
		fs.mkdirSync(bundle);
		fs.writeFileSync(path.join(bundle, 'index.mjs'), ECHO_HANDLER);
		fs.writeFileSync(path.join(bundle, 'run.sh'), '#!/bin/sh\nnode index.mjs');
	});
	afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

	const domain = { domainName: 'app.example.com', hostedZoneId: 'Z1234567890ABC', hostedZone: 'example.com' };
	const handlerServer = (streaming: boolean): DeployManifest['compute'][string] => ({
		type: 'handler',
		bundle,
		handler: 'index.handler',
		placement: 'regional',
		streaming,
	});
	const lwaServer = (): DeployManifest['compute'][string] => ({
		type: 'http-server',
		bundle,
		entrypoint: 'run.sh',
		port: 3000,
		placement: 'regional',
		environment: { HOST_HEADER: 'x-forwarded-host', PROTOCOL_HEADER: 'x-forwarded-proto' },
	});
	const synth = (
		server: DeployManifest['compute'][string],
		frontDoor: HostingConstructProps['frontDoor'],
		extra: Partial<HostingConstructProps> = {},
	) => {
		const stack = new Stack(new App(), 'S', { env: { account: '111111111111', region: 'us-west-2' } });
		new HostingConstruct(stack, 'Hosting', {
			manifest: {
				version: 1,
				buildId: 'fh1',
				compute: { server },
				staticAssets: { directory: tmp },
				routes: [
					{ pattern: '/assets/*', target: 'static' },
					{ pattern: '/*', target: 'server' },
				],
			},
			frontDoor,
			...extra,
		});
		return { fns: Object.values(Template.fromStack(stack).findResources('AWS::Lambda::Function')) };
	};
	const handlerOf = (fns: ReturnType<typeof synth>['fns']): string[] => fns.map((f) => String(f.Properties.Handler));

	it('declares which doors set it themselves', () => {
		assert.equal(doorCapabilitiesFor(undefined).forwardedHost, true);
		assert.equal(doorCapabilitiesFor({ kind: 'stackedRouter' }).forwardedHost, true);
		assert.equal(doorCapabilitiesFor({ kind: 'alb' }).forwardedHost, false);
		assert.equal(doorCapabilitiesFor({ kind: 'apiGateway' }).forwardedHost, false);
		assert.equal(doorCapabilitiesFor({ kind: 'apiGateway', api: 'rest' }).forwardedHost, false);
	});

	it('ALB: a handler server runs the ALB shim, which sets the forwarded host', () => {
		const { fns } = synth(handlerServer(false), { kind: 'alb' });
		assert.ok(handlerOf(fns).includes(ALB_EVENT_SHIM_HANDLER));
		assert.match(fs.readFileSync(path.join(bundle, ALB_EVENT_SHIM_FILE), 'utf-8'), /headers\['x-forwarded-host'\] = headers\.host/);
	});

	it("stacked router: the ALB shim keeps the edge's forwarded host", () => {
		synth(handlerServer(false), { kind: 'stackedRouter' });
		assert.doesNotMatch(fs.readFileSync(path.join(bundle, ALB_EVENT_SHIM_FILE), 'utf-8'), /x-forwarded-host/);
	});

	it('API Gateway (HTTP, and REST with a streaming server): a handler server runs the forwarded-host shim', () => {
		for (const [frontDoor, streaming, extra] of [
			[{ kind: 'apiGateway' }, false, {}],
			[{ kind: 'apiGateway', api: 'rest' }, true, { domain }],
		] as const) {
			const { fns } = synth(handlerServer(streaming), frontDoor, extra);
			assert.ok(handlerOf(fns).includes(FORWARDED_HOST_SHIM_HANDLER), JSON.stringify(frontDoor));
			assert.ok(fs.existsSync(path.join(bundle, FORWARDED_HOST_SHIM_FILE)));
		}
	});

	it('CloudFront: the server keeps its own handler', () => {
		const { fns } = synth(handlerServer(true), undefined);
		const handlers = handlerOf(fns);
		assert.ok(!handlers.includes(FORWARDED_HOST_SHIM_HANDLER) && !handlers.includes(ALB_EVENT_SHIM_HANDLER));
	});

	it('a Lambda Web Adapter server reading HOST_HEADER reads Host on the ALB and API Gateway doors only', () => {
		const hostHeader = (frontDoor: HostingConstructProps['frontDoor']) => {
			const { fns } = synth(lwaServer(), frontDoor);
			const values = fns
				.map((f) => (f.Properties.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables?.HOST_HEADER)
				.filter((v) => v !== undefined);
			assert.equal(values.length, 1, `one server with HOST_HEADER: ${JSON.stringify(frontDoor)}`);
			return values[0];
		};
		assert.equal(hostHeader({ kind: 'alb' }), 'host');
		assert.equal(hostHeader({ kind: 'apiGateway' }), 'host');
		assert.equal(hostHeader({ kind: 'stackedRouter' }), 'x-forwarded-host');
		assert.equal(hostHeader(undefined), 'x-forwarded-host');
	});
});
