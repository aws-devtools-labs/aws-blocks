// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:net';
import {
  reclaimPort,
  evaluatePortBindRetry,
  DEFAULT_PORT_BIND_RETRY_POLICY,
  evaluateSingleton,
  parsePidRecord,
  isPidAlive,
  isPortOpen,
  type DevServerPidRecord,
} from './dev-server.js';
import { findListenerPids, killListenerTree } from './process-tree.js';

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

// ── reclaimPort — startup / EADDRINUSE port reclaim policy ──────────────────
// Fully injected: no real processes are spawned. `probe` is scripted to model
// the port's open/closed state across the reclaim sequence, so we assert exactly
// which signals are sent and when it gives up.
describe('reclaimPort — frees a stale/orphaned port before startup', () => {
  // reclaimPort probes the port up to three times: (1) initial check,
  // (2) after the SIGTERM wait, (3) the final reclaimed? check.
  function scriptedProbe(states: boolean[]): (port: number) => Promise<boolean> {
    let i = 0;
    return async () => states[Math.min(i++, states.length - 1)];
  }

  it('is a no-op when the port is already free (no discovery, no kills)', async () => {
    const kills: Array<[number, NodeJS.Signals]> = [];
    let listed = 0;
    const result = await reclaimPort(3000, {
      probe: scriptedProbe([false]),
      listPids: () => { listed++; return [111]; },
      killTree: (pid, sig) => kills.push([pid, sig]),
      waitFree: async () => {},
    });
    assert.deepStrictEqual(result, { wasOpen: false, reclaimed: true, pids: [] });
    assert.strictEqual(listed, 0, 'must not discover PIDs when the port is free');
    assert.deepStrictEqual(kills, []);
  });

  it('SIGTERMs every listener and reports reclaimed when the port frees gracefully', async () => {
    const kills: Array<[number, NodeJS.Signals]> = [];
    const result = await reclaimPort(3100, {
      // open, then free after SIGTERM, then still free at the final check
      probe: scriptedProbe([true, false, false]),
      listPids: () => [4242, 4243],
      killTree: (pid, sig) => kills.push([pid, sig]),
      waitFree: async () => {},
    });
    assert.deepStrictEqual(kills, [[4242, 'SIGTERM'], [4243, 'SIGTERM']]);
    assert.deepStrictEqual(result, { wasOpen: true, reclaimed: true, pids: [4242, 4243] });
  });

  it('escalates to SIGKILL when the listener survives the graceful SIGTERM', async () => {
    const kills: Array<[number, NodeJS.Signals]> = [];
    const result = await reclaimPort(3000, {
      // open, still open after SIGTERM, free after SIGKILL
      probe: scriptedProbe([true, true, false]),
      listPids: () => [777],
      killTree: (pid, sig) => kills.push([pid, sig]),
      waitFree: async () => {},
    });
    assert.deepStrictEqual(kills, [[777, 'SIGTERM'], [777, 'SIGKILL']]);
    assert.strictEqual(result.reclaimed, true);
  });

  it('reports reclaimed:false when the port stays bound through SIGKILL', async () => {
    const result = await reclaimPort(3000, {
      probe: scriptedProbe([true, true, true]),
      listPids: () => [777],
      killTree: () => {},
      waitFree: async () => {},
    });
    assert.strictEqual(result.wasOpen, true);
    assert.strictEqual(result.reclaimed, false);
  });

  it('re-discovers listeners for the SIGKILL pass when the first discovery was empty', async () => {
    const kills: Array<[number, NodeJS.Signals]> = [];
    let call = 0;
    const result = await reclaimPort(3000, {
      probe: scriptedProbe([true, true, false]),
      // First lsof pass momentarily returns nothing; second finds the owner.
      listPids: () => (call++ === 0 ? [] : [999]),
      killTree: (pid, sig) => kills.push([pid, sig]),
      waitFree: async () => {},
    });
    assert.deepStrictEqual(kills, [[999, 'SIGKILL']]);
    assert.strictEqual(result.reclaimed, true);
  });

  it('reports the port free once its real listener is reclaimed (real sockets, injected kill)', async () => {
    const port = await getFreePort();
    const srv = createServer((c) => c.destroy());
    await new Promise<void>((res) => srv.listen(port, '127.0.0.1', () => res()));

    assert.strictEqual(await isPortOpen(port, '127.0.0.1'), true, 'port should be held before reclaim');

    // Inject the "kill" as closing our test server so the real probe/waitFree
    // path is exercised end-to-end without spawning an OS process.
    let killed = false;
    const result = await reclaimPort(port, {
      probe: (p) => isPortOpen(p, '127.0.0.1'),
      listPids: () => [process.pid],
      killTree: () => { if (!killed) { killed = true; srv.close(); } },
    });

    assert.strictEqual(result.wasOpen, true);
    assert.strictEqual(result.reclaimed, true);
    assert.strictEqual(await isPortOpen(port, '127.0.0.1'), false, 'port should be free after reclaim');
  });
});

