// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createLambdaHandler, _resetCorsPatterns, requestCookies, isApiGatewayHttpEvent, computeHttpDeadlineMs, classifyEvent, buildEventUrl, isLoopbackForwardedHost } from './lambda-handler.js';
import type { LambdaContext } from './lambda-handler.js';
import { registerRoute, clearRouteRegistry, getRegisteredRoutes } from './raw-route.js';
import { decodeRpcResponse } from './rpc.js';
import type { BlocksContext } from './api.js';

beforeEach(() => {
  clearRouteRegistry();
});

function makeEvent(overrides: Record<string, any> = {}) {
  return {
    httpMethod: 'POST',
    path: '/aws-blocks/api',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'api.echo', params: ['hello'], id: 1 }),
    isBase64Encoded: false,
    ...overrides,
  };
}

async function invoke(backend: any, event: any): Promise<any> {
  const handler = createLambdaHandler(async () => backend);
  return handler(event) as any;
}

// ── RPC body tests ──────────────────────────────────────────────────────────

describe('createLambdaHandler — RPC body handling', () => {
  it('populates ctx.request.body as a ReadableStream for RPC calls', async () => {
    let capturedBody: ReadableStream<Uint8Array> | null = null;

    const backend = {
      api: (ctx: BlocksContext) => ({
        async echo(msg: string) {
          capturedBody = ctx.request.body;
          return { msg };
        },
      }),
    };

    const result = await invoke(backend, makeEvent());

    assert.strictEqual(result.statusCode, 200);
    assert.ok(capturedBody !== null, 'ctx.request.body should not be null');
    assert.ok((capturedBody as any) instanceof ReadableStream, 'ctx.request.body should be a ReadableStream');

    const reader = (capturedBody as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      if (value) chunks.push(value);
      done = d;
    }
    const text = new TextDecoder().decode(chunks[0]);
    const parsed = JSON.parse(text);
    assert.strictEqual(parsed.jsonrpc, '2.0');
    assert.strictEqual(parsed.method, 'api.echo');
  });

  it('ctx.request.body is null when event.body is absent', async () => {
    const backend = {
      api: (_ctx: BlocksContext) => ({
        async noop() { return {}; },
      }),
    };

    const result = await invoke(backend, makeEvent({ body: null }));
    // null body → empty JSON-RPC envelope → Invalid Request
    assert.strictEqual(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.strictEqual(body.jsonrpc, '2.0');
    assert.ok(body.error);
    assert.strictEqual(body.error.code, -32600);
  });

  it('decodes base64-encoded body', async () => {
    let capturedText = '';

    const payload = JSON.stringify({ jsonrpc: '2.0', method: 'api.getBody', params: [], id: 1 });
    const base64Body = Buffer.from(payload).toString('base64');

    const backend = {
      api: (ctx: BlocksContext) => ({
        async getBody() {
          capturedText = await ctx.request.text();
          return { received: true };
        },
      }),
    };

    const result = await invoke(backend, makeEvent({
      body: base64Body,
      isBase64Encoded: true,
    }));

    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(capturedText, payload);
  });

  it('ctx.request.json() returns parsed body for RPC calls', async () => {
    let capturedJson: any = null;

    const backend = {
      api: (ctx: BlocksContext) => ({
        async echo() {
          capturedJson = await ctx.request.json();
          return { ok: true };
        },
      }),
    };

    await invoke(backend, makeEvent());

    assert.ok(capturedJson);
    assert.strictEqual(capturedJson.jsonrpc, '2.0');
    assert.strictEqual(capturedJson.method, 'api.echo');
  });
});

// ── RawRoute body tests ─────────────────────────────────────────────────────

describe('createLambdaHandler — named params (JSON-RPC 2.0 §4.2)', () => {
  it('accepts named params as an object and converts to positional args', async () => {
    const backend = {
      api: (_ctx: BlocksContext) => ({
        async echo(msg: string) { return { msg }; },
      }),
    };

    const result = await invoke(backend, makeEvent({
      body: JSON.stringify({ jsonrpc: '2.0', method: 'api.echo', params: { msg: 'hello' }, id: 1 }),
    }));

    assert.strictEqual(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.strictEqual(body.result.msg, 'hello');
  });
});

// ── RawRoute body tests ─────────────────────────────────────────────────────

describe('createLambdaHandler — RawRoute body handling', () => {
  it('populates ctx.request.body as a ReadableStream for RawRoute POST', async () => {
    let capturedBody: ReadableStream<Uint8Array> | null = null;

    registerRoute({
      method: 'POST',
      path: '/webhooks/test',
      handler: async (ctx) => {
        capturedBody = ctx.request.body;
        ctx.response.send({ received: true });
      },
    });

    const webhookPayload = JSON.stringify({ event: 'task.updated', id: '123' });
    const result = await invoke({}, makeEvent({
      httpMethod: 'POST',
      path: '/webhooks/test',
      body: webhookPayload,
    }));

    assert.strictEqual(result.statusCode, 200);
    assert.ok(capturedBody !== null, 'ctx.request.body should not be null for RawRoute POST');
    assert.ok((capturedBody as any) instanceof ReadableStream, 'ctx.request.body should be a ReadableStream');

    const reader = (capturedBody as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value!);
    assert.strictEqual(text, webhookPayload);
  });

  it('ctx.request.body is null for RawRoute GET (no body)', async () => {
    let capturedBody: ReadableStream<Uint8Array> | null = 'NOT_SET' as any;

    registerRoute({
      method: 'GET',
      path: '/health',
      handler: async (ctx) => {
        capturedBody = ctx.request.body;
        ctx.response.send({ status: 'ok' });
      },
    });

    const result = await invoke({}, makeEvent({
      httpMethod: 'GET',
      path: '/health',
      body: null,
    }));

    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(capturedBody, null, 'ctx.request.body should be null when there is no body');
  });

  it('decodes base64-encoded body for RawRoute POST', async () => {
    let capturedText = '';

    registerRoute({
      method: 'POST',
      path: '/upload',
      handler: async (ctx) => {
        capturedText = await ctx.request.text();
        ctx.response.send({ received: true });
      },
    });

    const payload = 'binary-like-data=hello&key=value';
    const result = await invoke({}, makeEvent({
      httpMethod: 'POST',
      path: '/upload',
      body: Buffer.from(payload).toString('base64'),
      isBase64Encoded: true,
    }));

    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(capturedText, payload);
  });

  it('ctx.request.json() works for RawRoute POST with JSON body', async () => {
    let capturedJson: any = null;

    registerRoute({
      method: 'POST',
      path: '/data',
      handler: async (ctx) => {
        capturedJson = await ctx.request.json();
        ctx.response.send({ received: true });
      },
    });

    const jsonPayload = { name: 'test', value: 42 };
    const result = await invoke({}, makeEvent({
      httpMethod: 'POST',
      path: '/data',
      body: JSON.stringify(jsonPayload),
    }));

    assert.strictEqual(result.statusCode, 200);
    assert.deepStrictEqual(capturedJson, jsonPayload);
  });

  it('extracts params and body simultaneously for RawRoute', async () => {
    let capturedParams: Record<string, string> = {};
    let capturedBody: ReadableStream<Uint8Array> | null = null;

    registerRoute({
      method: 'POST',
      path: '/items/{id}',
      handler: async (ctx) => {
        capturedParams = ctx.request.params;
        capturedBody = ctx.request.body;
        ctx.response.send({ ok: true });
      },
    });

    const payload = JSON.stringify({ update: true });
    const result = await invoke({}, makeEvent({
      httpMethod: 'POST',
      path: '/items/abc-123',
      body: payload,
    }));

    assert.strictEqual(result.statusCode, 200);
    assert.deepStrictEqual(capturedParams, Object.assign(Object.create(null), { id: 'abc-123' }));
    assert.ok(capturedBody !== null);
  });
});

// ── Cookie extraction tests ─────────────────────────────────────────────────

// ── Unmatched RawRoute diagnostics ──────────────────────────────────────────
//
// A request that matches no RawRoute used to return 404 without a trace in
// CloudWatch, which is what made the duplicate-core-copy bug invisible.

describe('createLambdaHandler — unmatched RawRoute diagnostics', () => {
  /** Run `fn` with console.error captured; returns the collected lines. */
  async function captureErrors(fn: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(' '));
    };
    try {
      await fn();
    } finally {
      console.error = original;
    }
    return lines;
  }

  it('logs method, path and route count when no RawRoute matches', async () => {
    registerRoute({ method: 'GET', path: '/known', handler: async (ctx) => ctx.response.send({ ok: true }) });

    let result: any;
    const logged = await captureErrors(async () => {
      result = await invoke({}, makeEvent({ httpMethod: 'GET', path: '/unknown', body: null }));
    });

    assert.strictEqual(result.statusCode, 404);
    // The count must match the registry the dispatcher actually consulted —
    // a "0 routes registered" line is the fingerprint of a split registry.
    const expectedCount = getRegisteredRoutes().length;
    assert.ok(expectedCount > 0, 'precondition: routes are registered');
    assert.ok(
      logged.some(
        (line) =>
          line.includes('No RawRoute matched GET /unknown') &&
          line.includes(`${expectedCount} routes registered`),
      ),
      `expected a diagnostic for the unmatched route, got: ${JSON.stringify(logged)}`,
    );
  });

  it('does not log when a RawRoute matches', async () => {
    registerRoute({ method: 'GET', path: '/known', handler: async (ctx) => ctx.response.send({ ok: true }) });

    const logged = await captureErrors(async () => {
      const result = await invoke({}, makeEvent({ httpMethod: 'GET', path: '/known', body: null }));
      assert.strictEqual(result.statusCode, 200);
    });

    assert.deepStrictEqual(logged, []);
  });

  it('names duplicate core copies as the likely cause when more than one is loaded', async () => {
    const REGISTRY_KEY = '__AWS_BLOCKS_RAW_ROUTE_REGISTRY_V1__';
    const state = (globalThis as typeof globalThis & { [REGISTRY_KEY]?: { copies: number } })[REGISTRY_KEY];
    assert.ok(state, `route registry state must live on globalThis['${REGISTRY_KEY}']`);

    const originalCopies = state.copies;
    state.copies = 2;
    try {
      const logged = await captureErrors(async () => {
        const result = await invoke({}, makeEvent({ httpMethod: 'GET', path: '/unknown', body: null }));
        assert.strictEqual(result.statusCode, 404);
      });

      assert.ok(
        logged.some((line) => line.includes('2 copies of @aws-blocks/core are loaded')),
        `expected the copy count in the diagnostic, got: ${JSON.stringify(logged)}`,
      );
    } finally {
      state.copies = originalCopies;
    }
  });
});

