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
const serverPort = 3000;
const origin = `http://localhost:${serverPort}`;
const readinessUrl = `${origin}/.blocks-sandbox/config.json`;

// The AuthOIDC tests below drive the in-process stub IdP, which only exists in
// the local mock runtime; against a running sandbox the server on :3000 proxies
// to the deployed Lambda where there is no stub provider. The readiness
// config.json carries which one we hit.
let isLocalMock = false;

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
// after you replace `ping`/`setValue`/`getValue` with your own methods.
test('app: server serves its Blocks config', async () => {
  const response = await fetch(readinessUrl);
  assert.ok(response.ok, `expected ${readinessUrl} to respond ok`);
});

test('api: public method needs no session', async () => {
  const result = await api.ping();
  assert.strictEqual(result.message, 'pong');
  assert.ok(typeof result.timestamp === 'number');
});

test('AuthOIDC - requireAuth rejects a signed-out caller', async () => {
  await authApi.setAuthState({ action: 'signOut' });
  await assert.rejects(api.whoAmI(), { status: 401 });
  await assert.rejects(api.getValue('k'), { status: 401 });
});

// Drive the server-initiated OIDC sign-in over `fetch` with the cookie jar,
// following each 302 by hand (signin → stub authorize → callback → "/") so the
// jar carries the pending-auth and session cookies across the hops.
async function signInThroughStub(provider: string): Promise<void> {
  let url: string | null = `${origin}/aws-blocks/auth/signin/${provider}`;
  // A bounded hop count: signin → authorize → callback → postSignInPath is 3
  // redirects; cap well above that so a redirect loop fails loudly, not hangs.
  for (let hop = 0; hop < 8 && url; hop++) {
    const res: Response = await fetch(url, { redirect: 'manual' });
    if (res.status === 302 || res.status === 303) {
      const location = res.headers.get('location');
      assert.ok(location, `redirect at hop ${hop} carried no Location`);
      // Resolve relative Locations (the callback 302s to the bare path "/").
      url = new URL(location, origin).toString();
      // The final hop lands on postSignInPath ("/") — the app shell, not an
      // auth route. Stop there: the session cookie is now set.
      if (new URL(url).pathname === '/') return;
      continue;
    }
    // Any non-redirect on an auth hop is a sign-in failure (the route emits a
    // JSON error body with a 4xx), so surface it.
    const body = await res.text();
    throw new Error(`sign-in hop ${hop} returned ${res.status}: ${body.slice(0, 200)}`);
  }
  throw new Error('sign-in did not land on postSignInPath within the hop budget');
}

test('AuthOIDC - stub sign-in authorises a requireAuth call', async (t) => {
  if (!isLocalMock) {
    t.skip('needs the local mock: the stub IdP only exists in `npm run dev`');
    return;
  }

  await authApi.setAuthState({ action: 'signOut' });
  const before = await authApi.getAuthState();
  assert.strictEqual(before.state, 'signedOut');

  await signInThroughStub('demo');

  // The session cookie now authorises a requireAuth-gated call, and whoAmI
  // reports the stub user the backend's onAuthorize approved.
  const me = await api.whoAmI();
  assert.strictEqual(me.email, 'alice@stub.invalid');
  assert.strictEqual(me.name, 'Alice Example');
  assert.strictEqual(me.provider, 'demo');
  assert.ok(typeof me.userId === 'string' && me.userId.length > 0);

  const after = await authApi.getAuthState();
  assert.strictEqual(after.state, 'signedIn');
});

test('KV Store - set and get (signed in, keys namespaced per user)', async (t) => {
  if (!isLocalMock) {
    t.skip('needs the local mock: the stub IdP only exists in `npm run dev`');
    return;
  }
  await authApi.setAuthState({ action: 'signOut' });
  await signInThroughStub('demo');

  const setResult = await api.setValue('test-key', 'test-value');
  assert.strictEqual(setResult.success, true);
  assert.strictEqual(await api.getValue('test-key'), 'test-value');

  // Signing out drops the session, so the key is no longer reachable.
  await authApi.setAuthState({ action: 'signOut' });
  await assert.rejects(api.getValue('test-key'), { status: 401 });
});
