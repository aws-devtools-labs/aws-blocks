// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import { parseCorsPatterns, _resetCorsPatterns, buildCorsHeaders } from './cors.js';
import { createLambdaHandler } from './lambda-handler.js';
import { clearRouteRegistry } from './raw-route.js';

// ── parseCorsPatterns unit tests ────────────────────────────────────────────

describe('parseCorsPatterns', () => {
  it('returns anchored patterns from plain strings', () => {
    const patterns = parseCorsPatterns('https://example\\.com');
    assert.strictEqual(patterns.length, 1);
    assert.ok(patterns[0].test('https://example.com'));
    assert.ok(!patterns[0].test('https://example.com.evil.org'));
  });

  it('handles already-anchored patterns (starting with ^)', () => {
    const patterns = parseCorsPatterns('^https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?$');
    assert.strictEqual(patterns.length, 1);
    assert.ok(patterns[0].test('http://localhost:3000'));
    assert.ok(patterns[0].test('https://127.0.0.1:8080'));
    assert.ok(!patterns[0].test('https://evil.com'));
  });

  it('handles multiple comma-separated patterns', () => {
    const patterns = parseCorsPatterns('https://a\\.com,https://b\\.com');
    assert.strictEqual(patterns.length, 2);
    assert.ok(patterns[0].test('https://a.com'));
    assert.ok(patterns[1].test('https://b.com'));
  });

  it('trims whitespace from patterns', () => {
    const patterns = parseCorsPatterns(' https://a\\.com , https://b\\.com ');
    assert.strictEqual(patterns.length, 2);
    assert.ok(patterns[0].test('https://a.com'));
    assert.ok(patterns[1].test('https://b.com'));
  });

  it('skips empty entries', () => {
    const patterns = parseCorsPatterns('https://a\\.com,,,,https://b\\.com');
    assert.strictEqual(patterns.length, 2);
  });

  it('handles invalid regex by escaping and matching literally', () => {
    const patterns = parseCorsPatterns('https://[invalid');
    assert.strictEqual(patterns.length, 1);
    assert.ok(patterns[0].test('https://[invalid'));
    assert.ok(!patterns[0].test('https://valid'));
  });

  it('wildcard .* allows all origins', () => {
    const patterns = parseCorsPatterns('.*');
    assert.strictEqual(patterns.length, 1);
    assert.ok(patterns[0].test('https://anything.example.org'));
    assert.ok(patterns[0].test('http://localhost:9999'));
  });
});

// ── buildCorsHeaders unit tests ─────────────────────────────────────────────

describe('buildCorsHeaders', () => {
  beforeEach(() => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.CORS_HOSTING_ORIGINS;
    _resetCorsPatterns();
  });

  it('reflects an origin that matches the configured allowlist', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://myapp\\.example\\.com';
    _resetCorsPatterns();

    const headers = buildCorsHeaders('https://myapp.example.com');
    assert.strictEqual(headers['Access-Control-Allow-Origin'], 'https://myapp.example.com');
    assert.strictEqual(headers['Access-Control-Allow-Credentials'], 'true');
  });

  it('never reflects an origin that is not on a configured allowlist', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://myapp\\.example\\.com';
    _resetCorsPatterns();

    const headers = buildCorsHeaders('https://evil.example.com');
    assert.strictEqual(headers['Access-Control-Allow-Origin'], undefined);
    assert.strictEqual(headers['Access-Control-Allow-Credentials'], undefined);
    assert.deepStrictEqual(headers, {});
  });

  it('never reflects an origin when no allowlist is configured', () => {
    const headers = buildCorsHeaders('https://evil.example.com');
    assert.deepStrictEqual(headers, {});
  });

  it('returns no headers when there is no origin', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://myapp\\.example\\.com';
    _resetCorsPatterns();

    assert.deepStrictEqual(buildCorsHeaders(''), {});
  });
});

// ── isOriginAllowed + getCorsPatterns integration via handler ────────────────

// These tests exercise the full CORS flow through createLambdaHandler to
// verify origin validation, header injection, and rejection work end-to-end.

