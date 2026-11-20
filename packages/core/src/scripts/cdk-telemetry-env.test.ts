// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getCdkTelemetryEnv, getFrameworkSinkEnv } from './cdk-telemetry-env.js';
import { FRAMEWORK_SINK_ENV } from '../telemetry/framework-sink.js';

// Prevent an inherited CDK telemetry opt-out from disabling enabled-path tests.
delete process.env.CDK_DISABLE_CLI_TELEMETRY;

describe('getCdkTelemetryEnv', () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();

  afterEach(() => {
    process.env = { ...originalEnv };
    process.chdir(originalCwd);
  });

  it('returns CDK_CLI_USERAGENT when telemetry is enabled', () => {
    delete process.env.CDK_DISABLE_CLI_TELEMETRY;
    // Use a temporary directory with no project-level CDK configuration.
    const tmp = mkdtempSync(join(tmpdir(), 'cdk-telemetry-test-'));
    process.chdir(tmp);

    const env = getCdkTelemetryEnv('sandbox');

    assert.ok('CDK_CLI_USERAGENT' in env, 'should have CDK_CLI_USERAGENT');
    assert.ok(!('CDK_DISABLE_CLI_TELEMETRY' in env), 'should NOT have CDK_DISABLE_CLI_TELEMETRY');
    assert.match(env.CDK_CLI_USERAGENT, /^aws-blocks\/.*\/sandbox$/);

    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns CDK_DISABLE_CLI_TELEMETRY when env var disables telemetry', () => {
    process.env.CDK_DISABLE_CLI_TELEMETRY = '1';

    const env = getCdkTelemetryEnv('production');

    assert.deepStrictEqual(env, { CDK_DISABLE_CLI_TELEMETRY: '1' });
    assert.ok(!('CDK_CLI_USERAGENT' in env), 'should NOT have CDK_CLI_USERAGENT');
  });

  it('includes the command name in the user-agent string', () => {
    delete process.env.CDK_DISABLE_CLI_TELEMETRY;
    const tmp = mkdtempSync(join(tmpdir(), 'cdk-telemetry-test-'));
    process.chdir(tmp);

    const sandboxEnv = getCdkTelemetryEnv('sandbox');
    const prodEnv = getCdkTelemetryEnv('production');

    assert.ok(sandboxEnv.CDK_CLI_USERAGENT.endsWith('/sandbox'));
    assert.ok(prodEnv.CDK_CLI_USERAGENT.endsWith('/production'));

    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns CDK_DISABLE_CLI_TELEMETRY when CDK context disables telemetry', () => {
    delete process.env.CDK_DISABLE_CLI_TELEMETRY;
    const tmp = mkdtempSync(join(tmpdir(), 'cdk-telemetry-test-'));
    // What `cdk cli-telemetry --disable` records, so the cdk child is told as well.
    writeFileSync(join(tmp, 'cdk.context.json'), JSON.stringify({ 'cli-telemetry': false }));
    process.chdir(tmp);

    const env = getCdkTelemetryEnv('production');

    assert.deepStrictEqual(env, { CDK_DISABLE_CLI_TELEMETRY: '1' });
    assert.ok(!('CDK_CLI_USERAGENT' in env), 'should NOT have CDK_CLI_USERAGENT');

    rmSync(tmp, { recursive: true, force: true });
  });
});

describe('getFrameworkSinkEnv', () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();

  afterEach(() => {
    process.env = { ...originalEnv };
    process.chdir(originalCwd);
  });

  it('returns the sink path when telemetry is enabled', () => {
    delete process.env.CDK_DISABLE_CLI_TELEMETRY;
    const tmp = mkdtempSync(join(tmpdir(), 'framework-sink-env-test-'));
    process.chdir(tmp);

    assert.deepStrictEqual(getFrameworkSinkEnv('/tmp/sink'), { [FRAMEWORK_SINK_ENV]: '/tmp/sink' });

    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns nothing when the user opted out, so the sink file is never written', () => {
    process.env.CDK_DISABLE_CLI_TELEMETRY = '1';

    assert.deepStrictEqual(getFrameworkSinkEnv('/tmp/sink'), {});
  });

  it('returns nothing when CDK context disables telemetry', () => {
    delete process.env.CDK_DISABLE_CLI_TELEMETRY;
    const tmp = mkdtempSync(join(tmpdir(), 'framework-sink-env-test-'));
    writeFileSync(join(tmp, 'cdk.context.json'), JSON.stringify({ 'cli-telemetry': false }));
    process.chdir(tmp);

    assert.deepStrictEqual(getFrameworkSinkEnv('/tmp/sink'), {});

    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns nothing when no sink directory could be created', () => {
    delete process.env.CDK_DISABLE_CLI_TELEMETRY;
    assert.deepStrictEqual(getFrameworkSinkEnv(undefined), {});
  });
});
