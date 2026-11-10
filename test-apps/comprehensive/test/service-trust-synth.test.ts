// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Confused-deputy coverage across every Building Block.
 *
 * Synthesizes this app (which instantiates every BB) with API Gateway access
 * logging on, and fails if ANY `AWS::IAM::Role` in ANY synthesized template
 * lets an AWS service assume it without both `aws:SourceAccount` and
 * `aws:SourceArn` on the trust statement — unless the service principal is
 * one of core's documented exclusions (`SERVICE_TRUST_EXCLUSIONS` in
 * `packages/core/src/cdk/service-trust.ts`). So a new block, or a new role in
 * an existing one, that trusts a service without the keys fails here.
 *
 * Scope: one VPC-free `BlocksStack` with no Hosting, as in
 * `iam-boundary-synth.test.ts`. Hosting's roles (SSR, Lambda@Edge, the
 * us-east-1 helper stacks) are checked in `packages/core/src/hosting.test.ts`
 * (describe block "defaults.permissionsBoundary of the fronted backend", test
 * "every service-principal trust on these roles …").
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import { describeUnscopedServiceTrust, findUnscopedServiceTrust } from '@aws-blocks/core/cdk/internal';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..');

type Resource = {
  Type: string;
  Properties?: { AssumeRolePolicyDocument?: { Statement?: { Principal?: { Service?: unknown } }[] } };
  Metadata?: { 'aws:cdk:path'?: string };
};

describe('every service-principal trust in the comprehensive app is scoped to this account', () => {
  let outdir: string;

  before(() => {
    outdir = mkdtempSync(join(tmpdir(), 'blocks-service-trust-'));
    // AGENTS.md Core rule 1: synth needs `--conditions=cdk`. Set it explicitly so the test doesn't depend on the caller's NODE_OPTIONS or on tsx's `-C`.
    const nodeOptions = process.env.NODE_OPTIONS ?? '';
    execFileSync(
      'npx',
      [
        'cdk', 'synth', '--app', 'npx tsx -C cdk aws-blocks/index.cdk.ts', '--output', outdir, '--quiet',
        '--context', 'sandboxMode=true', '--context', 'blocksAccessLogging=true',
      ],
      {
        cwd: APP_ROOT,
        stdio: 'pipe',
        env: {
          ...process.env,
          NODE_OPTIONS: nodeOptions.includes('--conditions=cdk') ? nodeOptions : `${nodeOptions} --conditions=cdk`.trim(),
        },
      },
    );
  });

  after(() => rmSync(outdir, { recursive: true, force: true }));

  test('every AWS::IAM::Role trusts services only with aws:SourceAccount and aws:SourceArn (or a documented exclusion)', () => {
    const templates = readdirSync(outdir).filter((f) => f.endsWith('.template.json'));
    assert.ok(templates.length > 0, 'synth should produce at least one template');
    const services = new Set<string>();
    const problems: string[] = [];
    let checked = 0;
    for (const file of templates) {
      const { Resources = {} } = JSON.parse(readFileSync(join(outdir, file), 'utf8')) as {
        Resources?: Record<string, Resource>;
      };
      for (const [id, r] of Object.entries(Resources)) {
        if (r.Type !== 'AWS::IAM::Role') continue;
        checked++;
        const trust = r.Properties?.AssumeRolePolicyDocument;
        for (const s of trust?.Statement ?? []) {
          for (const svc of [s.Principal?.Service ?? []].flat()) if (typeof svc === 'string') services.add(svc);
        }
        const roleIds = [id, ...(r.Metadata?.['aws:cdk:path'] ? [r.Metadata['aws:cdk:path']] : [])];
        const findings = findUnscopedServiceTrust(trust, roleIds);
        if (findings.length > 0) problems.push(describeUnscopedServiceTrust(`${file}: ${id}`, findings));
      }
    }
    // The app exercises every BB, so a near-empty count means synth went wrong (e.g. mocks loaded).
    assert.ok(checked >= 10, `expected the full app's roles, found only ${checked}`);
    // The roles this guard exists for are present, so a pass is not vacuous.
    for (const svc of ['apigateway.amazonaws.com', 'bedrock.amazonaws.com', 'scheduler.amazonaws.com']) {
      assert.ok(services.has(svc), `expected a role trusted by ${svc}; found ${[...services].sort().join(', ')}`);
    }
    assert.deepStrictEqual(
      problems,
      [],
      `service-principal trusts without aws:SourceAccount and aws:SourceArn:\n  ${problems.join('\n  ')}`,
    );
  });
});
