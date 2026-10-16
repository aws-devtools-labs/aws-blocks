import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import type { api as apiType, hello as helloType } from 'aws-blocks';

// npm is npm.cmd on Windows, which spawn won't resolve without a shell.
const isWin = process.platform === 'win32';

installCookieJar();

let server: ChildProcess | null = null;
let api: typeof apiType;
let hello: typeof helloType;
const serverPort = 3000;
const readinessUrl = `http://localhost:${serverPort}/.blocks-sandbox/config.json`;

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

// ─── Secret ─────────────────────────────────────────────────────────────────
// A credential backed by Secrets Manager (local file in dev). Unlike AppSetting
// it keeps version history: after a rotation the previous value stays readable
// for a grace window. We set, rotate, then assert current + previous + that two
// versions are labeled.
test('Secret - rotate keeps the previous value readable', async () => {
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
  assert.strictEqual(results[0].source, 'billing.md', 'top hit should be the billing doc');
  assert.ok(results[0].score > 0, 'top hit should have a positive relevance score');
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
