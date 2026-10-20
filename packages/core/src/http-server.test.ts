// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as http from 'node:http';
import * as net from 'node:net';
import { serveHttp, buildRequestUrl } from './http-server.js';
import type { HttpServerHandle, ServeHttpOptions } from './http-server.js';
import { FORWARDED_HOST_HEADER, FORWARDED_STAGE_HEADER } from './constants.js';
import { createLambdaHandler, _resetCorsPatterns, requestCookies } from './lambda-handler.js';
import { registerRoute, clearRouteRegistry } from './raw-route.js';
import { MAX_RPC_BODY_BYTES, decodeRpcResponse } from './rpc.js';
import type { BlocksContext } from './api.js';

const API_HOST = 'abc123.execute-api.us-west-2.amazonaws.com';
const ALLOWED_ORIGIN = 'https://app.example.com';

// ── Test plumbing ───────────────────────────────────────────────────────────

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function send(
  port: number,
  method: string,
  target: string,
  headers: Record<string, string> = {},
  body?: string | Buffer,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** One raw HTTP/1.1 exchange; resolves with the status line. */
function rawRequest(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.on('data', (d) => {
      data += d;
    });
    socket.on('close', () => resolve(data.split('\r\n')[0]));
    socket.on('error', reject);
    socket.write(text);
  });
}

/** Poll until `predicate` holds; fail (instead of hanging) after `timeoutMs`. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Headers Node adds on the wire that an API Gateway proxy result never carries. */
const TRANSPORT_HEADERS = new Set(['date', 'connection', 'keep-alive', 'content-length', 'transfer-encoding']);

function normalize(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const name = k.toLowerCase();
    if (TRANSPORT_HEADERS.has(name) || name === 'set-cookie' || v === undefined) continue;
    out[name] = String(v);
  }
  return out;
}

/**
 * The API Gateway REST event for a raw request target: `path` is the target's
 * path verbatim (API Gateway does not resolve it) and the query arrives parsed.
 */
function lambdaEvent(method: string, target: string, headers: Record<string, string>, body?: string) {
  const queryAt = target.indexOf('?');
  const path = queryAt === -1 ? target : target.slice(0, queryAt);
  const multi: Record<string, string[]> = {};
  if (queryAt !== -1) {
    for (const [k, v] of new URLSearchParams(target.slice(queryAt))) multi[k] = [...(multi[k] ?? []), v];
  }
  const hasQuery = Object.keys(multi).length > 0;
  const single = Object.fromEntries(Object.entries(multi).map(([k, v]) => [k, v[v.length - 1]]));
  return {
    httpMethod: method,
    path,
    headers: { Host: API_HOST, ...headers },
    queryStringParameters: hasQuery ? single : null,
    multiValueQueryStringParameters: hasQuery ? multi : null,
    body: body ?? null,
    isBase64Encoded: false,
    requestContext: { stage: 'prod' },
  };
}

// ── Backend under test ──────────────────────────────────────────────────────

const backend = {
  api: (ctx: BlocksContext) => ({
    async echo(msg: string) {
      return { msg, url: ctx.request.url.href, cookie: requestCookies.getStore() };
    },
    async login() {
      ctx.response.headers.append('Set-Cookie', 'a=1; Path=/');
      ctx.response.headers.append('Set-Cookie', 'b=2; Path=/');
      return { ok: true };
    },
    async fail() {
      throw new Error('boom: internal detail');
    },
    async signOutAndFail() {
      ctx.response.headers.append('Set-Cookie', 'live=1; Path=/');
      ctx.response.headers.append('Set-Cookie', 'gone=; Path=/; Max-Age=0');
      throw new Error('signed out');
    },
  }),
};

let slowRelease: (() => void) | undefined;
let lastAbort: { aborted: boolean } | undefined;

