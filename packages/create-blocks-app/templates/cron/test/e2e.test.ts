import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import type { api as apiType } from 'aws-blocks';

// npm is npm.cmd on Windows, which spawn won't resolve without a shell.
const isWin = process.platform === 'win32';

installCookieJar();

let server: ChildProcess | null = null;
let api: typeof apiType;
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
// after you replace `lastRun` with your own methods.
test('app: server serves its Blocks config', async () => {
  const response = await fetch(readinessUrl);
  assert.ok(response.ok, `expected ${readinessUrl} to respond ok`);
});

// Runs against the sample jobs the template ships with, so a freshly scaffolded
// app is validated end to end. When you replace them, update or delete these
// tests to exercise your own jobs instead.
//
// `heartbeat` runs every minute (the shortest schedule), so this waits for its
// first run rather than triggering it: the test proves the schedule itself fires.
test('heartbeat fires on its schedule and records the run', { timeout: 120_000 }, async () => {
  let run = await api.lastRun('heartbeat');
  for (let i = 0; i < 30 && !run; i++) {
    await setTimeout(3000);
    run = await api.lastRun('heartbeat');
  }
  assert.ok(run, 'heartbeat should have fired within 90 seconds');
  assert.ok(run.jobName.endsWith('heartbeat'), `unexpected jobName: ${run.jobName}`);
  assert.ok(!Number.isNaN(Date.parse(run.scheduledTime)), 'scheduledTime should be an ISO 8601 timestamp');
  assert.ok(run.count >= 1);
});

// `paused` has the same schedule but `enabled: false`. Checked after heartbeat
// has fired, so an enabled job would have run by now.
test('a disabled job never fires', async () => {
  assert.strictEqual(await api.lastRun('paused'), null);
});
