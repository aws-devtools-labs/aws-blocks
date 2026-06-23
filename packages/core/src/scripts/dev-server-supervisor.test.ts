// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import {
  evaluateFrontendRespawn,
  DEFAULT_FRONTEND_RESPAWN_POLICY,
  killFrontendTree,
  type KillableProcess,
} from './dev-server.js';

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

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: '127.0.0.1' }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => { sock.destroy(); resolve(false); });
    sock.setTimeout(300, () => { sock.destroy(); resolve(false); });
  });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── evaluateFrontendRespawn ────────────────────────────────────────────────
describe('evaluateFrontendRespawn — bounded auto-respawn policy', () => {
  it('allows the first restart with the base backoff', () => {
    const now = 1_000_000;
    const d = evaluateFrontendRespawn([], now);
    assert.strictEqual(d.restart, true);
    assert.strictEqual(d.delayMs, DEFAULT_FRONTEND_RESPAWN_POLICY.backoffMs);
    assert.deepStrictEqual(d.recent, [now]);
  });

  it('backs off exponentially with the number of recent restarts', () => {
    const now = 1_000_000;
    // one recent restart already → 500 * 2^1
    assert.strictEqual(evaluateFrontendRespawn([now - 100], now).delayMs, 1000);
    // three recent → 500 * 2^3
    assert.strictEqual(evaluateFrontendRespawn([now - 30, now - 20, now - 10], now).delayMs, 4000);
  });

  it('caps the backoff at maxBackoffMs', () => {
    const now = 1_000_000;
    // four recent → 500 * 2^4 = 8000, capped to 5000
    const d = evaluateFrontendRespawn([now - 4, now - 3, now - 2, now - 1], now);
    assert.strictEqual(d.restart, true);
    assert.strictEqual(d.delayMs, DEFAULT_FRONTEND_RESPAWN_POLICY.maxBackoffMs);
  });

  it('stops restarting once the budget within the window is exhausted', () => {
    const now = 1_000_000;
    const recent = [now - 5, now - 4, now - 3, now - 2, now - 1]; // 5 == maxRestarts
    const d = evaluateFrontendRespawn(recent, now);
    assert.strictEqual(d.restart, false);
    assert.strictEqual(d.delayMs, 0);
    assert.strictEqual(d.recent.length, DEFAULT_FRONTEND_RESPAWN_POLICY.maxRestarts);
  });

  it('forgets restarts that fall outside the sliding window', () => {
    const now = 1_000_000;
    const { windowMs } = DEFAULT_FRONTEND_RESPAWN_POLICY;
    const recent = [
      now - windowMs - 1, // stale
      now - windowMs - 2, // stale
      now - windowMs - 3, // stale
      now - windowMs - 4, // stale
      now - 100,          // in-window
    ];
    const d = evaluateFrontendRespawn(recent, now);
    assert.strictEqual(d.restart, true);
    // only the one in-window timestamp survives → backoff 500 * 2^1
    assert.strictEqual(d.delayMs, 1000);
    assert.deepStrictEqual(d.recent, [now - 100, now]);
  });

  it('honors a custom policy', () => {
    const now = 0;
    const policy = { maxRestarts: 1, windowMs: 1000, backoffMs: 100, maxBackoffMs: 200 };
    assert.strictEqual(evaluateFrontendRespawn([], now, policy).delayMs, 100);
    assert.strictEqual(evaluateFrontendRespawn([now], now, policy).restart, false);
  });
});

// ── killFrontendTree (unit, injected spies) ─────────────────────────────────
describe('killFrontendTree — signal routing', () => {
  function makeChild(pid: number | undefined) {
    const calls: Array<NodeJS.Signals | number | undefined> = [];
    const child: KillableProcess = {
      pid,
      kill(signal) { calls.push(signal); return true; },
    };
    return { child, calls };
  }

  it('signals the whole process group on POSIX (negative pid)', () => {
    const { child, calls } = makeChild(4242);
    const groupCalls: Array<[number, NodeJS.Signals]> = [];
    killFrontendTree(child, 'SIGTERM', 'linux', (pid, sig) => { groupCalls.push([pid, sig]); });
    assert.deepStrictEqual(groupCalls, [[-4242, 'SIGTERM']]);
    assert.deepStrictEqual(calls, []); // direct child.kill not used on POSIX
  });

  it('falls back to a direct child kill on Windows (no process groups)', () => {
    const { child, calls } = makeChild(4242);
    let groupCalled = false;
    killFrontendTree(child, 'SIGTERM', 'win32', () => { groupCalled = true; });
    assert.strictEqual(groupCalled, false);
    assert.deepStrictEqual(calls, ['SIGTERM']);
  });

  it('falls back to a direct child kill when the group signal throws', () => {
    const { child, calls } = makeChild(4242);
    killFrontendTree(child, 'SIGKILL', 'linux', () => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    assert.deepStrictEqual(calls, ['SIGKILL']);
  });

  it('uses a direct child kill when there is no pid', () => {
    const { child, calls } = makeChild(undefined);
    let groupCalled = false;
    killFrontendTree(child, 'SIGTERM', 'linux', () => { groupCalled = true; });
    assert.strictEqual(groupCalled, false);
    assert.deepStrictEqual(calls, ['SIGTERM']);
  });

  it('never group-signals pid <= 1 (defensive)', () => {
    const { child, calls } = makeChild(1);
    let groupCalled = false;
    killFrontendTree(child, 'SIGTERM', 'linux', () => { groupCalled = true; });
    assert.strictEqual(groupCalled, false);
    assert.deepStrictEqual(calls, ['SIGTERM']);
  });
});

// ── killFrontendTree (integration, real shell + grandchild) ─────────────────
describe('killFrontendTree — reaps a real detached shell tree', () => {
  it('frees a port held by a grandchild that survives a direct child kill',
    { skip: isWindows, timeout: 30000 },
    async () => {
      const port = await getFreePort();
      const inner =
        `const net=require('net');` +
        `const s=net.createServer(c=>c.destroy());` +
        `s.on('error',()=>process.exit(1));` +
        `s.listen(${port},'127.0.0.1');` +
        `setInterval(()=>{},1e9);`;
      // Run node as a backgrounded child of the shell (then `wait`): this gives
      // the shell→node parent/grandchild topology of `shell: true` without any
      // exec-optimization. SIGTERM to the shell does NOT propagate to the
      // backgrounded node, so the node is orphaned and keeps the port — exactly
      // the leak the fix must reap via a process-group kill.
      const cmd = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(inner)} & wait`;
      const child = spawn(cmd, { shell: true, detached: true, stdio: 'ignore' });

      try {
        assert.ok(await waitFor(() => isPortOpen(port), 10000),
          'frontend grandchild should bind the port');

        // Direct kill of only the shell parent (what the old cleanup did): the
        // backgrounded node grandchild is orphaned, survives, and keeps the
        // port bound — this is exactly the :3100 502 leak.
        child.kill('SIGTERM');
        await delay(600);
        assert.strictEqual(await isPortOpen(port), true,
          'direct child kill must NOT free the port (demonstrates the orphan bug)');

        // Group kill reaps the entire tree and frees the port — the fix.
        killFrontendTree(child, 'SIGKILL');
        assert.ok(await waitFor(async () => !(await isPortOpen(port)), 10000),
          'group kill must free the port (the fix)');
      } finally {
        // Belt-and-suspenders: never leak the node grandchild if an assert throws.
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
      }
    });
});
