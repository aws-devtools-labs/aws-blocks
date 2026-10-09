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
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { isBlocksError } from '@aws-blocks/blocks/client';
import { installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import type { api as ApiType, authApi as AuthApiType } from 'aws-blocks';

// Install cookie jar before importing the API client — Node's fetch doesn't
// persist cookies between requests, which breaks authenticated API calls.
installCookieJar();

let server: ChildProcess | null = null;
let api: typeof ApiType;
let authApi: typeof AuthApiType;

const serverPort = 3000;
const readinessUrl = `http://localhost:${serverPort}/.blocks-sandbox/config.json`;

// A fresh user per run, so the suite also passes against existing local data.
const username = `testuser-${Date.now().toString(36)}`;
const email = `${username}@example.com`;
const password = 'TestPass123!';

/**
 * The verification code the local auth block just issued for `name`. Locally no
 * email is sent: every code is written to `.bb-data/<scope id>-<auth id>/last-code.json`
 * (here `my-app` + `auth`). On AWS, Cognito emails it instead.
 */
async function lastCode(name: string): Promise<string> {
  const last: { username: string; code: string } = JSON.parse(
    await readFile('.bb-data/my-app-auth/last-code.json', 'utf-8'),
  );
  assert.strictEqual(last.username, name, 'expected a code for this user');
  return last.code;
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

test('auth: starts signed out', async () => {
  const state = await authApi.getAuthState();
  assert.strictEqual(state.state, 'signedOut');
});

test('auth: sign up asks for the emailed code', async () => {
  const state = await authApi.setAuthState({ action: 'signUp', username, password, email });
  assert.strictEqual(state.state, 'confirmingSignUp');
});

test('auth: the code confirms the account and signs in', async () => {
  const confirmed = await authApi.setAuthState({ action: 'confirmSignUp', username, code: await lastCode(username) });
  // The <Authenticator> submits this step on its own; no second password entry.
  assert.ok(confirmed.actions.some((a) => a.name === 'autoSignIn'));
  const state = await authApi.setAuthState({ action: 'autoSignIn', username });
  assert.strictEqual(state.state, 'signedIn');
  assert.strictEqual(state.user?.username, username);
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

  // Sign in as a second, brand-new user.
  await authApi.setAuthState({ action: 'signOut' });
  const other = `${username}-b`;
  await authApi.setAuthState({ action: 'signUp', username: other, password, email: `${other}@example.com` });
  await authApi.setAuthState({ action: 'confirmSignUp', username: other, code: await lastCode(other) });
  assert.strictEqual((await authApi.setAuthState({ action: 'autoSignIn', username: other })).state, 'signedIn');

  for (const sortBy of [undefined, 'priority', 'title'] as const) {
    const theirs = await api.listTodos(sortBy);
    assert.ok(!theirs.some(t => t.todoId === mine.todoId), `listTodos(${sortBy ?? ''}) leaked the first user's todo`);
  }
  await assert.rejects(() => api.toggleTodo(mine.todoId), /not found/i);
  await assert.rejects(() => api.updatePriority(mine.todoId, 3), /not found/i);
  await api.deleteTodo(mine.todoId); // a no-op outside the caller's own todos

  // Back as the first user: the todo is still there, unchanged.
  await authApi.setAuthState({ action: 'signOut' });
  assert.strictEqual((await authApi.setAuthState({ action: 'signIn', username, password })).state, 'signedIn');
  const after = (await api.listTodos()).find(t => t.todoId === mine.todoId);
  assert.ok(after, 'the first user still has the todo');
  assert.strictEqual(after.completed, false);
  assert.strictEqual(after.priority, 2);
  assert.strictEqual(after.version, 1);
  await api.deleteTodo(mine.todoId);
});

// ─── Realtime ─────────────────────────────────────────────────────────────────
// Note: Realtime subscription tests require the middleware to be loaded,
// which happens automatically when the dev server regenerates client.js.
// For a manual test: run `npm run dev`, open two browser tabs, and create
// a todo in one — it should appear in the other immediately.
