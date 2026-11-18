// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import { sql, unwrapQuery } from './sql.js';

test('sql tag produces parameterized query', () => {
  const q = sql`SELECT * FROM users WHERE id = ${'abc'} AND age > ${18}`;
  assert.strictEqual(q.sql, 'SELECT * FROM users WHERE id = $1 AND age > $2');
  assert.deepStrictEqual([...q.params], ['abc', 18]);
});

test('sql tag with no interpolations', () => {
  const q = sql`SELECT 1`;
  assert.strictEqual(q.sql, 'SELECT 1');
  assert.deepStrictEqual([...q.params], []);
});

test('sql tag handles null and undefined params', () => {
  const q = sql`INSERT INTO t VALUES (${null}, ${undefined})`;
  assert.strictEqual(q.sql, 'INSERT INTO t VALUES ($1, $2)');
  assert.deepStrictEqual([...q.params], [null, undefined]);
});

test('unwrapQuery returns mutable copies', () => {
  const q = sql`SELECT ${1}`;
  const { sql: s, params } = unwrapQuery(q);
  assert.strictEqual(s, 'SELECT $1');
  params.push('extra');
  assert.strictEqual(q.params.length, 1);
});

test('SqlQuery cannot be constructed from a plain object', () => {
  const fake = { sql: 'SELECT 1', params: [] };
  const realKeys = Object.getOwnPropertySymbols(sql`SELECT 1`);
  const fakeKeys = Object.getOwnPropertySymbols(fake);
  assert.strictEqual(realKeys.length, 1);
  assert.strictEqual(fakeKeys.length, 0);
});

test('unwrapQuery rejects forged objects at runtime', () => {
  const fake = { sql: 'SELECT 1', params: [] } as any;
  assert.throws(
    () => unwrapQuery(fake),
    (err: Error) => err.message.includes('use the sql tagged template')
  );
});

// ─── unwrapQuery — brand guard integrity ────────────────────────────────────
// The brand guard must use identity comparison against the module-private
// SQL_BRAND symbol. A foreign Symbol('SafeSQL') must not pass — only objects
// created by the sql tagged template carry the real brand.

test('unwrapQuery rejects an object forged with a same-named Symbol', () => {
  const forged = {
    [Symbol('SafeSQL')]: true,
    sql: 'DROP TABLE users',
    params: [],
  } as any;
  assert.throws(
    () => unwrapQuery(forged),
    (err: Error) => err.message.includes('use the sql tagged template'),
    'a foreign Symbol("SafeSQL") must not pass the brand guard',
  );
});

test('unwrapQuery rejects a forged object carrying an extra decoy symbol', () => {
  const forged: any = { sql: 'DELETE FROM accounts', params: [] };
  forged[Symbol('SafeSQL')] = true;
  forged[Symbol('other')] = true;
  assert.throws(
    () => unwrapQuery(forged),
    (err: Error) => err.message.includes('use the sql tagged template'),
  );
});

test('unwrapQuery still accepts a genuine sql`` query', () => {
  const q = sql`SELECT * FROM t WHERE id = ${'x'}`;
  const { sql: s, params } = unwrapQuery(q);
  assert.strictEqual(s, 'SELECT * FROM t WHERE id = $1');
  assert.deepStrictEqual(params, ['x']);
});
