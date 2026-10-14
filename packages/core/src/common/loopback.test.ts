// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isLoopbackHost, isWildcardHost, isIpLiteral } from './loopback.js';
import { isLoopbackHost as devServerIsLoopbackHost } from '../scripts/dev-server.js';

describe('shared host classification (dev-server bind + realtime Origin check)', () => {
  it('isLoopbackHost accepts bare and bracketed forms alike, plus IPv4-mapped loopback', () => {
    for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '::ffff:127.0.0.1', '[::ffff:127.0.0.1]']) {
      assert.strictEqual(isLoopbackHost(h), true, h);
    }
    for (const h of ['0.0.0.0', '::', '[::]', '128.0.0.1', '192.168.1.10', '::ffff:10.0.0.1', 'localhost.evil.example', 'example.com']) {
      assert.strictEqual(isLoopbackHost(h), false, h);
    }
  });

  it('the dev server uses the same definition (no second classifier to drift)', () => {
    assert.strictEqual(devServerIsLoopbackHost, isLoopbackHost);
  });

  it('isWildcardHost', () => {
    for (const h of ['0.0.0.0', '::', '[::]']) assert.strictEqual(isWildcardHost(h), true, h);
    for (const h of ['127.0.0.1', '::1', 'example.com']) assert.strictEqual(isWildcardHost(h), false, h);
  });

  it('isIpLiteral distinguishes addresses from DNS names', () => {
    for (const h of ['192.168.1.10', '10.0.0.5', '[fd00::1]', 'fd00::1', '::1']) assert.strictEqual(isIpLiteral(h), true, h);
    for (const h of ['evil.example', 'mybox.example.com', '999.1.1.1', 'localhost']) assert.strictEqual(isIpLiteral(h), false, h);
  });
});
