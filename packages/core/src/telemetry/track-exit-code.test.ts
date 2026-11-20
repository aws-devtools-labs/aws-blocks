// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, beforeEach, afterEach, type TestContext } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackCommand, trackExitCode, stateForExitCode } from './trackCommand.js';

const CI_VARS = [
  'CI', 'CONTINUOUS_INTEGRATION', 'BUILD_NUMBER', 'CODEBUILD_BUILD_ID', 'GITHUB_ACTIONS', 'GITLAB_CI',
  'CIRCLECI', 'JENKINS_URL', 'TF_BUILD', 'BITBUCKET_BUILD_NUMBER', 'BUILDKITE',
];

/** A local collector that answers every POST with `status`; resolves `delivered` on the first body. */
async function startCollector(t: TestContext, status = 200) {
  const received: string[] = [];
  let resolveDelivered!: () => void;
  const delivered = new Promise<void>((r) => (resolveDelivered = r));
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push(body);
      res.writeHead(status).end();
      resolveDelivered();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { received, delivered, endpoint: `http://127.0.0.1:${address.port}/metrics` };
}

describe('telemetry/stateForExitCode', () => {
  it('maps 0 to SUCCESS, 130 and 143 to ABORTED, and anything else to FAIL', () => {
    assert.strictEqual(stateForExitCode(0), 'SUCCESS');
    assert.strictEqual(stateForExitCode(130), 'ABORTED');
    assert.strictEqual(stateForExitCode(143), 'ABORTED');
    assert.strictEqual(stateForExitCode(1), 'FAIL');
    assert.strictEqual(stateForExitCode(2), 'FAIL');
  });
});

describe('telemetry/trackExitCode', () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'blocks-track-exit-'));
    for (const name of CI_VARS) delete process.env[name];
    delete process.env.CDK_DISABLE_CLI_TELEMETRY;
    process.env.HOME = home;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = { ...originalEnv };
    rmSync(home, { recursive: true, force: true });
  });

  it('sends the command, the state from the exit code, and the duration', { timeout: 10_000 }, async (t) => {
    const { received, delivered, endpoint } = await startCollector(t);
    process.env.BLOCKS_TELEMETRY_ENDPOINT = endpoint;

    const code = await trackExitCode('whoami', async () => 1, { projectRoot: home });

    assert.strictEqual(code, 1);
    await delivered;
    const event = JSON.parse(received[0]);
    assert.strictEqual(event.event.command, 'whoami');
    assert.strictEqual(event.event.state, 'FAIL');
    assert.deepStrictEqual(event.event.error, { code: 'UNKNOWN', phase: 'unknown' });
    assert.strictEqual(typeof event.event.duration, 'number');
  });

  it('returns the exit code, without waiting, when the endpoint is unreachable', async () => {
    process.env.BLOCKS_TELEMETRY_ENDPOINT = 'http://127.0.0.1:1/metrics';
    const start = Date.now();
    assert.strictEqual(await trackExitCode('docs', async () => 0, { projectRoot: home }), 0);
    assert.strictEqual(await trackExitCode('docs', async () => 2, { projectRoot: home }), 2);
    // The send runs in a detached child: the command never waits for the network.
    assert.ok(Date.now() - start < 2_000, `took ${Date.now() - start} ms`);
  });

  it('returns the exit code when the collector rejects the event', { timeout: 10_000 }, async (t) => {
    const { delivered, endpoint } = await startCollector(t, 500);
    process.env.BLOCKS_TELEMETRY_ENDPOINT = endpoint;
    assert.strictEqual(await trackExitCode('help', async () => 0, { projectRoot: home }), 0);
    await delivered;
  });

  it('rethrows the command error unchanged', async () => {
    process.env.BLOCKS_TELEMETRY_ENDPOINT = 'http://127.0.0.1:1/metrics';
    const error = new Error('boom');
    await assert.rejects(() => trackExitCode('secret', async () => { throw error; }, { projectRoot: home }), (e) => e === error);
  });

  it('runs the command once, untracked, when the consent check throws', async () => {
    // A deleted working directory makes process.cwd() throw inside the consent lookup.
    const gone = mkdtempSync(join(tmpdir(), 'blocks-gone-'));
    process.chdir(gone);
    rmSync(gone, { recursive: true });
    assert.throws(() => process.cwd());

    let calls = 0;
    assert.strictEqual(
      await trackExitCode('config', async () => {
        calls++;
        return 0;
      }),
      0,
    );
    assert.strictEqual(calls, 1);

    let ran = false;
    await trackCommand('deploy', async () => { ran = true; });
    assert.strictEqual(ran, true);
  });
});
