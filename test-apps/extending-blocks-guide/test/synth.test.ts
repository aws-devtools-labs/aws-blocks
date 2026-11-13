// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Synth-time validation. Runs `cdk synth` and inspects the CloudFormation
 * template to assert each pattern produced (or *didn't* produce) the
 * expected resources.
 *
 * Pattern 1: external SQS queue + handler env var EXTERNAL_QUEUE_URL.
 * Pattern 2: the two legacy DynamoDB tables are created by us; neither
 *            KVStore.fromExisting adds a third table (this asserts the bb-kv-store fix).
 * Pattern 3: bb-queue creates its own SQS queue, env var WORK_URL on handler.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..');
const SYNTH_DIR = join(APP_ROOT, 'cdk.out');

let template: any;

describe('extending-blocks-guide synth', () => {
  before(() => {
    execSync('npx cdk synth --quiet', { cwd: APP_ROOT, stdio: 'pipe' });
    const files = readdirSync(SYNTH_DIR).filter(f => f.endsWith('.template.json'));
    assert.ok(files.length > 0, 'no template emitted');
    template = JSON.parse(readFileSync(join(SYNTH_DIR, files[0]), 'utf-8'));
  });

  test('contains the Blocks Lambda handler', () => {
    const lambdas = Object.values(template.Resources).filter(
      (r: any) => r.Type === 'AWS::Lambda::Function'
    );
    assert.ok(lambdas.length >= 1, 'expected at least one Lambda');
  });

  test('exactly two DynamoDB tables (the legacy fixtures; neither fromExisting must add a third)', () => {
    const tables = Object.values(template.Resources).filter(
      (r: any) => r.Type === 'AWS::DynamoDB::Table'
    );
    assert.strictEqual(
      tables.length,
      2,
      `expected 2 tables (legacy-sessions + legacy-users fixtures); got ${tables.length}. ` +
        'If >2, a KVStore.fromExisting is provisioning a redundant table on the CDK side.'
    );
  });

  test('zero CloudFormation custom resources (KVStore.fromExisting must skip the GSI provider)', () => {
    const customs = Object.values(template.Resources).filter(
      (r: any) => r.Type === 'AWS::CloudFormation::CustomResource'
    );
    assert.strictEqual(
      customs.length,
      0,
      `expected 0 custom resources; got ${customs.length}. ` +
        'KVStore.fromExisting must not invoke the GSI manager.'
    );
  });

  test('two SQS queues: external (Pattern 1) + bb-queue work (Pattern 3)', () => {
    const queues = Object.values(template.Resources).filter(
      (r: any) => r.Type === 'AWS::SQS::Queue'
    );
    assert.strictEqual(queues.length, 2, `expected 2 SQS queues; got ${queues.length}`);
  });

  test('handler has EXTERNAL_QUEUE_URL and BLOCKS_LEGACY_SESSIONS_TABLE env vars', () => {
    const handler: any = Object.values(template.Resources).find(
      (r: any) =>
        r.Type === 'AWS::Lambda::Function' &&
        r.Properties?.Environment?.Variables?.NODE_ENV === 'production'
    );
    assert.ok(handler, 'could not find Blocks handler Lambda');
    const envVars = handler.Properties.Environment.Variables;
    assert.ok('EXTERNAL_QUEUE_URL' in envVars, 'missing EXTERNAL_QUEUE_URL on handler');
    assert.ok('BLOCKS_LEGACY_SESSIONS_TABLE' in envVars, 'missing BLOCKS_LEGACY_SESSIONS_TABLE on handler');
    // Pattern 3: bb-queue injects EXTENDING_GUIDE_WORK_URL.
    const workKey = Object.keys(envVars).find(k => k.endsWith('_WORK_URL'));
    assert.ok(workKey, 'missing *_WORK_URL on handler (Pattern 3 custom BB)');
  });
});
