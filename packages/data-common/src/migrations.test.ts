// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import { splitStatements } from './migrations.js';

test('splitStatements splits on ; and trims', () => {
  const result = splitStatements('CREATE TABLE t (id INT);\nINSERT INTO t VALUES (1);\n');
  assert.deepStrictEqual(result, ['CREATE TABLE t (id INT)', 'INSERT INTO t VALUES (1)']);
});

test('splitStatements filters empty strings', () => {
  const result = splitStatements('SELECT 1;  ;  ; SELECT 2;');
  assert.deepStrictEqual(result, ['SELECT 1', 'SELECT 2']);
});

test('splitStatements handles dollar-quoted blocks', () => {
  const sql = `DO $$ BEGIN RAISE NOTICE 'hello; world'; END $$; SELECT 1;`;
  const result = splitStatements(sql);
  assert.deepStrictEqual(result, [
    `DO $$ BEGIN RAISE NOTICE 'hello; world'; END $$`,
    'SELECT 1',
  ]);
});

test('splitStatements handles tagged dollar-quoting', () => {
  const sql = `CREATE FUNCTION f() RETURNS void AS $fn$ BEGIN NULL; END; $fn$; SELECT 2;`;
  const result = splitStatements(sql);
  assert.strictEqual(result.length, 2);
  assert.ok(result[0].includes('$fn$'));
  assert.strictEqual(result[1], 'SELECT 2');
});

test('splitStatements handles semicolons inside string literals', () => {
  const sql = `INSERT INTO t VALUES ('a;b'); SELECT 1;`;
  const result = splitStatements(sql);
  assert.deepStrictEqual(result, [`INSERT INTO t VALUES ('a;b')`, 'SELECT 1']);
});

test('splitStatements handles escaped quotes in strings', () => {
  const sql = `INSERT INTO t VALUES ('it''s;here'); SELECT 2;`;
  const result = splitStatements(sql);
  assert.deepStrictEqual(result, [`INSERT INTO t VALUES ('it''s;here')`, 'SELECT 2']);
});

// ─── splitStatements — positional parameters ────────────────────────────────
// PostgreSQL dollar-quote tags are $$ or $tag$ (tag starts with a
// letter/underscore). Positional params ($1, $2, $10) must NOT be treated as
// dollar-quote openers — they should pass through so statements split correctly.

test('splitStatements: positional params do not merge two statements', () => {
  const sql = 'INSERT INTO t (a) VALUES ($1); DELETE FROM u WHERE id = $2;';
  const result = splitStatements(sql);
  assert.deepStrictEqual(result, [
    'INSERT INTO t (a) VALUES ($1)',
    'DELETE FROM u WHERE id = $2',
  ]);
});

test('splitStatements: three statements each using a positional param', () => {
  const sql = 'INSERT INTO t (a) VALUES ($1); DELETE FROM u WHERE id = $2; SELECT $3;';
  const result = splitStatements(sql);
  assert.deepStrictEqual(result, [
    'INSERT INTO t (a) VALUES ($1)',
    'DELETE FROM u WHERE id = $2',
    'SELECT $3',
  ]);
});

test('splitStatements: multi-digit positional params ($10, $11) split correctly', () => {
  const sql = 'UPDATE t SET a = $10 WHERE id = $11; SELECT 1;';
  const result = splitStatements(sql);
  assert.deepStrictEqual(result, [
    'UPDATE t SET a = $10 WHERE id = $11',
    'SELECT 1',
  ]);
});

test('splitStatements: single positional param in one statement stays intact', () => {
  const sql = 'UPDATE accounts SET balance = $1 WHERE id = $2';
  const result = splitStatements(sql);
  assert.deepStrictEqual(result, ['UPDATE accounts SET balance = $1 WHERE id = $2']);
});

test('splitStatements: positional params inside a real $$ body do not break the body', () => {
  // The $$...$$ body is a genuine dollar-quoted region; the $1/$2 inside it must
  // remain part of the single function statement, and the trailing statement splits.
  const sql = 'CREATE FUNCTION add2(a int, b int) RETURNS int AS $$ BEGIN RETURN $1 + $2; END $$ LANGUAGE plpgsql; SELECT 1;';
  const result = splitStatements(sql);
  assert.strictEqual(result.length, 2);
  assert.ok(result[0].includes('RETURN $1 + $2'), `function body should be intact, got: ${result[0]}`);
  assert.strictEqual(result[1], 'SELECT 1');
});

