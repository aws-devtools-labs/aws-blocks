// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Real-process tests of the dev server's lifecycle: closed output, the
// singleton guard, port ownership and fatal startup failures. Each test runs
// `startDevServer` in its own app directory under `tsx` (optionally `tsx watch`,
// as `blocks dev` does) on free ports.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type DevServerOptions, devPidfilePath, stopDevServer } from './dev-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tsxCli = join(__dirname, '..', '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const posix = process.platform !== 'win32';

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  server.close();
  await once(server, 'close');
  return address.port;
}

/** Poll `check` until it returns a value; the only signal some of these real processes give. */
async function waitFor<T>(
  what: string,
  check: () => T | undefined | false | Promise<T | undefined | false>,
  runs: DevRun[] = [],
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  const output = runs.map((run, i) => `\n--- run ${i} stdout:\n${run.out.stdout}\n--- run ${i} stderr:\n${run.out.stderr}`).join('');
  assert.fail(`timed out waiting for ${what}${output}`);
}

interface DevRun {
  child: ChildProcess;
  out: { stdout: string; stderr: string };
  exited: Promise<number | null>;
}

const live: ChildProcess[] = [];
let entries = 0;
const dirs: string[] = [];

/** A minimal app: one API, run from its own directory (the dev server's pidfiles are cwd-relative). */
function makeApp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dev-lifecycle-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'backend.ts'), "export const testApi = { ping: async () => 'pong' };\n");
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dev-lifecycle-app', private: true, type: 'module' }));
  return dir;
}

const quote = (word: string) => `'${word.replace(/'/g, "'\\''")}'`;

/** An HTTP server answering `body` on `port`, as a separate process: a frontend, or someone else's server. */
function serverScript(dir: string): string {
  const script = join(dir, 'server.mjs');
  writeFileSync(
    script,
    "import { createServer } from 'node:http';\n" +
      "createServer((_q, r) => r.end(process.argv[3])).listen(Number(process.argv[2]), '127.0.0.1');\n",
  );
  return script;
}

function frontendCommand(dir: string, port: number, body: string): string {
  return `${quote(process.execPath)} ${quote(serverScript(dir))} ${port} ${body}`;
}

/** Start an unrelated process that holds `port`. */
async function foreignServer(dir: string, port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, [serverScript(dir), String(port), 'foreign'], { stdio: 'ignore', detached: posix });
  live.push(child);
  await waitFor('the foreign server', () => fetchText(port).then((t) => t === 'foreign'));
  return child;
}

async function fetchText(port: number, path = '/'): Promise<string | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2000) });
    return await response.text();
  } catch {
    return undefined;
  }
}

function startDev(
  dir: string,
  options: Partial<DevServerOptions>,
  { watch = false, env = {} }: { watch?: boolean; env?: NodeJS.ProcessEnv } = {},
): DevRun {
  // One entry file per run: rewriting a shared one would make a running `tsx watch` reload.
  const entry = `run-dev-${++entries}.ts`;
  writeFileSync(
    join(dir, entry),
    `import { startDevServer } from ${JSON.stringify(join(__dirname, 'dev-server.js'))};\n` +
      `startDevServer(${JSON.stringify({ backendPath: join(dir, 'backend.ts'), typegen: false, ...options })});\n`,
  );
  const child = spawn(process.execPath, [tsxCli, ...(watch ? ['watch', '--clear-screen=false'] : []), entry], {
    cwd: dir,
    env: { ...process.env, AWS_BLOCKS_DISABLE_TELEMETRY: '1', BLOCKS_DEV_QUIET: '1', BLOCKS_LOG_LEVEL: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: posix,
  });
  live.push(child);
  const out = { stdout: '', stderr: '' };
  child.stdout?.on('data', (d) => { out.stdout += d; });
  child.stderr?.on('data', (d) => { out.stderr += d; });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, out, exited };
}

async function rpc(port: number): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}/aws-blocks/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'testApi.ping', params: [], id: 1 }),
    signal: AbortSignal.timeout(2000),
  });
  const body: unknown = await response.json();
  return body && typeof body === 'object' && 'result' in body ? body.result : undefined;
}