describe('createLambdaHandler — CORS origin validation', () => {
  beforeEach(() => {
    process.env.CORS_ALLOWED_ORIGINS = [
      'https://myapp\\.com',
      '^https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?$',
    ].join(',');
    delete process.env.CORS_HOSTING_ORIGINS;
    _resetCorsPatterns();
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

  async function invoke(backend: any, event: any) {
    const handler = createLambdaHandler(async () => backend);
    return handler(event) as any;
  }

  const echoBackend = {
    api: (_ctx: any) => ({
      async echo(msg: string) { return { msg }; },
    }),
  };

  it('allows an origin that matches an exact pattern', async () => {
    const result = await invoke(echoBackend, makeEvent({
      headers: { 'Content-Type': 'application/json', origin: 'https://myapp.com' },
    }));
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.headers['access-control-allow-origin'], 'https://myapp.com');
    assert.strictEqual(result.headers['access-control-allow-credentials'], 'true');
  });

  it('allows an origin that matches a regex pattern', async () => {
    const result = await invoke(echoBackend, makeEvent({
      headers: { 'Content-Type': 'application/json', origin: 'http://localhost:5173' },
    }));
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.headers['access-control-allow-origin'], 'http://localhost:5173');
  });

  it('rejects an origin that does not match any pattern with 403', async () => {
    const result = await invoke(echoBackend, makeEvent({
      headers: { 'Content-Type': 'application/json', origin: 'https://evil.com' },
    }));
    assert.strictEqual(result.statusCode, 403);
    const body = JSON.parse(result.body);
    assert.strictEqual(body.error, 'Forbidden: cross-origin request rejected');
  });

  it('passes through when no origin header is present (same-origin / server-side)', async () => {
    const result = await invoke(echoBackend, makeEvent({
      headers: { 'Content-Type': 'application/json' },
    }));
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.headers['access-control-allow-origin'], undefined);
  });

  it('anchored pattern prevents partial-match bypass', async () => {
    const result = await invoke(echoBackend, makeEvent({
      headers: { 'Content-Type': 'application/json', origin: 'https://myapp.com.evil.org' },
    }));
    assert.strictEqual(result.statusCode, 403);
  });

  it('sets ACAO and credentials headers on allowed origin', async () => {
    const result = await invoke(echoBackend, makeEvent({
      headers: { 'Content-Type': 'application/json', origin: 'https://myapp.com' },
    }));
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.headers['access-control-allow-origin'], 'https://myapp.com');
    assert.strictEqual(result.headers['access-control-allow-credentials'], 'true');
  });

  it('OPTIONS preflight with allowed origin returns 200 with CORS headers', async () => {
    const result = await invoke(echoBackend, makeEvent({
      httpMethod: 'OPTIONS',
      path: '/aws-blocks/api',
      headers: { origin: 'http://localhost:3000' },
      body: null,
    }));
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.headers['Access-Control-Allow-Origin'], 'http://localhost:3000');
    assert.strictEqual(result.headers['Access-Control-Allow-Credentials'], 'true');
    assert.ok(result.headers['Access-Control-Allow-Methods']);
    assert.ok(result.headers['Access-Control-Allow-Headers']);
    assert.strictEqual(result.headers['Access-Control-Max-Age'], '7200');
  });

  it('OPTIONS preflight with rejected origin returns 403', async () => {
    const result = await invoke(echoBackend, makeEvent({
      httpMethod: 'OPTIONS',
      path: '/aws-blocks/api',
      headers: { origin: 'https://evil.com' },
      body: null,
    }));
    assert.strictEqual(result.statusCode, 403);
  });
});

// ── CORS wildcard pattern ───────────────────────────────────────────────────

describe('createLambdaHandler — CORS wildcard pattern (.*)', () => {
  beforeEach(() => {
    process.env.CORS_ALLOWED_ORIGINS = '.*';
    delete process.env.CORS_HOSTING_ORIGINS;
    _resetCorsPatterns();
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

  async function invoke(backend: any, event: any) {
    const handler = createLambdaHandler(async () => backend);
    return handler(event) as any;
  }

  const echoBackend = {
    api: (_ctx: any) => ({
      async echo(msg: string) { return { msg }; },
    }),
  };

  it('allows any origin when pattern is .* (catch-all)', async () => {
    const result = await invoke(echoBackend, makeEvent({
      headers: { 'Content-Type': 'application/json', origin: 'https://anything.example.org' },
    }));
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.headers['access-control-allow-origin'], 'https://anything.example.org');
  });
});

// ── CORS hosting origin merge ───────────────────────────────────────────────

describe('createLambdaHandler — CORS hosting origin merge', () => {
  beforeEach(() => {
    process.env.CORS_ALLOWED_ORIGINS = '^https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?$';
    process.env.CORS_HOSTING_ORIGINS = 'https://d111111abcdef8\\.cloudfront\\.net';
    _resetCorsPatterns();
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

  async function invoke(backend: any, event: any) {
    const handler = createLambdaHandler(async () => backend);
    return handler(event) as any;
  }

  const echoBackend = {
    api: (_ctx: any) => ({
      async echo(msg: string) { return { msg }; },
    }),
  };

  it('allows localhost origin from CORS_ALLOWED_ORIGINS env var', async () => {
    const result = await invoke(echoBackend, makeEvent({
      headers: { 'Content-Type': 'application/json', origin: 'http://localhost:5173' },
    }));
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.headers['access-control-allow-origin'], 'http://localhost:5173');
  });

  it('allows CloudFront origin from CORS_HOSTING_ORIGINS (S3 config)', async () => {
    const result = await invoke(echoBackend, makeEvent({
      headers: { 'Content-Type': 'application/json', origin: 'https://d111111abcdef8.cloudfront.net' },
    }));
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.headers['access-control-allow-origin'], 'https://d111111abcdef8.cloudfront.net');
  });

  it('rejects origins not matching either source', async () => {
    const result = await invoke(echoBackend, makeEvent({
      headers: { 'Content-Type': 'application/json', origin: 'https://evil.com' },
    }));
    assert.strictEqual(result.statusCode, 403);
  });

  it('allows 127.0.0.1 from the combined patterns', async () => {
    const result = await invoke(echoBackend, makeEvent({
      headers: { 'Content-Type': 'application/json', origin: 'http://127.0.0.1:8080' },
    }));
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.headers['access-control-allow-origin'], 'http://127.0.0.1:8080');
  });
});
