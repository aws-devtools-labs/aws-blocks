// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Conformance tests for the container HTTP server: the same dispatch
// behaviors covered by lambda-handler.test.ts, exercised through a real
// Node HTTP server and fetch — proving Lambda/container parity.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import type * as http from 'node:http';
import {
  startBlocksHttpServer,
  createNodeRequestListener,
  toLambdaEvent,
  BLOCKS_HEALTH_PATH,
} from './http-server.js';
import { createLambdaHandler, defaultHttpDeadlineCapMs } from './lambda-handler.js';
import { registerRoute, clearRouteRegistry } from './raw-route.js';
import { _resetCorsPatterns } from './cors.js';
import type { BlocksContext } from './api.js';

const servers: http.Server[] = [];

beforeEach(() => {
  clearRouteRegistry();
  delete process.env.CORS_ALLOWED_ORIGINS;
  delete process.env.BLOCKS_HTTP_TIMEOUT_MS;
  delete process.env.BLOCKS_PUBLIC_ORIGIN;
  _resetCorsPatterns();
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  delete process.env.CORS_ALLOWED_ORIGINS;
  delete process.env.BLOCKS_HTTP_TIMEOUT_MS;
  delete process.env.BLOCKS_PUBLIC_ORIGIN;
  _resetCorsPatterns();
});

/** Start a server on an ephemeral port for the given backend; returns its base URL. */
async function serve(backend: any, options: Record<string, any> = {}): Promise<string> {
  const handler = createLambdaHandler(async () => backend);
  const server = await startBlocksHttpServer(handler, {
    port: 0,
    handleSignals: false,
    ...options,
  });
  servers.push(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'server should be bound to a port');
  return `http://127.0.0.1:${address.port}`;
}

function rpcBody(method: string, params: unknown[] = [], id = 1): string {
  return JSON.stringify({ jsonrpc: '2.0', method, params, id });
}

const echoBackend = {
  api: (_ctx: BlocksContext) => ({
    async echo(msg: string) {
      return { msg };
    },
  }),
};

// ── RPC over real HTTP ──────────────────────────────────────────────────────

