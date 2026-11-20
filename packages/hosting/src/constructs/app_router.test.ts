// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Behavior of the app router (`routing: 'app'`): the one handler that runs an
 * app's route table. The generated source is executed with an in-memory S3
 * bucket, a stubbed backend (`node:https`) and a stubbed image function
 * (`@aws-sdk/client-lambda`); the framework server is a real module (native
 * handler) or a real child process (HTTP server).
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import * as zlib from 'node:zlib';
import { type AppRouterOptions, generateAppRouterCode } from './app_router.js';

const PREFIX = 'builds/b1';

type Headers = Record<string, string[]>;
type RouterResponse = {
	statusCode: number;
	statusDescription?: string;
	headers?: Record<string, string>;
	multiValueHeaders?: Headers;
	cookies?: string[];
	body: string;
	isBase64Encoded: boolean;
};
type Handler = (event: unknown, context?: unknown) => Promise<RouterResponse>;

type StoredObject = { body: string; contentType?: string; cacheControl?: string };

const OBJECTS: Record<string, StoredObject> = {
	[`${PREFIX}/index.html`]: { body: '<html>shell</html>', contentType: 'text/html', cacheControl: 'no-cache' },
	[`${PREFIX}/assets/app.js`]: { body: 'console.log(1)', contentType: 'text/javascript', cacheControl: 'immutable' },
	[`${PREFIX}/_next/static/chunk.js`]: { body: 'chunk', contentType: 'text/javascript' },
	[`${PREFIX}/img/cat.png`]: { body: 'PNG', contentType: 'image/png' },
	[`${PREFIX}/404.html`]: { body: '<html>not found page</html>', contentType: 'text/html' },
	[`${PREFIX}/500.html`]: { body: '<html>error page</html>', contentType: 'text/html' },
};

type Calls = {
	s3: string[];
	api: { method?: string; path?: string; headers?: http.OutgoingHttpHeaders; body?: string }[];
	image: { FunctionName: string; event: Record<string, unknown> }[];
};

type LoadOptions = {
	dir?: string;
	backend?: { status: number; headers: Record<string, string | string[]>; body: string };
	image?: { statusCode: number; headers?: Record<string, string>; body: string; isBase64Encoded?: boolean };
};

