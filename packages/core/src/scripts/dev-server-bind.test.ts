// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The local dev server proxies the whole Blocks API (mock auth applies no
 * authentication) against the local mock datastore, so it must not be reachable
 * beyond the developer's machine by default. It used to `listen(port)` with no
 * host, which binds every interface.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolveDevHost, isLoopbackHost } from './dev-server.js';

describe('dev server bind host', () => {
  it('defaults to IPv4 loopback', () => {
    assert.strictEqual(resolveDevHost(undefined, {}), '127.0.0.1');
  });

  it('honors an explicit option, then BLOCKS_DEV_HOST (container / remote devbox opt-in)', () => {
    assert.strictEqual(resolveDevHost('0.0.0.0', { BLOCKS_DEV_HOST: '127.0.0.1' }), '0.0.0.0');
    assert.strictEqual(resolveDevHost(undefined, { BLOCKS_DEV_HOST: '0.0.0.0' }), '0.0.0.0');
    assert.strictEqual(resolveDevHost(undefined, { BLOCKS_DEV_HOST: '  ' }), '127.0.0.1', 'blank env falls back to loopback');
  });

  it('classifies loopback hosts', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', '::1', 'localhost', '[::1]']) assert.strictEqual(isLoopbackHost(h), true, h);
    for (const h of ['0.0.0.0', '::', '192.168.1.10', 'example.com']) assert.strictEqual(isLoopbackHost(h), false, h);
  });

  it('a server bound to the default host is not listening on a wildcard address', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolveDevHost(undefined, {}), resolve));
    const { address } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.strictEqual(address, '127.0.0.1', 'must bind loopback, not a wildcard (:: / 0.0.0.0)');
  });
});
