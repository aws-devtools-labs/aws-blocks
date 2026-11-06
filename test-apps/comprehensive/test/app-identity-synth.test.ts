// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `defaults.app` across every Building Block.
 *
 * Synthesizes this app (which instantiates every BB) with `defaults.app`
 * (`strict: true`) and a permissions boundary set, then checks:
 * - synth passes under `strict: true`, and the IAM report names the app and
 *   lists no violations — no Building Block's own grants or roles count as
 *   reaching outside the app, so a platform can run with `strict: true`;
 * - every `AWS::IAM::Role` in every template carries the `app` tag (so a
 *   boundary keyed on `aws:PrincipalTag/app` reads it on every role) and the
 *   permissions boundary, and is named under the app's prefix.
 *
 * The app id is `bb`, the prefix of this app's stack names (`bb-test-…`).
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
const APP_ID = 'bb';

type RoleProperties = {
  Tags?: { Key: string; Value: unknown }[];
  PermissionsBoundary?: unknown;
  RoleName?: unknown;
};
type Template = { Resources?: Record<string, { Type: string; Properties?: RoleProperties }> };

/** Whether `name` is under the app's prefix: `<id>`, `<id>-…` or `<id>/…`. */
const underPrefix = (name: string) => name === APP_ID || name.startsWith(`${APP_ID}-`) || name.startsWith(`${APP_ID}/`);

describe('defaults.app: every Building Block stays inside the app', () => {
  let outdir: string;
  let synthError: string | undefined;

  before(() => {
    outdir = mkdtempSync(join(tmpdir(), 'blocks-app-identity-'));
    // AGENTS.md Core rule 1: synth needs `--conditions=cdk`.
    const nodeOptions = process.env.NODE_OPTIONS ?? '';
    try {
      execFileSync(
        'npx',
        [
          'cdk', 'synth', '--app', 'npx tsx -C cdk aws-blocks/index.cdk.ts', '--output', outdir, '--quiet',
          '--context', 'sandboxMode=true', '--context', 'blocksPermissionsBoundary=apps-boundary',
          '--context', `blocksAppId=${APP_ID}`, '--context', 'blocksAppStrict=true',
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
    } catch (error) {
      const e = error as { stderr?: Buffer; message?: string };
      synthError = e.stderr?.toString() || e.message || String(error);
    }
  });

  after(() => rmSync(outdir, { recursive: true, force: true }));

  const templates = (): { file: string; template: Template }[] =>
    readdirSync(outdir)
      .filter((f) => f.endsWith('.template.json'))
      .map((file) => ({ file, template: JSON.parse(readFileSync(join(outdir, file), 'utf8')) as Template }));

  /** Every `AWS::IAM::Role` in every template, by `<template>: <logical id>`. */
  const roles = (): { where: string; props: RoleProperties }[] =>
    templates().flatMap(({ file, template }) =>
      Object.entries(template.Resources ?? {})
        .filter(([, r]) => r.Type === 'AWS::IAM::Role')
        .map(([id, r]) => ({ where: `${file}: ${id}`, props: r.Properties ?? {} })),
    );

  test('synth passes with defaults.app.strict: true', () => {
    assert.strictEqual(synthError, undefined, `strict synth failed:\n${synthError}`);
  });

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
    const all = roles();
    assert.ok(all.length >= 10, `expected the full app's roles, found only ${all.length}`);
    const missing = all
      .map(({ where, props }) => ({ where, tag: props.Tags?.find((t) => t.Key === 'app')?.Value }))
      .filter(({ tag }) => tag !== APP_ID)
      .map(({ where, tag }) => `${where} → ${JSON.stringify(tag ?? 'NONE')}`);
    assert.deepStrictEqual(missing, [], `roles without app=${APP_ID}:\n  ${missing.join('\n  ')}`);
  });

  test('every AWS::IAM::Role in every template carries the permissions boundary', () => {
    const unbounded = roles()
      .filter(({ props }) => props.PermissionsBoundary === undefined || props.PermissionsBoundary === null)
      .map(({ where }) => where);
    assert.deepStrictEqual(unbounded, [], `roles without a permissions boundary:\n  ${unbounded.join('\n  ')}`);
  });

  test("every stack and every AWS::IAM::Role is named under the app's prefix", () => {
    // A role without a `RoleName` gets a CloudFormation-generated name that starts
    // with its stack's name, so the stack names must be under the prefix too.
    const stacks = templates().map(({ file }) => file.replace(/\.template\.json$/, ''));
    assert.deepStrictEqual(stacks.filter((s) => !underPrefix(s)), [], `stacks not named ${APP_ID} or ${APP_ID}-…`);
    const outside = roles()
      .filter(({ props }) => props.RoleName !== undefined && !(typeof props.RoleName === 'string' && underPrefix(props.RoleName)))
      .map(({ where, props }) => `${where} → ${JSON.stringify(props.RoleName)}`);
    assert.deepStrictEqual(outside, [], `roles named outside "${APP_ID}-":\n  ${outside.join('\n  ')}`);
  });
});