function registerRoutes() {
  registerRoute({
    method: 'GET',
    path: '/users/{id}',
    handler: async (ctx) => {
      ctx.response.status = 201;
      ctx.response.headers.append('Set-Cookie', 'r1=1; Path=/');
      ctx.response.headers.append('Set-Cookie', 'r2=2; Path=/');
      ctx.response.send({ id: ctx.request.params.id, q: ctx.request.url.searchParams.getAll('q'), cookie: requestCookies.getStore() });
    },
  });
  registerRoute({
    method: 'GET',
    path: '/text',
    handler: async (ctx) => {
      ctx.response.headers.set('Content-Type', 'text/plain; charset=utf-8');
      ctx.response.send('plain text');
    },
  });
  registerRoute({
    method: 'GET',
    path: '/boom',
    handler: async () => {
      throw new Error('raw boom: internal detail');
    },
  });
  registerRoute({
    method: 'POST',
    path: '/echo-body',
    handler: async (ctx) => {
      ctx.response.send({ text: await ctx.request.text() });
    },
  });
  registerRoute({
    method: 'POST',
    path: '/bytes',
    handler: async (ctx) => {
      const bytes = ctx.request.body ? new Uint8Array(await new Response(ctx.request.body).arrayBuffer()) : new Uint8Array();
      ctx.response.send({ bytes: [...bytes] });
    },
  });
  registerRoute({
    method: 'GET',
    path: '/url',
    handler: async (ctx) => {
      ctx.response.send({ url: ctx.request.url.href });
    },
  });
  registerRoute({
    method: 'GET',
    path: '/slow',
    handler: async (ctx) => {
      await new Promise<void>((resolve) => {
        slowRelease = resolve;
      });
      ctx.response.send({ done: true });
    },
  });
  registerRoute({
    method: 'GET',
    path: '/wait-for-abort',
    handler: async (ctx) => {
      const seen = { aborted: false };
      lastAbort = seen;
      await new Promise<void>((resolve) => {
        ctx.request.signal?.addEventListener('abort', () => {
          seen.aborted = true;
          resolve();
        });
      });
      ctx.response.send('');
    },
  });
}

async function start(options: ServeHttpOptions = {}): Promise<HttpServerHandle> {
  return serveHttp(backend, { port: 0, healthPort: 0, ...options });
}

let savedCors: string | undefined;
beforeEach(() => {
  savedCors = process.env.CORS_ALLOWED_ORIGINS;
  process.env.CORS_ALLOWED_ORIGINS = 'https://app\\.example\\.com';
  _resetCorsPatterns();
  clearRouteRegistry();
  registerRoutes();
  slowRelease = undefined;
  lastAbort = undefined;
});
afterEach(() => {
  if (savedCors === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
  else process.env.CORS_ALLOWED_ORIGINS = savedCors;
  _resetCorsPatterns();
  clearRouteRegistry();
});

// ── Parity with the Lambda handler ──────────────────────────────────────────

const rpc = (method: string, params: unknown[] = []) => JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 });
const json = { 'Content-Type': 'application/json' };

const PARITY: Array<{ name: string; method: string; target: string; headers?: Record<string, string>; body?: string }> = [
  {
    name: 'RPC call with an allowed origin and a cookie',
    method: 'POST',
    target: '/aws-blocks/api/api',
    headers: { ...json, origin: ALLOWED_ORIGIN, cookie: 'sid=abc' },
    body: rpc('api.echo', ['hi']),
  },
  { name: 'RPC error envelope', method: 'POST', target: '/aws-blocks/api', headers: json, body: rpc('api.fail') },
  { name: 'RPC unknown method', method: 'POST', target: '/aws-blocks/api', headers: json, body: rpc('api.nope') },
  { name: 'RPC invalid JSON', method: 'POST', target: '/aws-blocks/api', headers: json, body: '{nope' },
  { name: 'RPC path/body namespace mismatch', method: 'POST', target: '/aws-blocks/api/other', headers: json, body: rpc('api.echo', ['x']) },
  { name: 'preflight from an allowed origin', method: 'OPTIONS', target: '/aws-blocks/api', headers: { origin: ALLOWED_ORIGIN } },
  { name: 'cross-origin rejection', method: 'POST', target: '/aws-blocks/api', headers: { ...json, origin: 'https://evil.example' }, body: rpc('api.echo', ['x']) },
  { name: 'RawRoute with params, repeated query and cookies', method: 'GET', target: '/users/42?q=a&q=b', headers: { origin: ALLOWED_ORIGIN, cookie: 'sid=abc' } },
  { name: 'RawRoute text body', method: 'GET', target: '/text' },
  { name: 'RawRoute that throws', method: 'GET', target: '/boom' },
  { name: 'RawRoute POST body', method: 'POST', target: '/echo-body', headers: json, body: '{"x":1}' },
  { name: 'RawRoute request URL', method: 'GET', target: '/url?a=1' },
  { name: 'RawRoute request URL with an encoded and a valueless query', method: 'GET', target: '/url?q=a%20b&flag' },
  { name: 'RawRoute request URL behind a loopback forwarded host', method: 'GET', target: '/url', headers: { 'x-forwarded-host': 'localhost:3000' } },
  { name: 'repeated slashes collapse for routing', method: 'GET', target: '//users/42' },
  { name: 'a //host prefix is a path, not a host', method: 'GET', target: '//evil.example/users/42' },
  { name: 'percent-encoded dot segments are not resolved', method: 'GET', target: '/aws-blocks/%2e%2e/users/42' },
  { name: 'dot segments are not resolved', method: 'GET', target: '/x/../users/42' },
  { name: 'unknown path', method: 'GET', target: '/missing' },
];

