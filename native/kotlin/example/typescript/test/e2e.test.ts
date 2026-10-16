import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import type { api as apiType, hello as helloType } from 'aws-blocks';

let server: ChildProcess | null = null;
let api: typeof apiType;
let hello: typeof helloType;

test.before(async () => {

  // Start dev server
  console.log('🚀 Starting dev server...');
  server = spawn('npm', ['run', 'dev:server'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
    env: { ...process.env, NODE_OPTIONS: '' }
  });
  server.unref();

  // Wait for the server to answer. It also writes `aws-blocks/client.js`, the
  // generated client the import below resolves to, so import only after this.
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await setTimeout(1000);
    try {
      const res = await fetch('http://localhost:3001/aws-blocks/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello.greet', params: ['ping'] }),
      });
      ready = res.ok;
    } catch (e) {
      if (i % 10 === 9) console.log(`  Still waiting... (${i+1}s) ${(e as Error).message}`);
    }
  }
  if (!ready) throw new Error('Server not ready');

  // Import API via browser conditional export (client proxy)
  const mod = await import('aws-blocks');
  api = mod.api;
  hello = mod.hello;
});

test.after(() => {
  if (server?.pid) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  }
});

test('greet returns message and timestamp', async () => {
  const result = await hello.greet('World');
  assert.strictEqual(result.message, 'Hello, World!');
  assert.ok(typeof result.timestamp === 'number');
});

test('KV Store - set and get', async () => {
  const setResult = await api.setValue('test-key', 'test-value');
  assert.strictEqual(setResult.success, true);

  const value = await api.getValue('test-key');
  assert.strictEqual(value, 'test-value');
});

// Per-user isolation itself (one user can't see or change another's todos) is
// exercised in ../../../swift/Demo/typescript-demo/test/e2e.test.ts, whose
// backend has the same todo methods: signing two users in here would need real
// Google accounts. This checks the gate every todo method starts with.
test('todo methods refuse a signed-out caller', async () => {
  for (const [method, params] of [
    ['api.listTodos', []],
    ['api.createTodo', ['x', 1]],
    ['api.updateTodo', ['some-id', { title: 'x' }]],
    ['api.deleteTodo', ['some-id']],
  ] as const) {
    const res = await fetch('http://localhost:3001/aws-blocks/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = (await res.json()) as { error?: { data?: { name?: string } } };
    assert.strictEqual(body.error?.data?.name, 'NotAuthenticatedException', `${method} without a session`);
  }
});
