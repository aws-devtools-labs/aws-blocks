// Windows E2E driver: scaffold the `backend` template from a local registry
// (packed off this repo) and run the real user commands — `npm run dev`,
// `npm run sandbox` (+destroy), `npm run deploy` (+destroy). Readiness is keyed
// off product artifacts (config/outputs files), not log strings. Run from the
// repo root after `npm ci`, `npm run build`, and `npm run publish:dry-run`,
// with AWS creds in the env. Fail-fast; always tears down what it deployed.

import { spawn, spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const isWin = process.platform === 'win32';
const ROOT = process.cwd();
const REGISTRY = 'http://localhost:4873/registry/';

if (!existsSync(join(ROOT, 'dist-registry'))) {
  console.error('dist-registry not found — run `npm run publish:dry-run` first.');
  process.exit(1);
}

const children = [];

function killTree(pid) {
  if (!pid) return;
  try {
    if (isWin) execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

function shutdown() {
  for (const c of children) killTree(c.pid);
}

/** Run a one-shot command; throw on non-zero exit. */
function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}  (cwd: ${opts.cwd ?? ROOT})`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: isWin, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`);
}

/** Run a one-shot command; never throw (best-effort cleanup). */
function runBestEffort(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}  (best-effort, cwd: ${opts.cwd ?? ROOT})`);
  try {
    spawnSync(cmd, args, { stdio: 'inherit', shell: isWin, ...opts });
  } catch (e) {
    console.warn(`  (cleanup ignored: ${e?.message ?? e})`);
  }
}

async function httpUp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.status > 0;
  } catch { return false; }
}

/**
 * Spawn a long-running command and poll `ready()` until it returns true.
 * Readiness is based on product artifacts (config/outputs files, ports), NOT
 * console log strings, so it doesn't break when log wording changes. Rejects if
 * the child exits early or the timeout elapses. Returns the child to kill.
 */
async function startUntilReady(cmd, args, opts, ready, timeoutMs) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const child = spawn(cmd, args, { shell: isWin, detached: !isWin, stdio: 'inherit', ...opts });
  children.push(child);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${cmd} ${args.join(' ')} exited (${child.exitCode}) before becoming ready`);
    if (await ready()) return child;
    await sleep(2000);
  }
  throw new Error(`${cmd} ${args.join(' ')} did not become ready within ${timeoutMs / 1000}s`);
}

/** Origin (scheme://host:port) the dev server bound, read from the config file
 * it writes (`.blocks-sandbox/config.json` -> apiUrl). null until present. */
function devOrigin(appDir) {
  try {
    const cfg = JSON.parse(readFileSync(join(appDir, '.blocks-sandbox', 'config.json'), 'utf-8'));
    return cfg.apiUrl ? new URL(cfg.apiUrl).origin : null;
  } catch { return null; }
}

async function main() {
  // ── Local registry (node.exe + tsx loader — no shim needed) ──────────────
  const registry = spawn(process.execPath, ['--import', 'tsx', 'scripts/publish/serve-local-registry.ts'], {
    cwd: ROOT, stdio: 'inherit', detached: !isWin,
  });
  children.push(registry);
  for (let i = 0; ; i++) {
    if (await httpUp(`${REGISTRY}@aws-blocks/blocks`)) break;
    if (i > 30) throw new Error('Local registry did not start on :4873');
    await sleep(1000);
  }
  console.log('Local registry is up.');

  // Scaffold under RUNNER_TEMP (a long path) — os.tmpdir() on Windows runners
  // is the 8.3 short path (C:\Users\RUNNER~1\...), which breaks some tooling.
  const baseTmp = process.env.RUNNER_TEMP || tmpdir();
  const work = mkdtempSync(join(baseTmp, 'bb-win-e2e-'));
  const userNpmrc = join(work, '.npmrc');
  writeFileSync(userNpmrc, `@aws-blocks:registry=${REGISTRY}\n`);
  const env = { ...process.env, NPM_CONFIG_USERCONFIG: userNpmrc, npm_config_cache: join(work, '.npm-cache') };

  run('npm', ['install', '@aws-blocks/create-blocks-app@latest'], { cwd: work, env });
  const createBin = join(work, 'node_modules', '.bin', isWin ? 'create-blocks-app.cmd' : 'create-blocks-app');
  const app = join(work, 'my-app');
  // `backend` template is backend-only (no DynamoDB/GSI/Aurora) → fast deploy.
  run(createBin, [app, '--template', 'backend'], { cwd: work, env });

  const inApp = { cwd: app, env };

  // Phase 1: dev — ready when config.json's bound port answers HTTP.
  {
    const dev = await startUntilReady('npm', ['run', 'dev'], inApp, async () => {
      const origin = devOrigin(app);
      return origin ? await httpUp(origin) : false;
    }, 3 * 60_000);
    killTree(dev.pid);
    console.log('OK: npm run dev booted and is reachable');
  }

  // Phase 2: sandbox — ready when CDK writes the outputs file (before watch).
  const sandboxOutputs = join(app, '.blocks-sandbox', 'outputs.json');
  rmSync(sandboxOutputs, { force: true });
  try {
    const sb = await startUntilReady('npm', ['run', 'sandbox'], inApp, () => existsSync(sandboxOutputs), 30 * 60_000);
    killTree(sb.pid);
    console.log('OK: npm run sandbox deployed');
  } finally {
    runBestEffort('npm', ['run', 'sandbox:destroy'], inApp);
  }

  // Phase 3: production deploy → destroy.
  try {
    run('npm', ['run', 'deploy'], inApp);
    console.log('OK: npm run deploy succeeded');
  } finally {
    runBestEffort('npm', ['run', 'destroy'], inApp);
  }

  console.log(`\nOK: scaffolded backend template dev + sandbox + deploy all work on ${process.platform}.`);
}

main()
  .then(() => { shutdown(); process.exit(0); })
  .catch((err) => { console.error(`\nFAIL: ${err?.message ?? err}`); shutdown(); process.exit(1); });
