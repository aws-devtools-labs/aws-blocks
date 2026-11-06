// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { DEFAULT_TSX_RANGE, generateBinShim, generatePackageJson, vendorBins } from './generate.js';

/** The fields of the generated package.json these tests read. */
interface GeneratedPackageJson {
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  exports?: unknown;
}

const generate = (...args: Parameters<typeof generatePackageJson>) => generatePackageJson(...args) as GeneratedPackageJson;

const bbData = {
  name: '@aws-blocks/bb-data',
  version: '0.4.0',
  type: 'module',
  bin: { 'bb-data': './dist/cli.js' },
  exports: { '.': { cdk: { types: './dist/index.cdk.d.ts', default: './dist/index.cdk.js' }, default: './dist/index.mock.js' } },
  dependencies: { pg: '^8.23.1' },
  peerDependencies: { 'aws-cdk-lib': '^2.257.0' },
  devDependencies: { '@types/pg': '^8.23.1', '@types/node': '^20.19.43', typescript: '^5.9.3' },
};

describe('vendorBins', () => {
  test('maps dist/ bins onto a shim that runs the src/ entry', () => {
    assert.deepStrictEqual(vendorBins(bbData), [{ name: 'bb-data', shim: './bin/bb-data.js', entry: './src/cli.ts' }]);
  });

  test('names a string bin after the unscoped package name', () => {
    assert.deepStrictEqual(vendorBins({ name: '@aws-blocks/bb-x', bin: 'dist/cli.js' }), [
      { name: 'bb-x', shim: './bin/bb-x.js', entry: './src/cli.ts' },
    ]);
  });

  test('leaves out bins outside dist/ and packages without bins', () => {
    assert.deepStrictEqual(vendorBins({ name: 'x', bin: { x: './scripts/x.mjs' } }), []);
    assert.deepStrictEqual(vendorBins({ name: 'x' }), []);
  });
});

describe('generatePackageJson', () => {
  test('points bins at their shims and adds tsx at the given range', () => {
    const pkg = generate(bbData, vendorBins(bbData), '^4.23.15');
    assert.deepStrictEqual(pkg.bin, { 'bb-data': './bin/bb-data.js' });
    assert.deepStrictEqual(pkg.dependencies, { pg: '^8.23.1', tsx: '^4.23.15' });
  });

  test('uses the default tsx range when none is given, and keeps a declared tsx', () => {
    const bins = vendorBins(bbData);
    assert.strictEqual(generate(bbData, bins).dependencies?.tsx, DEFAULT_TSX_RANGE);
    const withTsx = { ...bbData, dependencies: { tsx: '^4.1.0' } };
    assert.strictEqual(generate(withTsx, bins, '^4.23.15').dependencies?.tsx, '^4.1.0');
  });

  test('keeps only the @types/* devDependencies', () => {
    const pkg = generate(bbData);
    assert.deepStrictEqual(pkg.devDependencies, { '@types/pg': '^8.23.1', '@types/node': '^20.19.43' });
    assert.strictEqual(generate({ ...bbData, devDependencies: { typescript: '^5' } }).devDependencies, undefined);
  });

  test('without bins adds neither bin nor tsx', () => {
    const pkg = generate(bbData);
    assert.strictEqual(pkg.bin, undefined);
    assert.deepStrictEqual(pkg.dependencies, { pg: '^8.23.1' });
    assert.deepStrictEqual(pkg.peerDependencies, { 'aws-cdk-lib': '^2.257.0' });
  });

  test('remaps exports from dist/ to src/', () => {
    const pkg = generate(bbData);
    assert.deepStrictEqual(pkg.exports, {
      '.': { cdk: { types: './src/index.cdk.ts', default: './src/index.cdk.ts' }, default: './src/index.mock.ts' },
    });
  });
});

describe('generateBinShim', () => {
  test('registers tsx before importing the src/ entry', () => {
    const shim = generateBinShim({ name: 'bb-data', shim: './bin/bb-data.js', entry: './src/cli.ts' });
    assert.ok(shim.startsWith('#!/usr/bin/env node\n'));
    assert.ok(shim.indexOf('register();') < shim.indexOf("await import('../src/cli.ts');"));
    assert.match(shim, /import \{ register \} from 'tsx\/esm\/api';/);
  });
});
