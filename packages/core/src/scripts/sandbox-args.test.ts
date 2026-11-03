// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import {
  buildSandboxCdkEnv,
  buildDevServerSpawn,
  buildSandboxDeployArgs,
  buildSandboxSynthArgs,
  buildSandboxWatchArgs,
  sandboxIsDeployOnly,
  findHostingUrl,
  previewRemovalWarning,
  PREVIEW_MODE_CONTEXT,
  findExpressUnsafeStacks,
  sandboxFailureRecoveryHint,
  CDK_APP_ENTRY_ENV,
  cdkAppCommand,
  cdkAppEnv,
  buildSandboxWatchSpawn,
  stacksWithExpressUnsafeResources,
  sandboxDevServerExitCode,
  assertNoRunningSandbox,
} from './sandbox.js';
import { pidCommand } from './dev-pidfile.js';
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
    assert.strictEqual(valueAfter(args, '--app'), cdkAppCommand());
  });

  it('interpolates the provided outDir and projectRoot', () => {
    const custom = buildSandboxDeployArgs({ outDir: 'out', projectRoot: '/other' });
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

  it('names the commands the user runs, when the caller passes them, aligned', () => {
    const named = sandboxFailureRecoveryHint('cdk-blocks sandbox deploy', 'cdk-blocks sandbox destroy');
    assert.match(named, /If the next `cdk-blocks sandbox deploy` reports/);
    assert.match(named, /^ {5}cdk-blocks sandbox destroy {3}# tears/m);
    assert.match(named, /^ {5}cdk-blocks sandbox deploy {4}# redeploy/m);
    assert.doesNotMatch(named, /npm run/);
  });
});

describe('sandbox Express Mode fallback (Lambda Web Function endpoints)', () => {
  it('drops --express (keeping --method direct, rollback on) when express is false', () => {
    const args = buildSandboxDeployArgs({ outDir: 'o', projectRoot: '/a', express: false });
    assert.ok(!args.includes('--express'), `unexpected --express in: ${args.join(' ')}`);
    assert.strictEqual(valueAfter(args, '--method'), 'direct');
    assert.ok(!args.includes('--no-rollback'), 'rollback stays at its default (on)');
  });

  it('synthesizes once into <outDir>/cdk.out and deploys that assembly', () => {
    const synth = buildSandboxSynthArgs({ outDir: '.blocks-sandbox', projectRoot: '/app' });
    assert.deepStrictEqual(synth.slice(0, 4), ['exec', 'cdk', '--', 'synth']);
    assert.strictEqual(valueAfter(synth, '--output'), '.blocks-sandbox/cdk.out');
    assert.ok(synth.includes('sandboxMode=true'));
    assert.strictEqual(valueAfter(synth, '--app'), cdkAppCommand());
    const deploy = buildSandboxDeployArgs({
      outDir: '.blocks-sandbox',
      projectRoot: '/app',
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

    const env = buildSandboxCdkEnv('/tmp/blocks-framework-sink', 'aws-blocks/index.cdk.ts');

    assert.strictEqual(env[FRAMEWORK_SINK_ENV], '/tmp/blocks-framework-sink');
    assert.strictEqual(env.NODE_OPTIONS, '--conditions=cdk');
    assert.strictEqual(env[CDK_APP_ENTRY_ENV], 'aws-blocks/index.cdk.ts');
  });

  it('omits the sink when the user opted out, so nothing is written to disk', () => {
    process.env.AWS_BLOCKS_DISABLE_TELEMETRY = '1';

    const env = buildSandboxCdkEnv('/tmp/blocks-framework-sink', 'aws-blocks/index.cdk.ts');

    assert.ok(!(FRAMEWORK_SINK_ENV in env), `opted-out run must not set ${FRAMEWORK_SINK_ENV}`);
  });
});

describe('sandboxDevServerExitCode', () => {
  it('ends the sandbox with 0 when its dev server was stopped, and 1 when it failed', () => {
    assert.strictEqual(sandboxDevServerExitCode(0, null), 0);
    assert.strictEqual(sandboxDevServerExitCode(null, 'SIGTERM'), 0);
    assert.strictEqual(sandboxDevServerExitCode(143, null), 0, 'the shell reports a SIGTERM as 128+15');
    assert.strictEqual(sandboxDevServerExitCode(137, null), 0, 'dev stop SIGKILLs a hung tsx watch');
    assert.strictEqual(sandboxDevServerExitCode(1, null), 1, 'a startup failure');
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

  it('adds --hotswap-fallback; the fallback CloudFormation deploy stays direct and in Express Mode', () => {
    const args = buildSandboxDeployArgs({ ...base, hotswap: true });
    assert.ok(args.includes('--hotswap-fallback'));
    // The CDK CLI deploys a fallback with the `--method` given; without one it
    // creates and executes a change set, which adds its own wait to the deploy.
    assert.strictEqual(valueAfter(args, '--method'), 'direct', 'the fallback calls UpdateStack directly, no change set');
    assert.ok(args.includes('--express'), 'a fallback CloudFormation deploy still runs in Express Mode');
  });

  it('is off by default', () => {
    const args = buildSandboxDeployArgs(base);
    assert.ok(!args.includes('--hotswap-fallback'));
    assert.strictEqual(valueAfter(args, '--method'), 'direct');
  });
});

describe('buildSandboxWatchArgs — infrastructure changes are deployed, not skipped', () => {
  const base = { outDir: '.blocks-sandbox', projectRoot: '/proj', backendPath: '/proj/aws-blocks/index.cdk.ts' };

  // `cdk watch` defaults to --hotswap, which ignores changes it can't hotswap
  // (a new Database or Realtime). The fallback deploys them in full instead.
  it('watches with --hotswap-fallback', () => {
    const args = buildSandboxWatchArgs(base);
    assert.deepStrictEqual(args.slice(0, 2), ['cdk', 'watch']);
    assert.ok(args.includes('--hotswap-fallback'), `missing --hotswap-fallback: ${args.join(' ')}`);
  });

  it('never passes plain --hotswap or --no-hotswap, which would skip or slow every change', () => {
    const args = buildSandboxWatchArgs(base);
    assert.ok(!args.includes('--hotswap'));
    assert.ok(!args.includes('--no-hotswap'));
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

  it('a preview sandbox is deploy-only: no cdk watch re-deploys the hosted preview', () => {
    assert.strictEqual(sandboxIsDeployOnly({ preview: true }), true);
    assert.strictEqual(sandboxIsDeployOnly({ preview: true, deployOnly: false }), true);
    assert.strictEqual(sandboxIsDeployOnly({ deployOnly: true }), true);
    assert.strictEqual(sandboxIsDeployOnly({}), false);
  });

  it('a plain sandbox passes no previewMode context', () => {
    for (const args of [buildSandboxSynthArgs(base), buildSandboxDeployArgs(base), buildSandboxWatchArgs(base)]) {
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

describe('previewRemovalWarning — a plain sandbox deploy over a hosted preview', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const outputsWith = (outputs: unknown): string => {
    dir = mkdtempSync(join(tmpdir(), 'sandbox-preview-warning-'));
    const file = join(dir, 'outputs.json');
    writeFileSync(file, typeof outputs === 'string' ? outputs : JSON.stringify(outputs));
    return file;
  };
  const withPreview = {
    'MyApp-sandbox-me': {
      ApiUrl: 'https://api.example/prod/aws-blocks/api',
      HostingHostingUrlAB12CD34: 'https://abc.execute-api.us-west-2.amazonaws.com',
    },
  };

  it('warns, naming the preview URL, when the previous deploy had hosting', () => {
    const warning = previewRemovalWarning(outputsWith(withPreview), false);
    assert.match(warning ?? '', /hosted preview at https:\/\/abc\.execute-api\.us-west-2\.amazonaws\.com/);
    assert.match(warning ?? '', /removes it/);
    assert.match(warning ?? '', /npm run sandbox:preview/);
  });

  it('names the command that deploys a preview, when the launcher passes it', () => {
    const warning = previewRemovalWarning(outputsWith(withPreview), false, 'npx --no -- cdk-blocks sandbox preview');
    assert.match(warning ?? '', /Run npx --no -- cdk-blocks sandbox preview to keep it/);
    assert.doesNotMatch(warning ?? '', /npm run/);
  });

  it('is silent for a preview deploy, a backend-only stack, and no or an unreadable outputs file', () => {
    assert.strictEqual(previewRemovalWarning(outputsWith(withPreview), true), undefined);
    assert.strictEqual(
      previewRemovalWarning(outputsWith({ 'MyApp-sandbox-me': { ApiUrl: 'https://api.example/prod/aws-blocks/api' } }), false),
      undefined,
    );
    assert.strictEqual(previewRemovalWarning(join(tmpdir(), 'no-such-dir', 'outputs.json'), false), undefined);
    assert.strictEqual(previewRemovalWarning(outputsWith('{not json'), false), undefined);
  });
});

describe('cdkAppCommand — the --app command CDK runs through a shell', () => {
  const awkward = "/work/sp ace/it's $HOME `id` %PATH% & app/aws-blocks/index.cdk.ts";

  it('names no path: the shell reads the entry from the environment', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      assert.doesNotMatch(cdkAppCommand(platform), /aws-blocks|index/, platform);
    }
    assert.strictEqual(cdkAppCommand('linux'), `npm exec tsx -- -C cdk "$${CDK_APP_ENTRY_ENV}"`);
    assert.strictEqual(cdkAppCommand('win32'), `npm exec tsx -- -C cdk "%${CDK_APP_ENTRY_ENV}%"`);
    assert.deepStrictEqual(cdkAppEnv(awkward), { [CDK_APP_ENTRY_ENV]: awkward });
  });

  it('passes a project path with a space, a quote, $, a backtick or % to tsx as one word', { skip: process.platform === 'win32' }, () => {
    // Run the command through sh, as CDK does, and see what arrives.
    const echoed = spawnSync('sh', ['-c', cdkAppCommand('linux').replace('npm exec tsx -- -C cdk', "printf '%s\\n'")], {
      encoding: 'utf-8',
      env: { ...process.env, ...cdkAppEnv(awkward) },
    });
    assert.strictEqual(echoed.stdout, `${awkward}\n`);
  });

  it('is used by synth, deploy (without an assembly) and watch, whose env carries the entry', () => {
    const path = '/work/sp ace/aws-blocks/index.cdk.ts';
    const options = { outDir: '.blocks-sandbox', projectRoot: '/work/sp ace' };
    assert.strictEqual(valueAfter(buildSandboxSynthArgs(options), '--app'), cdkAppCommand());
    assert.strictEqual(valueAfter(buildSandboxDeployArgs(options), '--app'), cdkAppCommand());
    assert.strictEqual(buildSandboxCdkEnv(undefined, path)[CDK_APP_ENTRY_ENV], path);
    const watch = buildSandboxWatchSpawn({ ...options, backendPath: path });
    assert.deepStrictEqual(watch.args.slice(0, 2), ['cdk', 'watch']);
    assert.strictEqual(valueAfter(watch.args, '--app'), cdkAppCommand());
    assert.strictEqual(watch.env[CDK_APP_ENTRY_ENV], path);
    assert.strictEqual(watch.env.NODE_OPTIONS, '--conditions=cdk');
  });

  it("watches into the sandbox's own assembly directory, never the ./cdk.out a cdk-blocks deploy uses (JW-02)", () => {
    const watch = buildSandboxWatchSpawn({ outDir: '.blocks-sandbox', projectRoot: '/app', backendPath: '/app/aws-blocks/index.cdk.ts' });
    assert.strictEqual(valueAfter(watch.args, '--output'), '.blocks-sandbox/cdk.out');
    assert.strictEqual(valueAfter(buildSandboxSynthArgs({ outDir: '.blocks-sandbox', projectRoot: '/app' }), '--output'), '.blocks-sandbox/cdk.out');
  });
});

describe('assertNoRunningSandbox — one sandbox session per app (JW-02)', () => {
  it('refuses a sandbox deploy or destroy while the app runs cdk-blocks sandbox, naming it and how to stop it', () => {
    const root = mkdtempSync(join(tmpdir(), 'blocks-running-sandbox-'));
    try {
      mkdirSync(join(root, '.blocks-sandbox'));
      // This process plays the sandbox, and its dev server (its record names our own command line).
      const record = { pid: process.pid, ppid: 1, port: 41950, command: pidCommand(process.pid), sandbox: { pid: process.pid } };
      writeFileSync(join(root, '.blocks-sandbox', 'dev-server.41950.pid'), JSON.stringify(record));
      assert.throws(
        () => assertNoRunningSandbox(root, 'npx --no -- cdk-blocks sandbox deploy'),
        new RegExp(
          `^Error: A \`cdk-blocks sandbox\` is running in this app \\(pid ${process.pid}, dev server on :41950\\).*` +
            'npx --no -- cdk-blocks dev stop --port 41950.*re-run `npx --no -- cdk-blocks sandbox deploy`',
        ),
      );
      // A plain cdk-blocks dev, or a session that has ended, is no reason to refuse.
      writeFileSync(join(root, '.blocks-sandbox', 'dev-server.41950.pid'), JSON.stringify({ ...record, sandbox: undefined }));
      assertNoRunningSandbox(root, 'x');
      writeFileSync(join(root, '.blocks-sandbox', 'dev-server.41950.pid'), JSON.stringify({ ...record, sandbox: { pid: 4194301 } }));
      assertNoRunningSandbox(root, 'x');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
