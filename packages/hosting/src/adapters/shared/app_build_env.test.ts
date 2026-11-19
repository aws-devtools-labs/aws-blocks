// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appBuildEnv } from './app_build_env.js';

void describe('appBuildEnv', () => {
  let savedNodeOptions: string | undefined;

  beforeEach(() => {
    savedNodeOptions = process.env.NODE_OPTIONS;
  });

  afterEach(() => {
    if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = savedNodeOptions;
  });

  const nodeOptionsFor = (value: string): string | undefined => {
    process.env.NODE_OPTIONS = value;
    return appBuildEnv().NODE_OPTIONS;
  };

  void it('removes the cdk condition a synth runs with', () => {
    assert.strictEqual(nodeOptionsFor('--conditions=cdk'), '');
  });

  void it('removes every spelling of the cdk condition', () => {
    assert.strictEqual(nodeOptionsFor('--conditions cdk'), '');
    assert.strictEqual(nodeOptionsFor('-C cdk'), '');
    assert.strictEqual(nodeOptionsFor('--conditions=cdk -C cdk'), '');
  });

  void it('removes the cdk condition when its value or the whole entry is in double quotes', () => {
    assert.strictEqual(nodeOptionsFor('--conditions="cdk"'), '');
    assert.strictEqual(nodeOptionsFor('"--conditions=cdk"'), '');
    assert.strictEqual(nodeOptionsFor('-C "cdk"'), '');
    assert.strictEqual(
      nodeOptionsFor('--max-old-space-size=4096 --conditions="cdk" --enable-source-maps'),
      '--max-old-space-size=4096 --enable-source-maps',
    );
  });

  void it('keeps the other NODE_OPTIONS entries, wherever the cdk condition sits', () => {
    assert.strictEqual(nodeOptionsFor('--max-old-space-size=4096 --conditions=cdk'), '--max-old-space-size=4096');
    assert.strictEqual(nodeOptionsFor('--conditions=cdk --max-old-space-size=4096'), '--max-old-space-size=4096');
    assert.strictEqual(
      nodeOptionsFor('--enable-source-maps -C cdk --max-old-space-size=4096'),
      '--enable-source-maps --max-old-space-size=4096',
    );
  });

  void it('keeps conditions other than cdk', () => {
    assert.strictEqual(nodeOptionsFor('--conditions=development'), '--conditions=development');
    assert.strictEqual(nodeOptionsFor('--conditions=cdk-preview'), '--conditions=cdk-preview');
    assert.strictEqual(nodeOptionsFor('--conditions="cdk-preview"'), '--conditions="cdk-preview"');
    assert.strictEqual(
      nodeOptionsFor('--conditions=development --conditions=cdk'),
      '--conditions=development',
    );
  });

  void it('leaves NODE_OPTIONS unset when the parent has none', () => {
    delete process.env.NODE_OPTIONS;
    assert.strictEqual('NODE_OPTIONS' in appBuildEnv(), false);
  });

  void it('applies overrides on top of the current environment', () => {
    process.env.NODE_OPTIONS = '--conditions=cdk';
    const env = appBuildEnv({ NITRO_PRESET: 'aws-lambda' });
    assert.strictEqual(env.NITRO_PRESET, 'aws-lambda');
    assert.strictEqual(env.PATH, process.env.PATH);
    assert.strictEqual(env.NODE_OPTIONS, '');
  });

  void it('does not change the current process environment', () => {
    process.env.NODE_OPTIONS = '--conditions=cdk';
    appBuildEnv({ NITRO_PRESET: 'aws-lambda' });
    assert.strictEqual(process.env.NODE_OPTIONS, '--conditions=cdk');
    assert.strictEqual(process.env.NITRO_PRESET, undefined);
  });

  void it('a Node.js child started with the result does not resolve packages through the cdk condition', () => {
    // A package with a `cdk` export condition, like every `@aws-cdk-blocks/*` package.
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-app-build-env-'));
    try {
      const pkgDir = path.join(projectDir, 'node_modules', 'probe');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: 'probe', exports: { '.': { cdk: './cdk.js', default: './default.js' } } }),
      );
      fs.writeFileSync(path.join(pkgDir, 'cdk.js'), "module.exports = 'cdk';\n");
      fs.writeFileSync(path.join(pkgDir, 'default.js'), "module.exports = 'default';\n");

      process.env.NODE_OPTIONS = '--conditions=cdk --max-old-space-size=512';
      const [inherited, stripped] = [{ ...process.env }, appBuildEnv()].map((env) =>
        execFileSync(process.execPath, ['-p', "require('probe')"], { cwd: projectDir, env, encoding: 'utf-8' }).trim(),
      );
      assert.strictEqual(inherited, 'cdk', 'precondition: a child that inherits NODE_OPTIONS resolves the cdk entry');
      assert.strictEqual(stripped, 'default');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
