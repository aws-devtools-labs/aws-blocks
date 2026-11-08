// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Aurora DSQL cluster budget of the E2E stacks.
 *
 * E2E Sandbox and E2E Production both deploy this app, into the one E2E account
 * a PR maps to (PR number mod the pool size, see `.github/actions/e2e-slot`),
 * next to the stacks of the other PRs that run in that account at the same time.
 * An account holds at most 20 DSQL clusters (the Aurora DSQL default quota).
 * Past that, `AWS::DSQL::Cluster` fails with "Account quota of 20 clusters
 * reached" (402) and the deploy rolls back. Four PRs deploying into one account
 * at the same time is common, so a PR's two stacks get at most 4 clusters
 * together, which leaves room for the DSQL clusters other workflows deploy into
 * the same accounts.
 *
 * Synthesizes the app in both modes and counts the clusters.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..');
const CLUSTERS_PER_PR = 4;

type Resource = { Type: string };

async function synthClusterCount(sandboxMode: boolean, outdir: string): Promise<number> {
  // AGENTS.md Core rule 1: synth needs `--conditions=cdk`. Set it explicitly so the test doesn't depend on the caller's NODE_OPTIONS or on tsx's `-C`.
  const nodeOptions = process.env.NODE_OPTIONS ?? '';
  await promisify(execFile)(
    'npx',
    [
      'cdk', 'synth', '--app', 'npx tsx -C cdk aws-blocks/index.cdk.ts', '--output', outdir, '--quiet',
      '--context', `sandboxMode=${sandboxMode}`,
    ],
    {
      cwd: APP_ROOT,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        NODE_OPTIONS: nodeOptions.includes('--conditions=cdk') ? nodeOptions : `${nodeOptions} --conditions=cdk`.trim(),
      },
    },
  );
  const templates = readdirSync(outdir).filter((f) => f.endsWith('.template.json'));
  assert.ok(templates.length > 0, 'synth should produce at least one template');
  let clusters = 0;
  for (const file of templates) {
    const { Resources = {} } = JSON.parse(readFileSync(join(outdir, file), 'utf8')) as {
      Resources?: Record<string, Resource>;
    };
    clusters += Object.values(Resources).filter((r) => r.Type === 'AWS::DSQL::Cluster').length;
  }
  return clusters;
}

describe('the E2E stacks of one PR stay within their share of the DSQL cluster quota', () => {
  const outdirs: string[] = [];
  let sandbox = 0;
  let production = 0;

  before(async () => {
    const outdir = () => {
      const dir = mkdtempSync(join(tmpdir(), 'blocks-dsql-budget-'));
      outdirs.push(dir);
      return dir;
    };
    [sandbox, production] = await Promise.all([synthClusterCount(true, outdir()), synthClusterCount(false, outdir())]);
  });

  after(() => {
    for (const dir of outdirs) rmSync(dir, { recursive: true, force: true });
  });

  test(`the sandbox and production stacks hold at most ${CLUSTERS_PER_PR} DSQL clusters together`, () => {
    // Both stacks deploy DSQL, so a count of 0 means synth went wrong (e.g. mocks loaded).
    assert.ok(sandbox > 0 && production > 0, `expected DSQL clusters in both stacks, found sandbox ${sandbox}, production ${production}`);
    assert.ok(
      sandbox + production <= CLUSTERS_PER_PR,
      `sandbox ${sandbox} + production ${production} DSQL clusters is more than ${CLUSTERS_PER_PR} per PR (see this file's header)`,
    );
  });
});
