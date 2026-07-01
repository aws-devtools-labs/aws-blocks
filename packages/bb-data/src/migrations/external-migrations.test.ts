// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import {
  toSessionPortUrl,
  advisoryLockKey,
  warnUngrantedCreateTable,
  extractCreatedTableNames,
  decideBaseline,
} from './external-migrations.js';

test('toSessionPortUrl rewrites the 6543 transaction-pooler port to 5432', () => {
  const out = toSessionPortUrl(
    'postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?prepared_statements=false',
  );
  const u = new URL(out);
  assert.strictEqual(u.port, '5432');
});

test('toSessionPortUrl drops the prepared_statements and sslmode hints, preserves others', () => {
  const out = toSessionPortUrl('postgresql://u:p@host:6543/db?prepared_statements=false&sslmode=require&application_name=blocks');
  assert.ok(!out.includes('prepared_statements'), 'prepared_statements should be removed');
  // sslmode is stripped so an explicitly-configured ssl (pinned CA) takes effect:
  // node pg ignores a programmatic ssl.ca when sslmode is present in the URL.
  assert.ok(!out.includes('sslmode'), 'sslmode should be removed');
  assert.ok(out.includes('application_name=blocks'), 'unrelated params preserved');
});

test('toSessionPortUrl is a no-op on port when no explicit port (sets 5432)', () => {
  // The old `.replace(":5432/",":6543/")` fragility: a URL without an explicit
  // port. new URL() + explicit assignment fixes the port deterministically.
  const out = toSessionPortUrl('postgresql://u:p@host/db');
  assert.strictEqual(new URL(out).port, '5432');
});

test('toSessionPortUrl throws an actionable error on a non-URL string', () => {
  assert.throws(
    () => toSessionPortUrl('not-a-url'),
    (e: Error) => {
      assert.strictEqual(e.name, 'ConnectionFailedException');
      return true;
    },
  );
});

test('advisoryLockKey is deterministic, positive, and within int4 range', () => {
  const a = advisoryLockKey('production:./migrations');
  const b = advisoryLockKey('production:./migrations');
  assert.strictEqual(a, b);
  assert.ok(a >= 0 && a <= 0x7fffffff);
});

test('advisoryLockKey differs by input (distinct apps/stages do not collide)', () => {
  assert.notStrictEqual(
    advisoryLockKey('sandbox:./migrations'),
    advisoryLockKey('production:./migrations'),
  );
});

test('warnUngrantedCreateTable warns on CREATE TABLE without a GRANT', () => {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (msg?: any) => { warnings.push(String(msg)); };
  try {
    warnUngrantedCreateTable({ '001.sql': 'CREATE TABLE tasks (id text primary key);' });
  } finally {
    console.warn = orig;
  }
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /tasks/);
  assert.match(warnings[0], /GRANT/);
});

test('warnUngrantedCreateTable stays silent when the file grants access', () => {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (msg?: any) => { warnings.push(String(msg)); };
  try {
    warnUngrantedCreateTable({
      '001.sql': 'CREATE TABLE tasks (id text primary key);\nGRANT ALL ON tasks TO authenticated;',
    });
  } finally {
    console.warn = orig;
  }
  assert.strictEqual(warnings.length, 0);
});

test('warnUngrantedCreateTable ignores ALTER-only migrations', () => {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (msg?: any) => { warnings.push(String(msg)); };
  try {
    warnUngrantedCreateTable({ '002.sql': 'ALTER TABLE tasks ADD COLUMN priority int;' });
  } finally {
    console.warn = orig;
  }
  assert.strictEqual(warnings.length, 0);
});

// Regression: a pg_dump baseline embeds DDL keywords inside function bodies,
// comments, and string literals. A naive scan picks them up as phantom tables
// and derails the baseline decision (observed against a real Supabase DB whose
// `rls_auto_enable()` event-trigger function contains the literal
// 'CREATE TABLE AS' → phantom table "AS" → 'ambiguous' → migrations blocked).
const BASELINE_WITH_FUNCTION_BODY = `
CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  FOR cmd IN SELECT * FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  LOOP
    EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
  END LOOP;
END;
$$;

CREATE TABLE public.projects (id uuid PRIMARY KEY, name text);
-- CREATE TABLE public.ignored_comment (id int);
/* CREATE TABLE public.ignored_block (id int); */
CREATE TABLE public.tags (id serial PRIMARY KEY, label text);
`;

