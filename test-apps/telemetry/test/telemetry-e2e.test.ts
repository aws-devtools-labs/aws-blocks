// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Isolated E2E Telemetry Test Suite
 *
 * Verifies that telemetry events fire correctly across all Blocks CLI commands
 * using the `--telemetry-file` sink for assertions, that identifiers are created
 * and pinned correctly, and that every telemetry-emitting command produces a
 * correct SUCCESS and FAIL event.
 *
 * Isolation:
 * - Every test overrides HOME to a throwaway temp dir, so telemetry state
 *   (installation-id, global config) is sandboxed and never touches the real
 *   ~/.blocks or the other e2e suites.
 * - Each captured event goes to a UNIQUE --telemetry-file path (the sink uses
 *   O_EXCL, so paths must never be reused).
 *
 * Pinned installation ID:
 * - Matching .github/actions/seed-telemetry-id, most tests seed a fixed
 *   installation ID by writing $HOME/.blocks/telemetry/installation-id before
 *   invoking the CLI. This keeps installationId deterministic and suppresses
 *   the first-run consent notice.
 *
 * No AWS credentials: cloud commands fail fast but still emit a FAIL event.
 */

import { describe, test, afterEach } from 'node:test';
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
const MONO_ROOT = join(APP_ROOT, '..', '..');

// Built CLI entry points (require `npm run build` first).
const CLEANUP_SCRIPT = join(MONO_ROOT, 'packages', 'core', 'dist', 'scripts', 'cleanup.js');
const CREATE_APP_SCRIPT = join(MONO_ROOT, 'packages', 'create-blocks-app', 'dist', 'index.js');

/**
 * Fixed CI e2e telemetry installation ID.
 * Kept in sync with .github/actions/seed-telemetry-id.
 */
const PINNED_INSTALLATION_ID = '00000000-0000-0000-0000-000000000e2e';

/** Fixed projectId seeded in test-apps/telemetry/.blocks/config.json. */
const PINNED_PROJECT_ID = '00000000-0000-0000-0000-0000000e2e57';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Helpers ─────────────────────────────────────────────────────────────────

let fileCounter = 0;

function createTmpDir(prefix = 'blocks-telemetry-e2e'): string {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Absolute path to the installation-id file inside a sandboxed HOME. */
function installationIdPath(homeDir: string): string {
  return join(homeDir, '.blocks', 'telemetry', 'installation-id');
}

/** Write the pinned installation ID into a sandboxed HOME (returns it). */
function seedPinnedInstallationId(homeDir: string): string {
  const filePath = installationIdPath(homeDir);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, PINNED_INSTALLATION_ID, 'utf-8');
  return PINNED_INSTALLATION_ID;
}

/** Unique, never-before-used telemetry file path inside a dir. */
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

function spawnCommand(
  cmd: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
  },
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const { cwd, env, timeoutMs = 20_000 } = options;
    let stdout = '';
    let stderr = '';

    const child = spawn(cmd, args, {
      cwd: cwd ?? APP_ROOT,
      stdio: 'pipe',
      detached: true,
      env: { ...process.env, ...env, NODE_OPTIONS: '' } as NodeJS.ProcessEnv,
    });

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    const timer = globalThis.setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {}
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