// ─── splitStatements — SQL comments ─────────────────────────────────────────
// Line comments (-- ...) and block comments (/* ... */) may contain semicolons.
// The scanner must skip comment text without treating those semicolons as
// statement terminators. Comment markers inside string literals must still be
// treated as ordinary string content.

test('splitStatements: line comment containing a semicolon is not split', () => {
  const sql = '-- DSQL notes: one DDL per file; UUID keys distribute well;\nCREATE TABLE t (id TEXT PRIMARY KEY)';
  const result = splitStatements(sql);
  assert.strictEqual(result.length, 1, `expected 1 statement, got: ${JSON.stringify(result)}`);
  assert.ok(result[0].includes('CREATE TABLE t'), `expected the DDL to survive, got: ${result[0]}`);
});

test('splitStatements: trailing inline line comment with a semicolon does not create fragments', () => {
  const sql = "INSERT INTO t (a) VALUES (1); -- sets a; default\nINSERT INTO t (a) VALUES (2);";
  const result = splitStatements(sql);
  assert.deepStrictEqual(result, [
    'INSERT INTO t (a) VALUES (1)',
    'INSERT INTO t (a) VALUES (2)',
  ]);
});

test('splitStatements: block comment containing a semicolon is not split', () => {
  const sql = 'CREATE TABLE a (id TEXT); /* step 2; create b */ CREATE TABLE b (id TEXT);';
  const result = splitStatements(sql);
  assert.deepStrictEqual(result, [
    'CREATE TABLE a (id TEXT)',
    'CREATE TABLE b (id TEXT)',
  ]);
});

test('splitStatements: -- inside a string literal is NOT treated as a comment', () => {
  const sql = "INSERT INTO t (note) VALUES ('a--b; c'); SELECT 1;";
  const result = splitStatements(sql);
  assert.deepStrictEqual(result, [
    "INSERT INTO t (note) VALUES ('a--b; c')",
    'SELECT 1',
  ]);
});

test('splitStatements: regression — commented DSQL migration yields a single CREATE TABLE', () => {
  const sql = `-- DSQL notes: at most one DDL statement per migration file; UUID keys distribute well;
CREATE TABLE IF NOT EXISTS "todos" (
  "id"        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "ownerId"   TEXT NOT NULL,
  "content"   TEXT NOT NULL,
  "isDone"    BOOLEAN NOT NULL DEFAULT false
);`;
  const result = splitStatements(sql);
  assert.strictEqual(result.length, 1, `expected 1 statement, got: ${JSON.stringify(result)}`);
  assert.ok(result[0].includes('CREATE TABLE IF NOT EXISTS "todos"'));
});

test('splitStatements skips psql meta-commands (pg_dump 17/18 \\restrict / \\unrestrict)', () => {
  // A real pg_dump --schema-only header: a \restrict line (no semicolon, line-
  // terminated) before the SQL, and \unrestrict after it. Executing those over
  // the pg wire protocol fails with `syntax error at or near "\"`.
  const sql = [
    '\\restrict dPbJhhdUWDbOIUDELDNA5BNlkZZtw22Y',
    '',
    'SET statement_timeout = 0;',
    "SELECT pg_catalog.set_config('search_path', '', false);",
    'CREATE TABLE public.t (id integer);',
    '',
    '\\unrestrict dPbJhhdUWDbOIUDELDNA5BNlkZZtw22Y',
  ].join('\n');
  const result = splitStatements(sql);
  assert.ok(!result.some(s => s.includes('\\restrict')), 'must drop the \\restrict meta-command');
  assert.ok(!result.some(s => s.includes('\\unrestrict')), 'must drop the \\unrestrict meta-command');
  assert.deepStrictEqual(result, [
    'SET statement_timeout = 0',
    "SELECT pg_catalog.set_config('search_path', '', false)",
    'CREATE TABLE public.t (id integer)',
  ]);
});

test('splitStatements keeps a backslash that lives inside a string literal', () => {
  // The meta-command skip must only fire at statement start, not for a backslash
  // inside a value (here a Windows-style path in a string literal).
  const sql = "INSERT INTO t (p) VALUES ('C:\\Users\\x');";
  const result = splitStatements(sql);
  assert.deepStrictEqual(result, ["INSERT INTO t (p) VALUES ('C:\\Users\\x')"]);
});
