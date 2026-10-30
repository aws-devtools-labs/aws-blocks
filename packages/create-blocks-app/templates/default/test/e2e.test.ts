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
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { isBlocksError } from '@aws-blocks/blocks/client';
import { createTestClient, getLastAuthCode, installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import type { api as ApiType, authApi as AuthApiType } from 'aws-blocks';

// npm is npm.cmd on Windows, which spawn won't resolve without a shell.
const isWin = process.platform === 'win32';

// Install cookie jar before importing the API client — Node's fetch doesn't
// persist cookies between requests, which breaks authenticated API calls.
installCookieJar();

let server: ChildProcess | null = null;
let app: typeof import('aws-blocks');
let api: typeof ApiType;
let authApi: typeof AuthApiType;

const serverPort = 3000;
const readinessUrl = `http://localhost:${serverPort}/.blocks-sandbox/config.json`;

// A fresh user per run, so the suite also passes against existing local data.
const username = `testuser-${Date.now().toString(36)}@example.com`;
const password = 'TestPass123!';

// Locally no email is sent: `getLastAuthCode(name)` reads the verification code
// the local auth block just issued for `name` (it finds the block's .bb-data/
// files itself). On AWS, Cognito emails it instead.

// ─── Setup (don't touch) ─────────────────────────────────────────────────────

test.before(async () => {
  // Use existing dev server if running, otherwise start one
  if (!await isServerRunning(serverPort)) {
    server = spawn('npm', ['run', 'dev:server'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWin,
      shell: isWin,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    server.unref();
    await setTimeout(2000);
  }

  app = await import('aws-blocks');
  api = app.api;
  authApi = app.authApi;

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
    try {
      if (isWin) spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(-server.pid, 'SIGTERM');
    } catch {}
  }
});

// ─── App readiness (independent of the sample API) ────────────────────────────

test('app: server serves its Blocks config', async () => {
  const response = await fetch(readinessUrl);
  assert.ok(response.ok, `expected ${readinessUrl} to respond ok`);
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

test('auth: starts signed out', async () => {
  const state = await authApi.getAuthState();
  assert.strictEqual(state.state, 'signedOut');
});

test('auth: sign up asks for the emailed code', async () => {
  const state = await authApi.setAuthState({ action: 'signUp', username, password });
  assert.strictEqual(state.state, 'confirmingSignUp');
});

test('auth: the code confirms the account and signs in', async () => {
  const confirmed = await authApi.setAuthState({ action: 'confirmSignUp', username, code: await getLastAuthCode(username) });
  // The <Authenticator> submits this step on its own; no second password entry.
  assert.ok(confirmed.actions.some((a) => a.name === 'autoSignIn'));
  const state = await authApi.setAuthState({ action: 'autoSignIn', username });
  assert.strictEqual(state.state, 'signedIn');
  // The username is an id Cognito generates (`signInWith: ['email']`); the UI shows `displayName`.
  assert.strictEqual(state.user?.displayName, username);
});

test('auth: unauthenticated access is rejected', async () => {
  // Sign out first
  await authApi.setAuthState({ action: 'signOut' });

  await assert.rejects(
    () => api.listTodos(),
    (err: unknown) => isBlocksError(err, 'NotAuthenticatedException'),
  );

  // Sign back in for remaining tests
  const state = await authApi.setAuthState({ action: 'signIn', username, password });
  assert.strictEqual(state.state, 'signedIn');
});

// ─── CRUD ─────────────────────────────────────────────────────────────────────

test('todos: create with priority', async () => {
  const todo = await api.createTodo('Buy milk', 1);
  assert.strictEqual(todo.title, 'Buy milk');
  assert.strictEqual(todo.priority, 1);
  assert.strictEqual(todo.completed, false);
  assert.strictEqual(todo.version, 1);
  assert.ok(todo.todoId);
});

test('todos: list (only own)', async () => {
  const list = await api.listTodos();
  assert.ok(list.length >= 1);
  // Every todo is keyed on the owner's userSub, the same for all of them.
  const owner = list[0].userSub;
  assert.ok(owner);
  assert.ok(list.every(t => t.userSub === owner));
});

test('todos: list sorted by priority (client-side sort)', async () => {
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
});

test('todos: list sorted by title (client-side sort)', async () => {
  const sorted = await api.listTodos('title');
  assert.ok(sorted.length >= 2);
  const titles = sorted.map(t => t.title);
  for (let i = 1; i < titles.length; i++) {
    assert.ok(titles[i] >= titles[i - 1], 'Should be sorted by title ascending');
  }
});

test('todos: toggle completion', async () => {
  const [todo] = await api.listTodos();
  await api.toggleTodo(todo.todoId);

  const updated = (await api.listTodos()).find(t => t.todoId === todo.todoId);
  assert.strictEqual(updated?.completed, !todo.completed);
  assert.strictEqual(updated?.version, todo.version + 1);
});

test('todos: delete', async () => {
  const before = await api.listTodos();
  const target = before[0];
  await api.deleteTodo(target.todoId);

  const after = await api.listTodos();
  assert.ok(!after.some(t => t.todoId === target.todoId));
});

// ─── Conditional writes (optimistic locking) ──────────────────────────────────

test('todos: concurrent toggle → conflict → retry succeeds', async () => {
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
});

// ─── Per-user isolation ───────────────────────────────────────────────────────

test('todos: another user can neither see nor change them', async () => {
  const mine = await api.createTodo('Private to the first user', 2);

  // A second, brand-new user, signed in at the same time: `createTestClient`
  // gives them the app's clients with a cookie jar of their own.
  const other = createTestClient(app);
  const otherName = `b-${username}`;
  await other.authApi.setAuthState({ action: 'signUp', username: otherName, password });
  await other.authApi.setAuthState({ action: 'confirmSignUp', username: otherName, code: await getLastAuthCode(otherName) });
  assert.strictEqual((await other.authApi.setAuthState({ action: 'autoSignIn', username: otherName })).state, 'signedIn');

  for (const sortBy of [undefined, 'priority', 'title'] as const) {
    const theirs = await other.api.listTodos(sortBy);
    assert.ok(!theirs.some(t => t.todoId === mine.todoId), `listTodos(${sortBy ?? ''}) leaked the first user's todo`);
  }
  await assert.rejects(() => other.api.toggleTodo(mine.todoId), /not found/i);
  await assert.rejects(() => other.api.updatePriority(mine.todoId, 3), /not found/i);
  await other.api.deleteTodo(mine.todoId); // a no-op outside the caller's own todos

  // The first user, still signed in: the todo is still there, unchanged.
  const after = (await api.listTodos()).find(t => t.todoId === mine.todoId);
  assert.ok(after, 'the first user still has the todo');
  assert.strictEqual(after.completed, false);
  assert.strictEqual(after.priority, 2);
  assert.strictEqual(after.version, 1);
  await api.deleteTodo(mine.todoId);
});

// ─── Realtime ─────────────────────────────────────────────────────────────────
// `subscribeTodos()` returns a channel the client hydrates into a live
// WebSocket subscription (dev server runs a local WS server — no AWS). We
// subscribe, mutate over the API, and assert the broadcast arrives.

/**
 * Subscribe to `channel` and return a promise for the NEXT message, plus an
 * `established` promise that resolves once the server confirms the subscription.
 * Awaiting `established` before triggering a mutation closes the race where a
 * publish could fire before the subscribe is confirmed. Rejects after
 * `timeoutMs` so a dropped broadcast fails loudly instead of hanging.
 */
function nextMessage<T>(
  channel: {
    subscribe(handler: (message: T) => void): { unsubscribe(): void; established: Promise<void> };
  },
  timeoutMs = 5000,
): { received: Promise<T>; established: Promise<void>; unsubscribe(): void } {
  let unsubscribe = () => {};
  let established: Promise<void> = Promise.resolve();
  const received = new Promise<T>((resolve, reject) => {
    // Use globalThis to avoid the timers/promises setTimeout shadow (the
    // template imports { setTimeout } from 'node:timers/promises' at the top).
    const timer = globalThis.setTimeout(() => reject(new Error('timed out waiting for Realtime message')), timeoutMs);
    const sub = channel.subscribe((message: T) => {
      globalThis.clearTimeout(timer);
      resolve(message);
    });
    established = sub.established;
    unsubscribe = () => { globalThis.clearTimeout(timer); sub.unsubscribe(); };
  });
  return { received, established, unsubscribe };
}

test('realtime: a created todo broadcasts to a subscriber', async (t) => {
  const channel = await api.subscribeTodos();
  if (typeof channel.subscribe !== 'function') {
    t.skip('Realtime middleware not hydrated (no local WS server — expected on Windows)');
    return;
  }
  const { received, established, unsubscribe } = nextMessage<{ action: string; todoId: string }>(channel);
  try {
    await established;
    const todo = await api.createTodo('Realtime create');
    const message = await received;
    assert.strictEqual(message.action, 'created');
    assert.strictEqual(message.todoId, todo.todoId);
    await api.deleteTodo(todo.todoId);
  } finally {
    unsubscribe();
  }
});

test('realtime: an updated todo broadcasts an updated event', async (t) => {
  const todo = await api.createTodo('Realtime update');
  const channel = await api.subscribeTodos();
  if (typeof channel.subscribe !== 'function') {
    t.skip('Realtime middleware not hydrated (no local WS server — expected on Windows)');
    await api.deleteTodo(todo.todoId);
    return;
  }
  const { received, established, unsubscribe } = nextMessage<{ action: string; todoId: string }>(channel);
  try {
    await established;
    await api.toggleTodo(todo.todoId);
    const message = await received;
    assert.strictEqual(message.action, 'updated');
    assert.strictEqual(message.todoId, todo.todoId);
  } finally {
    unsubscribe();
    await api.deleteTodo(todo.todoId);
  }
});
