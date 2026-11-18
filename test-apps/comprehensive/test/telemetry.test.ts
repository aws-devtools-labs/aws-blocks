// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Telemetry task e2e test.
 *
 * Verifies the `telemetry` task:
 * 1. Bare command shows status
 * 2. --enable writes project config
 * 3. --disable writes project config
 * 4. --enable --global writes global config
 * 5. --disable --global writes global config
 * 6. --help shows usage information
 * 7. Config uses correct nested format { telemetry: { enabled: bool } }
 * 8. Existing keys in config files are preserved
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..');
const TASK = ['--input-type=module', '-e', "import '@aws-blocks/blocks/run'", '--'];

function createTmpDir(): string {
  const dir = join(tmpdir(), `blocks-telemetry-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runTelemetry(args: string, options?: { cwd?: string; env?: Record<string, string> }) {
  // Resolve the package from the installed app, but target the isolated project for consent changes.
  const result = spawnSync(process.execPath, [...TASK, '-C', options?.cwd ?? APP_ROOT, 'telemetry', ...args.split(' ').filter(Boolean)], {
    cwd: APP_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, ...options?.env, USERPROFILE: options?.env?.HOME },
  });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 };
}

describe('Telemetry task e2e', () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeEach(() => {
    tmpHome = createTmpDir();
    tmpProject = createTmpDir();
    writeFileSync(join(tmpProject, 'package.json'), '{}');
    mkdirSync(join(tmpProject, 'aws-blocks'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
  });

  test('bare command shows status', () => {
    const result = runTelemetry('', { cwd: tmpProject, env: { HOME: tmpHome } });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('Telemetry:'), result.stdout);
  });

  test('--help shows usage information', () => {
    const result = runTelemetry('--help', { cwd: tmpProject, env: { HOME: tmpHome } });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('Usage:'), 'Should show usage header');
    assert.ok(result.stdout.includes('--enable'), 'Should document --enable flag');
    assert.ok(result.stdout.includes('--disable'), 'Should document --disable flag');
    assert.ok(result.stdout.includes('--global'), 'Should document --global flag');
  });

  test('--disable creates project config with telemetry.enabled=false', () => {
    const result = runTelemetry('--disable', { cwd: tmpProject, env: { HOME: tmpHome } });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('disabled for this project'));

    const configPath = join(tmpProject, '.blocks', 'config.json');
    assert.ok(existsSync(configPath), 'Project config should exist');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.strictEqual(config.telemetry.enabled, false);
  });

  test('--enable creates project config with telemetry.enabled=true', () => {
    const result = runTelemetry('--enable', { cwd: tmpProject, env: { HOME: tmpHome } });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('enabled for this project'));

    const configPath = join(tmpProject, '.blocks', 'config.json');
    assert.ok(existsSync(configPath), 'Project config should exist');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.strictEqual(config.telemetry.enabled, true);
  });

  test('--disable --global writes global config with telemetry.enabled=false', () => {
    const result = runTelemetry('--disable --global', { cwd: tmpProject, env: { HOME: tmpHome } });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('disabled globally'));

    const globalConfigPath = join(tmpHome, '.blocks', 'config.json');
    assert.ok(existsSync(globalConfigPath), 'Global config should exist');
    const config = JSON.parse(readFileSync(globalConfigPath, 'utf-8'));
    assert.strictEqual(config.telemetry.enabled, false);
  });

  test('--enable --global writes global config with telemetry.enabled=true', () => {
    const result = runTelemetry('--enable --global', { cwd: tmpProject, env: { HOME: tmpHome } });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('enabled globally'));

    const globalConfigPath = join(tmpHome, '.blocks', 'config.json');
    assert.ok(existsSync(globalConfigPath), 'Global config should exist');
    const config = JSON.parse(readFileSync(globalConfigPath, 'utf-8'));
    assert.strictEqual(config.telemetry.enabled, true);
  });

  test('preserves existing keys in project config', () => {
    const configDir = join(tmpProject, '.blocks');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ telemetry: { projectId: 'test-id-123' }, theme: 'dark' }, null, 2)
    );

    const result = runTelemetry('--disable', { cwd: tmpProject, env: { HOME: tmpHome } });
    assert.strictEqual(result.exitCode, 0);

    const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf-8'));
    assert.strictEqual(config.telemetry.enabled, false);
    assert.strictEqual(config.telemetry.projectId, 'test-id-123');
    assert.strictEqual(config.theme, 'dark');
  });

  test('status reflects disabled state after --disable', () => {
    runTelemetry('--disable', { cwd: tmpProject, env: { HOME: tmpHome } });

    const result = runTelemetry('--status', { cwd: tmpProject, env: { HOME: tmpHome } });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('Disabled'), 'Should show telemetry as disabled');
    assert.ok(result.stdout.includes('Project config'), 'Should show project config as source');
  });

  test('status reflects enabled state after --enable', () => {
    runTelemetry('--enable', { cwd: tmpProject, env: { HOME: tmpHome } });

    const result = runTelemetry('--status', { cwd: tmpProject, env: { HOME: tmpHome } });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('Enabled'), 'Should show telemetry as enabled');
  });
});
