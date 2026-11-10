// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
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

// Same child-process reason as GATE_CHILD: the status must be read with HOME redirected.
const STATUS_CHILD = `
const [moduleUrl, projectRoot] = process.argv.slice(1);
const { getTelemetryStatus } = await import(moduleUrl);
process.stdout.write(JSON.stringify(getTelemetryStatus(projectRoot)));
`;

function readStatus(projectRoot: string, env: Record<string, string>): { enabled: boolean; projectConfig?: boolean } {
  const consentUrl = new URL('../telemetry/consent.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', STATUS_CHILD, consentUrl, projectRoot], {
    cwd: projectRoot,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  assert.strictEqual(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

/** An app layout (`package.json` + `aws-blocks/`) with a nested `src/sub`; returns the real paths. */
function createAppProject(dir: string): { root: string; sub: string } {
  writeFileSync(join(dir, 'package.json'), '{"name":"app"}');
  mkdirSync(join(dir, 'aws-blocks'));
  mkdirSync(join(dir, 'src', 'sub'), { recursive: true });
  const root = realpathSync(dir);
  return { root, sub: join(root, 'src', 'sub') };
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

    it('names the cdk-blocks telemetry command first', () => {
      const result = runCli(['--help'], { cwd: tmpProject, env: { HOME: tmpHome } });
      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stdout, /^Usage: npx --no -- cdk-blocks telemetry \[status\|enable\|disable\] \[--global\]\n/);
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
      createAppProject(tmpProject);
      const result = runCli(['--disable'], { cwd: tmpProject, env: { HOME: tmpHome } });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('disabled for this project'));

      const configPath = join(tmpProject, '.blocks', 'config.json');
      assert.ok(existsSync(configPath));
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      assert.strictEqual(config.telemetry.enabled, false);
    });
  });

  describe('project-level writes resolve the project root', () => {
    it('--disable from a subdirectory writes the project root and the root status reads disabled', () => {
      const { root, sub } = createAppProject(tmpProject);
      const env = { HOME: tmpHome, USERPROFILE: tmpHome, ...NO_CI_ENV };

      const result = runCli(['--disable'], { cwd: sub, env });
      assert.strictEqual(result.exitCode, 0, result.stdout + result.stderr);
      assert.ok(result.stdout.includes(join(root, '.blocks', 'config.json')), `expected the root config path, got:\n${result.stdout}`);
      assert.ok(!existsSync(join(sub, '.blocks')), 'must not write a config into the subdirectory');

      const status = readStatus(root, env);
      assert.strictEqual(status.projectConfig, false);
      assert.strictEqual(status.enabled, false);
    });

    it('--enable from a subdirectory writes the project root', () => {
      const { root, sub } = createAppProject(tmpProject);

      const result = runCli(['--enable'], { cwd: sub, env: { HOME: tmpHome, USERPROFILE: tmpHome, ...NO_CI_ENV } });
      assert.strictEqual(result.exitCode, 0, result.stdout + result.stderr);
      assert.strictEqual(JSON.parse(readFileSync(join(root, '.blocks', 'config.json'), 'utf-8')).telemetry.enabled, true);
      assert.ok(!existsSync(join(sub, '.blocks')), 'must not write a config into the subdirectory');
    });

    it('--status from a subdirectory reports the project-root config that --disable wrote', () => {
      const { root, sub } = createAppProject(tmpProject);
      const env = { HOME: tmpHome, USERPROFILE: tmpHome, ...NO_CI_ENV };

      assert.strictEqual(runCli(['--disable'], { cwd: sub, env }).exitCode, 0);
      const result = runCli(['--status'], { cwd: sub, env });
      assert.strictEqual(result.exitCode, 0, result.stdout + result.stderr);
      assert.ok(result.stdout.includes('❌ Disabled'), result.stdout);
      assert.ok(
        result.stdout.includes(`Project config (${join(root, '.blocks', 'config.json')}): telemetry.enabled = false`),
        result.stdout,
      );
    });

    it('--disable outside any project refuses, writes nothing and points at --global', () => {
      const cwd = join(realpathSync(tmpProject), 'loose', 'dir');
      mkdirSync(cwd, { recursive: true });
      const env = { HOME: tmpHome, USERPROFILE: tmpHome, ...NO_CI_ENV };

      const result = runCli(['--disable'], { cwd, env });
      assert.notStrictEqual(result.exitCode, 0, result.stdout + result.stderr);
      assert.ok(!result.stdout.includes('✅'), `must not claim success, got:\n${result.stdout}`);
      assert.ok(result.stderr.includes('--global'), result.stderr);
      assert.ok(result.stderr.includes('AWS_BLOCKS_DISABLE_TELEMETRY=1'), result.stderr);
      assert.ok(!existsSync(join(cwd, '.blocks')), 'must not write a config outside a project');
    });

    it('--disable from a monorepo root without aws-blocks/ refuses instead of claiming success', () => {
      // The workspace root has a package.json but the app (with aws-blocks/) is nested below it,
      // so no project root is found walking up from the workspace root.
      const mono = realpathSync(tmpProject);
      writeFileSync(join(mono, 'package.json'), '{"name":"mono","private":true}');
      const app = join(mono, 'apps', 'web');
      mkdirSync(app, { recursive: true });
      createAppProject(app);
      const env = { HOME: tmpHome, USERPROFILE: tmpHome, ...NO_CI_ENV };

      const result = runCli(['--disable'], { cwd: mono, env });
      assert.notStrictEqual(result.exitCode, 0, result.stdout + result.stderr);
      assert.ok(!result.stdout.includes('✅'), `must not claim success, got:\n${result.stdout}`);
      assert.ok(result.stderr.includes('--global'), result.stderr);
      assert.ok(result.stderr.includes('AWS_BLOCKS_DISABLE_TELEMETRY=1'), result.stderr);
      assert.ok(!existsSync(join(mono, '.blocks')), 'must not write an opt-out the app never reads');
      // Nothing changed for the nested app, and the command did not say otherwise.
      assert.strictEqual(runGate({ cwd: app, env }), true);
    });

    it('--disable --global from a monorepo root still opts out the nested app', () => {
      const mono = realpathSync(tmpProject);
      writeFileSync(join(mono, 'package.json'), '{"name":"mono","private":true}');
      const app = join(mono, 'apps', 'web');
      mkdirSync(app, { recursive: true });
      createAppProject(app);
      const env = { HOME: tmpHome, USERPROFILE: tmpHome, ...NO_CI_ENV };

      const result = runCli(['--disable', '--global'], { cwd: mono, env });
      assert.strictEqual(result.exitCode, 0, result.stdout + result.stderr);
      assert.ok(result.stdout.includes('disabled globally'), result.stdout);
      assert.strictEqual(runGate({ cwd: app, env }), false);
    });

    it('--enable and --status outside any project still use the working directory', () => {
      const cwd = join(realpathSync(tmpProject), 'loose', 'dir');
      mkdirSync(cwd, { recursive: true });
      const env = { HOME: tmpHome, USERPROFILE: tmpHome, ...NO_CI_ENV };

      assert.strictEqual(runCli(['--enable'], { cwd, env }).exitCode, 0);
      assert.strictEqual(JSON.parse(readFileSync(join(cwd, '.blocks', 'config.json'), 'utf-8')).telemetry.enabled, true);
      const status = runCli(['--status'], { cwd, env });
      assert.strictEqual(status.exitCode, 0);
      assert.ok(status.stdout.includes(`Project config (${join(cwd, '.blocks', 'config.json')})`), status.stdout);
    });
  });

  describe('--disable verifies the effect before reporting success', () => {
    // A config.json that swallows writes: the write succeeds but reads back empty, so the
    // opt-out never reaches the send gate. POSIX-only (needs /dev/null and symlinks).
    it('prints no success line when the opt-out does not read back', { skip: process.platform === 'win32' }, () => {
      const { root } = createAppProject(tmpProject);
      mkdirSync(join(root, '.blocks'));
      symlinkSync('/dev/null', join(root, '.blocks', 'config.json'));
      const env = { HOME: tmpHome, USERPROFILE: tmpHome, ...NO_CI_ENV };

      const result = runCli(['--disable'], { cwd: root, env });
      assert.notStrictEqual(result.exitCode, 0, result.stdout + result.stderr);
      assert.ok(!result.stdout.includes('✅'), `must not claim success, got:\n${result.stdout}`);
      assert.ok(result.stderr.includes('still enabled'), result.stderr);
      assert.strictEqual(runGate({ cwd: root, env }), true);
    });

    it('prints the success line once the opt-out reads back disabled', () => {
      const { root } = createAppProject(tmpProject);
      const env = { HOME: tmpHome, USERPROFILE: tmpHome, ...NO_CI_ENV };

      const result = runCli(['--disable'], { cwd: root, env });
      assert.strictEqual(result.exitCode, 0, result.stdout + result.stderr);
      assert.ok(result.stdout.includes('✅ Telemetry disabled for this project.'), result.stdout);
      assert.strictEqual(runGate({ cwd: root, env }), false);
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
