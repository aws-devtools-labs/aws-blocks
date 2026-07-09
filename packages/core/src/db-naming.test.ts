// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractDbRef, dbConnectionParameterName } from './db-naming.js';
import { getStackName } from './scripts/stack-id.js';

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
  test('formats stack name into parameter path', () => {
    assert.strictEqual(dbConnectionParameterName('my-app-k7x2mf-prod'), '/my-app-k7x2mf-prod-db-url');
  });

  test('two distinct stack names produce distinct parameter names', () => {
    assert.notStrictEqual(
      dbConnectionParameterName('app-a-111111-prod'),
      dbConnectionParameterName('app-b-222222-prod'),
    );
  });
});

describe('cross-site invariant: write name == read name', () => {
  let tmpDir: string;
  let originalCwd: string;

  afterEach(() => {
    if (originalCwd) process.chdir(originalCwd);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupProject(stackId: string, sandboxId: string): string {
    tmpDir = mkdtempSync(join(tmpdir(), 'cross-site-'));
    mkdirSync(join(tmpDir, '.blocks'), { recursive: true });
    writeFileSync(join(tmpDir, '.blocks', 'config.json'), JSON.stringify({ stackId }));
    mkdirSync(join(tmpDir, '.blocks-sandbox'), { recursive: true });
    writeFileSync(join(tmpDir, '.blocks-sandbox', 'sandbox-id.txt'), sandboxId);
    return tmpDir;
  }

  test('write-side name == read-side name (sandbox)', () => {
    const root = setupProject('my-app-k7x2mf', 'alice-0d7e1c');
    const writeName = dbConnectionParameterName(getStackName({ sandbox: true, projectRoot: root }));
    originalCwd = process.cwd();
    process.chdir(root);
    const readName = dbConnectionParameterName(getStackName({ sandbox: true }));
    assert.strictEqual(writeName, readName);
  });

  test('write-side name == read-side name (production)', () => {
    const root = setupProject('my-app-k7x2mf', 'alice-0d7e1c');
    const writeName = dbConnectionParameterName(getStackName({ sandbox: false, projectRoot: root }));
    originalCwd = process.cwd();
    process.chdir(root);
    const readName = dbConnectionParameterName(getStackName({ sandbox: false }));
    assert.strictEqual(writeName, readName);
  });
});
