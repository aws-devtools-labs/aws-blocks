// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The ALB door's API forwarder (same-origin `/aws-blocks/*` and raw routes):
 * it relays the request to the backend and the response back in the ALB
 * multi-value shape, so several `Set-Cookie` headers survive, and applies the
 * app's header rules to a successful response, as the CloudFront door does at
 * the edge. The generated source runs against an in-memory `node:https` stub,
 * and once against a real local server to check what goes on the wire.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { generateAlbApiProxyCode } from './alb_api_proxy.js';

type Upstream = { status: number; headers: Record<string, string | string[]>; body: string | Buffer; error?: Error };
type Seen = { method?: string; path?: string; headers?: Record<string, string>; body?: string };
type AlbResponse = {
  statusCode: number;
  multiValueHeaders: Record<string, string[]>;
  body: string;
  isBase64Encoded: boolean;
};

const load = (code: string, upstream: Upstream, seen: Seen) => {
  const https = {
    request(opts: { method: string; path: string; headers: Record<string, string> }, cb: (res: unknown) => void) {
      seen.method = opts.method;
      seen.path = opts.path;
      seen.headers = opts.headers;
      const chunks: Buffer[] = [];
      const req = new EventEmitter() as EventEmitter & { write: (b: Buffer) => void; end: (b?: Buffer) => void };
      req.write = (b) => chunks.push(Buffer.from(b));
      req.end = (b) => {
        if (b) chunks.push(Buffer.from(b));
        seen.body = Buffer.concat(chunks).toString('utf8');
        if (upstream.error) {
          req.emit('error', upstream.error);
          return;
        }
        const res = new EventEmitter() as EventEmitter & Record<string, unknown>;
        res.statusCode = upstream.status;
        res.statusMessage = 'OK';
        res.headers = upstream.headers;
        cb(res);
        res.emit('data', Buffer.from(upstream.body));
        res.emit('end');
      };
      return req;
    },
  };
  const mod: { exports: { handler?: (e: unknown) => Promise<AlbResponse> } } = { exports: {} };
  const fakeRequire = (id: string) => {
    if (id === 'node:https') return https;
    throw new Error(`unexpected require: ${id}`);
  };
  const env = { env: { API_GW_BASE: 'https://abc.execute-api.us-west-2.amazonaws.com/prod' } };
  new Function('require', 'exports', 'module', 'process', code)(fakeRequire, mod.exports, mod, env);
  if (!mod.exports.handler) throw new Error('no handler');
  return mod.exports.handler;
};

const event = (
  path: string,
  over: {
    query?: Record<string, string[]>;
    headers?: Record<string, string[]>;
  } = {},
) => ({
  requestContext: { elb: { targetGroupArn: 'arn:aws:elasticloadbalancing:us-west-2:111111111111:targetgroup/x/y' } },
  httpMethod: 'POST',
  path,
  multiValueQueryStringParameters: over.query ?? { a: ['1'] },
  multiValueHeaders: over.headers ?? {
    'content-type': ['application/json'],
    host: ['alb.example.com'],
    cookie: ['s=1'],
  },
  body: Buffer.from('{"x":1}').toString('base64'),
  isBase64Encoded: true,
});

/** The body the ALB returns to the viewer, decoded from either encoding. */
const bodyOf = (res: AlbResponse): string =>
  res.isBase64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;

const HEADER_RULES: Array<{ pattern: string; headers: Record<string, string> }> = [
  { pattern: '/aws-blocks/*', headers: { 'X-Api-Rule': 'api' } },
  { pattern: '/hooks/*', headers: { 'X-Hook-Rule': 'hook' } },
];

