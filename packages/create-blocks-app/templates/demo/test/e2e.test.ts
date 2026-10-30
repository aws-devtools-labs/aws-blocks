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
let authApi: typeof authApiType;
let hello: typeof helloType;
const serverPort = 3000;
const readinessUrl = `http://localhost:${serverPort}/.blocks-sandbox/config.json`;

// Locally no email is sent: `getLastAuthCode(name)` reads the verification code
// the local auth block just issued for `name` (it finds the block's .bb-data/
// files itself). On AWS, Cognito emails it instead.

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
  authApi = app.authApi;
  hello = app.hello;

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

// The installed cookie jar carries the session cookie across calls, so after
// this resolves every API call runs as the new user. This pool signs in with an
// email, so `name` becomes an address (`:` and other punctuation turn into `-`);
// sign-up confirms the emailed code, then signs the user in (see `signUpAs`).
const signUp = async (name: string) => {
  await signUpAs(`${name.replace(/[^A-Za-z0-9-]/g, '-')}@example.com`, 'Password1!');
};
const uniqueSuffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

test('Protected methods reject signed-out callers', async () => {
  await authApi.setAuthState({ action: 'signOut' });
  await assert.rejects(api.getValue('test-key'), { status: 401 });
  await assert.rejects(api.setValue('test-key', 'test-value'), { status: 401 });
  await assert.rejects(api.getUploadSlot('uploads/x.txt', 'text/plain'), { status: 401 });
  await assert.rejects(api.getFileHandle('uploads/x.txt'), { status: 401 });
  await assert.rejects(api.setFlag('on'), { status: 401 });
  await assert.rejects(api.rotateApiKey('key-x'), { status: 401 });
  await assert.rejects(api.getApiKey(), { status: 401 });
  await assert.rejects(api.getPreviousApiKey(), { status: 401 });
  await assert.rejects(api.apiKeyVersionCount(), { status: 401 });
  await assert.rejects(api.sendWelcome('user@example.com'), { status: 401 });
  await assert.rejects(api.runGreetingJob('signed-out'), { status: 401 });
});

test('KV Store - set and get (signed in, keys isolated per user)', async () => {
  const suffix = uniqueSuffix();

  await signUp(`alice-${suffix}`);
  const setResult = await api.setValue('test-key', 'test-value');
  assert.strictEqual(setResult.success, true);
  assert.strictEqual(await api.getValue('test-key'), 'test-value');

  // A different user sees their own namespace, not alice's value.
  await signUp(`bob-${suffix}`);
  assert.strictEqual(await api.getValue('test-key'), null);

  await authApi.setAuthState({ action: 'signOut' });
});

test('KV Store - a ":" in the username cannot reach another user\'s keys', async () => {
  const alice = `alice-${uniqueSuffix()}`;

  await signUp(alice);
  await api.setValue('notes:secret', 'alice-value');

  // `${alice}:notes` + `secret` must not map onto `${alice}` + `notes:secret`.
  await signUp(`${alice}:notes`);
  assert.strictEqual(await api.getValue('secret'), null);

  await authApi.setAuthState({ action: 'signOut' });
});

// ─── Cookies ────────────────────────────────────────────────────────────────
// Runs the real setCookie/getCookie/deleteCookie: a value with `;` or CR/LF
// must be encoded, so it round-trips instead of adding cookie attributes.
test('Cookie - a hostile value round-trips without adding attributes', async () => {
  const value = 'x; Domain=evil.example\r\nSet-Cookie: admin=1';
  await api.setCookie(value);
  assert.strictEqual(await api.getCookie(), value);
  await api.deleteCookie();
  assert.strictEqual(await api.getCookie(), null);
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
  await authApi.setAuthState({ action: 'confirmSignUp', username, code: await getLastAuthCode(username) });
  const state = await authApi.setAuthState({ action: 'autoSignIn', username });
  assert.strictEqual(state.state, 'signedIn');

  const todo = await api.createTodo('Try AWS Blocks', 1);
  assert.ok(todo.userSub, "the todo is keyed on the owner's userSub");
  await api.deleteTodo(todo.todoId);
});

