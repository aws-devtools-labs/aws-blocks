/**
 * End-to-end tests — exercise the Agent BB via the same typed client the
 * frontend uses. The agent runs on the built-in `canned` provider locally
 * (deterministic, no LLM, no AWS), so these assertions are reproducible.
 *
 * Run:  npm run test:e2e
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { getLastAuthCode, installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import type { api as ApiType, authApi as AuthApiType } from 'aws-blocks';

// npm is npm.cmd on Windows, which spawn won't resolve without a shell.
const isWin = process.platform === 'win32';

installCookieJar();

let server: ChildProcess | null = null;
let api: typeof ApiType;
let authApi: typeof AuthApiType;

// The dev server's port: package.json "blocks.dev.port", which `npm run dev` also uses.
const serverPort: number = JSON.parse(readFileSync('package.json', 'utf-8')).blocks?.dev?.port ?? 3000;
const readinessUrl = `http://localhost:${serverPort}/.blocks-sandbox/config.json`;

// The canned-provider assertions below only hold in the local mock runtime; a
// deployed sandbox runs a real Bedrock model whose text is non-deterministic.
// So no test drives a deployed turn: the deployed path relies on `model.deployed`
// in aws-blocks/index.ts naming a valid model. The readiness config.json
// carries which runtime we hit.
let isLocalMock = false;

// A new user each run: the local auth store persists, so a fixed username
// would already exist when you rerun `npm run test:e2e` against the same server.
const creds = { username: `agent-user-${Date.now()}@example.com`, password: 'TestPass123!' };

// Sign up the way the sign-in UI does: sign-up confirms the email with a code,
// then signs the user in. Locally no email is sent: getLastAuthCode reads the
// code the local auth block issued.
async function signUpAndSignIn() {
  await authApi.setAuthState({ action: 'signUp', ...creds });
  await authApi.setAuthState({ action: 'confirmSignUp', username: creds.username, code: await getLastAuthCode(creds.username) });
  return await authApi.setAuthState({ action: 'autoSignIn', username: creds.username });
}

// Wait for the Blocks server to be ready without depending on the sample API,
// and record which runtime it reports.
async function waitForServer() {
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
  }

  await waitForServer();

  // Import the client only once the server answers: the dev server regenerates
  // aws-blocks/client.js before it listens, so an earlier import could load a
  // stale client that lacks namespaces exported since the last generation.
  const mod = await import('aws-blocks');
  api = mod.api;
  authApi = mod.authApi;
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
// after you replace the sample methods with your own.
test('app: server serves its Blocks config', async () => {
  const response = await fetch(readinessUrl);
  assert.ok(response.ok, `expected ${readinessUrl} to respond ok`);
});

test('api: public method needs no session', async () => {
  const result = await api.ping();
  assert.strictEqual(result.message, 'pong');
  assert.ok(typeof result.timestamp === 'number');
});

test('Agent - chat rejects a signed-out caller', async () => {
  await authApi.setAuthState({ action: 'signOut' });
  await assert.rejects(api.chat('hello'), { status: 401 });
  await assert.rejects(api.lastNote(), { status: 401 });
});

test('Agent - a chat turn returns the model text', async (t) => {
  if (!isLocalMock) {
    t.skip('needs the local mock: the canned provider only runs in `npm run dev`');
    return;
  }
  const signedUp = await signUpAndSignIn();
  assert.strictEqual(signedUp.state, 'signedIn');

  const { text } = await api.chat('hello there');
  // The canned provider always tags its output; the exact phrasing is an
  // implementation detail, so assert the stable marker, not the full string.
  assert.ok(typeof text === 'string' && text.length > 0, 'expected non-empty text');
  assert.ok(text.includes('[canned]'), `expected a canned response, got: ${text}`);
});

test('Agent - a tool-calling turn runs the tool handler', async (t) => {
  if (!isLocalMock) {
    t.skip('needs the local mock: the canned provider only runs in `npm run dev`');
    return;
  }
  const signedIn = await authApi.setAuthState({ action: 'signIn', ...creds });
  if (signedIn.state !== 'signedIn') await signUpAndSignIn();

  // Mentioning the tool's name (its camelCase words "save"/"note") makes the
  // canned provider emit a toolUse for `saveNote`; Strands runs the handler,
  // which writes the note into the KVStore.
  const { text } = await api.chat('please save a note for me');
  // After a tool call the canned provider summarises with this marker.
  assert.ok(text.includes('[canned tool response]'), `expected a tool summary, got: ${text}`);

  // The side effect is the real proof the tool ran end-to-end over the RPC boundary.
  const note = await api.lastNote();
  assert.ok(typeof note === 'string' && note.length > 0, `expected a saved note, got: ${note}`);
});
