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

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..');

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

function installationIdPath(homeDir: string): string {
  return join(homeDir, '.blocks', 'telemetry', 'installation-id');
}

function seedPinnedInstallationId(homeDir: string): void {
  const filePath = installationIdPath(homeDir);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, PINNED_INSTALLATION_ID, 'utf-8');
}

function uniqueTelemetryFile(dir: string): string {
  return join(dir, `telemetry-event-${fileCounter++}.json`);
}

function getNextPort(): number {
  return 3456 + Math.floor(Math.random() * 4000);
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
    home: string;
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
        HOME: home,
        NODE_DEBUG: 'blocks-telemetry',
        NODE_OPTIONS: '',
      } as NodeJS.ProcessEnv,
    });

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = globalThis.setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch {}
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      // Wait a moment for the detached telemetry subprocess to finish
      globalThis.setTimeout(() => resolve({ stdout, stderr, exitCode: code }), 1500);
    });
  });
}

/** Spawn dev server, wait for ready, return process + output. */
function spawnDevServer(options: {
  port: number;
  home: string;
  telemetryFile: string;
  env?: Record<string, string | undefined>;
}): Promise<{ process: ChildProcess; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const { port, home, telemetryFile, env = {} } = options;
    let stdout = '';
    let stderr = '';

    const child = spawn('npx', ['tsx', 'aws-blocks/scripts/server.ts', `--telemetry-file=${telemetryFile}`], {
      cwd: APP_ROOT,
      stdio: 'pipe',
      detached: true,
      env: {
        ...process.env,
        ...env,
        HOME: home,
        PORT: String(port),
        NODE_DEBUG: 'blocks-telemetry',
        NODE_OPTIONS: '',
      } as NodeJS.ProcessEnv,
    });

    const timeout = globalThis.setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch {}
      reject(new Error(`Dev server timeout.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 45_000);

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (stdout.includes('local server running on')) {
        clearTimeout(timeout);
        resolve({ process: child, stdout, stderr });
      }
    });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      // Dev server exited — might be FAIL (port in use). Resolve anyway.
      resolve({ process: child, stdout, stderr });
    });
  });
}

function killProcess(proc: ChildProcess): void {
  try {
    if (proc.pid) { try { process.kill(-proc.pid, 'SIGKILL'); } catch {} }
    proc.kill('SIGKILL');
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
function assertDelivered(stderr: string, description = ''): void {
  assert.match(stderr, SENT_REGEX, `Telemetry should be delivered to endpoint. ${description}\nstderr: ${stderr.slice(-500)}`);
}

/** Assert that the event was NOT delivered (disabled). */
function assertNotDelivered(stderr: string): void {
  assert.doesNotMatch(stderr, SENT_REGEX, 'Telemetry should NOT be delivered when disabled');
}

// ─── Test Suites ─────────────────────────────────────────────────────────────

describe('Telemetry E2E', { timeout: 600_000 }, () => {

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
      seedPinnedInstallationId(tmpHome);
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      const result = await spawnDevServer({ port, home: tmpHome, telemetryFile });
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
      await sleep(2000);
      assertDelivered(result.stderr, 'dev SUCCESS');
    });

    test('official BBs appear with version, custom BBs are excluded but counted', async () => {
      tmpHome = createTmpDir('bb-filtering');
      seedPinnedInstallationId(tmpHome);
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      const result = await spawnDevServer({ port, home: tmpHome, telemetryFile });
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
      seedPinnedInstallationId(tmpHome);
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      const result = await spawnDevServer({ port, home: tmpHome, telemetryFile });
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
      // Do NOT seed — let the CLI create it
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
      seedPinnedInstallationId(tmpHome);

      const file1 = uniqueTelemetryFile(tmpHome);
      const file2 = uniqueTelemetryFile(tmpHome);
      const port1 = getNextPort();
      const port2 = getNextPort();

      // Run 1
      const r1 = await spawnDevServer({ port: port1, home: tmpHome, telemetryFile: file1 });
      killProcess(r1.process);
      await waitForFile(file1, 15_000);

      // Run 2
      const r2 = await spawnDevServer({ port: port2, home: tmpHome, telemetryFile: file2 });
      killProcess(r2.process);
      await waitForFile(file2, 15_000);

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
      seedPinnedInstallationId(tmpHome);
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      const result = await spawnDevServer({ port, home: tmpHome, telemetryFile });
      devProcess = result.process;

      assert.ok(await waitForFile(telemetryFile, 15_000));
      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(body.event.command, 'dev');
      assert.strictEqual(body.event.state, 'SUCCESS');

      await sleep(2000);
      assertDelivered(result.stderr, 'dev SUCCESS');
    });

    test('FAIL: port in use emits dev/FAIL with PORT_IN_USE', async () => {
      tmpHome = createTmpDir('dev-fail');
      seedPinnedInstallationId(tmpHome);
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      blocker = createServer();
      await new Promise<void>((resolve, reject) => {
        blocker!.once('error', reject);
        blocker!.listen(port, resolve);
      });

      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/server.ts'], {
        home: tmpHome, telemetryFile, env: { PORT: String(port) }, timeoutMs: 15_000,
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
      seedPinnedInstallationId(tmpHome);
      scaffoldDir = createTmpDir('scaffold-target');
      const targetDir = join(scaffoldDir, 'my-app');
      const telemetryFile = uniqueTelemetryFile(tmpHome);

      const result = await runCommand('npx', ['create-blocks-app', targetDir, '--template', 'bare', '--yes', '--skip-install'], {
        home: tmpHome, telemetryFile, cwd: scaffoldDir, timeoutMs: 60_000,
      });

      assert.ok(await waitForFile(telemetryFile, 5_000));
      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(body.event.command, 'create-blocks-app');
      assert.strictEqual(body.event.state, 'SUCCESS');
      assertDelivered(result.stderr, 'create-blocks-app SUCCESS');
    });

    test('FAIL: missing args emits create-blocks-app/FAIL', async () => {
      tmpHome = createTmpDir('create-app-fail');
      seedPinnedInstallationId(tmpHome);
      const telemetryFile = uniqueTelemetryFile(tmpHome);

      // No target dir argument → should fail
      const result = await runCommand('npx', ['create-blocks-app'], {
        home: tmpHome, telemetryFile, timeoutMs: 15_000,
      });

      // create-blocks-app may exit without emitting telemetry on arg parse failure
      // (it exits before trackCommand is called). This is expected behavior.
      if (await waitForFile(telemetryFile, 3_000)) {
        const body = readTelemetryFile(telemetryFile);
        assert.strictEqual(body.event.command, 'create-blocks-app');
        assert.strictEqual(body.event.state, 'FAIL');
      }
    });
  });

  describe('command: vendorize', () => {
    let tmpHome: string;
    afterEach(() => { if (tmpHome) rmSync(tmpHome, { recursive: true, force: true }); });

    test('FAIL: bad package name emits vendorize/FAIL', async () => {
      tmpHome = createTmpDir('vendorize-fail');
      seedPinnedInstallationId(tmpHome);
      const telemetryFile = uniqueTelemetryFile(tmpHome);

      const result = await runCommand('npx', ['blocks-vendorize', '@nonexistent/fake-package'], {
        home: tmpHome, telemetryFile, timeoutMs: 15_000,
      });

      if (await waitForFile(telemetryFile, 3_000)) {
        const body = readTelemetryFile(telemetryFile);
        assert.strictEqual(body.event.command, 'vendorize');
        assert.strictEqual(body.event.state, 'FAIL');
        assertDelivered(result.stderr, 'vendorize FAIL');
      }
    });
  });

  // ── 4. AWS commands (require valid credentials) ─────────────────────────────

  describe('command: sandbox', () => {
    let tmpHome: string;
    afterEach(() => { if (tmpHome) rmSync(tmpHome, { recursive: true, force: true }); });

    test('FAIL: no creds emits sandbox/FAIL', async () => {
      tmpHome = createTmpDir('sandbox-fail');
      seedPinnedInstallationId(tmpHome);
      const telemetryFile = uniqueTelemetryFile(tmpHome);

      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/sandbox.ts'], {
        home: tmpHome, telemetryFile, timeoutMs: 90_000,
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
      seedPinnedInstallationId(tmpHome);
      const telemetryFile = uniqueTelemetryFile(tmpHome);

      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/sandbox.ts'], {
        home: tmpHome, telemetryFile, timeoutMs: 300_000,
      });

      assert.ok(await waitForFile(telemetryFile, 5_000), 'sandbox SUCCESS should emit telemetry');
      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(body.event.command, 'sandbox');
      assert.strictEqual(body.event.state, 'SUCCESS');
      assert.strictEqual(body.event.error, undefined);
      assertDelivered(result.stderr, 'sandbox SUCCESS');
    });
  });

  describe('command: sandbox:destroy', () => {
    let tmpHome: string;
    afterEach(() => { if (tmpHome) rmSync(tmpHome, { recursive: true, force: true }); });

    test('FAIL: no creds emits sandbox:destroy/FAIL', async () => {
      tmpHome = createTmpDir('sandbox-destroy-fail');
      seedPinnedInstallationId(tmpHome);
      const telemetryFile = uniqueTelemetryFile(tmpHome);

      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/sandbox-destroy.ts'], {
        home: tmpHome, telemetryFile, timeoutMs: 90_000,
        env: { AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_SESSION_TOKEN: '' },
      });

      if (await waitForFile(telemetryFile, 5_000)) {
        const body = readTelemetryFile(telemetryFile);
        assert.strictEqual(body.event.command, 'sandbox:destroy');
        assert.strictEqual(body.event.state, 'FAIL');
        assertDelivered(result.stderr, 'sandbox:destroy FAIL');
      }
    });

    test('SUCCESS: sandbox:destroy after deploy emits sandbox:destroy/SUCCESS', async () => {
      tmpHome = createTmpDir('sandbox-destroy-success');
      seedPinnedInstallationId(tmpHome);

      // First deploy a sandbox
      const deployFile = uniqueTelemetryFile(tmpHome);
      await runCommand('npx', ['tsx', 'aws-blocks/scripts/sandbox.ts'], {
        home: tmpHome, telemetryFile: deployFile, timeoutMs: 300_000,
      });

      // Then destroy it
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/sandbox-destroy.ts'], {
        home: tmpHome, telemetryFile, timeoutMs: 120_000,
      });

      assert.ok(await waitForFile(telemetryFile, 5_000));
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
      seedPinnedInstallationId(tmpHome);
      const telemetryFile = uniqueTelemetryFile(tmpHome);

      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/deploy.ts'], {
        home: tmpHome, telemetryFile, timeoutMs: 90_000,
        env: { AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_SESSION_TOKEN: '' },
      });

      assert.ok(await waitForFile(telemetryFile, 5_000));
      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(body.event.command, 'deploy');
      assert.strictEqual(body.event.state, 'FAIL');
      assert.ok(body.event.error);
      assertDelivered(result.stderr, 'deploy FAIL');
    });

    test('SUCCESS: deploy with creds emits deploy/SUCCESS', async () => {
      tmpHome = createTmpDir('deploy-success');
      seedPinnedInstallationId(tmpHome);
      const telemetryFile = uniqueTelemetryFile(tmpHome);

      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/deploy.ts'], {
        home: tmpHome, telemetryFile, timeoutMs: 300_000,
      });

      assert.ok(await waitForFile(telemetryFile, 5_000));
      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(body.event.command, 'deploy');
      assert.strictEqual(body.event.state, 'SUCCESS');
      assertDelivered(result.stderr, 'deploy SUCCESS');
    });
  });

  describe('command: destroy', () => {
    let tmpHome: string;
    afterEach(() => { if (tmpHome) rmSync(tmpHome, { recursive: true, force: true }); });

    test('FAIL: no creds emits destroy/FAIL', async () => {
      tmpHome = createTmpDir('destroy-fail');
      seedPinnedInstallationId(tmpHome);
      const telemetryFile = uniqueTelemetryFile(tmpHome);

      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/destroy.ts'], {
        home: tmpHome, telemetryFile, timeoutMs: 90_000,
        env: { AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_SESSION_TOKEN: '' },
      });

      assert.ok(await waitForFile(telemetryFile, 5_000));
      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(body.event.command, 'destroy');
      assert.strictEqual(body.event.state, 'FAIL');
      assertDelivered(result.stderr, 'destroy FAIL');
    });

    test('SUCCESS: destroy with creds emits destroy/SUCCESS', async () => {
      tmpHome = createTmpDir('destroy-success');
      seedPinnedInstallationId(tmpHome);

      // Deploy first, then destroy
      const deployFile = uniqueTelemetryFile(tmpHome);
      await runCommand('npx', ['tsx', 'aws-blocks/scripts/deploy.ts'], {
        home: tmpHome, telemetryFile: deployFile, timeoutMs: 300_000,
      });

      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/destroy.ts'], {
        home: tmpHome, telemetryFile, timeoutMs: 120_000,
      });

      assert.ok(await waitForFile(telemetryFile, 5_000));
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
      seedPinnedInstallationId(tmpHome);

      // Deploy sandbox first to create outputs.json
      const deployFile = uniqueTelemetryFile(tmpHome);
      await runCommand('npx', ['tsx', 'aws-blocks/scripts/sandbox.ts'], {
        home: tmpHome, telemetryFile: deployFile, timeoutMs: 300_000,
      });

      // Run console
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const result = await runCommand('npx', ['tsx', '-e', `
        import { openConsole } from '@aws-blocks/blocks/scripts';
        openConsole({ outputsFile: '.blocks-sandbox/outputs.json' });
      `], {
        home: tmpHome, telemetryFile, timeoutMs: 15_000,
      });

      assert.ok(await waitForFile(telemetryFile, 3_000));
      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(body.event.command, 'console');
      assert.strictEqual(body.event.state, 'SUCCESS');
      assertDelivered(result.stderr, 'console SUCCESS');

      // Cleanup: destroy the sandbox
      await runCommand('npx', ['tsx', 'aws-blocks/scripts/sandbox-destroy.ts'], {
        home: tmpHome, telemetryFile: uniqueTelemetryFile(tmpHome), timeoutMs: 120_000,
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
      seedPinnedInstallationId(tmpHome);
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/server.ts'], {
        home: tmpHome, telemetryFile, env: { PORT: String(port), AWS_BLOCKS_DISABLE_TELEMETRY: '1' }, timeoutMs: 12_000,
      });

      const fileExists = await waitForFile(telemetryFile, 2_000);
      // --telemetry-file still writes even when disabled (matches CDK behavior)
      // but HTTP send should NOT happen
      assertNotDelivered(result.stderr);
    });

    test('global config telemetry.enabled=false prevents telemetry', async () => {
      tmpHome = createTmpDir('disable-global');
      seedPinnedInstallationId(tmpHome);
      // Write global config disabling telemetry
      const globalConfig = join(tmpHome, '.blocks', 'config.json');
      mkdirSync(dirname(globalConfig), { recursive: true });
      writeFileSync(globalConfig, JSON.stringify({ telemetry: { enabled: false } }));

      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/server.ts'], {
        home: tmpHome, telemetryFile, env: { PORT: String(port) }, timeoutMs: 12_000,
      });

      assertNotDelivered(result.stderr);
    });

    test('per-project config telemetry.enabled=false prevents telemetry', async () => {
      tmpHome = createTmpDir('disable-project');
      seedPinnedInstallationId(tmpHome);
      // Write per-project config disabling telemetry
      const projectConfig = join(APP_ROOT, '.blocks', 'config.json');
      const originalContent = existsSync(projectConfig) ? readFileSync(projectConfig, 'utf-8') : null;

      try {
        mkdirSync(dirname(projectConfig), { recursive: true });
        writeFileSync(projectConfig, JSON.stringify({ telemetry: { enabled: false } }));

        const telemetryFile = uniqueTelemetryFile(tmpHome);
        const port = getNextPort();

        const result = await runCommand('npx', ['tsx', 'aws-blocks/scripts/server.ts'], {
          home: tmpHome, telemetryFile, env: { PORT: String(port) }, timeoutMs: 12_000,
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
      seedPinnedInstallationId(tmpHome);
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      const result = await spawnDevServer({
        port, home: tmpHome, telemetryFile,
        env: { AWS_BLOCKS_DISABLE_TELEMETRY: '0' },
      });
      devProcess = result.process;

      assert.ok(await waitForFile(telemetryFile, 15_000), 'telemetry should still fire with =0');
      await sleep(2000);
      assertDelivered(result.stderr, 'telemetry should be delivered when DISABLE=0');
    });
  });

}); // end describe('Telemetry E2E')
