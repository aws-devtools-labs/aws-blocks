// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end tests of `vendorize()` against a throwaway app. Each run happens
 * in a child process (vendorize exits the process on errors), with a fake
 * `npm` on PATH: `npm install` links the workspaces into node_modules as npm
 * does, and `npm pack` serves the "published" fixture package.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENDORIZE_ENTRY = pathToFileURL(join(__dirname, 'index.js')).href;
const TSX_DIR = dirname(createRequire(import.meta.url).resolve('tsx/package.json'));
const PKG = '@aws-blocks/bb-fake';

const root = mkdtempSync(join(tmpdir(), 'vendorize-run-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

const FAKE_NPM = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, readFileSync, rmSync, symlinkSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { dirname, join, relative } = require('node:path');
const [cmd, ...args] = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPM_LOG, [cmd, ...args].join(' ') + '\\n');
if (cmd === 'install') {
  if (process.env.FAKE_NPM_INSTALL_FAIL) { console.error('npm error install failed'); process.exit(1); }
  for (const ws of JSON.parse(readFileSync('package.json', 'utf-8')).workspaces) {
    const name = JSON.parse(readFileSync(join(ws, 'package.json'), 'utf-8')).name;
    const link = join('node_modules', ...name.split('/'));
    rmSync(link, { recursive: true, force: true });
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(relative(dirname(link), ws), link);
  }
} else if (cmd === 'pack') {
  if (process.env.FAKE_NPM_PACK_FAIL) { console.error('npm error 404 Not Found - ' + args[0]); process.exit(1); }
  const dest = args[args.indexOf('--pack-destination') + 1];
  execFileSync('tar', ['-czf', join(dest, 'aws-blocks-bb-fake-1.2.3.tgz'), 'package'], { cwd: process.env.FAKE_NPM_PUBLISHED });
}
`;

/** Write the published package (as it ships: package.json, src/, dist/) into `dir`. */
function writePublishedPackage(dir: string): void {
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: PKG,
    version: '1.2.3',
    type: 'module',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    bin: { 'bb-fake': './dist/cli.js' },
    dependencies: { 'some-dep': '^1.0.0' },
    devDependencies: { '@types/some-dep': '^1.0.0', typescript: '^5.0.0' },
  }));
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const SOURCE = "published";\n');
  writeFileSync(join(dir, 'src', 'greet.ts'), 'export const greet = (name: string): string => `Hello, ${name}`;\n');
  writeFileSync(join(dir, 'src', 'cli.ts'), "import { greet } from './greet.js';\nconsole.log(greet(process.argv[2] ?? 'world'));\n");
  writeFileSync(join(dir, 'dist', 'cli.js'), "console.log('dist build');\n");
}

let appCount = 0;

/** A fresh app with the published package installed in node_modules. */
function makeApp(): string {
  const app = join(root, `app-${++appCount}`);
  mkdirSync(join(app, 'aws-blocks'), { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({
    name: 'app', private: true, workspaces: ['aws-blocks'], devDependencies: { tsx: '^4.20.0' },
  }, null, 2) + '\n');
  writeFileSync(join(app, 'aws-blocks', 'package.json'), JSON.stringify({ name: 'app-backend', private: true }));
  writePublishedPackage(join(app, 'node_modules', '@aws-blocks', 'bb-fake'));
  symlinkSync(TSX_DIR, join(app, 'node_modules', 'tsx'));
  const published = join(app, '.published');
  writePublishedPackage(join(published, 'package'));
  const fakeBin = join(app, '.fake-bin');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'npm'), FAKE_NPM, { mode: 0o755 });
  writeFileSync(join(app, '.npm-log'), '');
  return app;
}

function runVendorize(app: string, { force = false, env = {} }: { force?: boolean; env?: Record<string, string> } = {}) {
  const script = `import { vendorize } from ${JSON.stringify(VENDORIZE_ENTRY)};
vendorize(${JSON.stringify(PKG)}, { force: ${force} });`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: app,
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${join(app, '.fake-bin')}${delimiter}${process.env.PATH}`,
      FAKE_NPM_LOG: join(app, '.npm-log'),
      FAKE_NPM_PUBLISHED: join(app, '.published'),
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** An app with the package vendorized and its vendored index.ts customized. */
function vendorizedApp(): string {
  const app = makeApp();
  const first = runVendorize(app);
  assert.strictEqual(first.status, 0, first.stderr);
  appendFileSync(join(app, 'vendor', 'bb-fake', 'src', 'index.ts'), '// my customization\n');
  return app;
}

const read = (app: string, path: string) => readFileSync(join(app, path), 'utf-8');
const vendorEntries = (app: string) => readdirSync(join(app, 'vendor')).sort();

describe('vendorize', () => {
  test('copies src/, keeps the bin commands and the @types devDependencies', () => {
    const app = makeApp();
    const { status, stderr } = runVendorize(app);
    assert.strictEqual(status, 0, stderr);

    const pkg = JSON.parse(read(app, 'vendor/bb-fake/package.json'));
    assert.deepStrictEqual(pkg.bin, { 'bb-fake': './bin/bb-fake.js' });
    assert.deepStrictEqual(pkg.devDependencies, { '@types/some-dep': '^1.0.0' });
    assert.deepStrictEqual(pkg.dependencies, { 'some-dep': '^1.0.0', tsx: '^4.20.0' });
    assert.strictEqual(pkg.exports['.'].default, './src/index.ts');
    assert.ok(existsSync(join(app, 'vendor/bb-fake/src/cli.ts')));
    assert.ok(existsSync(join(app, 'vendor/bb-fake/VENDORIZE.md')));
    assert.deepStrictEqual(JSON.parse(read(app, 'package.json')).workspaces, ['aws-blocks', 'vendor/bb-fake']);
    assert.strictEqual(realpathSync(join(app, 'node_modules/@aws-blocks/bb-fake')), realpathSync(join(app, 'vendor/bb-fake')));
    assert.deepStrictEqual(vendorEntries(app), ['bb-fake']);
  });

  test('the kept bin runs the vendorized source', () => {
    const app = makeApp();
    assert.strictEqual(runVendorize(app).status, 0);
    const shim = join(app, 'vendor/bb-fake/bin/bb-fake.js');
    const run = () => spawnSync(process.execPath, [shim, 'Blocks'], { cwd: app, encoding: 'utf-8' }).stdout.trim();

    assert.strictEqual(run(), 'Hello, Blocks');
    writeFileSync(join(app, 'vendor/bb-fake/src/greet.ts'), 'export const greet = (name: string): string => `Hi, ${name}`;\n');
    assert.strictEqual(run(), 'Hi, Blocks');
  });

  test('--force re-copies the published package when node_modules links to the vendored copy', () => {
    const app = vendorizedApp();
    const { status, stdout, stderr } = runVendorize(app, { force: true });

    assert.strictEqual(status, 0, stderr);
    assert.match(stdout, /downloading the published @aws-blocks\/bb-fake@1\.2\.3/);
    assert.match(read(app, '.npm-log'), /^pack @aws-blocks\/bb-fake@1\.2\.3 --pack-destination /m);
    assert.strictEqual(read(app, 'vendor/bb-fake/src/index.ts'), 'export const SOURCE = "published";\n');
    assert.deepStrictEqual(JSON.parse(read(app, 'vendor/bb-fake/package.json')).bin, { 'bb-fake': './bin/bb-fake.js' });
    assert.deepStrictEqual(vendorEntries(app), ['bb-fake']);
    assert.strictEqual(realpathSync(join(app, 'node_modules/@aws-blocks/bb-fake')), realpathSync(join(app, 'vendor/bb-fake')));
  });

  test('--force keeps the vendored copy when the published package cannot be downloaded', () => {
    const app = vendorizedApp();
    const appPkg = read(app, 'package.json');
    const { status, stderr } = runVendorize(app, { force: true, env: { FAKE_NPM_PACK_FAIL: '1' } });

    assert.strictEqual(status, 1);
    assert.match(stderr, /Could not download the published @aws-blocks\/bb-fake@1\.2\.3/);
    assert.match(stderr, /npm error 404/);
    assert.match(stderr, /vendor\/bb-fake\/ is untouched/);
    assert.match(read(app, 'vendor/bb-fake/src/index.ts'), /my customization/);
    assert.strictEqual(read(app, 'package.json'), appPkg);
    assert.deepStrictEqual(vendorEntries(app), ['bb-fake']);
  });

  test('--force restores the vendored copy when npm install fails', () => {
    const app = vendorizedApp();
    const appPkg = read(app, 'package.json');
    const { status, stderr } = runVendorize(app, { force: true, env: { FAKE_NPM_INSTALL_FAIL: '1' } });

    assert.strictEqual(status, 1);
    assert.match(stderr, /Restored the previous vendor\/bb-fake\/ and package\.json/);
    assert.match(read(app, 'vendor/bb-fake/src/index.ts'), /my customization/);
    assert.strictEqual(read(app, 'package.json'), appPkg);
    assert.deepStrictEqual(vendorEntries(app), ['bb-fake']);
  });

  test('without --force refuses and changes nothing', () => {
    const app = vendorizedApp();
    const { status, stderr } = runVendorize(app);

    assert.strictEqual(status, 1);
    assert.match(stderr, /already vendorized at vendor\/bb-fake\//);
    assert.match(read(app, 'vendor/bb-fake/src/index.ts'), /my customization/);
  });

  test('a first vendorize rolls back when npm install fails', () => {
    const app = makeApp();
    const appPkg = read(app, 'package.json');
    const { status, stderr } = runVendorize(app, { env: { FAKE_NPM_INSTALL_FAIL: '1' } });

    assert.strictEqual(status, 1);
    assert.match(stderr, /Removed the partial vendor\/bb-fake\/ and restored package\.json/);
    assert.strictEqual(read(app, 'package.json'), appPkg);
    assert.deepStrictEqual(vendorEntries(app), []);
  });
});
