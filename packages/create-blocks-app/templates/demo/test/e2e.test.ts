import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { isBlocksError } from '@aws-blocks/blocks/client';
import { installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import type { api as apiType, authApi as authApiType, hello as helloType } from 'aws-blocks';

// npm is npm.cmd on Windows, which spawn won't resolve without a shell.
const isWin = process.platform === 'win32';

installCookieJar();

let server: ChildProcess | null = null;
let api: typeof apiType;
let hello: typeof helloType;
let authApi: typeof authApiType;
const serverPort = 3000;
const readinessUrl = `http://localhost:${serverPort}/.blocks-sandbox/config.json`;

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

test('KV Store - set and get', async () => {
  const setResult = await api.setValue('test-key', 'test-value');
  assert.strictEqual(setResult.success, true);

  const value = await api.getValue('test-key');
  assert.strictEqual(value, 'test-value');
});

// Sign-up confirms the email address with a code, then signs the user in
// (the <Authenticator> does the same steps in the browser).
test('auth: sign up with the emailed code, then call a protected method', async () => {
  const username = `demo-${Date.now().toString(36)}@example.com`;
  const password = 'TestPass123!';

  await assert.rejects(
    () => api.listTodos(),
    (err: unknown) => isBlocksError(err, 'NotAuthenticatedException'),
    'todo methods require a signed-in user',
  );

  const signUp = await authApi.setAuthState({ action: 'signUp', username, password });
  assert.strictEqual(signUp.state, 'confirmingSignUp');
  await authApi.setAuthState({ action: 'confirmSignUp', username, code: await lastCode(username) });
  const state = await authApi.setAuthState({ action: 'autoSignIn', username });
  assert.strictEqual(state.state, 'signedIn');

  const todo = await api.createTodo('Try AWS Blocks', 1);
  assert.ok(todo.userSub, "the todo is keyed on the owner's userSub");
  await api.deleteTodo(todo.todoId);
});

/** Sign out whoever is signed in, then sign up `username` and sign them in. */
async function signUpAs(username: string, password: string) {
  await authApi.setAuthState({ action: 'signOut' });
  await authApi.setAuthState({ action: 'signUp', username, password });
  await authApi.setAuthState({ action: 'confirmSignUp', username, code: await lastCode(username) });
  const state = await authApi.setAuthState({ action: 'autoSignIn', username });
  assert.strictEqual(state.state, 'signedIn');
}

// Todos are private: each method reads and writes only the caller's own.
test('todos: another user can neither see nor change them', async () => {
  const password = 'TestPass123!';
  const alice = `demo-a-${Date.now().toString(36)}@example.com`;
  await signUpAs(alice, password);
  const mine = await api.createTodo('Private to alice', 1);

  await signUpAs(`demo-b-${Date.now().toString(36)}@example.com`, password);
  const bobsTodo = await api.createTodo('Bob', 2);
  for (const sortBy of [undefined, 'priority', 'title', 'createdAt'] as const) {
    const theirs = await api.listTodos(sortBy);
    assert.ok(!theirs.some((t) => t.todoId === mine.todoId), `listTodos(${sortBy ?? ''}) leaked alice's todo`);
  }
  await assert.rejects(() => api.updateTodo(mine.todoId, { title: 'not yours' }), /not found/i);
  await api.deleteTodo(mine.todoId); // a no-op outside the caller's own todos

  // Extra properties reach the server untouched, so updateTodo must not copy
  // key fields from `updates` onto the stored todo.
  const withKeyFields = { title: 'still bob', userSub: mine.userSub, todoId: mine.todoId };
  await api.updateTodo(bobsTodo.todoId, withKeyFields);
  const bobs = await api.listTodos();
  assert.deepStrictEqual(bobs.map((t) => [t.todoId, t.title]), [[bobsTodo.todoId, 'still bob']]);

  await authApi.setAuthState({ action: 'signOut' });
  assert.strictEqual((await authApi.setAuthState({ action: 'signIn', username: alice, password })).state, 'signedIn');
  const after = await api.listTodos();
  assert.deepStrictEqual(after.map((t) => [t.todoId, t.title]), [[mine.todoId, 'Private to alice']]);
  await api.deleteTodo(mine.todoId);
});

// ─── FileBucket ─────────────────────────────────────────────────────────────
// `getUploadSlot()` / `getFileHandle()` return descriptors the client hydrates
// into live upload/download handles backed by the dev server's local file
// server (no AWS). We upload bytes, then download them back and assert they
// round-trip unchanged.
test('FileBucket - upload then download round-trips', async (t) => {
  const path = 'uploads/greeting.txt';
  const contentType = 'text/plain';
  const payload = 'hello from the file bucket';

  const slot = await api.getUploadSlot(path, contentType);
  if (typeof slot.upload !== 'function') {
    t.skip('FileBucket middleware not hydrated (no local file server — expected on Windows)');
    return;
  }
  await slot.upload(new Blob([payload], { type: contentType }));

  const handle = await api.getFileHandle(path);
  // The upload skip-gate above already confirmed the middleware hydrates in this
  // environment, so a bare assertion here is intentional: a non-function download
  // at this point is a genuine regression, not the no-local-file-server case.
  assert.strictEqual(typeof handle.download, 'function', 'download handle should hydrate');
  const blob = await handle.download();
  const text = await blob.text();
  assert.strictEqual(text, payload);
});

// ─── AppSetting ───────────────────────────────────────────────────────────────
// A runtime config value backed by SSM Parameter Store (local file in dev).
test('AppSetting - set and get a flag', async () => {
  const setResult = await api.setFlag('on');
  assert.strictEqual(setResult.success, true);

  const value = await api.getFlag();
  assert.strictEqual(value, 'on');
});

// ─── AsyncJob ─────────────────────────────────────────────────────────────────
// Background processing. The handler runs locally (no SQS/Lambda); we submit a
// job, wait for completion, and confirm the handler's side effect landed.
test('AsyncJob - submit, complete, and observe the effect', async () => {
  const name = `e2e-${Date.now().toString(36)}`;

  const result = await api.runGreetingJob(name);
  assert.strictEqual(result.state, 'complete');

  const ran = await api.jobRan(name);
  assert.strictEqual(ran, true, 'the job handler should have run and written its marker');
});

// ─── EmailClient ────────────────────────────────────────────────────────────
// Transactional email (no SES in local dev). This is a send-succeeds smoke
// check: it asserts send() resolves with a message id. It does not assert the
// mock recorded the mail — EmailClient's public API is send/sendBatch only (no
// read-back method, matching the AWS runtime), so asserting capture would mean
// reaching into mock-internal storage and breaking mock/AWS parity.
test('EmailClient - send returns a message id', async () => {
  const { messageId } = await api.sendWelcome('user@example.com');
  assert.ok(typeof messageId === 'string' && messageId.length > 0, 'send should return a message id');
});