/**
 * Sign out whoever is signed in, then sign up `username` and sign them in.
 * `user` defaults to this file's clients (the cookie jar `installCookieJar`
 * installs); pass `createTestClient(app)` for another user with a session of
 * their own, signed in at the same time.
 */
async function signUpAs(username: string, password: string, user = { authApi }) {
  await user.authApi.setAuthState({ action: 'signOut' });
  await user.authApi.setAuthState({ action: 'signUp', username, password });
  await user.authApi.setAuthState({ action: 'confirmSignUp', username, code: await getLastAuthCode(username) });
  const state = await user.authApi.setAuthState({ action: 'autoSignIn', username });
  assert.strictEqual(state.state, 'signedIn');
}

// Todos are private: each method reads and writes only the caller's own.
test('todos: another user can neither see nor change them', async () => {
  const password = 'TestPass123!';
  // Alice and Bob signed in at once, each with a cookie jar of their own.
  const alice = createTestClient(app);
  const bob = createTestClient(app);
  await signUpAs(`demo-a-${Date.now().toString(36)}@example.com`, password, alice);
  await signUpAs(`demo-b-${Date.now().toString(36)}@example.com`, password, bob);
  const mine = await alice.api.createTodo('Private to alice', 1);

  const bobsTodo = await bob.api.createTodo('Bob', 2);
  for (const sortBy of [undefined, 'priority', 'title', 'createdAt'] as const) {
    const theirs = await bob.api.listTodos(sortBy);
    assert.ok(!theirs.some((t) => t.todoId === mine.todoId), `listTodos(${sortBy ?? ''}) leaked alice's todo`);
  }
  await assert.rejects(() => bob.api.updateTodo(mine.todoId, { title: 'not yours' }), /not found/i);
  await bob.api.deleteTodo(mine.todoId); // a no-op outside the caller's own todos

  // Extra properties reach the server untouched, so updateTodo must not copy
  // key fields from `updates` onto the stored todo.
  const withKeyFields = { title: 'still bob', userSub: mine.userSub, todoId: mine.todoId };
  await bob.api.updateTodo(bobsTodo.todoId, withKeyFields);
  const bobs = await bob.api.listTodos();
  assert.deepStrictEqual(bobs.map((t) => [t.todoId, t.title]), [[bobsTodo.todoId, 'still bob']]);

  const after = await alice.api.listTodos();
  assert.deepStrictEqual(after.map((t) => [t.todoId, t.title]), [[mine.todoId, 'Private to alice']]);
  await alice.api.deleteTodo(mine.todoId);
});

// ─── FileBucket ─────────────────────────────────────────────────────────────
// `getUploadSlot()` / `getFileHandle()` return descriptors the client hydrates
// into live upload/download handles backed by the dev server's local file
// server (no AWS). We upload bytes, then download them back and assert they
// round-trip unchanged.
test('FileBucket - upload then download round-trips', async (t) => {
  await signUp(`files-${uniqueSuffix()}`);
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
  await signUp(`flag-${uniqueSuffix()}`);
  const setResult = await api.setFlag('on');
  assert.strictEqual(setResult.success, true);

  const value = await api.getFlag();
  assert.strictEqual(value, 'on');
});

// ─── Secret ─────────────────────────────────────────────────────────────────
// A credential backed by Secrets Manager (local file in dev). Unlike AppSetting
// it keeps version history: after a rotation the previous value stays readable
// until the next rotation (history is capped at current + previous, not time-aged).
// We set, rotate, then assert current + previous + that two versions are labeled.
test('Secret - rotate keeps the previous value readable', async () => {
  await signUp(`secret-${uniqueSuffix()}`);
  await api.rotateApiKey('key-v1');
  await api.rotateApiKey('key-v2');

  assert.strictEqual(await api.getApiKey(), 'key-v2');
  assert.strictEqual(await api.getPreviousApiKey(), 'key-v1');
  assert.strictEqual(await api.apiKeyVersionCount(), 2);
});

