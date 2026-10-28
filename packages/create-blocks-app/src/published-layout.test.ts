// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Runs the CLI from a copy laid out the way npm installs it (outside the
// monorepo), so the published path is exercised, not the in-monorepo `file:`
// rewrite the other CLI tests hit. A customer running `npx` gets this path.

import { describe, it, before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(__dirname, '..');
const require = createRequire(import.meta.url);

type Manifest = {
  files?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  blocksTemplateOverlayOnly?: boolean;
};

const readManifest = (path: string): Manifest => JSON.parse(readFileSync(path, 'utf-8'));
const cliManifest = readManifest(join(PKG_DIR, 'package.json'));

/** The `@aws-blocks/*` entries of a manifest's dependencies and devDependencies. */
function blocksDeps(pkg: Manifest): [string, string][] {
  return [...Object.entries(pkg.dependencies ?? {}), ...Object.entries(pkg.devDependencies ?? {})]
    .filter(([name]) => name.startsWith('@aws-blocks/'));
}

/** Assert every `@aws-blocks/*` dependency carries the range the CLI ships for it. */
function assertStamped(pkg: Manifest, label: string): void {
  const deps = blocksDeps(pkg);
  assert.ok(deps.length > 0, `${label}: expected at least one @aws-blocks/* dependency`);
  for (const [name, range] of deps) {
    assert.notStrictEqual(range, '*', `${label}: ${name} is still the "*" placeholder`);
    assert.strictEqual(
      range,
      cliManifest.devDependencies?.[name],
      `${label}: ${name} should be stamped with create-blocks-app's devDependency range`,
    );
  }
}

let root: string;
let cli: string;

/**
 * Copy what `npm publish` ships (the package.json `files` list plus the
 * manifest) into `<tmp>/node_modules/@aws-blocks/create-blocks-app`, next to
 * the CLI's one runtime dependency. Nothing in that tree has a sibling
 * `core/package.json`, so the CLI takes its published-registry path.
 */
before(() => {
  root = mkdtempSync(join(tmpdir(), 'cba-published-'));
  const dest = join(root, 'node_modules', '@aws-blocks', 'create-blocks-app');
  for (const entry of ['package.json', ...(cliManifest.files ?? [])]) {
    if (existsSync(join(PKG_DIR, entry))) cpSync(join(PKG_DIR, entry), join(dest, entry), { recursive: true });
  }
  symlinkSync(dirname(require.resolve('ci-info/package.json')), join(root, 'node_modules', 'ci-info'), 'junction');
  cli = join(dest, 'dist', 'index.js');
});

after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

function run(args: string[], cwd: string): { output: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [cli, ...args], {
      encoding: 'utf-8',
      timeout: 30000,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AWS_BLOCKS_DISABLE_TELEMETRY: '1',
        BLOCKS_TELEMETRY_ENDPOINT: 'http://127.0.0.1:1/noop',
      },
    });
    return { output: stdout, exitCode: 0 };
  } catch (err: any) {
    return { output: `${err.stdout ?? ''}${err.stderr ?? ''}`, exitCode: err.status ?? 1 };
  }
}

describe('create-blocks-app version stamping from the published package', () => {
  it('stamps every @aws-blocks/* dependency of every fresh template', () => {
    const templatesDir = join(PKG_DIR, 'templates');
    const templates = readdirSync(templatesDir).filter((name) => {
      const pkgPath = join(templatesDir, name, 'package.json');
      return existsSync(pkgPath) && !readManifest(pkgPath).blocksTemplateOverlayOnly;
    });
    assert.ok(templates.length > 0, 'expected at least one fresh template');

    for (const template of templates) {
      const app = join(root, `fresh-${template}`);
      const result = run([app, '--template', template, '--skip-install'], root);
      assert.strictEqual(result.exitCode, 0, `${template}: ${result.output}`);
      assertStamped(readManifest(join(app, 'package.json')), `template ${template}`);
    }
  });

  it('stamps @aws-blocks/blocks when adding Blocks to an existing project', () => {
    const project = join(root, 'existing');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'existing', version: '1.0.0' }));

    const result = run(['.', '--yes', '--skip-install'], project);
    assert.strictEqual(result.exitCode, 0, result.output);
    const pkg = readManifest(join(project, 'package.json'));
    assertStamped(pkg, 'existing project');
    assert.ok(pkg.dependencies?.['@aws-blocks/blocks'], 'existing project should depend on @aws-blocks/blocks');
  });

  it('keeps an @aws-blocks/* range the existing project already declares', () => {
    const project = join(root, 'existing-pinned');
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({ name: 'existing-pinned', version: '1.0.0', dependencies: { '@aws-blocks/blocks': '~0.1.0' } }),
    );

    const result = run(['.', '--yes', '--skip-install'], project);
    assert.strictEqual(result.exitCode, 0, result.output);
    assert.strictEqual(readManifest(join(project, 'package.json')).dependencies?.['@aws-blocks/blocks'], '~0.1.0');
  });

  it('stamps the root and the aws-blocks/ workspace when adding Blocks to an Amplify Gen 2 project', () => {
    const project = join(root, 'amplify-app');
    mkdirSync(join(project, 'amplify'), { recursive: true });
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'amplify-app', version: '1.0.0' }));
    writeFileSync(join(project, 'amplify', 'backend.ts'), 'const backend = defineBackend({});\n');

    const result = run(['.', '--yes', '--skip-install'], project);
    assert.strictEqual(result.exitCode, 0, result.output);
    assertStamped(readManifest(join(project, 'package.json')), 'Amplify project root');
    const workspace = readManifest(join(project, 'aws-blocks', 'package.json'));
    assertStamped(workspace, 'Amplify aws-blocks/ workspace');
    assert.ok(workspace.dependencies?.['@aws-blocks/bb-kv-store'], 'the Amplify workspace should depend on bb-kv-store');
  });
});
