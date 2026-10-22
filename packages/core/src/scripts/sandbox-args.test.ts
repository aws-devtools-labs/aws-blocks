// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import {
  buildSandboxCdkEnv,
  buildDevServerSpawn,
  buildSandboxDeployArgs,
  buildSandboxSynthArgs,
  findHostingUrl,
  PREVIEW_MODE_CONTEXT,
  findExpressUnsafeStacks,
  sandboxFailureRecoveryHint,
  stacksWithExpressUnsafeResources,
} from './sandbox.js';
import { FRAMEWORK_SINK_ENV } from '../telemetry/framework-sink.js';
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

describe('sandbox Express Mode fallback (Lambda Web Function endpoints)', () => {
  it('drops --express (keeping --method direct, rollback on) when express is false', () => {
    const args = buildSandboxDeployArgs({ outDir: 'o', projectRoot: '/a', backendPath: 'b.ts', express: false });
    assert.ok(!args.includes('--express'), `unexpected --express in: ${args.join(' ')}`);
    assert.strictEqual(valueAfter(args, '--method'), 'direct');
    assert.ok(!args.includes('--no-rollback'), 'rollback stays at its default (on)');
  });

  it('synthesizes once into <outDir>/cdk.out and deploys that assembly', () => {
    const synth = buildSandboxSynthArgs({ outDir: '.blocks-sandbox', projectRoot: '/app', backendPath: 'aws-blocks/index.cdk.ts' });
    assert.deepStrictEqual(synth.slice(0, 4), ['exec', 'cdk', '--', 'synth']);
    assert.strictEqual(valueAfter(synth, '--output'), '.blocks-sandbox/cdk.out');
    assert.ok(synth.includes('sandboxMode=true'));
    const deploy = buildSandboxDeployArgs({
      outDir: '.blocks-sandbox',
      projectRoot: '/app',
      backendPath: 'aws-blocks/index.cdk.ts',
      assemblyDir: '.blocks-sandbox/cdk.out',
    });
    assert.strictEqual(valueAfter(deploy, '--app'), '.blocks-sandbox/cdk.out', 'no second synth/framework build');
  });

  it('finds stacks whose synthesized template has a Web Function endpoint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-assembly-'));
    try {
      writeFileSync(
        join(dir, 'manifest.json'),
        JSON.stringify({
          artifacts: {
            WfStack: { type: 'aws:cloudformation:stack', environment: 'aws://123456789012/us-east-1', properties: { templateFile: 'WfStack.template.json', stackName: 'wf-stack' } },
            PlainStack: { type: 'aws:cloudformation:stack', environment: 'aws://unknown-account/unknown-region', properties: { templateFile: 'PlainStack.template.json' } },
            Tree: { type: 'cdk:tree' },
          },
        }),
      );
      writeFileSync(join(dir, 'WfStack.template.json'), JSON.stringify({ Resources: { E: { Type: 'AWS::Lambda::WebFunctionEndpoint' } } }));
      writeFileSync(join(dir, 'PlainStack.template.json'), JSON.stringify({ Resources: { F: { Type: 'AWS::Lambda::Function' } } }));
      assert.deepStrictEqual(stacksWithExpressUnsafeResources(dir), [{ stackName: 'wf-stack', region: 'us-east-1' }]);
      assert.deepStrictEqual(stacksWithExpressUnsafeResources(join(dir, 'missing')), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const fakeCfn = (byStack: Record<string, string | Error>) => (): CloudFormationClient =>
    ({
      send: async (cmd: { input: { StackName: string } }) => {
        const r = byStack[cmd.input.StackName];
        if (r instanceof Error) throw r;
        return { Stacks: [{ StackStatus: r }] };
      },
    }) as unknown as CloudFormationClient;

  it('turns Express off for an existing stack, keeps it for a create, and fails closed on errors', async () => {
    const unsafe = await findExpressUnsafeStacks(
      [{ stackName: 'existing' }, { stackName: 'new' }, { stackName: 'throttled' }, { stackName: 'deleted' }],
      fakeCfn({
        existing: 'UPDATE_COMPLETE',
        new: new Error('Stack with id new does not exist'),
        throttled: new Error('Rate exceeded'),
        deleted: 'DELETE_COMPLETE',
      }),
    );
    assert.deepStrictEqual(unsafe, ['existing', 'throttled']);
  });

  it('keeps Express Mode when no stack has an unsafe resource', async () => {
    assert.deepStrictEqual(await findExpressUnsafeStacks([], fakeCfn({})), []);
  });
});

describe('buildSandboxCdkEnv — framework sink reaches the synth child, and honours opt-out', () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();

  afterEach(() => {
    process.env = { ...originalEnv };
    process.chdir(originalCwd);
  });

  function inCleanProject(): void {
    // No .blocks/config.json, so consent falls back to the enabled default.
    const tmp = join(tmpdir(), `sandbox-env-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    process.chdir(tmp);
  }

  it('carries the framework sink path and the cdk resolution condition', () => {
    delete process.env.AWS_BLOCKS_DISABLE_TELEMETRY;
    inCleanProject();

    const env = buildSandboxCdkEnv('/tmp/blocks-framework-sink');

    assert.strictEqual(env[FRAMEWORK_SINK_ENV], '/tmp/blocks-framework-sink');
    assert.strictEqual(env.NODE_OPTIONS, '--conditions=cdk');
  });

  it('omits the sink when the user opted out, so nothing is written to disk', () => {
    process.env.AWS_BLOCKS_DISABLE_TELEMETRY = '1';

    const env = buildSandboxCdkEnv('/tmp/blocks-framework-sink');

    assert.ok(!(FRAMEWORK_SINK_ENV in env), `opted-out run must not set ${FRAMEWORK_SINK_ENV}`);
  });
});

describe('buildDevServerSpawn', () => {
  // The dev server runs under `shell: true`. Node 24 emits DEP0190 whenever a
  // non-empty args array is passed alongside `shell: true` (the args are only
  // concatenated, not escaped), so the whole command must go to the shell as
  // one string with no separate args.
  it('passes the default command as one shell string with no args', () => {
    assert.deepStrictEqual(buildDevServerSpawn(undefined), {
      command: 'npx tsx watch aws-blocks/scripts/server.ts',
      args: [],
    });
  });

  it('passes a custom devCommand through unsplit', () => {
    assert.deepStrictEqual(buildDevServerSpawn('npx next dev --port 3100'), {
      command: 'npx next dev --port 3100',
      args: [],
    });
  });
});


describe('buildSandboxDeployArgs — preview re-deploy hotswap', () => {
  const base = { outDir: '.blocks-sandbox', projectRoot: '/proj', backendPath: 'aws-blocks/index.cdk.ts' };

  it('replaces --method direct with --hotswap-fallback, keeping Express Mode for the fallback', () => {
    const args = buildSandboxDeployArgs({ ...base, hotswap: true });
    assert.ok(args.includes('--hotswap-fallback'));
    assert.ok(!args.includes('--method'), 'no --method direct alongside the hotswap');
    assert.ok(args.includes('--express'), 'a fallback CloudFormation deploy still runs in Express Mode');
  });

  it('is off by default', () => {
    const args = buildSandboxDeployArgs(base);
    assert.ok(!args.includes('--hotswap-fallback'));
    assert.strictEqual(valueAfter(args, '--method'), 'direct');
  });
});

describe('preview sandbox — the previewMode context', () => {
  const base = { outDir: '.blocks-sandbox', projectRoot: '/proj', backendPath: 'aws-blocks/index.cdk.ts' };
  const contexts = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === '--context' ? [a] : []));

  it('synth and deploy both pass previewMode=true next to sandboxMode=true', () => {
    for (const args of [buildSandboxSynthArgs({ ...base, preview: true }), buildSandboxDeployArgs({ ...base, preview: true })]) {
      assert.deepStrictEqual(contexts(args), ['projectRoot=/proj', 'sandboxMode=true', 'previewMode=true']);
    }
  });

  it('a plain sandbox passes no previewMode context', () => {
    for (const args of [buildSandboxSynthArgs(base), buildSandboxDeployArgs(base)]) {
      assert.deepStrictEqual(contexts(args), ['projectRoot=/proj', 'sandboxMode=true']);
    }
  });

  it('exports the context key the app reads', () => {
    assert.strictEqual(PREVIEW_MODE_CONTEXT, 'previewMode');
  });
});

describe('findHostingUrl — the URL a preview sandbox prints', () => {
  it('reads the Hosting construct output whatever its hash suffix, adding a scheme when missing', () => {
    assert.strictEqual(
      findHostingUrl({ ApiUrl: 'https://api.example/prod/aws-blocks/api', HostingHostingUrlAB12CD34: 'https://abc.execute-api.us-west-2.amazonaws.com' }),
      'https://abc.execute-api.us-west-2.amazonaws.com',
    );
    assert.strictEqual(findHostingUrl({ HostingHostingUrl99: 'd111.cloudfront.net' }), 'https://d111.cloudfront.net');
  });

  it('is undefined for a backend-only sandbox', () => {
    assert.strictEqual(findHostingUrl({ ApiUrl: 'https://api.example/prod/aws-blocks/api' }), undefined);
  });
});
