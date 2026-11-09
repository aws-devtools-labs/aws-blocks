// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A native Lambda handler server (Nitro's `aws-lambda` preset) behind the ALB
 * door, at handler level, with a real ALB Lambda-target event.
 *
 * An ALB invokes a Lambda target with its own event shape: the method is
 * `event.httpMethod` (top level, not under `requestContext`), and with
 * multi-value headers on (the server target group enables them, so several
 * `Set-Cookie` headers survive) the headers and query arrive as
 * `multiValueHeaders` / `multiValueQueryStringParameters` and the response
 * must be `multiValueHeaders` too.
 *
 * Two Nitro handler shapes run here, each written to a temp bundle as
 * `index.mjs`, patched by `patchNitroHandlerForApiGateway`, and wrapped by the
 * ALB event shim the hosting construct adds for this door:
 *   - the nitropack 2.13.4 `aws-lambda` runtime (its handler body, verbatim,
 *     with the Nitro app replaced by an echo stub);
 *   - the older shape the patch targets (`event.rawPath`,
 *     `event.requestContext?.http?.method` only).
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { patchNitroHandlerForApiGateway } from '../adapters/nitro.js';
import type { DeployManifest } from '../manifest/types.js';
import { ALB_EVENT_SHIM_FILE, ALB_EVENT_SHIM_HANDLER, generateAlbEventShimCode } from './alb_lambda_event.js';
import { HostingConstruct, type HostingConstructProps } from './hosting_construct.js';

/** The Nitro app stub: echoes what Nitro parsed and sets two cookies. */
const NITRO_APP_STUB = `
const nitroApp = {
  async localCall(req) {
    const body = req.body == null ? '' : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
    return {
      status: 201,
      headers: {
        'content-type': 'application/json',
        'set-cookie': ['session=abc; Path=/; HttpOnly', 'theme=dark; Path=/'],
      },
      body: JSON.stringify({ method: req.method, url: req.url, body, cookie: req.headers.cookie || null, ua: req.headers['user-agent'] || null }),
    };
  },
};
const withQuery = (p, q) => { const s = new URLSearchParams(); for (const k in q) { const v = q[k]; for (const x of [].concat(v)) s.append(k, x); } const t = s.toString(); return t ? p + '?' + t : p; };
const normalizeLambdaIncomingHeaders = (h) => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), v]));
const normalizeCookieHeader = (h) => [].concat(h || []);
const normalizeLambdaOutgoingHeaders = (h, strip) => Object.fromEntries(Object.entries(h).filter(([k]) => !(strip && k === 'set-cookie')).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)]));
const normalizeLambdaOutgoingBody = async (body) => ({ type: 'text', body });
`;

/** nitropack 2.13.4 `presets/aws-lambda/runtime/aws-lambda.mjs`, handler body verbatim. */
const NITRO_2_13_HANDLER = `${NITRO_APP_STUB}
export async function handler(event, context) {
  const query = {
    ...event.queryStringParameters,
    ...event.multiValueQueryStringParameters
  };
  const url = withQuery(
    event.path || event.rawPath,
    query
  );
  const method = event.httpMethod || event.requestContext?.http?.method || "get";
  if ("cookies" in event && event.cookies) {
    event.headers.cookie = event.cookies.join(";");
  }
  const r = await nitroApp.localCall({
    event,
    url,
    context,
    headers: normalizeLambdaIncomingHeaders(event.headers),
    method,
    query,
    body: event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body
  });
  const isApiGwV2 = "cookies" in event || "rawPath" in event;
  const awsBody = await normalizeLambdaOutgoingBody(r.body, r.headers);
  const cookies = normalizeCookieHeader(r.headers["set-cookie"]);
  return {
    ...cookies.length > 0 && {
      ...isApiGwV2 ? { cookies } : { multiValueHeaders: { "set-cookie": cookies } }
    },
    statusCode: r.status,
    headers: normalizeLambdaOutgoingHeaders(r.headers, true),
    body: awsBody.body,
    isBase64Encoded: awsBody.type === "binary"
  };
}
`;

