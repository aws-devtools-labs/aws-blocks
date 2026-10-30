import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { createTestClient, getLastAuthCode, installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import type { api as apiType, authApi as authApiType } from 'aws-blocks';

// npm is npm.cmd on Windows, which spawn won't resolve without a shell.
const isWin = process.platform === 'win32';

installCookieJar();

let server: ChildProcess | null = null;
let app: typeof import('aws-blocks');
let api: typeof apiType;
let authApi: typeof authApiType;
const serverPort = 3001;
const readinessUrl = `http://localhost:${serverPort}/.blocks-sandbox/config.json`;

/**
 * Sign up and sign in, the way the sign-in UI does: sign-up confirms the email
 * address with a 6-digit code, then signs the user in. Locally no email is
 * sent: `getLastAuthCode` reads the code the local auth block issued (it finds
 * the block's .bb-data/ files itself). On AWS, Cognito emails it instead.
 *
 * `user` defaults to this file's clients (the cookie jar `installCookieJar`
 * installs); pass `createTestClient(app)` for another user with a session of
 * their own, signed in at the same time.
 */
async function signUpAndSignIn(username: string, password: string, user = { authApi }) {
  const signUp = await user.authApi.setAuthState({ action: 'signUp', username, password });
  assert.strictEqual(signUp.state, 'confirmingSignUp');
  await user.authApi.setAuthState({ action: 'confirmSignUp', username, code: await getLastAuthCode(username) });
  return await user.authApi.setAuthState({ action: 'autoSignIn', username });
}

test.before(async () => {
  if (!await isServerRunning(serverPort)) {
    server = spawn('npm', ['run', 'dev'], {
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

// App-level readiness — independent of the sample API, so it keeps passing
// after you replace these methods with your own.
test('app: server serves its Blocks config', async () => {
  const response = await fetch(readinessUrl);
  assert.ok(response.ok, `expected ${readinessUrl} to respond ok`);
});

// Runs against the sample SQL API the template ships with, so a freshly
// scaffolded app is validated end to end: signup + login, then a notebook and
// note round-trip through PostgreSQL. When you replace the sample API, update
// or delete this test to exercise your own methods instead.
test('sql: notebook and note round-trip', async () => {
  const username = `e2e-${Date.now().toString(36)}@example.com`;
  const password = 'TestPass123!';

  const state = await signUpAndSignIn(username, password);
  assert.strictEqual(state.state, 'signedIn');

  const notebook = await api.createNotebook('Journal');
  assert.ok(notebook.id, 'expected a notebook id');
  assert.strictEqual(notebook.name, 'Journal');

  const notebooks = await api.listNotebooks();
  assert.ok(
    notebooks.some((n) => n.id === notebook.id),
    'created notebook should appear in the list',
  );

  const note = await api.addNote(notebook.id, 'First entry');
  assert.ok(note.id, 'expected a note id');

  const notes = await api.listNotes(notebook.id);
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(notes[0].body, 'First entry');

  // Deleting the notebook cascades to its notes.
  await api.deleteNotebook(notebook.id);
  const afterDelete = await api.listNotebooks();
  assert.ok(
    !afterDelete.some((n) => n.id === notebook.id),
    'deleted notebook should be gone',
  );
});

// Notebooks and notes are private: every method reads and writes only the
// caller's own. When you replace the sample API, update or delete this test.
test('sql: another user can neither see nor change them', async () => {
  const password = 'TestPass123!';
  // Two users signed in at once, each with a cookie jar of their own.
  const owner = createTestClient(app);
  const other = createTestClient(app);
  assert.strictEqual((await signUpAndSignIn(`e2e-owner-${Date.now().toString(36)}@example.com`, password, owner)).state, 'signedIn');
  assert.strictEqual((await signUpAndSignIn(`e2e-other-${Date.now().toString(36)}@example.com`, password, other)).state, 'signedIn');
  const notebook = await owner.api.createNotebook('Private');
  await owner.api.addNote(notebook.id, 'Secret');

  const theirs = await other.api.listNotebooks();
  assert.ok(!theirs.some((n) => n.id === notebook.id), "listNotebooks leaked the owner's notebook");
  assert.deepStrictEqual(await other.api.listNotes(notebook.id), [], "listNotes leaked the owner's notes");
  await assert.rejects(() => other.api.addNote(notebook.id, 'Intruder'), /not found/i);
  await other.api.deleteNotebook(notebook.id); // a no-op outside the caller's own notebooks

  assert.ok((await owner.api.listNotebooks()).some((n) => n.id === notebook.id), 'the owner still has the notebook');
  const notes = await owner.api.listNotes(notebook.id);
  assert.deepStrictEqual(notes.map((n) => n.body), ['Secret']);
  await owner.api.deleteNotebook(notebook.id);
});