// ─── KnowledgeBase ────────────────────────────────────────────────────────
// Semantic search over the ./knowledge corpus. Backed by Bedrock KB on deploy;
// locally the mock builds a TF-IDF index over the committed docs (no AWS). We
// query a billing question and assert the top hit comes from billing.md, not
// the unrelated shipping doc, with a positive relevance score.
test('KnowledgeBase - retrieves the relevant doc for a query', async () => {
  const results = await api.searchDocs('how do I get a refund for a payment');
  assert.ok(results.length > 0, 'expected at least one retrieval result');
  // endsWith (not strictEqual): the mock returns `source` relative to the corpus
  // root (billing.md), while the Bedrock layer returns an s3://<bucket>/billing.md
  // URI — endsWith matches the filename across both.
  assert.ok(
    results[0].source.endsWith('billing.md'),
    'top hit should be the billing doc',
  );
  assert.ok(results[0].score > 0, 'top hit should have a positive relevance score');
});

// ─── AsyncJob ─────────────────────────────────────────────────────────────────
// Background processing. The handler runs locally (no SQS/Lambda); we submit a
// job, wait for completion, and confirm the handler's side effect landed.
test('AsyncJob - submit, complete, and observe the effect', async () => {
  await signUp(`job-${uniqueSuffix()}`);
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
  await signUp(`email-${uniqueSuffix()}`);
  const { messageId } = await api.sendWelcome('user@example.com');
  assert.ok(typeof messageId === 'string' && messageId.length > 0, 'send should return a message id');
});

// ─── DistributedDatabase (SQL) ───────────────────────────────────────────
// A money transfer runs both UPDATEs inside one transaction: the balances move
// together or not at all. We assert the post-transfer balances AND that the
// total is conserved — the atomic-multi-row-write capability DistributedTable
// cannot express. Runs on the PGlite mock locally (no AWS). OCC-conflict retry
// (SerializationFailureException / retryOnConflict) is covered by the
// bb-distributed-data unit suite; forcing a real 40001 race here would be
// non-deterministic, so the canary asserts the atomic-commit behavior instead.
test('DistributedDatabase - a transfer moves both balances atomically', async () => {
  await api.openAccount('alice', 100);
  await api.openAccount('bob', 0);

  await api.transfer('alice', 'bob', 30);

  const alice = await api.balanceOf('alice');
  const bob = await api.balanceOf('bob');
  assert.strictEqual(alice.balance, 70, 'alice debited');
  assert.strictEqual(bob.balance, 30, 'bob credited');
  assert.strictEqual(
    (alice.balance ?? 0) + (bob.balance ?? 0),
    100,
    'the transaction conserves the total — both updates committed',
  );
});

// The guard makes the atomic-abort path observable: an overdraft matches zero
// rows on the debit, so transfer throws and the credit is rolled back with it.
// transfer throws an ApiError (wire-safe), so the 'TransferDeclined' name crosses
// the RPC boundary and the client can match it; the decisive proof is behavioral:
// the call rejects with that branded error AND neither balance moved.
test('DistributedDatabase - a declined transfer rolls back atomically', async () => {
  const { isBlocksError } = await import('@aws-blocks/blocks/client');

  await api.openAccount('carol', 50);
  await api.openAccount('dave', 0);

  await assert.rejects(
    () => api.transfer('carol', 'dave', 999),
    (e: unknown) => isBlocksError(e, 'TransferDeclined'),
    'an overdraft transfer should raise a branded TransferDeclined error',
  );

  const carol = await api.balanceOf('carol');
  const dave = await api.balanceOf('dave');
  assert.strictEqual(carol.balance, 50, 'carol not debited — transaction aborted');
  assert.strictEqual(dave.balance, 0, 'dave not credited — the whole transfer rolled back');
});
