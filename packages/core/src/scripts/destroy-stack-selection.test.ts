// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { execFile, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildSandboxDeployArgs } from './sandbox.js';
import { cdkListedStacks, stackExists } from './destroy.js';

// The sandbox destroy must select the same stacks the sandbox deploy creates.
// (The production destroy follows in a separate change, together with its
// confirmation; `npm run deploy` already passes `--all`.) With no selector,
// `cdk destroy` refuses an app with more than one top-level stack ("Since
// this app includes more than a single stack, specify which stacks to use ...
// or specify `--all`"), so a sandbox deployed with `--all` (e.g. a
// Lambda@Edge `edge-lambda-stack-*` outside us-east-1, or a `Vpc.fromLookup`
// reference stack) could never be destroyed. The real destroy functions run in
// a child process against fake `npm`/`npx` binaries that record their argv, so
// no CDK or AWS call is made. The fakes are POSIX shell scripts (no `.cmd`).

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
    // directory. cdk.log gets the working directory, the stage environment and
    // whether a stale file was still in that directory when it ran.
    writeFileSync(
      file,
      // `cdk ls` prints the stacks in ZZ_STACKS and records nothing.
      `#!/bin/sh\nif [ "$2" = ls ]; then printf '%s\\n' "$ZZ_STACKS"; exit 0; fi\n` +
        `printf '%s\\n' "$@" > "${argvLog}"\necho "cwd=$PWD" > "${cdkLog}"\n` +
        `echo "stage=$BLOCKS_STAGE mark=$ZZ_MARK" >> "${cdkLog}"\n` +
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

describe('destroy selects the stacks its deploy creates', { skip }, () => {
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
    // A destroy doesn't deploy the frontend, so Hosting reuses an existing build.
    assert.strictEqual(argv[argv.indexOf('reuseFrontendBuild=true') - 1], '--context', `expected --context reuseFrontendBuild=true in: ${argv.join(' ')}`);
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

  it('the production destroy loads .env.production, as the production deploy does', () => {
    writeFileSync(join(root, '.env.production'), 'ZZ_MARK=from-env-production\n');
    try {
      const argv = recordDestroyArgv('./destroy.js', `mod.destroy({ cdkAppPath: 'aws-blocks/index.cdk.ts', projectRoot: ${JSON.stringify(root)} })`);
      assert.ok(argv.includes('destroy'), `expected a cdk destroy, got: ${argv.join(' ')}`);
      // A destroy doesn't deploy the frontend, so Hosting reuses an existing build.
      assert.strictEqual(argv[argv.indexOf('reuseFrontendBuild=true') - 1], '--context', `expected --context reuseFrontendBuild=true in: ${argv.join(' ')}`);
      // cdk destroy synthesizes the app with the production environment.
      assert.match(readFileSync(cdkLog, 'utf-8'), /^stage=production mark=from-env-production$/m);
    } finally {
      rmSync(join(root, '.env.production'), { force: true });
    }
  });
});

describe('the production destroy of a stack that does not exist', { skip }, () => {
  /** Loopback STS and CloudFormation: GetCallerIdentity succeeds; DescribeStacks knows only `live-prod`. */
  let server: Server;
  let endpoint: string;
  before(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const params = new URLSearchParams(body);
        res.setHeader('content-type', 'text/xml');
        if (params.get('Action') === 'GetCallerIdentity') {
          res.end('<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>arn:aws:iam::111111111111:user/u</Arn><Account>111111111111</Account></GetCallerIdentityResult></GetCallerIdentityResponse>');
        } else if (params.get('StackName') === 'live-prod') {
          res.end('<DescribeStacksResponse><DescribeStacksResult><Stacks><member><StackName>live-prod</StackName><StackStatus>UPDATE_COMPLETE</StackStatus><CreationTime>2026-01-01T00:00:00Z</CreationTime></member></Stacks></DescribeStacksResult></DescribeStacksResponse>');
        } else {
          res.statusCode = 400;
          res.end(`<ErrorResponse><Error><Type>Sender</Type><Code>ValidationError</Code><Message>Stack with id ${params.get('StackName')} does not exist</Message></Error></ErrorResponse>`);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  /**
   * Run the production destroy in a child, with a CDK app that defines `stacks`;
   * the server must keep answering, so not execFileSync.
   */
  async function runDestroy(stackName: string, stacks = stackName): Promise<{ failed: boolean; output: string; cdkRan: boolean }> {
    rmSync(argvLog, { force: true });
    const moduleUrl = new URL('./destroy.js', import.meta.url).href;
    const options = JSON.stringify({ cdkAppPath: 'aws-blocks/index.cdk.ts', projectRoot: root, stackName });
    const script = `const mod = await import(${JSON.stringify(moduleUrl)}); await mod.destroy(${options});`;
    const run = promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      env: {
        PATH: join(root, 'bin'),
        HOME: root,
        AWS_BLOCKS_DISABLE_TELEMETRY: '1',
        AWS_REGION: 'us-east-1',
        AWS_ACCESS_KEY_ID: 'AKIDTEST',
        AWS_SECRET_ACCESS_KEY: 'secret',
        AWS_ENDPOINT_URL_STS: endpoint,
        AWS_ENDPOINT_URL_CLOUDFORMATION: endpoint,
        ZZ_STACKS: stacks,
      },
      timeout: 60_000,
    });
    const { failed, stdout, stderr } = await run.then(
      (result) => ({ failed: false, ...result }),
      (error: { stdout: string; stderr: string }) => ({ failed: true, stdout: error.stdout, stderr: error.stderr }),
    );
    return { failed, output: `${stdout}${stderr}`, cdkRan: existsSync(argvLog) };
  }

  it('says there is nothing to delete, and runs no cdk destroy', async () => {
    const missing = await runDestroy('gone-prod');
    assert.strictEqual(missing.failed, false, missing.output);
    assert.match(missing.output, /There is no stack gone-prod in Region us-east-1; nothing to delete\./);
    assert.doesNotMatch(missing.output, /destroyed/);
    assert.strictEqual(missing.cdkRan, false);
    const live = await runDestroy('live-prod');
    assert.strictEqual(live.cdkRan, true);
    assert.match(live.output, /Production stack destroyed/);
  });

  it('refuses, and deletes nothing, when the CDK app does not define the named stack', async () => {
    const other = await runDestroy('live-prod', 'my-blocks-stack-prod');
    assert.strictEqual(other.failed, true);
    assert.strictEqual(other.cdkRan, false);
    assert.match(
      other.output,
      /The CDK app \(aws-blocks\/index\.cdk\.ts\) defines my-blocks-stack-prod, not live-prod, the production stack that \.blocks\/config\.json names; nothing was deleted\./,
    );
    // A construct id that differs from the stack name is listed as `id (name)`.
    const named = await runDestroy('live-prod', 'Edge\nApp (live-prod)');
    assert.strictEqual(named.cdkRan, true, named.output);
  });

  it('reads only "does not exist" as a missing stack', async () => {
    const failing = (error: Error) => ({ send: async () => Promise.reject(error) });
    const named = (name: string, message: string) => Object.assign(new Error(message), { name });
    const describe = (name: string) => name;
    assert.strictEqual(await stackExists({ send: async () => ({}) }, describe, 's'), true);
    assert.strictEqual(await stackExists(failing(named('ValidationError', 'Stack with id s does not exist')), describe, 's'), false);
    assert.strictEqual(await stackExists(failing(named('AccessDenied', 'not authorized')), describe, 's'), undefined);
    assert.strictEqual(await stackExists(failing(named('ValidationError', 'Rate exceeded')), describe, 's'), undefined);
  });

  it('looks a deployed stack up with the deploy credentials, in the Region given or configured', async () => {
    const moduleUrl = new URL('./destroy.js', import.meta.url).href;
    const lookup = async (env: Record<string, string>, options: Record<string, unknown>) => {
      const script = `const mod = await import(${JSON.stringify(moduleUrl)}); console.log(String(await mod.deployedStackExists(${JSON.stringify({ projectRoot: root, ...options })})));`;
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
        cwd: root,
        env: { HOME: root, AWS_BLOCKS_DISABLE_TELEMETRY: '1', ...env },
        timeout: 60_000,
      });
      return stdout.trim();
    };
    const aws = { AWS_ACCESS_KEY_ID: 'AKIDTEST', AWS_SECRET_ACCESS_KEY: 'secret', AWS_ENDPOINT_URL_CLOUDFORMATION: endpoint };
    assert.strictEqual(await lookup({ ...aws, AWS_REGION: 'us-east-1' }, { stackName: 'live-prod' }), 'true');
    assert.strictEqual(await lookup({ ...aws, AWS_REGION: 'us-east-1' }, { stackName: 'gone-prod' }), 'false');
    assert.strictEqual(await lookup(aws, { stackName: 'gone-prod', region: 'eu-west-1' }), 'false');
    // No Region to look in, or a lookup that fails otherwise: unknown.
    assert.strictEqual(await lookup(aws, { stackName: 'live-prod' }), 'undefined');
    const unreachable = { ...aws, AWS_ENDPOINT_URL_CLOUDFORMATION: 'http://127.0.0.1:9', AWS_REGION: 'us-east-1' };
    assert.strictEqual(await lookup(unreachable, { stackName: 'live-prod' }), 'undefined');
  });
});

describe('cdkListedStacks', () => {
  it('keeps only stack ids from cdk ls output, not the build output of the synth', () => {
    const out = [
      'AI agent detected',
      '🏗️  Building frontend (spa): npm run build',
      '> mig1@0.1.0 prebuild',
      'blocks-generate-client: wrote /app/aws-blocks/client.js',
      'vite v6.4.5 building for production...',
      '✓ built in 406ms',
      'zz-app-prod',
      'Main (zz-app-prod-main)',
      'Stage/Nested',
      '',
    ].join('\n');
    assert.deepStrictEqual(cdkListedStacks(out), ['zz-app-prod', 'Main (zz-app-prod-main)', 'Stage/Nested']);
  });
});
