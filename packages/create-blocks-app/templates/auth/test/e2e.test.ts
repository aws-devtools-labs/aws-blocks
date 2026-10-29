import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { isBlocksError } from '@aws-blocks/blocks/client';
import { createTestClient, getLastAuthCode, installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import type { api as apiType, authApi as authApiType, hello as helloType } from 'aws-blocks';

// npm is npm.cmd on Windows, which spawn won't resolve without a shell.
const isWin = process.platform === 'win32';

installCookieJar();

let server: ChildProcess | null = null;
let app: typeof import('aws-blocks');
let api: typeof apiType;
let hello: typeof helloType;
let authApi: typeof authApiType;
const serverPort = 3000;
const readinessUrl = `http://localhost:${serverPort}/.blocks-sandbox/config.json`;

// The sign-in tests below read each emailed code with `getLastAuthCode()`, which
// reads the local mock pool's files (.bb-data/): against a running sandbox the
// server on :3000 proxies to the deployed Lambda, where Cognito emails the code
// and each run would create a real user. The readiness config.json says which
// one we hit.
let isLocalMock = false;

/** Skips [t] unless the server is the local mock; true when skipped. */
function skipUnlessLocal(t: { skip(message?: string): void }): boolean {
  if (isLocalMock) return false;
  t.skip('needs the local mock: Cognito emails the code on a deployed backend');
  return true;
}

test.before(async () => {
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
  hello = app.hello;
  authApi = app.authApi;

  // Wait for the Blocks server to be ready without depending on the sample API.
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(readinessUrl);
      if (response.ok) {
        const config: { environment?: string } = await response.json();
        isLocalMock = config.environment === 'local';
        return;
      }
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

test('KV Store - rejects signed-out callers', async () => {
  await authApi.setAuthState({ action: 'signOut' });
  await assert.rejects(() => api.getValue('test-key'), (e: unknown) => isBlocksError(e, 'NotAuthenticatedException'));
  await assert.rejects(() => api.setValue('test-key', 'test-value'), (e: unknown) => isBlocksError(e, 'NotAuthenticatedException'));
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
// The same steps the <Authenticator> drives in the browser. A fresh email per
// run, so the suite also passes against existing local data.
const email = `e2e-${Date.now().toString(36)}@example.com`;
const password = 'TestPass123!';

/**
 * A new user with a session of their own: `createTestClient` gives them the
 * app's clients with their own cookie jar, so a test can hold several users at
 * once. `getLastAuthCode` reads the code the local pool "emailed" them.
 */
async function newUser(name: string) {
  const user = createTestClient(app);
  await user.authApi.setAuthState({ action: 'signUp', username: name, password });
  await user.authApi.setAuthState({ action: 'confirmSignUp', username: name, code: await getLastAuthCode(name) });
  assert.strictEqual((await user.authApi.setAuthState({ action: 'autoSignIn', username: name })).state, 'signedIn');
  return user;
}

test('auth: protected and role-gated methods reject a signed-out caller', async () => {
  await assert.rejects(() => api.whoAmI(), (e: unknown) => isBlocksError(e, 'NotAuthenticatedException'));
  await assert.rejects(() => api.editorsOnly(), (e: unknown) => isBlocksError(e, 'NotAuthenticatedException'));
});

test('auth: sign up with the emailed code signs the user in', async (t) => {
  if (skipUnlessLocal(t)) return;
  const signUp = await authApi.setAuthState({ action: 'signUp', username: email, password });
  assert.strictEqual(signUp.state, 'confirmingSignUp');

  const confirmed = await authApi.setAuthState({ action: 'confirmSignUp', username: email, code: await getLastAuthCode(email) });
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

test('auth: requireRole rejects a user outside the group', async (t) => {
  if (skipUnlessLocal(t)) return;
  await assert.rejects(() => api.editorsOnly(), (e: unknown) => isBlocksError(e, 'NotAuthorizedException'));
});

test('auth: custom attribute round-trip', async (t) => {
  if (skipUnlessLocal(t)) return;
  await api.updateDepartment('Engineering');
  const attrs = await api.getUserAttributes();
  assert.strictEqual(attrs['custom:department'], 'Engineering');
});

test('todos: per-user create and list', async (t) => {
  if (skipUnlessLocal(t)) return;
  const me = await api.whoAmI();
  const todo = await api.createTodo('Try AWS Blocks', 1);
  assert.strictEqual(todo.userSub, me.userSub, "the todo is keyed on the owner's userSub");
  const list = await api.listTodos();
  assert.ok(list.some((t) => t.todoId === todo.todoId));
  assert.ok(list.every((t) => t.userSub === me.userSub));
  await api.deleteTodo(todo.todoId);
});

test('auth: sign out, then sign back in with email + password', async (t) => {
  if (skipUnlessLocal(t)) return;
  await authApi.setAuthState({ action: 'signOut' });
  await assert.rejects(() => api.listTodos(), (e: unknown) => isBlocksError(e, 'NotAuthenticatedException'));
  const state = await authApi.setAuthState({ action: 'signIn', username: email, password });
  assert.strictEqual(state.state, 'signedIn');
});

test('todos: another user can neither see nor change them', async (t) => {
  if (skipUnlessLocal(t)) return;
  const mine = await api.createTodo('Private to the first user', 1);

  // A second, brand-new user, signed in at the same time as the first.
  const other = await newUser(`b-${email}`);

  const bobsTodo = await other.api.createTodo('Second user', 2);
  for (const sortBy of [undefined, 'priority', 'title', 'createdAt'] as const) {
    const theirs = await other.api.listTodos(sortBy);
    assert.ok(!theirs.some((t) => t.todoId === mine.todoId), `listTodos(${sortBy ?? ''}) leaked the first user's todo`);
  }
  await assert.rejects(() => other.api.updateTodo(mine.todoId, { title: 'not yours' }), /not found/i);
  await other.api.deleteTodo(mine.todoId); // a no-op outside the caller's own todos

  // Extra properties reach the server untouched, so updateTodo must not copy
  // key fields from `updates` onto the stored todo.
  const withKeyFields = { title: 'still mine', userSub: mine.userSub, todoId: mine.todoId };
  await other.api.updateTodo(bobsTodo.todoId, withKeyFields);
  const theirs = await other.api.listTodos();
  assert.deepStrictEqual(theirs.map((t) => [t.todoId, t.title]), [[bobsTodo.todoId, 'still mine']]);

  // The first user, still signed in: the todo is still there, unchanged.
  const after = await api.listTodos();
  assert.deepStrictEqual(after.map((t) => [t.todoId, t.title]), [[mine.todoId, 'Private to the first user']]);
  await api.deleteTodo(mine.todoId);
});

test('KV Store - set and get (signed in, keys isolated per user)', async (t) => {
  if (skipUnlessLocal(t)) return;
  const a = await newUser(`kv-a-${Date.now().toString(36)}@example.com`);
  const b = await newUser(`kv-b-${Date.now().toString(36)}@example.com`);
  assert.strictEqual((await a.api.setValue('test-key', 'test-value')).success, true);
  assert.strictEqual(await a.api.getValue('test-key'), 'test-value');

  // A different user sees their own namespace, not the first user's value.
  assert.strictEqual(await b.api.getValue('test-key'), null);
});
