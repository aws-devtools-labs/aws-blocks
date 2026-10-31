import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import type { api as apiType, authApi as authApiType } from 'aws-blocks';

// npm is npm.cmd on Windows, which spawn won't resolve without a shell.
const isWin = process.platform === 'win32';

installCookieJar();

let server: ChildProcess | null = null;
let api: typeof apiType;
let authApi: typeof authApiType;
const serverPort = 3001;
const readinessUrl = `http://localhost:${serverPort}/.blocks-sandbox/config.json`;

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

// Signal the dev server's process group; signal 0 only reports whether any of it is still alive.
function signalServer(pid: number, signal: NodeJS.Signals | 0) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function waitForServerExit(pid: number, ms: number) {
  for (const deadline = Date.now() + ms; signalServer(pid, 0); await setTimeout(100)) {
    if (Date.now() >= deadline) return false;
  }
  return true;
}

// The dev server shuts down gracefully, so wait for it to exit: it can still be
// writing to the app's directory when this file ends and the caller removes it.
test.after(async () => {
  if (!server?.pid) return;
  if (isWin) {
    spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  if (!signalServer(server.pid, 'SIGTERM') || await waitForServerExit(server.pid, 15_000)) return;
  signalServer(server.pid, 'SIGKILL');
  await waitForServerExit(server.pid, 2_000);
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
  const password = 'password123';

  // signUp creates the account and signs in (no code delivery configured).
  const state = await authApi.setAuthState({ action: 'signUp', username, password });
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