describe('createLambdaHandler — cookie extraction', () => {
  it('extracts cookies from lowercase "cookie" header (API Gateway v2)', async () => {
    let capturedCookies = '';
    const backend = {
      api: (_ctx: any) => ({
        async echo(msg: string) {
          capturedCookies = requestCookies.getStore() || '';
          return { msg };
        },
      }),
    };

    await invoke(backend, makeEvent({
      headers: {
        'Content-Type': 'application/json',
        cookie: 'session=abc123; token=xyz',
      },
    }));

    assert.strictEqual(capturedCookies, 'session=abc123; token=xyz');
  });

  it('extracts cookies from mixed-case "Cookie" header (ALB/CloudFront)', async () => {
    let capturedCookies = '';
    const backend = {
      api: (_ctx: any) => ({
        async echo(msg: string) {
          capturedCookies = requestCookies.getStore() || '';
          return { msg };
        },
      }),
    };

    await invoke(backend, makeEvent({
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'session=def456; auth=token',
      },
    }));

    assert.strictEqual(capturedCookies, 'session=def456; auth=token');
  });

  it('prefers lowercase "cookie" when both are present', async () => {
    let capturedCookies = '';
    const backend = {
      api: (_ctx: any) => ({
        async echo(msg: string) {
          capturedCookies = requestCookies.getStore() || '';
          return { msg };
        },
      }),
    };

    await invoke(backend, makeEvent({
      headers: {
        'Content-Type': 'application/json',
        cookie: 'from-apigw=v2',
        Cookie: 'from-alb=v1',
      },
    }));

    assert.strictEqual(capturedCookies, 'from-apigw=v2');
  });

  it('store is empty string when no cookie header present', async () => {
    let capturedCookies: string | undefined = 'NOT_SET';
    const backend = {
      api: (_ctx: any) => ({
        async echo(msg: string) {
          capturedCookies = requestCookies.getStore();
          return { msg };
        },
      }),
    };

    await invoke(backend, makeEvent({
      headers: { 'Content-Type': 'application/json' },
    }));

    assert.strictEqual(capturedCookies, '');
  });
});

