// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  stopDevServer,
  stopMessage,
  runStopCli,
  devPidfilePath,
  parsePortArg,
  type StopDevServerDeps,
  type StopResult,
} from './dev-server.js';

// Fully injected: no real processes, ports, or filesystem. We assert ownership
// (only the pids the pidfile recorded are ever signalled) and that the tsx-watch
// supervisor — not just the listener child — is the primary target. A real
// nested-process test lives in dev-server-stop-supervisor.test.ts.

/** A sequencer that returns the i-th scripted boolean, holding the last value. */
function seq(states: boolean[]): () => Promise<boolean> {
  let i = 0;
  return async () => states[Math.min(i++, states.length - 1)];
}

const TSX = 'node /app/node_modules/.bin/tsx watch aws-blocks/scripts/server.ts';

function makeDeps(overrides: Partial<StopDevServerDeps> = {}): {
  deps: StopDevServerDeps;
  sigs: Array<{ pid: number; signal: string; via: 'signal' | 'killTree' }>;
  removed: string[];
} {
  const sigs: Array<{ pid: number; signal: string; via: 'signal' | 'killTree' }> = [];
  const removed: string[] = [];
  const deps: StopDevServerDeps = {
    readPidfile: () => null,
    removePidfile: (p) => { removed.push(p); },
    isAlive: () => false,
    commandOf: () => '',
    signal: (pid, signal) => { sigs.push({ pid, signal, via: 'signal' }); },
    probe: async () => false,
    listPids: () => [],
    killTree: (pid, signal) => { sigs.push({ pid, signal, via: 'killTree' }); },
    waitFree: async () => {},
    ...overrides,
  };
  return { deps, sigs, removed };
}

describe('stopDevServer — proves ownership, targets the tsx watch supervisor', () => {
  it('is an idempotent no-op when there is no pidfile', async () => {
    const { deps, sigs } = makeDeps({ readPidfile: () => null, probe: async () => false });
    const r = await stopDevServer(3000, deps);
    assert.equal(r.alreadyStopped, true);
    assert.equal(r.via, 'none');
    assert.equal(r.portFree, true);
    assert.deepEqual(sigs, []);
  });

  it('SIGTERMs the recorded tsx-watch ppid (the clean watcher path)', async () => {
    const { deps, sigs, removed } = makeDeps({
      readPidfile: () => JSON.stringify({ pid: 4242, ppid: 4000, port: 3000 }),
      isAlive: (pid) => pid === 4000 || pid === 4242,
      commandOf: (pid) => (pid === 4000 ? TSX : ''),
      // The watcher path probes once, after the SIGTERM: free ⇒ clean stop.
      probe: seqProbe([false]),
    });
    const r = await stopDevServer(3000, deps);
    assert.equal(r.via, 'watcher');
    assert.equal(r.stopped, true);
    assert.equal(r.portFree, true);
    // The WATCHER (ppid) is signalled, exactly once, via a single-pid signal —
    // not killTree, and never the listener child.
    assert.deepEqual(sigs, [{ pid: 4000, signal: 'SIGTERM', via: 'signal' }]);
    assert.deepEqual(removed, [devPidfilePath(3000)]);
  });

  it('does NOT signal the ppid when it is a bare shell, not a tsx watcher (self-kill guard)', async () => {
    // Started as `node server.ts` from a shell → ppid is the shell. Child holds
    // the port, so we fall back to the recorded CHILD's listener tree — never the
    // shell.
    const { deps, sigs } = makeDeps({
      readPidfile: () => JSON.stringify({ pid: 4242, ppid: 500, port: 3000 }),
      isAlive: (pid) => pid === 500 || pid === 4242,
      commandOf: (pid) => (pid === 500 ? '-bash' : ''), // the user's shell
      probe: seqProbe([true, false]),
      listPids: (p) => (p === 3000 ? [4242] : []),
    });
    const r = await stopDevServer(3000, deps);
    assert.equal(r.via, 'listener');
    // The shell ppid (500) is NEVER signalled; only the recorded child via killTree.
    assert.ok(!sigs.some((s) => s.pid === 500), 'shell ppid must never be signalled');
    assert.deepEqual(sigs, [{ pid: 4242, signal: 'SIGTERM', via: 'killTree' }]);
  });

  it('fallback escalates SIGTERM→SIGKILL on the recorded child when the watcher is gone', async () => {
    const { deps, sigs } = makeDeps({
      readPidfile: () => JSON.stringify({ pid: 777, ppid: 500, port: 3000 }),
      isAlive: (pid) => pid === 777, // watcher ppid 500 already dead
      commandOf: () => '',
      // bound; still bound after SIGTERM; free after SIGKILL
      probe: seqProbe([true, true, false]),
      listPids: (p) => (p === 3000 ? [777] : []),
    });
    const r = await stopDevServer(3000, deps);
    assert.equal(r.via, 'listener');
    assert.deepEqual(sigs, [
      { pid: 777, signal: 'SIGTERM', via: 'killTree' },
      { pid: 777, signal: 'SIGKILL', via: 'killTree' },
    ]);
  });

  it('NEVER kills a foreign process: a stale pidfile whose owner is dead is just cleared', async () => {
    // The reproduced bug: stale pidfile for :3000, an UNRELATED process now binds
    // :3000. Ownership is not proven (both recorded pids dead), so nothing is
    // signalled — the foreign process is left alone and the stale file is cleared.
    const { deps, sigs, removed } = makeDeps({
      readPidfile: () => JSON.stringify({ pid: 111, ppid: 110, port: 3000 }),
      isAlive: () => false, // neither recorded pid alive
      probe: async () => true, // an unrelated process holds :3000
      listPids: () => [99999], // the foreign pid — must NOT be touched
    });
    const r = await stopDevServer(3000, deps);
    assert.equal(r.via, 'none');
    assert.equal(r.alreadyStopped, true);
    assert.deepEqual(sigs, [], 'a foreign same-port process must never be signalled');
    assert.deepEqual(removed, [devPidfilePath(3000)], 'the stale pidfile is cleared');
  });

  it('does NOT reap by port scan: a child that no longer holds the port is not force-killed', async () => {
    // Recorded child alive but not the listener on :3000 (another pid is) — we do
    // not kill it, because ownership of the PORT is not proven.
    const { deps, sigs } = makeDeps({
      readPidfile: () => JSON.stringify({ pid: 777, ppid: 500, port: 3000 }),
      isAlive: (pid) => pid === 777,
      probe: async () => true,
      listPids: () => [55555], // some other listener, not our recorded child
    });
    const r = await stopDevServer(3000, deps);
    assert.equal(r.via, 'none');
    assert.deepEqual(sigs, [], 'only the recorded child listener is reaped, never an arbitrary one');
  });

  it('keeps the pidfile when the port is still bound after the watcher signal', async () => {
    const { deps, removed } = makeDeps({
      readPidfile: () => JSON.stringify({ pid: 4242, ppid: 4000, port: 3000 }),
      isAlive: (pid) => pid === 4000 || pid === 4242,
      commandOf: (pid) => (pid === 4000 ? TSX : ''),
      probe: async () => true, // never frees
    });
    const r = await stopDevServer(3000, deps);
    assert.equal(r.via, 'watcher');
    assert.equal(r.portFree, false);
    assert.deepEqual(removed, [], 'a surviving server keeps its singleton guard');
  });
});

