// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert';
import { minimatch } from 'minimatch';
import { blocksPackageDir, isBlocksPackage, resolveStampedVersions, stampBlocksVersions } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(__dirname, '..');
const PACKAGES_DIR = join(PKG_DIR, '..');

type Manifest = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const readManifest = (path: string): Manifest => JSON.parse(readFileSync(path, 'utf-8'));

/** Why `range` is not a caret range on the current release line of package `name`, or null when it is. */
function releaseLineProblem(name: string, range: string | undefined): string | null {
  const current = readManifest(join(PACKAGES_DIR, blocksPackageDir(name), 'package.json'));
  if (current.name !== name) return `${name}: no package at packages/${blocksPackageDir(name)}`;
  // An optional prerelease suffix keeps changesets pre mode (`^0.9.0-next.1`) working.
  const match = /^\^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(range ?? '');
  if (!match) return `${name}: expected a caret range, got "${range}"`;
  const [major, minor] = (current.version ?? '').split('.').map(Number);
  const line = major === 0 ? `0.${minor}` : `${major}`;
  const rangeLine = match[1] === '0' ? `0.${match[2]}` : match[1];
  return rangeLine === line ? null : `${name}: "${range}" is not on the ${current.version} release line`;
}

/** Every package.json under `dir`, at any depth (templates nest a cdk-blocks/ workspace). */
function findManifests(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return findManifests(path);
    return entry.name === 'package.json' ? [path] : [];
  });
}

describe('resolveStampedVersions', () => {
  it('returns the @aws-cdk-blocks/* devDependency ranges and nothing else', () => {
    const versions = resolveStampedVersions({
      devDependencies: {
        'aws-cdk-blocks': '^0.8.0',
        '@aws-cdk-blocks/hosting': '^0.4.1',
        '@types/node': '^20.0.0',
      },
    });
    assert.deepStrictEqual(versions, { 'aws-cdk-blocks': '^0.8.0', '@aws-cdk-blocks/hosting': '^0.4.1' });
  });

  it('throws when the manifest lists no aws-cdk-blocks devDependency', () => {
    assert.throws(() => resolveStampedVersions({}), /no aws-cdk-blocks or @aws-cdk-blocks\/\* devDependencies/);
    assert.throws(
      () => resolveStampedVersions({ devDependencies: { typescript: '^5.0.0' } }),
      /no aws-cdk-blocks or @aws-cdk-blocks\/\* devDependencies/,
    );
  });

  it('throws when a devDependency range would stamp nothing useful', () => {
    assert.throws(
      () => resolveStampedVersions({ devDependencies: { 'aws-cdk-blocks': '*' } }),
      /aws-cdk-blocks/,
    );
    assert.throws(
      () => resolveStampedVersions({ devDependencies: { 'aws-cdk-blocks': '' } }),
      /aws-cdk-blocks/,
    );
  });
});

describe('stampBlocksVersions', () => {
  const versions = { 'aws-cdk-blocks': '^0.8.0', '@aws-cdk-blocks/hosting': '^0.4.1' };

  it('replaces each "*" placeholder for an @aws-cdk-blocks/* package with its range', () => {
    const deps = { 'aws-cdk-blocks': '*', '@aws-cdk-blocks/hosting': '*', zod: '^4.0.0' };
    stampBlocksVersions(deps, versions);
    assert.deepStrictEqual(deps, {
      'aws-cdk-blocks': '^0.8.0',
      '@aws-cdk-blocks/hosting': '^0.4.1',
      zod: '^4.0.0',
    });
  });

  it('leaves concrete ranges, file: paths and non-@aws-cdk-blocks placeholders alone', () => {
    const deps = { 'aws-cdk-blocks': '~0.1.0', '@aws-cdk-blocks/hosting': 'file:../hosting', other: '*' };
    stampBlocksVersions(deps, versions);
    assert.deepStrictEqual(deps, { 'aws-cdk-blocks': '~0.1.0', '@aws-cdk-blocks/hosting': 'file:../hosting', other: '*' });
  });

  it('accepts a missing dependency map', () => {
    assert.doesNotThrow(() => stampBlocksVersions(undefined, versions));
  });

  it('throws, naming the package, for a placeholder it has no range for', () => {
    assert.throws(
      () => stampBlocksVersions({ '@aws-cdk-blocks/bb-unknown': '*' }, versions),
      /@aws-cdk-blocks\/bb-unknown/,
    );
  });
});

