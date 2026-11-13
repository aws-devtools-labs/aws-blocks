// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopDevServer, devPidfilePath, isPidAlive } from './dev-server.js';
import { BLOCKS_SANDBOX_DIR } from '../common/constants.js';

// The behaviour unit tests cannot catch (killTree/signal are injected there):
// a REAL `tsx watch` supervisor must be fully gone after stopDevServer, not just
// its listener child — otherwise the watcher relaunches the server on the next
// edit (the bug this PR fixes). Spawns OS processes and depends on wall-clock
// timing, so it is gated behind RUN_SLOW_TESTS to keep the default run fast and
// deterministic — the same gate dev-server-supervisor.test.ts uses.
const runSlow = !!process.env.RUN_SLOW_TESTS;
const isWindows = process.platform === 'win32';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: '127.0.0.1' }, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => { sock.destroy(); resolve(false); });
    sock.setTimeout(300, () => { sock.destroy(); resolve(false); });
  });
}

async function waitFor(pred: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return Promise.resolve(pred());
}

describe('stopDevServer — real tsx watch supervisor (RUN_SLOW_TESTS)', () => {
  it('terminates BOTH the watcher and the listener child', { skip: !runSlow || isWindows }, async () => {
    const port = await getFreePort();
    const dir = mkdtempSync(join(tmpdir(), 'blocks-stop-'));
    // A minimal server that binds the port and writes the pidfile exactly like
    // startDevServer does: {pid: self, ppid: the tsx watch watcher, port}.
    const serverTs = join(dir, 'server.ts');
    writeFileSync(
      serverTs,
      [
        `import { createServer } from 'node:net';`,
        `import { writeFileSync, mkdirSync } from 'node:fs';`,
        `import { join } from 'node:path';`,
        `const port = ${port};`,
        `const dir = ${JSON.stringify(BLOCKS_SANDBOX_DIR)};`,
        `mkdirSync(dir, { recursive: true });`,
        `writeFileSync(join(dir, 'dev-server.' + port + '.pid'), JSON.stringify({ pid: process.pid, ppid: process.ppid, port }));`,
        `const srv = createServer((s) => s.end());`,
        `srv.listen(port, '127.0.0.1');`,
        `process.on('SIGTERM', () => { try { srv.close(); } catch {} process.exit(0); });`,
        `setInterval(() => {}, 1 << 30);`,
      ].join('\n'),
      'utf-8',
    );

    // Spawn the real `tsx watch` supervisor via the workspace's tsx bin.
    const child = spawn('npx', ['tsx', 'watch', serverTs], {
      cwd: process.cwd(),
      stdio: 'ignore',
      detached: false,
    });
    const watcherPid = child.pid!;

    try {
      // Wait for the server to bind and record its pidfile.
      const up = await waitFor(() => portOpen(port), 20000);
      assert.ok(up, 'the dev server should bind the port');

      await stopDevServer(port);

      // The port must stay free (watcher cannot relaunch) and the watcher gone.
      const stayedFree = await waitFor(async () => !(await portOpen(port)), 8000);
      assert.ok(stayedFree, 'port must be free after stop');
      // Give tsx a moment to exit, then assert the watcher is dead.
      const watcherGone = await waitFor(() => !isPidAlive(watcherPid), 8000);
      assert.ok(watcherGone, 'the tsx watch supervisor must be terminated, not just its child');
    } finally {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      try { rmSync(devPidfilePath(port), { force: true }); } catch { /* ignore */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