// ── evaluatePortBindRetry — bounded :3000 EADDRINUSE retry ───────────────────
describe('evaluatePortBindRetry — front-door bind retry budget', () => {
  it('retries early attempts with a linear backoff', () => {
    assert.deepStrictEqual(evaluatePortBindRetry(1), { retry: true, delayMs: 250 });
    assert.deepStrictEqual(evaluatePortBindRetry(2), { retry: true, delayMs: 500 });
  });

  it('gives up (no retry) once the attempt budget is reached', () => {
    const d = evaluatePortBindRetry(DEFAULT_PORT_BIND_RETRY_POLICY.maxAttempts);
    assert.deepStrictEqual(d, { retry: false, delayMs: 0 });
  });

  it('honors a custom policy', () => {
    const policy = { maxAttempts: 2, backoffMs: 100 };
    assert.deepStrictEqual(evaluatePortBindRetry(1, policy), { retry: true, delayMs: 100 });
    assert.deepStrictEqual(evaluatePortBindRetry(2, policy), { retry: false, delayMs: 0 });
  });
});

// ── evaluateSingleton — singleton guard decision ────────────────────────────
// Prevents two fighting supervisors while never blocking a `tsx watch` reload of
// the SAME supervisor (same parent pid).
describe('evaluateSingleton — one supervisor per port, hot-reload safe', () => {
  const rec = (over: Partial<DevServerPidRecord> = {}): DevServerPidRecord => ({
    pid: 1000,
    ppid: 500,
    port: 3000,
    ...over,
  });
  const alive = () => true;
  const dead = () => false;

  it('proceeds when there is no (or a corrupt) pidfile', () => {
    assert.deepStrictEqual(evaluateSingleton(null, { pid: 1, ppid: 2 }, true, alive), { action: 'proceed' });
  });

  it('proceeds on a tsx-watch relaunch of our own supervisor (same parent pid)', () => {
    // New child, DIFFERENT own pid, but SAME watcher parent → not a competitor.
    const d = evaluateSingleton(rec({ pid: 1000, ppid: 500 }), { pid: 1001, ppid: 500 }, true, alive);
    assert.deepStrictEqual(d, { action: 'proceed' });
  });

  it('exits when a different, live supervisor is actually holding the port', () => {
    const d = evaluateSingleton(rec({ pid: 1000, ppid: 500, port: 3000 }), { pid: 2000, ppid: 900 }, true, alive);
    assert.strictEqual(d.action, 'exit');
    assert.match((d as { reason: string }).reason, /already running on :3000/);
    assert.match((d as { reason: string }).reason, /pid 1000/);
  });

  it('proceeds when the recorded owner is dead (stale pidfile), even if the port looks in use', () => {
    const d = evaluateSingleton(rec({ pid: 1000, ppid: 500 }), { pid: 2000, ppid: 900 }, true, dead);
    assert.deepStrictEqual(d, { action: 'proceed' });
  });

  it('proceeds when a different live owner is NOT holding the port (nothing to fight over)', () => {
    const d = evaluateSingleton(rec({ pid: 1000, ppid: 500 }), { pid: 2000, ppid: 900 }, false, alive);
    assert.deepStrictEqual(d, { action: 'proceed' });
  });

  it('treats the owner as alive when only its parent pid is still alive', () => {
    // Recorded pid gone, but its parent (the watcher) is alive → owner alive.
    const isAlive = (pid: number) => pid === 500;
    const d = evaluateSingleton(rec({ pid: 1000, ppid: 500 }), { pid: 2000, ppid: 900 }, true, isAlive);
    assert.strictEqual(d.action, 'exit');
  });
});