describe('http-server — RPC dispatch parity', () => {
  it('returns a JSON-RPC success envelope for a valid call', async () => {
    const baseUrl = await serve(echoBackend);

    const res = await fetch(`${baseUrl}/aws-blocks/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rpcBody('api.echo', ['hello']),
    });

    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.jsonrpc, '2.0');
    assert.strictEqual(body.id, 1);
    assert.deepStrictEqual(body.result, { msg: 'hello' });
  });

  it('returns a method-not-found envelope for an unknown API', async () => {
    const baseUrl = await serve(echoBackend);

    const res = await fetch(`${baseUrl}/aws-blocks/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rpcBody('nope.missing'),
    });

    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.error, 'expected a JSON-RPC error');
    assert.strictEqual(body.error.code, -32601);
  });

  it('returns an invalid-request envelope for a malformed body', async () => {
    const baseUrl = await serve(echoBackend);

    const res = await fetch(`${baseUrl}/aws-blocks/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });

    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.error, 'expected a JSON-RPC error');
  });
});

// ── RawRoutes over real HTTP ────────────────────────────────────────────────

describe('http-server — RawRoute dispatch parity', () => {
  it('dispatches path params and query string', async () => {
    let seenParams: Record<string, string> = {};
    let seenUrl: URL | undefined;
    registerRoute({
      method: 'GET',
      path: '/things/{id}',
      handler: async (ctx) => {
        seenParams = ctx.request.params;
        seenUrl = ctx.request.url;
        ctx.response.send({ ok: true });
      },
    });
    const baseUrl = await serve(echoBackend);

    const res = await fetch(`${baseUrl}/things/42?tag=a&tag=b`);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true });
    assert.strictEqual(seenParams.id, '42');
    assert.ok(seenUrl, 'route should observe ctx.request.url');
    assert.deepStrictEqual(seenUrl.searchParams.getAll('tag'), ['a', 'b']);
  });

  it('delivers every Set-Cookie header separately', async () => {
    registerRoute({
      method: 'GET',
      path: '/login',
      handler: async (ctx) => {
        ctx.response.headers.append('Set-Cookie', 'a=1; Path=/');
        ctx.response.headers.append('Set-Cookie', 'b=2; Path=/; HttpOnly');
        ctx.response.send({ ok: true });
      },
    });
    const baseUrl = await serve(echoBackend);

    const res = await fetch(`${baseUrl}/login`);

    assert.strictEqual(res.status, 200);
    const cookies = res.headers.getSetCookie();
    assert.deepStrictEqual(cookies, ['a=1; Path=/', 'b=2; Path=/; HttpOnly']);
  });

  it('round-trips the request body byte-for-byte (base64 event encoding)', async () => {
    let seenText = '';
    registerRoute({
      method: 'POST',
      path: '/ingest',
      handler: async (ctx) => {
        seenText = await ctx.request.text();
        ctx.response.send({ ok: true });
      },
    });
    const baseUrl = await serve(echoBackend);
    const payload = JSON.stringify({ emoji: '🚀', newline: 'a\nb' });

    const res = await fetch(`${baseUrl}/ingest`, { method: 'POST', body: payload });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(seenText, payload);
  });

  it('propagates error status and error name (D-003)', async () => {
    registerRoute({
      method: 'GET',
      path: '/boom',
      handler: async () => {
        const err = new Error('nope');
        err.name = 'CustomBlockError';
        throw err;
      },
    });
    const baseUrl = await serve(echoBackend);

    const res = await fetch(`${baseUrl}/boom`);

    assert.strictEqual(res.status, 500);
    const body = await res.json();
    assert.strictEqual(body.name, 'CustomBlockError');
  });

  it('returns 404 for unmatched non-RPC paths', async () => {
    const baseUrl = await serve(echoBackend);

    const res = await fetch(`${baseUrl}/definitely/not/registered`);

    assert.strictEqual(res.status, 404);
  });
});

// ── CORS over real HTTP ─────────────────────────────────────────────────────

describe('http-server — CORS parity', () => {
  it('answers OPTIONS preflight with CORS headers for an allowed origin', async () => {
    process.env.CORS_ALLOWED_ORIGINS = '^https://allowed\\.example$';
    _resetCorsPatterns();
    const baseUrl = await serve(echoBackend);

    const res = await fetch(`${baseUrl}/aws-blocks/api`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://allowed.example' },
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), 'https://allowed.example');
    assert.strictEqual(res.headers.get('access-control-allow-credentials'), 'true');
  });

  it('rejects a disallowed origin with 403', async () => {
    process.env.CORS_ALLOWED_ORIGINS = '^https://allowed\\.example$';
    _resetCorsPatterns();
    const baseUrl = await serve(echoBackend);

    const res = await fetch(`${baseUrl}/aws-blocks/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: rpcBody('api.echo', ['x']),
    });

    assert.strictEqual(res.status, 403);
  });
});

// ── Timeout guard ───────────────────────────────────────────────────────────

