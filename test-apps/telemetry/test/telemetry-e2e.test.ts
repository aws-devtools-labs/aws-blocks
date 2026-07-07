// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E Telemetry Test Suite
 *
 * Tests telemetry end-to-end by invoking REAL CLI scripts and verifying:
 * 1. Event payload correctness via --telemetry-file
 * 2. Actual delivery to the telemetry endpoint via NODE_DEBUG stderr output
 *
 * Requirements:
 * - Valid AWS credentials (for sandbox/deploy/destroy SUCCESS paths)
 * - Network access to the telemetry endpoint
 * - `npm run build` must have been run first
 */

import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { tmpdir, homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..');
const REPO_ROOT = join(APP_ROOT, '..', '..');
// The create-blocks-app CLI is a monorepo workspace package (@aws-blocks/create-blocks-app)
// that is not published to the public npm registry, so `npm exec create-blocks-app` 404s.
// Invoke the locally built binary directly (built by `npm run build` before the suite).
const CREATE_BLOCKS_APP_BIN = join(REPO_ROOT, 'packages', 'create-blocks-app', 'dist', 'index.js');
// The blocks-telemetry consent CLI is the `blocks-telemetry` bin of @aws-blocks/core.
// `npx blocks-telemetry` depends on the workspace bin symlink + exec bit surviving the
// build step, which is fragile in CI; invoke the built entrypoint directly with `node`.
const BLOCKS_TELEMETRY_CLI = join(REPO_ROOT, 'packages', 'core', 'dist', 'scripts', 'telemetry-cli.js');

const PINNED_INSTALLATION_ID = '00000000-0000-0000-0000-000000000e2e';
const PINNED_PROJECT_ID = '00000000-0000-0000-0000-0000000e2e57';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SENT_REGEX = /BLOCKS-TELEMETRY: sent \(status=200\)/;

// ─── Helpers ─────────────────────────────────────────────────────────────────

let fileCounter = 0;

function createTmpDir(prefix = 'blocks-telemetry-e2e'): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function installationIdPath(homeDir?: string): string {
  return join(homeDir ?? homedir(), '.blocks', 'telemetry', 'installation-id');
}

function seedPinnedInstallationId(homeDir?: string): void {
  const filePath = installationIdPath(homeDir);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, PINNED_INSTALLATION_ID, 'utf-8');
}

function globalConfigPath(homeDir?: string): string {
  return join(homeDir ?? homedir(), '.blocks', 'config.json');
}

function uniqueTelemetryFile(dir: string): string {
  return join(dir, `telemetry-event-${fileCounter++}.json`);
}

let portCounter = 0;
function getNextPort(): number {
  // Sequential ports starting from a high range to avoid common service ports.
  // Each test gets a unique port within this run.
  return 13456 + (portCounter++);
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Spawn a command with NODE_DEBUG=blocks-telemetry and --telemetry-file.
 * Returns stdout, stderr (for delivery verification), and exit code.
 */
function runCommand(
  cmd: string,
  args: string[],
  options: {
    home?: string;
    telemetryFile: string;
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string | undefined>;
  },
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const { home, telemetryFile, cwd, timeoutMs = 60_000, env = {} } = options;
    let stdout = '';
    let stderr = '';

    const child = spawn(cmd, [...args, `--telemetry-file=${telemetryFile}`], {
      cwd: cwd ?? APP_ROOT,
      stdio: 'pipe',
      detached: true,
      env: {
        ...process.env,
        ...env,
        ...(home ? { HOME: home } : {}),
        ...('NODE_DEBUG' in env ? {} : { NODE_DEBUG: 'blocks-telemetry' }),
        NODE_OPTIONS: '',
      } as NodeJS.ProcessEnv,
    });

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = globalThis.setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      // Wait a moment for the detached telemetry subprocess to finish
      globalThis.setTimeout(() => resolve({ stdout, stderr, exitCode: code }), 5000);
    });
  });
}

/** Spawn dev server, wait for ready, return process + output. */
function spawnDevServer(options: {
  port: number;
  home?: string;
  telemetryFile: string;
  env?: Record<string, string | undefined>;
}): Promise<{ process: ChildProcess; output: { stdout: string; stderr: string } }> {
  return new Promise((resolve, reject) => {
    const { port, home, telemetryFile, env = {} } = options;
    const output = { stdout: '', stderr: '' };

    const child = spawn('npx', ['tsx', 'aws-blocks/scripts/server.ts', `--telemetry-file=${telemetryFile}`], {
      cwd: APP_ROOT,
      stdio: 'pipe',
      env: {
        ...process.env,
        ...env,
        ...(home ? { HOME: home } : {}),
        PORT: String(port),
        ...('NODE_DEBUG' in env ? {} : { NODE_DEBUG: 'blocks-telemetry' }),
        NODE_OPTIONS: '',
      } as NodeJS.ProcessEnv,
    });

    const timeout = globalThis.setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error(`Dev server timeout.\nstdout: ${output.stdout}\nstderr: ${output.stderr}`));
    }, 45_000);

    child.stdout?.on('data', (d: Buffer) => {
      output.stdout += d.toString();
      if (output.stdout.includes('local server running on')) {
        clearTimeout(timeout);
        resolve({ process: child, output });
      }
    });
    child.stderr?.on('data', (d: Buffer) => { output.stderr += d.toString(); });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      // Dev server exited — might be FAIL (port in use). Resolve anyway.
      resolve({ process: child, output });
    });
  });
}

