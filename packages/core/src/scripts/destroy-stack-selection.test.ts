// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, before, after } from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCdkDeployArgs, readAppStackOutputs, selectAppStack } from './deploy-stream.js';
import {
  buildSandboxDeployArgs,
  buildSandboxWatchArgs,
  quoteCdkAppPath,
  sandboxWatchStacks,
  topLevelStackPaths,
  watchArgsForAssembly,
} from './sandbox.js';

// Every CDK command the scripts run must select every top-level stack of the
// app. With no selector, `cdk deploy` and `cdk destroy` refuse an app with more
// than one top-level stack ("Since this app includes more than a single stack,
// specify which stacks to use ... or specify `--all`"), and `cdk watch` never
// deploys and prints no error. Such an app is e.g. one with a Lambda@Edge
// `edge-lambda-stack-*` outside us-east-1, or a `Vpc.fromLookup` reference
// stack. The real destroy functions run in a child process against fake
// `npm`/`npx` binaries that record their argv, so no CDK or AWS call is made.
// The fakes are POSIX shell scripts (no `.cmd`).

const skip = process.platform === 'win32';
let root: string;
let argvLog: string;
let cdkLog: string;

before(() => {
  if (skip) return;
  root = mkdtempSync(join(tmpdir(), 'bb-destroy-select-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  argvLog = join(root, 'argv.log');
  cdkLog = join(root, 'cdk.log');
  for (const name of ['npm', 'npx']) {
    const file = join(bin, name);
    // Records its argv and, like CDK, writes a manifest into the `--output`
    // directory. cdk.log gets the working directory and whether a stale file
    // was still in that directory when it ran.
    writeFileSync(
      file,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvLog}"\necho "cwd=$PWD" > "${cdkLog}"\n` +
        `prev=\nfor a in "$@"; do if [ "$prev" = --output ]; then ` +
        `if [ -e "$a/stale.json" ]; then echo stale-seen >> "${cdkLog}"; fi; ` +
        `/bin/mkdir -p "$a" && echo '{}' > "$a/manifest.json"; fi; prev=$a; done\n`,
    );
    chmodSync(file, 0o755);
  }
});

after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Run `call` in a child ESM process with `mod` bound to `modulePath`; return the argv the fake binary recorded. */
function recordDestroyArgv(modulePath: string, call: string): string[] {
  rmSync(argvLog, { force: true });
  const moduleUrl = new URL(modulePath, import.meta.url).href;
  const script = `const mod = await import(${JSON.stringify(moduleUrl)}); await ${call};`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    // HOME without ~/.aws and no Region: the credential pre-check is skipped,
    // so the child never reaches AWS. PATH holds only the fake binaries.
    env: { PATH: join(root, 'bin'), HOME: root, USERPROFILE: root, AWS_BLOCKS_DISABLE_TELEMETRY: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  return readFileSync(argvLog, 'utf-8').split('\n').filter(Boolean);
}

describe('destroy selects every stack its deploy creates', { skip }, () => {
  it('destroySandbox runs `cdk destroy --all`, like the sandbox deploy', () => {
    const deployArgs = buildSandboxDeployArgs({ outDir: '.blocks-sandbox', projectRoot: '/app', backendPath: 'a.ts' });
    assert.ok(deployArgs.includes('--all'), `expected --all in the sandbox deploy: ${deployArgs.join(' ')}`);
    const argv = recordDestroyArgv('./sandbox.js', `mod.destroySandbox('aws-blocks/index.ts')`);
    assert.ok(argv.includes('destroy'), `expected a cdk destroy, got: ${argv.join(' ')}`);
    assert.ok(argv.includes('--all'), `expected --all in: ${argv.join(' ')}`);
    assert.ok(argv.includes('--force'), `expected --force in: ${argv.join(' ')}`);
    // sandboxMode=true keeps `--all --force` on this sandbox's stacks; without it the app names its stack `<app>-prod`.
    assert.strictEqual(argv[argv.indexOf('sandboxMode=true') - 1], '--context', `expected --context sandboxMode=true in: ${argv.join(' ')}`);
    // The same projectRoot as the sandbox deploy (the working directory), so both resolve the same stack names.
    const projectRoot = `projectRoot=${realpathSync(root)}`;
    assert.strictEqual(argv[argv.indexOf(projectRoot) - 1], '--context', `expected --context ${projectRoot} in: ${argv.join(' ')}`);
    // The retry reads the stacks this attempt selected from the assembly it synthesized.
    assert.strictEqual(argv[argv.indexOf('--output') + 1], '.blocks-sandbox/sandbox-destroy.out', `expected --output in: ${argv.join(' ')}`);
  });

  it('destroySandbox clears a stale assembly first and removes the one CDK wrote after a successful destroy', () => {
    const assemblyDir = join(root, '.blocks-sandbox', 'sandbox-destroy.out');
    mkdirSync(assemblyDir, { recursive: true });
    writeFileSync(join(assemblyDir, 'stale.json'), '{}');
    const argv = recordDestroyArgv('./sandbox.js', `mod.destroySandbox('aws-blocks/index.ts')`);
    // CDK ran in the project root, where the relative `--output` and the cleanup point at the same directory ...
    assert.ok(argv.includes('.blocks-sandbox/sandbox-destroy.out'), argv.join(' '));
    const cdk = readFileSync(cdkLog, 'utf-8');
    assert.match(cdk, new RegExp(`^cwd=${realpathSync(root)}$`, 'm'));
    // ... the stale file was gone before CDK wrote there ...
    assert.doesNotMatch(cdk, /stale-seen/);
    // ... and the successful destroy removed what CDK wrote.
    assert.ok(!existsSync(assemblyDir), `expected ${assemblyDir} to be removed`);
  });

  it('production destroy runs `cdk destroy --all`, like the production deploy', () => {
    const deployArgs = buildCdkDeployArgs({ projectRoot: root, outputsFile: 'outputs.json' });
    assert.ok(deployArgs.includes('--all'), `expected --all in the production deploy: ${deployArgs.join(' ')}`);
    const call = `mod.destroy({ cdkAppPath: ${JSON.stringify(join(root, 'index.cdk.ts'))}, projectRoot: ${JSON.stringify(root)} })`;
    const argv = recordDestroyArgv('./destroy.js', call);
    assert.ok(argv.includes('destroy'), `expected a cdk destroy, got: ${argv.join(' ')}`);
    assert.ok(argv.includes('--all'), `expected --all in: ${argv.join(' ')}`);
    assert.ok(argv.includes('--force'), `expected --force in: ${argv.join(' ')}`);
    // The retry reads the stacks this attempt selected from the assembly it synthesized.
    assert.strictEqual(argv[argv.indexOf('--output') + 1], '.blocks-sandbox/destroy.out', `expected --output in: ${argv.join(' ')}`);
  });

  it('production destroy clears a stale assembly first and removes the one CDK wrote after a successful destroy', () => {
    // CDK runs in projectRoot and writes the relative `--output` there; destroy() clears and reads that same directory.
    const projectRoot = mkdtempSync(join(root, 'project-'));
    const assemblyDir = join(projectRoot, '.blocks-sandbox', 'destroy.out');
    mkdirSync(assemblyDir, { recursive: true });
    writeFileSync(join(assemblyDir, 'stale.json'), '{}');
    const call = `mod.destroy({ cdkAppPath: ${JSON.stringify(join(projectRoot, 'index.cdk.ts'))}, projectRoot: ${JSON.stringify(projectRoot)} })`;
    const argv = recordDestroyArgv('./destroy.js', call);
    assert.ok(argv.includes('.blocks-sandbox/destroy.out'), argv.join(' '));
    const cdk = readFileSync(cdkLog, 'utf-8');
    assert.match(cdk, new RegExp(`^cwd=${realpathSync(projectRoot)}$`, 'm'));
    // The stale file was gone before CDK wrote there, and the successful destroy removed what CDK wrote.
    assert.doesNotMatch(cdk, /stale-seen/);
    assert.ok(!existsSync(assemblyDir), `expected ${assemblyDir} to be removed`);
    assert.ok(!existsSync(join(root, '.blocks-sandbox', 'destroy.out')), 'CDK wrote outside projectRoot');
    // Its own directory: a sandbox:destroy running at the same time keeps its assembly.
    assert.ok(!argv.includes('.blocks-sandbox/sandbox-destroy.out'), argv.join(' '));
  });
});

describe('the sandbox watch selects every stack', () => {
  it('the sandbox `cdk watch` names the given stacks right after `watch`', () => {
    const args = buildSandboxWatchArgs({
      outDir: '.blocks-sandbox',
      projectRoot: '/app',
      backendPath: 'a.ts',
      stacks: ['my-app', 'Parent/Nested'],
    });
    assert.deepStrictEqual(args.slice(0, 4), ['cdk', 'watch', 'my-app', 'Parent/Nested']);
    // `cdk watch` does not declare `--all`: the CLI warns about it as unknown.
    assert.ok(!args.includes('--all'), `expected no --all in: ${args.join(' ')}`);
  });

  it('the sandbox names stacks for `cdk watch` only when the app has several', () => {
    assert.deepStrictEqual(sandboxWatchStacks(['my-app', 'edge-lambda-stack-x']), ['my-app', 'edge-lambda-stack-x']);
    // One stack (whatever its path) or none: no selector, the argv a single-stack app always had.
    assert.deepStrictEqual(sandboxWatchStacks(['Api (dev)']), []);
    assert.deepStrictEqual(sandboxWatchStacks([]), []);
  });

  it('the sandbox `cdk watch` passes no selector when no stack is named', () => {
    const args = buildSandboxWatchArgs({ outDir: '.blocks-sandbox', projectRoot: '/app', backendPath: 'a.ts', stacks: [] });
    assert.strictEqual(args[2], '--outputs-file', `expected no stack pattern: ${args.join(' ')}`);
  });

  it('the sandbox `cdk watch` quotes the backend path in --app, like the other sandbox commands', () => {
    const args = buildSandboxWatchArgs({ outDir: '.blocks-sandbox', projectRoot: '/app', backendPath: 'my app/a.ts', stacks: [] });
    assert.strictEqual(args[args.indexOf('--app') + 1], `npm exec tsx -- -C cdk ${quoteCdkAppPath('my app/a.ts')}`);
  });
});

describe('quoteCdkAppPath', () => {
  it('double-quotes on Windows, where cmd.exe keeps single quotes in the path', () => {
    assert.strictEqual(quoteCdkAppPath('D:\\a\\my app\\index.cdk.ts', 'win32'), '"D:\\a\\my app\\index.cdk.ts"');
  });

  it('single-quotes on POSIX, escaping a single quote in the path', () => {
    assert.strictEqual(quoteCdkAppPath('/tmp/my app/index.cdk.ts', 'linux'), "'/tmp/my app/index.cdk.ts'");
    assert.strictEqual(quoteCdkAppPath("/tmp/bob's app/index.cdk.ts", 'darwin'), "'/tmp/bob'\\''s app/index.cdk.ts'");
  });
});

/**
 * A synthesized cloud assembly with three top-level stacks, one of them below a
 * plain construct (`Parent/Nested`), plus a CDK Stage holding a fourth stack.
 * All stacks are pinned to the never-issued all-zeros account.
 */
function writeMultiStackAssembly(dir: string): void {
  mkdirSync(join(dir, 'assembly-Stage'), { recursive: true });
  const template = JSON.stringify({ Resources: { H: { Type: 'AWS::CloudFormation::WaitConditionHandle' } } });
  const stack = (displayName: string, templateFile: string) => ({
    type: 'aws:cloudformation:stack',
    environment: 'aws://000000000000/us-east-1',
    displayName,
    properties: { templateFile },
  });
  for (const file of ['app.template.json', 'nested.template.json', 'edge.template.json']) {
    writeFileSync(join(dir, file), template);
  }
  writeFileSync(join(dir, 'assembly-Stage', 'staged.template.json'), template);
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      version: '22.0.0',
      artifacts: {
        'my-app': stack('my-app', 'app.template.json'),
        ParentNestedABCD1234: stack('Parent/Nested', 'nested.template.json'),
        'edge-lambda-stack-x': stack('edge-lambda-stack-x', 'edge.template.json'),
        'assembly-Stage': {
          type: 'cdk:cloud-assembly',
          properties: { directoryName: 'assembly-Stage', displayName: 'Stage' },
        },
      },
    }),
  );
  writeFileSync(
    join(dir, 'assembly-Stage', 'manifest.json'),
    JSON.stringify({ version: '22.0.0', artifacts: { 'Stage-Staged': stack('Stage/Staged', 'staged.template.json') } }),
  );
}

