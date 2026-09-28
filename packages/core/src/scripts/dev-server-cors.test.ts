// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveDevCorsOrigin, LOCALHOST_PATTERN, buildDevCorsHeaders } from './dev-server.js';
import { CORS_MAX_AGE } from '../cors.js';

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
});
