// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  parseCorsPatterns,
  escapeOriginToPattern,
  getCorsPatterns,
  isOriginAllowed,
  _resetCorsPatterns,
  buildCorsHeaders,
  CORS_MAX_AGE,
  validateAllowedOrigins,
  validateCorsOriginEntry,
} from './cors.js';
import { BlocksPresets } from './cdk/blocks-defaults.js';
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

  it('drops an entry that is not a valid regex (it never matches) and logs it once', () => {
    _resetCorsPatterns();
    const original = console.error;
    const lines: string[] = [];
    console.error = (msg: string) => { lines.push(msg); };
    try {
      const patterns = parseCorsPatterns('https://[invalid,https://a\\.com');
      assert.strictEqual(patterns.length, 1, 'only the valid entry is compiled');
      assert.ok(!patterns.some(re => re.test('https://[invalid')));
      assert.ok(patterns[0].test('https://a.com'));
      parseCorsPatterns('https://[invalid');
      assert.strictEqual(lines.length, 1, 'the same bad entry is reported once');
      assert.match(lines[0], /https:\/\/\[invalid/);
      assert.match(lines[0], /defaults\.allowedOrigins/);
    } finally {
      console.error = original;
      _resetCorsPatterns();
    }
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

// ── plain origins (matched exactly) ─────────────────────────────────────────

describe('parseCorsPatterns — plain origins', () => {
  beforeEach(() => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.CORS_HOSTING_ORIGINS;
    _resetCorsPatterns();
  });

  it('matches a plain origin exactly: its dots are literal', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com';
    _resetCorsPatterns();

    assert.strictEqual(isOriginAllowed('https://app.example.com'), true);
    assert.strictEqual(isOriginAllowed('https://appxexample.com'), false);
    assert.strictEqual(isOriginAllowed('https://app-example.com'), false);
    assert.strictEqual(isOriginAllowed('https://app.examplexcom'), false);
    assert.strictEqual(isOriginAllowed('https://app.example.com.other'), false);
  });

  it('matches a plain origin case-insensitively', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com';
    _resetCorsPatterns();

    assert.strictEqual(isOriginAllowed('https://APP.Example.com'), true);
  });

  it('emits no grant headers for a dot-substituted variant of a plain origin', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com';
    _resetCorsPatterns();

    const original = console.warn;
    console.warn = () => {};
    try {
      const headers = buildCorsHeaders('https://appxexample.com');
      assert.strictEqual(headers['Access-Control-Allow-Origin'], undefined);
      assert.strictEqual(headers['Access-Control-Allow-Credentials'], undefined);
    } finally {
      console.warn = original;
    }
  });

  it('accepts a port and drops a trailing slash', () => {
    const patterns = parseCorsPatterns('http://localhost:3000/');
    assert.strictEqual(patterns.length, 1);
    assert.ok(patterns[0].test('http://localhost:3000'));
    assert.ok(!patterns[0].test('http://localhost:30000'));
    assert.ok(!patterns[0].test('http://localhost:3000/'));
  });

  it('matches a bracketed IPv6 origin literally', () => {
    const patterns = parseCorsPatterns('http://[::1]:3000');
    assert.strictEqual(patterns.length, 1);
    assert.ok(patterns[0].test('http://[::1]:3000'));
    assert.ok(!patterns[0].test('http://1:3000'));
    assert.ok(!patterns[0].test('http://[::1]:30000'));
  });

  it('treats an entry with a path as a regex pattern, not a plain origin', () => {
    // `/x` is not part of an origin, so the entry goes through the regex path,
    // where its unescaped dot makes it invalid and it is dropped.
    const original = console.error;
    console.error = () => {};
    try {
      assert.strictEqual(parseCorsPatterns('https://app.example.com/x').length, 0);
    } finally {
      console.error = original;
    }
  });
});

// ── unbalanced / unescaped entries fail closed at runtime ───────────────────

describe('getCorsPatterns — invalid regex entries are dropped', () => {
  beforeEach(() => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.CORS_HOSTING_ORIGINS;
    _resetCorsPatterns();
  });

  it('drops an unbalanced-group entry instead of letting it close the wrapper group', () => {
    const originalError = console.error;
    const lines: string[] = [];
    console.error = (msg: string) => { lines.push(msg); };
    try {
      process.env.CORS_ALLOWED_ORIGINS = 'a)|(?:.*';
      _resetCorsPatterns();
      assert.strictEqual(isOriginAllowed('https://anything.test'), false);
      assert.deepStrictEqual(getCorsPatterns(), [], 'a configured allowlist with no valid entries matches nothing');
      assert.strictEqual(lines.length, 1);
    } finally {
      console.error = originalError;
    }
  });

  it('rejects cross-origin requests with 403 when every configured entry is dropped', async () => {
    const originalError = console.error;
    const originalWarn = console.warn;
    console.error = () => {};
    console.warn = () => {};
    try {
      process.env.CORS_ALLOWED_ORIGINS = 'a)|(?:.*';
      _resetCorsPatterns();
      clearRouteRegistry();
      const backend = {
        api: (_ctx: any) => ({
          async echo(msg: string) { return { msg }; },
        }),
      };
      const handler = createLambdaHandler(async () => backend);
      const result = await handler({
        httpMethod: 'POST',
        path: '/aws-blocks/api',
        headers: { 'Content-Type': 'application/json', origin: 'https://x.test' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'api.echo', params: ['hello'], id: 1 }),
        isBase64Encoded: false,
      }) as any;
      assert.strictEqual(result.statusCode, 403);
      assert.strictEqual(JSON.parse(result.body).error, 'Forbidden: cross-origin request rejected');
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
    }
  });

  it('drops a regex with an unescaped dot and keeps the valid entries', () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      process.env.CORS_ALLOWED_ORIGINS = '^https://app.example\\.com$,https://ok\\.example\\.com';
      _resetCorsPatterns();
      assert.strictEqual(isOriginAllowed('https://app.example.com'), false);
      assert.strictEqual(isOriginAllowed('https://appxexample.com'), false);
      assert.strictEqual(isOriginAllowed('https://ok.example.com'), true);
    } finally {
      console.error = originalError;
    }
  });
});

