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
  windowsTreeKill,
  type KillableProcess,
} from './dev-server.js';

const isWindows = process.platform === 'win32';
// The real-process integration test spawns OS processes and depends on
// wall-clock timing; gate it behind RUN_SLOW_TESTS so the default test run
// stays deterministic and fast. The pure unit tests below always run.
const runSlowTests = !!process.env.RUN_SLOW_TESTS;

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

// Poll across a bounded window, returning false the instant the port closes.
// More robust than a single post-`delay` snapshot on a busy/slow host: it
// asserts the port stays bound for the whole window rather than at one moment.
async function staysOpen(port: number, windowMs: number): Promise<boolean> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    if (!(await isPortOpen(port))) return false;
    await delay(50);
  }
  return true;
}

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

  it('reaps the tree via taskkill on Windows (no POSIX group, no direct kill)', () => {
    const { child, calls } = makeChild(4242);
    let groupCalled = false;
    const winPids: number[] = [];
    killFrontendTree(child, 'SIGTERM', 'win32',
      () => { groupCalled = true; },
      (pid) => { winPids.push(pid); return true; });
    assert.strictEqual(groupCalled, false);  // POSIX group kill not used on Windows
    assert.deepStrictEqual(winPids, [4242]); // taskkill tree-kill invoked with the pid
    assert.deepStrictEqual(calls, []);       // no direct child.kill once taskkill succeeded
  });

  it('falls back to a direct child kill on Windows when taskkill cannot run', () => {
    const { child, calls } = makeChild(4242);
    killFrontendTree(child, 'SIGTERM', 'win32',
      () => {},
      () => false); // taskkill unavailable → must degrade to child.kill
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

// ── windowsTreeKill (unit, injected runner) ─────────────────────────────────
describe('windowsTreeKill — taskkill tree-kill command', () => {
  it('invokes `taskkill /T /F /PID <pid>` and reports success', () => {
    const runs: Array<[string, readonly string[]]> = [];
    const ok = windowsTreeKill(4242, (cmd, args) => { runs.push([cmd, args]); return { status: 0 }; });
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(runs, [['taskkill', ['/T', '/F', '/PID', '4242']]]);
  });

  it('treats an already-gone tree (non-zero exit, no spawn error) as handled', () => {
    const ok = windowsTreeKill(4242, () => ({ status: 128 })); // 128 = "process not found"
    assert.strictEqual(ok, true);
  });

  it('reports failure when taskkill cannot be spawned (caller then falls back)', () => {
    const ok = windowsTreeKill(4242, () => ({ status: null, error: new Error('ENOENT') }));
    assert.strictEqual(ok, false);
  });

  it('never throws even if the runner throws', () => {
    const ok = windowsTreeKill(4242, () => { throw new Error('boom'); });
    assert.strictEqual(ok, false);
  });
});

// ── killFrontendTree (integration, real shell + grandchild) ─────────────────
// Opt-in: spawns real OS processes and relies on wall-clock timing, so it is
// gated behind RUN_SLOW_TESTS to keep the default `npm test` deterministic.
// POSIX-only because it asserts process-group reaping.
const integrationSkip = !runSlowTests
  ? 'set RUN_SLOW_TESTS=1 to run (spawns real processes)'
  : isWindows
    ? 'POSIX-only (relies on process groups)'
    : false;

describe('killFrontendTree — reaps a real detached shell tree', { skip: integrationSkip }, () => {
  it('frees a port held by a grandchild that survives a direct child kill',
    { timeout: 30000 },
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
        // Poll across a bounded window instead of a single post-`delay`
        // snapshot so a slow/busy host can't race the assertion.
        assert.ok(await staysOpen(port, 600),
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
