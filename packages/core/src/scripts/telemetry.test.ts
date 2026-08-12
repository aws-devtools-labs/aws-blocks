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
  TASK_ID: '',
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
      const globalConfigDir = join(tmpHome, '.blocks');
      mkdirSync(globalConfigDir, { recursive: true });
      writeFileSync(join(globalConfigDir, 'config.json'), JSON.stringify({ telemetry: { enabled: true } }));

      const projectConfigDir = join(tmpProject, '.blocks');
      mkdirSync(projectConfigDir, { recursive: true });
      writeFileSync(join(projectConfigDir, 'config.json'), JSON.stringify({ telemetry: { enabled: false } }));

      const result = runCli(['--status'], { cwd: tmpProject, env: { HOME: tmpHome, ...NO_CI_ENV } });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('Disabled'));
    });

    it('any disable wins — global disabled even if project enabled', () => {
      const globalConfigDir = join(tmpHome, '.blocks');
      mkdirSync(globalConfigDir, { recursive: true });
      writeFileSync(join(globalConfigDir, 'config.json'), JSON.stringify({ telemetry: { enabled: false } }));

      const projectConfigDir = join(tmpProject, '.blocks');
      mkdirSync(projectConfigDir, { recursive: true });
      writeFileSync(join(projectConfigDir, 'config.json'), JSON.stringify({ telemetry: { enabled: true } }));

      const result = runCli(['--status'], { cwd: tmpProject, env: { HOME: tmpHome, ...NO_CI_ENV } });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('Disabled'));
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
