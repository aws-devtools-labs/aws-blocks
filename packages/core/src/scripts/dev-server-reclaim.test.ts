// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:net';
import {
  reclaimPort,
  reclaimMessage,
  evaluatePortBindRetry,
  createBindRetryController,
  DEFAULT_PORT_BIND_RETRY_POLICY,
  evaluateSingleton,
  parsePidRecord,
  isPidAlive,
  isPortOpen,
  type DevServerPidRecord,
  type ReclaimResult,
} from './dev-server.js';
import {
  findListenerPids,
  killListenerTree,
  collectSelfAndAncestorPids,
  readParentPid,
} from './process-tree.js';

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

  it('SIGKILLs the CURRENT owner, not the stale one, when the port changed hands during the wait', async () => {
    // The original listener (111) is SIGTERM'd but exits, and a DIFFERENT process
    // (222) grabs the port before the SIGKILL pass. The escalation must re-list
    // and target the new owner (222) — never the stale pid (111) it already
    // signalled — otherwise it SIGKILLs a dead pid and leaves the real owner.
    const kills: Array<[number, NodeJS.Signals]> = [];
    let call = 0;
    const result = await reclaimPort(3000, {
      // open, still open after SIGTERM (new owner now holds it), free after SIGKILL
      probe: scriptedProbe([true, true, false]),
      listPids: () => (call++ === 0 ? [111] : [222]),
      killTree: (pid, sig) => kills.push([pid, sig]),
      waitFree: async () => {},
    });
    assert.deepStrictEqual(kills, [[111, 'SIGTERM'], [222, 'SIGKILL']]);
    assert.strictEqual(result.reclaimed, true);
    // result.pids reflects the initial discovery (what we SIGTERM'd).
    assert.deepStrictEqual(result.pids, [111]);
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

// ── reclaimMessage — accurate startup reclaim-outcome messaging ──────────────
describe('reclaimMessage — three-way reclaim outcome message', () => {
  it('reports success when the port was reclaimed', () => {
    const msg = reclaimMessage(3000, { wasOpen: true, reclaimed: true, pids: [] }, 'a stale/orphaned listener');
    assert.match(msg, /Reclaimed port 3000 from a stale\/orphaned listener/);
  });

  it('names the holding pid(s) when reclaim failed but an owner is known', () => {
    const msg = reclaimMessage(3100, { wasOpen: true, reclaimed: false, pids: [4242, 4243] }, 'a stale/orphaned dev server');
    assert.match(msg, /Port 3100 held by pid\(s\) \[4242, 4243\]/);
    assert.match(msg, /stop that process and retry/);
  });

  it('falls back to the generic message when reclaim failed with no owner PID', () => {
    const msg = reclaimMessage(3000, { wasOpen: true, reclaimed: false, pids: [] }, 'a stale/orphaned listener');
    assert.match(msg, /no owner PID found/);
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
    if (d.action !== 'exit') assert.fail(`expected exit, got ${d.action}`);
    assert.match(d.reason, /already running on :3000/);
    assert.match(d.reason, /pid 1000/);
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
    }, 'linux', new Set<number>());
    assert.deepStrictEqual(pids, [4242, 4243]);
    assert.deepStrictEqual(calls, [['lsof', ['-ti', 'tcp:3100', '-sTCP:LISTEN']]]);
  });

  it('dedups PIDs and drops non-signalable pids (<= 1)', () => {
    const pids = findListenerPids(3000, () => ({ stdout: '5\n5\n1\n0\n7\n' }), 'linux', new Set<number>());
    assert.deepStrictEqual(pids, [5, 7]);
  });

  it('returns [] when nothing is listening (empty stdout / non-zero exit)', () => {
    assert.deepStrictEqual(findListenerPids(3000, () => ({ stdout: '', status: 1 }), 'linux', new Set<number>()), []);
    assert.deepStrictEqual(findListenerPids(3000, () => ({ stdout: null }), 'linux', new Set<number>()), []);
  });

  it('returns [] when the discovery command cannot run (never throws)', () => {
    assert.deepStrictEqual(findListenerPids(3000, () => { throw new Error('ENOENT'); }, 'linux', new Set<number>()), []);
  });

  it('parses LISTENING rows for the port from `netstat -ano` on Windows', () => {
    const stdout = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:3100           0.0.0.0:0              LISTENING       4242',
      '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       9001', // different port
      '  TCP    127.0.0.1:3100         127.0.0.1:55123        ESTABLISHED     8888', // not listening
    ].join('\r\n');
    const pids = findListenerPids(3100, () => ({ stdout }), 'win32', new Set<number>());
    assert.deepStrictEqual(pids, [4242]);
  });

  it('drops the current process and its ancestors (self/ancestor guard) on POSIX', () => {
    // A listener that resolves to us or a forebear must never be returned:
    // reclaiming it would group-kill the process tree running the dev server.
    const guard = new Set<number>([4242, 9999]);
    const pids = findListenerPids(3100, () => ({ stdout: '4242\n4243\n9999\n' }), 'linux', guard);
    assert.deepStrictEqual(pids, [4243]);
  });

  it('drops guarded PIDs on Windows too', () => {
    const stdout = [
      '  TCP    0.0.0.0:3100           0.0.0.0:0              LISTENING       4242',
      '  TCP    0.0.0.0:3100           0.0.0.0:0              LISTENING       4243',
    ].join('\r\n');
    const pids = findListenerPids(3100, () => ({ stdout }), 'win32', new Set<number>([4242]));
    assert.deepStrictEqual(pids, [4243]);
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

// ── readParentPid / collectSelfAndAncestorPids — self+ancestor guard set ──────
describe('readParentPid — parent PID from /proc/<pid>/stat (with ps fallback)', () => {
  it('parses ppid (field 4) from a /proc stat line whose comm contains spaces/parens', () => {
    // comm = "(tsx watch (dev))" — the parens/spaces inside comm must not shift field parsing.
    const stat = '4242 (tsx watch (dev)) S 4200 4242 4242 0 -1 4194304 0 0';
    assert.strictEqual(readParentPid(4242, () => stat), 4200);
  });

  it('falls back to `ps -o ppid=` when /proc is unavailable', () => {
    const ppid = readParentPid(4242, () => null, (cmd, args) => {
      assert.strictEqual(cmd, 'ps');
      assert.deepStrictEqual(args, ['-o', 'ppid=', '-p', '4242']);
      return { stdout: '  4200\n' };
    });
    assert.strictEqual(ppid, 4200);
  });

  it('returns null when neither /proc nor ps yield a ppid', () => {
    assert.strictEqual(readParentPid(4242, () => null, () => { throw new Error('ENOENT'); }), null);
    assert.strictEqual(readParentPid(4242, () => null, () => ({ stdout: '' })), null);
  });
});

describe('collectSelfAndAncestorPids — walks the ancestry chain to init', () => {
  it('collects self + every ancestor, stopping at pid <= 1', () => {
    const parents: Record<number, number | null> = { 500: 400, 400: 300, 300: 1 };
    const set = collectSelfAndAncestorPids(500, (pid) => parents[pid] ?? null);
    assert.deepStrictEqual([...set].sort((a, b) => a - b), [300, 400, 500]);
  });

  it('is cycle-safe (a parent pointing back into the chain terminates the walk)', () => {
    const parents: Record<number, number | null> = { 500: 400, 400: 500 };
    const set = collectSelfAndAncestorPids(500, (pid) => parents[pid] ?? null);
    assert.deepStrictEqual([...set].sort((a, b) => a - b), [400, 500]);
  });

  it('stops when the parent can no longer be read (returns null)', () => {
    const set = collectSelfAndAncestorPids(500, () => null);
    assert.deepStrictEqual([...set], [500]);
  });

  it('honours maxDepth', () => {
    const set = collectSelfAndAncestorPids(1000, (pid) => pid - 1, 3);
    assert.strictEqual(set.size, 3);
  });
});

// ── createBindRetryController — :3000 EADDRINUSE retry wiring ─────────────────
// Locks in the retry *wiring* the front-door robustness fix hinges on — the
// 1-based attempt counter, the bounded decision, reclaim-result routing, and
// retry scheduling — without a real socket. All effects are injected seams.
describe('createBindRetryController — bounded EADDRINUSE reclaim-and-rebind', () => {
  // setImmediate resolves after the microtask queue, so the controller's
  // `void (async () => { await reclaim(); … scheduleRetry() })()` IIFE has run.
  const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

  interface Recorder {
    handler: () => void;
    reclaimCalls: number;
    relistenCalls: number;
    exhaustedCalls: number;
    scheduled: Array<{ fn: () => void; delayMs: number }>;
    warnings: string[];
  }

  function makeController(
    result: ReclaimResult = { wasOpen: true, reclaimed: true, pids: [] },
    policy = DEFAULT_PORT_BIND_RETRY_POLICY,
  ): Recorder {
    const rec: Recorder = {
      handler: () => {},
      reclaimCalls: 0,
      relistenCalls: 0,
      exhaustedCalls: 0,
      scheduled: [],
      warnings: [],
    };
    rec.handler = createBindRetryController(
      3000,
      {
        reclaim: async () => { rec.reclaimCalls += 1; return result; },
        relisten: () => { rec.relistenCalls += 1; },
        scheduleRetry: (fn, delayMs) => { rec.scheduled.push({ fn, delayMs }); },
        onExhausted: () => { rec.exhaustedCalls += 1; },
        warn: (m) => { rec.warnings.push(m); },
      },
      policy,
    );
    return rec;
  }

  it('reclaims and schedules a retry with linear backoff, invoking relisten on the scheduled callback', async () => {
    const c = makeController();

    c.handler(); // attempt 1
    await flush();
    assert.strictEqual(c.reclaimCalls, 1, 'reclaim runs on a retryable attempt');
    assert.strictEqual(c.exhaustedCalls, 0);
    assert.strictEqual(c.scheduled.length, 1, 'one retry scheduled');
    assert.strictEqual(c.scheduled[0].delayMs, 250, 'delay = backoffMs * attempt (250*1)');
    assert.match(c.warnings[0], /attempt 1\/3/);

    // Firing the scheduled callback must re-attempt the bind (guards against a
    // refactor dropping the onListening-bound relisten on the retry path).
    assert.strictEqual(c.relistenCalls, 0, 'relisten deferred until the scheduled callback fires');
    c.scheduled[0].fn();
    assert.strictEqual(c.relistenCalls, 1);

    c.handler(); // attempt 2
    await flush();
    assert.strictEqual(c.scheduled.length, 2);
    assert.strictEqual(c.scheduled[1].delayMs, 500, 'delay = backoffMs * attempt (250*2)');
    assert.match(c.warnings.at(-1) ?? '', /attempt 2\/3/);
  });

  it('gives up after the attempt budget — no reclaim, no retry scheduled, actionable message', async () => {
    const c = makeController({ wasOpen: true, reclaimed: true, pids: [] }, { maxAttempts: 2, backoffMs: 100 });

    c.handler(); // attempt 1 → retry
    await flush();
    c.handler(); // attempt 2 → budget reached
    await flush();

    assert.strictEqual(c.exhaustedCalls, 1, 'onExhausted fired exactly once at the budget');
    assert.strictEqual(c.reclaimCalls, 1, 'no reclaim on the exhausted attempt (only the retryable one)');
    assert.strictEqual(c.scheduled.length, 1, 'no retry scheduled after exhaustion');
    assert.match(c.warnings.at(-1) ?? '', /still in use after 2/);
  });

  it('surfaces the holding pid(s) when a retry reclaim fails to free the port', async () => {
    const c = makeController({ wasOpen: true, reclaimed: false, pids: [4242] });

    c.handler(); // attempt 1 → retry; reclaim fails
    await flush();

    assert.ok(
      c.warnings.some((w) => /held by pid\(s\) \[4242\]/.test(w)),
      'operator sees the pid-naming reclaim message, not just the generic banner',
    );
    // A failed reclaim still schedules the next attempt (the budget, not reclaim
    // success, bounds the loop).
    assert.strictEqual(c.scheduled.length, 1);
  });
});
