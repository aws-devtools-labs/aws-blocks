// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import { parseCorsPatterns, escapeOriginToPattern, getCorsPatterns, isOriginAllowed, _resetCorsPatterns, buildCorsHeaders, CORS_MAX_AGE } from './cors.js';
import { createLambdaHandler } from './lambda-handler.js';
import { clearRouteRegistry } from './raw-route.js';
import { CLIENT_USER_AGENT_HEADER } from './constants.js';

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

  it('leaves the documented .* wildcard escape hatch intact end-to-end', () => {
    const patterns = parseCorsPatterns('.*');
    assert.ok(patterns[0].test('https://d123.cloudfront.net'));
    assert.ok(patterns[0].test('https://anything.example.org'));
  });

  it('appends $ to a start-only-anchored pattern (enforces the end anchor)', () => {
    const patterns = parseCorsPatterns('^https://app\\.example\\.com');
    assert.strictEqual(patterns.length, 1);
    assert.ok(patterns[0].test('https://app.example.com'));
    assert.ok(!patterns[0].test('https://app.example.com.extra'));
  });

  it('end-anchors every branch of a top-level | alternation (both branches end in $)', () => {
    const patterns = parseCorsPatterns('^https://a\\.com|https://b\\.com$');
    assert.strictEqual(patterns.length, 1);
    assert.ok(patterns[0].test('https://a.com'));
    assert.ok(patterns[0].test('https://b.com'));
    // Whole-expression anchoring: a longer first-branch origin does not match.
    assert.ok(!patterns[0].test('https://a.com.other'));
  });

  it('end-anchors both branches of a | alternation with no leading ^', () => {
    const patterns = parseCorsPatterns('https://a\\.com|https://b\\.com');
    assert.strictEqual(patterns.length, 1);
    assert.ok(patterns[0].test('https://a.com'));
    assert.ok(patterns[0].test('https://b.com'));
    assert.ok(!patterns[0].test('https://a.com.other'));
  });

  it('start-anchors both branches of a | alternation (first branch not a prefix match)', () => {
    const patterns = parseCorsPatterns('^https://a\\.com|b\\.com');
    assert.strictEqual(patterns.length, 1);
    assert.ok(patterns[0].test('https://a.com'));
    assert.ok(patterns[0].test('b.com'));
    // The second branch is start-anchored too, so a longer-prefixed host does not match.
    assert.ok(!patterns[0].test('https://xb.com'));
  });

  it('leaves a fully-anchored pattern unchanged (no double-anchor)', () => {
    const patterns = parseCorsPatterns('^https?://localhost(:\\d+)?$');
    assert.strictEqual(patterns.length, 1);
    assert.ok(patterns[0].test('http://localhost:3000'));
    assert.ok(!patterns[0].test('http://localhost:3000.other'));
  });

  it('treats a trailing escaped dollar as literal and appends a real end anchor', () => {
    const patterns = parseCorsPatterns('^https://foo\\$');
    assert.strictEqual(patterns.length, 1);
    assert.ok(patterns[0].test('https://foo$'));
    assert.ok(!patterns[0].test('https://foo$bar'));
  });
});

// ── escapeOriginToPattern unit tests ─────────────────────────────────────────

describe('escapeOriginToPattern', () => {
  it('escapes a literal origin so its dots are not wildcards', () => {
    const pattern = escapeOriginToPattern('https://d123.cloudfront.net');
    const patterns = parseCorsPatterns(pattern);
    assert.strictEqual(patterns.length, 1);
    assert.ok(patterns[0].test('https://d123.cloudfront.net'));
    assert.ok(!patterns[0].test('https://d123xcloudfrontxnet'));
  });

  it('returns an already-anchored pattern that is not double-anchored by parseCorsPatterns', () => {
    const pattern = escapeOriginToPattern('https://d123.cloudfront.net');
    assert.ok(pattern.startsWith('^'));
    assert.ok(pattern.endsWith('$'));
    // Feeding it back through parseCorsPatterns must still match the exact origin
    // and, proving the anchors are not broken by the outer wrap, reject a suffix.
    const patterns = parseCorsPatterns(pattern);
    assert.ok(patterns[0].test('https://d123.cloudfront.net'));
    assert.ok(!patterns[0].test('https://d123.cloudfront.net.other'));
  });
});

// ── getCorsPatterns channel separation ───────────────────────────────────────

