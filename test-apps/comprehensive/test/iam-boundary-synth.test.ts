// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Permissions-boundary coverage across every Building Block.
 *
 * Synthesizes this app (which instantiates every BB) with
 * `defaults.permissionsBoundary` set and fails if ANY `AWS::IAM::Role` in ANY
 * synthesized template lacks the boundary. A platform that requires a boundary
 * on every role its apps create (an `iam:PermissionsBoundary` condition on its
 * deploy role) needs this to hold for every block — so a new block, or a new
 * compute, that creates a role outside the boundary's reach fails here.
 *
 * Also checks the synth-time IAM report (`<stack>.blocks-iam.json`) is written.
 *
 * Scope: this guard covers every Building Block's roles in one VPC-free
 * `BlocksStack` with no Hosting. The other topologies are covered elsewhere:
 * off-region Hosting, Lambda@Edge and the cross-region-reference provider in
 * `packages/core/src/hosting.test.ts` (describe block
 * "defaults.permissionsBoundary of the fronted backend"), and embedded
 * `BlocksBackend` topologies in `packages/core/src/cdk/permissions-boundary.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..');
const BOUNDARY = 'blocks-test-boundary';
const EXPECTED = {
  'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::', { Ref: 'AWS::AccountId' }, `:policy/${BOUNDARY}`]],
};

type Resource = { Type: string; Properties?: { PermissionsBoundary?: unknown } };

describe('defaults.permissionsBoundary covers every role in the comprehensive app', () => {
  let outdir: string;

  before(() => {
    outdir = mkdtempSync(join(tmpdir(), 'blocks-iam-boundary-'));
    // AGENTS.md Core rule 1: synth needs `--conditions=cdk`. Set it explicitly so the test doesn't depend on the caller's NODE_OPTIONS or on tsx's `-C`.
    const nodeOptions = process.env.NODE_OPTIONS ?? '';
    execFileSync(
      'npx',
      [
        'cdk', 'synth', '--app', 'npx tsx -C cdk aws-blocks/index.cdk.ts', '--output', outdir, '--quiet',
        '--context', 'sandboxMode=true', '--context', `blocksPermissionsBoundary=${BOUNDARY}`,
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

  test('every AWS::IAM::Role in every template carries the boundary', () => {
    const templates = readdirSync(outdir).filter((f) => f.endsWith('.template.json'));
    assert.ok(templates.length > 0, 'synth should produce at least one template');
    let checked = 0;
    const missing: string[] = [];
    for (const file of templates) {
      const { Resources = {} } = JSON.parse(readFileSync(join(outdir, file), 'utf8')) as {
        Resources?: Record<string, Resource>;
      };
      for (const [id, r] of Object.entries(Resources)) {
        if (r.Type !== 'AWS::IAM::Role') continue;
        checked++;
        if (JSON.stringify(r.Properties?.PermissionsBoundary) !== JSON.stringify(EXPECTED)) {
          missing.push(`${file}: ${id} → ${JSON.stringify(r.Properties?.PermissionsBoundary ?? 'NONE')}`);
        }
      }
    }
    // The app exercises every BB, so a near-empty count means synth went wrong (e.g. mocks loaded).
    assert.ok(checked >= 10, `expected the full app's roles, found only ${checked}`);
    assert.deepStrictEqual(missing, [], `roles without the permissions boundary:\n  ${missing.join('\n  ')}`);
  });

  test('writes the IAM report for the shared execution role', () => {
    const reports = readdirSync(outdir).filter((f) => f.endsWith('.blocks-iam.json'));
    assert.strictEqual(reports.length, 1, `expected one report, found ${reports}`);
    const report = JSON.parse(readFileSync(join(outdir, reports[0]), 'utf8')) as {
      executionRole: { permissionsBoundary: unknown; statements: { actions?: string[]; blocks: string[] }[] };
    };
    assert.deepStrictEqual(report.executionRole.permissionsBoundary, EXPECTED);
    const dynamo = report.executionRole.statements.filter((s) => s.actions?.some((a) => a.startsWith('dynamodb:')));
    assert.ok(dynamo.length > 0, 'the KV/table blocks grant DynamoDB access');
    assert.ok(dynamo.some((s) => s.blocks.length > 0), 'DynamoDB grants are attributed to their blocks');
  });
});
