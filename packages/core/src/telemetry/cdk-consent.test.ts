// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  CDK_DISABLE_ENV_VAR,
  CDK_TELEMETRY_CONTEXT_KEY,
  isCdkDisableContextValue,
  isCdkDisableEnvValue,
  readCdkTelemetryContext,
} from './cdk-consent.js';

const consentModuleUrl = new URL('./consent.js', import.meta.url).href;

// Driven in a child process: `os.homedir()` reads the native environment, so HOME
// can only be redirected at spawn time, and `~/.cdk.json` is one of the mechanisms.
const GATE_CHILD = `
const [moduleUrl] = process.argv.slice(1);
const { isTelemetryEnabled } = await import(moduleUrl);
process.stdout.write(String(isTelemetryEnabled()));
`;

interface CdkConsentCase {
  name: string;
  cdkEnv: string | null;
  cdkJson: boolean | string | null;
  cdkContextJson: boolean | string | null;
  userCdkJson: boolean | string | null;
  expected: boolean;
}

const { cases }: { cases: CdkConsentCase[] } = JSON.parse(
  readFileSync(new URL('../../src/telemetry/cdk-consent-cases.test.json', import.meta.url), 'utf-8'),
);

function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a CDK config file whose `cli-telemetry` sits inside a `context` element. */
function writeCdkConfig(path: string, value: boolean | string): void {
  writeFileSync(path, JSON.stringify({ context: { [CDK_TELEMETRY_CONTEXT_KEY]: value } }));
}

describe('CDK CLI telemetry opt-out disables CDK Blocks telemetry (shared case table)', () => {
  it('pins the shared case table contents', () => {
    assert.deepStrictEqual(
      cases.map((c) => [c.name, c.cdkEnv, c.cdkJson, c.cdkContextJson, c.userCdkJson, c.expected]),
      [
        ['no CDK opt-out anywhere', null, null, null, null, true],
        ['CDK_DISABLE_CLI_TELEMETRY=1', '1', null, null, null, false],
        ['CDK_DISABLE_CLI_TELEMETRY=true', 'true', null, null, null, false],
        ["CDK_DISABLE_CLI_TELEMETRY=TRUE is not CDK's disable", 'TRUE', null, null, null, true],
        ["CDK_DISABLE_CLI_TELEMETRY=yes is not CDK's disable", 'yes', null, null, null, true],
        ['CDK_DISABLE_CLI_TELEMETRY=0', '0', null, null, null, true],
        ['cdk.json context disables', null, false, null, null, false],
        ['cdk.json context disables with the string "false"', null, 'false', null, null, false],
        ['cdk.context.json disables, as `cdk cli-telemetry --disable` writes it', null, null, false, null, false],
        ['~/.cdk.json context disables globally', null, null, null, false, false],
        ['a cdk.json enable shadows a cdk.context.json disable, as in CDK', null, true, false, null, true],
        ['a cdk.context.json disable outranks a ~/.cdk.json enable', null, null, false, true, false],
        ['a cdk.json enable does not re-enable the env var', '1', true, null, null, false],
      ],
    );
  });

  for (const testCase of cases) {
    it(testCase.name, () => {
      const home = makeTmpDir('cdk-consent-home');
      const project = makeTmpDir('cdk-consent-proj');
      try {
        if (testCase.cdkJson !== null) writeCdkConfig(join(project, 'cdk.json'), testCase.cdkJson);
        if (testCase.cdkContextJson !== null) {
          writeFileSync(
            join(project, 'cdk.context.json'),
            JSON.stringify({ [CDK_TELEMETRY_CONTEXT_KEY]: testCase.cdkContextJson }),
          );
        }
        if (testCase.userCdkJson !== null) writeCdkConfig(join(home, '.cdk.json'), testCase.userCdkJson);

        const result = spawnSync(process.execPath, ['--input-type=module', '-e', GATE_CHILD, consentModuleUrl], {
          encoding: 'utf-8',
          cwd: project,
          timeout: 30_000,
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            [CDK_DISABLE_ENV_VAR]: testCase.cdkEnv ?? '',
          },
        });

        assert.strictEqual(result.status, 0, result.stderr);
        assert.strictEqual(result.stdout, String(testCase.expected), 'isTelemetryEnabled() — the send gate');
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(project, { recursive: true, force: true });
      }
    });
  }

});

