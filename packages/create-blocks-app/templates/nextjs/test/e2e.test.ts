import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { ApiNamespaceClient } from '@aws-blocks/blocks/client';
import type { api as apiType } from '../aws-blocks/index.js';

// Basic e2e test for the Next.js template
// Run with: npm run test:e2e

const baseUrl = process.env.TEST_URL || 'http://localhost:3000';
let server: ChildProcess | null = null;

async function isServerReady() {
  try {
    const res = await fetch(baseUrl);
    return res.status === 200;
  } catch {
    return false;
  }
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    if (await isServerReady()) return;
    await setTimeout(1000);
  }
  throw new Error(`Next.js dev server did not become ready at ${baseUrl}`);
}

test.before(async () => {
  console.log(`Testing ${baseUrl}...`);

  if (!process.env.TEST_URL && !await isServerReady()) {
    server = spawn('npm', ['run', 'dev:server'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    server.unref();
  }

  await waitForServer();
});

test.after(() => {
  if (server?.pid) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  }
});

test('home page loads', async () => {
  const res = await fetch(baseUrl);
  assert.strictEqual(res.status, 200, 'Home page should return 200');
});

test('app: server serves its Blocks config', async () => {
  const configUrl = `${baseUrl.replace(/\/$/, '')}/.blocks-sandbox/config.json`;
  const response = await fetch(configUrl);
  assert.ok(response.ok, `expected ${configUrl} to respond ok`);
});

// Validate the sample API in a freshly scaffolded app. When you replace it,
// update or delete this test to exercise your own methods instead.
test('greet returns message and timestamp', async () => {
  const configUrl = `${baseUrl.replace(/\/$/, '')}/.blocks-sandbox/config.json`;
  const response = await fetch(configUrl);
  assert.ok(response.ok, `expected ${configUrl} to respond ok`);
  const config = await response.json();
  assert.strictEqual(typeof config.apiUrl, 'string', 'Blocks config should contain an API URL');
  const api = ApiNamespaceClient<typeof apiType>('api', { url: new URL(config.apiUrl, baseUrl).href });
  const result = await api.greet('World');
  assert.strictEqual(result.message, 'Hello, World!');
  assert.strictEqual(typeof result.timestamp, 'number');
});
