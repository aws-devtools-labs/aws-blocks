// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reclaimPort,
  reclaimMessage,
  describePortHolders,
  evaluatePortBindRetry,
  createBindRetryController,
  scheduleBindRetry,
  DEFAULT_PORT_BIND_RETRY_POLICY,
  evaluateSingleton,
  recordLiveness,
  claimDevPidfile,
  parsePidRecord,
  isPidAlive,
  isPortOpen,
  type DevServerPidRecord,
  type ReclaimResult,
  stopDevServer,
} from './dev-server.js';
import { findListenerPids, killListenerTree } from './process-tree.js';
import { claimDevSession, pidCommand } from './dev-pidfile.js';

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
describe('reclaimPort — frees a port only from listeners this app owns', () => {
  // reclaimPort probes the port up to three times: (1) initial check,
  // (2) after the SIGTERM wait, (3) the final reclaimed? check.
  function scriptedProbe(states: boolean[]): (port: number) => Promise<boolean> {
    let i = 0;
    return async () => states[Math.min(i++, states.length - 1)];
  }
  const ours = { owned: () => true, commandOf: () => 'vite' };

  it('is a no-op when the port is already free (no discovery, no kills)', async () => {
    const kills: Array<[number, NodeJS.Signals]> = [];
    let listed = 0;
    const result = await reclaimPort(3000, {
      ...ours,
      probe: scriptedProbe([false]),
      listPids: () => { listed++; return [111]; },
      killTree: (pid, sig) => kills.push([pid, sig]),
      waitFree: async () => {},
    });
    assert.deepStrictEqual(result, { wasOpen: false, reclaimed: true, pids: [], foreign: [] });
    assert.strictEqual(listed, 0, 'must not discover PIDs when the port is free');
    assert.deepStrictEqual(kills, []);
  });

  it('SIGTERMs every owned listener and reports reclaimed when the port frees gracefully', async () => {
    const kills: Array<[number, NodeJS.Signals]> = [];
    const result = await reclaimPort(3100, {
      ...ours,
      // open, then free after SIGTERM, then still free at the final check
      probe: scriptedProbe([true, false, false]),
      listPids: () => [4242, 4243],
      killTree: (pid, sig) => kills.push([pid, sig]),
      waitFree: async () => {},
    });
    assert.deepStrictEqual(kills, [[4242, 'SIGTERM'], [4243, 'SIGTERM']]);
    assert.deepStrictEqual(result, { wasOpen: true, reclaimed: true, pids: [4242, 4243], foreign: [] });
  });

  it('escalates to SIGKILL when the listener survives the graceful SIGTERM', async () => {
    const kills: Array<[number, NodeJS.Signals]> = [];
    const result = await reclaimPort(3000, {
      ...ours,
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
      ...ours,
      probe: scriptedProbe([true, true, true]),
      listPids: () => [777],
      killTree: () => {},
      waitFree: async () => {},
    });
    assert.strictEqual(result.wasOpen, true);
    assert.strictEqual(result.reclaimed, false);
  });

  it('never signals a listener it does not own, and names it instead', async () => {
    const kills: Array<[number, NodeJS.Signals]> = [];
    const result = await reclaimPort(41012, {
      probe: scriptedProbe([true]),
      listPids: () => [555],
      commandOf: () => 'python3 -m http.server 41012',
      killTree: (pid, sig) => kills.push([pid, sig]),
      waitFree: async () => {},
    });
    assert.deepStrictEqual(kills, [], 'nothing is owned by default');
    assert.deepStrictEqual(result, {
      wasOpen: true,
      reclaimed: false,
      pids: [],
      foreign: [{ pid: 555, command: 'python3 -m http.server 41012' }],
    });
  });

  it('leaves the port alone when one of its listeners is foreign, even if another is owned', async () => {
    const kills: Array<[number, NodeJS.Signals]> = [];
    const result = await reclaimPort(3100, {
      probe: scriptedProbe([true]),
      listPids: () => [4242, 555],
      owned: (pid) => pid === 4242,
      commandOf: () => 'other',
      killTree: (pid, sig) => kills.push([pid, sig]),
      waitFree: async () => {},
    });
    assert.deepStrictEqual(kills, []);
    assert.deepStrictEqual(result.foreign, [{ pid: 555, command: 'other' }]);
  });

  it('signals nothing when no listener pid can be found', async () => {
    const kills: Array<[number, NodeJS.Signals]> = [];
    const result = await reclaimPort(3000, {
      ...ours,
      probe: scriptedProbe([true]),
      listPids: () => [],
      killTree: (pid, sig) => kills.push([pid, sig]),
      waitFree: async () => {},
    });
    assert.deepStrictEqual(kills, []);
    assert.deepStrictEqual(result, { wasOpen: true, reclaimed: false, pids: [], foreign: [] });
  });

  it('does not SIGKILL a new, foreign owner that grabbed the port during the wait', async () => {
    // The owned listener (111) exits on SIGTERM, and an unrelated process (222)
    // binds the port before the SIGKILL pass: it must be judged afresh, not killed.
    const kills: Array<[number, NodeJS.Signals]> = [];
    let call = 0;
    const result = await reclaimPort(3000, {
      probe: scriptedProbe([true, true, true]),
      listPids: () => (call++ === 0 ? [111] : [222]),
      owned: (pid) => pid === 111,
      commandOf: (pid) => `cmd-${pid}`,
      killTree: (pid, sig) => kills.push([pid, sig]),
      waitFree: async () => {},
    });
    assert.deepStrictEqual(kills, [[111, 'SIGTERM']]);
    assert.strictEqual(result.reclaimed, false);
    assert.deepStrictEqual(result.foreign, [{ pid: 222, command: 'cmd-222' }]);
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
      ...ours,
      probe: (p) => isPortOpen(p, '127.0.0.1'),
      listPids: () => [process.pid],
      killTree: () => { if (!killed) { killed = true; srv.close(); } },
    });

    assert.strictEqual(result.wasOpen, true);
    assert.strictEqual(result.reclaimed, true);
    assert.strictEqual(await isPortOpen(port, '127.0.0.1'), false, 'port should be free after reclaim');
  });
});