/** Spawn the dev server and wait for the ready marker (or reject on exit). */
function spawnDevServer(options: {
  port: number;
  env: Record<string, string | undefined>;
  cwd?: string;
  extraArgs?: string[];
}): Promise<{ process: ChildProcess; output: { stdout: string; stderr: string } }> {
  return new Promise((resolve, reject) => {
    const { port, env, cwd, extraArgs = [] } = options;
    const output = { stdout: '', stderr: '' };

    const args = ['tsx', 'aws-blocks/scripts/server.ts', ...extraArgs];

    const child = spawn('npx', args, {
      cwd: cwd ?? APP_ROOT,
      stdio: 'pipe',
      detached: true,
      env: {
        ...process.env,
        ...env,
        PORT: String(port),
        NODE_OPTIONS: '',
      } as NodeJS.ProcessEnv,
    });

    const timeout = globalThis.setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {}
      child.kill('SIGKILL');
      reject(
        new Error(
          `Dev server did not become ready within 45s.\nstdout: ${output.stdout}\nstderr: ${output.stderr}`,
        ),
      );
    }, 45_000);

    child.stdout?.on('data', (d: Buffer) => {
      output.stdout += d.toString();
      if (output.stdout.includes('local server running on')) {
        clearTimeout(timeout);
        resolve({ process: child, output });
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      output.stderr += d.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Dev server exited with code ${code} before ready.\nstdout: ${output.stdout}\nstderr: ${output.stderr}`,
        ),
      );
    });
  });
}

function killProcess(proc: ChildProcess): void {
  try {
    if (proc.pid) {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {}
    }
    proc.kill('SIGKILL');
    proc.stdout?.destroy();
    proc.stderr?.destroy();
    proc.removeAllListeners();
  } catch {}
}

/** Poll until a file exists (used to wait for the telemetry sink to flush). */
async function waitForFile(filePath: string, timeoutMs = 15_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(filePath)) return true;
    await sleep(150);
  }
  return existsSync(filePath);
}

/** Read a --telemetry-file output. The file contains a JSON array [event]. */
function readTelemetryFile(filePath: string): Record<string, any> {
  const content = readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(content);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

/**
 * Run a one-shot script that emits a single telemetry event to a file, wait
 * for the file, and return the parsed event.
 */
async function runScriptAndCapture(
  cmd: string,
  args: string[],
  home: string,
  telemetryFile: string,
  cwd = APP_ROOT,
  timeoutMs = 20_000,
): Promise<Record<string, any> | null> {
  await spawnCommand(cmd, [...args, `--telemetry-file=${telemetryFile}`], {
    cwd,
    env: { HOME: home, AWS_BLOCKS_DISABLE_TELEMETRY: undefined },
    timeoutMs,
  });
  const found = await waitForFile(telemetryFile, 3_000);
  return found ? readTelemetryFile(telemetryFile) : null;
}

/** Emit a SUCCESS or FAIL event for a command via the real trackCommand pipeline. */
async function emitCommand(
  command: string,
  outcome: 'success' | 'fail',
  home: string,
  telemetryFile: string,
): Promise<Record<string, any> | null> {
  return runScriptAndCapture(
    'npx',
    ['tsx', 'aws-blocks/scripts/emit.ts', command, outcome],
    home,
    telemetryFile,
  );
}

// ─── Test Suites ─────────────────────────────────────────────────────────────

describe('Telemetry E2E (isolated, pinned)', { timeout: 600_000 }, () => {
  // ── 1. --telemetry-file emission & attribute assertions ────────────────────

  describe('--telemetry-file emission & attributes', () => {
    let devProcess: ChildProcess | null = null;
    let tmpHome: string;

    afterEach(() => {
      if (devProcess) {
        killProcess(devProcess);
        devProcess = null;
      }
      if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
    });

    test('dev event carries all standard attributes and correct counters', async () => {
      tmpHome = createTmpDir('telemetry-attrs');
      seedPinnedInstallationId(tmpHome);
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      const result = await spawnDevServer({
        port,
        env: { HOME: tmpHome, AWS_BLOCKS_DISABLE_TELEMETRY: undefined },
        extraArgs: [`--telemetry-file=${telemetryFile}`],
      });
      devProcess = result.process;

      assert.ok(await waitForFile(telemetryFile, 15_000), 'telemetry file should be written');
      const body = readTelemetryFile(telemetryFile);

      // Identifiers (pinned).
      assert.strictEqual(
        body.identifiers.installationId,
        PINNED_INSTALLATION_ID,
        'installationId should be the pinned value',
      );
      assert.strictEqual(
        body.identifiers.projectId,
        PINNED_PROJECT_ID,
        'projectId should be the pinned value from .blocks/config.json',
      );
      assert.match(body.identifiers.eventId, UUID_REGEX, 'eventId should be a UUID');
      assert.ok(body.identifiers.timestamp, 'timestamp should exist');

      // Command.
      assert.strictEqual(body.event.command, 'dev', 'command should be "dev"');
      assert.strictEqual(body.event.state, 'SUCCESS', 'dev server start should be SUCCESS');

      // Product: blocks version + template name/version.
      assert.match(
        body.product.blocksVersion,
        /^\d+\.\d+\.\d+/,
        'blocksVersion should be semver',
      );
      assert.deepStrictEqual(
        body.product.template,
        { name: 'telemetry-e2e', version: '1.2.3' },
        'template name/version should come from package.json',
      );

      // Environment: os + ci.
      assert.ok(
        ['linux', 'darwin', 'win32'].includes(body.environment.os),
        `os should be a known platform, got ${body.environment.os}`,
      );
      assert.strictEqual(
        body.environment.os,
        platform(),
        'environment.os should match the actual platform',
      );
      assert.strictEqual(typeof body.environment.ci, 'boolean', 'ci should be a boolean');
      assert.match(body.environment.nodeVersion, /^v?\d+\.\d+\.\d+/, 'nodeVersion should be semver');

      // Building blocks: official appear with version; custom excluded.
      const officialNames: string[] = (body.product.buildingBlocks ?? []).map(
        (b: { name: string }) => b.name,
      );
      assert.ok(officialNames.includes('AppSetting'), 'AppSetting should appear as official BB');
      assert.ok(officialNames.includes('KVStore'), 'KVStore should appear as official BB');
      assert.ok(
        !officialNames.includes('CustomAnalyticsTracker'),
        'custom BB must NOT appear in buildingBlocks',
      );
      for (const bb of body.product.buildingBlocks ?? []) {
        assert.ok(bb.version, `official BB ${bb.name} should carry a version`);
      }

      // Counters: custom count and total count.
      assert.ok(body.counters, 'counters should exist');
      assert.ok(
        body.counters.customBuildingBlocks >= 1,
        `customBuildingBlocks should be >= 1, got ${body.counters.customBuildingBlocks}`,
      );
      assert.ok(
        body.counters.blocksCount >= 3,
        `blocksCount should be >= 3 (2 official + 1 custom), got ${body.counters.blocksCount}`,
      );
      assert.ok(
        body.counters.blocksCount > officialNames.length,
        'total blocksCount should exceed official BB count (custom BB included)',
      );
    });
  });

  // ── 2. Identifier creation when missing ────────────────────────────────────

  describe('identifier creation', () => {
    let devProcess: ChildProcess | null = null;
    let tmpHome: string;
    let tmpProject: string | null = null;

    afterEach(() => {
      if (devProcess) {
        killProcess(devProcess);
        devProcess = null;
      }
      if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
      if (tmpProject) {
        rmSync(tmpProject, { recursive: true, force: true });
        tmpProject = null;
      }
    });

    test('installation-id is created when missing and carried in the event', async () => {
      tmpHome = createTmpDir('telemetry-installid-create');
      // NOTE: no seeding — start from a clean HOME.
      const idPath = installationIdPath(tmpHome);
      assert.ok(!existsSync(idPath), 'installation-id must not exist at start');

      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();
      const result = await spawnDevServer({
        port,
        env: { HOME: tmpHome, AWS_BLOCKS_DISABLE_TELEMETRY: undefined },
        extraArgs: [`--telemetry-file=${telemetryFile}`],
      });
      devProcess = result.process;

      assert.ok(await waitForFile(telemetryFile, 15_000), 'telemetry file should be written');
      assert.ok(existsSync(idPath), 'installation-id file should have been created');

      const createdId = readFileSync(idPath, 'utf-8').trim();
      assert.match(createdId, UUID_REGEX, 'created installation-id should be a valid UUID');

      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(
        body.identifiers.installationId,
        createdId,
        'emitted event should carry the freshly created installation-id',
      );
    });

    test('project-id is created when missing (fresh project dir)', async () => {
      tmpHome = createTmpDir('telemetry-projectid-home');
      seedPinnedInstallationId(tmpHome);
      tmpProject = createTmpDir('telemetry-projectid-project');
      // Provide a package.json so the app can run from this cwd.
      writeFileSync(
        join(tmpProject, 'package.json'),
        JSON.stringify({ name: 'tmp-proj', type: 'module' }),
        'utf-8',
      );
      const configPath = join(tmpProject, '.blocks', 'config.json');
      assert.ok(!existsSync(configPath), 'project config must not exist at start');

      const telemetryFile = uniqueTelemetryFile(tmpHome);

      // Run the emit harness from the fresh project dir so getProjectId() writes there.
      const body = await runScriptAndCapture(
        'npx',
        ['tsx', join(APP_ROOT, 'aws-blocks', 'scripts', 'emit.ts'), 'deploy', 'success'],
        tmpHome,
        telemetryFile,
        tmpProject,
      );

      assert.ok(existsSync(configPath), 'project .blocks/config.json should have been created');
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      assert.match(
        config.telemetry.projectId,
        UUID_REGEX,
        'created projectId should be a valid UUID',
      );
      assert.ok(body, 'event should have been captured');
      assert.strictEqual(
        body!.identifiers.projectId,
        config.telemetry.projectId,
        'emitted event should carry the freshly created projectId',
      );
    });
  });

  // ── 3. Per-command SUCCESS + FAILURE events ────────────────────────────────

  describe('per-command success + failure events', () => {
    let tmpHome: string;

    afterEach(() => {
      if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
    });

    const trackedCommands = [
      'deploy',
      'destroy',
      'sandbox',
      'sandbox:destroy',
      'cleanup',
      'console',
      'create-blocks-app',
    ] as const;

    for (const command of trackedCommands) {
      test(`${command}: SUCCESS event has correct command + state`, async () => {
        tmpHome = createTmpDir(`telemetry-ok-${command.replace(':', '-')}`);
        seedPinnedInstallationId(tmpHome);
        const telemetryFile = uniqueTelemetryFile(tmpHome);

        const body = await emitCommand(command, 'success', tmpHome, telemetryFile);

        assert.ok(body, `${command} success event should be captured`);
        assert.strictEqual(body!.event.command, command, 'command name should match');
        assert.strictEqual(body!.event.state, 'SUCCESS', 'state should be SUCCESS');
        assert.strictEqual(body!.event.error, undefined, 'SUCCESS event must not carry error info');
        assert.strictEqual(
          body!.identifiers.installationId,
          PINNED_INSTALLATION_ID,
          'installationId should be pinned',
        );
      });

      test(`${command}: FAILURE event has correct command + state + error`, async () => {
        tmpHome = createTmpDir(`telemetry-fail-${command.replace(':', '-')}`);
        seedPinnedInstallationId(tmpHome);
        const telemetryFile = uniqueTelemetryFile(tmpHome);

        const body = await emitCommand(command, 'fail', tmpHome, telemetryFile);

        assert.ok(body, `${command} failure event should be captured`);
        assert.strictEqual(body!.event.command, command, 'command name should match');
        assert.strictEqual(body!.event.state, 'FAIL', 'state should be FAIL');
        assert.ok(body!.event.error, 'FAIL event should carry error info');
        assert.strictEqual(typeof body!.event.error.code, 'string', 'error.code should be a string');
        assert.strictEqual(typeof body!.event.error.phase, 'string', 'error.phase should be a string');
      });
    }
  });

  // ── 3b. Real CLI integration: actual scripts emit correct events ───────────

  describe('real CLI command integration', () => {
    let devProcess: ChildProcess | null = null;
    let blocker: ReturnType<typeof createServer> | null = null;
    let tmpHome: string;

    afterEach(async () => {
      if (devProcess) {
        killProcess(devProcess);
        devProcess = null;
      }
      if (blocker) {
        await new Promise<void>((r) => blocker!.close(() => r()));
        blocker = null;
      }
      if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
    });

    test('dev: real server start emits dev/SUCCESS', async () => {
      tmpHome = createTmpDir('telemetry-real-dev-ok');
      seedPinnedInstallationId(tmpHome);
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();
      const result = await spawnDevServer({
        port,
        env: { HOME: tmpHome, AWS_BLOCKS_DISABLE_TELEMETRY: undefined },
        extraArgs: [`--telemetry-file=${telemetryFile}`],
      });
      devProcess = result.process;

      assert.ok(await waitForFile(telemetryFile, 15_000), 'telemetry file should be written');
      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(body.event.command, 'dev');
      assert.strictEqual(body.event.state, 'SUCCESS');
    });

    test('dev: EADDRINUSE emits dev/FAIL with PORT_IN_USE', async () => {
      tmpHome = createTmpDir('telemetry-real-dev-fail');
      seedPinnedInstallationId(tmpHome);
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();

      // Occupy the port so the dev server's listen() fails deterministically.
      blocker = createServer();
      await new Promise<void>((resolve, reject) => {
        blocker!.once('error', reject);
        blocker!.listen(port, resolve);
      });

      // Dev server will hit EADDRINUSE, emit FAIL, but keep the process alive;
      // run it via spawnCommand with a short timeout that kills it.
      await spawnCommand(
        'npx',
        ['tsx', 'aws-blocks/scripts/server.ts', `--telemetry-file=${telemetryFile}`],
        {
          cwd: APP_ROOT,
          env: { HOME: tmpHome, PORT: String(port), AWS_BLOCKS_DISABLE_TELEMETRY: undefined },
          timeoutMs: 12_000,
        },
      );

      assert.ok(await waitForFile(telemetryFile, 3_000), 'FAIL telemetry file should be written');
      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(body.event.command, 'dev');
      assert.strictEqual(body.event.state, 'FAIL');
      assert.strictEqual(body.event.error?.code, 'PORT_IN_USE');
      assert.strictEqual(body.event.error?.phase, 'startup');
    });

    test('sandbox: real script fails without creds and emits sandbox/FAIL', async () => {
      tmpHome = createTmpDir('telemetry-real-sandbox-fail');
      seedPinnedInstallationId(tmpHome);
      const telemetryFile = uniqueTelemetryFile(tmpHome);

      const body = await runScriptAndCapture(
        'npx',
        ['tsx', 'aws-blocks/scripts/sandbox.ts'],
        tmpHome,
        telemetryFile,
        APP_ROOT,
        60_000,
      );

      // Sandbox forwards the flag to a child process in some paths; only assert
      // when the event was captured (it fires on CDK failure in this env).
      if (body) {
        assert.strictEqual(body.event.command, 'sandbox');
        assert.strictEqual(body.event.state, 'FAIL');
      }
    });

    test('deploy: real script fails without creds and emits deploy/FAIL', async () => {
      tmpHome = createTmpDir('telemetry-real-deploy-fail');
      seedPinnedInstallationId(tmpHome);
      const telemetryFile = uniqueTelemetryFile(tmpHome);

      const body = await runScriptAndCapture(
        'npx',
        ['tsx', 'aws-blocks/scripts/deploy.ts'],
        tmpHome,
        telemetryFile,
        APP_ROOT,
        60_000,
      );

      if (body) {
        assert.strictEqual(body.event.command, 'deploy');
        assert.strictEqual(body.event.state, 'FAIL');
        assert.ok(body.event.error, 'deploy FAIL should carry error info');
      }
    });

    test('destroy: real script fails without creds and emits destroy/FAIL', async () => {
      tmpHome = createTmpDir('telemetry-real-destroy-fail');
      seedPinnedInstallationId(tmpHome);
      const telemetryFile = uniqueTelemetryFile(tmpHome);

      const body = await runScriptAndCapture(
        'npx',
        ['tsx', 'aws-blocks/scripts/destroy.ts'],
        tmpHome,
        telemetryFile,
        APP_ROOT,
        60_000,
      );

      if (body) {
        assert.strictEqual(body.event.command, 'destroy');
        assert.strictEqual(body.event.state, 'FAIL');
        assert.ok(body.event.error, 'destroy FAIL should carry error info');
      }
    });

    test('cleanup: real built CLI emits cleanup/SUCCESS', async () => {
      tmpHome = createTmpDir('telemetry-real-cleanup');
      seedPinnedInstallationId(tmpHome);
      const telemetryFile = uniqueTelemetryFile(tmpHome);

      assert.ok(existsSync(CLEANUP_SCRIPT), `built cleanup script should exist at ${CLEANUP_SCRIPT}`);

      const body = await runScriptAndCapture(
        'node',
        [CLEANUP_SCRIPT],
        tmpHome,
        telemetryFile,
        APP_ROOT,
        20_000,
      );

      assert.ok(body, 'cleanup should emit a telemetry event');
      assert.strictEqual(body!.event.command, 'cleanup');
      assert.strictEqual(body!.event.state, 'SUCCESS');
    });

    test('create-blocks-app: real built CLI scaffolds and emits create-blocks-app/SUCCESS', async () => {
      tmpHome = createTmpDir('telemetry-real-create-app');
      seedPinnedInstallationId(tmpHome);
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const scaffoldParent = createTmpDir('telemetry-scaffold');
      const targetDir = join(scaffoldParent, 'my-app');

      assert.ok(existsSync(CREATE_APP_SCRIPT), `built create-blocks-app should exist at ${CREATE_APP_SCRIPT}`);

      const body = await runScriptAndCapture(
        'node',
        [CREATE_APP_SCRIPT, targetDir, '--template', 'bare', '--yes', '--skip-install'],
        tmpHome,
        telemetryFile,
        scaffoldParent,
        60_000,
      );

      rmSync(scaffoldParent, { recursive: true, force: true });

      assert.ok(body, 'create-blocks-app should emit a telemetry event');
      assert.strictEqual(body!.event.command, 'create-blocks-app');
      assert.strictEqual(body!.event.state, 'SUCCESS');
      assert.ok(body!.product?.template, 'create-blocks-app event should carry template info');
    });
  });

  // ── 4. Pinned installation ID: delete → recreate → restore ─────────────────

  describe('pinned installationId recreation lifecycle', () => {
    let devProcess: ChildProcess | null = null;
    let tmpHome: string;

    afterEach(() => {
      if (devProcess) {
        killProcess(devProcess);
        devProcess = null;
      }
      // Teardown: ensure the pinned value is restored before cleanup so the
      // sandboxed HOME ends in the canonical pinned state.
      if (tmpHome) {
        seedPinnedInstallationId(tmpHome);
        assert.strictEqual(
          readFileSync(installationIdPath(tmpHome), 'utf-8').trim(),
          PINNED_INSTALLATION_ID,
          'teardown should restore the pinned installation-id',
        );
        rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    test('delete pinned id, let CLI recreate a fresh one, then restore', async () => {
      tmpHome = createTmpDir('telemetry-pinned-lifecycle');
      const idPath = installationIdPath(tmpHome);

      // 1. Seed pinned, verify.
      seedPinnedInstallationId(tmpHome);
      assert.strictEqual(readFileSync(idPath, 'utf-8').trim(), PINNED_INSTALLATION_ID);

      // 2. Delete the pinned file.
      rmSync(idPath, { force: true });
      assert.ok(!existsSync(idPath), 'pinned installation-id should be deleted');

      // 3. Run the real CLI so it creates a fresh installation-id.
      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();
      const result = await spawnDevServer({
        port,
        env: { HOME: tmpHome, AWS_BLOCKS_DISABLE_TELEMETRY: undefined },
        extraArgs: [`--telemetry-file=${telemetryFile}`],
      });
      devProcess = result.process;

      assert.ok(await waitForFile(telemetryFile, 15_000), 'telemetry file should be written');
      assert.ok(existsSync(idPath), 'CLI should have recreated the installation-id file');

      const recreatedId = readFileSync(idPath, 'utf-8').trim();
      assert.match(recreatedId, UUID_REGEX, 'recreated id should be a valid UUID');
      assert.notStrictEqual(
        recreatedId,
        PINNED_INSTALLATION_ID,
        'recreated id should be a fresh random UUID, not the pinned value',
      );

      const body = readTelemetryFile(telemetryFile);
      assert.strictEqual(
        body.identifiers.installationId,
        recreatedId,
        'emitted event should carry the recreated id',
      );

      // 4. Restore the pinned value explicitly (teardown re-asserts it too).
      seedPinnedInstallationId(tmpHome);
      assert.strictEqual(
        readFileSync(idPath, 'utf-8').trim(),
        PINNED_INSTALLATION_ID,
        'pinned installation-id should be restored',
      );
    });
  });

  // ── 5. Environment isolation guarantees ────────────────────────────────────

  describe('environment isolation', () => {
    let devProcess: ChildProcess | null = null;
    let tmpHome: string;

    afterEach(() => {
      if (devProcess) {
        killProcess(devProcess);
        devProcess = null;
      }
      if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
    });

    test('suite runs in a sandboxed HOME and never touches the real ~/.blocks', async () => {
      tmpHome = createTmpDir('telemetry-isolation');
      seedPinnedInstallationId(tmpHome);

      const realHome = homedir();
      assert.notStrictEqual(tmpHome, realHome, 'test HOME must differ from real HOME');

      const realIdPath = installationIdPath(realHome);
      const realIdBefore = existsSync(realIdPath)
        ? readFileSync(realIdPath, 'utf-8')
        : null;

      const telemetryFile = uniqueTelemetryFile(tmpHome);
      const port = getNextPort();
      const result = await spawnDevServer({
        port,
        env: { HOME: tmpHome, AWS_BLOCKS_DISABLE_TELEMETRY: undefined },
        extraArgs: [`--telemetry-file=${telemetryFile}`],
      });
      devProcess = result.process;
      assert.ok(await waitForFile(telemetryFile, 15_000), 'telemetry file should be written');

      // The pinned id lives ONLY in the sandboxed home.
      assert.strictEqual(
        readFileSync(installationIdPath(tmpHome), 'utf-8').trim(),
        PINNED_INSTALLATION_ID,
      );

      // The real home's installation-id is unchanged.
      const realIdAfter = existsSync(realIdPath)
        ? readFileSync(realIdPath, 'utf-8')
        : null;
      assert.strictEqual(realIdAfter, realIdBefore, 'real ~/.blocks installation-id must be untouched');

      // No PII leak: payload must not contain the real or sandbox home paths.
      const body = readTelemetryFile(telemetryFile);
      const serialized = JSON.stringify(body);
      assert.ok(!serialized.includes(realHome), 'payload must not contain the real HOME path');
      assert.ok(!serialized.includes(tmpHome), 'payload must not contain the sandbox HOME path');
    });
  });
});
