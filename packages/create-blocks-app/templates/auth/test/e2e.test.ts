import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { isBlocksError } from '@aws-blocks/blocks/client';
import { installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import type { api as apiType, authApi as authApiType, hello as helloType } from 'aws-blocks';

installCookieJar();

let server: ChildProcess | null = null;
let api: typeof apiType;
let hello: typeof helloType;
let authApi: typeof authApiType;
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
  authApi = mod.authApi;

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

// Run against the sample API the template ships with, so a freshly scaffolded
// app is validated end to end. When you replace the sample API, update or
// delete these tests to exercise your own methods instead.
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

// ─── Auth ─────────────────────────────────────────────────────────────────────
// The same steps the <Authenticator> drives in the browser. A fresh email per
// run, so the suite also passes against existing local data.
const email = `e2e-${Date.now().toString(36)}@example.com`;
const password = 'TestPass123!';

/** The last code `codeDelivery` received (local dev only — see `getLastCode`). */
async function lastCodeFor(name: string): Promise<string> {
  const last = await api.getLastCode();
  assert.ok(last, 'expected a verification code (local dev)');
  assert.strictEqual(last.username, name);
  return last.code;
}

test('auth: protected and role-gated methods reject a signed-out caller', async () => {
  await assert.rejects(() => api.whoAmI(), (e: unknown) => isBlocksError(e, 'NotAuthenticatedException'));
  await assert.rejects(() => api.editorsOnly(), (e: unknown) => isBlocksError(e, 'NotAuthenticatedException'));
});

test('auth: sign up with the emailed code signs the user in', async () => {
  const signUp = await authApi.setAuthState({ action: 'signUp', username: email, password });
  assert.strictEqual(signUp.state, 'confirmingSignUp');

  const confirmed = await authApi.setAuthState({ action: 'confirmSignUp', username: email, code: await lastCodeFor(email) });
  // The <Authenticator> submits this step on its own; no second password entry.
  assert.ok(confirmed.actions.some((a) => a.name === 'autoSignIn'));
  const state = await authApi.setAuthState({ action: 'autoSignIn', username: email });
  assert.strictEqual(state.state, 'signedIn');
  // The username is an id Cognito generates; the UI shows `displayName`.
  assert.strictEqual(state.user?.displayName, email);

  const me = await api.whoAmI();
  assert.strictEqual(me.attributes.email, email);
  assert.deepStrictEqual(me.groups, []);
});

test('auth: requireRole rejects a user outside the group', async () => {
  await assert.rejects(() => api.editorsOnly(), (e: unknown) => isBlocksError(e, 'NotAuthorizedException'));
});

test('auth: custom attribute round-trip', async () => {
  await api.updateDepartment('Engineering');
  const attrs = await api.getUserAttributes();
  assert.strictEqual(attrs['custom:department'], 'Engineering');
});

test('todos: per-user create and list', async () => {
  const me = await api.whoAmI();
  const todo = await api.createTodo('Try AWS Blocks', 1);
  assert.strictEqual(todo.userSub, me.userSub, "the todo is keyed on the owner's userSub");
  const list = await api.listTodos();
  assert.ok(list.some((t) => t.todoId === todo.todoId));
  assert.ok(list.every((t) => t.userSub === me.userSub));
  await api.deleteTodo(todo.todoId);
});

test('auth: sign out, then sign back in with email + password', async () => {
  await authApi.setAuthState({ action: 'signOut' });
  await assert.rejects(() => api.listTodos(), (e: unknown) => isBlocksError(e, 'NotAuthenticatedException'));
  const state = await authApi.setAuthState({ action: 'signIn', username: email, password });
  assert.strictEqual(state.state, 'signedIn');
});

test('todos: another user can neither see nor change them', async () => {
  const mine = await api.createTodo('Private to the first user', 1);

  // Sign in as a second, brand-new user.
  await authApi.setAuthState({ action: 'signOut' });
  const other = `b-${email}`;
  await authApi.setAuthState({ action: 'signUp', username: other, password });
  await authApi.setAuthState({ action: 'confirmSignUp', username: other, code: await lastCodeFor(other) });
  assert.strictEqual((await authApi.setAuthState({ action: 'autoSignIn', username: other })).state, 'signedIn');

  const bobsTodo = await api.createTodo('Second user', 2);
  for (const sortBy of [undefined, 'priority', 'title', 'createdAt'] as const) {
    const theirs = await api.listTodos(sortBy);
    assert.ok(!theirs.some((t) => t.todoId === mine.todoId), `listTodos(${sortBy ?? ''}) leaked the first user's todo`);
  }
  await assert.rejects(() => api.updateTodo(mine.todoId, { title: 'not yours' }), /not found/i);
  await api.deleteTodo(mine.todoId); // a no-op outside the caller's own todos

  // Extra properties reach the server untouched, so updateTodo must not copy
  // key fields from `updates` onto the stored todo.
  const withKeyFields = { title: 'still mine', userSub: mine.userSub, todoId: mine.todoId };
  await api.updateTodo(bobsTodo.todoId, withKeyFields);
  const theirs = await api.listTodos();
  assert.deepStrictEqual(theirs.map((t) => [t.todoId, t.title]), [[bobsTodo.todoId, 'still mine']]);

  // Back as the first user: the todo is still there, unchanged.
  await authApi.setAuthState({ action: 'signOut' });
  assert.strictEqual((await authApi.setAuthState({ action: 'signIn', username: email, password })).state, 'signedIn');
  const after = await api.listTodos();
  assert.deepStrictEqual(after.map((t) => [t.todoId, t.title]), [[mine.todoId, 'Private to the first user']]);
  await api.deleteTodo(mine.todoId);
});