/** The older handler shape the patch targets: payload 2.0 fields only. */
const NITRO_V2_ONLY_HANDLER = `${NITRO_APP_STUB}
export async function handler(event, context) {
  const query = { ...event.queryStringParameters, ...event.multiValueQueryStringParameters };
  const url = withQuery(event.rawPath, query);
  const method = event.requestContext?.http?.method || "get";
  const r = await nitroApp.localCall({
    event, url, context,
    headers: normalizeLambdaIncomingHeaders(event.headers),
    method, query,
    body: event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body
  });
  const cookies = normalizeCookieHeader(r.headers["set-cookie"]);
  return {
    ...cookies.length > 0 && { multiValueHeaders: { "set-cookie": cookies } },
    statusCode: r.status,
    headers: normalizeLambdaOutgoingHeaders(r.headers, true),
    body: r.body,
    isBase64Encoded: false
  };
}
`;

/** A real ALB Lambda-target event (multi-value headers on): POST with a base64 body. */
const albEvent = (): Record<string, unknown> => ({
  requestContext: {
    elb: {
      targetGroupArn:
        'arn:aws:elasticloadbalancing:us-west-2:111111111111:targetgroup/Hosti-Serve-ABC/0123456789abcdef',
    },
  },
  httpMethod: 'POST',
  path: '/api/echo',
  multiValueQueryStringParameters: { q: ['a%20b'], tag: ['x', 'y'] },
  multiValueHeaders: {
    accept: ['application/json'],
    'content-type': ['application/json'],
    cookie: ['seen=1', 'ab=b'],
    host: ['my-alb-123.us-west-2.elb.amazonaws.com'],
    'user-agent': ['curl/8.7.1'],
    'x-amzn-trace-id': ['Root=1-67891233-abcdef012345678912345678'],
    'x-forwarded-for': ['203.0.113.7'],
    'x-forwarded-port': ['80'],
    'x-forwarded-proto': ['http'],
  },
  body: Buffer.from('{"hello":"world"}').toString('base64'),
  isBase64Encoded: true,
});

type AlbResponse = {
  statusCode: number;
  statusDescription?: string;
  headers?: Record<string, string>;
  multiValueHeaders?: Record<string, string[]>;
  body: string;
  isBase64Encoded: boolean;
};

describe('a Nitro handler behind the ALB door (real ALB event)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alb-event-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const load = async (handlerSource: string): Promise<(e: unknown) => Promise<AlbResponse>> => {
    fs.writeFileSync(path.join(tmp, 'index.mjs'), handlerSource);
    patchNitroHandlerForApiGateway(tmp);
    fs.writeFileSync(path.join(tmp, ALB_EVENT_SHIM_FILE), generateAlbEventShimCode('./index.mjs'));
    const mod = await import(pathToFileURL(path.join(tmp, ALB_EVENT_SHIM_FILE)).href);
    return mod.handler;
  };

  for (const [label, source] of [
    ['nitropack 2.13.4 runtime', NITRO_2_13_HANDLER],
    ['older payload-2.0-only runtime (patched)', NITRO_V2_ONLY_HANDLER],
  ] as const) {
    describe(label, () => {
      it('sees the POST method, the request path and query, and the decoded base64 body', async () => {
        const handler = await load(source);
        const res = await handler(albEvent());
        const echo = JSON.parse(res.body);
        assert.equal(echo.method, 'POST');
        assert.match(echo.url, /^\/api\/echo\?/);
        assert.match(echo.url, /q=a\+b|q=a%20b/);
        assert.match(echo.url, /tag=x&tag=y/);
        assert.equal(echo.body, '{"hello":"world"}');
        assert.equal(echo.cookie, 'seen=1; ab=b');
        assert.equal(echo.ua, 'curl/8.7.1');
      });

      it('answers in the ALB multi-value shape: both Set-Cookie headers and the content type survive', async () => {
        const handler = await load(source);
        const res = await handler(albEvent());
        assert.equal(res.statusCode, 201);
        assert.equal(res.statusDescription, '201 Created');
        assert.equal(res.headers, undefined, 'multi-value mode answers with multiValueHeaders only');
        assert.deepEqual(res.multiValueHeaders?.['set-cookie'], [
          'session=abc; Path=/; HttpOnly',
          'theme=dark; Path=/',
        ]);
        assert.deepEqual(res.multiValueHeaders?.['content-type'], ['application/json']);
      });
    });
  }

  it('single-value ALB events are answered with single-value headers', async () => {
    const handler = await load(NITRO_2_13_HANDLER);
    const { multiValueHeaders, multiValueQueryStringParameters, ...rest } = albEvent() as Record<string, unknown> & {
      multiValueHeaders: Record<string, string[]>;
    };
    void multiValueQueryStringParameters;
    const headers = Object.fromEntries(Object.entries(multiValueHeaders).map(([k, v]) => [k, v.join('; ')]));
    const res = await handler({ ...rest, headers, queryStringParameters: { q: 'a%20b' } });
    assert.equal(JSON.parse(res.body).method, 'POST');
    assert.equal(res.multiValueHeaders, undefined);
    assert.equal(res.headers?.['content-type'], 'application/json');
  });

  it('non-ALB events reach the handler unchanged', async () => {
    const handler = await load(NITRO_2_13_HANDLER);
    const res = await handler({
      version: '2.0',
      rawPath: '/x',
      requestContext: { http: { method: 'PUT', path: '/x' } },
      headers: {},
      cookies: ['a=1'],
    });
    assert.equal(JSON.parse(res.body).method, 'PUT');
    assert.deepEqual((res as unknown as { cookies: string[] }).cookies, [
      'session=abc; Path=/; HttpOnly',
      'theme=dark; Path=/',
    ]);
  });
});

