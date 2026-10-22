// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCdkDeployArgs, selectAppStackOutputs } from './deploy-stream.js';
import { buildSandboxDeployArgs, buildSandboxWatchArgs } from './sandbox.js';

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
  });
});

describe('deploy and watch select every stack', () => {
  it('the production deploy runs `cdk deploy --all`', () => {
    const args = buildCdkDeployArgs({ projectRoot: '/app', outputsFile: '.blocks-sandbox/outputs.json' });
    assert.deepStrictEqual(args.slice(0, 2), ['cdk', 'deploy']);
    assert.ok(args.includes('--all'), `expected --all in: ${args.join(' ')}`);
  });

  it('the sandbox `cdk watch` selects every top-level stack with the `*` wildcard', () => {
    const args = buildSandboxWatchArgs({ outDir: '.blocks-sandbox', projectRoot: '/app', backendPath: 'a.ts' });
    assert.deepStrictEqual(args.slice(0, 2), ['cdk', 'watch']);
    // `cdk watch` declares no `--all` option: the CLI warns it "will be ignored".
    assert.strictEqual(args[2], '*', `expected the '*' stack pattern right after 'watch': ${args.join(' ')}`);
    assert.ok(!args.includes('--all'), `expected no --all in: ${args.join(' ')}`);
  });
});

describe('selectAppStackOutputs', () => {
  it('picks the stack that carries ApiUrl when another stack is listed first', () => {
    const outputs = {
      'my-app-helper': { HelperArn: 'arn:helper' },
      'my-app': { ApiUrl: 'https://api.example/aws-blocks/api', HostingUrlABC123: 'https://d1.example' },
    };
    assert.deepStrictEqual(selectAppStackOutputs(outputs), outputs['my-app']);
  });

  it('falls back to the first stack when none carries ApiUrl', () => {
    assert.deepStrictEqual(selectAppStackOutputs({ a: { X: '1' }, b: { Y: '2' } }), { X: '1' });
  });

  it('returns an empty object when no stack has outputs', () => {
    assert.deepStrictEqual(selectAppStackOutputs({}), {});
  });
});