describe('ALB API forwarder', () => {
  it('relays method, path, query and body to the backend stage, and every Set-Cookie back', async () => {
    const seen: Seen = {};
    const handler = load(
      generateAlbApiProxyCode(),
      { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] }, body: '{"ok":true}' },
      seen,
    );
    const res = await handler(event('/aws-blocks/api'));
    assert.equal(seen.method, 'POST');
    assert.equal(seen.path, '/prod/aws-blocks/api?a=1');
    assert.equal(seen.body, '{"x":1}');
    assert.equal(seen.headers?.host, 'abc.execute-api.us-west-2.amazonaws.com');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.multiValueHeaders['set-cookie'], ['a=1', 'b=2']);
  });

  it("sends the relayed body's own Content-Length (never a chunked body), whatever the client sent", async () => {
    const seen: Seen = {};
    const handler = load(generateAlbApiProxyCode(), { status: 200, headers: {}, body: '{}' }, seen);
    // The client's length is for the base64 body the ALB delivered, not the 7 bytes relayed.
    await handler(event('/aws-blocks/api', { headers: { 'content-type': ['application/json'], 'content-length': ['12'] } }));
    assert.equal(seen.headers?.['content-length'], '7');
    assert.equal(seen.headers?.['transfer-encoding'], undefined);

    // A GET with no body sends no length.
    const get: Seen = {};
    const noBody = load(generateAlbApiProxyCode(), { status: 200, headers: {}, body: '{}' }, get);
    await noBody({ ...event('/aws-blocks/api'), httpMethod: 'GET', body: null });
    assert.equal(get.headers?.['content-length'], undefined);
  });

  it('puts a POST body on the wire with Content-Length and no Transfer-Encoding (real socket)', async () => {
    const got: { headers?: http.IncomingHttpHeaders; body?: string } = {};
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        got.headers = req.headers;
        got.body = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      // The generated code's `https.request`, pointed at the local plain-HTTP server.
      const https = {
        request: (opts: http.RequestOptions, cb: (res: http.IncomingMessage) => void) =>
          http.request({ ...opts, hostname: '127.0.0.1', port }, cb),
      };
      const mod: { exports: { handler?: (e: unknown) => Promise<AlbResponse> } } = { exports: {} };
      const env = { env: { API_GW_BASE: 'https://abc.execute-api.us-west-2.amazonaws.com/prod' } };
      new Function('require', 'exports', 'module', 'process', generateAlbApiProxyCode())(
        () => https,
        mod.exports,
        mod,
        env,
      );
      const res = await mod.exports.handler?.(event('/aws-blocks/api'));
      assert.equal(res?.statusCode, 200);
      assert.equal(got.body, '{"x":1}');
      assert.equal(got.headers?.['content-length'], '7');
      assert.equal(got.headers?.['transfer-encoding'], undefined);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("applies the app's matching header rules to a successful response", async () => {
    const handler = load(
      generateAlbApiProxyCode({ headers: HEADER_RULES }),
      { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' },
      {},
    );
    const api = await handler(event('/aws-blocks/api'));
    assert.deepEqual(api.multiValueHeaders['x-api-rule'], ['api']);
    assert.equal(api.multiValueHeaders['x-hook-rule'], undefined);
    const hook = await handler(event('/hooks/door-probe'));
    assert.deepEqual(hook.multiValueHeaders['x-hook-rule'], ['hook']);
  });

  it('leaves an error response as the backend sent it (as at the edge)', async () => {
    const handler = load(
      generateAlbApiProxyCode({ headers: HEADER_RULES }),
      { status: 401, headers: { 'content-type': 'application/json' }, body: '{"error":"unauthorized"}' },
      {},
    );
    const res = await handler(event('/aws-blocks/api'));
    assert.equal(res.statusCode, 401);
    assert.equal(res.multiValueHeaders['x-api-rule'], undefined);
  });

  it('forwards query values exactly as the ALB delivered them (still percent-encoded), never encoding them twice', async () => {
    const seen: Seen = {};
    const handler = load(generateAlbApiProxyCode(), { status: 200, headers: {}, body: '{}' }, seen);
    await handler(
      event('/aws-blocks/auth/callback', {
        query: { q: ['a%20b'], state: ['eyJ4IjoxfQ%3D%3D'], next: ['%2Fhome'], plus: ['a+b'], 'a%5Bb%5D': ['1', '2'] },
      }),
    );
    assert.equal(
      seen.path,
      '/prod/aws-blocks/auth/callback?q=a%20b&state=eyJ4IjoxfQ%3D%3D&next=%2Fhome&plus=a+b&a%5Bb%5D=1&a%5Bb%5D=2',
    );
  });

  it("joins several Cookie header fields with '; ' (the cookie separator), other headers with ', '", async () => {
    const seen: Seen = {};
    const handler = load(generateAlbApiProxyCode(), { status: 200, headers: {}, body: '{}' }, seen);
    await handler(
      event('/aws-blocks/api', {
        headers: { cookie: ['seen=1', 'session=abc'], accept: ['text/html', 'application/json'] },
      }),
    );
    assert.equal(seen.headers?.cookie, 'seen=1; session=abc');
    assert.equal(seen.headers?.accept, 'text/html, application/json');
  });

  it('strips the origin-verify secret and client forwarding headers, and keeps the client chain and trace id', async () => {
    const seen: Seen = {};
    const handler = load(generateAlbApiProxyCode(), { status: 200, headers: {}, body: '{}' }, seen);
    await handler(
      event('/aws-blocks/api', {
        headers: {
          'X-Blocks-Origin-Verify': ['secret'],
          'x-forwarded-host': ['localhost:3000'],
          'x-forwarded-port': ['80'],
          'x-forwarded-proto': ['http'],
          'x-forwarded-for': ['203.0.113.7, 198.51.100.2'],
          'x-amzn-trace-id': ['Root=1-abc'],
          connection: ['keep-alive'],
          'content-type': ['application/json'],
        },
      }),
    );
    const sent = Object.fromEntries(Object.entries(seen.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    assert.equal(sent['x-blocks-origin-verify'], undefined);
    assert.equal(sent['x-forwarded-host'], undefined);
    assert.equal(sent['x-forwarded-port'], undefined);
    assert.equal(sent['x-forwarded-proto'], undefined);
    assert.equal(sent.connection, undefined);
    assert.equal(sent['x-forwarded-for'], '203.0.113.7, 198.51.100.2');
    assert.equal(sent['x-amzn-trace-id'], 'Root=1-abc');
    assert.equal(sent['content-type'], 'application/json');
  });

  it('drops hop-by-hop response headers', async () => {
    const handler = load(
      generateAlbApiProxyCode(),
      {
        status: 200,
        headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked', connection: 'close', 'keep-alive': 'x' },
        body: '{}',
      },
      {},
    );
    const res = await handler(event('/aws-blocks/api'));
    assert.equal(res.multiValueHeaders['transfer-encoding'], undefined);
    assert.equal(res.multiValueHeaders.connection, undefined);
    assert.equal(res.multiValueHeaders['keep-alive'], undefined);
    assert.deepEqual(res.multiValueHeaders['content-type'], ['application/json']);
  });

  it('answers a fixed 502 when the backend is unreachable, without echoing the upstream error', async () => {
    const handler = load(
      generateAlbApiProxyCode(),
      {
        status: 0,
        headers: {},
        body: '',
        error: new Error('getaddrinfo ENOTFOUND abc.execute-api.us-west-2.amazonaws.com'),
      },
      {},
    );
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const res = await handler(event('/aws-blocks/api'));
      assert.equal(res.statusCode, 502);
      assert.equal(bodyOf(res), '{"error":"Bad Gateway"}');
      assert.ok(!bodyOf(res).includes('execute-api'));
      assert.equal(errors.length, 1, 'the upstream error is logged for the operator');
    } finally {
      console.error = original;
    }
  });

  it('returns a text response as UTF-8 (no base64 inflation against the 1 MB ALB cap) and a binary one as base64', async () => {
    const json = '{"name":"caf\u00e9"}';
    const text = load(
      generateAlbApiProxyCode(),
      { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: json },
      {},
    );
    const t = await text(event('/aws-blocks/api'));
    assert.equal(t.isBase64Encoded, false);
    assert.equal(t.body, json);

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]);
    const binary = load(generateAlbApiProxyCode(), { status: 200, headers: { 'content-type': 'image/png' }, body: png }, {});
    const b = await binary(event('/aws-blocks/files/x.png'));
    assert.equal(b.isBase64Encoded, true);
    assert.deepEqual(Buffer.from(b.body, 'base64'), png);

    // A text type whose bytes are not valid UTF-8 stays base64 so nothing is lost.
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
    const odd = load(generateAlbApiProxyCode(), { status: 200, headers: { 'content-type': 'text/plain' }, body: latin1 }, {});
    const o = await odd(event('/aws-blocks/api'));
    assert.equal(o.isBase64Encoded, true);
    assert.deepEqual(Buffer.from(o.body, 'base64'), latin1);
  });
});
