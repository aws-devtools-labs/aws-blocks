// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Service-principal trust ownership across every Building Block.
 *
 * The synth-time trust check fails synth for a role AWS Blocks creates and only
 * warns for one the app creates. A block role it mistook for the app's would
 * silently lose the hard error, so this synthesizes this app (which
 * instantiates every BB) with every trust condition removed
 * (test/service-role-ownership-app.ts) and asserts that every role trusting a
 * non-Lambda service principal fails synth — none of them only warns. A new
 * block, or a stack-level helper, that creates such a role without marking it
 * as AWS Blocks' own fails here.
 *
 * Lambda execution roles are left out: the check accepts them unconditioned,
 * so their ownership doesn't change its outcome.
 *
 * KMS key policies get the same check: every key whose policy names a service
 * principal, with those statements' conditions removed, must fail synth and
 * none may only warn. (Today no key in this app names a service principal;
 * this guards a block that adds one.)
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..');

/** The account-level API Gateway CloudWatch Logs role's trust is allowed unconditioned. */
const ALLOWED_UNCONDITIONED = /\/BlocksApiGatewayCloudWatchRole\/Resource$/;

describe('the service-principal trust check classifies every Building Block role as AWS Blocks-owned', () => {
  test('every role with a non-Lambda service principal fails synth when its conditions are removed', () => {
    // AGENTS.md Core rule 1: synth needs `--conditions=cdk`; `-C cdk` sets it for tsx.
    const out = execFileSync('npx', ['tsx', '-C', 'cdk', 'test/service-role-ownership-app.ts'], {
      cwd: APP_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    const line = out.trim().split('\n').at(-1) ?? '';
    const { errors, warnings, serviceRoles, keyErrors, keyWarnings, serviceKeys } = JSON.parse(line) as {
      errors: string[];
      warnings: string[];
      serviceRoles: string[];
      keyErrors: string[];
      keyWarnings: string[];
      serviceKeys: string[];
    };
    const expected = serviceRoles.filter((path) => !ALLOWED_UNCONDITIONED.test(path)).sort();
    // The app has a KnowledgeBase, waiter providers and a CronJob, so a short
    // list means synth went wrong (e.g. mocks loaded).
    assert.ok(expected.length >= 3, `expected the full app's service roles, found ${expected.join(', ')}`);
    assert.deepStrictEqual(warnings, [], `roles classified as the app's:\n  ${warnings.join('\n  ')}`);
    assert.deepStrictEqual([...errors].sort(), expected);
    assert.deepStrictEqual(keyWarnings, [], `KMS keys classified as the app's:\n  ${keyWarnings.join('\n  ')}`);
    assert.deepStrictEqual([...keyErrors].sort(), [...serviceKeys].sort());
  });
});