// ── parsePidRecord ──────────────────────────────────────────────────────────
describe('parsePidRecord — tolerant pidfile parsing', () => {
  it('parses a well-formed record', () => {
    assert.deepStrictEqual(parsePidRecord('{"pid":12,"ppid":3,"port":3000}'), { pid: 12, ppid: 3, port: 3000 });
  });

  it('returns null for empty / corrupt JSON', () => {
    assert.strictEqual(parsePidRecord(''), null);
    assert.strictEqual(parsePidRecord('not json'), null);
    assert.strictEqual(parsePidRecord('{'), null);
  });

  it('returns null when required numeric fields are missing or wrong-typed', () => {
    assert.strictEqual(parsePidRecord('{"pid":12,"ppid":3}'), null);
    assert.strictEqual(parsePidRecord('{"pid":"12","ppid":3,"port":3000}'), null);
    assert.strictEqual(parsePidRecord('{}'), null);
  });
});

// ── isPidAlive ──────────────────────────────────────────────────────────────
describe('isPidAlive — signal-0 liveness probe', () => {
  it('reports alive when the probe signal succeeds', () => {
    assert.strictEqual(isPidAlive(4242, () => {}), true);
  });

  it('reports dead on ESRCH', () => {
    assert.strictEqual(isPidAlive(4242, () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); }), false);
  });

  it('reports alive on EPERM (exists, not ours to signal)', () => {
    assert.strictEqual(isPidAlive(4242, () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); }), true);
  });

  it('rejects non-signalable pids (<= 1) without probing', () => {
    let probed = false;
    assert.strictEqual(isPidAlive(1, () => { probed = true; }), false);
    assert.strictEqual(isPidAlive(0, () => { probed = true; }), false);
    assert.strictEqual(probed, false);
  });
});

// ── findListenerPids — port → listener PID discovery (injected runner) ───────
describe('findListenerPids — lsof/netstat listener discovery', () => {
  it('parses the bare PID list from `lsof -ti tcp:<port> -sTCP:LISTEN` on POSIX', () => {
    const calls: Array<[string, readonly string[]]> = [];
    const pids = findListenerPids(3100, (cmd, args) => {
      calls.push([cmd, args]);
      return { stdout: '4242\n4243\n' };
    }, 'linux');
    assert.deepStrictEqual(pids, [4242, 4243]);
    assert.deepStrictEqual(calls, [['lsof', ['-ti', 'tcp:3100', '-sTCP:LISTEN']]]);
  });

  it('dedups PIDs and drops non-signalable pids (<= 1)', () => {
    const pids = findListenerPids(3000, () => ({ stdout: '5\n5\n1\n0\n7\n' }), 'linux');
    assert.deepStrictEqual(pids, [5, 7]);
  });

  it('returns [] when nothing is listening (empty stdout / non-zero exit)', () => {
    assert.deepStrictEqual(findListenerPids(3000, () => ({ stdout: '', status: 1 }), 'linux'), []);
    assert.deepStrictEqual(findListenerPids(3000, () => ({ stdout: null }), 'linux'), []);
  });

  it('returns [] when the discovery command cannot run (never throws)', () => {
    assert.deepStrictEqual(findListenerPids(3000, () => { throw new Error('ENOENT'); }, 'linux'), []);
  });

  it('parses LISTENING rows for the port from `netstat -ano` on Windows', () => {
    const stdout = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:3100           0.0.0.0:0              LISTENING       4242',
      '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       9001', // different port
      '  TCP    127.0.0.1:3100         127.0.0.1:55123        ESTABLISHED     8888', // not listening
    ].join('\r\n');
    const pids = findListenerPids(3100, () => ({ stdout }), 'win32');
    assert.deepStrictEqual(pids, [4242]);
  });
});

// ── killListenerTree — reuses the frontend group-kill on a discovered PID ────
describe('killListenerTree — reclaim reuses the process-group kill', () => {
  it('group-signals the discovered PID on POSIX (negative pid)', () => {
    const group: Array<[number, NodeJS.Signals]> = [];
    killListenerTree(4242, 'SIGTERM', 'linux', (pid, sig) => group.push([pid, sig]));
    assert.deepStrictEqual(group, [[-4242, 'SIGTERM']]);
  });

  it('reaps the tree via taskkill on Windows', () => {
    const winPids: number[] = [];
    let groupCalled = false;
    killListenerTree(4242, 'SIGKILL', 'win32', () => { groupCalled = true; }, (pid) => { winPids.push(pid); return true; });
    assert.strictEqual(groupCalled, false);
    assert.deepStrictEqual(winPids, [4242]);
  });
});
