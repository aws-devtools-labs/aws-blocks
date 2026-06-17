// Windows "local dev" boot smoke (no AWS).
//
// Starts the comprehensive app's dev server (`npm run dev:server` ->
// `tsx aws-blocks/scripts/server.ts` -> startDevServer) and verifies it comes
// up and serves on http://localhost:3000, then tears the process tree down.
// No behavioral assertions — local dev runs the same OS-independent JS as the
// cloud; this only confirms the dev tooling boots on Windows.
//
// Run from the repo root: `node scripts/ci/windows-dev-smoke.mjs`.

import { spawn, execSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const isWin = process.platform === 'win32';
const APP_DIR = join(process.cwd(), 'test-apps', 'comprehensive');
const URL = 'http://localhost:3000/';
const MAX_WAIT_MS = 90_000;

function killTree(pid) {
  if (!pid) return;
  try {
    if (isWin) execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

async function serverIsUp() {
  try {
    // Any HTTP response (even 404 for `/` with no frontend) means the dev
    // server is listening.
    const res = await fetch(URL, { signal: AbortSignal.timeout(2000) });
    return res.status > 0;
  } catch {
    return false;
  }
}

const dev = spawn('npm', ['run', 'dev:server'], {
  cwd: APP_DIR,
  shell: isWin,
  detached: !isWin,
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: '' },
});

let failed = false;
try {
  const deadline = Date.now() + MAX_WAIT_MS;
  let up = false;
  while (Date.now() < deadline) {
    if (await serverIsUp()) {
      up = true;
      break;
    }
    if (dev.exitCode !== null) {
      throw new Error(`dev server exited early with code ${dev.exitCode}`);
    }
    await sleep(2000);
  }
  if (!up) throw new Error(`dev server did not serve ${URL} within ${MAX_WAIT_MS / 1000}s`);
  console.log(`\nOK: local dev server booted and served ${URL} on ${process.platform}.`);
} catch (err) {
  failed = true;
  console.error(`\nFAIL: ${err?.message ?? err}`);
} finally {
  killTree(dev.pid);
}

process.exit(failed ? 1 : 0);