describe('create-blocks-app stamped package inventory', () => {
  const cliDevDeps = readManifest(join(PKG_DIR, 'package.json')).devDependencies ?? {};

  it('lists every @aws-cdk-blocks/* package a template writes as a devDependency', () => {
    for (const manifest of findManifests(join(PKG_DIR, 'templates'))) {
      const pkg = readManifest(manifest);
      for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
        if (!isBlocksPackage(name)) continue;
        assert.ok(cliDevDeps[name], `${manifest} writes ${name}, so create-blocks-app must list it as a devDependency`);
      }
    }
  });

  it('keeps @aws-cdk-blocks/* out of the cdk-blocks/ workspace of every non-overlay template', () => {
    // The add-to-existing path copies templates/<name>/cdk-blocks/ verbatim and
    // stamps only the root manifest, so a dependency declared there would ship as
    // `*`. (The Amplify overlay's workspace is stamped on its own path.)
    const templatesDir = join(PKG_DIR, 'templates');
    for (const name of readdirSync(templatesDir)) {
      const workspace = join(templatesDir, name, 'cdk-blocks', 'package.json');
      if (name === 'amplify' || !existsSync(workspace)) continue;
      const pkg = readManifest(workspace);
      const blocksDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => isBlocksPackage(d));
      assert.deepStrictEqual(blocksDeps, [], `${workspace} must not declare @aws-cdk-blocks/* dependencies`);
    }
  });

  it('stamps a caret range on the current release line of each package', () => {
    // The umbrella publishes unscoped, so a scope test alone would drop the most
    // important stamped range (`aws-cdk-blocks` in create-blocks-app's devDependencies).
    const stamped = Object.entries(cliDevDeps).filter(([name]) => isBlocksPackage(name));
    assert.ok(stamped.length > 0, 'create-blocks-app must list the packages it stamps');
    for (const [name, range] of stamped) {
      const problem = releaseLineProblem(name, range);
      assert.strictEqual(problem, null, problem ?? '');
    }
  });

  it('releases the CLI whenever a stamped package starts a new release line', () => {
    // The fixed group releases the CLI with every blocks release, and changesets
    // releases blocks when another stamped package leaves the caret range blocks
    // declares for it. A stamped package outside blocks' dependencies would not.
    const config = JSON.parse(readFileSync(join(PACKAGES_DIR, '..', '.changeset', 'config.json'), 'utf-8'));
    const group = ['aws-cdk-blocks', '@aws-cdk-blocks/create-blocks-app'];
    const fixed: string[][] = config.fixed ?? [];
    assert.ok(fixed.some((g) => group.every((name) => g.includes(name))), `${group.join(' and ')} must be a changesets fixed group`);
    for (const name of group) {
      assert.ok(!(config.ignore ?? []).some((pattern: string) => minimatch(name, pattern)), `${name} must not be ignored by changesets`);
    }
    const blocksDeps = readManifest(join(PACKAGES_DIR, 'blocks', 'package.json')).dependencies ?? {};
    for (const name of Object.keys(cliDevDeps)) {
      if (!name.startsWith('@aws-cdk-blocks/') || name === 'aws-cdk-blocks') continue;
      const problem = releaseLineProblem(name, blocksDeps[name]);
      assert.strictEqual(problem, null, `${name} is stamped, so aws-cdk-blocks must depend on it with a caret range on its current line (${problem})`);
    }
  });
});

describe("recognising this repo's packages", () => {
  it('recognises the unscoped umbrella and the scoped siblings', () => {
    assert.strictEqual(isBlocksPackage('aws-cdk-blocks'), true);
    assert.strictEqual(isBlocksPackage('@aws-cdk-blocks/core'), true);
  });

  it('rejects a name that merely resembles one', () => {
    for (const name of ['aws-cdk-blocks-foo', 'aws-cdk-lib', '@aws-blocks/core', '@other/aws-cdk-blocks']) {
      assert.strictEqual(isBlocksPackage(name), false, name);
    }
  });

  it('maps a package name to its directory, the umbrella to packages/blocks', () => {
    assert.strictEqual(blocksPackageDir('aws-cdk-blocks'), 'blocks');
    assert.strictEqual(blocksPackageDir('@aws-cdk-blocks/bb-kv-store'), 'bb-kv-store');
  });
});
