// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import {
  parseProductionRefsFromEnvContent,
  isProductionTarget,
  buildMigrateArgs,
  shouldGuardAgainstProduction,
} from './external-migrations-step.js';

const SUPA = (ref: string) =>
  `postgresql://postgres.${ref}:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;

test('parseProductionRefsFromEnvContent extracts DB identity from connection-string vars', () => {
  const content = [
    '# production config',
    `SUPABASE_DB_URL=${SUPA('prodref1')}`,
    'OTHER=not-a-db',
    `MY_CONNECTION_STRING=${SUPA('prodref2')}`,
  ].join('\n');
  assert.deepStrictEqual(parseProductionRefsFromEnvContent(content).sort(), ['prodref1', 'prodref2']);
});

test('parseProductionRefsFromEnvContent ignores comments, blanks, and non-DB keys', () => {
  assert.deepStrictEqual(parseProductionRefsFromEnvContent('\n# c\nFOO=bar\n'), []);
});

test('isProductionTarget refuses when the dev ref matches a production ref', () => {
  const prod = new Set(['prodref1', 'prodref2']);
  assert.strictEqual(isProductionTarget('prodref1', prod), true);
});

test('isProductionTarget allows a distinct dev database', () => {
  const prod = new Set(['prodref1']);
  assert.strictEqual(isProductionTarget('devref', prod), false);
});

test('isProductionTarget is safe when the dev ref is unknown (null)', () => {
  assert.strictEqual(isProductionTarget(null, new Set(['prodref1'])), false);
});

test('buildMigrateArgs (deploy/sandbox) is schema-only — no --regenerate-types', () => {
  const args = buildMigrateArgs('production', './migrations');
  assert.deepStrictEqual(args, ['--no-install', 'bb-data', 'migrate', '--stage', 'production', './migrations']);
  assert.ok(!args.some(a => a.startsWith('--regenerate-types')), 'deploy must never rewrite source');
});

test('buildMigrateArgs (dev) appends --regenerate-types=<dir> so apply also refreshes types', () => {
  const args = buildMigrateArgs('sandbox', './migrations', './aws-blocks');
  assert.deepStrictEqual(args, [
    '--no-install', 'bb-data', 'migrate', '--stage', 'sandbox', './migrations',
    '--regenerate-types=./aws-blocks',
  ]);
});

test('shouldGuardAgainstProduction: sandbox is guarded (shares .env.local with dev)', () => {
  assert.strictEqual(shouldGuardAgainstProduction('sandbox'), true);
});

test('shouldGuardAgainstProduction: production deploy is intentionally NOT guarded', () => {
  assert.strictEqual(shouldGuardAgainstProduction('production'), false);
});