/** Per-call probe sequencer shared across both ports (front door only here). */
function seqProbe(states: boolean[]): (port: number) => Promise<boolean> {
  const s = seq(states);
  return () => s();
}

describe('stopMessage', () => {
  const base: StopResult = { port: 3000, stopped: false, alreadyStopped: true, record: null, via: 'none', pids: [], portFree: true };
  it('says nothing-to-stop when already stopped', () => {
    assert.match(stopMessage(base), /nothing to stop/);
  });
  it('confirms a stop with the pid', () => {
    assert.match(
      stopMessage({ ...base, stopped: true, alreadyStopped: false, via: 'watcher', pids: [4000], portFree: true }),
      /Stopped the dev server on :3000 \(pid 4000\)/,
    );
  });
  it('warns when the port is still bound after signalling', () => {
    assert.match(
      stopMessage({ ...base, stopped: true, alreadyStopped: false, via: 'watcher', pids: [4000], portFree: false }),
      /still\s+bound/,
    );
  });
});

describe('runStopCli', () => {
  it('honours --port and exits 0 on a clean stop', async () => {
    const prev = process.exitCode;
    process.exitCode = 0;
    const logs: string[] = [];
    const log = console.log;
    console.log = (m?: unknown) => { logs.push(String(m)); };
    try {
      // Default-dep stop against a port with nothing on it → alreadyStopped, exit 0.
      await runStopCli(['--port', '3999']);
    } finally {
      console.log = log;
    }
    assert.ok(logs.some((l) => /:3999/.test(l)));
    assert.notEqual(process.exitCode, 1);
    process.exitCode = prev;
  });

  it('parsePortArg feeds the CLI', () => {
    assert.equal(parsePortArg(['--port', '3005']), 3005);
    assert.equal(parsePortArg(['--port=3006']), 3006);
    assert.equal(parsePortArg(['--foo']), null);
    assert.equal(parsePortArg(['--port', 'abc']), null);
    assert.equal(parsePortArg(['--port', '0']), null);
  });
});
