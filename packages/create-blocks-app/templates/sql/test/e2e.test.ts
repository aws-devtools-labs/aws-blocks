import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import type { api as apiType, authApi as authApiType } from 'aws-blocks';

installCookieJar();

let server: ChildProcess | null = null;
let api: typeof apiType;
let authApi: typeof authApiType;
const serverPort = 3001;
const readinessUrl = `http://localhost:${serverPort}/.blocks-sandbox/config.json`;

/**
 * Sign up and sign in, the way the sign-in UI does: sign-up confirms the email
 * address with a 6-digit code, then signs the user in. Locally no email is
 * sent: every code is written to `.bb-data/<scope id>-<auth id>/last-code.json`
 * (here `my-app` + `auth`). On AWS, Cognito emails it instead.
 */
async function signUpAndSignIn(username: string, password: string) {
  const signUp = await authApi.setAuthState({ action: 'signUp', username, password, email: `${username}@example.com` });
  assert.strictEqual(signUp.state, 'confirmingSignUp');
  const last: { username: string; code: string } = JSON.parse(
    await readFile('.bb-data/my-app-auth/last-code.json', 'utf-8'),
  );
  assert.strictEqual(last.username, username, 'expected a code for this user');
  await authApi.setAuthState({ action: 'confirmSignUp', username, code: last.code });
  return await authApi.setAuthState({ action: 'autoSignIn', username });
}

test.before(async () => {
  if (!await isServerRunning(serverPort)) {
    server = spawn('npm', ['run', 'dev'], {
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
  const username = `e2e-${Date.now().toString(36)}`;
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
  const owner = `e2e-owner-${Date.now().toString(36)}`;
  await authApi.setAuthState({ action: 'signOut' });
  assert.strictEqual((await signUpAndSignIn(owner, password)).state, 'signedIn');
  const notebook = await api.createNotebook('Private');
  await api.addNote(notebook.id, 'Secret');

  await authApi.setAuthState({ action: 'signOut' });
  assert.strictEqual((await signUpAndSignIn(`e2e-other-${Date.now().toString(36)}`, password)).state, 'signedIn');
  const theirs = await api.listNotebooks();
  assert.ok(!theirs.some((n) => n.id === notebook.id), "listNotebooks leaked the owner's notebook");
  assert.deepStrictEqual(await api.listNotes(notebook.id), [], "listNotes leaked the owner's notes");
  await assert.rejects(() => api.addNote(notebook.id, 'Intruder'), /not found/i);
  await api.deleteNotebook(notebook.id); // a no-op outside the caller's own notebooks

  await authApi.setAuthState({ action: 'signOut' });
  assert.strictEqual((await authApi.setAuthState({ action: 'signIn', username: owner, password })).state, 'signedIn');
  assert.ok((await api.listNotebooks()).some((n) => n.id === notebook.id), 'the owner still has the notebook');
  const notes = await api.listNotes(notebook.id);
  assert.deepStrictEqual(notes.map((n) => n.body), ['Secret']);
  await api.deleteNotebook(notebook.id);
});
