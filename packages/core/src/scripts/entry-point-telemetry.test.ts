// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The entry points that apps on vendored `aws-blocks/scripts/*.ts` call directly
 * send their own event, so those apps report the command as the CLI does.
 */

import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runConfigCli } from './config.js';
import { writeSpec } from './generate-spec.js';
import { runSecretCli } from './secret.js';
import { runTypegenCli } from './typegen.js';

const CI_VARS = [
  'CI', 'CONTINUOUS_INTEGRATION', 'BUILD_NUMBER', 'CODEBUILD_BUILD_ID', 'GITHUB_ACTIONS', 'GITLAB_CI',
  'CIRCLECI', 'JENKINS_URL', 'TF_BUILD', 'BITBUCKET_BUILD_NUMBER', 'BUILDKITE',
];

describe('entry points send their own event', () => {
  const originalEnv = { ...process.env };
  const originalArgv = [...process.argv];
  const originalCwd = process.cwd();
  let dir: string;
  let telemetryFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'blocks-entry-telemetry-'));
    telemetryFile = join(dir, 'events.json');
    for (const name of CI_VARS) delete process.env[name];
    delete process.env.CDK_DISABLE_CLI_TELEMETRY;
    process.env.HOME = dir;
    // Nothing leaves the machine: the send goes to a closed port, the file sink records it.
    process.env.BLOCKS_TELEMETRY_ENDPOINT = 'http://127.0.0.1:1/metrics';
    process.argv = [...originalArgv, `--telemetry-file=${telemetryFile}`];
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = { ...originalEnv };
    process.argv = originalArgv;
    rmSync(dir, { recursive: true, force: true });
  });

  function events(): Array<{ command: string; state: string }> {
    if (!existsSync(telemetryFile)) return [];
    const parsed = JSON.parse(readFileSync(telemetryFile, 'utf-8'));
    return (Array.isArray(parsed) ? parsed : [parsed]).map((e) => ({ command: e.event.command, state: e.event.state }));
  }

  it('runSecretCli sends secret, with the usage error passed through', async () => {
    await assert.rejects(runSecretCli(['bogus-verb'], { interactive: false }), { name: 'ValueCliUsageError' });
    assert.deepStrictEqual(events(), [{ command: 'secret', state: 'FAIL' }]);
  });

  it('runConfigCli sends config, with the usage error passed through', async () => {
    await assert.rejects(runConfigCli(['bogus-verb'], { interactive: false }), { name: 'ValueCliUsageError' });
    assert.deepStrictEqual(events(), [{ command: 'config', state: 'FAIL' }]);
  });

  it('runTypegenCli sends generate:types, with its exit code unchanged', async () => {
    const code = await runTypegenCli(['--help'], { log: () => {}, error: () => {} });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(events(), [{ command: 'generate:types', state: 'SUCCESS' }]);
  });

  it('runTypegenCli --watch sends generate:types once its signal is aborted', { timeout: 10_000 }, async () => {
    const controller = new AbortController();
    let started!: () => void;
    const watching = new Promise<void>((resolve) => {
      started = resolve;
    });
    // Abort only once the watcher logs that it watches: it listens for the abort from then on.
    const log = (message: string) => {
      if (message.includes('watching')) started();
    };
    const run = runTypegenCli(['--watch', '--cwd', dir], { log, error: () => {}, signal: controller.signal });
    await watching;
    // hosting logs "watching" just before it starts waiting for the abort; let it get there.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(events(), []);
    controller.abort();
    assert.strictEqual(await run, 0);
    assert.deepStrictEqual(events(), [{ command: 'generate:types', state: 'SUCCESS' }]);
  });

  it('writeSpec sends generate:spec, with the error passed through', async () => {
    await assert.rejects(writeSpec(join(dir, 'missing', 'cdk-blocks', 'index.js'), join(dir, 'spec.json')));
    assert.deepStrictEqual(events(), [{ command: 'generate:spec', state: 'FAIL' }]);
  });

  // The opt-out is read from the working directory's cdk.json, where the npm script and the
  // CLI run it, not from two levels above the backend, which is the project root only for
  // a backend at `<root>/<dir>/index.ts`.
  for (const backend of ['backend.ts', join('src', 'api', 'cdk-blocks', 'index.ts')]) {
    it(`writeSpec honours a cdk.json opt-out in the working directory for a backend at ${backend}`, async () => {
      writeFileSync(join(dir, 'cdk.json'), JSON.stringify({ context: { 'cli-telemetry': false } }));
      process.chdir(dir);
      await assert.rejects(writeSpec(join(dir, backend), join(dir, 'spec.json')));
      assert.deepStrictEqual(events(), []);
    });
  }

  it('sends nothing when the CDK CLI telemetry opt-out is set', async () => {
    process.env.CDK_DISABLE_CLI_TELEMETRY = '1';
    await assert.rejects(runSecretCli(['bogus-verb'], { interactive: false }));
    assert.strictEqual(await runTypegenCli(['--help'], { log: () => {}, error: () => {} }), 0);
    assert.deepStrictEqual(events(), []);
  });
});