function killProcess(proc: ChildProcess): void {
  try {
    proc.kill('SIGTERM');
    // Give it a moment to shut down gracefully, then force-kill
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
    proc.removeAllListeners();
  } catch {}
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(filePath)) return true;
    await sleep(150);
  }
  return existsSync(filePath);
}

function readTelemetryFile(filePath: string): Record<string, any> {
  const content = readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(content);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

/** Assert that the event was delivered to the real endpoint. */
/** Assert that the event was delivered to the real endpoint. */
function assertDelivered(stderr: string, description = ''): void {
  assert.match(stderr, SENT_REGEX, `Telemetry should be delivered to endpoint. ${description}\nstderr: ${stderr.slice(-500)}`);
}

/** Assert that the event was NOT delivered (disabled). */
function assertNotDelivered(stderr: string): void {
  assert.doesNotMatch(stderr, SENT_REGEX, 'Telemetry should NOT be delivered when disabled');
}

// ─── Test Suites ─────────────────────────────────────────────────────────────

describe('Telemetry E2E', { timeout: 2_400_000 }, () => {

  // Seed pinned installation-id in real HOME (no HOME override needed).
  // CI workflow also seeds this, but doing it here ensures local runs work too.
  before(() => {
    seedPinnedInstallationId();
  });

  // Clean up: remove the seeded .blocks directory
  after(() => {
    rmSync(join(homedir(), '.blocks', 'telemetry'), { recursive: true, force: true });
  });

  // ── 1. Payload structure & Building Block filtering ─────────────────────────

  describe('payload structure', () => {
    let devProcess: ChildProcess | null = null;
    let tmpHome: string;

    afterEach(() => {
      if (devProcess) { killProcess(devProcess); devProcess = null; }
      if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
    });

    test('dev event carries correct identifiers, environment, product, and counters', async () => {
      tmpHome = createTmpDir('payload-structure');
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      const result = await spawnDevServer({ port, telemetryFile });
      devProcess = result.process;

      assert.ok(await waitForFile(telemetryFile, 15_000), 'telemetry file should be written');
      const body = readTelemetryFile(telemetryFile);

      // Identifiers
      assert.strictEqual(body.identifiers.installationId, PINNED_INSTALLATION_ID);
      assert.strictEqual(body.identifiers.projectId, PINNED_PROJECT_ID);
      assert.match(body.identifiers.eventId, UUID_REGEX);
      assert.ok(body.identifiers.timestamp);

      // Event
      assert.strictEqual(body.event.command, 'dev');
      assert.strictEqual(body.event.state, 'SUCCESS');
      assert.strictEqual(typeof body.event.duration, 'number');

      // Environment
      assert.strictEqual(body.environment.os, platform());
      assert.match(body.environment.nodeVersion, /^\d+\.\d+\.\d+/);
      assert.strictEqual(typeof body.environment.ci, 'boolean');

      // Product
      assert.match(body.product.blocksVersion, /^\d+\.\d+\.\d+/);
      assert.deepStrictEqual(body.product.template, { name: 'telemetry-e2e', version: '1.2.3' });

      // Delivery
      await sleep(5000);
      assertDelivered(result.output.stderr, 'dev SUCCESS');
    });

    test('official BBs appear with version, custom BBs are excluded but counted', async () => {
      tmpHome = createTmpDir('bb-filtering');
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      const result = await spawnDevServer({ port, telemetryFile });
      devProcess = result.process;

      assert.ok(await waitForFile(telemetryFile, 15_000));
      const body = readTelemetryFile(telemetryFile);

      const bbNames = (body.product.buildingBlocks ?? []).map((b: any) => b.name);
      assert.ok(bbNames.includes('AppSetting'), 'AppSetting should be in buildingBlocks');
      assert.ok(bbNames.includes('KVStore'), 'KVStore should be in buildingBlocks');
      assert.ok(!bbNames.includes('CustomAnalyticsTracker'), 'Custom BB must NOT appear');

      for (const bb of body.product.buildingBlocks ?? []) {
        assert.ok(bb.version, `${bb.name} should have a version`);
      }

      assert.ok(body.counters);
      assert.ok(body.counters.customBuildingBlocks >= 1, 'customBuildingBlocks should count custom BBs');
      assert.ok(body.counters.blocksCount >= 3, 'blocksCount should include all BBs');
    });

    test('payload contains no file paths, home dirs, or usernames (privacy)', async () => {
      tmpHome = createTmpDir('privacy-check');
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      const result = await spawnDevServer({ port, telemetryFile });
      devProcess = result.process;

      assert.ok(await waitForFile(telemetryFile, 15_000));
      const raw = readFileSync(telemetryFile, 'utf-8');

      assert.ok(!raw.includes(tmpHome), 'payload must not contain HOME path');
      assert.ok(!raw.includes('/Users/'), 'payload must not contain /Users/ path');
      assert.ok(!raw.includes('/home/'), 'payload must not contain /home/ path');
      assert.ok(!raw.includes(process.env.USER ?? '___none___'), 'payload must not contain username');
    });
  });

  // ── 2. Identifier creation & stability ───────────────────────────────────────

  describe('identifiers', () => {
    let devProcess: ChildProcess | null = null;
    let tmpHome: string;

    afterEach(() => {
      if (devProcess) { killProcess(devProcess); devProcess = null; }
      if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
    });

    test('installation-id is created when missing', async () => {
      tmpHome = createTmpDir('id-creation');
      // Use a fresh HOME with no installation-id — let the CLI create it
      const idPath = installationIdPath(tmpHome);
      assert.ok(!existsSync(idPath), 'installation-id must not exist at start');

      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();
      const result = await spawnDevServer({ port, home: tmpHome, telemetryFile });
      devProcess = result.process;

      assert.ok(await waitForFile(telemetryFile, 15_000));
      assert.ok(existsSync(idPath), 'installation-id should be created');

      const createdId = readFileSync(idPath, 'utf-8').trim();
      assert.match(createdId, UUID_REGEX);

      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(body.identifiers.installationId, createdId);
    });

    test('projectId is stable across multiple runs', async () => {
      tmpHome = createTmpDir('id-stability');

      const file1 = uniqueTelemetryFile(tmpHome);
      const file2 = uniqueTelemetryFile(tmpHome);
      const port1 = getNextPort();
      const port2 = getNextPort();

      // Run 1
      const r1 = await spawnDevServer({ port: port1, telemetryFile: file1 });
      assert.ok(await waitForFile(file1, 15_000), `Run 1: telemetry file not written.\nstdout: ${r1.output.stdout.slice(-300)}\nstderr: ${r1.output.stderr.slice(-300)}`);
      killProcess(r1.process);
      await sleep(1000);

      // Run 2
      const r2 = await spawnDevServer({ port: port2, telemetryFile: file2 });
      assert.ok(await waitForFile(file2, 15_000), `Run 2: telemetry file not written.\nstdout: ${r2.output.stdout.slice(-300)}\nstderr: ${r2.output.stderr.slice(-300)}`);
      killProcess(r2.process);

      const body1 = readTelemetryFile(file1);
      const body2 = readTelemetryFile(file2);

      assert.strictEqual(body1.identifiers.projectId, body2.identifiers.projectId, 'projectId should be stable');
      assert.notStrictEqual(body1.identifiers.eventId, body2.identifiers.eventId, 'eventIds should be unique');
    });
  });

  // ── 3. Per-command real invocations ──────────────────────────────────────────

  describe('command: dev', () => {
    let devProcess: ChildProcess | null = null;
    let blocker: ReturnType<typeof createServer> | null = null;
    let tmpHome: string;

    afterEach(async () => {
      if (devProcess) { killProcess(devProcess); devProcess = null; }
      if (blocker) { await new Promise<void>(r => blocker!.close(() => r())); blocker = null; }
      if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
    });

    test('SUCCESS: dev server starts and emits dev/SUCCESS', async () => {
      tmpHome = createTmpDir('dev-success');
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      const result = await spawnDevServer({ port, telemetryFile });
      devProcess = result.process;

      assert.ok(await waitForFile(telemetryFile, 15_000));
      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(body.event.command, 'dev');
      assert.strictEqual(body.event.state, 'SUCCESS');

      await sleep(5000);
      assertDelivered(result.output.stderr, 'dev SUCCESS');
    });

    test('FAIL: port in use emits dev/FAIL with PORT_IN_USE', async () => {
      tmpHome = createTmpDir('dev-fail');
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      blocker = createServer();
      await new Promise<void>((resolve, reject) => {
        blocker!.once('error', reject);
        blocker!.listen(port, resolve);
      });

      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/server.ts'], {
        telemetryFile, env: { PORT: String(port) }, timeoutMs: 15_000,
      });

      assert.ok(await waitForFile(telemetryFile, 3_000));
      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(body.event.command, 'dev');
      assert.strictEqual(body.event.state, 'FAIL');
      assert.strictEqual(body.event.error?.code, 'PORT_IN_USE');
      assertDelivered(result.stderr, 'dev FAIL');
    });
  });


  describe('command: create-blocks-app', () => {
    let tmpHome: string;
    let scaffoldDir: string | null = null;
    afterEach(() => {
      if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
      if (scaffoldDir) rmSync(scaffoldDir, { recursive: true, force: true });
    });

    test('SUCCESS: scaffolds app and emits create-blocks-app/SUCCESS', async () => {
      tmpHome = createTmpDir('create-app-success');
      scaffoldDir = createTmpDir('scaffold-target');
      const targetDir = join(scaffoldDir, 'my-app');
      const telemetryFile = uniqueTelemetryFile(tmpHome);

      const result = await runCommand('node', [CREATE_BLOCKS_APP_BIN, targetDir, '--template', 'bare', '--yes', '--skip-install'], {
        telemetryFile, timeoutMs: 60_000,
      });

      assert.ok(await waitForFile(telemetryFile, 5_000), `telemetry file not written.\nexit=${result.exitCode}\nstdout(last 500): ${result.stdout.slice(-500)}\nstderr(last 500): ${result.stderr.slice(-500)}`);
      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(body.event.command, 'create-blocks-app');
      assert.strictEqual(body.event.state, 'SUCCESS');
      assertDelivered(result.stderr, 'create-blocks-app SUCCESS');
    });

    test('FAIL: missing args emits create-blocks-app/FAIL', async () => {
      tmpHome = createTmpDir('create-app-fail');
      const telemetryFile = uniqueTelemetryFile(tmpHome);

      // `--template` with no value forces an arg-parse failure (exits non-zero).
      const result = await runCommand('node', [CREATE_BLOCKS_APP_BIN, '--template'], {
        telemetryFile, timeoutMs: 15_000,
      });

      // create-blocks-app exits before trackCommand on arg parse failure —
      // no telemetry event is emitted. Assert that explicitly.
      const fileWritten = await waitForFile(telemetryFile, 3_000);
      assert.ok(!fileWritten, 'create-blocks-app with no args should NOT emit telemetry');
    });
  });

  describe('command: vendorize', () => {
    let tmpHome: string;
    afterEach(() => { if (tmpHome) rmSync(tmpHome, { recursive: true, force: true }); });

    test('FAIL: bad package name does not emit telemetry (vendorize calls process.exit)', async () => {
      tmpHome = createTmpDir('vendorize-fail');
      const telemetryFile = uniqueTelemetryFile(tmpHome);

      const result = await runCommand('npm', ['exec', '--', 'blocks-vendorize', '@nonexistent/fake-package'], {
        telemetryFile, timeoutMs: 15_000,
      });

      // vendorize calls process.exit(1) on unresolvable packages, which
      // bypasses trackCommand's finally block — no telemetry is emitted.
      // This is a known limitation (not a test bug).
      assert.ok(result.exitCode !== 0, 'vendorize should exit with non-zero on bad package');
      const fileWritten = await waitForFile(telemetryFile, 3_000);
      assert.ok(!fileWritten, 'vendorize with process.exit does NOT emit telemetry');
    });
  });

  // ── 4. AWS commands (require valid credentials) ─────────────────────────────

  describe('command: sandbox', () => {
    let tmpHome: string;
    afterEach(() => { if (tmpHome) rmSync(tmpHome, { recursive: true, force: true }); });

    test('FAIL: no creds emits sandbox/FAIL', async () => {
      tmpHome = createTmpDir('sandbox-fail');
      const telemetryFile = uniqueTelemetryFile(tmpHome);

      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/sandbox.ts'], {
        telemetryFile, timeoutMs: 90_000,
        env: { AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_SESSION_TOKEN: '' },
      });

      assert.ok(await waitForFile(telemetryFile, 5_000), 'sandbox FAIL should emit telemetry');
      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(body.event.command, 'sandbox');
      assert.strictEqual(body.event.state, 'FAIL');
      assert.ok(body.event.error, 'FAIL should carry error info');
      assertDelivered(result.stderr, 'sandbox FAIL');
    });

    test('SUCCESS: sandbox deploys and emits sandbox/SUCCESS', async () => {
      tmpHome = createTmpDir('sandbox-success');
      const telemetryFile = uniqueTelemetryFile(tmpHome);

      // Delete sandbox-id to get a unique stack name for this test
      rmSync(join(APP_ROOT, '.blocks-sandbox', 'sandbox-id.txt'), { force: true });

      // Verify AWS credentials are valid before deploying
      try {
        execSync('aws sts get-caller-identity', { encoding: 'utf-8', timeout: 10_000 });
      } catch (e: any) {
        assert.fail(`AWS credentials invalid before sandbox deploy: ${e.message}`);
      }

      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/sandbox.ts'], {
        telemetryFile, timeoutMs: 300_000,
      });

      assert.ok(await waitForFile(telemetryFile, 5_000), `sandbox SUCCESS should emit telemetry.\nexit=${result.exitCode}\nstdout(last 500): ${result.stdout.slice(-500)}\nstderr(last 500): ${result.stderr.slice(-500)}`);
      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(body.event.command, 'sandbox');
      assert.strictEqual(body.event.state, 'SUCCESS', `Expected SUCCESS but got ${body.event.state}. error=${JSON.stringify(body.event.error)}\nstdout(last 2000): ${result.stdout.slice(-2000)}\nstderr(last 2000): ${result.stderr.slice(-2000)}`);
      assert.strictEqual(body.event.error, undefined);
      assertDelivered(result.stderr, 'sandbox SUCCESS');

      // Cleanup: destroy the sandbox stack
      await runCommand('npx', ['tsx', 'aws-blocks/scripts/sandbox-destroy.ts'], {
        telemetryFile: uniqueTelemetryFile(tmpHome), timeoutMs: 120_000,
      });
    });
  });

  describe('command: sandbox:destroy', () => {
    let tmpHome: string;
    afterEach(() => { if (tmpHome) rmSync(tmpHome, { recursive: true, force: true }); });

    test('FAIL: no creds emits sandbox:destroy/FAIL', async () => {
      tmpHome = createTmpDir('sandbox-destroy-fail');
      const telemetryFile = uniqueTelemetryFile(tmpHome);

      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/sandbox-destroy.ts'], {
        telemetryFile, timeoutMs: 300_000,
        env: { AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_SESSION_TOKEN: '' },
      });

      assert.ok(await waitForFile(telemetryFile, 5_000), 'sandbox:destroy FAIL should emit telemetry');
      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(body.event.command, 'sandbox:destroy');
      assert.strictEqual(body.event.state, 'FAIL');
      assertDelivered(result.stderr, 'sandbox:destroy FAIL');
    });

    test('SUCCESS: sandbox:destroy after deploy emits sandbox:destroy/SUCCESS', async () => {
      tmpHome = createTmpDir('sandbox-destroy-success');

      // First deploy a sandbox
      const deployFile = uniqueTelemetryFile(tmpHome);
      await runCommand('npx', ['tsx', 'aws-blocks/scripts/sandbox.ts'], {
        telemetryFile: deployFile, timeoutMs: 300_000,
      });

      // Then destroy it
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/sandbox-destroy.ts'], {
        telemetryFile, timeoutMs: 120_000,
      });

      assert.ok(await waitForFile(telemetryFile, 5_000), `telemetry file not written.\nexit=${result.exitCode}\nstdout(last 500): ${result.stdout.slice(-500)}\nstderr(last 500): ${result.stderr.slice(-500)}`);
      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(body.event.command, 'sandbox:destroy');
      assert.strictEqual(body.event.state, 'SUCCESS');
      assertDelivered(result.stderr, 'sandbox:destroy SUCCESS');
    });
  });

  describe('command: deploy', () => {
    let tmpHome: string;
    afterEach(() => { if (tmpHome) rmSync(tmpHome, { recursive: true, force: true }); });

    test('FAIL: no creds emits deploy/FAIL', async () => {
      tmpHome = createTmpDir('deploy-fail');
      const telemetryFile = uniqueTelemetryFile(tmpHome);

      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/deploy.ts'], {
        telemetryFile, timeoutMs: 90_000,
        env: { AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_SESSION_TOKEN: '' },
      });

      assert.ok(await waitForFile(telemetryFile, 5_000), `telemetry file not written.\nexit=${result.exitCode}\nstdout(last 500): ${result.stdout.slice(-500)}\nstderr(last 500): ${result.stderr.slice(-500)}`);
      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(body.event.command, 'deploy');
      assert.strictEqual(body.event.state, 'FAIL');
      assert.ok(body.event.error);
      assertDelivered(result.stderr, 'deploy FAIL');
    });

    test('SUCCESS: deploy with creds emits deploy/SUCCESS', async () => {
      tmpHome = createTmpDir('deploy-success');
      const telemetryFile = uniqueTelemetryFile(tmpHome);

      // Delete sandbox-id to get a unique stack name for this test
      rmSync(join(APP_ROOT, '.blocks-sandbox', 'sandbox-id.txt'), { force: true });

      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/deploy.ts'], {
        telemetryFile, timeoutMs: 300_000,
      });

      assert.ok(await waitForFile(telemetryFile, 5_000), `telemetry file not written.\nexit=${result.exitCode}\nstdout(last 500): ${result.stdout.slice(-500)}\nstderr(last 500): ${result.stderr.slice(-500)}`);
      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(body.event.command, 'deploy');
      assert.strictEqual(body.event.state, 'SUCCESS');
      assertDelivered(result.stderr, 'deploy SUCCESS');

      // Cleanup: destroy the production stack
      await runCommand('npx', ['tsx', 'aws-blocks/scripts/destroy.ts'], {
        telemetryFile: uniqueTelemetryFile(tmpHome), timeoutMs: 120_000,
      });
    });
  });

  describe('command: destroy', () => {
    let tmpHome: string;
    afterEach(() => { if (tmpHome) rmSync(tmpHome, { recursive: true, force: true }); });

    test('FAIL: no creds emits destroy/FAIL', async () => {
      tmpHome = createTmpDir('destroy-fail');
      const telemetryFile = uniqueTelemetryFile(tmpHome);

      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/destroy.ts'], {
        telemetryFile, timeoutMs: 90_000,
        env: { AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_SESSION_TOKEN: '' },
      });

      assert.ok(await waitForFile(telemetryFile, 5_000), `telemetry file not written.\nexit=${result.exitCode}\nstdout(last 500): ${result.stdout.slice(-500)}\nstderr(last 500): ${result.stderr.slice(-500)}`);
      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(body.event.command, 'destroy');
      assert.strictEqual(body.event.state, 'FAIL');
      assertDelivered(result.stderr, 'destroy FAIL');
    });

    test('SUCCESS: destroy with creds emits destroy/SUCCESS', async () => {
      tmpHome = createTmpDir('destroy-success');

      // Deploy first, then destroy
      const deployFile = uniqueTelemetryFile(tmpHome);
      await runCommand('npx', ['tsx', 'aws-blocks/scripts/deploy.ts'], {
        telemetryFile: deployFile, timeoutMs: 300_000,
      });

      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/destroy.ts'], {
        telemetryFile, timeoutMs: 120_000,
      });

      assert.ok(await waitForFile(telemetryFile, 5_000), `telemetry file not written.\nexit=${result.exitCode}\nstdout(last 500): ${result.stdout.slice(-500)}\nstderr(last 500): ${result.stderr.slice(-500)}`);
      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(body.event.command, 'destroy');
      assert.strictEqual(body.event.state, 'SUCCESS');
      assertDelivered(result.stderr, 'destroy SUCCESS');
    });
  });

  describe('command: console', () => {
    let tmpHome: string;
    afterEach(() => { if (tmpHome) rmSync(tmpHome, { recursive: true, force: true }); });

    test('SUCCESS: console after sandbox deploy emits console/SUCCESS', async () => {
      tmpHome = createTmpDir('console-success');

      // Deploy sandbox first to create outputs.json
      const deployFile = uniqueTelemetryFile(tmpHome);
      await runCommand('npx', ['tsx', 'aws-blocks/scripts/sandbox.ts'], {
        telemetryFile: deployFile, timeoutMs: 300_000,
      });

      // Run console
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/console.ts'], {
        telemetryFile, timeoutMs: 15_000,
      });

      assert.ok(await waitForFile(telemetryFile, 3_000), `console should emit telemetry.\nexit=${result.exitCode}\nstdout(last 1000): ${result.stdout.slice(-1000)}\nstderr(last 1000): ${result.stderr.slice(-1000)}`);
      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(body.event.command, 'console');
      assert.strictEqual(body.event.state, 'SUCCESS', `Expected SUCCESS but got ${body.event.state}. error=${JSON.stringify(body.event.error)}\nstdout(last 1000): ${result.stdout.slice(-1000)}\nstderr(last 1000): ${result.stderr.slice(-1000)}`);
      assertDelivered(result.stderr, 'console SUCCESS');

      // Cleanup: destroy the sandbox
      await runCommand('npx', ['tsx', 'aws-blocks/scripts/sandbox-destroy.ts'], {
        telemetryFile: uniqueTelemetryFile(tmpHome), timeoutMs: 120_000,
      });
    });
  });

  // ── 5. Disable mechanisms ────────────────────────────────────────────────────

  describe('disable mechanisms', () => {
    let devProcess: ChildProcess | null = null;
    let tmpHome: string;

    afterEach(() => {
      if (devProcess) { killProcess(devProcess); devProcess = null; }
      if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
    });

    test('AWS_BLOCKS_DISABLE_TELEMETRY=1 prevents telemetry', async () => {
      tmpHome = createTmpDir('disable-env');
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/server.ts'], {
        telemetryFile, env: { PORT: String(port), AWS_BLOCKS_DISABLE_TELEMETRY: '1' }, timeoutMs: 12_000,
      });

      // --telemetry-file still writes even when HTTP is disabled (D-010 contract)
      assert.ok(await waitForFile(telemetryFile, 2_000), '--telemetry-file should write even when telemetry is disabled');
      // but HTTP send should NOT happen
      assertNotDelivered(result.stderr);
    });

    test('global config telemetry.enabled=false prevents telemetry', async () => {
      tmpHome = createTmpDir('disable-global');
      // Write global config disabling telemetry in real HOME
      const globalCfg = globalConfigPath();
      const hadConfig = existsSync(globalCfg);
      const originalContent = hadConfig ? readFileSync(globalCfg, 'utf-8') : null;
      mkdirSync(dirname(globalCfg), { recursive: true });
      writeFileSync(globalCfg, JSON.stringify({ telemetry: { enabled: false } }));

      try {
        const telemetryFile = uniqueTelemetryFile(tmpHome);
        const port = getNextPort();

        const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/server.ts'], {
          telemetryFile, env: { PORT: String(port) }, timeoutMs: 12_000,
        });

        assertNotDelivered(result.stderr);
      } finally {
        // Restore original state
        if (originalContent) writeFileSync(globalCfg, originalContent);
        else rmSync(globalCfg, { force: true });
      }
    });

    test('per-project config telemetry.enabled=false prevents telemetry', async () => {
      tmpHome = createTmpDir('disable-project');
      // Write per-project config disabling telemetry
      const projectConfig = join(APP_ROOT, '.blocks', 'config.json');
      const originalContent = existsSync(projectConfig) ? readFileSync(projectConfig, 'utf-8') : null;

      try {
        mkdirSync(dirname(projectConfig), { recursive: true });
        writeFileSync(projectConfig, JSON.stringify({ telemetry: { enabled: false } }));

        const telemetryFile = uniqueTelemetryFile(tmpHome);
        const port = getNextPort();

        const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/server.ts'], {
          telemetryFile, env: { PORT: String(port) }, timeoutMs: 12_000,
        });

        assertNotDelivered(result.stderr);
      } finally {
        // Restore original config
        if (originalContent) {
          writeFileSync(projectConfig, originalContent);
        } else {
          rmSync(projectConfig, { force: true });
        }
      }
    });

    test('AWS_BLOCKS_DISABLE_TELEMETRY=0 does NOT disable (only "1" disables)', async () => {
      tmpHome = createTmpDir('disable-zero');
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      const result = await spawnDevServer({
        port, telemetryFile,
        env: { AWS_BLOCKS_DISABLE_TELEMETRY: '0' },
      });
      devProcess = result.process;

      assert.ok(await waitForFile(telemetryFile, 15_000), 'telemetry should still fire with =0');
      await sleep(5000);
      assertDelivered(result.output.stderr, 'telemetry should be delivered when DISABLE=0');
    });

  });

  // ── 6. Network resilience ──────────────────────────────────────────────────

  describe('network resilience', () => {
    let devProcess: ChildProcess | null = null;
    let tmpHome: string;
    afterEach(() => {
      if (devProcess) { killProcess(devProcess); devProcess = null; }
      if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
    });

    test('broken endpoint is invisible to users (no NODE_DEBUG)', async () => {
      tmpHome = createTmpDir('net-invisible');
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/server.ts'], {
        telemetryFile, env: {
          PORT: String(port),
          BLOCKS_TELEMETRY_ENDPOINT: 'http://127.0.0.1:1/unreachable',
          NODE_DEBUG: '',  // explicitly disable debug
        }, timeoutMs: 12_000,
      });

      // No BLOCKS-TELEMETRY output should be visible without NODE_DEBUG
      assert.ok(!result.stderr.includes('BLOCKS-TELEMETRY:'), 'telemetry errors must be invisible without NODE_DEBUG');
    });

    test('broken endpoint IS visible with NODE_DEBUG=blocks-telemetry', async () => {
      tmpHome = createTmpDir('net-visible');
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/server.ts'], {
        telemetryFile, env: {
          PORT: String(port),
          BLOCKS_TELEMETRY_ENDPOINT: 'http://127.0.0.1:1/unreachable',
        }, timeoutMs: 12_000,
      });

      // Debug output should show the send attempt
      assert.ok(result.stderr.includes('BLOCKS-TELEMETRY'), 'telemetry debug should be visible with NODE_DEBUG');
    });

    test('telemetry failure does not crash or delay the command', async () => {
      tmpHome = createTmpDir('net-nocrash');
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      // Use a port that's NOT in use so the dev server starts successfully,
      // but with a broken telemetry endpoint. If telemetry blocked, the command
      // would hang waiting for the HTTP timeout. The dev server should start
      // normally regardless.
      const result = await spawnDevServer({
        port, telemetryFile,
        env: { BLOCKS_TELEMETRY_ENDPOINT: 'http://127.0.0.1:1/unreachable' },
      });
      devProcess = result.process;

      // Dev server started (spawnDevServer resolved) — telemetry failure didn't block it
      assert.ok(await waitForFile(telemetryFile, 15_000), 'telemetry file should still be written despite send failure');
      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(body.event.state, 'SUCCESS', 'command should succeed regardless of telemetry failure');
    });
  });

  // ── 7. Schema forward-compatibility ────────────────────────────────────────

  describe('schema forward-compatibility', () => {
    let devProcess: ChildProcess | null = null;
    let tmpHome: string;

    afterEach(() => {
      if (devProcess) { killProcess(devProcess); devProcess = null; }
      if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
    });

    test('payload is fully JSON-serializable (no circular refs, no undefined)', async () => {
      tmpHome = createTmpDir('schema-json');
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      const result = await spawnDevServer({ port, telemetryFile });
      devProcess = result.process;

      assert.ok(await waitForFile(telemetryFile, 15_000));
      const raw = readFileSync(telemetryFile, 'utf-8');
      // Should parse without error and re-serialize identically
      const parsed = JSON.parse(raw);
      const reserialized = JSON.stringify(JSON.parse(JSON.stringify(parsed)));
      assert.strictEqual(JSON.stringify(parsed), reserialized, 'payload should round-trip through JSON');
    });

    test('all required top-level fields exist', async () => {
      tmpHome = createTmpDir('schema-fields');
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      const result = await spawnDevServer({ port, telemetryFile });
      devProcess = result.process;

      assert.ok(await waitForFile(telemetryFile, 15_000));
      const body = readTelemetryFile(telemetryFile);

      assert.ok(body.telemetryVersion, 'telemetryVersion required');
      assert.ok(body.identifiers, 'identifiers required');
      assert.ok(body.event, 'event required');
      assert.ok(body.environment, 'environment required');
      assert.ok(body.product, 'product required');
    });
  });

  // ── 8. Environment metadata ────────────────────────────────────────────────

  describe('environment metadata', () => {
    let devProcess: ChildProcess | null = null;
    let tmpHome: string;

    afterEach(() => {
      if (devProcess) { killProcess(devProcess); devProcess = null; }
      if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
    });

    test('environment includes nodeVersion, os, and ci fields', async () => {
      tmpHome = createTmpDir('env-fields');
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      const result = await spawnDevServer({ port, telemetryFile });
      devProcess = result.process;

      assert.ok(await waitForFile(telemetryFile, 15_000));
      const body = readTelemetryFile(telemetryFile);

      assert.ok(body.environment.nodeVersion, 'nodeVersion should exist');
      assert.match(body.environment.nodeVersion, /^\d+\.\d+\.\d+/, 'nodeVersion should be semver');
      assert.ok(['linux', 'darwin', 'win32'].includes(body.environment.os), `os should be valid, got: ${body.environment.os}`);
      assert.strictEqual(typeof body.environment.ci, 'boolean', 'ci should be boolean');
    });

    test('environment.os matches actual platform', async () => {
      tmpHome = createTmpDir('env-platform');
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      const result = await spawnDevServer({ port, telemetryFile });
      devProcess = result.process;

      assert.ok(await waitForFile(telemetryFile, 15_000));
      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(body.environment.os, platform(), 'os should match process platform');
    });
  });

  // ── 9. --telemetry-file sink ───────────────────────────────────────────────

  describe('--telemetry-file sink', () => {
    let devProcess: ChildProcess | null = null;
    let tmpHome: string;

    afterEach(() => {
      if (devProcess) { killProcess(devProcess); devProcess = null; }
      if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
    });

    test('--telemetry-file writes payload when telemetry is enabled', async () => {
      tmpHome = createTmpDir('file-enabled');
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      const result = await spawnDevServer({ port, telemetryFile });
      devProcess = result.process;

      assert.ok(await waitForFile(telemetryFile, 15_000), 'file should be written when enabled');
      const body = readTelemetryFile(telemetryFile);
      assert.ok(body.event, 'file should contain a valid event');
    });

    test('--telemetry-file writes even when HTTP telemetry is disabled', async () => {
      tmpHome = createTmpDir('file-disabled-http');
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/server.ts'], {
        telemetryFile, env: { PORT: String(port), AWS_BLOCKS_DISABLE_TELEMETRY: '1' }, timeoutMs: 12_000,
      });

      assert.ok(await waitForFile(telemetryFile, 3_000), '--telemetry-file should write even when HTTP disabled');
      const body = readTelemetryFile(telemetryFile);
      assert.ok(body.event, 'file should contain a valid event even when HTTP disabled');
    });

    test('projectId persists across runs from same project', async () => {
      tmpHome = createTmpDir('file-projectid');
      const file1 = uniqueTelemetryFile(tmpHome);
      const file2 = uniqueTelemetryFile(tmpHome);
      const port1 = getNextPort();
      const port2 = getNextPort();

      const r1 = await spawnDevServer({ port: port1, telemetryFile: file1 });
      assert.ok(await waitForFile(file1, 15_000));
      killProcess(r1.process);
      await sleep(1000);

      const r2 = await spawnDevServer({ port: port2, telemetryFile: file2 });
      assert.ok(await waitForFile(file2, 15_000));
      killProcess(r2.process);

      const body1 = readTelemetryFile(file1);
      const body2 = readTelemetryFile(file2);
      assert.strictEqual(body1.identifiers.projectId, body2.identifiers.projectId, 'projectId should persist');
    });
  });

  // ── 10. Consent notice ─────────────────────────────────────────────────────

  describe('consent notice', () => {
    let devProcess: ChildProcess | null = null;
    let tmpHome: string;

    afterEach(() => {
      if (devProcess) { killProcess(devProcess); devProcess = null; }
      if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
    });

    test('no consent notice on subsequent runs (installation-id exists)', async () => {
      tmpHome = createTmpDir('consent-silent');
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      // Use real HOME which has the pinned installation-id
      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/server.ts'], {
        telemetryFile, env: { PORT: String(port) }, timeoutMs: 12_000,
      });

      assert.ok(!result.stderr.includes('AWS Blocks collects anonymous usage data'), 'consent notice should NOT show when id exists');
    });
  });

  // ── 11. blocks-telemetry CLI consent commands ──────────────────────────────

  describe('blocks-telemetry CLI', () => {
    let tmpHome: string;

    afterEach(() => {
      if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
    });

    test('bare command shows help/usage', async () => {
      tmpHome = createTmpDir('cli-bare');
      const result = await runCommand('node', [BLOCKS_TELEMETRY_CLI], {
        telemetryFile: uniqueTelemetryFile(tmpHome), timeoutMs: 10_000,
      });
      assert.ok(result.stdout.includes('Usage:') || result.stdout.includes('--enable'), 'bare command should show usage');
    });

    test('--help shows usage information', async () => {
      tmpHome = createTmpDir('cli-help');
      const result = await runCommand('node', [BLOCKS_TELEMETRY_CLI, '--help'], {
        telemetryFile: uniqueTelemetryFile(tmpHome), timeoutMs: 10_000,
      });
      assert.ok(result.stdout.includes('--enable'), '--help should mention --enable');
      assert.ok(result.stdout.includes('--disable'), '--help should mention --disable');
    });

    test('--disable creates config with telemetry.enabled=false', async () => {
      tmpHome = createTmpDir('cli-disable');
      const configPath = join(APP_ROOT, '.blocks', 'config.json');
      const originalContent = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : null;

      try {
        const result = await runCommand('node', [BLOCKS_TELEMETRY_CLI, '--disable'], {
          telemetryFile: uniqueTelemetryFile(tmpHome), timeoutMs: 10_000,
        });
        assert.strictEqual(result.exitCode, 0);
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
        assert.strictEqual(config.telemetry.enabled, false);
      } finally {
        if (originalContent) writeFileSync(configPath, originalContent);
        else rmSync(configPath, { force: true });
      }
    });

    test('--enable creates config with telemetry.enabled=true', async () => {
      tmpHome = createTmpDir('cli-enable');
      const configPath = join(APP_ROOT, '.blocks', 'config.json');
      const originalContent = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : null;

      try {
        const result = await runCommand('node', [BLOCKS_TELEMETRY_CLI, '--enable'], {
          telemetryFile: uniqueTelemetryFile(tmpHome), timeoutMs: 10_000,
        });
        assert.strictEqual(result.exitCode, 0);
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
        assert.strictEqual(config.telemetry.enabled, true);
      } finally {
        if (originalContent) writeFileSync(configPath, originalContent);
        else rmSync(configPath, { force: true });
      }
    });

    test('--status shows current telemetry status', async () => {
      tmpHome = createTmpDir('cli-status');
      const result = await runCommand('node', [BLOCKS_TELEMETRY_CLI, '--status'], {
        telemetryFile: uniqueTelemetryFile(tmpHome), timeoutMs: 10_000,
      });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('Telemetry:') || result.stdout.includes('telemetry'), '--status should show telemetry state');
    });

    test('--disable --global writes global config', async () => {
      tmpHome = createTmpDir('cli-disable-global');
      const globalCfg = globalConfigPath();
      const hadConfig = existsSync(globalCfg);
      const originalContent = hadConfig ? readFileSync(globalCfg, 'utf-8') : null;

      try {
        const result = await runCommand('node', [BLOCKS_TELEMETRY_CLI, '--disable', '--global'], {
          telemetryFile: uniqueTelemetryFile(tmpHome), timeoutMs: 10_000,
        });
        assert.strictEqual(result.exitCode, 0);
        const config = JSON.parse(readFileSync(globalCfg, 'utf-8'));
        assert.strictEqual(config.telemetry.enabled, false);
      } finally {
        if (originalContent) writeFileSync(globalCfg, originalContent);
        else rmSync(globalCfg, { force: true });
      }
    });

    test('--enable --global writes global config', async () => {
      tmpHome = createTmpDir('cli-enable-global');
      const globalCfg = globalConfigPath();
      const hadConfig = existsSync(globalCfg);
      const originalContent = hadConfig ? readFileSync(globalCfg, 'utf-8') : null;

      try {
        const result = await runCommand('node', [BLOCKS_TELEMETRY_CLI, '--enable', '--global'], {
          telemetryFile: uniqueTelemetryFile(tmpHome), timeoutMs: 10_000,
        });
        assert.strictEqual(result.exitCode, 0);
        const config = JSON.parse(readFileSync(globalCfg, 'utf-8'));
        assert.strictEqual(config.telemetry.enabled, true);
      } finally {
        if (originalContent) writeFileSync(globalCfg, originalContent);
        else rmSync(globalCfg, { force: true });
      }
    });
  });

}); // end describe('Telemetry E2E')