describe('serveHttp — parity with the Lambda handler', () => {
  let server: HttpServerHandle;
  let lambda: (event: any) => Promise<any>;
  before(async () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://app\\.example\\.com';
    _resetCorsPatterns();
    clearRouteRegistry();
    registerRoutes();
    server = await start({ trustForwardedHeaders: true });
    lambda = createLambdaHandler(async () => backend);
  });
  after(async () => {
    await server.close();
  });
  // The suite-level registry must survive the per-test reset above.
  beforeEach(() => {
    clearRouteRegistry();
    registerRoutes();
  });

  for (const c of PARITY) {
    it(c.name, async () => {
      const headers = c.headers ?? {};
      const viaLambda = await lambda(lambdaEvent(c.method, c.target, headers, c.body));
      const viaHttp = await send(
        server.port,
        c.method,
        c.target,
        // What the shared gateway stamps on a VPC-link request.
        { ...headers, [FORWARDED_HOST_HEADER]: API_HOST, [FORWARDED_STAGE_HEADER]: 'prod' },
        c.body,
      );

      assert.strictEqual(viaHttp.status, viaLambda.statusCode);
      assert.strictEqual(viaHttp.body, viaLambda.body);
      assert.deepStrictEqual(normalize(viaHttp.headers), normalize(viaLambda.headers));
      const lambdaCookies = viaLambda.multiValueHeaders?.['Set-Cookie'] ?? [];
      assert.deepStrictEqual(viaHttp.headers['set-cookie'] ?? [], lambdaCookies);
    });
  }

  it('sends every Set-Cookie an RPC method sets, as the Lambda envelope does', async () => {
    const viaLambda = await lambda(lambdaEvent('POST', '/aws-blocks/api', json, rpc('api.login')));
    const viaHttp = await send(server.port, 'POST', '/aws-blocks/api', json, rpc('api.login'));
    assert.deepStrictEqual(viaLambda.multiValueHeaders?.['Set-Cookie'], ['a=1; Path=/', 'b=2; Path=/']);
    assert.deepStrictEqual(viaHttp.headers['set-cookie'], ['a=1; Path=/', 'b=2; Path=/']);
    assert.strictEqual(viaHttp.body, viaLambda.body);
  });

  it('delivers only the cookie deletions of an RPC method that throws, as the Lambda envelope does', async () => {
    const viaLambda = await lambda(lambdaEvent('POST', '/aws-blocks/api', json, rpc('api.signOutAndFail')));
    const viaHttp = await send(server.port, 'POST', '/aws-blocks/api', json, rpc('api.signOutAndFail'));
    assert.deepStrictEqual(viaLambda.multiValueHeaders?.['Set-Cookie'], ['gone=; Path=/; Max-Age=0']);
    assert.deepStrictEqual(viaHttp.headers['set-cookie'], ['gone=; Path=/; Max-Age=0']);
    assert.strictEqual(viaHttp.body, viaLambda.body);
  });
});

// ── Server behavior ─────────────────────────────────────────────────────────