/** Load the generated router with stubbed AWS clients and backend. */
const load = (opts: AppRouterOptions, lo: LoadOptions = {}): { handler: Handler; calls: Calls } => {
	const calls: Calls = { s3: [], api: [], image: [] };
	class GetObjectCommand {
		constructor(readonly input: { Key: string }) {}
	}
	class S3Client {
		async send(cmd: GetObjectCommand) {
			calls.s3.push(cmd.input.Key);
			const obj = OBJECTS[cmd.input.Key];
			if (!obj)
				throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
			return { Body: [Buffer.from(obj.body)], ContentType: obj.contentType, CacheControl: obj.cacheControl };
		}
	}
	class InvokeCommand {
		constructor(readonly input: { FunctionName: string; Payload: Buffer }) {}
	}
	class LambdaClient {
		async send(cmd: InvokeCommand) {
			calls.image.push({
				FunctionName: cmd.input.FunctionName,
				event: JSON.parse(cmd.input.Payload.toString('utf8')),
			});
			return { Payload: Buffer.from(JSON.stringify(lo.image ?? { statusCode: 200, body: 'img' })) };
		}
	}
	const https = {
		request: (
			o: { method?: string; path?: string; headers?: http.OutgoingHttpHeaders },
			cb: (res: unknown) => void,
		) => {
			const call: Calls['api'][number] = { method: o.method, path: o.path, headers: o.headers };
			calls.api.push(call);
			const backend = lo.backend ?? { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' };
			return {
				on: () => undefined,
				end: (body?: Buffer) => {
					call.body = body?.toString('utf8');
					const listeners: Record<string, (arg?: Buffer) => void> = {};
					cb({
						statusCode: backend.status,
						statusMessage: 'OK',
						headers: backend.headers,
						on: (name: string, fn: (arg?: Buffer) => void) => {
							listeners[name] = fn;
						},
					});
					listeners.data?.(Buffer.from(backend.body));
					listeners.end?.();
				},
			};
		},
	};
	const fakeRequire = (id: string): unknown => {
		if (id === '@aws-sdk/client-s3') return { S3Client, GetObjectCommand };
		if (id === '@aws-sdk/client-lambda') return { LambdaClient, InvokeCommand };
		if (id === 'node:https') return https;
		if (id === 'node:zlib') return zlib;
		if (id.startsWith('node:')) return process.getBuiltinModule(id);
		throw new Error(`unexpected require: ${id}`);
	};
	const env = {
		ASSET_BUCKET: 'bucket',
		ASSET_KEY_PREFIX: PREFIX,
		API_GW_BASE: 'https://abc.execute-api.us-west-2.amazonaws.com/prod',
		BLOCKS_IMAGE_FUNCTION: 'image-fn',
	};
	const fakeProcess = { env, execPath: process.execPath };
	const mod: { exports: { handler?: Handler } } = { exports: {} };
	new Function('require', 'exports', 'module', 'process', '__dirname', generateAppRouterCode(opts))(
		fakeRequire,
		mod.exports,
		mod,
		fakeProcess,
		lo.dir ?? os.tmpdir(),
	);
	const handler = mod.exports.handler;
	if (!handler) throw new Error('the router exports no handler');
	return { handler, calls };
};

// ── Events ──────────────────────────────────────────────────────────────────

type Req = { method?: string; headers?: Record<string, string>; query?: string; body?: string; cookies?: string[] };

const albEvent = (p: string, r: Req = {}, multi = true) => {
	const query: Record<string, string[]> = {};
	for (const pair of r.query ? r.query.split('&') : []) {
		const [k, v = ''] = pair.split('=');
		query[k] = [...(query[k] ?? []), v];
	}
	const headers = { host: 'app.example.com', ...(r.cookies ? { cookie: r.cookies.join('; ') } : {}), ...r.headers };
	return {
		requestContext: { elb: { targetGroupArn: 'arn' } },
		httpMethod: r.method ?? 'GET',
		path: p,
		...(multi
			? {
					multiValueHeaders: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, [v]])),
					multiValueQueryStringParameters: r.query ? query : null,
				}
			: {
					headers,
					queryStringParameters: r.query
						? Object.fromEntries(Object.entries(query).map(([k, v]) => [k, v[v.length - 1]]))
						: null,
				}),
		body: r.body ?? '',
		isBase64Encoded: false,
	};
};

const v1Event = (p: string, r: Req = {}) => {
	const headers = { Host: 'app.example.com', ...(r.cookies ? { Cookie: r.cookies.join('; ') } : {}), ...r.headers };
	return {
		resource: '/{proxy+}',
		path: p,
		httpMethod: r.method ?? 'GET',
		headers,
		multiValueHeaders: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, [v]])),
		queryStringParameters: r.query ? { q: decodeURIComponent(r.query.split('=')[1]) } : null,
		multiValueQueryStringParameters: r.query ? { q: [decodeURIComponent(r.query.split('=')[1])] } : null,
		requestContext: { httpMethod: r.method ?? 'GET', path: `/prod${p}`, stage: 'prod' },
		body: r.body ?? null,
		isBase64Encoded: false,
	};
};

const v2Event = (p: string, r: Req = {}, domainName = 'abc.execute-api.us-west-2.amazonaws.com') => ({
	version: '2.0',
	routeKey: '$default',
	rawPath: p,
	rawQueryString: r.query ?? '',
	...(r.cookies ? { cookies: r.cookies } : {}),
	headers: { host: domainName, ...r.headers },
	requestContext: { domainName, http: { method: r.method ?? 'GET', path: p } },
	...(r.body !== undefined ? { body: Buffer.from(r.body).toString('base64'), isBase64Encoded: true } : {}),
});

