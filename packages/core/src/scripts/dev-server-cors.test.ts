// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveDevCorsOrigin, LOCALHOST_PATTERN, buildDevCorsHeaders, devUrlHost } from './dev-server.js';
import { CORS_MAX_AGE } from '../cors.js';
import { CLIENT_USER_AGENT_HEADER } from '../constants.js';

describe('resolveDevCorsOrigin — dev server CORS', () => {
  it('reflects localhost origin back as-is', () => {
    assert.strictEqual(resolveDevCorsOrigin('http://localhost:3000'), 'http://localhost:3000');
  });

  it('reflects 127.0.0.1 origin back as-is', () => {
    assert.strictEqual(resolveDevCorsOrigin('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  });

  it('returns fallback http://localhost:3000 for non-localhost origin', () => {
    assert.strictEqual(resolveDevCorsOrigin('https://evil.com'), 'http://localhost:3000');
  });

  it('returns fallback http://localhost:3000 when origin is empty', () => {
    assert.strictEqual(resolveDevCorsOrigin(''), 'http://localhost:3000');
  });

  it('rejects subdomain impersonation (evil.localhost)', () => {
    assert.strictEqual(LOCALHOST_PATTERN.test('http://localhost.evil.com'), false);
    assert.strictEqual(resolveDevCorsOrigin('http://localhost.evil.com'), 'http://localhost:3000');
  });
});

describe('buildDevCorsHeaders — dev server header set', () => {
  it('shares one Max-Age value with the Lambda path so the two cannot drift', () => {
    assert.strictEqual(buildDevCorsHeaders('http://localhost:3000')['Access-Control-Max-Age'], CORS_MAX_AGE);
  });

  it('sets Vary: Origin because Allow-Origin is reflected per request', () => {
    assert.strictEqual(buildDevCorsHeaders('http://localhost:3000')['Vary'], 'Origin');
    assert.strictEqual(buildDevCorsHeaders('https://evil.com')['Vary'], 'Origin');
  });

  it('reflects an allowed localhost origin', () => {
    const headers = buildDevCorsHeaders('http://127.0.0.1:5173');
    assert.strictEqual(headers['Access-Control-Allow-Origin'], 'http://127.0.0.1:5173');
    assert.strictEqual(headers['Access-Control-Allow-Credentials'], 'true');
  });

  it('does not reflect a non-localhost origin', () => {
    assert.strictEqual(
      buildDevCorsHeaders('https://evil.com')['Access-Control-Allow-Origin'],
      'http://localhost:3000'
    );
  });

  it('allows the same headers as the Lambda path so a browser client works in both', () => {
    assert.strictEqual(
      buildDevCorsHeaders('http://localhost:3000')['Access-Control-Allow-Headers'],
      `Content-Type, Authorization, ${CLIENT_USER_AGENT_HEADER}`,
    );
  });
});

describe('resolveDevCorsOrigin — the bound host and port', () => {
  const lan = { host: '10.253.66.118', port: 41083 };

  it("falls back to the server's own origin, not a hard-coded :3000", () => {
    assert.strictEqual(resolveDevCorsOrigin('https://evil.com', { host: '127.0.0.1', port: 4000 }), 'http://localhost:4000');
    assert.strictEqual(resolveDevCorsOrigin('https://evil.com', lan), 'http://10.253.66.118:41083');
  });

  it('reflects an origin on the specific host the server binds, on any port', () => {
    assert.strictEqual(resolveDevCorsOrigin('http://10.253.66.118:41083', lan), 'http://10.253.66.118:41083');
    assert.strictEqual(resolveDevCorsOrigin('http://10.253.66.118:5173', lan), 'http://10.253.66.118:5173');
  });

  it('does not reflect look-alikes of the bound host', () => {
    for (const origin of ['http://10.253.66.118.evil.com', 'http://10.253.66.1180:80', 'http://user@10.253.66.118', 'null']) {
      assert.strictEqual(resolveDevCorsOrigin(origin, lan), 'http://10.253.66.118:41083', origin);
    }
  });

  it('reflects no extra origins for an all-interfaces bind', () => {
    assert.strictEqual(resolveDevCorsOrigin('http://192.168.1.9:3000', { host: '0.0.0.0', port: 3000 }), 'http://localhost:3000');
  });

  it('keeps reflecting localhost origins whatever the bind', () => {
    assert.strictEqual(resolveDevCorsOrigin('http://localhost:5173', lan), 'http://localhost:5173');
    assert.strictEqual(buildDevCorsHeaders('http://10.253.66.118:5173', lan)['Access-Control-Allow-Origin'], 'http://10.253.66.118:5173');
  });
});

describe('devUrlHost', () => {
  it('names loopback and wildcard binds localhost, and keeps any other host', () => {
    assert.strictEqual(devUrlHost('127.0.0.1'), 'localhost');
    assert.strictEqual(devUrlHost('::1'), 'localhost');
    assert.strictEqual(devUrlHost('0.0.0.0'), 'localhost');
    assert.strictEqual(devUrlHost('10.0.0.5'), '10.0.0.5');
    assert.strictEqual(devUrlHost('fd00::5'), '[fd00::5]');
    assert.strictEqual(devUrlHost('[fd00::5]'), '[fd00::5]');
    assert.strictEqual(devUrlHost('devbox.local'), 'devbox.local');
  });
});
