import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { getLastAuthCode, installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import type { api as apiType, authApi as authApiType } from 'aws-blocks';

// npm is npm.cmd on Windows, which spawn won't resolve without a shell.
const isWin = process.platform === 'win32';

installCookieJar();

let server: ChildProcess | null = null;
let api: typeof apiType;
let authApi: typeof authApiType;
// A new user each run: the local auth store persists, so a fixed username
// would already exist when you rerun `npm run test:e2e` against the same server.
const creds = { username: `orders-user-${Date.now()}@example.com`, password: 'TestPass123!' };
// The dev server's port: package.json "blocks.dev.port", which `npm run dev` also uses.
const serverPort: number = JSON.parse(readFileSync('package.json', 'utf-8')).blocks?.dev?.port ?? 3001;
const readinessUrl = `http://localhost:${serverPort}/.blocks-sandbox/config.json`;

// Every line the dev server writes, when this file started it. Logger and
// Metrics write to the server's stdout/stderr, so that is where the test reads
// them. With a dev server you started yourself, those checks are skipped.
const serverOutput: string[] = [];

function collectLines(stream: NodeJS.ReadableStream | null) {
  let partial = '';
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk: string) => {
    const lines = (partial + chunk).split('\n');
    partial = lines.pop() ?? '';
    serverOutput.push(...lines);
  });
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
    collectLines(server.stdout);
    collectLines(server.stderr);
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

// The JSON records in the server's output that match `predicate`. A line may
// carry a prefix before its JSON, so parsing starts at the first `{`.
function jsonRecords(predicate: (record: Record<string, unknown>) => boolean) {
  const found: Record<string, unknown>[] = [];
  for (const line of serverOutput) {
    const start = line.indexOf('{');
    if (start < 0) continue;
    try {
      const record: unknown = JSON.parse(line.slice(start));
      if (record && typeof record === 'object' && predicate(record as Record<string, unknown>)) {
        found.push(record as Record<string, unknown>);
      }
    } catch {
      // Not a JSON line.
    }
  }
  return found;
}

// Output reaches this process through a pipe, so give it a moment to arrive.
async function waitForRecord(predicate: (record: Record<string, unknown>) => boolean) {
  for (let i = 0; i < 25; i++) {
    const [record] = jsonRecords(predicate);
    if (record) return record;
    await setTimeout(200);
  }
  return undefined;
}

// The Tracer mock keeps its traces in .bb-data/<tracer id>/traces.json, under
// the dev server's working directory: this app's directory.
function savedTraces() {
  const root = join(process.cwd(), '.bb-data');
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((dir) => {
    const file = join(root, dir, 'traces.json');
    if (!existsSync(file)) return [];
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Array<{
        traceId: string;
        segment: string;
        annotations: Record<string, unknown>;
      }>;
    } catch {
      return [];
    }
  });
}

// App-level readiness — independent of the sample API, so it keeps passing
// after you replace `placeOrder` with your own methods.
test('app: server serves its Blocks config', async () => {
  const response = await fetch(readinessUrl);
  assert.ok(response.ok, `expected ${readinessUrl} to respond ok`);
});

// Runs against the sample method the template ships with, so a freshly
// scaffolded app is validated end to end. When you replace it, update or delete
// these tests to exercise your own code instead.
let order: Awaited<ReturnType<typeof apiType.placeOrder>>;

test('placeOrder rejects a signed-out caller', async () => {
  await authApi.setAuthState({ action: 'signOut' });
  await assert.rejects(api.placeOrder('coffee'), { status: 401 });
});

test('placeOrder returns an order id and the trace id', async () => {
  // Sign-up confirms the email with a code, as the sign-in UI does. Locally no
  // email is sent: getLastAuthCode reads the code the local auth block issued.
  await authApi.setAuthState({ action: 'signUp', ...creds });
  await authApi.setAuthState({ action: 'confirmSignUp', username: creds.username, code: await getLastAuthCode(creds.username) });
  const signedUp = await authApi.setAuthState({ action: 'autoSignIn', username: creds.username });
  assert.strictEqual(signedUp.state, 'signedIn');
  order = await api.placeOrder('coffee');
  assert.ok(order.orderId, 'orderId should be set');
  assert.ok(order.traceId, 'traceId should be set: the Tracer samples every request by default');
});

test('Tracer: the placeOrder segment is saved with its annotation', async () => {
  const trace = savedTraces().find((t) => t.traceId === order.traceId);
  assert.ok(trace, `no saved trace with traceId ${order.traceId}`);
  assert.strictEqual(trace.segment, 'placeOrder');
  assert.strictEqual(trace.annotations.item, 'coffee');
});

test('Logger: the order is logged as one structured JSON line', async (t) => {
  if (!server) return t.skip('reads the dev server output, so it needs the server this file starts');
  const entry = await waitForRecord((r) => r.orderId === order.orderId && r.message === 'Order placed');
  assert.ok(entry, 'expected an "Order placed" log line for this order');
  assert.strictEqual(entry.level, 'info');
  assert.strictEqual(entry.item, 'coffee');
  assert.strictEqual(entry.logger, 'orders-log');
  assert.ok(!Number.isNaN(Date.parse(String(entry.timestamp))), 'timestamp should be an ISO 8601 string');
});

test('Metrics: OrdersPlaced is written as an EMF record', async (t) => {
  if (!server) return t.skip('reads the dev server output, so it needs the server this file starts');
  const emf = await waitForRecord((r) => r.OrdersPlaced === 1 && typeof r._aws === 'object');
  assert.ok(emf, 'expected an EMF record carrying OrdersPlaced');
  const aws = emf._aws as { CloudWatchMetrics: Array<{ Namespace: string; Metrics: Array<{ Name: string; Unit: string }> }> };
  const [directive] = aws.CloudWatchMetrics;
  assert.strictEqual(directive.Namespace, 'MyApp');
  assert.deepStrictEqual(directive.Metrics.map((m) => [m.Name, m.Unit]), [['OrdersPlaced', 'Count']]);
});

// The Dashboard is a CloudWatch resource, so locally its route explains where
// the local observability data is instead of redirecting.
test('Dashboard: its route answers locally with a cloud-only notice', async () => {
  const response = await fetch(`http://localhost:${serverPort}/aws-blocks/dashboard`, { redirect: 'manual' });
  assert.strictEqual(response.status, 503);
  const body: { message?: string; localObservability?: Record<string, string> } = await response.json();
  assert.match(body.message ?? '', /cloud-only/);
  assert.ok(body.localObservability?.logs, 'expected a pointer to the local logs');
});
