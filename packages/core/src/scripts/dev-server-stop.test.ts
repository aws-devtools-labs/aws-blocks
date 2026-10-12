// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  stopDevServer,
  stopMessage,
  statusDevServer,
  statusMessage,
  findDevServerPorts,
  devPidfilePath,
  parsePortArg,
  type StopDevServerDeps,
} from './dev-server.js';

// Fully injected: no real processes, ports, or filesystem. A scripted `probe`
// models the port's open/closed state across the stop sequence so we can assert
// exactly which signals are sent and when it escalates — the same approach the
// reclaim tests use.

/** A sequencer that returns the i-th scripted boolean, holding the last value. */
function seq(states: boolean[]): () => Promise<boolean> {
  let i = 0;
  return async () => states[Math.min(i++, states.length - 1)];
}

function makeDeps(overrides: Partial<StopDevServerDeps> = {}): {
  deps: StopDevServerDeps;
  signals: Array<{ pid: number; signal: string }>;
  removed: string[];
} {
  const signals: Array<{ pid: number; signal: string }> = [];
  const removed: string[] = [];
  const deps: StopDevServerDeps = {
    readPidfile: () => null,
    removePidfile: (p) => { removed.push(p); },
    probe: async () => false,
    listPids: () => [],
    killTree: (pid, signal) => { signals.push({ pid, signal }); },
    waitFree: async () => {},
    ...overrides,
  };
  return { deps, signals, removed };
}

describe('stopDevServer — stops by listener PID, never by process name', () => {
  it('is an idempotent no-op when nothing is listening', async () => {
    const { deps, signals } = makeDeps({ probe: async () => false });
    const r = await stopDevServer(3000, 3100, deps);
    assert.equal(r.stopped, false);
    assert.equal(r.alreadyStopped, true);
    assert.equal(r.portsFree, true);
    assert.deepEqual(signals, []);
  });

  it('SIGTERMs the listener and resolves stopped when the port frees after SIGTERM', async () => {
    // front door: open, then free after SIGTERM; frontend: never open.
    const probe = (() => {
      const perPort: Record<number, () => Promise<boolean>> = {
        3000: seq([true, false, false]),
        3100: seq([false]),
      };
      return (p: number) => perPort[p]();
    })();
    const { deps, signals, removed } = makeDeps({
      probe,
      listPids: (p) => (p === 3000 ? [4242] : []),
      readPidfile: () => JSON.stringify({ pid: 4242, ppid: 4000, port: 3000 }),
    });
    const r = await stopDevServer(3000, 3100, deps);
    assert.equal(r.stopped, true);
    assert.equal(r.alreadyStopped, false);
    assert.equal(r.portsFree, true);
    assert.deepEqual(signals, [{ pid: 4242, signal: 'SIGTERM' }]);
    // The pidfile was present → it is cleaned up.
    assert.deepEqual(removed, [devPidfilePath(3000)]);
  });

  it('escalates to SIGKILL when the port is still held after SIGTERM', async () => {
    // open, still open after SIGTERM, then free after SIGKILL.
    const probe = (() => {
      const perPort: Record<number, () => Promise<boolean>> = {
        3000: seq([true, true, false]),
        3100: seq([false]),
      };
      return (p: number) => perPort[p]();
    })();
    const { deps, signals } = makeDeps({
      probe,
      listPids: (p) => (p === 3000 ? [777] : []),
    });
    const r = await stopDevServer(3000, 3100, deps);
    assert.equal(r.stopped, true);
    assert.deepEqual(signals, [
      { pid: 777, signal: 'SIGTERM' },
      { pid: 777, signal: 'SIGKILL' },
    ]);
  });

  it('reaps an orphaned frontend port even with no pidfile', async () => {
    const probe = (() => {
      const perPort: Record<number, () => Promise<boolean>> = {
        3000: seq([false]),
        3100: seq([true, false, false]),
      };
      return (p: number) => perPort[p]();
    })();
    const { deps, signals, removed } = makeDeps({
      probe,
      listPids: (p) => (p === 3100 ? [9001] : []),
      readPidfile: () => null, // crashed server, no live record
    });
    const r = await stopDevServer(3000, 3100, deps);
    assert.equal(r.stopped, true);
    assert.deepEqual(signals, [{ pid: 9001, signal: 'SIGTERM' }]);
    // No pidfile was present → nothing to remove.
    assert.deepEqual(removed, []);
  });
});

describe('stopMessage', () => {
  it('says nothing-to-stop when already stopped', () => {
    assert.match(
      stopMessage({ port: 3000, stopped: false, alreadyStopped: true, record: null, pids: [], portsFree: true }),
      /nothing to stop/,
    );
  });
  it('confirms a stop with the pids', () => {
    assert.match(
      stopMessage({ port: 3000, stopped: true, alreadyStopped: false, record: null, pids: [1, 2], portsFree: true }),
      /Stopped the dev server on :3000 \(pids 1, 2\)/,
    );
  });
  it('warns when a port is still bound after signalling', () => {
    assert.match(
      stopMessage({ port: 3000, stopped: true, alreadyStopped: false, record: null, pids: [1], portsFree: false }),
      /still bound/,
    );
  });
});

describe('statusDevServer', () => {
  it('reports running with the recorded pid', async () => {
    const r = await statusDevServer(3000, {
      readPidfile: () => JSON.stringify({ pid: 55, ppid: 50, port: 3000 }),
      probe: async () => true,
      isAlive: () => true,
    });
    assert.equal(r.running, true);
    assert.equal(r.stalePidfile, false);
    assert.match(statusMessage(r), /running on :3000 \(pid 55\)/);
  });

  it('reports not-running with no pidfile', async () => {
    const r = await statusDevServer(3000, {
      readPidfile: () => null,
      probe: async () => false,
      isAlive: () => false,
    });
    assert.equal(r.running, false);
    assert.equal(r.stalePidfile, false);
    assert.match(statusMessage(r), /not running on :3000\./);
  });

  it('flags a stale pidfile when the owner is dead and the port is free', async () => {
    const r = await statusDevServer(3000, {
      readPidfile: () => JSON.stringify({ pid: 55, ppid: 50, port: 3000 }),
      probe: async () => false,
      isAlive: () => false,
    });
    assert.equal(r.stalePidfile, true);
    assert.match(statusMessage(r), /stale pidfile/);
  });
});

describe('findDevServerPorts — scans .blocks-sandbox pidfiles', () => {
  it('extracts ports from dev-server.<port>.pid names and ignores others', () => {
    const ports = findDevServerPorts(() => [
      'dev-server.3000.pid',
      'dev-server.3001.pid',
      'config.json',
      'dev-server.badport.pid',
      'sandbox-id.txt',
    ]);
    assert.deepEqual(ports.sort((a, b) => a - b), [3000, 3001]);
  });
  it('returns [] when the dir is absent/unreadable', () => {
    assert.deepEqual(findDevServerPorts(() => { throw new Error('ENOENT'); }), []);
  });
});

describe('parsePortArg', () => {
  it('parses --port <n>', () => assert.equal(parsePortArg(['--port', '3005']), 3005));
  it('parses --port=<n>', () => assert.equal(parsePortArg(['--port=3006']), 3006));
  it('returns null when absent', () => assert.equal(parsePortArg(['--foo']), null));
  it('returns null on a non-numeric value', () => assert.equal(parsePortArg(['--port', 'abc']), null));
});
