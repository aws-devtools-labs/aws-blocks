// ⚠️ TEMPORARY — delete together with .github/workflows/windows-deploy-check.yml
// once issue #19 is verified/merged.
//
// Cross-platform driver that exercises the real developer loop for a scaffolded
// template, with no AWS: serve the local registry (built by `publish:dry-run`),
// scaffold the `default` template exactly as a customer would, then
// `npm run build` and smoke `npm run dev`. Verifies that a Windows user can
// actually build and run a Blocks app end to end.
//
// Assumes `npm ci`, `npm run build:packages`, and `npm run publish:dry-run`
// have already run (so dist-registry exists). Exits non-zero on any failure.

import { spawn, spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = process.cwd();
const isWin = process.platform === 'win32';
const REGISTRY = 'http://localhost:4873/registry/';
const SERVER_URL = 'http://localhost:3000/';

if (!existsSync(join(ROOT, 'dist-registry'))) {
  console.error('dist-registry not found — run `npm run publish:dry-run` first.');
  process.exit(1);
}

const children = [];

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}  (cwd: ${opts.cwd ?? ROOT})`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: isWin, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`);
}

async function httpOk(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.status > 0;
  } catch {
    return false;
  }
}

async function waitFor(url, label, attempts) {
  for (let i = 0; i < attempts; i++) {
    if (await httpOk(url)) return true;
    await sleep(1000);
  }
  return false;
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (isWin) execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

async function main() {
  // 1. Serve the local registry (node.exe + tsx loader — no shim needed).
  const registry = spawn(process.execPath, ['--import', 'tsx', 'scripts/publish/serve-local-registry.ts'], {
    cwd: ROOT,
    stdio: 'inherit',
    detached: !isWin,
  });
  children.push(registry);

  if (!(await waitFor(`${REGISTRY}@aws-blocks/blocks`, 'registry', 30))) {
    throw new Error('Local registry did not start on :4873');
  }
  console.log('Local registry is up.');

  // 2. Isolated npm config pointing the @aws-blocks scope at the local registry.
  const work = mkdtempSync(join(tmpdir(), 'blocks-win-smoke-'));
  const userNpmrc = join(work, '.npmrc');
  writeFileSync(userNpmrc, `@aws-blocks:registry=${REGISTRY}\n`);
  const env = {
    ...process.env,
    NPM_CONFIG_USERCONFIG: userNpmrc,
    npm_config_cache: join(work, '.npm-cache'),
  };

  // 3. Install the CLI from the local registry and scaffold the default template.
  run('npm', ['install', '@aws-blocks/create-blocks-app@latest'], { cwd: work, env });
  const createBin = join(work, 'node_modules', '.bin', isWin ? 'create-blocks-app.cmd' : 'create-blocks-app');
  const appDir = join(work, 'my-app');
  run(createBin, [appDir], { cwd: work, env });

  // 4. The real developer loop: build the app.
  run('npm', ['run', 'build'], { cwd: appDir, env });

  // 5. Smoke `npm run dev`: start it, wait for the Blocks server, then tear down.
  console.log('\n$ npm run dev  (background smoke)');
  const dev = spawn('npm', ['run', 'dev'], {
    cwd: appDir,
    env,
    shell: isWin,
    detached: !isWin,
    stdio: 'inherit',
  });
  children.push(dev);

  const up = await waitFor(SERVER_URL, 'dev server', 120);
  killTree(dev.pid);
  if (!up) throw new Error(`npm run dev did not serve ${SERVER_URL} within 120s`);

  console.log(`\nOK: scaffold + npm run build + npm run dev all work on ${process.platform}.`);
}

main()
  .then(() => { for (const c of children) killTree(c.pid); process.exit(0); })
  .catch((err) => {
    console.error('\nFAIL:', err?.message ?? err);
    for (const c of children) killTree(c.pid);
    process.exit(1);
  });