describe('getCorsPatterns — channel separation', () => {
  beforeEach(() => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.CORS_HOSTING_ORIGINS;
    _resetCorsPatterns();
  });

  it('compiles CORS_ALLOWED_ORIGINS as regex and CORS_HOSTING_ORIGINS as escaped literal', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://app\\.example\\.com'; // regex channel
    process.env.CORS_HOSTING_ORIGINS = 'https://d123.cloudfront.net'; // literal channel (raw)
    _resetCorsPatterns();

    assert.strictEqual(isOriginAllowed('https://app.example.com'), true);
    assert.strictEqual(isOriginAllowed('https://d123.cloudfront.net'), true);
    // The hosting literal is escaped, so a dot-substituted variant must not match.
    assert.strictEqual(isOriginAllowed('https://d123xcloudfrontxnet'), false);
  });

  it('keeps the regex channel intact: CORS_ALLOWED_ORIGINS=.* alone allows anything', () => {
    process.env.CORS_ALLOWED_ORIGINS = '.*';
    _resetCorsPatterns();

    assert.strictEqual(isOriginAllowed('https://anything.test'), true);
  });

  it('splits multiple CORS_HOSTING_ORIGINS entries and trims surrounding whitespace', () => {
    process.env.CORS_HOSTING_ORIGINS = ' https://d1.cloudfront.net , https://d2.cloudfront.net ';
    _resetCorsPatterns();

    assert.strictEqual(isOriginAllowed('https://d1.cloudfront.net'), true);
    assert.strictEqual(isOriginAllowed('https://d2.cloudfront.net'), true);
    // Each entry is escaped, so a dot-substituted variant is rejected.
    assert.strictEqual(isOriginAllowed('https://d1xcloudfront.net'), false);
  });

  it('returns null when neither source is configured', () => {
    assert.strictEqual(getCorsPatterns(), null);
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
    assert.deepStrictEqual(headers, { Vary: 'Origin' });
  });

  it('never reflects an origin when no allowlist is configured', () => {
    const headers = buildCorsHeaders('https://evil.example.com');
    assert.strictEqual(headers['Access-Control-Allow-Origin'], undefined);
    assert.deepStrictEqual(headers, { Vary: 'Origin' });
  });

  it('returns no reflection headers when there is no origin', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://myapp\\.example\\.com';
    _resetCorsPatterns();

    assert.deepStrictEqual(buildCorsHeaders(''), { Vary: 'Origin' });
  });

  it('always sets Vary: Origin so shared caches key on the request origin', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://myapp\\.example\\.com';
    _resetCorsPatterns();

    assert.strictEqual(buildCorsHeaders('https://myapp.example.com').Vary, 'Origin');
    assert.strictEqual(buildCorsHeaders('https://evil.example.com').Vary, 'Origin');
    assert.strictEqual(buildCorsHeaders('').Vary, 'Origin');
  });

  it('warns only once per distinct disallowed origin', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://myapp\\.example\\.com';
    _resetCorsPatterns();

    const original = console.warn;
    const lines: string[] = [];
    console.warn = (msg: string) => { lines.push(msg); };
    try {
      buildCorsHeaders('https://evil.example.com');
      buildCorsHeaders('https://evil.example.com');
      buildCorsHeaders('https://evil.example.com');
      assert.strictEqual(lines.length, 1, 'repeat requests from one origin should warn once');

      buildCorsHeaders('https://other.example.com');
      assert.strictEqual(lines.length, 2, 'a distinct origin should still warn');
      assert.ok(lines[0].includes('https://evil.example.com'));
      assert.ok(lines[1].includes('https://other.example.com'));
    } finally {
      console.warn = original;
    }
  });

  it('does not warn for an allowed origin or an absent origin', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://myapp\\.example\\.com';
    _resetCorsPatterns();

    const original = console.warn;
    const lines: string[] = [];
    console.warn = (msg: string) => { lines.push(msg); };
    try {
      buildCorsHeaders('https://myapp.example.com');
      buildCorsHeaders('');
      assert.strictEqual(lines.length, 0);
    } finally {
      console.warn = original;
    }
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
    assert.strictEqual(
      result.headers['Access-Control-Allow-Headers'],
      `Content-Type, Authorization, ${CLIENT_USER_AGENT_HEADER}`,
    );
    assert.strictEqual(result.headers['Access-Control-Max-Age'], CORS_MAX_AGE);
    assert.strictEqual(result.headers['Vary'], 'Origin');
  });

  it('pins Access-Control-Max-Age at the browser preflight cap', () => {
    assert.strictEqual(CORS_MAX_AGE, '7200');
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

// ── CORS hosting origin (literal channel) ───────────────────────────────────

describe('createLambdaHandler — CORS hosting origin (literal channel)', () => {
  beforeEach(() => {
    process.env.CORS_ALLOWED_ORIGINS = '^https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?$';
    // Raw, unescaped resolved origin — CORS_HOSTING_ORIGINS is the literal
    // channel, escaped at runtime by getCorsPatterns() (not pre-escaped).
    process.env.CORS_HOSTING_ORIGINS = 'https://d111111abcdef8.cloudfront.net';
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

  it('escapes the literal origin dots (a dot-substituted variant is rejected 403)', async () => {
    // Proves CORS_HOSTING_ORIGINS is compiled as an escaped literal, not a regex:
    // the dots must match literally, so this single-char variant does NOT match.
    const result = await invoke(echoBackend, makeEvent({
      headers: { 'Content-Type': 'application/json', origin: 'https://d111111abcdef8xcloudfront.net' },
    }));
    assert.strictEqual(result.statusCode, 403);
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
