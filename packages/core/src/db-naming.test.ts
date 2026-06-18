// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { extractDbRef } from './db-naming.js';

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
