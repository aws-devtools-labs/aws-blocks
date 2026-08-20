// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { buildSandboxDeployArgs } from './sandbox.js';
import { buildCdkDeployArgs } from './deploy-stream.js';

describe('buildSandboxDeployArgs — express mode (sandbox only)', () => {
  const args = buildSandboxDeployArgs({
    outDir: '.blocks-sandbox',
    projectRoot: '/app',
    backendPath: 'aws-blocks/index.ts',
  });

  it('deploys via direct UpdateStack (express mode) instead of a change set', () => {
    assert.strictEqual(args[args.indexOf('--method') + 1], 'direct', `expected --method direct in: ${args.join(' ')}`);
  });

  it('deploys every stack so Lambda@Edge apps synth cleanly', () => {
    assert.ok(args.includes('--all'), `expected --all in: ${args.join(' ')}`);
  });

  it('keeps the non-interactive deploy contract and sandbox context', () => {
    assert.deepStrictEqual(args.slice(0, 4), ['exec', 'cdk', '--', 'deploy']);
    assert.strictEqual(args[args.indexOf('--require-approval') + 1], 'never');
    assert.strictEqual(args[args.indexOf('--outputs-file') + 1], '.blocks-sandbox/outputs.json');
    assert.ok(args.includes('sandboxMode=true'), `expected sandboxMode=true in: ${args.join(' ')}`);
    assert.strictEqual(args[args.indexOf('--app') + 1], 'npm exec tsx -- -C cdk aws-blocks/index.ts');
  });

  it('interpolates the provided outDir and projectRoot', () => {
    const custom = buildSandboxDeployArgs({ outDir: 'out', projectRoot: '/other', backendPath: 'b.ts' });
    assert.strictEqual(custom[custom.indexOf('--outputs-file') + 1], 'out/outputs.json');
    assert.strictEqual(custom[custom.indexOf('--context') + 1], 'projectRoot=/other');
  });

  it('does NOT leak express mode into the production deploy path', () => {
    // A production deploy must keep a reviewable change set: `--method direct`
    // is a sandbox-only speedup and must never appear in buildCdkDeployArgs.
    const prod = buildCdkDeployArgs({ projectRoot: '/app', outputsFile: '.blocks-sandbox/outputs.json' });
    assert.ok(!prod.includes('--method'), `production deploy must not use --method: ${prod.join(' ')}`);
  });
});