// ── RawRoute cookie forwarding tests ────────────────────────────────────────

describe('createLambdaHandler — RawRoute cookie forwarding', () => {
  it('cookies are available in RawRoute handlers via AsyncLocalStorage', async () => {
    let capturedCookies = '';

    registerRoute({
      method: 'GET',
      path: '/hooks/callback',
      handler: async (ctx) => {
        capturedCookies = requestCookies.getStore() || '';
        ctx.response.send({ ok: true });
      },
    });

    const result = await invoke({}, makeEvent({
      httpMethod: 'GET',
      path: '/hooks/callback',
      headers: {
        'Content-Type': 'application/json',
        cookie: 'session=abc123; token=xyz',
      },
    }));

    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(capturedCookies, 'session=abc123; token=xyz');
  });

  it('cookies are empty string in RawRoute when no cookie header present', async () => {
    let capturedCookies: string | undefined = 'NOT_SET';

    registerRoute({
      method: 'GET',
      path: '/hooks/nocookie',
      handler: async (ctx) => {
        capturedCookies = requestCookies.getStore();
        ctx.response.send({ ok: true });
      },
    });

    const result = await invoke({}, makeEvent({
      httpMethod: 'GET',
      path: '/hooks/nocookie',
      headers: { 'Content-Type': 'application/json' },
    }));

    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(capturedCookies, '');
  });

  it('cookies from mixed-case "Cookie" header are available in RawRoute', async () => {
    let capturedCookies = '';

    registerRoute({
      method: 'POST',
      path: '/hooks/webhook',
      handler: async (ctx) => {
        capturedCookies = requestCookies.getStore() || '';
        ctx.response.send({ received: true });
      },
    });

    const result = await invoke({}, makeEvent({
      httpMethod: 'POST',
      path: '/hooks/webhook',
      body: JSON.stringify({ event: 'test' }),
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'auth=bearer-token; sid=999',
      },
    }));

    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(capturedCookies, 'auth=bearer-token; sid=999');
  });
});

// ── Timeout guard tests ─────────────────────────────────────────────────────

function makeApiGatewayV2Event(overrides: Record<string, any> = {}) {
  return {
    requestContext: { http: { method: 'POST', path: '/aws-blocks/api' } },
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'api.echo', params: ['hello'], id: 1 }),
    isBase64Encoded: false,
    ...overrides,
  };
}