const furlEvent = (p: string, r: Req = {}) => v2Event(p, r, 'abc123.lambda-url.us-west-2.on.aws');

const bodyOf = (res: RouterResponse): string =>
	res.isBase64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;

// ── Fixtures ────────────────────────────────────────────────────────────────

const RULES = {
	redirects: [{ source: '/old/*', destination: '/new/*', statusCode: 308 as const }],
	headers: [{ pattern: '/*', headers: { 'x-app-rule': 'yes' } }],
};

const spa: AppRouterOptions = {
	routes: [
		{ pattern: '/assets/*', kind: 'static' },
		{ pattern: '/*', kind: 'static' },
	],
	spaFallback: true,
	...RULES,
	errorPages: { notFound: '404.html', serverError: '500.html' },
	apiPaths: ['/aws-blocks/*', '/hooks/*'],
	imageFallback: { hosts: ['images.example.com'] },
};

let dir: string;
before(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-router-'));
	// A native handler: echoes the event it got, sets two cookies, and answers
	// 404 / 500 / throws on demand.
	fs.writeFileSync(
		path.join(dir, 'index.mjs'),
		`export const handler = async (event) => {
  if (!event.rawPath) return { statusCode: 200, body: 'non-http:' + JSON.stringify(event) };
  if (event.rawPath === '/missing') return { statusCode: 404, headers: { 'content-type': 'text/html' }, cookies: ['seen=1'], body: 'framework 404' };
  if (event.rawPath === '/boom') throw new Error('render failed');
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'x-frame-options': 'DENY' },
    cookies: ['a=1; Path=/', 'b=2; Path=/'],
    body: JSON.stringify(event),
  };
};
`,
	);
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const ssr = (): AppRouterOptions => ({
	routes: [
		{ pattern: '/_next/static/*', kind: 'static' },
		{ pattern: '/_next/image', kind: 'image' },
		{ pattern: '/*', kind: 'server' },
	],
	...RULES,
	errorPages: { notFound: '404.html', serverError: '500.html' },
	apiPaths: ['/aws-blocks/*'],
	server: { kind: 'handler', module: './index.mjs', export: 'handler' },
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('app router — event shapes in, matching shapes out', () => {
	it('ALB with multi-value headers: answers multiValueHeaders and a status description', async () => {
		const { handler } = load(spa);
		const res = await handler(albEvent('/assets/app.js'));
		assert.equal(res.statusCode, 200);
		assert.equal(res.statusDescription, '200 OK');
		assert.equal(res.headers, undefined);
		assert.deepEqual(res.multiValueHeaders?.['content-type'], ['text/javascript']);
		assert.deepEqual(res.multiValueHeaders?.['x-content-type-options'], ['nosniff']);
		assert.deepEqual(res.multiValueHeaders?.['x-app-rule'], ['yes']);
		// Text travels as UTF-8, not base64 (the ALB's 1 MB limit).
		assert.equal(res.isBase64Encoded, false);
		assert.equal(res.body, 'console.log(1)');
	});

	it('ALB without multi-value headers: answers single headers', async () => {
		const { handler } = load(spa);
		const res = await handler(albEvent('/assets/app.js', {}, false));
		assert.equal(res.multiValueHeaders, undefined);
		assert.equal(res.headers?.['content-type'], 'text/javascript');
	});

	it('API Gateway REST (payload 1.0): answers headers and multiValueHeaders', async () => {
		const { handler } = load(spa);
		const res = await handler(v1Event('/assets/app.js'));
		assert.equal(res.statusCode, 200);
		assert.equal(res.headers?.['cache-control'], 'immutable');
		assert.deepEqual(res.multiValueHeaders?.['cache-control'], ['immutable']);
		assert.equal(res.statusDescription, undefined);
	});

	it('HTTP API (payload 2.0): answers headers, with Set-Cookie as cookies', async () => {
		const { handler } = load(ssr(), { dir });
		const res = await handler(v2Event('/page'));
		assert.equal(res.statusCode, 200);
		assert.deepEqual(res.cookies, ['a=1; Path=/', 'b=2; Path=/']);
		assert.equal(res.headers?.['set-cookie'], undefined);
		assert.equal(res.headers?.['content-type'], 'application/json');
	});

	it('Lambda Function URL: reads the 2.0 event and answers in kind', async () => {
		const { handler } = load(spa);
		const res = await handler(furlEvent('/assets/app.js'));
		assert.equal(res.statusCode, 200);
		assert.equal(res.headers?.['content-type'], 'text/javascript');
		assert.equal(res.multiValueHeaders, undefined);
	});
});

describe('app router — dispatch', () => {
	it("applies the app's redirects first (wildcard tail spliced), with no S3 read", async () => {
		const { handler, calls } = load(spa);
		const res = await handler(albEvent('/old/a/b'));
		assert.equal(res.statusCode, 308);
		assert.deepEqual(res.multiValueHeaders?.location, ['/new/a/b']);
		assert.equal(calls.s3.length, 0);
	});

	it('forwards API paths to the backend through the ALB door forwarder (query as delivered, cookies relayed)', async () => {
		const { handler, calls } = load(spa, {
			backend: {
				status: 200,
				headers: { 'content-type': 'application/json', 'set-cookie': ['s=1', 't=2'] },
				body: '{"ok":true}',
			},
		});
		const res = await handler(
			albEvent('/aws-blocks/api/notes', {
				method: 'POST',
				query: 'a=b%20c',
				body: '{"x":1}',
				headers: { 'x-forwarded-host': 'evil.example', 'x-blocks-origin-verify': 'secret' },
			}),
		);
		assert.equal(calls.api.length, 1);
		assert.equal(calls.api[0].method, 'POST');
		assert.equal(calls.api[0].path, '/prod/aws-blocks/api/notes?a=b%20c');
		assert.equal(calls.api[0].headers?.host, 'abc.execute-api.us-west-2.amazonaws.com');
		assert.equal(calls.api[0].headers?.['x-forwarded-host'], undefined);
		assert.equal(calls.api[0].headers?.['x-blocks-origin-verify'], undefined);
		assert.equal(calls.api[0].body, '{"x":1}');
		assert.equal(res.statusCode, 200);
		assert.deepEqual(res.multiValueHeaders?.['set-cookie'], ['s=1', 't=2']);
		assert.equal(res.body, '{"ok":true}');
		// A raw backend route is an API path too.
		await handler(v2Event('/hooks/stripe'));
		assert.equal(calls.api[1].path, '/prod/hooks/stripe');
	});

	it('serves static files from the build prefix, with the SPA fallback for extensionless paths', async () => {
		const { handler, calls } = load(spa);
		const res = await handler(albEvent('/dashboard/settings'));
		assert.equal(res.statusCode, 200);
		assert.equal(res.body, '<html>shell</html>');
		assert.deepEqual(calls.s3, [`${PREFIX}/index.html`]);
	});

	it("answers a missing file with the app's 404 page", async () => {
		const { handler } = load(spa);
		const res = await handler(albEvent('/missing.js'));
		assert.equal(res.statusCode, 404);
		assert.equal(bodyOf(res), '<html>not found page</html>');
	});

	it('delegates server routes to the native handler with a payload 2.0 event', async () => {
		const { handler, calls } = load(ssr(), { dir });
		const res = await handler(
			albEvent('/page/1', {
				query: 'q=a%20b',
				cookies: ['sid=x', 'theme=dark'],
				headers: { 'x-forwarded-host': 'evil.example', 'x-blocks-origin-verify': 'secret' },
			}),
		);
		assert.equal(res.statusCode, 200);
		const event = JSON.parse(bodyOf(res));
		assert.equal(event.version, '2.0');
		assert.equal(event.rawPath, '/page/1');
		assert.equal(event.rawQueryString, 'q=a%20b');
		assert.deepEqual(event.queryStringParameters, { q: 'a b' });
		assert.deepEqual(event.cookies, ['sid=x', 'theme=dark']);
		assert.equal(event.requestContext.http.method, 'GET');
		// The public host is the request's Host, never the client's x-forwarded-host.
		assert.equal(event.headers['x-forwarded-host'], 'app.example.com');
		assert.equal(event.headers['x-blocks-origin-verify'], undefined);
		// Both cookies survive in an ALB multi-value response.
		assert.deepEqual(res.multiValueHeaders?.['set-cookie'], ['a=1; Path=/', 'b=2; Path=/']);
		// The server's own header wins over the baseline; the app's rule applies.
		assert.deepEqual(res.multiValueHeaders?.['x-frame-options'], ['DENY']);
		assert.deepEqual(res.multiValueHeaders?.['x-app-rule'], ['yes']);
		assert.deepEqual(res.multiValueHeaders?.['strict-transport-security'], ['max-age=31536000']);
		assert.equal(calls.s3.length, 0);
	});

	it('serves static routes of an SSR app from S3, not the server', async () => {
		const { handler, calls } = load(ssr(), { dir });
		const res = await handler(v1Event('/_next/static/chunk.js'));
		assert.equal(res.statusCode, 200);
		assert.equal(res.body, 'chunk');
		assert.deepEqual(calls.s3, [`${PREFIX}/_next/static/chunk.js`]);
	});

	it("replaces a server 404 with the app's 404 page, keeping the cookies the server set", async () => {
		const { handler } = load(ssr(), { dir });
		const res = await handler(v2Event('/missing'));
		assert.equal(res.statusCode, 404);
		assert.equal(bodyOf(res), '<html>not found page</html>');
		assert.deepEqual(res.cookies, ['seen=1']);
		assert.equal(res.headers?.['x-app-rule'], undefined);
	});

	it('answers a failing server with a 502 and never echoes the cause', async () => {
		const { handler } = load(ssr(), { dir });
		const res = await handler(albEvent('/boom'));
		assert.equal(res.statusCode, 502);
		assert.equal(res.body, 'Bad Gateway');
		assert.doesNotMatch(res.body, /render failed/);
	});

	it('hands a non-HTTP event (a warmup) to the native handler unchanged', async () => {
		const { handler } = load(ssr(), { dir });
		const res = await handler({ source: 'hosting-warmup', version: '1' });
		assert.equal(res.body, 'non-http:{"source":"hosting-warmup","version":"1"}');
	});

	it('invokes the image function with a payload 2.0 event, basePath stripped', async () => {
		const { handler, calls } = load(
			{ ...ssr(), basePath: '/app', routes: [{ pattern: '/app/_next/image', kind: 'image' }], image: true },
			{
				dir,
				image: {
					statusCode: 200,
					headers: { 'content-type': 'image/webp' },
					body: 'V0VCUA==',
					isBase64Encoded: true,
				},
			},
		);
		const res = await handler(albEvent('/app/_next/image', { query: 'url=%2Fimg%2Fcat.png&w=64' }));
		assert.equal(calls.image.length, 1);
		assert.equal(calls.image[0].FunctionName, 'image-fn');
		assert.equal(calls.image[0].event.rawPath, '/_next/image');
		assert.equal(calls.image[0].event.rawQueryString, 'url=%2Fimg%2Fcat.png&w=64');
		assert.equal(res.statusCode, 200);
		assert.equal(res.isBase64Encoded, true);
		assert.equal(res.body, 'V0VCUA==');
	});

	it('without an image function, serves a local image source as stored and redirects an allowed remote one', async () => {
		const { handler, calls } = load(spa);
		const local = await handler(albEvent('/_next/image', { query: 'url=%2Fimg%2Fcat.png&w=64' }));
		assert.equal(local.statusCode, 200);
		assert.deepEqual(calls.s3, [`${PREFIX}/img/cat.png`]);
		const remote = await handler(
			v2Event('/_next/image', { query: 'url=https%3A%2F%2Fimages.example.com%2Fa.png' }),
		);
		assert.equal(remote.statusCode, 302);
		assert.equal(remote.headers?.location, 'https://images.example.com/a.png');
		const denied = await handler(v2Event('/_next/image', { query: 'url=https%3A%2F%2Fevil.example%2Fa.png' }));
		assert.equal(denied.statusCode, 404);
		assert.equal(calls.image.length, 0);
	});

	it('redirects a path outside the basePath into it (308, query kept), as the CloudFront router does', async () => {
		const { handler } = load(
			{ ...ssr(), basePath: '/app', routes: [{ pattern: '/app/*', kind: 'server' }] },
			{ dir },
		);
		const res = await handler(v2Event('/about', { query: 'x=1' }));
		assert.equal(res.statusCode, 308);
		assert.equal(res.headers?.location, '/app/about?x=1');
		// The API lives outside the basePath and is not redirected.
		const api = await handler(v2Event('/aws-blocks/api'));
		assert.equal(api.statusCode, 200);
	});

	it('strips the basePath before the S3 lookup of a static route', async () => {
		const { handler, calls } = load({ ...spa, basePath: '/app', routes: [{ pattern: '/app/*', kind: 'static' }] });
		const res = await handler(albEvent('/app/assets/app.js'));
		assert.equal(res.statusCode, 200);
		assert.deepEqual(calls.s3, [`${PREFIX}/assets/app.js`]);
	});
});

describe('app router — an HTTP server framework (the Lambda Web Adapter shape)', () => {
	let serverDir: string;
	let port: number;
	before(async () => {
		serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-router-http-'));
		// A free port for the child server.
		const probe = http.createServer();
		await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
		const address = probe.address();
		port = typeof address === 'object' && address ? address.port : 0;
		await new Promise<void>((resolve) => probe.close(() => resolve()));
		fs.writeFileSync(
			path.join(serverDir, 'server.mjs'),
			`import http from 'node:http';
http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('set-cookie', ['one=1', 'two=2']);
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }));
    // One request per test run: exit, so the test process can end.
    setTimeout(() => process.exit(0), 50);
  });
}).listen(Number(process.env.PORT), '127.0.0.1');
`,
		);
	});
	after(() => fs.rmSync(serverDir, { recursive: true, force: true }));

	it('starts the server on its port and forwards server routes to it over HTTP', async () => {
		const { handler } = load(
			{ ...ssr(), server: { kind: 'http', port, start: 'server.mjs', readyTimeoutMs: 5000 } },
			{ dir: serverDir },
		);
		const res = await handler(
			albEvent('/page', {
				method: 'POST',
				query: 'a=1',
				body: 'hello',
				cookies: ['sid=x'],
				headers: { 'x-forwarded-host': 'evil.example', 'x-blocks-origin-verify': 'secret' },
			}),
		);
		assert.equal(res.statusCode, 200);
		const seen = JSON.parse(bodyOf(res));
		assert.equal(seen.method, 'POST');
		assert.equal(seen.url, '/page?a=1');
		assert.equal(seen.body, 'hello');
		assert.equal(seen.headers.cookie, 'sid=x');
		assert.equal(seen.headers['x-forwarded-host'], 'app.example.com');
		assert.equal(seen.headers['x-blocks-origin-verify'], undefined);
		assert.deepEqual(res.multiValueHeaders?.['set-cookie'], ['one=1', 'two=2']);
	});
});
