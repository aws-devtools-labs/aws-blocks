// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { getTelemetryStatus, getGlobalConfigPath, getProjectConfigPath } from './consent.js';
import { writeConfigTelemetry } from './config-writer.js';

describe('getTelemetryStatus', () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();

  afterEach(() => {
    process.env = { ...originalEnv };
    process.chdir(originalCwd);
  });

  function clearCIVars(): void {
    delete process.env.CI;
    delete process.env.CONTINUOUS_INTEGRATION;
    delete process.env.BUILD_NUMBER;
    delete process.env.CODEBUILD_BUILD_ID;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITLAB_CI;
    delete process.env.CIRCLECI;
    delete process.env.JENKINS_URL;
    delete process.env.TF_BUILD;
    delete process.env.BITBUCKET_BUILD_NUMBER;
    delete process.env.BUILDKITE;
  }

  it('returns enabled=true when no config exists and not in CI', () => {
    delete process.env.AWS_BLOCKS_DISABLE_TELEMETRY;
    clearCIVars();
    const tmp = join(tmpdir(), `blocks-status-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    process.chdir(tmp);

    const status = getTelemetryStatus();
    assert.strictEqual(status.enabled, true);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns enabled=false when AWS_BLOCKS_DISABLE_TELEMETRY=1', () => {
    process.env.AWS_BLOCKS_DISABLE_TELEMETRY = '1';
    const tmp = join(tmpdir(), `blocks-status-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    process.chdir(tmp);

    const status = getTelemetryStatus();
    assert.strictEqual(status.enabled, false);
    assert.strictEqual(status.envVar, '1');
    rmSync(tmp, { recursive: true, force: true });
  });

  for (const value of ['true', 'TRUE', 'yes', ' true ']) {
    it(`returns enabled=false when AWS_BLOCKS_DISABLE_TELEMETRY=${JSON.stringify(value)}`, () => {
      process.env.AWS_BLOCKS_DISABLE_TELEMETRY = value;
      clearCIVars();
      const tmp = join(tmpdir(), `blocks-status-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(tmp, { recursive: true });
      process.chdir(tmp);

      const status = getTelemetryStatus();
      assert.strictEqual(status.enabled, false);
      assert.strictEqual(status.envVar, value);
      rmSync(tmp, { recursive: true, force: true });
    });
  }

  it('returns enabled=false when project config disables', () => {
    delete process.env.AWS_BLOCKS_DISABLE_TELEMETRY;
    clearCIVars();
    const tmp = join(tmpdir(), `blocks-status-test-${Date.now()}`);
    mkdirSync(join(tmp, '.blocks'), { recursive: true });
    writeFileSync(join(tmp, '.blocks', 'config.json'), JSON.stringify({ telemetry: { enabled: false } }));
    process.chdir(tmp);

    const status = getTelemetryStatus();
    assert.strictEqual(status.enabled, false);
    assert.strictEqual(status.projectConfig, false);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('any disable wins — global disabled even if project enables', () => {
    delete process.env.AWS_BLOCKS_DISABLE_TELEMETRY;
    clearCIVars();
    const tmp = join(tmpdir(), `blocks-status-test-${Date.now()}`);
    const home = join(tmp, 'home');
    const project = join(tmp, 'project');
    mkdirSync(join(home, '.blocks'), { recursive: true });
    mkdirSync(join(project, '.blocks'), { recursive: true });
    writeFileSync(join(home, '.blocks', 'config.json'), JSON.stringify({ telemetry: { enabled: false } }));
    writeFileSync(join(project, '.blocks', 'config.json'), JSON.stringify({ telemetry: { enabled: true } }));

    // Driven in a child process: afterEach replaces `process.env`, so setting HOME here would not reach homedir().
    const consentUrl = new URL('./consent.js', import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', 'const { getTelemetryStatus } = await import(process.argv[1]); process.stdout.write(JSON.stringify(getTelemetryStatus()));', consentUrl],
      { encoding: 'utf-8', cwd: project, env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '' } },
    );
    rmSync(tmp, { recursive: true, force: true });

    assert.strictEqual(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.strictEqual(status.enabled, false);
    assert.strictEqual(status.globalConfig, false);
    assert.strictEqual(status.projectConfig, true);
  });

  it('env var disables even when project config enables', () => {
    process.env.AWS_BLOCKS_DISABLE_TELEMETRY = '1';
    const tmp = join(tmpdir(), `blocks-status-test-${Date.now()}`);
    mkdirSync(join(tmp, '.blocks'), { recursive: true });
    writeFileSync(join(tmp, '.blocks', 'config.json'), JSON.stringify({ telemetry: { enabled: true } }));
    process.chdir(tmp);

    const status = getTelemetryStatus();
    assert.strictEqual(status.enabled, false);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns enabled=true in CI environment (CI does not suppress telemetry)', () => {
    delete process.env.AWS_BLOCKS_DISABLE_TELEMETRY;
    process.env.CI = 'true';
    const tmp = join(tmpdir(), `blocks-status-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    process.chdir(tmp);

    const status = getTelemetryStatus();
    assert.strictEqual(status.enabled, true);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe('writeConfigTelemetry', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `blocks-writer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a new config file with telemetry.enabled', () => {
    const configPath = join(tmpDir, '.blocks', 'config.json');
    writeConfigTelemetry(configPath, true);

    assert.ok(existsSync(configPath));
    const content = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.strictEqual(content.telemetry.enabled, true);
  });

  it('writes telemetry.enabled=false', () => {
    const configPath = join(tmpDir, '.blocks', 'config.json');
    writeConfigTelemetry(configPath, false);

    const content = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.strictEqual(content.telemetry.enabled, false);
  });

  it('preserves existing keys when writing', () => {
    const configPath = join(tmpDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ telemetry: { projectId: 'abc-123' }, other: 'data' }, null, 2));

    writeConfigTelemetry(configPath, false);

    const content = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.strictEqual(content.telemetry.enabled, false);
    assert.strictEqual(content.telemetry.projectId, 'abc-123');
    assert.strictEqual(content.other, 'data');
  });

  it('creates parent directories if they do not exist', () => {
    const configPath = join(tmpDir, 'deep', 'nested', 'config.json');
    writeConfigTelemetry(configPath, true);

    assert.ok(existsSync(configPath));
    const content = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.strictEqual(content.telemetry.enabled, true);
  });

  it('overwrites telemetry.enabled without affecting other telemetry keys', () => {
    const configPath = join(tmpDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ telemetry: { enabled: true, projectId: 'xyz' } }));

    writeConfigTelemetry(configPath, false);

    const content = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.strictEqual(content.telemetry.enabled, false);
    assert.strictEqual(content.telemetry.projectId, 'xyz');
  });
});

describe('getProjectConfigPath', () => {
  it('uses cwd by default', () => {
    const result = getProjectConfigPath();
    assert.ok(result.endsWith('.blocks/config.json'));
    assert.ok(result.startsWith(process.cwd()));
  });

  it('accepts a custom project root', () => {
    const custom = '/some/custom/path';
    const result = getProjectConfigPath(custom);
    assert.ok(result.startsWith(custom));
    assert.ok(result.endsWith('.blocks/config.json'));
  });
});

describe('getGlobalConfigPath', () => {
  it('uses homedir', () => {
    const result = getGlobalConfigPath();
    assert.ok(result.endsWith('.blocks/config.json'));
  });
});
