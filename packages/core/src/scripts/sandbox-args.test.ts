// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { buildSandboxDeployArgs, sandboxFailureRecoveryHint } from './sandbox.js';
import { buildCdkDeployArgs } from './deploy-stream.js';

/**
 * Return the value that follows `flag` in `args`, failing with a clear message
 * if the flag is absent. Reading `args[indexOf(flag) + 1]` directly silently
 * reads `args[0]` when the flag is missing (indexOf returns -1), which turns a
 * dropped flag into a confusing value mismatch instead of a "flag missing".
 *
 * NOTE: resolves only the FIRST occurrence of `flag`. `--context` legitimately
 * appears twice in this argv (projectRoot, then sandboxMode=true), so do not
 * use `valueAfter(args, '--context')` expecting the second value — it silently
 * returns the first. Assert repeated flags with `args.includes(...)` instead.
 */
function valueAfter(args: string[], flag: string): string {
  const i = args.indexOf(flag);
  assert.ok(i !== -1, `expected ${flag} in: ${args.join(' ')}`);
  return args[i + 1];
}

describe('buildSandboxDeployArgs — express mode (sandbox only)', () => {
  const args = buildSandboxDeployArgs({
    outDir: '.blocks-sandbox',
    projectRoot: '/app',
    backendPath: 'aws-blocks/index.ts',
  });

  it('enables CloudFormation Express Mode via --express', () => {
    assert.ok(args.includes('--express'), `expected --express in: ${args.join(' ')}`);
  });

  it('pairs express mode with the direct deployment method', () => {
    assert.strictEqual(valueAfter(args, '--method'), 'direct');
  });

  it('leaves express-mode rollback at its default (off) — no --rollback', () => {
    // Express Mode disables automatic rollback by default; we keep that default
    // for the throwaway sandbox loop. Passing --rollback here would silently
    // give up the speedup.
    assert.ok(!args.includes('--rollback'), `sandbox must not force --rollback: ${args.join(' ')}`);
  });

  it('deploys every stack so Lambda@Edge apps synth cleanly', () => {
    assert.ok(args.includes('--all'), `expected --all in: ${args.join(' ')}`);
  });

  it('keeps the non-interactive deploy contract and sandbox context', () => {
    assert.deepStrictEqual(args.slice(0, 4), ['exec', 'cdk', '--', 'deploy']);
    assert.strictEqual(valueAfter(args, '--require-approval'), 'never');
    assert.strictEqual(valueAfter(args, '--outputs-file'), '.blocks-sandbox/outputs.json');
    assert.ok(args.includes('sandboxMode=true'), `expected sandboxMode=true in: ${args.join(' ')}`);
    assert.strictEqual(valueAfter(args, '--app'), 'npm exec tsx -- -C cdk aws-blocks/index.ts');
  });

  it('interpolates the provided outDir and projectRoot', () => {
    const custom = buildSandboxDeployArgs({ outDir: 'out', projectRoot: '/other', backendPath: 'b.ts' });
    assert.strictEqual(valueAfter(custom, '--outputs-file'), 'out/outputs.json');
    assert.strictEqual(valueAfter(custom, '--context'), 'projectRoot=/other');
  });

  it('does NOT leak express mode into the production deploy path', () => {
    // A production deploy must keep a reviewable change set and full
    // stabilization with rollback: neither `--express` nor `--method direct`
    // (both sandbox-only speedups) may appear in buildCdkDeployArgs.
    const prod = buildCdkDeployArgs({ projectRoot: '/app', outputsFile: '.blocks-sandbox/outputs.json' });
    assert.ok(!prod.includes('--express'), `production deploy must not use --express: ${prod.join(' ')}`);
    assert.ok(!prod.includes('--method'), `production deploy must not use --method: ${prod.join(' ')}`);
  });
});

describe('sandboxFailureRecoveryHint — no silent dead-end after a failed express deploy', () => {
  const hint = sandboxFailureRecoveryHint();

  it('points to the repo-native destroy + redeploy recovery', () => {
    assert.match(hint, /npm run sandbox:destroy/);
    assert.match(hint, /npm run sandbox\b/);
  });

  it('covers the manual UPDATE_ROLLBACK_FAILED escape hatch', () => {
    assert.match(hint, /continue-update-rollback/);
  });

  it('explains why (rollback is off under express mode)', () => {
    assert.match(hint, /rollback is off|automatic rollback/i);
  });
});

describe('buildSandboxDeployArgs — hotswap (re-deploy)', () => {
  const hot = buildSandboxDeployArgs({
    outDir: '.blocks-sandbox',
    projectRoot: '/app',
    backendPath: 'aws-blocks/index.ts',
    hotswap: true,
  });

  it('uses --hotswap-fallback for a re-deploy', () => {
    assert.ok(hot.includes('--hotswap-fallback'), `expected --hotswap-fallback in: ${hot.join(' ')}`);
  });

  it('pairs hotswap with --express so the fallback deploy is also fast', () => {
    // --hotswap-fallback and --express are orthogonal: the former decides
    // WHETHER to touch CloudFormation, the latter HOW the CloudFormation deploy
    // runs. When a non-hotswappable change forces the fallback, we still want it
    // to run in Express Mode, not a plain slow deploy — so both flags are passed.
    assert.ok(hot.includes('--express'), `hotswap should pair with --express: ${hot.join(' ')}`);
  });

  it('does NOT pass --method with hotswap (--express implies its own method)', () => {
    // --express selects its own deployment method, so --method direct is not
    // needed alongside it here; keeping it off avoids a redundant/conflicting flag.
    assert.ok(!hot.includes('--method'), `hotswap must not pass --method: ${hot.join(' ')}`);
  });

  it('keeps the non-interactive contract + outputs + sandbox context', () => {
    assert.deepStrictEqual(hot.slice(0, 4), ['exec', 'cdk', '--', 'deploy']);
    assert.ok(hot.includes('--all'));
    assert.strictEqual(valueAfter(hot, '--require-approval'), 'never');
    assert.strictEqual(valueAfter(hot, '--outputs-file'), '.blocks-sandbox/outputs.json');
  });

  it('first deploy (hotswap:false) stays on Express Mode, not hotswap', () => {
    const first = buildSandboxDeployArgs({ outDir: 'o', projectRoot: '/a', backendPath: 'b.ts' });
    assert.ok(first.includes('--express'), 'first deploy uses Express Mode');
    assert.ok(!first.includes('--hotswap-fallback'), 'first deploy does not hotswap');
  });
});
