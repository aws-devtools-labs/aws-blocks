import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import type { api as apiType, hello as helloType } from 'aws-blocks';

installCookieJar();

let server: ChildProcess | null = null;
let api: typeof apiType;
let hello: typeof helloType;
const serverPort = 3000;
const readinessUrl = `http://localhost:${serverPort}/.blocks-sandbox/config.json`;

test.before(async () => {
  if (!await isServerRunning(serverPort)) {
    server = spawn('npm', ['run', 'dev:server'], {
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
  hello = mod.hello;

  // Wait for the Blocks server to be ready without depending on the sample API.
  for (let i = 0; i < 60; i++) {
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
// after you replace `greet`/`setValue`/`getValue` with your own methods.
test('app: server serves its Blocks config', async () => {
  const response = await fetch(readinessUrl);
  assert.ok(response.ok, `expected ${readinessUrl} to respond ok`);
});

// Run against the sample API so a scaffolded app is validated end to end.
// Each self-skips once you remove the method it exercises; copy a block for your own.
test('greet returns message and timestamp', {
  skip: 'greet' in hello ? false : 'sample greet API removed — replace with your own',
}, async () => {
  const result = await hello.greet('World');
  assert.strictEqual(result.message, 'Hello, World!');
  assert.ok(typeof result.timestamp === 'number');
});

test('KV Store - set and get', {
  skip: 'setValue' in api ? false : 'sample KV API removed — replace with your own',
}, async () => {
  const setResult = await api.setValue('test-key', 'test-value');
  assert.strictEqual(setResult.success, true);

  const value = await api.getValue('test-key');
  assert.strictEqual(value, 'test-value');
});
