// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Real-process tests of the dev server's lifecycle: closed output, the
// singleton guard, port ownership and fatal startup failures. Each test runs
// `startDevServer` in its own app directory under `tsx` (optionally `tsx watch`,
// as `blocks dev` does) on free ports.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DevServerOptions } from './dev-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tsxCli = join(__dirname, '..', '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const posix = process.platform !== 'win32';

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  server.close();
  await once(server, 'close');
  return address.port;
}

/** Poll `check` until it returns a value; the only signal some of these real processes give. */
async function waitFor<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

interface DevRun {
  child: ChildProcess;
  out: { stdout: string; stderr: string };
  exited: Promise<number | null>;
}

const live: ChildProcess[] = [];
const dirs: string[] = [];

/** A minimal app: one API, run from its own directory (the dev server's pidfiles are cwd-relative). */
function makeApp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dev-lifecycle-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'backend.ts'), "export const testApi = { ping: async () => 'pong' };\n");
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dev-lifecycle-app', private: true, type: 'module' }));
  return dir;
}

function startDev(
  dir: string,
  options: Partial<DevServerOptions>,
  { watch = false, env = {} }: { watch?: boolean; env?: NodeJS.ProcessEnv } = {},
): DevRun {
  writeFileSync(
    join(dir, 'run-dev.ts'),
    `import { startDevServer } from ${JSON.stringify(join(__dirname, 'dev-server.js'))};\n` +
      `startDevServer(${JSON.stringify({ backendPath: join(dir, 'backend.ts'), typegen: false, ...options })});\n`,
  );
  const child = spawn(process.execPath, [tsxCli, ...(watch ? ['watch', '--clear-screen=false'] : []), 'run-dev.ts'], {
    cwd: dir,
    env: { ...process.env, AWS_BLOCKS_DISABLE_TELEMETRY: '1', BLOCKS_DEV_QUIET: '1', BLOCKS_LOG_LEVEL: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: posix,
  });
  live.push(child);
  const out = { stdout: '', stderr: '' };
  child.stdout?.on('data', (d) => { out.stdout += d; });
  child.stderr?.on('data', (d) => { out.stderr += d; });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, out, exited };
}

async function rpc(port: number): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}/aws-blocks/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'testApi.ping', params: [], id: 1 }),
    signal: AbortSignal.timeout(2000),
  });
  const body: unknown = await response.json();
  return body && typeof body === 'object' && 'result' in body ? body.result : undefined;
}

async function serving(port: number): Promise<boolean> {
  try {
    return (await rpc(port)) === 'pong';
  } catch {
    return false;
  }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  try {
    if (posix && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* already gone */ }
}

afterEach(async () => {
  for (const child of live.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      killGroup(child, 'SIGTERM');
      const timer = setTimeout(() => killGroup(child), 3000);
      await once(child, 'exit');
      clearTimeout(timer);
    }
    killGroup(child); // anything left in its group
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('dev server lifecycle', { skip: !posix && 'POSIX process groups' }, () => {
  it('keeps serving after its stdout and stderr readers go away (EPIPE)', async () => {
    const port = await freePort();
    // Request logging on, so every call writes to the closed stdout.
    const dev = startDev(makeApp(), { port }, { env: { BLOCKS_DEV_QUIET: '' } });
    await waitFor('the server to start', () => dev.out.stdout.includes('local server running'));
    dev.child.stdout?.destroy();
    dev.child.stderr?.destroy();
    for (let i = 0; i < 3; i++) assert.strictEqual(await rpc(port), 'pong');
    assert.strictEqual(dev.child.exitCode, null, 'the dev server is still running');
  });
});
