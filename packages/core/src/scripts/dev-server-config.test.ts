// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildBlocksConfig, isBlocksConfigRequest } from './dev-server.js';

describe('buildBlocksConfig — client runtime config', () => {
  it('points the browser at the localhost front door RPC endpoint', () => {
    assert.deepStrictEqual(buildBlocksConfig(3000, false), {
      apiUrl: 'http://localhost:3000/aws-blocks/api',
      environment: 'local',
    });
  });

  it('honors a custom port', () => {
    assert.strictEqual(buildBlocksConfig(4000, false).apiUrl, 'http://localhost:4000/aws-blocks/api');
  });

  it('marks the environment as sandbox but keeps the localhost front door', () => {
    assert.deepStrictEqual(buildBlocksConfig(3000, true), {
      apiUrl: 'http://localhost:3000/aws-blocks/api',
      environment: 'sandbox',
    });
  });
});

describe('isBlocksConfigRequest — reserved runtime-config path', () => {
  it('matches GET /.blocks-sandbox/config.json', () => {
    assert.strictEqual(isBlocksConfigRequest('GET', '/.blocks-sandbox/config.json'), true);
  });

  it('ignores non-GET methods (only the static-style read is reserved)', () => {
    assert.strictEqual(isBlocksConfigRequest('POST', '/.blocks-sandbox/config.json'), false);
    assert.strictEqual(isBlocksConfigRequest('HEAD', '/.blocks-sandbox/config.json'), false);
  });

  it('does not match other paths (frontend/app routes pass through to the proxy)', () => {
    assert.strictEqual(isBlocksConfigRequest('GET', '/'), false);
    assert.strictEqual(isBlocksConfigRequest('GET', '/api/chat'), false);
    assert.strictEqual(isBlocksConfigRequest('GET', '/.blocks-sandbox/other.json'), false);
    assert.strictEqual(isBlocksConfigRequest('GET', '/aws-blocks/api'), false);
  });
});
