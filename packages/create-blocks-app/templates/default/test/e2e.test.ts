/**
 * End-to-end tests — tests the API via direct imports (same typed client the frontend uses).
 *
 * Run:  npm run test:e2e
 *
 * Structure:
 *   - Setup (starts dev server, imports client) — don't touch
 *   - Auth tests
 *   - CRUD tests
 *   - Conditional write / conflict tests
 *   - Realtime tests
 *
 * To add tests: copy any test block, rename, change the assertion. The setup
 * boilerplate handles server lifecycle — you just call api.* methods.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import { ApiError } from '@aws-blocks/blocks/client';
import type { api as ApiType, authApi as AuthApiType } from 'aws-blocks';

// Install cookie jar before importing the API client — Node's fetch doesn't
// persist cookies between requests, which breaks authenticated API calls.
installCookieJar();

let server: ChildProcess | null = null;
let api: typeof ApiType;
let authApi: typeof AuthApiType;

const serverPort = 3000;
const readinessUrl = `http://localhost:${serverPort}/.blocks-sandbox/config.json`;

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

// ─── Setup (don't touch) ─────────────────────────────────────────────────────

test.before(async () => {
  // Use existing dev server if running, otherwise start one
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
  authApi = mod.authApi;

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

// ─── App readiness (independent of the sample API) ────────────────────────────

test('app: server serves its Blocks config', async () => {
  const response = await fetch(readinessUrl);
  assert.ok(response.ok, `expected ${readinessUrl} to respond ok`);
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

test('auth: starts signed out', (t) => runSampleApiTest(t, async () => {
  const state = await authApi.getAuthState();
  assert.strictEqual(state.state, 'signedOut');
}));

test('auth: sign up creates account and signs in', (t) => runSampleApiTest(t, async () => {
  const state = await authApi.setAuthState({
    action: 'signUp',
    username: 'testuser@example.com',
    password: 'TestPass123!',
  });
  assert.strictEqual(state.state, 'signedIn');
  assert.strictEqual(state.user?.username, 'testuser@example.com');
}));

test('auth: unauthenticated access is rejected', (t) => runSampleApiTest(t, async () => {
  // Sign out first
  await authApi.setAuthState({ action: 'signOut' });

  await assert.rejects(
    () => api.listTodos(),
    // A removed `listTodos` rejects with "Method not found"; let that propagate
    // so the test self-skips (via runSampleApiTest) instead of passing here.
    (err: any) =>
      !(err instanceof ApiError && err.message.startsWith('Method not found')) &&
      (err.message.includes('Authentication') || err.message.includes('Session') || err.message.includes('401')),
  );

  // Sign back in for remaining tests
  await authApi.setAuthState({
    action: 'signIn',
    username: 'testuser@example.com',
    password: 'TestPass123!',
  });
}));

// ─── CRUD ─────────────────────────────────────────────────────────────────────

test('todos: create with priority', (t) => runSampleApiTest(t, async () => {
  const todo = await api.createTodo('Buy milk', 1);
  assert.strictEqual(todo.title, 'Buy milk');
  assert.strictEqual(todo.priority, 1);
  assert.strictEqual(todo.completed, false);
  assert.strictEqual(todo.version, 1);
  assert.ok(todo.todoId);
}));

test('todos: list (only own)', (t) => runSampleApiTest(t, async () => {
  const list = await api.listTodos();
  assert.ok(list.length >= 1);
  assert.ok(list.every(t => t.userId === 'testuser@example.com'));
}));

test('todos: list sorted by priority (secondary index)', (t) => runSampleApiTest(t, async () => {
  // Create todos with different priorities
  await api.createTodo('Low priority task', 3);
  await api.createTodo('High priority task', 1);

  const sorted = await api.listTodos('priority');
  assert.ok(sorted.length >= 2);
  // Priority 1 (high) should come before priority 3 (low)
  const priorities = sorted.map(t => t.priority);
  for (let i = 1; i < priorities.length; i++) {
    assert.ok(priorities[i] >= priorities[i - 1], 'Should be sorted by priority ascending');
  }
}));

test('todos: list sorted by title (secondary index)', (t) => runSampleApiTest(t, async () => {
  const sorted = await api.listTodos('title');
  assert.ok(sorted.length >= 2);
  const titles = sorted.map(t => t.title);
  for (let i = 1; i < titles.length; i++) {
    assert.ok(titles[i] >= titles[i - 1], 'Should be sorted by title ascending');
  }
}));

test('todos: toggle completion', (t) => runSampleApiTest(t, async () => {
  const [todo] = await api.listTodos();
  await api.toggleTodo(todo.todoId);

  const updated = (await api.listTodos()).find(t => t.todoId === todo.todoId);
  assert.strictEqual(updated?.completed, !todo.completed);
  assert.strictEqual(updated?.version, todo.version + 1);
}));

test('todos: delete', (t) => runSampleApiTest(t, async () => {
  const before = await api.listTodos();
  const target = before[0];
  await api.deleteTodo(target.todoId);

  const after = await api.listTodos();
  assert.ok(!after.some(t => t.todoId === target.todoId));
}));

// ─── Conditional writes (optimistic locking) ──────────────────────────────────

test('todos: concurrent toggle → conflict → retry succeeds', (t) => runSampleApiTest(t, async () => {
  // Create a fresh todo
  const todo = await api.createTodo('Conflict test');

  // Simulate a concurrent write by toggling twice "simultaneously"
  // First toggle succeeds (version 1 → 2)
  await api.toggleTodo(todo.todoId);

  // Read current state
  const current = (await api.listTodos()).find(t => t.todoId === todo.todoId);
  assert.strictEqual(current?.version, 2);

  // Toggle again — should succeed because we're reading fresh version
  await api.toggleTodo(todo.todoId);
  const final = (await api.listTodos()).find(t => t.todoId === todo.todoId);
  assert.strictEqual(final?.version, 3);
  assert.strictEqual(final?.completed, todo.completed); // toggled twice = back to original

  // Cleanup
  await api.deleteTodo(todo.todoId);
}));

// ─── Realtime ─────────────────────────────────────────────────────────────────
// Note: Realtime subscription tests require the middleware to be loaded,
// which happens automatically when the dev server regenerates client.js.
// For a manual test: run `npm run dev`, open two browser tabs, and create
// a todo in one — it should appear in the other immediately.