describe('serveHttp — listener', { timeout: 30_000 }, () => {
  it('binds the loopback interface by default', async () => {
    const server = await start();
    try {
      assert.strictEqual(server.address, '127.0.0.1');
    } finally {
      await server.close();
    }
  });

  it('serves readiness on its own port and reports not-ready while draining', async () => {
    const server = await start({ drainTimeoutMs: 5_000 });
    const slow = send(server.port, 'GET', '/slow');
    let closing: Promise<void> | undefined;
    try {
      const ready = await send(server.healthPort, 'GET', '/');
      assert.strictEqual(ready.status, 200);
      assert.deepStrictEqual(JSON.parse(ready.body), { status: 'ok' });

      await waitFor(() => slowRelease !== undefined, 'the slow handler to start');
      closing = server.close();

      const draining = await send(server.healthPort, 'GET', '/');
      assert.strictEqual(draining.status, 503);
      await assert.rejects(() => send(server.port, 'GET', '/text'), /ECONNREFUSED/);

      slowRelease?.();
      assert.strictEqual((await slow).status, 200, 'an in-flight request completes during drain');
    } finally {
      slowRelease?.();
      await slow.catch(() => {});
      await (closing ?? server.close());
    }
  });

  it('resolves every close() call once the drain finishes', async () => {
    const server = await start({ drainTimeoutMs: 5_000 });
    const slow = send(server.port, 'GET', '/slow');
    try {
      await waitFor(() => slowRelease !== undefined, 'the slow handler to start');
      const first = server.close();
      const second = server.close();
      assert.strictEqual(first, second, 'close() is memoized');
      slowRelease?.();
      await Promise.all([first, second]);
    } finally {
      slowRelease?.();
      await slow.catch(() => {});
    }
  });

  it('does not reserve a route path for readiness', async () => {
    const server = await start();
    try {
      assert.strictEqual((await send(server.port, 'GET', '/aws-blocks/health')).status, 404);
    } finally {
      await server.close();
    }
  });

  it('stops waiting for in-flight requests after drainTimeoutMs', async () => {
    const server = await start({ drainTimeoutMs: 50 });
    const slow = send(server.port, 'GET', '/slow').catch((e: Error) => e);
    try {
      await waitFor(() => slowRelease !== undefined, 'the slow handler to start');
      await server.close();
      assert.ok((await slow) instanceof Error, 'the stuck connection is closed');
    } finally {
      slowRelease?.();
    }
  });

  it('rejects a body whose declared length exceeds the limit with 413', async () => {
    const server = await start({ maxBodyBytes: 16 });
    try {
      const reply = await send(server.port, 'POST', '/echo-body', { 'Content-Type': 'application/json' }, 'x'.repeat(17));
      assert.strictEqual(reply.status, 413);
      assert.deepStrictEqual(JSON.parse(reply.body), { error: 'Payload Too Large' });
      assert.strictEqual(reply.headers.vary, 'Origin', 'CORS headers ride on the 413');
    } finally {
      await server.close();
    }
  });

  it('rejects a chunked body that grows past the limit with 413', async () => {
    const server = await start({ maxBodyBytes: 16 });
    try {
      const reply = await new Promise<Reply>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: server.port, method: 'POST', path: '/echo-body', agent: false },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
          },
        );
        req.on('error', reject);
        req.write('x'.repeat(10));
        req.write('x'.repeat(10));
        req.end();
      });
      assert.strictEqual(reply.status, 413);
    } finally {
      await server.close();
    }
  });

  it('delivers the 413 for a multi-MiB body instead of resetting the connection', async () => {
    const server = await start({ maxBodyBytes: 16 });
    try {
      const reply = await send(server.port, 'POST', '/echo-body', {}, Buffer.alloc(4 * 1024 * 1024, 'x'));
      assert.strictEqual(reply.status, 413);
    } finally {
      await server.close();
    }
  });

  it('answers an oversized RPC body with the JSON-RPC 413 envelope', async () => {
    const server = await start();
    try {
      const reply = await send(server.port, 'POST', '/aws-blocks/api', { 'Content-Length': String(MAX_RPC_BODY_BYTES + 1) }, '');
      assert.strictEqual(reply.status, 200);
      assert.throws(
        () => decodeRpcResponse(JSON.parse(reply.body)),
        (e: any) => e.status === 413 && e.name === 'PayloadTooLarge',
      );
    } finally {
      await server.close();
    }
  });

  it('defaults the body limit to the JSON-RPC limit', async () => {
    const server = await start();
    try {
      const reply = await send(server.port, 'POST', '/echo-body', { 'Content-Length': String(MAX_RPC_BODY_BYTES + 1) }, '');
      assert.strictEqual(reply.status, 413);
    } finally {
      await server.close();
    }
  });

  it('hands RawRoutes the raw body bytes', async () => {
    const server = await start();
    try {
      const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41]);
      const reply = await send(server.port, 'POST', '/bytes', { 'Content-Type': 'application/octet-stream' }, bytes);
      assert.deepStrictEqual(JSON.parse(reply.body), { bytes: [...bytes] });
    } finally {
      await server.close();
    }
  });

  it('aborts the request signal when the client disconnects', async () => {
    const server = await start();
    const req = http.request({ host: '127.0.0.1', port: server.port, method: 'GET', path: '/wait-for-abort', agent: false });
    try {
      req.on('error', () => {});
      req.end();
      await waitFor(() => lastAbort !== undefined, 'the handler to start');
      req.destroy();
      await waitFor(() => lastAbort?.aborted === true, 'the abort signal');
    } finally {
      req.destroy();
      await server.close();
    }
  });
});

