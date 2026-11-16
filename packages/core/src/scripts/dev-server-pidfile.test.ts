// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Two dev servers started together (`npm run dev &` and `npm run test:e2e`,
// which starts its own when none is listening yet) both pass the singleton guard
// before either binds the port. The one that binds second does so only after the
// other has exited and removed its pidfile, so unless the server records itself
// when it starts listening, it serves with no pidfile and `dev:stop` reports
// nothing to stop. This test drives that order with a stand-in peer that holds
// the port, takes over the pidfile once the real server has written its startup
// record, and then removes its own record and releases the port.

import { after, describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { devPidfilePath, parsePidRecord, type DevServerPidRecord } from './dev-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const BACKEND = `
export const api = () => ({ async ping() { return 'pong'; } });
`;

// The stand-in peer: holds the port, waits for the real server's startup record,
// replaces it with its own (as the later of two concurrent starts does), then
// exits the way a dev server does — removing its own record, releasing the port.
const PEER = `
const net = require('node:net');
const fs = require('node:fs');
const [port, pidfile, serverPid] = process.argv.slice(1).map((v, i) => (i === 1 ? v : Number(v)));
let handedOff = false;
function handOff() {
  if (handedOff) return;
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(pidfile, 'utf8')); } catch {}
  if (!rec || rec.ppid !== serverPid) return;
  handedOff = true;
  fs.writeFileSync(pidfile, JSON.stringify({ pid: process.pid, ppid: process.ppid, port }));
  fs.unlinkSync(pidfile);
  server.close(() => process.exit(0));
}
const server = net.createServer().listen(port, '127.0.0.1', () => {
  process.stdout.write('listening\\n');
  setInterval(handOff, 10);
});
process.on('SIGTERM', () => { handOff(); if (!handedOff) process.exit(0); });
`;

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const { port } = address;
  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  return port;
}

// Polls real child processes for a condition (no fixed sleep): the processes
// under test run on their own clocks, so fake timers cannot drive them.
async function waitUntil(done: () => boolean, what: string, output: () => string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}:\n${output()}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

describe('dev server pidfile after a concurrent start', () => {
  const tempDir = join(tmpdir(), `dev-pidfile-${process.pid}-${Date.now()}`);
  const children: ChildProcess[] = [];

  after(() => {
    for (const child of children) {
      if (!exited(child) && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('records the server that binds the port, so dev:stop stops it', async () => {
    const port = await getAvailablePort();
    mkdirSync(join(tempDir, '.blocks-sandbox'), { recursive: true });
    writeFileSync(join(tempDir, 'backend.ts'), BACKEND);
    writeFileSync(join(tempDir, 'run-dev.ts'), `
import { startDevServer } from ${JSON.stringify(join(__dirname, 'dev-server.js').replace(/\\/g, '/'))};
startDevServer(${JSON.stringify({ backendPath: join(tempDir, 'backend.ts'), port, typegen: false })});
`);
    const pidfile = join(tempDir, devPidfilePath(port));
    const env: NodeJS.ProcessEnv = { ...process.env, AWS_BLOCKS_DISABLE_TELEMETRY: '1' };
    delete env.BLOCKS_API_URL;
    delete env.BLOCKS_DEV_HOST;

    // `tsx watch`, as `npm run dev` runs it: the watcher is the recorded ppid.
    const tsxBin = join(__dirname, '..', '..', '..', '..', 'node_modules', '.bin', 'tsx');
    const dev = spawn(tsxBin, ['watch', join(tempDir, 'run-dev.ts')], {
      cwd: tempDir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(dev);
    let devOut = '';
    dev.stdout?.on('data', chunk => { devOut += chunk.toString(); });
    dev.stderr?.on('data', chunk => { devOut += chunk.toString(); });

    // The peer starts listening before the server reaches its own bind, because
    // the server only binds after loading the backend.
    const peer = spawn(process.execPath, ['-e', PEER, String(port), pidfile, String(dev.pid)], {
      cwd: tempDir, detached: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    children.push(peer);

    await waitUntil(() => devOut.includes('AWS Blocks local server running') || exited(dev), 'the dev server to listen', () => devOut);
    assert.ok(!exited(dev), `dev server exited early:\n${devOut}`);
    await waitUntil(() => exited(peer), 'the peer to exit', () => devOut);

    let record: DevServerPidRecord | null = null;
    try { record = parsePidRecord(readFileSync(pidfile, 'utf-8')); } catch { /* absent */ }
    assert.ok(record, `no pidfile for the listening dev server:\n${devOut}`);
    assert.equal(record.ppid, dev.pid);
    assert.equal(record.port, port);

    const stopEntry = join(__dirname, 'dev-server.js').replace(/\\/g, '/');
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '-e', `import(${JSON.stringify(stopEntry)}).then(m => m.runStopCli(['--port', '${port}']));`],
      { cwd: tempDir, env },
    );
    assert.match(stdout, new RegExp(`Stopped the dev server on :${port}`));
    await waitUntil(() => exited(dev), 'the dev server to exit', () => devOut);
  });
});