describe('isCdkDisableEnvValue', () => {
  // Mirrors the CDK CLI's `['true', '1'].includes(...)`: case-sensitive and untrimmed.
  for (const value of ['true', '1']) {
    it(`treats ${JSON.stringify(value)} as disabled`, () => {
      assert.strictEqual(isCdkDisableEnvValue(value), true);
    });
  }

  for (const value of ['TRUE', 'True', 'yes', '0', 'false', ' 1', '1 ', '', undefined]) {
    it(`does not treat ${JSON.stringify(value)} as disabled`, () => {
      assert.strictEqual(isCdkDisableEnvValue(value), false);
    });
  }
});

describe('isCdkDisableContextValue', () => {
  // Mirrors the CDK CLI's `['false', false].includes(...)`.
  it('treats the boolean false as disabled', () => {
    assert.strictEqual(isCdkDisableContextValue(false), true);
  });

  it('treats the string "false" as disabled', () => {
    assert.strictEqual(isCdkDisableContextValue('false'), true);
  });

  for (const value of [true, 'true', 'FALSE', 0, null, undefined]) {
    it(`does not treat ${JSON.stringify(value) ?? 'undefined'} as disabled`, () => {
      assert.strictEqual(isCdkDisableContextValue(value), false);
    });
  }
});

describe('readCdkTelemetryContext', () => {
  // Run these cases in a child so HOME controls the user CDK config.
  const CONTEXT_CHILD = `
  const [moduleUrl, projectRoot] = process.argv.slice(1);
  const { readCdkTelemetryContext } = await import(moduleUrl);
  const value = readCdkTelemetryContext(projectRoot);
  process.stdout.write(value === undefined ? 'undefined' : JSON.stringify(value));
  `;

  const contextModuleUrl = new URL('./cdk-consent.js', import.meta.url).href;

  function resolveInChild(project: string): string {
    const home = makeTmpDir('cdk-context-home');
    try {
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', CONTEXT_CHILD, contextModuleUrl, project],
        {
          encoding: 'utf-8',
          timeout: 30_000,
          env: { ...process.env, HOME: home, USERPROFILE: home, [CDK_DISABLE_ENV_VAR]: '' },
        },
      );
      assert.strictEqual(result.status, 0, result.stderr);
      return result.stdout;
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it('returns undefined when no CDK config file sets the key', () => {
    const project = makeTmpDir('cdk-context-none');
    try {
      writeFileSync(join(project, 'cdk.json'), JSON.stringify({ app: 'npx tsx cdk-blocks/index.cdk.ts' }));
      assert.strictEqual(resolveInChild(project), 'undefined');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('ignores a top-level cli-telemetry, which the CDK CLI never reads', () => {
    // The CDK CLI builds its context bag from the `context` element only, so a
    // top-level key does not disable CDK telemetry and must not disable ours.
    const project = makeTmpDir('cdk-context-toplevel');
    try {
      writeFileSync(join(project, 'cdk.json'), JSON.stringify({ [CDK_TELEMETRY_CONTEXT_KEY]: false }));
      assert.strictEqual(resolveInChild(project), 'undefined');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('ignores an unparseable or non-object context', () => {
    const project = makeTmpDir('cdk-context-malformed');
    try {
      writeFileSync(join(project, 'cdk.json'), '{ not json');
      writeFileSync(join(project, 'cdk.context.json'), JSON.stringify({ context: 'a string' }));
      assert.strictEqual(resolveInChild(project), 'undefined');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