function makeSqsEvent() {
  return {
    Records: [
      {
        eventSource: 'aws:sqs',
        eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:my-queue',
        messageId: 'msg-1',
        body: JSON.stringify({ task: 'process' }),
      },
    ],
  };
}

function makeEventBridgeEvent() {
  return {
    source: 'blocks.cron',
    jobName: 'daily-cleanup',
    id: 'evt-123',
  };
}

function makeWebSocketEvent(eventType: 'CONNECT' | 'DISCONNECT' | 'MESSAGE' = 'MESSAGE') {
  return {
    requestContext: {
      eventType,
      connectionId: 'conn-abc',
      routeKey: '$default',
    },
    body: JSON.stringify({ action: 'ping' }),
  };
}

function makeLambdaContext(remainingMs: number): LambdaContext {
  return { getRemainingTimeInMillis: () => remainingMs };
}

async function invokeWithContext(backend: any, event: any, context?: LambdaContext): Promise<any> {
  const handler = createLambdaHandler(async () => backend);
  return handler(event, context);
}

describe('isApiGatewayHttpEvent — event source detection', () => {
  it('returns true for API Gateway v1 REST event (httpMethod present)', () => {
    assert.strictEqual(isApiGatewayHttpEvent(makeEvent()), true);
  });

  it('returns true for API Gateway v2 HTTP event (requestContext.http.method present)', () => {
    assert.strictEqual(isApiGatewayHttpEvent(makeApiGatewayV2Event()), true);
  });

  it('returns false for SQS event (Records[0].eventSource)', () => {
    assert.strictEqual(isApiGatewayHttpEvent(makeSqsEvent()), false);
  });

  it('returns false for EventBridge/Scheduler event (source starts with blocks.)', () => {
    assert.strictEqual(isApiGatewayHttpEvent(makeEventBridgeEvent()), false);
  });

  it('returns false for WebSocket CONNECT event', () => {
    assert.strictEqual(isApiGatewayHttpEvent(makeWebSocketEvent('CONNECT')), false);
  });

  it('returns false for WebSocket DISCONNECT event', () => {
    assert.strictEqual(isApiGatewayHttpEvent(makeWebSocketEvent('DISCONNECT')), false);
  });

  it('returns false for WebSocket MESSAGE event', () => {
    assert.strictEqual(isApiGatewayHttpEvent(makeWebSocketEvent('MESSAGE')), false);
  });

  it('returns false for unknown event with no HTTP indicators', () => {
    assert.strictEqual(isApiGatewayHttpEvent({ something: 'else' }), false);
  });
});

describe('computeHttpDeadlineMs — deadline computation', () => {
  it('returns 28000 when no context is provided', () => {
    assert.strictEqual(computeHttpDeadlineMs(), 28_000);
  });

  it('returns 28000 when remaining time is more than 29s', () => {
    const ctx = makeLambdaContext(900_000); // 15 minutes
    assert.strictEqual(computeHttpDeadlineMs(ctx), 28_000);
  });

  it('returns remaining - buffer when remaining is less than 29s', () => {
    const ctx = makeLambdaContext(10_000); // 10 seconds remaining
    assert.strictEqual(computeHttpDeadlineMs(ctx), 9_000); // 10000 - 1000 buffer
  });

  it('returns 0 when remaining time is less than buffer', () => {
    const ctx = makeLambdaContext(500); // only 500ms left
    assert.strictEqual(computeHttpDeadlineMs(ctx), 0);
  });

  it('returns 28000 when context has no getRemainingTimeInMillis', () => {
    assert.strictEqual(computeHttpDeadlineMs({} as any), 28_000);
  });
});