/** A synthesized cloud assembly with one top-level stack, below a construct. */
function writeSingleStackAssembly(dir: string): void {
  writeFileSync(join(dir, 'app.template.json'), JSON.stringify({ Resources: {} }));
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      version: '22.0.0',
      artifacts: {
        ApiDev: {
          type: 'aws:cloudformation:stack',
          environment: 'aws://000000000000/us-east-1',
          displayName: 'Api (dev)',
          properties: { templateFile: 'app.template.json' },
        },
      },
    }),
  );
}

describe('watchArgsForAssembly', () => {
  it('names every top-level stack of a multi-stack assembly for `cdk watch`', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-watch-asm-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeMultiStackAssembly(dir);
    const args = watchArgsForAssembly(dir, { outDir: '.blocks-sandbox', projectRoot: '/app', backendPath: 'a.ts' });
    assert.deepStrictEqual(args.slice(0, 5), ['cdk', 'watch', 'my-app', 'Parent/Nested', 'edge-lambda-stack-x']);
    assert.strictEqual(args[5], '--outputs-file');
  });

  it('names no stack for a single-stack assembly', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-watch-asm-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeSingleStackAssembly(dir);
    const args = watchArgsForAssembly(dir, { outDir: '.blocks-sandbox', projectRoot: '/app', backendPath: 'a.ts' });
    assert.strictEqual(args[2], '--outputs-file', `expected no stack pattern: ${args.join(' ')}`);
  });
});