describe('serveHttp — initialization and request targets', { timeout: 30_000 }, () => {
  it('registers the built-in routes and locks the route registry', async () => {
    const server = await start();
    try {
      const resources = await send(server.port, 'GET', '/aws-blocks/resources');
      assert.strictEqual(resources.status, 200);
      assert.match(String(resources.headers['content-type']), /text\/html/);
      assert.throws(
        () => registerRoute({ method: 'GET', path: '/late', handler: async () => {} }),
        /after handler creation/,
      );
    } finally {
      await server.close();
    }
  });

  // Node's default closes an idle keep-alive connection after ~6 s (5 s + a 1 s buffer).
  it('keeps an idle keep-alive connection open past the Node default', async () => {
    const server = await start();
    const socket = net.connect(server.port, '127.0.0.1');
    try {
      let closed = false;
      socket.on('close', () => {
        closed = true;
      });
      let received = '';
      socket.on('data', (d) => {
        received += d;
      });
      const request = 'GET /text HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n';
      socket.write(request);
      await waitFor(() => received.includes('plain text'), 'the first response');
      await new Promise((r) => setTimeout(r, 7_000));
      assert.strictEqual(closed, false, 'the server must not close idle connections before the ALB does');
      received = '';
      socket.write(request);
      await waitFor(() => received.includes('plain text'), 'the second response on the same connection');
    } finally {
      socket.destroy();
      await server.close();
    }
  });

  it('fails fast on an invalid PORT', async () => {
    const saved = process.env.PORT;
    process.env.PORT = 'eighty';
    let started: HttpServerHandle | undefined;
    try {
      await assert.rejects(async () => {
        started = await serveHttp(backend, { healthPort: 0 });
      }, /PORT must be an integer/);
    } finally {
      await started?.close();
      if (saved === undefined) delete process.env.PORT;
      else process.env.PORT = saved;
    }
  });

  it('fails fast on a public origin that is not an absolute URL', async () => {
    let started: HttpServerHandle | undefined;
    try {
      await assert.rejects(async () => {
        started = await start({ publicOrigin: 'app.example.com' });
      }, /public origin must be an absolute URL/);
    } finally {
      await started?.close();
    }
  });

  it('answers a preflight even when the Host header cannot form a URL', async () => {
    const server = await start();
    try {
      const status = await rawRequest(
        server.port,
        `OPTIONS /aws-blocks/api HTTP/1.1\r\nHost: a b\r\nOrigin: ${ALLOWED_ORIGIN}\r\nConnection: close\r\n\r\n`,
      );
      assert.strictEqual(status, 'HTTP/1.1 200 OK');
    } finally {
      await server.close();
    }
  });

  it('ignores front-door headers unless trustForwardedHeaders is set', async () => {
    const server = await start({ publicOrigin: 'https://app.example.com' });
    try {
      const reply = await send(server.port, 'GET', '/url', { [FORWARDED_HOST_HEADER]: 'evil.example' });
      assert.deepStrictEqual(JSON.parse(reply.body), { url: 'https://app.example.com/url' });
    } finally {
      await server.close();
    }
  });
});

