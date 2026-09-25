// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getCdkTelemetryEnv } from './cdk-telemetry-env.js';

describe('getCdkTelemetryEnv', () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();

  afterEach(() => {
    process.env = { ...originalEnv };
    process.chdir(originalCwd);
  });

  it('returns CDK_CLI_USERAGENT when telemetry is enabled', () => {
    delete process.env.AWS_BLOCKS_DISABLE_TELEMETRY;
    // chdir to a temp dir with no .blocks/config.json so defaults apply
    const tmp = join(tmpdir(), `cdk-telemetry-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    process.chdir(tmp);

    const env = getCdkTelemetryEnv('sandbox');

    assert.ok('CDK_CLI_USERAGENT' in env, 'should have CDK_CLI_USERAGENT');
    assert.ok(!('CDK_DISABLE_CLI_TELEMETRY' in env), 'should NOT have CDK_DISABLE_CLI_TELEMETRY');
    assert.match(env.CDK_CLI_USERAGENT, /^aws-blocks\/.*\/sandbox$/);

    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns CDK_DISABLE_CLI_TELEMETRY when env var disables telemetry', () => {
    process.env.AWS_BLOCKS_DISABLE_TELEMETRY = '1';

    const env = getCdkTelemetryEnv('production');

    assert.deepStrictEqual(env, { CDK_DISABLE_CLI_TELEMETRY: '1' });
    assert.ok(!('CDK_CLI_USERAGENT' in env), 'should NOT have CDK_CLI_USERAGENT');
  });

  it('returns CDK_DISABLE_CLI_TELEMETRY when project config disables telemetry', () => {
    delete process.env.AWS_BLOCKS_DISABLE_TELEMETRY;
    const tmp = join(tmpdir(), `cdk-telemetry-test-${Date.now()}`);
    mkdirSync(join(tmp, '.blocks'), { recursive: true });
    writeFileSync(join(tmp, '.blocks', 'config.json'), JSON.stringify({ telemetry: { enabled: false } }));
    process.chdir(tmp);

    const env = getCdkTelemetryEnv('sandbox');

    assert.deepStrictEqual(env, { CDK_DISABLE_CLI_TELEMETRY: '1' });
    assert.ok(!('CDK_CLI_USERAGENT' in env), 'should NOT have CDK_CLI_USERAGENT');

    rmSync(tmp, { recursive: true, force: true });
  });

  it('includes the command name in the user-agent string', () => {
    delete process.env.AWS_BLOCKS_DISABLE_TELEMETRY;
    const tmp = join(tmpdir(), `cdk-telemetry-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    process.chdir(tmp);

    const sandboxEnv = getCdkTelemetryEnv('sandbox');
    const prodEnv = getCdkTelemetryEnv('production');

    assert.ok(sandboxEnv.CDK_CLI_USERAGENT.endsWith('/sandbox'));
    assert.ok(prodEnv.CDK_CLI_USERAGENT.endsWith('/production'));

    rmSync(tmp, { recursive: true, force: true });
  });
});
