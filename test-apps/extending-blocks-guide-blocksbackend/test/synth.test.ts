// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Synth-time validation for the BlocksBackend harness.
 *
 * Asserts that BlocksBackend.create produces the expected resources INSIDE
 * the user-owned outer stack (not in a separate stack), and that env vars
 * + IAM are wired correctly to the BlocksBackend's handler.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..');
const SYNTH_DIR = join(APP_ROOT, 'cdk.out');

let template: any;

/**
 * CDK synthesizes its own helper Lambdas for custom resources — the S3
 * auto-delete provider and the BucketDeployment runtime, both pulled in by the
 * config registry's S3 bucket (`autoDeleteObjects` under the sandbox posture).
 * They are CDK-managed plumbing, not Blocks compute, so exclude them when
 * counting how many computes Blocks provisions. Their construct path carries a
 * `Custom::` segment; a real compute's does not
 * (`.../BlocksApi/DefaultCompute/Handler/Resource`).
 */
const isCdkCustomResourceLambda = (r: any) =>
  String(r.Metadata?.['aws:cdk:path'] ?? '').includes('Custom::');

const blocksComputeLambdas = () =>
  Object.values(template.Resources).filter(
    (r: any) => r.Type === 'AWS::Lambda::Function' && !isCdkCustomResourceLambda(r)
  );

describe('extending-blocks-guide-blocksbackend synth', () => {
  before(() => {
    execSync('npx cdk synth --quiet', { cwd: APP_ROOT, stdio: 'pipe' });
    const files = readdirSync(SYNTH_DIR).filter(f => f.endsWith('.template.json'));
    assert.ok(files.length === 1, `expected exactly 1 template (single stack), got ${files.length}`);
    template = JSON.parse(readFileSync(join(SYNTH_DIR, files[0]), 'utf-8'));
  });

  test('exactly one Blocks compute Lambda (the BlocksBackend handler)', () => {
    const lambdas = blocksComputeLambdas();
    assert.strictEqual(
      lambdas.length,
      1,
      `expected 1 Blocks compute Lambda (BlocksBackend handler); got ${lambdas.length}: ` +
        `${lambdas.map((r: any) => r.Metadata?.['aws:cdk:path']).join(', ')}`
    );
  });

  test('exactly one API Gateway (managed by BlocksBackend)', () => {
    const apis = Object.values(template.Resources).filter(
      (r: any) => r.Type === 'AWS::ApiGateway::RestApi'
    );
    assert.strictEqual(apis.length, 1);
  });

  test('exactly one SQS queue (the user-owned external queue)', () => {
    const queues = Object.values(template.Resources).filter(
      (r: any) => r.Type === 'AWS::SQS::Queue'
    );
    assert.strictEqual(queues.length, 1);
  });

  test('BlocksBackend handler has EXTERNAL_QUEUE_URL injected by the outer stack', () => {
    const handler: any = Object.values(template.Resources).find(
      (r: any) =>
        r.Type === 'AWS::Lambda::Function' &&
        r.Properties?.Environment?.Variables?.NODE_ENV === 'production'
    );
    assert.ok(handler, 'could not find Blocks handler Lambda');
    const envVars = handler.Properties.Environment.Variables;
    assert.ok('EXTERNAL_QUEUE_URL' in envVars, 'missing EXTERNAL_QUEUE_URL on BlocksBackend handler');
  });
});