describe('createLambdaHandler — timeout guard for API Gateway events', () => {
  it('a fast handler completes normally with correct response', async () => {
    const backend = {
      api: () => ({
        async echo(msg: string) { return { msg }; },
      }),
    };

    const result = await invokeWithContext(
      backend,
      makeEvent(),
      makeLambdaContext(900_000),
    );

    assert.strictEqual(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.strictEqual(body.result.msg, 'hello');
  });

  it('a slow handler returns 504 with JSON-RPC error envelope when deadline fires', async () => {
    const backend = {
      api: () => ({
        async echo() {
          await new Promise(resolve => setTimeout(resolve, 5_000));
          return { msg: 'should not reach' };
        },
      }),
    };

    const ctx = makeLambdaContext(100); // 100ms remaining → deadline = 0ms (fires immediately)
    const result = await invokeWithContext(backend, makeEvent(), ctx);

    assert.strictEqual(result.statusCode, 504);
    const body = JSON.parse(result.body);
    assert.strictEqual(body.jsonrpc, '2.0');
    assert.strictEqual(body.error.code, 504);
    assert.strictEqual(body.error.message, 'Request timed out');
    assert.strictEqual(body.error.data.name, 'HandlerTimeoutError');
    assert.strictEqual(body.id, null);
  });

  it('timeout guard respects computeHttpDeadlineMs with short remaining time', async () => {
    const backend = {
      api: () => ({
        async echo() {
          await new Promise(resolve => setTimeout(resolve, 200));
          return { msg: 'done' };
        },
      }),
    };

    const ctx = makeLambdaContext(50); // 50ms remaining → deadline = 0ms
    const result = await invokeWithContext(backend, makeEvent(), ctx);

    assert.strictEqual(result.statusCode, 504);
    const body = JSON.parse(result.body);
    assert.strictEqual(body.jsonrpc, '2.0');
    assert.strictEqual(body.error.code, 504);
  });

  it('504 response includes CORS headers for an allowed origin', async () => {
    const backend = {
      api: () => ({
        async echo() {
          await new Promise(resolve => setTimeout(resolve, 5_000));
          return {};
        },
      }),
    };

    process.env.CORS_ALLOWED_ORIGINS = 'https://myapp\\.example\\.com';
    delete process.env.CORS_HOSTING_ORIGINS;
    _resetCorsPatterns();

    const event = makeEvent({
      headers: {
        'Content-Type': 'application/json',
        origin: 'https://myapp.example.com',
      },
    });
    const ctx = makeLambdaContext(50);
    const result = await invokeWithContext(backend, event, ctx);

    assert.strictEqual(result.statusCode, 504);
    assert.strictEqual(result.headers['Access-Control-Allow-Origin'], 'https://myapp.example.com');
    assert.strictEqual(result.headers['Access-Control-Allow-Credentials'], 'true');

    delete process.env.CORS_ALLOWED_ORIGINS;
    _resetCorsPatterns();
  });

  it('504 response omits CORS headers when no allowlist is configured', async () => {
    const backend = {
      api: () => ({
        async echo() {
          await new Promise(resolve => setTimeout(resolve, 5_000));
          return {};
        },
      }),
    };

    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.CORS_HOSTING_ORIGINS;
    _resetCorsPatterns();

    const event = makeEvent({
      headers: {
        'Content-Type': 'application/json',
        origin: 'https://evil.example.com',
      },
    });
    const ctx = makeLambdaContext(50);
    const result = await invokeWithContext(backend, event, ctx);

    assert.strictEqual(result.statusCode, 504);
    assert.strictEqual(result.headers['Access-Control-Allow-Origin'], undefined);
    assert.strictEqual(result.headers['Access-Control-Allow-Credentials'], undefined);

    delete process.env.CORS_ALLOWED_ORIGINS;
    _resetCorsPatterns();
  });

  it('disallowed origin with a configured allowlist is rejected with 403 before the timeout path', async () => {
    const backend = {
      api: () => ({
        async echo() {
          await new Promise(resolve => setTimeout(resolve, 5_000));
          return {};
        },
      }),
    };

    process.env.CORS_ALLOWED_ORIGINS = 'https://myapp\\.example\\.com';
    delete process.env.CORS_HOSTING_ORIGINS;
    _resetCorsPatterns();

    const event = makeEvent({
      headers: {
        'Content-Type': 'application/json',
        origin: 'https://evil.example.com',
      },
    });
    const ctx = makeLambdaContext(50);
    const result = await invokeWithContext(backend, event, ctx);

    assert.strictEqual(result.statusCode, 403);
    assert.strictEqual(result.headers['Access-Control-Allow-Origin'], undefined);
    assert.strictEqual(result.headers['Access-Control-Allow-Credentials'], undefined);

    delete process.env.CORS_ALLOWED_ORIGINS;
    _resetCorsPatterns();
  });
});

describe('createLambdaHandler — async events bypass timeout guard', () => {
  it('SQS events run without timeout guard', async () => {
    const handlers = new Map<string, (record: any) => Promise<void>>();
    handlers.set('aws:sqs:my-queue', async (_record: any) => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    (globalThis as any).__BLOCKS_LAMBDA_EVENT_HANDLERS__ = handlers;

    const handler = createLambdaHandler(async () => ({}));
    const ctx = makeLambdaContext(50);
    const result = await handler(makeSqsEvent(), ctx);

    assert.deepStrictEqual(result, {});

    delete (globalThis as any).__BLOCKS_LAMBDA_EVENT_HANDLERS__;
  });

  it('EventBridge events run without timeout guard', async () => {
    let handlerCalled = false;
    const handlers = new Map<string, (record: any) => Promise<void>>();
    handlers.set('blocks.cron:daily-cleanup', async () => {
      handlerCalled = true;
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    (globalThis as any).__BLOCKS_LAMBDA_EVENT_HANDLERS__ = handlers;

    const handler = createLambdaHandler(async () => ({}));
    const ctx = makeLambdaContext(50);
    await handler(makeEventBridgeEvent(), ctx);

    assert.strictEqual(handlerCalled, true);

    delete (globalThis as any).__BLOCKS_LAMBDA_EVENT_HANDLERS__;
  });

  it('WebSocket events run without timeout guard', async () => {
    let handlerCalled = false;
    const handlers = new Map<string, (record: any) => Promise<void>>();
    handlers.set('blocks.websocket:my-realtime', async () => {
      handlerCalled = true;
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    (globalThis as any).__BLOCKS_LAMBDA_EVENT_HANDLERS__ = handlers;

    const handler = createLambdaHandler(async () => ({}));
    const ctx = makeLambdaContext(50);
    await handler(makeWebSocketEvent('MESSAGE'), ctx);

    assert.strictEqual(handlerCalled, true);

    delete (globalThis as any).__BLOCKS_LAMBDA_EVENT_HANDLERS__;
  });
});

describe('createLambdaHandler — timeout produces 504 and aborts signal', () => {
  it('returns 504 on timeout and aborts the request signal', async () => {
    let capturedSignal: AbortSignal | undefined;
    const backend = {
      api: (ctx: BlocksContext) => ({
        async echo() {
          capturedSignal = ctx.request.signal;
          await new Promise(resolve => setTimeout(resolve, 5_000));
          return { msg: 'should not reach' };
        },
      }),
    };

    const ctx = makeLambdaContext(50);
    const result = await invokeWithContext(backend, makeEvent(), ctx);

    assert.strictEqual(result.statusCode, 504);
    assert.ok(capturedSignal, 'signal should be passed to handler');
    assert.strictEqual(capturedSignal!.aborted, true, 'signal should be aborted after timeout');
  });

  it('handler errors that are not timeouts propagate normally', async () => {
    const backend = {
      api: () => ({
        async echo() {
          throw new Error('Intentional failure');
        },
      }),
    };

    const ctx = makeLambdaContext(900_000);
    const result = await invokeWithContext(backend, makeEvent(), ctx);

    assert.strictEqual(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.ok(body.error);
    assert.strictEqual(body.error.code, 500);
  });
});

// ── classifyEvent tests ─────────────────────────────────────────────────────

describe('classifyEvent — event source classification', () => {
  it('classifies API Gateway v1 REST event as http', () => {
    assert.strictEqual(classifyEvent(makeEvent()), 'http');
  });

  it('classifies API Gateway v2 HTTP event as http', () => {
    assert.strictEqual(classifyEvent(makeApiGatewayV2Event()), 'http');
  });

  it('classifies SQS event as records', () => {
    assert.strictEqual(classifyEvent(makeSqsEvent()), 'records');
  });

  it('classifies EventBridge event as direct', () => {
    assert.strictEqual(classifyEvent(makeEventBridgeEvent()), 'direct');
  });

  it('classifies WebSocket CONNECT as websocket', () => {
    assert.strictEqual(classifyEvent(makeWebSocketEvent('CONNECT')), 'websocket');
  });

  it('classifies WebSocket MESSAGE as websocket', () => {
    assert.strictEqual(classifyEvent(makeWebSocketEvent('MESSAGE')), 'websocket');
  });

  it('classifies unknown event as http (fallback)', () => {
    assert.strictEqual(classifyEvent({ something: 'else' }), 'http');
  });
});

// ── Decode-path test (ensures client can decode the 504 JSON-RPC envelope) ──

describe('createLambdaHandler — 504 response is decodable by RPC client', () => {
  it('decodeRpcResponse throws ApiError with message and status 504', async () => {
    const backend = {
      api: () => ({
        async echo() {
          await new Promise(resolve => setTimeout(resolve, 5_000));
          return {};
        },
      }),
    };

    const ctx = makeLambdaContext(50);
    const result = await invokeWithContext(backend, makeEvent(), ctx);

    assert.strictEqual(result.statusCode, 504);
    const responseBody = JSON.parse(result.body);

    try {
      decodeRpcResponse(responseBody);
      assert.fail('Expected decodeRpcResponse to throw');
    } catch (err: any) {
      assert.strictEqual(err.message, 'Request timed out');
      assert.strictEqual(err.status, 504);
      assert.strictEqual(err.name, 'HandlerTimeoutError');
    }
  });
});

// ── Non-RPC path timeout returns plain JSON ─────────────────────────────────

describe('createLambdaHandler — timeout on non-RPC path returns plain JSON', () => {
  it('returns plain JSON body (not JSON-RPC envelope) for RawRoute timeout', async () => {
    registerRoute({
      method: 'GET',
      path: '/slow-endpoint',
      handler: async () => {
        await new Promise(resolve => setTimeout(resolve, 5_000));
      },
    });

    const event = makeEvent({
      httpMethod: 'GET',
      path: '/slow-endpoint',
      body: null,
    });
    const ctx = makeLambdaContext(50);
    const result = await invokeWithContext({}, event, ctx);

    assert.strictEqual(result.statusCode, 504);
    const body = JSON.parse(result.body);
    assert.strictEqual(body.error, 'Request timed out');
    assert.strictEqual(body.code, 'HANDLER_TIMEOUT');
    assert.strictEqual(body.jsonrpc, undefined, 'Non-RPC path should not use JSON-RPC envelope');
  });
});

// ── AbortSignal threading tests ─────────────────────────────────────────────

describe('createLambdaHandler — AbortSignal threading', () => {
  it('signal is available in RPC handler context and not aborted for fast requests', async () => {
    let capturedSignal: AbortSignal | undefined;
    const backend = {
      api: (ctx: BlocksContext) => ({
        async echo(msg: string) {
          capturedSignal = ctx.request.signal;
          return { msg };
        },
      }),
    };

    const result = await invokeWithContext(backend, makeEvent(), makeLambdaContext(900_000));

    assert.strictEqual(result.statusCode, 200);
    assert.ok(capturedSignal, 'signal should be passed to handler');
    assert.strictEqual(capturedSignal!.aborted, false, 'signal should not be aborted for successful requests');
  });

  it('signal is available in RawRoute handler and aborted on timeout', async () => {
    let capturedSignal: AbortSignal | undefined;

    registerRoute({
      method: 'GET',
      path: '/signal-test',
      handler: async (ctx) => {
        capturedSignal = ctx.request.signal;
        await new Promise(resolve => setTimeout(resolve, 5_000));
        ctx.response.send({ ok: true });
      },
    });

    const event = makeEvent({
      httpMethod: 'GET',
      path: '/signal-test',
      body: null,
    });
    const ctx = makeLambdaContext(50);
    const result = await invokeWithContext({}, event, ctx);

    assert.strictEqual(result.statusCode, 504);
    assert.ok(capturedSignal, 'signal should be passed to RawRoute handler');
    assert.strictEqual(capturedSignal!.aborted, true, 'signal should be aborted after timeout');
  });
});

// ── buildEventUrl host resolution ───────────────────────────────────────────

describe('buildEventUrl — X-Forwarded-Host (sandbox front door)', () => {
  const EXECUTE_API = 'abc123.execute-api.us-east-1.amazonaws.com';

  it('prefers a loopback X-Forwarded-Host over Host', () => {
    const url = buildEventUrl({
      path: '/auth/callback',
      headers: { 'x-forwarded-host': 'localhost:3000', Host: EXECUTE_API },
      requestContext: { stage: 'prod' },
    });
    assert.strictEqual(url.host, 'localhost:3000');
    // Trusted front door: plain http, and the stage prefix is dropped (the
    // browser-visible URL has no /prod).
    assert.strictEqual(url.protocol, 'http:');
    assert.strictEqual(url.pathname, '/auth/callback');
  });

  it('ignores a forged non-loopback X-Forwarded-Host and falls back to Host', () => {
    const url = buildEventUrl({
      path: '/auth/callback',
      headers: { 'x-forwarded-host': 'evil.com', Host: EXECUTE_API },
    });
    assert.strictEqual(url.host, EXECUTE_API);
  });

  it('uses Host when no X-Forwarded-Host is present (full deploy)', () => {
    const url = buildEventUrl({
      path: '/auth/callback',
      headers: { Host: EXECUTE_API },
    });
    assert.strictEqual(url.host, EXECUTE_API);
  });

  it('forces http for the trusted front door regardless of x-forwarded-proto', () => {
    // The dev-server front door is plain HTTP; an execute-api x-forwarded-proto
    // of https must not leak into the browser-visible URL.
    const url = buildEventUrl({
      path: '/auth/callback',
      headers: { 'x-forwarded-host': 'localhost:3000', 'x-forwarded-proto': 'https', Host: EXECUTE_API },
    });
    assert.strictEqual(url.protocol, 'http:');
    assert.strictEqual(url.host, 'localhost:3000');
  });

  it('keeps proto and stage prefix for the non-loopback (deploy) path', () => {
    const url = buildEventUrl({
      path: '/auth/callback',
      headers: { 'x-forwarded-proto': 'https', Host: EXECUTE_API },
      requestContext: { stage: 'prod' },
    });
    assert.strictEqual(url.protocol, 'https:');
    assert.strictEqual(url.host, EXECUTE_API);
    assert.strictEqual(url.pathname, '/prod/auth/callback');
  });

  it('accepts 127.0.0.1 and [::1] as loopback forwarded hosts', () => {
    const v4 = buildEventUrl({ path: '/', headers: { 'x-forwarded-host': '127.0.0.1:3000', Host: EXECUTE_API } });
    assert.strictEqual(v4.host, '127.0.0.1:3000');

    const v6 = buildEventUrl({ path: '/', headers: { 'x-forwarded-host': '[::1]:3000', Host: EXECUTE_API } });
    assert.strictEqual(v6.hostname, '[::1]');
  });
});

describe('isLoopbackForwardedHost', () => {
  it('returns true for loopback hosts (with or without port)', () => {
    assert.strictEqual(isLoopbackForwardedHost('localhost'), true);
    assert.strictEqual(isLoopbackForwardedHost('localhost:3000'), true);
    assert.strictEqual(isLoopbackForwardedHost('127.0.0.1:3000'), true);
    assert.strictEqual(isLoopbackForwardedHost('[::1]:3000'), true);
  });

  it('returns false for non-loopback or malformed values', () => {
    assert.strictEqual(isLoopbackForwardedHost(undefined), false);
    assert.strictEqual(isLoopbackForwardedHost(''), false);
    assert.strictEqual(isLoopbackForwardedHost('evil.com'), false);
    assert.strictEqual(isLoopbackForwardedHost('abc.execute-api.us-east-1.amazonaws.com'), false);
    // A host that merely contains "localhost" as a subdomain must not pass.
    assert.strictEqual(isLoopbackForwardedHost('localhost.evil.com'), false);
  });
});

// ── Sandbox topology regression (end-to-end through the handler) ─────────────

describe('createLambdaHandler — sandbox forwarded-host reaches the route', () => {
  it('a RawRoute sees the loopback front-door host, not the execute-api Host', async () => {
    let capturedHost = '';
    registerRoute({
      method: 'GET',
      path: '/auth/callback',
      handler: async (ctx) => {
        // This mirrors how AuthOIDC.computeCallbackUrl derives redirect_uri:
        // entirely from ctx.request.url.host.
        capturedHost = ctx.request.url.host;
        ctx.response.send('');
      },
    });

    await invoke({}, makeEvent({
      httpMethod: 'GET',
      path: '/auth/callback',
      body: null,
      requestContext: { stage: 'prod' },
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-host': 'localhost:3000',
        Host: 'abc123.execute-api.us-east-1.amazonaws.com',
      },
    }));

    assert.strictEqual(capturedHost, 'localhost:3000');
  });

  it('a forged non-loopback forwarded host does not reach the route', async () => {
    let capturedHost = '';
    registerRoute({
      method: 'GET',
      path: '/auth/callback',
      handler: async (ctx) => {
        capturedHost = ctx.request.url.host;
        ctx.response.send('');
      },
    });

    await invoke({}, makeEvent({
      httpMethod: 'GET',
      path: '/auth/callback',
      body: null,
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-host': 'evil.com',
        Host: 'abc123.execute-api.us-east-1.amazonaws.com',
      },
    }));

    assert.strictEqual(capturedHost, 'abc123.execute-api.us-east-1.amazonaws.com');
  });
});

// ── SQS partial batch failure tests ─────────────────────────────────────────

/**
 * These pin the runtime half of the bb-async-job BatchSize fix: with a batch
 * larger than 1, failing records must be reported individually via
 * `batchItemFailures` so SQS retries only those messages. If this response
 * shape regresses, every successful sibling message in a partially-failing
 * batch would be redelivered (or, worse, the failures silently dropped).
 */
function makeSqsBatchEvent(count: number) {
  return {
    Records: Array.from({ length: count }, (_, i) => ({
      eventSource: 'aws:sqs',
      eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:my-queue',
      messageId: `msg-${i}`,
      body: JSON.stringify({ n: i }),
    })),
  };
}

describe('handleEventSourceRecords — SQS partial batch responses', () => {
  it('reports only the failed records of a mixed-success 10-record batch', async () => {
    const processed: number[] = [];
    const handlers = new Map<string, (record: any) => Promise<void>>();
    handlers.set('aws:sqs:my-queue', async (record: any) => {
      const { n } = JSON.parse(record.body);
      if (n % 3 === 0) throw new Error(`boom on ${n}`);
      processed.push(n);
    });
    (globalThis as any).__BLOCKS_LAMBDA_EVENT_HANDLERS__ = handlers;

    try {
      const handler = createLambdaHandler(async () => ({}));
      const result: any = await handler(makeSqsBatchEvent(10));

      assert.deepStrictEqual(
        result.batchItemFailures.map((f: any) => f.itemIdentifier).sort(),
        ['msg-0', 'msg-3', 'msg-6', 'msg-9']
      );
      assert.deepStrictEqual(processed.sort((a, b) => a - b), [1, 2, 4, 5, 7, 8]);
    } finally {
      delete (globalThis as any).__BLOCKS_LAMBDA_EVENT_HANDLERS__;
    }
  });

  it('returns no batchItemFailures when every record in the batch succeeds', async () => {
    const handlers = new Map<string, (record: any) => Promise<void>>();
    handlers.set('aws:sqs:my-queue', async () => {});
    (globalThis as any).__BLOCKS_LAMBDA_EVENT_HANDLERS__ = handlers;

    try {
      const handler = createLambdaHandler(async () => ({}));
      const result: any = await handler(makeSqsBatchEvent(10));
      assert.deepStrictEqual(result, {});
    } finally {
      delete (globalThis as any).__BLOCKS_LAMBDA_EVENT_HANDLERS__;
    }
  });

  it('reports all records when the whole batch fails (no silent drop)', async () => {
    const handlers = new Map<string, (record: any) => Promise<void>>();
    handlers.set('aws:sqs:my-queue', async () => { throw new Error('always'); });
    (globalThis as any).__BLOCKS_LAMBDA_EVENT_HANDLERS__ = handlers;

    try {
      const handler = createLambdaHandler(async () => ({}));
      const result: any = await handler(makeSqsBatchEvent(10));
      assert.strictEqual(result.batchItemFailures.length, 10);
    } finally {
      delete (globalThis as any).__BLOCKS_LAMBDA_EVENT_HANDLERS__;
    }
  });
});
