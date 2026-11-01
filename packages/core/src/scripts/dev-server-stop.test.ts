// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  stopDevServer,
  stopMessage,
  isStopWarning,
  runStopCli,
  devPidfilePath,
  parsePortArg,
  portInUseHint,
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
    groupOf: () => undefined,
    waitFree: async () => {},
    waitExit: async () => true,
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
    // The session ends while the stop waits for the port: only then does its record go.
    let ended = false;
    const { deps, sigs, removed } = makeDeps({
      readPidfile: () => JSON.stringify({ pid: 4242, ppid: 4000, port: 3000 }),
      isAlive: (pid) => !ended && (pid === 4000 || pid === 4242),
      waitFree: async () => { ended = true; },
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

  it("SIGKILLs a tsx watch that outlives its dead runner, and says so (H4)", async () => {
    // A runner killed by a signal: tsx waits for an exit that already happened, and ignores SIGTERM.
    let watcher = true;
    const waits: Array<[number, number]> = [];
    const { deps, sigs, removed } = makeDeps({
      readPidfile: () => JSON.stringify({ pid: 4242, ppid: 4000, port: 3000 }),
      isAlive: (pid) => pid === 4000 && watcher,
      commandOf: (pid) => (pid === 4000 ? TSX : ''),
      signal: (pid, signal) => {
        sigs.push({ pid, signal, via: 'signal' });
        if (signal === 'SIGKILL') watcher = false;
      },
      waitExit: async (pid, ms) => { waits.push([pid, ms]); return !watcher; },
    });
    const r = await stopDevServer(3000, deps);
    assert.equal(r.via, 'watcher');
    assert.equal(r.killed, true);
    assert.equal(r.portFree, true);
    assert.deepEqual(sigs, [
      { pid: 4000, signal: 'SIGTERM', via: 'signal' },
      { pid: 4000, signal: 'SIGKILL', via: 'signal' },
    ]);
    assert.equal(waits[0][1], 2000, 'a watcher without a runner gets a short grace, not the runner budget');
    assert.deepEqual(removed, [devPidfilePath(3000)]);
    assert.match(stopMessage(r), /its tsx watch had lost its runner and ignored SIGTERM, so it was killed/);
  });

  it('never SIGKILLs a watcher whose runner is still shutting down, and warns that the session goes on', async () => {
    const { deps, sigs, removed } = makeDeps({
      readPidfile: () => JSON.stringify({ pid: 4242, ppid: 4000, port: 3000 }),
      isAlive: (pid) => pid === 4000 || pid === 4242,
      commandOf: (pid) => (pid === 4000 ? TSX : ''),
      waitExit: async () => false,
    });
    const r = await stopDevServer(3000, deps);
    assert.deepEqual(sigs, [{ pid: 4000, signal: 'SIGTERM', via: 'signal' }]);
    assert.equal(r.portFree, false, 'reported as a warning: the session has not ended');
    assert.equal(isStopWarning(r), true);
    assert.deepEqual(removed, [], 'a live session keeps its record');
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

describe('stopDevServer — what it reports when nothing of this app runs', () => {
  it('names the foreign process that holds the port, without signalling it', async () => {
    const { deps, sigs } = makeDeps({
      readPidfile: () => null,
      probe: async () => true,
      listPids: () => [4321],
      commandOf: (pid) => (pid === 4321 ? 'python3 -m http.server 3000' : ''),
    });
    const r = await stopDevServer(3000, deps);
    assert.equal(r.alreadyStopped, true);
    assert.deepEqual(r.holders, [{ pid: 4321, command: 'python3 -m http.server 3000' }]);
    assert.deepEqual(sigs, []);
    const message = stopMessage(r);
    assert.doesNotMatch(message, /nothing to stop/);
    assert.match(message, /held by another process, which was not stopped: pid 4321 \(python3 -m http\.server 3000\)/);
  });

  it('removes an unreadable pidfile, so --all stops listing its port', async () => {
    const { deps, removed } = makeDeps({ readPidfile: () => 'garbage' });
    const r = await stopDevServer(3000, deps);
    assert.equal(r.alreadyStopped, true);
    assert.deepEqual(removed, [devPidfilePath(3000)]);
  });

  it('treats a recorded child whose pid now runs another command as gone', async () => {
    const { deps, sigs, removed } = makeDeps({
      readPidfile: () => JSON.stringify({ pid: 777, ppid: 500, port: 3000, command: 'node run-dev.ts' }),
      isAlive: (pid) => pid === 777,
      commandOf: () => 'postgres: writer',
      probe: async () => true,
      listPids: () => [777],
    });
    const r = await stopDevServer(3000, deps);
    assert.equal(r.via, 'none');
    assert.deepEqual(sigs, []);
    assert.deepEqual(removed, [devPidfilePath(3000)], 'the stale record is cleared');
  });
});

describe('stopDevServer — the frontend a SIGKILLed dev server left behind', () => {
  // A SIGKILL of the dev group leaves its detached Vite holding the frontend port. dev stop used to clear
  // the record as stale, which the next start needed to reclaim that port, and that start then failed (JA-3).
  const record = JSON.stringify({ pid: 777, ppid: 500, port: 3000, command: 'node run-dev.ts', frontend: { pgid: 900, port: 3100 } });

  it("stops the recorded frontend group when it still holds the frontend port, then clears the record", async () => {
    let held = true;
    const { deps, sigs, removed } = makeDeps({
      readPidfile: () => record,
      probe: async (p) => p === 3100 && held,
      listPids: (p) => (p === 3100 && held ? [901] : []),
      groupOf: (pid) => (pid === 901 ? 900 : undefined),
      killTree: (pid, signal) => { sigs.push({ pid, signal, via: 'killTree' }); held = false; },
    });
    const r = await stopDevServer(3000, deps);
    assert.equal(r.via, 'frontend');
    assert.equal(r.stopped, true);
    assert.equal(r.portFree, true);
    assert.deepEqual(r.frontend, { pgid: 900, port: 3100 });
    assert.deepEqual(sigs, [{ pid: 900, signal: 'SIGTERM', via: 'killTree' }], 'the recorded group, by its pgid');
    assert.deepEqual(removed, [devPidfilePath(3000)]);
    assert.match(stopMessage(r), /stopped the frontend that this app's dev server left running on :3100 \(pid 901\)/);
  });

  it('leaves a frontend port that another process holds alone, and clears the record', async () => {
    const { deps, sigs, removed } = makeDeps({
      readPidfile: () => record,
      probe: async (p) => p === 3100,
      listPids: (p) => (p === 3100 ? [4242] : []),
      groupOf: () => 4242,
    });
    const r = await stopDevServer(3000, deps);
    assert.equal(r.via, 'none');
    assert.deepEqual(sigs, []);
    assert.deepEqual(removed, [devPidfilePath(3000)]);
  });
});

describe('portInUseHint — an exact next command', () => {
  it('names the pids to stop, how to start again, and the flag for another port', () => {
    assert.equal(
      portInUseHint(3100, { foreign: [{ pid: 3181756, command: 'node vite --port 3100 --strictPort' }], pids: [] }, '--frontend-port'),
      'Stop it with `kill 3181756`, then run `npx --no -- blocks dev` again, or choose another port with --frontend-port.',
    );
    assert.match(portInUseHint(3000, { foreign: [], pids: [] }, '--port'), /`lsof -i :3000`/);
  });
});

/** Per-call probe sequencer shared across both ports (front door only here). */
function seqProbe(states: boolean[]): (port: number) => Promise<boolean> {
  const s = seq(states);
  return () => s();
}

describe('stopMessage', () => {
  const base: StopResult = { port: 3000, stopped: false, alreadyStopped: true, record: null, via: 'none', pids: [], portFree: true, holders: [] };
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

  it('sends the still-bound warning to stderr and only that case is a warning', () => {
    const base: StopResult = { port: 3000, stopped: true, alreadyStopped: false, record: null, via: 'watcher', pids: [1], portFree: false, holders: [] };
    assert.equal(isStopWarning(base), true);
    assert.equal(isStopWarning({ ...base, portFree: true }), false);
    assert.equal(isStopWarning({ ...base, alreadyStopped: true, stopped: false, via: 'none', pids: [] }), false);
  });

  it('parsePortArg feeds the CLI', () => {
    assert.equal(parsePortArg(['--port', '3005']), 3005);
    assert.equal(parsePortArg(['--port=3006']), 3006);
    assert.equal(parsePortArg(['--foo']), null);
    assert.equal(parsePortArg(['--port', 'abc']), null);
    assert.equal(parsePortArg(['--port', '0']), null);
  });
});

describe('stopDevServer — a blocks dev CLI whose dev server is still starting', () => {
  const CLI = 'node /app/node_modules/@aws-blocks/blocks/dist/cli/bin.js dev';
  const starting = JSON.stringify({ pid: 700, ppid: 600, port: 3000, command: CLI, parentCommand: 'bash', starting: true });

  it('SIGTERMs the CLI alone, never its caller, waits for it, and removes the pidfile it left', async () => {
    let pidfile: string | null = starting;
    const waited: number[] = [];
    const { deps, sigs, removed } = makeDeps({
      readPidfile: () => pidfile,
      removePidfile: (p) => { removed.push(p); pidfile = null; },
      isAlive: (pid) => pid === 700 || pid === 600,
      commandOf: (pid) => (pid === 700 ? CLI : 'bash'),
      waitExit: async (pid) => { waited.push(pid); return true; },
    });
    // The CLI's exit leaves the record of the dev server that took it over, and ended.
    deps.signal = (pid, signal) => {
      sigs.push({ pid, signal, via: 'signal' });
      pidfile = JSON.stringify({ pid: 702, ppid: 701, port: 3000, command: 'node dev-server.js', parentCommand: 'tsx watch' });
      deps.isAlive = () => false;
    };
    const r = await stopDevServer(3000, deps);
    assert.deepEqual(sigs, [{ pid: 700, signal: 'SIGTERM', via: 'signal' }]);
    assert.deepEqual(waited, [700]);
    assert.equal(r.via, 'cli');
    assert.equal(r.stopped, true);
    assert.equal(r.portFree, true);
    assert.deepEqual(removed, [devPidfilePath(3000)]);
    assert.match(stopMessage(r), /Stopped the dev server on :3000 \(pid 700\)/);
  });

  it('keeps the record of a live session that took the pidfile over meanwhile', async () => {
    const live = JSON.stringify({ pid: 900, ppid: 901, port: 3000, command: 'node dev-server.js', parentCommand: 'tsx watch x' });
    let pidfile = starting;
    const { deps, removed } = makeDeps({
      readPidfile: () => pidfile,
      isAlive: () => true,
      commandOf: (pid) => ({ 700: CLI, 900: 'node dev-server.js', 901: 'tsx watch x' })[pid] ?? 'bash',
      signal: () => { pidfile = live; },
    });
    assert.equal((await stopDevServer(3000, deps)).via, 'cli');
    assert.deepEqual(removed, []);
  });

  it('treats the record of a CLI that has exited as stale', async () => {
    const { deps, sigs, removed } = makeDeps({
      readPidfile: () => starting,
      // Its caller, the shell, is still alive, and is never signalled.
      isAlive: (pid) => pid === 600,
      commandOf: () => 'bash',
    });
    const r = await stopDevServer(3000, deps);
    assert.equal(r.alreadyStopped, true);
    assert.deepEqual(sigs, []);
    assert.deepEqual(removed, [devPidfilePath(3000)]);
  });
});