describe('topLevelStackPaths', () => {
  it('lists the top-level stacks by construct path, not stacks inside a Stage', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-asm-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeMultiStackAssembly(dir);
    assert.deepStrictEqual(topLevelStackPaths(dir), ['my-app', 'Parent/Nested', 'edge-lambda-stack-x']);
  });

  it('returns [] when there is no assembly', () => {
    assert.deepStrictEqual(topLevelStackPaths(join(tmpdir(), 'bb-no-such-assembly')), []);
  });
});

// The argv above, run through the pinned CDK CLI on the multi-stack assembly.
// Hermetic: no credentials for the all-zeros account, so a command whose stack
// selection succeeds stops at the credential check, before any AWS call.
describe('the real CDK CLI selects every top-level stack with these argv', () => {
  const cdkBin = (() => {
    try {
      return createRequire(import.meta.url).resolve('aws-cdk/bin/cdk');
    } catch {
      return undefined;
    }
  })();
  // A missing CLI fails in CI (npm ci installs it); elsewhere the block skips.
  const skipCli = !cdkBin && !process.env.CI ? 'aws-cdk CLI is not installed in this workspace' : false;
  const MULTI_STACK_REFUSAL = /Since this app includes more than a single stack, specify which stacks to use/;
  const CREDENTIAL_CHECK = /Need to perform AWS calls for account 000000000000, but no credentials have been configured/;
  let asm: string;

  before(() => {
    asm = mkdtempSync(join(tmpdir(), 'bb-cdk-select-'));
    writeMultiStackAssembly(asm);
  });
  after(() => {
    if (asm) rmSync(asm, { recursive: true, force: true });
  });

  function cdk(args: string[]): { out: string; stdout: string; status: number | null } {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: asm,
      USERPROFILE: asm,
      AWS_EC2_METADATA_DISABLED: 'true',
      AWS_SHARED_CREDENTIALS_FILE: join(asm, 'no-credentials'),
      AWS_CONFIG_FILE: join(asm, 'no-config'),
      CDK_DISABLE_VERSION_CHECK: '1',
    };
    // Windows needs these for Node and the CLI to start at all.
    if (process.platform === 'win32') {
      for (const key of ['SystemRoot', 'TEMP', 'TMP']) env[key] = process.env[key];
    }
    assert.ok(cdkBin, 'the aws-cdk CLI must be resolvable here (run `npm ci` at the repo root)');
    const r = spawnSync(process.execPath, [cdkBin, ...args, '--app', asm, '--no-notices'], {
      cwd: asm,
      env,
      encoding: 'utf-8',
      timeout: 120_000,
    });
    return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '', status: r.status };
  }

  it('the production deploy argv: refused without --all, selected with it', { skip: skipCli }, () => {
    const args = buildCdkDeployArgs({ projectRoot: asm, outputsFile: join(asm, 'outputs.json') }).slice(1);
    const withoutAll = cdk(args.filter((a) => a !== '--all'));
    assert.match(withoutAll.out, MULTI_STACK_REFUSAL);
    const withAll = cdk(args);
    assert.doesNotMatch(withAll.out, MULTI_STACK_REFUSAL);
    assert.match(withAll.out, CREDENTIAL_CHECK, `expected the deploy to pass stack selection: ${withAll.out.slice(0, 600)}`);
  });

  it('the production destroy argv: refused without --all, selected with it', { skip: skip || skipCli }, () => {
    const call = `mod.destroy({ cdkAppPath: ${JSON.stringify(join(root, 'index.cdk.ts'))}, projectRoot: ${JSON.stringify(root)} })`;
    const args = recordDestroyArgv('./destroy.js', call).slice(1);
    const withoutAll = cdk(args.filter((a) => a !== '--all'));
    assert.match(withoutAll.out, MULTI_STACK_REFUSAL);
    const withAll = cdk(args);
    assert.doesNotMatch(withAll.out, MULTI_STACK_REFUSAL);
    assert.match(withAll.out, CREDENTIAL_CHECK, `expected the destroy to pass stack selection: ${withAll.out.slice(0, 600)}`);
  });

  it('the watch stack names select every top-level stack, not the staged one', { skip: skipCli }, () => {
    const names = topLevelStackPaths(asm);
    // `cdk ls` matches stack patterns the same way `cdk watch` does.
    const listed = cdk(['ls', ...names]);
    assert.strictEqual(listed.status, 0, listed.out);
    // Stack names only: `cdk ls` prints them on stdout, and CLI warnings on stderr.
    const ids = listed.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    assert.deepStrictEqual(ids.sort(), ['Parent/Nested', 'edge-lambda-stack-x', 'my-app'].sort());
    // The `*` wildcard would miss the stack below a construct.
    const star = cdk(['ls', '*']).stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    assert.ok(!star.includes('Parent/Nested'), `expected '*' to miss Parent/Nested: ${star.join(', ')}`);
  });
});

