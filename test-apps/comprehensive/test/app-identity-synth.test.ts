// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `defaults.app` across every Building Block.
 *
 * Synthesizes this app (which instantiates every BB) with `defaults.app` and a
 * permissions boundary set, then checks:
 * - no Building Block's own grants or roles count as reaching outside the app —
 *   the IAM report lists no violations, so a platform can run with `strict: true`
 *   and `blocks-iam-check` passes on a plain AWS Blocks app;
 * - every `AWS::IAM::Role` carries the `app` tag, so a boundary keyed on
 *   `aws:PrincipalTag/app` reads it on every role.
 *
 * The app id is `bb`, the prefix of this app's stack names (`bb-test-…`).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..');
const APP_ID = 'bb';

type Resource = { Type: string; Properties?: { Tags?: { Key: string; Value: unknown }[] } };

describe('defaults.app: every Building Block stays inside the app', () => {
  let outdir: string;

  before(() => {
    outdir = mkdtempSync(join(tmpdir(), 'blocks-app-identity-'));
    // AGENTS.md Core rule 1: synth needs `--conditions=cdk`.
    const nodeOptions = process.env.NODE_OPTIONS ?? '';
    execFileSync(
      'npx',
      [
        'cdk', 'synth', '--app', 'npx tsx -C cdk aws-blocks/index.cdk.ts', '--output', outdir, '--quiet',
        '--context', 'sandboxMode=true', '--context', 'blocksPermissionsBoundary=apps-boundary',
        '--context', `blocksAppId=${APP_ID}`,
        // On a shared platform each app's bootstrap qualifier is its app id.
        '--context', `@aws-cdk/core:bootstrapQualifier=${APP_ID}`,
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

  test('the IAM report names the app and lists no violations', () => {
    const reports = readdirSync(outdir).filter((f) => f.endsWith('.blocks-iam.json'));
    assert.strictEqual(reports.length, 1, `expected one report, found ${reports}`);
    const report = JSON.parse(readFileSync(join(outdir, reports[0]), 'utf8')) as {
      app?: { id: string };
      violations?: { rule: string; message: string }[];
    };
    assert.strictEqual(report.app?.id, APP_ID);
    assert.deepStrictEqual(
      (report.violations ?? []).map((v) => `[${v.rule}] ${v.message}`),
      [],
      'a Building Block reached outside the app',
    );
  });

  test('every AWS::IAM::Role in every template carries app=<id>', () => {
    const missing: string[] = [];
    let checked = 0;
    for (const file of readdirSync(outdir).filter((f) => f.endsWith('.template.json'))) {
      const { Resources = {} } = JSON.parse(readFileSync(join(outdir, file), 'utf8')) as {
        Resources?: Record<string, Resource>;
      };
      for (const [id, r] of Object.entries(Resources)) {
        if (r.Type !== 'AWS::IAM::Role') continue;
        checked++;
        const tag = r.Properties?.Tags?.find((t) => t.Key === 'app')?.Value;
        if (tag !== APP_ID) missing.push(`${file}: ${id} → ${JSON.stringify(tag ?? 'NONE')}`);
      }
    }
    assert.ok(checked >= 10, `expected the full app's roles, found only ${checked}`);
    assert.deepStrictEqual(missing, [], `roles without app=${APP_ID}:\n  ${missing.join('\n  ')}`);
  });

  test("every action a Building Block's roles are granted is allowed by the generated boundary's allow-list", async () => {
    // `@aws-blocks/core` resolves to `<pkg>/dist/index.js`; the generator sits beside it.
    const core = dirname(createRequire(import.meta.url).resolve('@aws-blocks/core'));
    const { generateBoundaryPolicy } = (await import(pathToFileURL(join(core, 'scripts', 'iam-policies.js')).href)) as {
      generateBoundaryPolicy: () => { Statement: { Effect: string; Action: string | string[] }[] };
    };
    const allowed = generateBoundaryPolicy()
      .Statement.filter((s) => s.Effect === 'Allow')
      .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    const glob = (pattern: string, value: string) =>
      new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i').test(value);
    const uncovered = new Set<string>();
    for (const file of readdirSync(outdir).filter((f) => f.endsWith('.template.json'))) {
      const { Resources = {} } = JSON.parse(readFileSync(join(outdir, file), 'utf8')) as {
        Resources?: Record<string, { Type: string; Properties?: Record<string, unknown> }>;
      };
      const docs: unknown[] = [];
      for (const r of Object.values(Resources)) {
        if (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy') docs.push(r.Properties?.PolicyDocument);
        if (r.Type === 'AWS::IAM::Role') {
          for (const p of (r.Properties?.Policies as { PolicyDocument: unknown }[] | undefined) ?? []) docs.push(p.PolicyDocument);
        }
      }
      for (const doc of docs as { Statement?: { Effect: string; Action?: string | string[] }[] }[]) {
        for (const s of doc?.Statement ?? []) {
          if (s.Effect !== 'Allow') continue;
          for (const action of Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : []) {
            if (!allowed.some((a) => glob(a, action))) uncovered.add(action);
          }
        }
      }
    }
    assert.deepStrictEqual([...uncovered].sort(), [], 'actions Building Blocks grant that the boundary would deny');
  });

  test('blocks-iam-check passes on the synthesized templates', () => {
    // `@aws-blocks/core` resolves to `<pkg>/dist/index.js`; the CLI sits beside it.
    const cli = join(dirname(createRequire(import.meta.url).resolve('@aws-blocks/core')), 'scripts', 'iam-check-cli.js');
    const output = execFileSync(process.execPath, [cli, outdir, '--app', APP_ID], { encoding: 'utf8' });
    assert.match(output, /no violations/);
  });
});