// ── Request URL ─────────────────────────────────────────────────────────────

function incoming(url: string, headers: Record<string, string>): http.IncomingMessage {
  return { url, headers } as unknown as http.IncomingMessage;
}

const stamped = (host: string, stage?: string): Record<string, string> =>
  stage === undefined ? { [FORWARDED_HOST_HEADER]: host } : { [FORWARDED_HOST_HEADER]: host, [FORWARDED_STAGE_HEADER]: stage };

describe('buildRequestUrl', () => {
  it('uses the front-door-stamped host and stage when trusted', () => {
    const url = buildRequestUrl(incoming('/aws-blocks/api/x?a=1', { host: 'alb.internal', ...stamped(API_HOST, 'prod') }), undefined, true);
    assert.strictEqual(url.href, `https://${API_HOST}/prod/aws-blocks/api/x?a=1`);
  });

  it('omits the stage when the front door stamps none (CloudFront)', () => {
    const url = buildRequestUrl(incoming('/x', stamped('d111.cloudfront.net')), undefined, true);
    assert.strictEqual(url.href, 'https://d111.cloudfront.net/x');
  });

  it('ignores a stamped stage that is not a stage name', () => {
    const url = buildRequestUrl(incoming('/x', stamped(API_HOST, '/evil.example')), undefined, true);
    assert.strictEqual(url.href, `https://${API_HOST}/x`);
  });

  it('ignores stamped headers when not trusted', () => {
    const url = buildRequestUrl(incoming('/x', { host: 'alb.internal', ...stamped('evil.example', 'prod') }), 'https://app.example.com');
    assert.strictEqual(url.href, 'https://app.example.com/x');
  });

  it('prefers a loopback X-Forwarded-Host (sandbox dev server), without the stage', () => {
    const url = buildRequestUrl(incoming('/x', { 'x-forwarded-host': 'localhost:3000', ...stamped(API_HOST, 'prod') }), undefined, true);
    assert.strictEqual(url.href, 'http://localhost:3000/x');
  });

  it('ignores a non-loopback X-Forwarded-Host', () => {
    const url = buildRequestUrl(incoming('/x', { 'x-forwarded-host': 'evil.example', ...stamped(API_HOST) }), undefined, true);
    assert.strictEqual(url.href, `https://${API_HOST}/x`);
  });

  it('falls back to the configured public origin', () => {
    const url = buildRequestUrl(incoming('/x?y=2', { host: 'alb.internal' }), 'https://app.example.com');
    assert.strictEqual(url.href, 'https://app.example.com/x?y=2');
  });

  it('never takes the host from a //- or /\\-prefixed target', () => {
    const origin = 'https://app.example.com';
    for (const target of ['//evil.example/x?y=1', '/\\evil.example/x?y=1']) {
      assert.strictEqual(new URL(buildRequestUrl(incoming(target, { host: 'alb.internal' }), origin).href).host, 'app.example.com', target);
      assert.strictEqual(new URL(buildRequestUrl(incoming(target, { 'x-forwarded-host': 'localhost:3000' })).href).host, 'localhost:3000', target);
      assert.strictEqual(new URL(buildRequestUrl(incoming(target, stamped(API_HOST)), undefined, true).href).host, API_HOST, target);
      assert.strictEqual(new URL(buildRequestUrl(incoming(target, { host: 'localhost:8080' })).href).host, 'localhost:8080', target);
    }
  });

  it('keeps only the path and query of an absolute-form target', () => {
    const url = buildRequestUrl(incoming('http://evil.example/x?y=1', { host: 'alb.internal' }), 'https://app.example.com');
    assert.strictEqual(url.href, 'https://app.example.com/x?y=1');
  });

  it('falls back to the Host header over plain HTTP', () => {
    const url = buildRequestUrl(incoming('/x', { host: 'localhost:8080' }));
    assert.strictEqual(url.href, 'http://localhost:8080/x');
  });

  it('falls back to localhost for an empty Host header', () => {
    const url = buildRequestUrl(incoming('/x', { host: '' }));
    assert.strictEqual(url.href, 'http://localhost/x');
  });
});
