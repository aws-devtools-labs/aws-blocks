// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_SCRIPT = join(__dirname, 'telemetry-cli.js');

/** Env overrides that clear CI detection so tests see "default enabled" state. */
const NO_CI_ENV: Record<string, string> = {
  CI: '',
  CONTINUOUS_INTEGRATION: '',
  BUILD_NUMBER: '',
  CODEBUILD_BUILD_ID: '',
  GITHUB_ACTIONS: '',
  GITLAB_CI: '',
  CIRCLECI: '',
  JENKINS_URL: '',
  TF_BUILD: '',
  BITBUCKET_BUILD_NUMBER: '',
  BUILDKITE: '',
  RENDER: '',
  TASKCLUSTER_ROOT_URL: '',
  AWS_BLOCKS_DISABLE_TELEMETRY: '',
};

function createTmpDir(): string {
  const dir = join(tmpdir(), `blocks-telemetry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runCli(args: string[], options?: { cwd?: string; env?: Record<string, string> }): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('node', [CLI_SCRIPT, ...args], {
    cwd: options?.cwd ?? process.cwd(),
    encoding: 'utf-8',
    env: { ...process.env, ...options?.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status ?? 1,
  };
}

// Driven in a child process: `os.homedir()` reads the native environment, so HOME
// can only be redirected at spawn time.
const GATE_CHILD = `
const [moduleUrl] = process.argv.slice(1);
const { isTelemetryEnabled } = await import(moduleUrl);
process.stdout.write(String(isTelemetryEnabled()));
`;

function runGate(options: { cwd: string; env?: Record<string, string> }): boolean {
  const consentUrl = new URL('../telemetry/consent.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', GATE_CHILD, consentUrl], {
    cwd: options.cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, ...options.env },
  });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /^(true|false)$/, `unexpected gate output: ${JSON.stringify(result.stdout)}`);
  return result.stdout === 'true';
}

function writeTelemetryConfig(dir: string, enabled: boolean): void {
  mkdirSync(join(dir, '.blocks'), { recursive: true });
  writeFileSync(join(dir, '.blocks', 'config.json'), JSON.stringify({ telemetry: { enabled } }));
}

describe('telemetry CLI', () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeEach(() => {
    tmpHome = createTmpDir();
    tmpProject = createTmpDir();
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
  });

  describe('help', () => {
    it('--help shows usage', () => {
      const result = runCli(['--help'], { cwd: tmpProject, env: { HOME: tmpHome } });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('--enable'));
      assert.ok(result.stdout.includes('--disable'));
      assert.ok(result.stdout.includes('--global'));
      assert.ok(result.stdout.includes('AWS_BLOCKS_DISABLE_TELEMETRY=1|true|yes'));
      assert.ok(result.stdout.includes('A disable from any other mechanism still wins'));
      assert.ok(result.stdout.includes('BLOCKS_TELEMETRY_ENDPOINT=<url>'));
      assert.ok(result.stdout.includes('Send failures are ignored'));
      assert.ok(result.stdout.includes('AWS_BLOCKS_DISABLE_TEMPLATE_METADATA=1|true|yes'));
      assert.ok(result.stdout.includes('-c blocks:template-metadata=false or cdk --no-version-reporting'));
      assert.ok(result.stdout.includes('--disable does not affect it'));
    });

    it('-h shows usage', () => {
      const result = runCli(['-h'], { cwd: tmpProject, env: { HOME: tmpHome } });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('--enable'));
    });
  });

  describe('bare command (shows help)', () => {
    it('shows usage when invoked with no arguments', () => {
      const result = runCli([], { cwd: tmpProject, env: { HOME: tmpHome, ...NO_CI_ENV } });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('Usage:'));
      assert.ok(result.stdout.includes('--enable'));
      assert.ok(result.stdout.includes('--disable'));
      assert.ok(result.stdout.includes('--status'));
    });
  });

  describe('--enable (project-level default)', () => {
    it('creates .blocks/config.json with telemetry.enabled=true', () => {
      const result = runCli(['--enable'], { cwd: tmpProject, env: { HOME: tmpHome } });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('enabled for this project'));

      const configPath = join(tmpProject, '.blocks', 'config.json');
      assert.ok(existsSync(configPath));
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      assert.strictEqual(config.telemetry.enabled, true);
    });
  });

  describe('--disable (project-level default)', () => {
    it('creates .blocks/config.json with telemetry.enabled=false', () => {
      const result = runCli(['--disable'], { cwd: tmpProject, env: { HOME: tmpHome } });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('disabled for this project'));

      const configPath = join(tmpProject, '.blocks', 'config.json');
      assert.ok(existsSync(configPath));
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      assert.strictEqual(config.telemetry.enabled, false);
    });
  });

  describe('--enable --global', () => {
    it('creates ~/.blocks/config.json with telemetry.enabled=true', () => {
      const result = runCli(['--enable', '--global'], { cwd: tmpProject, env: { HOME: tmpHome } });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('enabled globally'));

      const configPath = join(tmpHome, '.blocks', 'config.json');
      assert.ok(existsSync(configPath));
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      assert.strictEqual(config.telemetry.enabled, true);
    });

    it('preserves existing keys in global config', () => {
      const configDir = join(tmpHome, '.blocks');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ telemetry: { projectId: 'xyz' }, someKey: 'value' }, null, 2));

      const result = runCli(['--enable', '--global'], { cwd: tmpProject, env: { HOME: tmpHome } });
      assert.strictEqual(result.exitCode, 0);

      const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf-8'));
      assert.strictEqual(config.telemetry.enabled, true);
      assert.strictEqual(config.telemetry.projectId, 'xyz');
      assert.strictEqual(config.someKey, 'value');
    });
  });

  describe('--disable --global', () => {
    it('creates ~/.blocks/config.json with telemetry.enabled=false', () => {
      const result = runCli(['--disable', '--global'], { cwd: tmpProject, env: { HOME: tmpHome } });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('disabled globally'));

      const configPath = join(tmpHome, '.blocks', 'config.json');
      assert.ok(existsSync(configPath));
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      assert.strictEqual(config.telemetry.enabled, false);
    });
  });

  describe('--status (shows status)', () => {
    it('shows enabled by default when no config exists', () => {
      const result = runCli(['--status'], { cwd: tmpProject, env: { HOME: tmpHome, ...NO_CI_ENV } });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('Telemetry:'));
      assert.ok(result.stdout.includes('Enabled'));
    });

    it('shows disabled when global config disables telemetry', () => {
      const configDir = join(tmpHome, '.blocks');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ telemetry: { enabled: false } }));

      const result = runCli(['--status'], { cwd: tmpProject, env: { HOME: tmpHome, ...NO_CI_ENV } });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('Disabled'));
      assert.ok(result.stdout.includes('Global config'));
    });

    it('shows disabled when env var is set to 1', () => {
      const result = runCli(['--status'], { cwd: tmpProject, env: { HOME: tmpHome, ...NO_CI_ENV, AWS_BLOCKS_DISABLE_TELEMETRY: '1' } });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('Disabled'));
      assert.ok(result.stdout.includes('AWS_BLOCKS_DISABLE_TELEMETRY'));
    });

    it('any disable wins — project disabled even if global enabled', () => {
      writeTelemetryConfig(tmpHome, true);
      writeTelemetryConfig(tmpProject, false);

      const env = { HOME: tmpHome, USERPROFILE: tmpHome, ...NO_CI_ENV };

      const result = runCli(['--status'], { cwd: tmpProject, env });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('Disabled'));
      assert.strictEqual(runGate({ cwd: tmpProject, env }), false, 'the send gate must also be closed');
    });

    it('any disable wins — global disabled even if project enabled', () => {
      writeTelemetryConfig(tmpHome, false);
      writeTelemetryConfig(tmpProject, true);

      const env = { HOME: tmpHome, USERPROFILE: tmpHome, ...NO_CI_ENV };

      const result = runCli(['--status'], { cwd: tmpProject, env });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('Disabled'));
      assert.strictEqual(runGate({ cwd: tmpProject, env }), false, 'the send gate must also be closed');
    });
  });

  describe('--enable reports when a broader mechanism still disables', () => {
    it('warns and names the global config when it disables', () => {
      writeTelemetryConfig(tmpHome, false);

      const result = runCli(['--enable'], { cwd: tmpProject, env: { HOME: tmpHome, USERPROFILE: tmpHome, ...NO_CI_ENV } });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('enabled for this project'));

      const output = result.stdout + result.stderr;
      assert.ok(output.includes('still disabled by'), `expected an advisory, got:\n${output}`);
      assert.ok(output.includes(join(tmpHome, '.blocks', 'config.json')), 'advisory must name the global config path');
    });

    it('warns and names the env var when it disables', () => {
      const result = runCli(['--enable'], {
        cwd: tmpProject,
        env: { HOME: tmpHome, USERPROFILE: tmpHome, ...NO_CI_ENV, AWS_BLOCKS_DISABLE_TELEMETRY: 'yes' },
      });
      assert.strictEqual(result.exitCode, 0);

      const output = result.stdout + result.stderr;
      assert.ok(output.includes('AWS_BLOCKS_DISABLE_TELEMETRY="yes"'), `expected the env var named, got:\n${output}`);
    });

    it('warns and names the project config when --enable --global cannot take effect', () => {
      writeTelemetryConfig(tmpProject, false);

      const result = runCli(['--enable', '--global'], { cwd: tmpProject, env: { HOME: tmpHome, USERPROFILE: tmpHome, ...NO_CI_ENV } });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('enabled globally'));

      const output = result.stdout + result.stderr;
      assert.ok(output.includes(join(tmpProject, '.blocks', 'config.json')), 'advisory must name the project config path');
    });

    it('stays silent when the enable actually takes effect', () => {
      const result = runCli(['--enable'], { cwd: tmpProject, env: { HOME: tmpHome, USERPROFILE: tmpHome, ...NO_CI_ENV } });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('enabled for this project'));
      assert.ok(!(result.stdout + result.stderr).includes('still disabled by'), 'no advisory when telemetry is on');
      assert.strictEqual(runGate({ cwd: tmpProject, env: { HOME: tmpHome, USERPROFILE: tmpHome, ...NO_CI_ENV } }), true);
    });
  });

  describe('error handling', () => {
    it('--enable and --disable together exits with error', () => {
      const result = runCli(['--enable', '--disable'], { cwd: tmpProject, env: { HOME: tmpHome } });
      assert.notStrictEqual(result.exitCode, 0);
      assert.ok(result.stderr.includes('mutually exclusive'));
    });
  });

  describe('unknown flags', () => {
    it('warns about unrecognized flags but still exits 0', () => {
      const result = runCli(['--statu'], { cwd: tmpProject, env: { HOME: tmpHome, ...NO_CI_ENV } });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stderr.includes('Unknown option') || result.stdout.includes('Unknown option'));
      assert.ok(result.stderr.includes('--statu') || result.stdout.includes('--statu'));
    });

    it('recognized action still runs when unknown flags are present', () => {
      const result = runCli(['--enable', '--typo'], { cwd: tmpProject, env: { HOME: tmpHome, ...NO_CI_ENV } });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stderr.includes('Unknown option') || result.stdout.includes('Unknown option'));
      assert.ok(result.stderr.includes('--typo') || result.stdout.includes('--typo'));
      assert.ok(result.stdout.includes('enabled for this project'));
    });
  });
});
