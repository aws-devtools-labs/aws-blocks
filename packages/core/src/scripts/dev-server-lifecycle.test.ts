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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type DevServerOptions, devPidfilePath, readDevGenerateClient, type StopResult, stopDevServer } from './dev-server.js';

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

  it('refuses a second dev server of the same app on another port, naming the running port', async () => {
    // Both would open the app's .bb-data: the second PGlite removed the first one's live postmaster.pid (H1).
    const dir = makeApp();
    const [port, other] = [await freePort(), await freePort()];
    const first = startDev(dir, { port }, { watch: true });
    await waitFor('the first server', () => serving(port), [first]);
    const second = startDev(dir, { port: other }, { watch: true });
    await waitFor('the second blocks dev to exit', () => second.child.exitCode !== null || second.child.signalCode !== null, [first, second]);
    assert.strictEqual(second.child.exitCode, 1, second.out.stderr);
    assert.match(second.out.stderr, new RegExp(`a dev server of this app is already running on :${port} \\(pid \\d+\\)`));
    assert.match(second.out.stderr, new RegExp(`npx --no -- blocks dev stop --port ${port}\``));
    assert.ok(!existsSync(join(dir, devPidfilePath(other))), 'the refused start leaves no pidfile');
    assert.strictEqual(await fetchText(other), undefined, 'nothing listens on the second port');
    assert.ok(await serving(port), 'the first server still serves');
  });

  it("gives its frontend BLOCKS_API_URL = its own front door, whatever a deploy recorded", async () => {
    // A Next.js Server Component resolves the API from BLOCKS_API_URL before .blocks-sandbox/config.json,
    // which a deploy used to point at AWS while `npm run dev` ran.
    const dir = makeApp();
    const [port, frontendPort] = [await freePort(), await freePort()];
    const script = join(dir, 'frontend.mjs');
    writeFileSync(
      script,
      "import { createServer } from 'node:http';\n" +
        "createServer((_q, r) => r.end(String(process.env.BLOCKS_API_URL))).listen(Number(process.argv[2]), '127.0.0.1');\n",
    );
    mkdirSync(join(dir, '.blocks-sandbox'));
    writeFileSync(
      join(dir, '.blocks-sandbox', 'config.production.json'),
      JSON.stringify({ apiUrl: 'https://prod.example/aws-blocks/api', environment: 'production' }),
    );
    const frontend = `${quote(process.execPath)} ${quote(script)} ${frontendPort}`;
    // No BLOCKS_API_URL from the caller: with one, the dev server runs in sandbox mode.
    const dev = startDev(dir, { port, frontendPort, frontendCommand: frontend }, { env: { BLOCKS_API_URL: '' } });
    const seen = await waitFor('the frontend', () => fetchText(port).then((t) => t?.startsWith('http') && t), [dev]);
    assert.strictEqual(seen, `http://localhost:${port}/aws-blocks/api`);
    assert.deepStrictEqual(JSON.parse(readFileSync(join(dir, '.blocks-sandbox', 'config.json'), 'utf-8')), {
      apiUrl: `http://localhost:${port}/aws-blocks/api`,
      environment: 'local',
    });
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

  /** Whether `pid` is still running. */
  function running(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it('dev stop ends the tsx watch of a runner that a signal killed, before it reports the stop (H4)', async () => {
    const dir = makeApp();
    const port = await freePort();
    const dev = startDev(dir, { port }, { watch: true });
    await waitFor('the server', () => serving(port), [dev]);
    const runner = JSON.parse(readFileSync(join(dir, devPidfilePath(port)), 'utf-8')).pid as number;
    process.kill(runner, 'SIGKILL'); // the OOM killer
    await waitFor('the runner to die', () => !running(runner), [dev]);
    const cwd = process.cwd();
    process.chdir(dir);
    let result: StopResult;
    try {
      result = await stopDevServer(port);
    } finally {
      process.chdir(cwd);
    }
    assert.strictEqual(result.stopped, true, JSON.stringify(result));
    assert.strictEqual(result.portFree, true, JSON.stringify(result));
    // Reported only once the session is over: its tsx watch is gone too, not still waiting for the dead runner.
    assert.ok(dev.child.pid && !running(dev.child.pid), `tsx watch outlived dev stop: ${JSON.stringify(result)}`);
    assert.ok(!existsSync(join(dir, devPidfilePath(port))));
  });

  it("records the blocks sandbox session that started it, and keeps it from its frontend's environment (U2)", async () => {
    const dir = makeApp();
    const [port, frontendPort] = await Promise.all([freePort(), freePort()]);
    const script = join(dir, 'frontend.mjs');
    writeFileSync(
      script,
      "import { createServer } from 'node:http';\n" +
        "createServer((_q, r) => r.end('session=' + (process.env.BLOCKS_SANDBOX_SESSION ?? 'none'))).listen(Number(process.argv[2]), '127.0.0.1');\n",
    );
    const dev = startDev(
      dir,
      { port, frontendPort, frontendCommand: `${quote(process.execPath)} ${quote(script)} ${frontendPort}` },
      { env: { BLOCKS_SANDBOX_SESSION: String(process.pid), BLOCKS_API_URL: '' } },
    );
    assert.strictEqual(await waitFor('the frontend', () => fetchText(port).then((t) => t?.startsWith('session=') && t), [dev]), 'session=none');
    const record = JSON.parse(readFileSync(join(dir, devPidfilePath(port)), 'utf-8'));
    assert.deepStrictEqual(record.sandbox, { pid: process.pid });
  });

  it('leaves no pidfile after the blocks CLI stop: SIGTERM to the dev server, then to its tsx watch', async () => {
    const dir = makeApp();
    const port = await freePort();
    const dev = startDev(dir, { port }, { watch: true });
    await waitFor('the server', () => serving(port), [dev]);
    const pidfile = join(dir, devPidfilePath(port));
    const runner = JSON.parse(readFileSync(pidfile, 'utf-8')).pid as number;
    assert.notStrictEqual(runner, dev.child.pid, 'the pidfile names the dev server under tsx watch');
    // The CLI's stop: SIGTERM the runner (the same signal tsx restarts it with), wait for it, then stop tsx watch.
    process.kill(runner, 'SIGTERM');
    await waitFor('the dev server to exit', () => !running(runner), [dev]);
    dev.child.kill('SIGTERM');
    await waitFor('tsx watch to exit', () => dev.child.exitCode !== null || dev.child.signalCode !== null, [dev]);
    await waitFor('the pidfile to be removed', () => !existsSync(pidfile), [dev]);
  });

  it('leaves no pidfile after a SIGTERM to its tsx watch, which relays it', async () => {
    const dir = makeApp();
    const port = await freePort();
    const dev = startDev(dir, { port }, { watch: true });
    await waitFor('the server', () => serving(port), [dev]);
    const pidfile = join(dir, devPidfilePath(port));
    dev.child.kill('SIGTERM');
    await waitFor('tsx watch to exit', () => dev.child.exitCode !== null || dev.child.signalCode !== null, [dev]);
    await waitFor('the pidfile to be removed', () => !existsSync(pidfile), [dev]);
  });

  it('leaves no pidfile after a group SIGTERM while its backend is still loading (JA-6)', async () => {
    // The pidfile is claimed before the backend loads; the cleanup was installed only once the server
    // listened, so a stop in between ended the dev server by the default disposition, record and all.
    const dir = makeApp();
    writeFileSync(
      join(dir, 'backend.ts'),
      "import { writeFileSync } from 'node:fs';\n" +
        "writeFileSync('loading', 'yes');\n" +
        // A real wait: the window between the claim and the cleanup is the backend's load.
        'await new Promise((r) => setTimeout(r, 10_000));\n' +
        "export const testApi = { ping: async () => 'pong' };\n",
    );
    const port = await freePort();
    const dev = startDev(dir, { port }, { watch: true });
    const pidfile = join(dir, devPidfilePath(port));
    await waitFor('the backend to start loading', () => existsSync(join(dir, 'loading')) && existsSync(pidfile), [dev]);
    killGroup(dev.child, 'SIGTERM');
    await waitFor('tsx watch to exit', () => dev.child.exitCode !== null || dev.child.signalCode !== null, [dev]);
    await waitFor('the pidfile to be removed', () => !existsSync(pidfile), [dev]);
  });

  it("closes the app's local data engines before it exits on a stop", async () => {
    // process.exit() skips the beforeExit hook that closes PGlite, which then left postmaster.pid on every
    // stop, so a leftover one could not mean a crash. A stand-in engine registers its closer as bb-data does;
    // its close takes a real 200 ms, as PGlite's shutdown does, so the test shows the dev server waits for it.
    const dir = makeApp();
    writeFileSync(
      join(dir, 'backend.ts'),
      "import { writeFileSync } from 'node:fs';\n" +
        "const key = Symbol.for('aws-blocks.local-engine-closers');\n" +
        '(globalThis[key] ??= new Set()).add(async () => {\n' +
        '  await new Promise((r) => setTimeout(r, 200));\n' +
        "  writeFileSync('engine-closed', 'yes');\n" +
        '});\n' +
        "export const testApi = { ping: async () => 'pong' };\n",
    );
    const port = await freePort();
    const dev = startDev(dir, { port }, { watch: true });
    await waitFor('the server', () => serving(port), [dev]);
    dev.child.kill('SIGTERM');
    await waitFor('tsx watch to exit', () => dev.child.exitCode !== null || dev.child.signalCode !== null, [dev]);
    assert.strictEqual(readFileSync(join(dir, 'engine-closed'), 'utf-8'), 'yes');
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

  it("dev stop after a SIGKILLed dev server stops the frontend it left, so the next start runs", async () => {
    // Stop first, then start: the natural recovery, which used to wedge on the orphaned frontend (JA-3).
    const dir = makeApp();
    const [port, frontendPort] = await Promise.all([freePort(), freePort()]);
    const command = frontendCommand(dir, frontendPort, 'frontend');
    const crashed = startDev(dir, { port, frontendPort, frontendCommand: command }, { watch: true });
    await waitFor('the frontend', async () => (await fetchText(port)) === 'frontend', [crashed]);
    killGroup(crashed.child);
    await crashed.exited;
    await waitFor('the front door to close', async () => !(await serving(port)));
    assert.strictEqual(await fetchText(frontendPort), 'frontend', 'the orphaned frontend still holds its port');

    const cwd = process.cwd();
    process.chdir(dir);
    let result: StopResult;
    try {
      result = await stopDevServer(port);
    } finally {
      process.chdir(cwd);
    }
    assert.strictEqual(result.via, 'frontend', JSON.stringify(result));
    assert.strictEqual(result.portFree, true);
    assert.strictEqual(await fetchText(frontendPort), undefined, 'the frontend is stopped');
    assert.ok(!existsSync(join(dir, devPidfilePath(port))), 'the record is cleared');

    const next = startDev(dir, { port, frontendPort, frontendCommand: command });
    await waitFor('the new dev server', async () => (await fetchText(port)) === 'frontend' && (await serving(port)), [next]);
  });

  const lanAddress = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

  it('uses the bound host, not localhost, in its banner, config.json and CORS', { skip: !lanAddress && 'no non-loopback IPv4 address' }, async () => {
    const host = lanAddress ?? '';
    const port = await freePort();
    const dev = startDev(makeApp(), { port, host });
    await waitFor('the server', () => dev.out.stdout.includes('local server running'), [dev]);
    assert.ok(dev.out.stdout.includes(`running on http://${host}:${port}`), dev.out.stdout);
    const config = await fetch(`http://${host}:${port}/.blocks-sandbox/config.json`).then((r) => r.json());
    assert.deepStrictEqual(config, { apiUrl: `http://${host}:${port}/aws-blocks/api`, environment: 'local' });
    const page = `http://${host}:5173`;
    const response = await fetch(`http://${host}:${port}/aws-blocks/api`, { method: 'OPTIONS', headers: { Origin: page } });
    assert.strictEqual(response.headers.get('access-control-allow-origin'), page);
    const foreign = await fetch(`http://${host}:${port}/aws-blocks/api`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(foreign.headers.get('access-control-allow-origin'), `http://${host}:${port}`);
  });

  it('serves a same-origin apiUrl and reflects a same-origin Origin when it binds all interfaces', { skip: !lanAddress && 'no non-loopback IPv4 address' }, async () => {
    const lan = lanAddress ?? '';
    const port = await freePort();
    const dir = makeApp();
    const dev = startDev(dir, { port, host: '0.0.0.0' });
    await waitFor('the server', () => dev.out.stdout.includes('local server running'), [dev]);
    // A page opened at the machine address calls the API at that address, not at localhost.
    const config = await fetch(`http://${lan}:${port}/.blocks-sandbox/config.json`).then((r) => r.json());
    assert.deepStrictEqual(config, { apiUrl: '/aws-blocks/api', environment: 'local' });
    // Node.js readers of the file need an origin, so the file keeps the absolute URL.
    assert.deepStrictEqual(JSON.parse(readFileSync(join(dir, '.blocks-sandbox', 'config.json'), 'utf-8')), {
      apiUrl: `http://localhost:${port}/aws-blocks/api`,
      environment: 'local',
    });
    const page = `http://${lan}:${port}`;
    const response = await fetch(`${page}/aws-blocks/api`, {
      method: 'POST',
      headers: { Origin: page, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'testApi.ping', params: [], id: 1 }),
    });
    assert.strictEqual(response.headers.get('access-control-allow-origin'), page);
    const body: unknown = await response.json();
    assert.ok(body && typeof body === 'object' && 'result' in body && body.result === 'pong', JSON.stringify(body));
    for (const origin of ['https://evil.example', `http://${lan}:5173`]) {
      const foreign = await fetch(`${page}/aws-blocks/api`, { method: 'OPTIONS', headers: { Origin: origin } });
      assert.strictEqual(foreign.headers.get('access-control-allow-origin'), `http://localhost:${port}`, origin);
    }
  });

  it('keeps a hand-written client.js when package.json sets blocks.dev.generateClient to false', async () => {
    const handWritten = '// Amplify overlay client: reads amplify_outputs.json\nexport const api = {};\n';
    const run = async (blocksDev: Record<string, unknown> | undefined): Promise<string> => {
      const dir = makeApp();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', private: true, type: 'module', blocks: blocksDev && { dev: blocksDev } }));
      writeFileSync(join(dir, 'client.js'), handWritten);
      const port = await freePort();
      const dev = startDev(dir, { port });
      await waitFor('the server', () => serving(port), [dev]);
      killGroup(dev.child, 'SIGTERM');
      await dev.exited;
      return readFileSync(join(dir, 'client.js'), 'utf-8');
    };
    assert.strictEqual(await run({ generateClient: false }), handWritten);
    assert.notStrictEqual(await run(undefined), handWritten, 'by default the dev server regenerates it');
  });
});

describe('readDevGenerateClient', () => {
  const withPackage = (body: string): boolean | undefined => {
    const dir = makeApp();
    writeFileSync(join(dir, 'package.json'), body);
    return readDevGenerateClient(dir);
  };

  it('reads a boolean, and treats anything else as unset', () => {
    assert.strictEqual(withPackage(JSON.stringify({ blocks: { dev: { generateClient: false } } })), false);
    assert.strictEqual(withPackage('\uFEFF' + JSON.stringify({ blocks: { dev: { generateClient: true } } })), true);
    assert.strictEqual(withPackage(JSON.stringify({ blocks: { dev: { port: 3001 } } })), undefined);
    assert.strictEqual(withPackage(JSON.stringify({ blocks: { dev: { generateClient: 'no' } } })), undefined);
    assert.strictEqual(withPackage('not json'), undefined);
    assert.strictEqual(readDevGenerateClient(join(tmpdir(), 'no-such-app-dir')), undefined);
  });
});
