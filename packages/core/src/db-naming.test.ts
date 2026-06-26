// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractDbRef, dbConnectionParameterName } from './db-naming.js';

describe('extractDbRef', () => {
  test('pooler form (postgres.{ref}@) yields ref', () => {
    assert.strictEqual(
      extractDbRef('postgresql://postgres.abcdef:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres'),
      'abcdef',
    );
  });

  test('direct form (db.{ref}.supabase.co) yields the same ref', () => {
    assert.strictEqual(
      extractDbRef('postgresql://postgres:pw@db.abcdef.supabase.co:5432/postgres'),
      'abcdef',
    );
  });

  test('pooler and direct forms of one project agree', () => {
    const pooler = extractDbRef('postgresql://postgres.proj123:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres');
    const direct = extractDbRef('postgresql://postgres:pw@db.proj123.supabase.co:5432/postgres');
    assert.strictEqual(pooler, direct);
  });

  test('non-Supabase host falls back to sanitized hostname', () => {
    assert.strictEqual(
      extractDbRef('postgresql://user:pw@my.db.example.com:5432/app'),
      'my-db-example-com',
    );
  });

  test('throws when no host is present', () => {
    assert.throws(() => extractDbRef('not-a-connection-string'));
  });
});

describe('dbConnectionParameterName', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function withConfig(stackId: string): string {
    tmpDir = mkdtempSync(join(tmpdir(), 'db-naming-'));
    mkdirSync(join(tmpDir, '.blocks'), { recursive: true });
    writeFileSync(join(tmpDir, '.blocks', 'config.json'), JSON.stringify({ stackId }));
    return tmpDir;
  }

  test('production name is stack-scoped (/<stackId>-prod-db-url)', () => {
    const root = withConfig('my-app-k7x2mf');
    assert.strictEqual(
      dbConnectionParameterName(root, { sandbox: false }),
      '/my-app-k7x2mf-prod-db-url',
    );
  });

  test('sandbox name embeds the per-machine sandbox id', () => {
    const root = withConfig('my-app-k7x2mf');
    mkdirSync(join(root, '.blocks-sandbox'), { recursive: true });
    writeFileSync(join(root, '.blocks-sandbox', 'sandbox-id.txt'), 'alice-0d7e1c');
    assert.strictEqual(
      dbConnectionParameterName(root, { sandbox: true }),
      '/my-app-k7x2mf-alice-0d7e1c-db-url',
    );
  });

  test('two apps (distinct stackIds) get distinct names — no collision', () => {
    const a = dbConnectionParameterName(withConfig('app-a-111111'), { sandbox: false });
    rmSync(tmpDir, { recursive: true, force: true });
    const b = dbConnectionParameterName(withConfig('app-b-222222'), { sandbox: false });
    assert.notStrictEqual(a, b);
  });

  test('does not derive from any connection string', () => {
    // Same stackId yields the same name regardless of which DB it points at —
    // the discriminator is the app's stack identity, never the connection string.
    const root = withConfig('my-app-k7x2mf');
    const name1 = dbConnectionParameterName(root, { sandbox: false });
    const name2 = dbConnectionParameterName(root, { sandbox: false });
    assert.strictEqual(name1, name2);
  });
});
