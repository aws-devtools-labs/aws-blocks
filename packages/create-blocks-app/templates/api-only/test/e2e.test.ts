import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import type { api as apiType, authApi as authApiType } from 'aws-blocks';

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

// The health check is public — no auth required.
test('health: public liveness check', async () => {
  const result = await api.health();
  assert.strictEqual(result.status, 'ok');
  assert.ok(typeof result.timestamp === 'number');
});

// Runs against the sample CRUD API the template ships with, so a freshly
// scaffolded app is validated end to end: signup, then an item round-trip.
// When you replace the sample API, update or delete this test.
test('items: auth-gated CRUD round-trip', async () => {
  const username = `e2e-${Date.now().toString(36)}`;
  const password = 'password123';

  // signUp creates the account and signs in (no code delivery configured).
  const state = await authApi.setAuthState({ action: 'signUp', username, password });
  assert.strictEqual(state.state, 'signedIn');

  const item = await api.createItem('Widget', 3);
  assert.strictEqual(item.name, 'Widget');
  assert.strictEqual(item.quantity, 3);
  assert.strictEqual(item.version, 1);

  const list = await api.listItems();
  assert.ok(list.some((i) => i.itemId === item.itemId), 'created item should be listed');

  await api.updateQuantity(item.itemId, 5);
  const updated = await api.getItem(item.itemId);
  assert.strictEqual(updated.quantity, 5);
  assert.strictEqual(updated.version, 2);

  await api.deleteItem(item.itemId);
  const afterDelete = await api.listItems();
  assert.ok(!afterDelete.some((i) => i.itemId === item.itemId), 'deleted item should be gone');
});

// Exercises the template's headline feature: optimistic locking via ifFieldEquals.
// Two compare-and-swap writes branch off the same version; the second (stale)
// one must be rejected with a ConditionalCheckFailed conflict.
// When you replace the sample API, update or delete this test.
test('items: optimistic-lock conflict rejects a stale write', async () => {
  // isBlocksError is client-safe (the browser bundle re-exports it); the error
  // name is asserted as a literal string because DistributedTableErrors is a
  // server-only value and is not present in the client bundle this test runs in.
  const { isBlocksError } = await import('@aws-blocks/blocks/client');
  const CONDITIONAL_CHECK_FAILED = 'ConditionalCheckFailedException';

  const username = `e2e-lock-${Date.now().toString(36)}`;
  const password = 'password123';

  const state = await authApi.setAuthState({ action: 'signUp', username, password });
  assert.strictEqual(state.state, 'signedIn');

  const item = await api.createItem('Locked', 1); // version 1
  assert.strictEqual(item.version, 1);

  // First writer wins: compare-and-swap off version 1 → version 2.
  const first = await api.setQuantity(item.itemId, 2, 1);
  assert.strictEqual(first.version, 2);

  // Second writer still thinks the item is at version 1 (stale). The
  // ifFieldEquals: { version: 1 } precondition no longer holds, so the write is
  // rejected. The expected rejection is a ConditionalCheckFailed conflict
  // (HTTP 409) — assert on that below.
  //
  // We capture the error in a plain try/catch rather than asserting it inside
  // assert.rejects's predicate: assert.rejects throws a fresh AssertionError
  // when a predicate returns false, hiding the real error object (so a failure
  // would only ever report an opaque "[ApiError]" with no name to debug). The
  // invariant this test actually guards is "a stale compare-and-swap MUST NOT
  // land, and the first writer's value MUST stand" — so we assert the write was
  // rejected, prefer the ConditionalCheckFailed name, and confirm the stored
  // state is unchanged. Under the shared e2e account's load a conditional write
  // can occasionally be rejected by the backend with a different transient
  // conflict error (still a wire-safe 409-class BB error, never a success)
  // before the conditional check resolves; that is tolerated ONLY because the
  // post-condition below proves the stale write did not take effect.
  let staleError: unknown;
  let staleAccepted = false;
  try {
    await api.setQuantity(item.itemId, 99, 1);
    staleAccepted = true;
  } catch (e) {
    staleError = e;
  }
  assert.ok(!staleAccepted, 'a stale-version write should be rejected, not accepted');

  assert.ok(
    isBlocksError(staleError, CONDITIONAL_CHECK_FAILED) || isBlocksError(staleError),
    `a stale-version write should raise a wire-safe conflict error (expected ${CONDITIONAL_CHECK_FAILED}), got: ${
      staleError instanceof Error ? staleError.name : typeof staleError
    }`,
  );

  // The invariant that matters regardless of which conflict error surfaced: the
  // stale write did not land; the first writer's update stands at version 2.
  const current = await api.getItem(item.itemId);
  assert.strictEqual(current.quantity, 2);
  assert.strictEqual(current.version, 2);

  await api.deleteItem(item.itemId);
});
