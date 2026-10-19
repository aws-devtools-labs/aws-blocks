import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import type { api as apiType, authApi as authApiType, hello as helloType } from 'aws-blocks';

// npm is npm.cmd on Windows, which spawn won't resolve without a shell.
const isWin = process.platform === 'win32';

installCookieJar();

let server: ChildProcess | null = null;
let api: typeof apiType;
let authApi: typeof authApiType;
let hello: typeof helloType;
const serverPort = 3000;
const readinessUrl = `http://localhost:${serverPort}/.blocks-sandbox/config.json`;

// The AuthCognito tests below drive getLastCode(), which only works against the
// local mock runtime; against a running sandbox the server on :3000 proxies to
// the deployed Lambda, where getLastCode() returns null and a real Cognito user
// would be created per run. The readiness config.json carries which one we hit.
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
  hello = mod.hello;

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

// AuthCognito (passwordless USER_AUTH + EMAIL_OTP) — exercised entirely on
// the local mock runtime, no AWS. The OTP that Cognito would email in a
// deployed stack is captured by the backend's `codeDelivery` hook and read
// back through the mock-only `getLastCode()` API (gated off in Sandbox/Prod
// by the BLOCKS_STACK_NAME env check), so the whole flow is driveable here.
// The installed cookie jar carries the autoSignIn bridging session + the
// signed-in session cookie across calls, exactly like the browser.
//
// Like greet/KV above, these run against the sample API the template ships
// with. When you replace the sample API, update or delete these tests to
// exercise your own methods instead — they depend on the sample `whoAmI` and
// `getLastCode` methods.

// Unique email per sign-up so the mock user pool starts clean each time.
const uniqueEmail = () => `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.example`;

// signUp -> read OTP -> confirm -> autoSignIn, asserting every step (and that
// the captured code belongs to this email) so a failure points at its real
// cause instead of surfacing lines later. Returns the signed-in state.
async function signUpAndAutoSignIn(email: string) {
  const r1 = await authApi.setAuthState({ action: 'signUp', username: email, password: 'Password1!' });
  assert.strictEqual(r1.state, 'confirmingSignUp', `signUp: ${r1.error ?? ''}`);

  const code = await api.getLastCode();
  assert.ok(code, 'codeDelivery should fire on sign-up');
  assert.strictEqual(code!.username, email, 'captured code should belong to this email');
  assert.strictEqual(code!.purpose, 'signUp');

  const r2 = await authApi.setAuthState({ action: 'confirmSignUp', username: email, code: code!.code });
  assert.strictEqual(r2.actions?.[0]?.name, 'autoSignIn', `confirmSignUp: ${r2.error ?? ''}`);

  const r3 = await authApi.setAuthState({ action: 'autoSignIn', username: email });
  assert.strictEqual(r3.state, 'signedIn', `autoSignIn: expected signedIn, got ${r3.state} (${r3.error ?? ''})`);
  return r3;
}

test('AuthCognito - signUp -> confirm code -> autoSignIn -> authenticated', async (t) => {
  if (!isLocalMock) {
    t.skip('needs the local mock: getLastCode() is null against a deployed backend');
    return;
  }
  const email = uniqueEmail();

  // Signed out, with signUp offered (selfSignUp: true).
  const start = await authApi.getAuthState();
  assert.strictEqual(start.state, 'signedOut');
  assert.ok(
    start.actions?.some((a) => a.name === 'signUp'),
    'signUp action should be offered when selfSignUp is enabled',
  );

  // signUp -> confirm -> autoSignIn, with every step asserted.
  const r3 = await signUpAndAutoSignIn(email);
  assert.strictEqual(r3.user!.username, email);

  // The signed-in session cookie now authorises a requireAuth-gated call.
  const me = await api.whoAmI();
  assert.strictEqual(me.username, email);
  assert.ok(typeof me.userSub === 'string' && me.userSub.length > 0);
});

test('AuthCognito - returning user signs in via EMAIL_OTP (no password)', async (t) => {
  if (!isLocalMock) {
    t.skip('needs the local mock: getLastCode() is null against a deployed backend');
    return;
  }
  const email = uniqueEmail();

  // Provision the user, then sign out so we start from a known signed-out state
  // rather than inheriting the previous flow's session through the cookie jar.
  await signUpAndAutoSignIn(email);
  await authApi.setAuthState({ action: 'signOut' });
  const signedOut = await authApi.getAuthState();
  assert.strictEqual(signedOut.state, 'signedOut');

  // Sign in with email only — preferredChallenge is EMAIL_OTP, so no password.
  const r1 = await authApi.setAuthState({ action: 'signIn', username: email, password: '' });
  assert.strictEqual(r1.state, 'confirmingSignIn', `expected confirmingSignIn, got ${r1.state} (${r1.error ?? ''})`);
  const action = r1.actions?.[0];
  assert.ok(action, 'a confirmSignIn action should be offered');
  const sessionField = action.fields.find((f) => f.name === 'session');
  assert.ok(sessionField, 'session hidden field should be present');
  const session = sessionField.defaultValue;
  assert.ok(typeof session === 'string' && session.length > 0, 'session field should carry a value');

  // The first-factor EMAIL_OTP rides the MFA delivery channel (purpose: 'mfa').
  const otp = await api.getLastCode();
  assert.ok(otp, 'codeDelivery should fire for the EMAIL_OTP first factor');
  assert.strictEqual(otp!.username, email, 'captured code should belong to this email');
  assert.strictEqual(otp!.purpose, 'mfa');

  // Submit the OTP -> signed in.
  const r2 = await authApi.setAuthState({
    action: 'confirmSignIn',
    challenge: 'code',
    session,
    code: otp!.code,
  });
  assert.strictEqual(r2.state, 'signedIn', `expected signedIn, got ${r2.state} (${r2.error ?? ''})`);
  assert.strictEqual(r2.user!.username, email);

  // The OTP-issued session cookie authorises a requireAuth-gated call too.
  const me = await api.whoAmI();
  assert.strictEqual(me.username, email);
});