// ── validateCorsOriginEntry / validateAllowedOrigins ────────────────────────

describe('validateCorsOriginEntry', () => {
  const valid = [
    'https://app.example.com',
    'http://localhost:3000',
    'https://app.example.com/',
    'https://app\\.example\\.com',
    '^https://app\\.example\\.com$',
    '.*',
    'https://.*\\.example\\.com',
    'https://.+\\.example\\.com',
    'https://a.?b\\.com',
    'https://x.{2}\\.com',
    'http://[::1]:3000',
    'https://[2001:db8::1]',
    'https://app[.]example[.]com',
    '^https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?$',
    '^https://foo\\$',
    ...BlocksPresets.sandbox.allowedOrigins,
    ...BlocksPresets.production.allowedOrigins,
  ];
  for (const entry of valid) {
    it(`accepts ${JSON.stringify(entry)}`, () => {
      assert.strictEqual(validateCorsOriginEntry(entry), undefined);
    });
  }

  const invalid: Array<[string, RegExp]> = [
    ['a)|(?:.*', /not a valid regular expression/],
    ['https://[invalid', /not a valid regular expression/],
    ['^https://app.example\\.com$', /unescaped '\.'/],
    ['https://(a|b).example\\.com', /unescaped '\.'/],
    // An escaped backslash does not escape the dot after it.
    ['https://app\\\\.example\\.com', /unescaped '\.'/],
    // A dot after a closed character class is a wildcard again.
    ['https://[a]b.c\\.com', /unescaped '\.'/],
    ['https://a\\.com,https://b\\.com', /comma/],
    // A `{` that does not open a quantifier is a literal brace, so the dot is bare.
    ['https://a.{x}', /unescaped '\.'/],
  ];
  for (const [entry, problem] of invalid) {
    it(`rejects ${JSON.stringify(entry)}`, () => {
      const message = validateCorsOriginEntry(entry);
      assert.ok(message, 'expected an error message');
      assert.match(message, problem);
      assert.ok(message.includes(`"${entry}"`), 'the message names the entry');
      assert.match(message, /defaults\.allowedOrigins/);
    });
  }
});

describe('validateAllowedOrigins', () => {
  it('accepts both presets', () => {
    validateAllowedOrigins(BlocksPresets.sandbox.allowedOrigins);
    validateAllowedOrigins(BlocksPresets.production.allowedOrigins);
  });

  it('skips empty and whitespace-only entries', () => {
    validateAllowedOrigins(['', '   ', 'https://app.example.com']);
  });

  it('throws one Error listing every invalid entry', () => {
    assert.throws(
      () => validateAllowedOrigins(['https://ok.example.com', 'a)|(?:.*', '^https://app.example\\.com$']),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.ok(e.message.includes('"a)|(?:.*"'));
        assert.ok(e.message.includes('"^https://app.example\\.com$"'));
        assert.ok(!e.message.includes('"https://ok.example.com"'));
        return true;
      },
    );
  });

  it('rejects a non-string entry from an untyped caller', () => {
    assert.throws(() => validateAllowedOrigins([42]), /must be a string/);
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

  it('matches a mixed-case hosting literal case-insensitively (ALB DNS vs lowercase browser Origin)', () => {
    // An ALB's DNS name is case-preserving (`stress-Hosti-AbCd…`) but the browser
    // lowercases it in the Origin header; a case-sensitive match 403'd sign-in on
    // the ALB front door.
    process.env.CORS_HOSTING_ORIGINS = 'http://blocks-Hosti-AbCdEf-123.us-west-2.elb.amazonaws.com';
    _resetCorsPatterns();

    assert.strictEqual(isOriginAllowed('http://blocks-hosti-abcdef-123.us-west-2.elb.amazonaws.com'), true);
    // Still escaped: case-insensitivity must not loosen the literal match.
    assert.strictEqual(isOriginAllowed('http://blocks-hosti-abcdef-123xus-west-2.elb.amazonaws.com'), false);
  });

  it("leaves the user's regex channel (CORS_ALLOWED_ORIGINS) case-sensitive, as released", () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://App\\.Example\\.com';
    _resetCorsPatterns();

    assert.strictEqual(isOriginAllowed('https://app.example.com'), false);
    assert.strictEqual(isOriginAllowed('https://App.Example.com'), true);
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
      assert.match(lines[0], /defaults\.allowedOrigins/, 'the warning points at the stack default to fix it');

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
