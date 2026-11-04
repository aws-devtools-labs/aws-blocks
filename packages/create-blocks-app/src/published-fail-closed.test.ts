import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// A scaffold that cannot establish a version must fail, not fall back to the
// `"*"` placeholder. `"*"` is a valid range, so a project carrying it installs
// whatever is newest on every clean install — including a breaking release.
// Nothing may be written until the versions are known.

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');

// A registry that cannot answer, with retries off so the failure is immediate.
const UNREACHABLE_REGISTRY = {
  npm_config_registry: 'http://127.0.0.1:1/',
  npm_config_fetch_retries: '0',
  npm_config_fetch_retry_mintimeout: '1',
  npm_config_fetch_retry_maxtimeout: '5',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
};

let workDir: string;
let cliPath: string;

before(() => {
  // Lay the package out the way npm installs it: outside the monorepo, so the
  // CLI takes its published path rather than rewriting deps to file: paths.
  workDir = mkdtempSync(join(tmpdir(), 'blocks-failclosed-'));
  const installed = join(workDir, 'node_modules', '@aws-blocks', 'create-blocks-app');
  for (const entry of ['dist', 'templates', 'resources', 'package.json']) {
    const from = join(PKG_ROOT, entry);
    if (existsSync(from)) cpSync(from, join(installed, entry), { recursive: true });
  }
  // The published CLI's runtime dependencies, which npm would have installed.
  for (const dep of ['ci-info']) {
    const from = join(PKG_ROOT, '..', '..', 'node_modules', dep);
    if (existsSync(from)) cpSync(from, join(workDir, 'node_modules', dep), { recursive: true });
  }
  cliPath = join(installed, 'dist', 'index.js');
});

after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe('a published scaffold that cannot reach the registry', () => {
  it('fails, names the package it could not resolve, and leaves no project behind', () => {
    const targetDir = join(workDir, 'my-app');

    const result = spawnSync(process.execPath, [cliPath, targetDir, '--template', 'bare', '--yes', '--skip-install'], {
      encoding: 'utf-8',
      env: { ...process.env, ...UNREACHABLE_REGISTRY },
      timeout: 120_000,
    });

    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.notStrictEqual(result.status, 0, `expected a non-zero exit, got ${result.status}\n${output}`);
    assert.match(output, /@aws-blocks\/blocks/, `expected the message to name the package\n${output}`);
    assert.ok(
      !existsSync(join(targetDir, 'package.json')),
      'a project was written even though no version could be resolved',
    );
  });
});