describe('HostingConstruct wires the ALB event shim for a buffered handler server behind the ALB', () => {
  let tmp: string;
  let bundle: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alb-event-hosting-'));
    fs.writeFileSync(path.join(tmp, 'index.html'), '<html></html>');
    bundle = path.join(tmp, 'server');
    fs.mkdirSync(bundle);
    fs.writeFileSync(path.join(bundle, 'index.mjs'), NITRO_2_13_HANDLER);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const manifest = (): DeployManifest => ({
    version: 1,
    buildId: 'nitro1',
    compute: { server: { type: 'handler', bundle, handler: 'index.handler', placement: 'regional', streaming: false } },
    staticAssets: { directory: tmp },
    routes: [
      { pattern: '/_nuxt/*', target: 'static' },
      { pattern: '/*', target: 'server' },
    ],
  });
  const synth = (frontDoor: HostingConstructProps['frontDoor']) => {
    const stack = new Stack(new App(), 'S', { env: { account: '111111111111', region: 'us-west-2' } });
    new HostingConstruct(stack, 'Hosting', { manifest: manifest(), frontDoor });
    return Template.fromStack(stack);
  };
  const handlers = (t: Template): string[] =>
    Object.values(t.findResources('AWS::Lambda::Function')).map((r) => String(r.Properties.Handler));

  it('ALB: the server runs the shim, and its target group has multi-value headers on', () => {
    const t = synth({ kind: 'alb' });
    assert.ok(handlers(t).includes(ALB_EVENT_SHIM_HANDLER), `handlers: ${handlers(t).join(', ')}`);
    assert.ok(fs.existsSync(path.join(bundle, ALB_EVENT_SHIM_FILE)), 'shim written into the bundle');
    const serverTg = Object.entries(t.findResources('AWS::ElasticLoadBalancingV2::TargetGroup')).find(([id]) =>
      id.includes('ServerTg'),
    );
    assert.ok(serverTg, 'a server target group');
    assert.deepEqual(
      (serverTg[1].Properties.TargetGroupAttributes as Array<{ Key: string; Value: string }>).find(
        (a) => a.Key === 'lambda.multi_value_headers.enabled',
      )?.Value,
      'true',
    );
  });

  it('CloudFront: the server keeps its own handler (no shim)', () => {
    const t = synth(undefined);
    assert.ok(!handlers(t).includes(ALB_EVENT_SHIM_HANDLER));
    assert.ok(!fs.existsSync(path.join(bundle, ALB_EVENT_SHIM_FILE)));
  });
});