// ── reclaimMessage / describePortHolders ─────────────────────────────────────
describe('reclaimMessage — reclaim outcome message', () => {
  it('reports success when the port was reclaimed', () => {
    const msg = reclaimMessage(3000, { wasOpen: true, reclaimed: true, pids: [], foreign: [] }, "this app's previous dev server");
    assert.match(msg, /Reclaimed port 3000 from this app's previous dev server/);
  });

  it('names a foreign holder by pid and command', () => {
    const result = { wasOpen: true, reclaimed: false, pids: [], foreign: [{ pid: 4242, command: 'python3 -m http.server 3100' }] };
    assert.strictEqual(describePortHolders(3100, result), 'port 3100 is in use by pid 4242 (python3 -m http.server 3100)');
    assert.match(reclaimMessage(3100, result, 'x'), /in use by pid 4242 \(python3 -m http\.server 3100\); not stopping it/);
  });

  it('names an owned listener that survived SIGKILL', () => {
    assert.match(describePortHolders(3000, { wasOpen: true, reclaimed: false, pids: [77], foreign: [] }), /still held by pid\(s\) 77/);
  });

  it('falls back to the generic message when no owner PID was found', () => {
    assert.match(describePortHolders(3000, { wasOpen: true, reclaimed: false, pids: [], foreign: [] }), /owner could not be found/);
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
// Prevents two fighting supervisors while allowing a `tsx watch` reload after
// the previous child has exited.
describe('evaluateSingleton — one supervisor per port, hot-reload safe', () => {
  const rec = (over: Partial<DevServerPidRecord> = {}): DevServerPidRecord => ({
    pid: 1000,
    ppid: 500,
    port: 3000,
    ...over,
  });
  const live = { pidAlive: true, watcherAlive: true };
  const gone = { pidAlive: false, watcherAlive: false };

  it('proceeds when there is no (or a corrupt) pidfile', () => {
    assert.deepStrictEqual(evaluateSingleton(null, { pid: 1, ppid: 2 }, live), { action: 'proceed' });
  });

  it('proceeds on a tsx-watch relaunch after the previous child has exited', () => {
    // New child, DIFFERENT own pid, SAME watcher parent, and old child is dead.
    const d = evaluateSingleton(rec(), { pid: 1001, ppid: 500 }, { pidAlive: false, watcherAlive: true });
    assert.deepStrictEqual(d, { action: 'proceed' });
  });

  it('exits when a same-parent owner is still alive (two jobs from one shell)', () => {
    const d = evaluateSingleton(rec(), { pid: 1001, ppid: 500 }, { pidAlive: true, watcherAlive: false });
    if (d.action !== 'exit') assert.fail(`expected exit, got ${d.action}`);
    assert.match(d.reason, /already running on :3000/);
    assert.match(d.reason, /pid 1000/);
  });

  it('exits when a different supervisor is alive, whether or not it has bound the port yet', () => {
    const d = evaluateSingleton(rec(), { pid: 2000, ppid: 900 }, { pidAlive: true, watcherAlive: true });
    if (d.action !== 'exit') assert.fail(`expected exit, got ${d.action}`);
    assert.match(d.reason, /already running on :3000 \(pid 1000\)/);
  });

  it('proceeds when the recorded owner and its watcher are gone (stale pidfile)', () => {
    assert.deepStrictEqual(evaluateSingleton(rec(), { pid: 2000, ppid: 900 }, gone), { action: 'proceed' });
  });

  it('exits while another session is between two reloads (only its tsx watch is alive)', () => {
    const d = evaluateSingleton(rec(), { pid: 2000, ppid: 900 }, { pidAlive: false, watcherAlive: true });
    if (d.action !== 'exit') assert.fail(`expected exit, got ${d.action}`);
    assert.match(d.reason, /pid 500/, 'names the live watcher');
  });
});

describe('recordLiveness — a live pid counts only with the command line it had', () => {
  const record: DevServerPidRecord = {
    pid: 1000, ppid: 500, port: 3000, command: 'node run-dev.ts', parentCommand: 'node tsx watch run-dev.ts',
  };
  const commands: Record<number, string> = { 1000: 'node run-dev.ts', 500: 'node tsx watch run-dev.ts' };
  const commandOf = (pid: number) => commands[pid] ?? '';

  it('reports both alive when pid and watcher match their recorded commands', () => {
    assert.deepStrictEqual(recordLiveness(record, () => true, commandOf), { pidAlive: true, watcherAlive: true });
  });

  it('treats a reused pid (another command) as gone', () => {
    const reused = (pid: number) => (pid === 1000 ? 'python3 -m http.server' : commandOf(pid));
    assert.strictEqual(recordLiveness(record, () => true, reused).pidAlive, false);
  });

  it('never counts a parent that is not a tsx watcher (a plain start from a shell)', () => {
    const shell = { ...record, parentCommand: undefined };
    const asShell = (pid: number) => (pid === 500 ? '-zsh' : commandOf(pid));
    assert.strictEqual(recordLiveness(shell, () => true, asShell).watcherAlive, false);
  });

  it('falls back to pid liveness for a record without command lines (older versions)', () => {
    const old: DevServerPidRecord = { pid: 1000, ppid: 1, port: 3000 };
    assert.deepStrictEqual(recordLiveness(old, (pid) => pid === 1000, () => 'anything'), { pidAlive: true, watcherAlive: false });
  });
});

describe('claimDevPidfile — exactly one start owns the port', () => {
  /** An in-memory file system with the same atomicity as the real one. */
  function memoryFs(initial: Record<string, string> = {}) {
    const files = new Map(Object.entries(initial));
    return {
      files,
      deps: {
        createExclusive: (p: string, body: string) => (files.has(p) ? false : (files.set(p, body), true)),
        read: (p: string) => files.get(p) ?? null,
        rename: (from: string, to: string) => {
          const body = files.get(from);
          if (body === undefined) return false;
          files.delete(from);
          files.set(to, body);
          return true;
        },
        replace: (p: string, body: string) => { files.set(p, body); },
        remove: (p: string) => { files.delete(p); },
        peers: (p: string) =>
          [...files.keys()].filter((f) => f !== p && /\/dev-server\.\d+\.pid$/.test(f) && f.slice(0, f.lastIndexOf('/')) === p.slice(0, p.lastIndexOf('/'))),
      },
    };
  }
  const self: DevServerPidRecord = { pid: 2000, ppid: 900, port: 3000, command: 'b', parentCommand: 'p' };
  const path = '/app/.blocks-sandbox/dev-server.3000.pid';

  it('creates the pidfile when there is none', () => {
    const fs = memoryFs();
    const claim = claimDevPidfile(path, self, { ...fs.deps, isAlive: () => false, commandOf: () => '' });
    assert.deepStrictEqual(claim, { acquired: true, previous: null });
    assert.deepStrictEqual(parsePidRecord(fs.files.get(path) ?? ''), self);
  });

  it('refuses while the recorded owner is alive, and leaves its pidfile alone', () => {
    const owner = JSON.stringify({ pid: 1000, ppid: 500, port: 3000, command: 'a', parentCommand: 'q' });
    const fs = memoryFs({ [path]: owner });
    const claim = claimDevPidfile(path, self, { ...fs.deps, isAlive: () => true, commandOf: (pid) => (pid === 1000 ? 'a' : 'q') });
    assert.strictEqual(claim.acquired, false);
    assert.strictEqual(fs.files.get(path), owner);
    assert.strictEqual(fs.files.size, 1, 'no claim file is left behind');
  });

  it("refuses while the app's dev server on another port is alive, names that port, and removes its own record", () => {
    // Two dev servers of one app share its .bb-data: the second one, on another port, must not start either.
    const other = '/app/.blocks-sandbox/dev-server.4100.pid';
    const owner = JSON.stringify({ pid: 1000, ppid: 500, port: 4100, command: 'a', parentCommand: 'q' });
    const foreign = '/elsewhere/.blocks-sandbox/dev-server.4200.pid';
    const fs = memoryFs({ [other]: owner, [foreign]: JSON.stringify({ pid: 1001, ppid: 501, port: 4200, command: 'c' }) });
    const commandOf = (pid: number) => ({ 1000: 'a', 500: 'q', 1001: 'c' })[pid] ?? '';
    const claim = claimDevPidfile(path, self, { ...fs.deps, isAlive: () => true, commandOf });
    assert.deepStrictEqual(claim, {
      acquired: false,
      reason: 'a dev server of this app is already running on :4100 (pid 1000)',
      port: 4100,
    });
    assert.ok(!fs.files.has(path), 'the refused start removed the record it wrote');
    assert.strictEqual(fs.files.get(other), owner, "the running server's record stays");
  });

  it("starts when the app's record on another port is stale, and leaves that record to its own port", () => {
    const other = '/app/.blocks-sandbox/dev-server.4100.pid';
    const stale = JSON.stringify({ pid: 1000, ppid: 500, port: 4100, command: 'a' });
    const fs = memoryFs({ [other]: stale });
    const claim = claimDevPidfile(path, self, { ...fs.deps, isAlive: (pid) => pid === 2000, commandOf: () => 'b' });
    assert.deepStrictEqual(claim, { acquired: true, previous: null });
    assert.strictEqual(fs.files.get(other), stale);
  });

  it('takes its own reload over in place without looking at the other ports again', () => {
    // A dev server whose tsx watch reloads it keeps the session, even while a refused start's record lingers.
    const predecessor = { pid: 1999, ppid: 900, port: 3000, command: 'old', parentCommand: 'tsx watch server.ts' };
    const other = '/app/.blocks-sandbox/dev-server.4100.pid';
    const fs = memoryFs({ [path]: JSON.stringify(predecessor), [other]: JSON.stringify({ pid: 1000, ppid: 500, port: 4100, command: 'a' }) });
    const commandOf = (pid: number) => ({ 900: 'tsx watch server.ts', 1000: 'a', 2000: 'b' })[pid] ?? '';
    const claim = claimDevPidfile(path, { ...self, parentCommand: 'tsx watch server.ts' }, {
      ...fs.deps,
      isAlive: (pid) => pid !== 1999,
      commandOf,
    });
    assert.strictEqual(claim.acquired, true);
  });

  it('takes over a stale pidfile and reports the record it replaced', () => {
    const stale = { pid: 1000, ppid: 500, port: 3000, command: 'a' };
    const fs = memoryFs({ [path]: JSON.stringify(stale) });
    const claim = claimDevPidfile(path, self, { ...fs.deps, isAlive: () => false, commandOf: () => '' });
    assert.deepStrictEqual(claim, { acquired: true, previous: stale });
    assert.deepStrictEqual(parsePidRecord(fs.files.get(path) ?? ''), self);
    assert.strictEqual(fs.files.size, 1);
  });

  it('takes over a garbage pidfile', () => {
    const fs = memoryFs({ [path]: 'garbage' });
    const claim = claimDevPidfile(path, self, { ...fs.deps, isAlive: () => false, commandOf: () => '' });
    assert.deepStrictEqual(claim, { acquired: true, previous: null });
  });

  it('never moves or removes a live record: B pauses after judging the pidfile stale, A claims, C tries in the gap', async () => {
    // The interleaving that broke the rename-aside takeover: B moved A's live record away, C took the
    // empty path, and B's restore failed and deleted A's record, so A served on, invisible to `dev stop`.
    const stale = JSON.stringify({ pid: 1000, ppid: 500, port: 3000, command: 'dead', token: 'dead-token' });
    const fs = memoryFs({ [path]: stale });
    const a: DevServerPidRecord = { pid: 3000, ppid: 901, port: 3000, command: 'a3', parentCommand: 'node tsx watch a', token: 'a-token' };
    const b: DevServerPidRecord = { ...self, token: 'b-token' };
    const c: DevServerPidRecord = { pid: 4000, ppid: 902, port: 3000, command: 'c4', parentCommand: 'pc', token: 'c-token' };
    const commands: Record<number, string> = { 3000: 'a3', 901: 'node tsx watch a', 2000: 'b', 900: 'p', 4000: 'c4', 902: 'pc' };
    const live = { isAlive: (pid: number) => pid in commands, commandOf: (pid: number) => commands[pid] ?? '', sleep: () => {} };
    const claims: Record<string, boolean[]> = { a: [], c: [] };
    const claim = (name: 'a' | 'c', record: DevServerPidRecord) =>
      claims[name].push(claimDevPidfile(path, record, { ...fs.deps, ...live }).acquired);
    let bRead = false;
    let cInGap = false;
    const cInTheGap = () => {
      if (cInGap) return;
      cInGap = true;
      claim('c', c);
    };
    // B's seams. `rename` is the old protocol's step between moving the record aside and putting it back,
    // `hook('takeover')` the new one's step while holding the record's reap file: C tries again there.
    const bDeps = {
      ...fs.deps,
      ...live,
      read: (p: string) => {
        const body = fs.deps.read(p);
        if (p === path && body === stale && !bRead) {
          // B has read the dead record: A takes the pidfile over, and C tries while A is live.
          bRead = true;
          claim('a', a);
          claim('c', c);
        }
        return body;
      },
      rename: (from: string, to: string) => {
        const moved = fs.deps.rename(from, to);
        cInTheGap();
        return moved;
      },
      hook: (step: string) => { if (step === 'takeover') cInTheGap(); },
    };
    const bClaim = claimDevPidfile(path, b, bDeps);
    assert.deepStrictEqual(claims.a, [true]);
    assert.ok(cInGap, 'C tried during the takeover');
    assert.deepStrictEqual(claims.c, [false, false], 'C never owns the pidfile while A is live');
    assert.strictEqual(bClaim.acquired, false);
    assert.strictEqual(fs.files.get(path), JSON.stringify(a), "A's record is intact");
    assert.deepStrictEqual([...fs.files.keys()], [path], 'no reap or claim file is left');
    // And `dev stop` finds A, and stops it through its tsx watch.
    const signals: Array<[number, string]> = [];
    const stop = await stopDevServer(3000, {
      readPidfile: () => fs.files.get(path) ?? null,
      removePidfile: () => {},
      ...live,
      signal: (pid, signal) => { signals.push([pid, signal]); },
      probe: async () => false,
      listPids: () => [],
      killTree: () => {},
      waitFree: async () => {},
      waitExit: async () => true,
    });
    assert.strictEqual(stop.via, 'watcher');
    assert.deepStrictEqual(signals, [[901, 'SIGTERM']]);
  });

  it('gives a dead pidfile to exactly one of several concurrent claimants and a reaper, round after round', { timeout: 120_000 }, async () => {
    // Real processes on a real file system, each on its own clock.
    const dir = mkdtempSync(join(tmpdir(), 'dev-pidfile-race-'));
    const pidfile = join(dir, 'dev-server.3000.pid');
    const module = JSON.stringify(new URL('./dev-pidfile.js', import.meta.url).href);
    const claimant = [
      `const m = await import(${module});`,
      'const [file, role, dead] = process.argv.slice(1);',
      "let won = 'lost';",
      "if (role === 'reaper') { m.reapDevPidfile(file, dead); won = 'reaped'; }",
      'else {',
      '  const self = { pid: process.pid, ppid: process.ppid, port: 3000, command: m.pidCommand(process.pid), parentCommand: m.pidCommand(process.ppid), token: crypto.randomUUID() };',
      "  if (m.claimDevPidfile(file, self).acquired) won = 'won ' + process.pid;",
      '}',
      'process.stdout.write(won + "\\n");',
      // A winner stays alive until every process of the round has reported: it is the live owner meanwhile.
      "process.stdin.on('data', () => {}); process.stdin.on('end', () => process.exit(0));",
    ].join('\n');
    try {
      for (let round = 0; round < 50; round++) {
        // A record whose process has exited, as a crashed dev server leaves it.
        const dead = JSON.stringify({ pid: 4194300 - round, ppid: 4194000, port: 3000, command: 'node dead-dev-server.js', token: `dead-${round}` });
        writeFileSync(pidfile, dead);
        const roles = ['claim', 'claim', 'claim', round % 2 === 0 ? 'reaper' : 'claim'];
        const runs = roles.map((role) => {
          const child = spawn(process.execPath, ['--input-type=module', '-e', claimant, pidfile, role, dead], { stdio: ['pipe', 'pipe', 'inherit'] });
          let out = '';
          const reported = new Promise<string>((resolve) => child.stdout.on('data', (chunk) => {
            out += chunk;
            if (out.includes('\n')) resolve(out.trim());
          }));
          return { child, reported, exited: once(child, 'exit') };
        });
        const results = await Promise.all(runs.map((r) => r.reported));
        const winners = results.filter((r) => r.startsWith('won '));
        assert.strictEqual(winners.length, 1, `round ${round}: exactly one live owner, not ${JSON.stringify(results)}`);
        assert.strictEqual(parsePidRecord(readFileSync(pidfile, 'utf-8'))?.pid, Number(winners[0].slice(4)), `round ${round}: the pidfile names the owner`);
        for (const r of runs) r.child.stdin?.end();
        await Promise.all(runs.map((r) => r.exited));
        rmSync(pidfile, { force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces its tsx watch predecessor's record in place, so the pidfile never goes missing in a reload", () => {
    // The predecessor exited; its tsx watch (pid 900, our parent) runs on.
    const predecessor = { pid: 1000, ppid: 900, port: 3000, command: 'b', parentCommand: 'node tsx watch server.ts' };
    const fs = memoryFs({ [path]: JSON.stringify(predecessor) });
    const guard = <A extends unknown[], R>(op: (...args: A) => R) => (...args: A): R => {
      const result = op(...args);
      assert.ok(fs.files.has(path), 'the pidfile exists after every step');
      return result;
    };
    const claim = claimDevPidfile(path, self, {
      createExclusive: guard(fs.deps.createExclusive),
      read: guard(fs.deps.read),
      replace: guard(fs.deps.replace),
      remove: guard(fs.deps.remove),
      isAlive: (pid) => pid === 900,
      commandOf: (pid) => (pid === 900 ? 'node tsx watch server.ts' : ''),
    });
    assert.deepStrictEqual(claim, { acquired: true, previous: predecessor });
    assert.deepStrictEqual(parsePidRecord(fs.files.get(path) ?? ''), self);
    assert.strictEqual(fs.files.size, 1, 'no claim file');
  });

  it("does not replace in place a record whose tsx watch is not this start's parent", () => {
    // Another session between two reloads: its watcher is alive, so this start bows out.
    const other = JSON.stringify({ pid: 1000, ppid: 800, port: 3000, command: 'b', parentCommand: 'node tsx watch server.ts' });
    const fs = memoryFs({ [path]: other });
    const claim = claimDevPidfile(path, self, { ...fs.deps, isAlive: (pid) => pid === 800, commandOf: (pid) => (pid === 800 ? 'node tsx watch server.ts' : '') });
    assert.strictEqual(claim.acquired, false);
    assert.strictEqual(fs.files.get(path), other);
  });

  describe('the starting record of a blocks dev CLI', () => {
    // The CLI (pid 700, run from a shell, pid 600) claimed the port before it started tsx watch.
    const cli = { pid: 700, ppid: 600, port: 3000, command: 'node blocks dev', parentCommand: 'bash', starting: true as const, frontend: { pgid: 4242, port: 3100 } };
    const live = { isAlive: (pid: number) => pid === 700 || pid === 600, commandOf: (pid: number) => (pid === 700 ? 'node blocks dev' : 'bash') };

    it('is replaced in place by the dev server that CLI started, which keeps its leftover frontend group', () => {
      const fs = memoryFs({ [path]: JSON.stringify(cli) });
      const claim = claimDevPidfile(path, self, { ...fs.deps, ...live }, 700);
      assert.deepStrictEqual(claim, { acquired: true, previous: cli });
      assert.deepStrictEqual(parsePidRecord(fs.files.get(path) ?? ''), self);
      assert.strictEqual(fs.files.size, 1);
    });

    it('makes any other start bow out while the CLI lives, saying the session is starting', () => {
      for (const adopt of [undefined, 701]) {
        const fs = memoryFs({ [path]: JSON.stringify(cli) });
        const claim = claimDevPidfile(path, self, { ...fs.deps, ...live }, adopt);
        assert.deepStrictEqual(claim, { acquired: false, reason: 'a dev server is already starting on :3000 (pid 700)', port: 3000 });
        assert.strictEqual(fs.files.get(path), JSON.stringify(cli));
      }
    });

    it('is stale once the CLI has exited, though its caller lives on', () => {
      const fs = memoryFs({ [path]: JSON.stringify(cli) });
      const claim = claimDevPidfile(path, self, { ...fs.deps, isAlive: (pid) => pid === 600, commandOf: () => 'bash' });
      assert.deepStrictEqual(claim, { acquired: true, previous: cli });
    });
  });
});

// ── parsePidRecord ──────────────────────────────────────────────────────────
describe('parsePidRecord — tolerant pidfile parsing', () => {
  it('parses a well-formed record', () => {
    assert.deepStrictEqual(parsePidRecord('{"pid":12,"ppid":3,"port":3000}'), { pid: 12, ppid: 3, port: 3000 });
    assert.deepStrictEqual(parsePidRecord('{"pid":12,"ppid":3,"port":3000,"starting":true}'), { pid: 12, ppid: 3, port: 3000, starting: true });
    assert.deepStrictEqual(parsePidRecord('{"pid":12,"ppid":3,"port":3000,"starting":1}'), { pid: 12, ppid: 3, port: 3000 });
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
    result: ReclaimResult = { wasOpen: true, reclaimed: true, pids: [], foreign: [] },
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
    const c = makeController({ wasOpen: true, reclaimed: true, pids: [], foreign: [] }, { maxAttempts: 2, backoffMs: 100 });

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
    const c = makeController({ wasOpen: true, reclaimed: false, pids: [], foreign: [{ pid: 4242, command: 'vite' }] });

    c.handler(); // attempt 1 → retry; reclaim fails
    await flush();

    assert.ok(
      c.warnings.some((w) => /in use by pid 4242 \(vite\)/.test(w)),
      'operator sees the pid-naming reclaim message, not just the generic banner',
    );
    // A failed reclaim still schedules the next attempt (the budget, not reclaim
    // success, bounds the loop).
    assert.strictEqual(c.scheduled.length, 1);
  });
});

describe('scheduleBindRetry — front-door retry timer', () => {
  it('does not unref the retry timer', () => {
    let callback: (() => void) | undefined;
    let delay: number | undefined;
    let unrefCalls = 0;
    const timer = {
      unref: () => { unrefCalls += 1; return timer; },
    } as NodeJS.Timeout;

    const returned = scheduleBindRetry(
      () => {},
      250,
      (fn, delayMs) => {
        callback = fn;
        delay = delayMs;
        return timer;
      },
    );

    assert.strictEqual(returned, timer);
    assert.strictEqual(delay, 250);
    assert.ok(callback);
    assert.strictEqual(unrefCalls, 0, 'front-door bind retry must keep the event loop alive');
  });
});

describe('claimDevSession — release', () => {
  it("removes the dev server's record once its session is over, and never a live one", () => {
    // A backend that throws while it loads ends its dev server before it removes the record it took over.
    const root = mkdtempSync(join(tmpdir(), 'dev-session-release-'));
    try {
      const pidfile = join(root, '.blocks-sandbox', 'dev-server.41951.pid');
      const first = claimDevSession(root, 41951);
      assert.ok(first.acquired);
      writeFileSync(pidfile, JSON.stringify({ pid: 4194302, ppid: 4194303, port: 41951, command: 'node gone.js', token: 'dead-run' }));
      first.release();
      assert.throws(() => readFileSync(pidfile), 'the dead record is gone');

      const second = claimDevSession(root, 41951);
      assert.ok(second.acquired);
      // Another live process (our parent) plays a dev server that runs: release removes only this CLI's own record.
      const live = JSON.stringify({ pid: process.ppid, ppid: 1, port: 41951, command: pidCommand(process.ppid), token: 'live-run' });
      writeFileSync(pidfile, live);
      second.release();
      assert.strictEqual(readFileSync(pidfile, 'utf-8'), live, 'a live record stays');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