test('extractCreatedTableNames ignores CREATE TABLE in function bodies, comments, and literals', () => {
  const names = extractCreatedTableNames(BASELINE_WITH_FUNCTION_BODY).sort();
  assert.deepStrictEqual(names, ['projects', 'tags']);
  assert.ok(!names.includes('AS'), 'must not extract the phantom "AS" from the function body literal');
});

test('decideBaseline marks an existing pulled DB as applied (no phantom-driven ambiguity)', () => {
  // The bug surfaced here: phantom "AS" made present(4) < expected(5) → 'ambiguous'.
  const expected = extractCreatedTableNames(BASELINE_WITH_FUNCTION_BODY);
  const actual = ['projects', 'tags']; // the real tables already in the DB
  assert.strictEqual(decideBaseline(expected, actual), 'mark-baseline-applied');
});

test('warnUngrantedCreateTable does not warn on CREATE TABLE inside a string literal', () => {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (msg?: any) => { warnings.push(String(msg)); };
  try {
    warnUngrantedCreateTable({
      '003.sql': `DO $$ BEGIN RAISE NOTICE 'CREATE TABLE phantom (id int)'; END $$;`,
    });
  } finally {
    console.warn = orig;
  }
  assert.strictEqual(warnings.length, 0);
});

// decideBaseline branch coverage (pure function): the three outcomes that drive
// maybeMarkBaselineApplied. 'mark-baseline-applied' is covered above.
test("decideBaseline returns 'run-all' for an empty database (none of the baseline tables present)", () => {
  assert.strictEqual(decideBaseline(['projects', 'tags'], []), 'run-all');
  // Unrelated tables already in the DB (e.g. a shared `todos` fixture) are ignored —
  // only the baseline's own tables count toward the decision.
  assert.strictEqual(decideBaseline(['projects', 'tags'], ['todos', 'other']), 'run-all');
});

test("decideBaseline returns 'run-all' when the baseline creates no tables", () => {
  assert.strictEqual(decideBaseline([], ['todos']), 'run-all');
});

test("decideBaseline returns 'ambiguous' for a partially-populated database", () => {
  assert.strictEqual(decideBaseline(['projects', 'tags'], ['projects']), 'ambiguous');
});

test('decideBaseline compares table names case-insensitively', () => {
  // pg_tables folds unquoted identifiers to lowercase; a hand-edited baseline could
  // contain an unquoted mixed-case CREATE TABLE.
  assert.strictEqual(decideBaseline(['Projects', 'Tags'], ['projects', 'tags']), 'mark-baseline-applied');
});

// Bar-raising review #3: per-table grant pairing + qualifier-aware names.
function captureWarnings(fn: () => void): string[] {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (msg?: any) => {
    warnings.push(String(msg));
  };
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return warnings;
}

test('warnUngrantedCreateTable warns only for the table left ungranted (per-table, not file-level)', () => {
  const warnings = captureWarnings(() =>
    warnUngrantedCreateTable({
      '001.sql':
        'CREATE TABLE a (id text primary key);\n' +
        'CREATE TABLE b (id text primary key);\n' +
        'GRANT ALL ON a TO authenticated;',
    }),
  );
  assert.strictEqual(warnings.length, 1, 'only the ungranted table warns');
  assert.match(warnings[0], /"b"/);
  assert.ok(!warnings[0].includes('"a"'), 'the granted table must not warn');
});

test('warnUngrantedCreateTable strips the public. qualifier (warns about the table, not "public")', () => {
  const warnings = captureWarnings(() =>
    warnUngrantedCreateTable({ '001.sql': 'CREATE TABLE public.tasks (id text primary key);' }),
  );
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /"tasks"/);
  assert.ok(!warnings[0].includes('"public"'), 'must not report a table named "public"');
});

test('warnUngrantedCreateTable matches a qualifier-aware GRANT to a qualified CREATE TABLE', () => {
  const warnings = captureWarnings(() =>
    warnUngrantedCreateTable({
      '001.sql':
        'CREATE TABLE public.tasks (id text primary key);\nGRANT SELECT ON public.tasks TO authenticated;',
    }),
  );
  assert.strictEqual(warnings.length, 0, 'qualified grant covers the qualified table');
});

test('warnUngrantedCreateTable stays silent for GRANT ON ALL TABLES IN SCHEMA', () => {
  const warnings = captureWarnings(() =>
    warnUngrantedCreateTable({
      '001.sql':
        'CREATE TABLE x (id int);\nCREATE TABLE y (id int);\n' +
        'GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;',
    }),
  );
  assert.strictEqual(warnings.length, 0, 'blanket schema grant covers every table');
});