describe('http-server — timeout guard', () => {
  it('returns 504 with the JSON-RPC timeout envelope when the cap elapses', async () => {
    process.env.BLOCKS_HTTP_TIMEOUT_MS = '150';
    const hangingBackend = {
      api: (_ctx: BlocksContext) => ({
        async hang() {
          await new Promise(() => {}); // never resolves
        },
      }),
    };
    const baseUrl = await serve(hangingBackend);

    const res = await fetch(`${baseUrl}/aws-blocks/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rpcBody('api.hang'),
    });

    assert.strictEqual(res.status, 504);
    const body = await res.json();
    assert.ok(body.error, 'expected a JSON-RPC error envelope');
    assert.strictEqual(body.error.data?.name, 'HandlerTimeoutError');
  });

  it('defaultHttpDeadlineCapMs reads BLOCKS_HTTP_TIMEOUT_MS with a 28s fallback', () => {
    delete process.env.BLOCKS_HTTP_TIMEOUT_MS;
    assert.strictEqual(defaultHttpDeadlineCapMs(), 28_000);

    process.env.BLOCKS_HTTP_TIMEOUT_MS = '55000';
    assert.strictEqual(defaultHttpDeadlineCapMs(), 55_000);

    process.env.BLOCKS_HTTP_TIMEOUT_MS = 'garbage';
    assert.strictEqual(defaultHttpDeadlineCapMs(), 28_000);

    process.env.BLOCKS_HTTP_TIMEOUT_MS = '-5';
    assert.strictEqual(defaultHttpDeadlineCapMs(), 28_000);
  });
});

// ── Health and lifecycle ────────────────────────────────────────────────────

describe('http-server — health endpoint', () => {
  it('reports 200 on the health path once the backend is warm', async () => {
    const baseUrl = await serve(echoBackend);

    const res = await fetch(`${baseUrl}${BLOCKS_HEALTH_PATH}`);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { status: 'ok' });
  });

  it('reports 503 while not ready (listener-level readiness gate)', async () => {
    const handler = createLambdaHandler(async () => echoBackend);
    let ready = false;
    const listener = createNodeRequestListener(handler, { isReady: () => ready });

    const { createServer } = await import('node:http');
    const server = createServer(listener);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    const port = (server.address() as any).port;

    const before = await fetch(`http://127.0.0.1:${port}${BLOCKS_HEALTH_PATH}`);
    assert.strictEqual(before.status, 503);

    ready = true;
    const after = await fetch(`http://127.0.0.1:${port}${BLOCKS_HEALTH_PATH}`);
    assert.strictEqual(after.status, 200);
  });

  it('exposes the health path to load balancers even with no matching route', async () => {
    // BLOCKS_HEALTH_PATH lives under the reserved /aws-blocks namespace but is
    // served by the server itself — dispatch (which would 404) never sees it.
    const baseUrl = await serve(echoBackend);
    const res = await fetch(`${baseUrl}${BLOCKS_HEALTH_PATH}`);
    assert.strictEqual(res.status, 200);
  });
});

// ── Public origin (front-door URL correctness) ──────────────────────────────

describe('http-server — public origin', () => {
  it('builds backend-visible URLs from BLOCKS_PUBLIC_ORIGIN, not the Host header', async () => {
    let seenHref = '';
    registerRoute({
      method: 'GET',
      path: '/whoami',
      handler: async (ctx) => {
        seenHref = ctx.request.url.href;
        ctx.response.send({ ok: true });
      },
    });
    const baseUrl = await serve(echoBackend, {
      publicOrigin: 'https://d111111abcdef8.cloudfront.net',
    });

    const res = await fetch(`${baseUrl}/whoami?x=1`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(seenHref, 'https://d111111abcdef8.cloudfront.net/whoami?x=1');
  });

  it('toLambdaEvent leaves Host untouched when no public origin is set', () => {
    const event = toLambdaEvent(
      { method: 'GET', url: '/a?b=c', headers: { host: 'internal-alb.local' } } as any,
      Buffer.alloc(0),
    );
    assert.strictEqual(event.headers.host, 'internal-alb.local');
    assert.strictEqual(event.path, '/a');
    assert.strictEqual(event.rawQueryString, 'b=c');
    assert.strictEqual(event.body, null);
    assert.strictEqual(event.isBase64Encoded, false);
  });

  it('toLambdaEvent strips a stale x-forwarded-host when rewriting to the public origin', () => {
    const event = toLambdaEvent(
      {
        method: 'GET',
        url: '/a',
        headers: { host: 'alb.internal', 'x-forwarded-host': 'localhost:3000', 'x-forwarded-proto': 'http' },
      } as any,
      Buffer.alloc(0),
      'https://public.example',
    );
    assert.strictEqual(event.headers.host, 'public.example');
    assert.strictEqual(event.headers['x-forwarded-proto'], 'https');
    assert.strictEqual('x-forwarded-host' in event.headers, false);
  });
});
