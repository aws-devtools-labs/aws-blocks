// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCdkDeployArgs } from './deploy-stream.js';
import { buildSandboxDeployArgs } from './sandbox.js';

// Each destroy path must select the same stacks its deploy path creates. With
// no selector, `cdk destroy` refuses an app with more than one top-level stack
// ("Since this app includes more than a single stack, specify which stacks to
// use ... or specify `--all`"), so a sandbox deployed with `--all` (e.g. a
// Lambda@Edge `edge-lambda-stack-*` outside us-east-1, or a `Vpc.fromLookup`
// reference stack) could never be destroyed. The real destroy functions run in
// a child process against fake `npm`/`npx` binaries that record their argv, so
// no CDK or AWS call is made. The fakes are POSIX shell scripts (no `.cmd`).

const skip = process.platform === 'win32';
let root: string;
let argvLog: string;

before(() => {
  if (skip) return;
  root = mkdtempSync(join(tmpdir(), 'bb-destroy-select-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  argvLog = join(root, 'argv.log');
  for (const name of ['npm', 'npx']) {
    const file = join(bin, name);
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvLog}"\n`);
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

describe('destroy selects the stacks its deploy creates', { skip }, () => {
  it('destroySandbox runs `cdk destroy --all`, like the sandbox deploy', () => {
    const deployArgs = buildSandboxDeployArgs({ outDir: '.blocks-sandbox', projectRoot: '/app', backendPath: 'a.ts' });
    assert.ok(deployArgs.includes('--all'), `expected --all in the sandbox deploy: ${deployArgs.join(' ')}`);
    const argv = recordDestroyArgv('./sandbox.js', `mod.destroySandbox('aws-blocks/index.ts')`);
    assert.ok(argv.includes('destroy'), `expected a cdk destroy, got: ${argv.join(' ')}`);
    assert.ok(argv.includes('--all'), `expected --all in: ${argv.join(' ')}`);
    assert.ok(argv.includes('--force'), `expected --force in: ${argv.join(' ')}`);
  });

  it('production destroy selects stacks the same way as the production deploy', () => {
    const deployArgs = buildCdkDeployArgs({ projectRoot: root, outputsFile: 'outputs.json' });
    const call = `mod.destroy({ cdkAppPath: ${JSON.stringify(join(root, 'index.cdk.ts'))}, projectRoot: ${JSON.stringify(root)} })`;
    const argv = recordDestroyArgv('./destroy.js', call);
    assert.ok(argv.includes('destroy'), `expected a cdk destroy, got: ${argv.join(' ')}`);
    assert.strictEqual(
      argv.includes('--all'),
      deployArgs.includes('--all'),
      `deploy and destroy must agree on --all: deploy=${deployArgs.join(' ')} destroy=${argv.join(' ')}`,
    );
  });
});
