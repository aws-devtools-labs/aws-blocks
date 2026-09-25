import { test, type TestContext } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import { ApiError } from '@aws-blocks/blocks/client';
import type { api as apiType } from 'aws-blocks';

installCookieJar();

let server: ChildProcess | null = null;
let api: typeof apiType;
const serverPort = 3001;
const readinessUrl = `http://localhost:${serverPort}/.blocks-sandbox/config.json`;

test.before(async () => {
  if (!await isServerRunning(serverPort)) {
    server = spawn('npm', ['run', 'dev'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    server.unref();
    await setTimeout(2000);
  }

  const mod = await import('aws-blocks');
  api = mod.api;

  // Wait for the Blocks server to be ready without depending on the sample API.
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(readinessUrl);
      if (response.ok) return;
    } catch {
      // The server is not listening yet.
    }
    await setTimeout(1000);
  }
  throw new Error(`Server not ready at ${readinessUrl}`);
});

test.after(() => {
  if (server?.pid) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  }
});

// App-level readiness — independent of the sample API, so it keeps passing
// after you replace `greet` with your own methods.
test('app: server serves its Blocks config', async () => {
  const response = await fetch(readinessUrl);
  assert.ok(response.ok, `expected ${readinessUrl} to respond ok`);
});

// Run a test against the sample API the template ships with, so a freshly
// scaffolded app is validated end to end. The generated client is a Proxy, so
// every method looks callable — a method you have removed only shows up at call
// time as a JSON-RPC "method not found" error. In that case the sample API was
// replaced, so skip; anything else is a real failure and is rethrown.
async function runSampleApiTest(t: TestContext, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (err) {
    if (err instanceof ApiError && err.message.startsWith('Method not found')) {
      t.skip('sample API removed — replace with tests for your own methods');
      return;
    }
    throw err;
  }
}

// Runs against the sample `greet` API so a scaffolded app is validated end to end.
// Self-skips once you remove or rename `greet`; copy this block for your own methods.
test('greet returns message and timestamp', (t) => runSampleApiTest(t, async () => {
  const result = await api.greet('World');
  assert.strictEqual(result.message, 'Hello, World!');
  assert.ok(typeof result.timestamp === 'number');
}));
