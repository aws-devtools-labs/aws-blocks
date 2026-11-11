// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The local dev server proxies the whole Blocks API (mock auth applies no
 * authentication) against the local mock datastore, so it must not be reachable
 * beyond the developer's machine by default. It used to `listen(port)` with no
 * host, which binds every interface.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDevHost, isLoopbackHost, isAllowedDevRequestHost } from './dev-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

  it('serves loopback Host headers on the default bind, with or without a port', () => {
    for (const h of ['localhost', 'localhost:3000', 'LOCALHOST:3000', '127.0.0.1:3000', '127.1.2.3', '[::1]:3000', '[::1]']) {
      assert.strictEqual(isAllowedDevRequestHost(h, '127.0.0.1', undefined), true, h);
    }
  });

  it('refuses a non-loopback, missing or malformed Host on the default bind', () => {
    for (const h of [undefined, '', 'evil.example', 'evil.example:3000', 'localhost.evil.example', '192.168.1.10:3000',
      'localhost@evil.example', 'evil.example/localhost', 'localhost:3000:3000', '[::1', 'local host']) {
      assert.strictEqual(isAllowedDevRequestHost(h, '127.0.0.1', undefined), false, String(h));
    }
  });

  it('serves the host configured with BLOCKS_DEV_HOST or the bind option, and only that one', () => {
    assert.strictEqual(isAllowedDevRequestHost('mybox.example.com:3000', 'mybox.example.com', undefined), true);
    assert.strictEqual(isAllowedDevRequestHost('MyBox.Example.com', '127.0.0.1', 'mybox.example.com'), true);
    assert.strictEqual(isAllowedDevRequestHost('10.0.0.5:3000', '10.0.0.5', undefined), true);
    assert.strictEqual(isAllowedDevRequestHost('[fd00::1]:3000', 'fd00::1', undefined), true);
    assert.strictEqual(isAllowedDevRequestHost('localhost:3000', 'mybox.example.com', undefined), true, 'loopback stays served');
    assert.strictEqual(isAllowedDevRequestHost('evil.example:3000', 'mybox.example.com', undefined), false);
    assert.strictEqual(isAllowedDevRequestHost('10.0.0.6:3000', '10.0.0.5', undefined), false);
  });

  it('with a wildcard bind, serves IP literals but not DNS names (a name can be rebound)', () => {
    for (const bind of ['0.0.0.0', '::']) {
      assert.strictEqual(isAllowedDevRequestHost('192.168.1.10:3000', bind, undefined), true, bind);
      assert.strictEqual(isAllowedDevRequestHost('[fd00::1]:3000', bind, undefined), true, bind);
      assert.strictEqual(isAllowedDevRequestHost('evil.example:3000', bind, undefined), false, bind);
    }
    assert.strictEqual(isAllowedDevRequestHost('mybox.example.com:3000', '0.0.0.0', 'mybox.example.com'), true,
      'a name opted into with BLOCKS_DEV_HOST is served alongside a wildcard bind');
  });

  it('a server bound to the default host is not listening on a wildcard address', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolveDevHost(undefined, {}), resolve));
    const { address } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.strictEqual(address, '127.0.0.1', 'must bind loopback, not a wildcard (:: / 0.0.0.0)');
  });
});

/**
 * Binding loopback is not enough on its own: a page on an attacker's origin can
 * re-point its own DNS name at 127.0.0.1 (DNS rebinding) and then drive the dev
 * server as a same-origin page. The browser still sends the attacker's name in
 * `Host`, so the dev server refuses any request whose `Host` isn't loopback (or
 * the host the developer explicitly configured) before it dispatches it.
 */
describe('dev server Host header check (DNS rebinding)', () => {
  let devProcess: ChildProcess | null = null;
  let tempDir = '';
  let port = 0;
  let output = '';

  function send(
    host: string | undefined,
    options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { ...options.headers };
      const req = httpRequest(
        { host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path ?? '/', headers, setHost: false },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
        },
      );
      if (host !== undefined) req.setHeader('Host', host);
      req.on('error', reject);
      req.end(options.body);
    });
  }

  const rpcBody = JSON.stringify({ jsonrpc: '2.0', method: 'testApi.ping', params: [], id: 1 });
  const rpc = (host: string | undefined, contentType = 'application/json') =>
    send(host, { method: 'POST', path: '/aws-blocks/api', headers: { 'Content-Type': contentType }, body: rpcBody });

  before(async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    tempDir = join(tmpdir(), `dev-host-check-${process.pid}-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'backend.ts'), `export const testApi = { ping: async () => 'pong' };\n`);
    writeFileSync(join(tempDir, 'run-dev.ts'), `
import { startDevServer } from ${JSON.stringify(join(__dirname, 'dev-server.js'))};
startDevServer(${JSON.stringify({ backendPath: join(tempDir, 'backend.ts'), port, typegen: false })});
`);
    const tsxBin = join(__dirname, '..', '..', '..', '..', 'node_modules', '.bin', 'tsx');
    const env: NodeJS.ProcessEnv = { ...process.env, AWS_BLOCKS_DISABLE_TELEMETRY: '1', BLOCKS_DEV_QUIET: '1', BLOCKS_API_URL: '' };
    delete env.BLOCKS_DEV_HOST;
    devProcess = spawn(tsxBin, [join(tempDir, 'run-dev.ts')], { cwd: tempDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    devProcess.stdout?.on('data', (c: Buffer) => { output += c.toString(); });
    devProcess.stderr?.on('data', (c: Buffer) => { output += c.toString(); });

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        if ((await rpc(`localhost:${port}`)).status === 200) return;
      } catch { /* not listening yet */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`dev server did not start:\n${output}`);
  });

  after(async () => {
    if (devProcess && devProcess.exitCode === null) {
      const exited = new Promise<void>((resolve) => devProcess?.once('exit', () => resolve()));
      devProcess.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
      if (devProcess.exitCode === null) devProcess.kill('SIGKILL');
    }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects a request whose Host is not loopback with 403', async () => {
    for (const host of ['evil.example', `evil.example:${port}`, `192.168.1.10:${port}`, `localhost.evil.example:${port}`]) {
      const res = await send(host, { path: '/some/page' });
      assert.strictEqual(res.status, 403, `GET with Host: ${host}`);
    }
  });

  it('refuses a rebinding-style text/plain POST with no Origin header before dispatch', async () => {
    const res = await rpc(`evil.example:${port}`, 'text/plain');
    assert.strictEqual(res.status, 403);
    assert.ok(!res.body.includes('pong'), `the RPC must not run: ${res.body}`);
  });

  it('rejects a preflight from a rebinding Host too', async () => {
    const res = await send(`evil.example:${port}`, { method: 'OPTIONS', path: '/aws-blocks/api' });
    assert.strictEqual(res.status, 403);
  });

  it('serves loopback hosts, with and without a port', async () => {
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, 'localhost', `LOCALHOST:${port}`]) {
      const res = await rpc(host);
      assert.strictEqual(res.status, 200, `RPC with Host: ${host}`);
      assert.match(res.body, /pong/, `RPC with Host: ${host}`);
    }
  });
});