async function serving(port: number): Promise<boolean> {
  try {
    return (await rpc(port)) === 'pong';
  } catch {
    return false;
  }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  try {
    if (posix && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* already gone */ }
}

afterEach(async () => {
  for (const child of live.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      killGroup(child, 'SIGTERM');
      const timer = setTimeout(() => killGroup(child), 3000);
      await once(child, 'exit');
      clearTimeout(timer);
    }
    killGroup(child); // anything left in its group
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('dev server lifecycle', { skip: !posix && 'POSIX process groups', timeout: 180_000 }, () => {
  it('keeps serving after its stdout and stderr readers go away (EPIPE)', async () => {
    const port = await freePort();
    // Request logging on, so every call writes to the closed stdout.
    const dev = startDev(makeApp(), { port }, { env: { BLOCKS_DEV_QUIET: '' } });
    await waitFor('the server to start', () => dev.out.stdout.includes('local server running'), [dev]);
    dev.child.stdout?.destroy();
    dev.child.stderr?.destroy();
    for (let i = 0; i < 3; i++) assert.strictEqual(await rpc(port), 'pong');
    assert.strictEqual(dev.child.exitCode, null, 'the dev server is still running');
  });

  it('ends a second blocks dev in the same app at once, with the reason, and leaves the first running', async () => {
    const dir = makeApp();
    const port = await freePort();
    const first = startDev(dir, { port }, { watch: true });
    await waitFor('the first server', () => serving(port), [first]);
    const failureFile = join(dir, 'failure.txt');
    const second = startDev(dir, { port }, { watch: true, env: { BLOCKS_DEV_FAILURE_FILE: failureFile } });
    // Its `tsx watch` exits too: nothing is left waiting for a file change.
    await waitFor('the second blocks dev to exit', () => second.child.exitCode !== null || second.child.signalCode !== null, [first, second]);
    assert.match(second.out.stderr, new RegExp(`already running on :${port}`));
    assert.match(second.out.stderr, new RegExp(`blocks dev stop --port ${port}`));
    assert.doesNotMatch(second.out.stderr, /npm run dev/);
    assert.match(readFileSync(failureFile, 'utf-8'), new RegExp(`already running on :${port} \\(pid \\d+\\)`));
    assert.ok(await serving(port), 'the first server still serves');
    assert.strictEqual(first.child.exitCode, null);
  });

  it('starts exactly one of two dev servers started at the same moment', async () => {
    const dir = makeApp();
    const port = await freePort();
    const runs = [startDev(dir, { port }, { watch: true }), startDev(dir, { port }, { watch: true })];
    const loser = await Promise.race(runs.map((run) => run.exited.then(() => run)));
    const winner = runs.find((run) => run !== loser);
    assert.ok(winner);
    assert.match(loser.out.stderr, /already running/);
    await waitFor('the winner to serve', () => serving(port), runs);
    assert.strictEqual(winner.child.exitCode, null, 'the winner was not stopped by the loser');
    assert.doesNotMatch(winner.out.stdout + winner.out.stderr, /Reclaimed|Shutting down/);
  });

  it('exits non-zero when it cannot bind the port, instead of waiting under tsx watch', { skip: process.getuid?.() === 0 && 'root can bind port 1' }, async () => {
    const dir = makeApp();
    const failureFile = join(dir, 'failure.txt');
    const run = startDev(dir, { port: 1 }, { watch: true, env: { BLOCKS_DEV_FAILURE_FILE: failureFile } });
    await waitFor('blocks dev to exit', () => run.child.exitCode !== null || run.child.signalCode !== null, [run]);
    assert.match(run.out.stderr, /could not listen on 127\.0\.0\.1:1: .*EACCES/);
    assert.match(readFileSync(failureFile, 'utf-8'), /EACCES/);
    assert.ok(!existsSync(join(dir, '.blocks-sandbox', 'dev-server.1.pid')), 'the failed start leaves no pidfile');
  });

  it('keeps its pidfile through a reload, so a dev stop right after an edit stops it', async () => {
    const dir = makeApp();
    const port = await freePort();
    const dev = startDev(dir, { port }, { watch: true });
    await waitFor('the server', () => serving(port), [dev]);
    const pidfile = join(dir, devPidfilePath(port));
    writeFileSync(join(dir, 'backend.ts'), "export const testApi = { ping: async () => 'pong' }; // edited\n");
    // Watch the pidfile across the whole reload: until the new child serves, it must never be missing.
    let missing = 0;
    await waitFor('the reloaded server', async () => {
      if (!existsSync(pidfile)) missing++;
      return dev.out.stdout.split('local server running').length > 2 && (await serving(port));
    }, [dev]);
    assert.strictEqual(missing, 0, 'the pidfile was missing during the reload');

    // And `dev stop` straight after another edit stops the whole session.
    writeFileSync(join(dir, 'backend.ts'), "export const testApi = { ping: async () => 'pong' }; // edited again\n");
    await waitFor('the reload to start', () => dev.out.stdout.split('Shutting down').length > 2, [dev]);
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const result = await stopDevServer(port);
      assert.strictEqual(result.stopped, true, JSON.stringify(result));
    } finally {
      process.chdir(cwd);
    }
    await waitFor('blocks dev to exit', () => dev.child.exitCode !== null || dev.child.signalCode !== null, [dev]);
    assert.strictEqual(await serving(port), false);
  });

  it('refuses to start when an unrelated process holds its port, and leaves that process alone', async () => {
    const dir = makeApp();
    const port = await freePort();
    const foreign = await foreignServer(dir, port);
    const dev = startDev(dir, { port }, { watch: true });
    const code = await dev.exited;
    assert.strictEqual(code, 1, dev.out.stderr);
    assert.match(dev.out.stderr, new RegExp(`port ${port} is in use by pid ${foreign.pid} \\(.*server\\.mjs ${port} foreign\\)`));
    assert.match(dev.out.stderr, /choose another port with --port/);
    assert.strictEqual(await fetchText(port), 'foreign', 'the unrelated server still answers');
    assert.ok(!existsSync(join(dir, devPidfilePath(port))), 'the failed start leaves no pidfile');
  });

  it("never stops another app's frontend on a shared frontend port", async () => {
    const [portA, portB, frontendPort] = await Promise.all([freePort(), freePort(), freePort()]);
    const appA = makeApp();
    const a = startDev(appA, { port: portA, frontendPort, frontendCommand: frontendCommand(appA, frontendPort, 'frontend-A') });
    await waitFor("app A's frontend", async () => (await fetchText(portA)) === 'frontend-A', [a]);
    const appB = makeApp();
    const b = startDev(appB, { port: portB, frontendPort, frontendCommand: frontendCommand(appB, frontendPort, 'frontend-B') });
    assert.strictEqual(await b.exited, 1, b.out.stderr);
    assert.match(b.out.stderr, new RegExp(`port ${frontendPort} is in use by pid \\d+ .*frontend-A.*--frontend-port`, 's'));
    assert.strictEqual(await fetchText(portA), 'frontend-A', "app A's front door still serves its own frontend");
    assert.doesNotMatch(a.out.stderr, /Frontend dev server exited/);
  });

  it("reclaims the frontend port from its own crashed predecessor's frontend", async () => {
    const dir = makeApp();
    const [port, frontendPort] = await Promise.all([freePort(), freePort()]);
    const command = frontendCommand(dir, frontendPort, 'frontend');
    const crashed = startDev(dir, { port, frontendPort, frontendCommand: command });
    await waitFor('the frontend', async () => (await fetchText(port)) === 'frontend', [crashed]);
    // SIGKILL the dev server's own group: no cleanup runs, and the detached frontend (its own group) is orphaned.
    killGroup(crashed.child);
    await crashed.exited;
    await waitFor('the front door to close', async () => !(await serving(port)));
    assert.strictEqual(await fetchText(frontendPort), 'frontend', 'the orphaned frontend still holds its port');

    const next = startDev(dir, { port, frontendPort, frontendCommand: command });
    await waitFor('the new dev server', async () => (await fetchText(port)) === 'frontend' && (await serving(port)), [next]);
    assert.match(next.out.stdout, new RegExp(`Reclaimed port ${frontendPort} from this app's previous dev server`));
  });
});
