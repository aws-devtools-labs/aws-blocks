// Windows E2E driver: scaffold the `backend` template from a local registry
// (packed off this repo) and run the real user commands — `npm run dev`,
// `npm run sandbox` (+destroy), `npm run deploy` (+destroy). Readiness is keyed
// off product artifacts (config/outputs files), not log strings. Run from the
// repo root after `npm ci`, `npm run build`, and `npm run publish:local`,
// with AWS creds in the env. Fail-fast; always tears down what it deployed.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isWin, killTree, runOrThrow, runSpawn, httpUp, startRegistry } from './_proc.mjs';

import { makeProductionDeployDisposable } from './_scaffold-teardown.mjs';

const ROOT = process.cwd();
const REGISTRY = 'http://localhost:4873/registry/';

if (!existsSync(join(ROOT, 'dist-registry'))) {
  console.error('dist-registry not found — run `npm run publish:local` first.');
  process.exit(1);
}

const children = [];

function shutdown() {
  for (const c of children) killTree(c.pid);
}

/** Run a one-shot command; throw on non-zero exit. */
const run = (cmd, args, opts = {}) => runOrThrow(cmd, args, opts, ROOT);

/** Teardown commands that failed; a failed teardown leaves a stack deployed. */
const teardownFailures = [];

/**
 * Run a teardown command without throwing, so a failed destroy can't mask the
 * phase's own result or skip the next teardown. Failures are recorded and fail
 * the job at the end: a silently ignored destroy leaked one stack per run.
 */
function runTeardown(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}  (teardown, cwd: ${opts.cwd ?? ROOT})`);
  try {
    runSpawn(cmd, args, opts, ROOT, { log: false });
  } catch (e) {
    const failure = `${cmd} ${args.join(' ')}: ${e?.message ?? e}`;
    teardownFailures.push(failure);
    console.error(`  TEARDOWN FAILED (stack may be left deployed): ${failure}`);
  }
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
  await startRegistry({ root: ROOT, registryUrl: REGISTRY, children });
  console.log('Local registry is up.');

  // Scaffold under RUNNER_TEMP (a long path) — os.tmpdir() on Windows runners
  // is the 8.3 short path (C:\Users\RUNNER~1\...), which breaks some tooling.
  const baseTmp = process.env.RUNNER_TEMP || tmpdir();
  const work = mkdtempSync(join(baseTmp, 'bb-win-e2e-'));
  const userNpmrc = join(work, '.npmrc');
  writeFileSync(userNpmrc, `@aws-blocks:registry=${REGISTRY}\n`);
  // This harness is test traffic, not real usage; suppress CLI telemetry so a
  // local run (no CI env var set) is not counted as a real user. See the
  // cross-platform driver templates-e2e.mjs for the full rationale.
  const env = {
    ...process.env,
    NPM_CONFIG_USERCONFIG: userNpmrc,
    npm_config_cache: join(work, '.npm-cache'),
    AWS_BLOCKS_DISABLE_TELEMETRY: '1',
  };

  run('npm', ['install', '@aws-blocks/create-blocks-app@latest'], { cwd: work, env });
  const createBin = join(work, 'node_modules', '.bin', isWin ? 'create-blocks-app.cmd' : 'create-blocks-app');
  // The app name becomes the stack-name prefix (.blocks/config.json stackId).
  // Keep it under `bb-test-`: the CI role can only delete stacks with the test
  // prefixes, so cleanup-stacks.yml can reclaim a stack a failed run leaves.
  const app = join(work, 'bb-test-win');
  // `backend` template is backend-only (no DynamoDB/GSI/Aurora) → fast deploy.
  run(createBin, [app, '--template', 'backend'], { cwd: work, env });

  const inApp = { cwd: app, env };
  // The production preset retains the config access-log bucket on destroy (by
  // design, for customers). Make the production deploy below fully deletable,
  // keeping its other defaults, so this CI stack leaves nothing behind. Done up
  // front so a template change fails the run before anything is deployed.
  makeProductionDeployDisposable(join(app, 'aws-blocks', 'index.cdk.ts'));

  // Phase 1: dev — ready when config.json's bound port answers HTTP.
  {
    const dev = await startUntilReady('npm', ['run', 'dev'], inApp, async () => {
      const origin = devOrigin(app);
      return origin ? await httpUp(origin, { okOnly: false }) : false;
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
    runTeardown('npm', ['run', 'sandbox:destroy'], inApp);
  }

  // Phase 3: production deploy → destroy.
  try {
    run('npm', ['run', 'deploy'], inApp);
    console.log('OK: npm run deploy succeeded');
  } finally {
    runTeardown('npm', ['run', 'destroy'], inApp);
  }

  if (teardownFailures.length > 0) {
    throw new Error(`teardown failed, stack(s) may be left deployed:\n  ${teardownFailures.join('\n  ')}`);
  }
  console.log(`\nOK: scaffolded backend template dev + sandbox + deploy all work on ${process.platform}.`);
}

main()
  .then(() => { shutdown(); process.exit(0); })
  .catch((err) => { console.error(`\nFAIL: ${err?.message ?? err}`); shutdown(); process.exit(1); });
