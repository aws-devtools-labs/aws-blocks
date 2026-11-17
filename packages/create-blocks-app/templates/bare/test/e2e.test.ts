import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import type { api as apiType } from 'aws-blocks';

// npm is npm.cmd on Windows, which spawn won't resolve without a shell.
const isWin = process.platform === 'win32';

installCookieJar();

let server: ChildProcess | null = null;
let api: typeof apiType;
// The dev server's port: package.json "blocks.dev.port", which `npm run dev` also uses.
const serverPort: number = JSON.parse(readFileSync('package.json', 'utf-8')).blocks?.dev?.port ?? 3000;
// The app under test: the dev server on that port, or a deployed app when you set TEST_URL to the URL its
// API is under (TEST_URL=https://<id>.cloudfront.net, or the deployed API URL without /aws-blocks/api). The
// client resolves BLOCKS_API_URL first, so a deploy, which records its URL in config.<stage>.json, never redirects these tests.
const testUrl = process.env.TEST_URL?.replace(/\/$/, '') || undefined;
const readinessUrl = `http://localhost:${serverPort}/.blocks-sandbox/config.json`;

// Wait for the Blocks server to be ready without depending on the sample API.
async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(readinessUrl);
      if (response.ok) return;
    } catch {
      // The server is not listening yet.
    }
    await sleep(1000);
  }
  throw new Error(`Server not ready at ${readinessUrl}`);
}

test.before(async () => {
  if (!testUrl && !await isServerRunning(serverPort)) {
    server = spawn('npm', ['run', 'dev:server'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWin,
      shell: isWin,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    server.unref();
  }

  // A deployed app (TEST_URL) has no dev server to wait for.
  if (!testUrl) await waitForServer();

  // Pin the client to the app under test. Only now: a dev server started above must not inherit it.
  process.env.BLOCKS_API_URL = `${testUrl ?? `http://localhost:${serverPort}`}/aws-blocks/api`;

  // Import the client only once the server answers: the dev server regenerates
  // aws-blocks/client.js before it listens, so an earlier import could load a
  // stale client that lacks namespaces exported since the last generation.
  const mod = await import('aws-blocks');
  api = mod.api;
});

// Signal the dev server's process group; signal 0 only reports whether any of it is still alive.
function signalServer(pid: number, signal: NodeJS.Signals | 0) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function waitForServerExit(pid: number, ms: number) {
  for (const deadline = Date.now() + ms; signalServer(pid, 0); await sleep(100)) {
    if (Date.now() >= deadline) return false;
  }
  return true;
}

// The dev server shuts down gracefully, so wait for it to exit: it can still be
// writing to the app's directory when this file ends and the caller removes it.
test.after(async () => {
  if (!server?.pid) return;
  if (isWin) {
    spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  if (!signalServer(server.pid, 'SIGTERM') || await waitForServerExit(server.pid, 15_000)) return;
  signalServer(server.pid, 'SIGKILL');
  await waitForServerExit(server.pid, 2_000);
});

// App-level readiness — independent of the sample API, so it keeps passing
// after you replace `greet` with your own methods.
test('app: server serves its Blocks config', { skip: testUrl && 'TEST_URL targets a deployed app' }, async () => {
  const response = await fetch(readinessUrl);
  assert.ok(response.ok, `expected ${readinessUrl} to respond ok`);
});

// Runs against the sample `greet` API the template ships with, so a freshly
// scaffolded app is validated end to end. When you replace the sample API,
// update or delete this test to exercise your own methods instead.
test('greet returns message and timestamp', async () => {
  const result = await api.greet('World');
  assert.strictEqual(result.message, 'Hello, World!');
  assert.ok(typeof result.timestamp === 'number');
});
