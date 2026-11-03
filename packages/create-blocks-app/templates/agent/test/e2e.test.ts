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
import { setTimeout } from 'node:timers/promises';
import { installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import type { api as ApiType, authApi as AuthApiType } from 'aws-blocks';

// npm is npm.cmd on Windows, which spawn won't resolve without a shell.
const isWin = process.platform === 'win32';

installCookieJar();

let server: ChildProcess | null = null;
let api: typeof ApiType;
let authApi: typeof AuthApiType;

const serverPort = 3000;
const readinessUrl = `http://localhost:${serverPort}/.blocks-sandbox/config.json`;

// The canned-provider assertions below only hold in the local mock runtime; a
// deployed sandbox runs a real Bedrock model whose text is non-deterministic.
// The readiness config.json carries which one we hit.
let isLocalMock = false;

const creds = { username: 'agent-user@example.com', password: 'TestPass123!' };

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
  authApi = mod.authApi;

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
  // signUp is idempotent across reruns only if the account is fresh; fall back
  // to signIn so a second local run against the same .bb-data still authenticates.
  const signedUp = await authApi.setAuthState({ action: 'signUp', ...creds }).catch(() => null);
  if (signedUp?.state !== 'signedIn') {
    await authApi.setAuthState({ action: 'signIn', ...creds });
  }

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
  await authApi.setAuthState({ action: 'signIn', ...creds }).catch(async () => {
    await authApi.setAuthState({ action: 'signUp', ...creds });
  });

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