describe('readAppStackOutputs', () => {
  it("reads the outputs file and picks the app's stack when another stack finished first", (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-outputs-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'outputs.json');
    writeFileSync(
      file,
      JSON.stringify({
        'my-app-CfMonitoring-1': { MonitoringTopicArnUsEast1: 'arn:topic' },
        'my-app': { ApiUrl: 'https://api.example/aws-blocks/api' },
      }),
    );
    assert.deepStrictEqual(readAppStackOutputs(file), {
      stackName: 'my-app',
      outputs: { ApiUrl: 'https://api.example/aws-blocks/api' },
    });
  });
});

describe('selectAppStack', () => {
  it('picks the stack that carries ApiUrl when another stack is listed first', () => {
    const outputs = {
      'my-app-CfMonitoring-1': { MonitoringTopicArnUsEast1: 'arn:topic' },
      'my-app': { ApiUrl: 'https://api.example/aws-blocks/api', HostingUrlABC123: 'https://d1.example' },
    };
    assert.deepStrictEqual(selectAppStack(outputs), { stackName: 'my-app', outputs: outputs['my-app'] });
  });

  it('falls back to the first stack when none carries ApiUrl', () => {
    assert.deepStrictEqual(selectAppStack({ a: { X: '1' }, b: { Y: '2' } }), { stackName: 'a', outputs: { X: '1' } });
  });

  it('returns no stack and empty outputs when the file has no stack', () => {
    assert.deepStrictEqual(selectAppStack({}), { stackName: undefined, outputs: {} });
  });

  it('warns and keeps the first when several stacks carry ApiUrl', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const picked = selectAppStack({ one: { ApiUrl: 'https://1' }, two: { ApiUrl: 'https://2' } });
    assert.strictEqual(picked.stackName, 'one');
    assert.strictEqual(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /one, two/);
  });
});
