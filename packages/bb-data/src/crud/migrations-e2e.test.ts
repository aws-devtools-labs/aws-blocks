// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E test: runMigrations() against a real Supabase database.
 *
 * Tests that the migration system:
 *   1. Creates the _migrations tracking table
 *   2. Applies pending migrations in order
 *   3. Skips already-applied migrations on re-run
 *   4. Rolls back on failure (bad SQL)
 *
 * Requires env vars: SUPABASE_DB_URL
 * Skips gracefully if not set.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PgClientEngine } from '../engines/pg-client-engine.js';
import { runMigrations } from '@aws-blocks/data-common';
import { runExternalMigrations, toSessionPortUrl } from '../migrations/external-migrations.js';
import { BASELINE_FILE } from '../migrations/baseline.js';
import { regenerateTypesAndMeta } from '../db-pull.js';

const env = { dbUrl: process.env.SUPABASE_DB_URL };
const skip = !env.dbUrl;

/**
 * SSL for the e2e connections. When `DATABASE_CA_CERT` is set (always in CI — the
 * e2e-supabase workflow pins the committed Supabase Root CA) connections run
 * verify-full, exercising the TLS feature under test; falls back to unverified
 * only for ad-hoc local runs without a CA. The `runExternalMigrations` path
 * resolves SSL via `externalDbSsl()` internally, which reads the same env var.
 */
const E2E_SSL = process.env.DATABASE_CA_CERT
  ? { ca: fs.readFileSync(process.env.DATABASE_CA_CERT, 'utf8'), rejectUnauthorized: true as const }
  : { rejectUnauthorized: false as const };

describe('runMigrations E2E — Supabase', { skip }, () => {
  let engine: PgClientEngine;

  before(async () => {
    engine = new PgClientEngine({
      connectionString: env.dbUrl!,
      ssl: E2E_SSL,
    });
  });

  after(async () => {
    if (engine) {
      // Clean up: drop test table and migration tracking entries
      await engine.execute(`DROP TABLE IF EXISTS _test_migrate_e2e`).catch(() => {});
      await engine.execute(`DELETE FROM _migrations WHERE name LIKE '9999_%'`).catch(() => {});
      await engine.destroy();
    }
  });

  test('applies a migration and tracks it', async () => {
    const migrations = {
      '9999_create_test_table.sql': `
        CREATE TABLE IF NOT EXISTS _test_migrate_e2e (
          id serial PRIMARY KEY,
          value text NOT NULL
        );
      `,
    };

    const applied = await runMigrations(engine, migrations);
    assert.deepStrictEqual(applied, ['9999_create_test_table.sql']);

    // Verify table exists
    const rows = await engine.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = '_test_migrate_e2e' ORDER BY ordinal_position`,
    );
    const cols = rows.map(r => r.column_name);
    assert.deepStrictEqual(cols, ['id', 'value']);
  });

  test('skips already-applied migrations', async () => {
    const migrations = {
      '9999_create_test_table.sql': `CREATE TABLE _test_migrate_e2e (id serial PRIMARY KEY, value text NOT NULL);`,
    };

    const applied = await runMigrations(engine, migrations);
    assert.deepStrictEqual(applied, [], 'Should skip already-applied migration');
  });

  test('applies second migration in order', async () => {
    const migrations = {
      '9999_create_test_table.sql': `CREATE TABLE _test_migrate_e2e (id serial PRIMARY KEY, value text NOT NULL);`,
      '9999_add_column.sql': `ALTER TABLE _test_migrate_e2e ADD COLUMN IF NOT EXISTS extra boolean DEFAULT false;`,
    };

    const applied = await runMigrations(engine, migrations);
    assert.deepStrictEqual(applied, ['9999_add_column.sql']);

    // Verify column exists
    const rows = await engine.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = '_test_migrate_e2e' ORDER BY ordinal_position`,
    );
    assert.ok(rows.map(r => r.column_name).includes('extra'));
  });

  test('rolls back on failure', async () => {
    const migrations = {
      '9999_create_test_table.sql': `ignored`,
      '9999_add_column.sql': `ignored`,
      '9999_bad_migration.sql': `ALTER TABLE _test_migrate_e2e ADD COLUMN oops; THIS IS INVALID SQL;`,
    };

    await assert.rejects(
      () => runMigrations(engine, migrations),
      (e: any) => {
        assert.ok(e.message || e.code, 'Should throw on bad SQL');
        return true;
      },
    );

    // Verify the bad migration was NOT tracked
    const tracked = await engine.query<{ name: string }>(
      `SELECT name FROM _migrations WHERE name = '9999_bad_migration.sql'`,
    );
    assert.strictEqual(tracked.length, 0, 'Failed migration should not be tracked');
  });
});

/**
 * E2E: the full dev-loop flow this PR adds — apply an external migration with
 * runExternalMigrations() (5432 session port + advisory lock), then refresh the
 * generated types with regenerateTypesAndMeta(), against a real Supabase DB.
 *
 * Asserts the customer-visible promise: after a migration, the generated
 * database.types.ts / database.meta.ts reflect the new schema, and hand-edited
 * singulars survive the refresh. Idempotent re-application applies nothing.
 *
 * Uses a non-underscore table name (introspection excludes `_%` tables) with a
 * distinctive prefix, and high migration numbers, cleaned up in after().
 */
describe('external migrate + type refresh E2E — Supabase', { skip }, () => {
  let engine: PgClientEngine;
  let migrationsDir: string;
  let outDir: string;

  const TABLE = 'regen_e2e_widgets';
  const CREATE_FILE = '9990_create_regen_e2e_widgets.sql';
  const ALTER_FILE = '9991_add_regen_e2e_priority.sql';

  before(async () => {
    engine = new PgClientEngine({ connectionString: env.dbUrl!, ssl: E2E_SSL });
    migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-e2e-migrations-'));
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-e2e-out-'));
    // Clean slate so the CREATE migration is genuinely pending.
    await engine.execute(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {});
    await engine.execute(`DELETE FROM _migrations WHERE name IN ($1, $2)`, [CREATE_FILE, ALTER_FILE]).catch(() => {});
    fs.writeFileSync(
      path.join(migrationsDir, CREATE_FILE),
      `CREATE TABLE ${TABLE} (id serial PRIMARY KEY, name text NOT NULL);`,
    );
  });

  after(async () => {
    if (engine) {
      await engine.execute(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {});
      await engine.execute(`DELETE FROM _migrations WHERE name IN ($1, $2)`, [CREATE_FILE, ALTER_FILE]).catch(() => {});
      await engine.destroy();
    }
    if (migrationsDir) fs.rmSync(migrationsDir, { recursive: true, force: true });
    if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
  });

  test('runExternalMigrations applies the CREATE on the session port + advisory lock', async () => {
    const { applied } = await runExternalMigrations({ connectionString: env.dbUrl!, migrationsDir, stage: 'sandbox' });
    assert.ok(applied.includes(CREATE_FILE), `expected ${CREATE_FILE} in applied: ${applied.join(', ')}`);
  });

  test('regenerateTypesAndMeta reflects the new table in types + meta', async () => {
    const res = await regenerateTypesAndMeta({ connectionString: env.dbUrl!, outputDir: outDir });
    assert.ok(res.tablesGenerated >= 1);
    const types = fs.readFileSync(path.join(outDir, 'database.types.ts'), 'utf-8');
    const meta = fs.readFileSync(path.join(outDir, 'database.meta.ts'), 'utf-8');
    assert.ok(types.includes('RegenE2eWidgets'), 'types include the PascalCase interface');
    assert.ok(/\bname\b/.test(types), 'types include the name column');
    assert.ok(meta.includes(`${TABLE}:`), 'meta includes the table entry');
    // The refresh writes ONLY the two type files — no scaffolding.
    assert.deepStrictEqual(fs.readdirSync(outDir).sort(), ['database.meta.ts', 'database.types.ts']);
  });

  test('a delta migration + refresh surfaces the new column', async () => {
    fs.writeFileSync(
      path.join(migrationsDir, ALTER_FILE),
      `ALTER TABLE ${TABLE} ADD COLUMN priority int;`,
    );
    const { applied } = await runExternalMigrations({ connectionString: env.dbUrl!, migrationsDir, stage: 'sandbox' });
    assert.deepStrictEqual(applied, [ALTER_FILE], 'only the new delta applies');

    await regenerateTypesAndMeta({ connectionString: env.dbUrl!, outputDir: outDir });
    const types = fs.readFileSync(path.join(outDir, 'database.types.ts'), 'utf-8');
    assert.ok(/priority/.test(types), 'refreshed types include the new priority column');
  });

  test('re-applying is idempotent (nothing pending)', async () => {
    const { applied } = await runExternalMigrations({ connectionString: env.dbUrl!, migrationsDir, stage: 'sandbox' });
    assert.deepStrictEqual(applied, [], 'no migrations re-applied');
  });

  test('refresh preserves a hand-edited singular', async () => {
    const metaPath = path.join(outDir, 'database.meta.ts');
    // Hand-edit the generated singular, then refresh and confirm it survives.
    // Replace the quoted singular only, so the plural ('regenE2eWidgets') is untouched.
    const edited = fs.readFileSync(metaPath, 'utf-8').replace(/'regenE2eWidget'/g, "'regenE2eGizmo'");
    fs.writeFileSync(metaPath, edited);

    await regenerateTypesAndMeta({ connectionString: env.dbUrl!, outputDir: outDir });
    const meta = fs.readFileSync(metaPath, 'utf-8');
    assert.ok(meta.includes("singular: 'regenE2eGizmo'"), 'hand-edited singular preserved across refresh');
    assert.ok(!/singular: 'regenE2eWidget'/.test(meta), 'derived singular not reintroduced');
  });
});

/**
 * E2E: the empty-DB "run-all" baseline path — the riskiest, previously-untested
 * flow (bar-raising review gap). A real `pg_dump --schema-only` baseline is applied
 * to an EMPTY target via runExternalMigrations(), exercising:
 *   - decideBaseline → 'run-all' on an empty target (no baseline tables present), and
 *   - the baseline running through splitStatements + runMigrations: SET noise, the
 *     session-level `set_config('search_path', '', false)`, a dollar-quoted function
 *     body (with a `CREATE TABLE` literal), RLS enable + policy, and GRANTs.
 *
 * Isolation: everything lives in a throwaway SCRATCH SCHEMA (`bb_runall_e2e`), never
 * `public` — so it cannot touch the shared `todos` fixture or the crud/auth E2E suites
 * that run in parallel against the same database. (This is why we scope `pg_dump` to the
 * scratch schema rather than calling `generateBaseline`, which dumps all of `public`.)
 *
 * Requires `SUPABASE_DB_URL` AND a `pg_dump` whose major >= the server's; skips
 * gracefully otherwise (the CI runner's default `pg_dump` may be too old).
 */
let hasPgDump = false;
try {
  execFileSync('pg_dump', ['--version'], { stdio: 'pipe' });
  hasPgDump = true;
} catch {
  hasPgDump = false;
}

describe('external migrate run-all baseline (empty target) E2E — Supabase', { skip: skip || !hasPgDump }, () => {
  let engine: PgClientEngine;
  let migrationsDir: string;
  const SCHEMA = 'bb_runall_e2e';
  const sessionUrl = () => toSessionPortUrl(env.dbUrl!);

  // Source schema (what a customer's existing DB looks like). Created in setup,
  // dumped via pg_dump, then dropped so the target is genuinely empty.
  const SETUP_SQL = `
    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.gadgets (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      owner_id text NOT NULL,
      name text NOT NULL
    );
    CREATE FUNCTION ${SCHEMA}.note() RETURNS text LANGUAGE sql AS $$
      SELECT 'CREATE TABLE phantom (x int); not a real statement'::text
    $$;
    ALTER TABLE ${SCHEMA}.gadgets ENABLE ROW LEVEL SECURITY;
    CREATE POLICY gadgets_owner ON ${SCHEMA}.gadgets
      USING ((owner_id = ((current_setting('request.jwt.claims', true))::jsonb ->> 'sub')));
    GRANT SELECT, INSERT ON ${SCHEMA}.gadgets TO authenticated;
  `;

  const dropSchema = async () =>
    engine.execute(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});

  before(async () => {
    engine = new PgClientEngine({ connectionString: sessionUrl(), ssl: E2E_SSL, poolSize: 1 });
    migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runall-e2e-'));
    await dropSchema();
    await engine.execute(`DELETE FROM _migrations WHERE name = $1`, [BASELINE_FILE]).catch(() => {});
    await engine.execute(SETUP_SQL);
  });

  after(async () => {
    if (engine) {
      await dropSchema();
      await engine.execute(`DELETE FROM _migrations WHERE name = $1`, [BASELINE_FILE]).catch(() => {});
      await engine.destroy();
    }
    if (migrationsDir) fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  test('a real pg_dump baseline rebuilds the schema on an empty target (run-all)', async t => {
    // Generate a REAL baseline from the source schema. pg_dump (not generateBaseline,
    // which is public-only) is scoped to the scratch schema. Credentials go via PG*
    // env vars, never argv. Skip — don't fail — if pg_dump is missing/too old.
    const u = new URL(sessionUrl());
    let baselineSql: string;
    try {
      baselineSql = execFileSync('pg_dump', ['--schema-only', `--schema=${SCHEMA}`, '--no-owner'], {
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          PGHOST: u.hostname,
          PGPORT: u.port || '5432',
          PGUSER: decodeURIComponent(u.username),
          PGPASSWORD: decodeURIComponent(u.password),
          PGDATABASE: u.pathname.replace(/^\//, '') || 'postgres',
          PGSSLMODE: 'require',
        },
      });
    } catch (e: any) {
      return t.skip(`pg_dump unavailable or incompatible with the server: ${(e?.stderr || e?.message || e).toString().trim()}`);
    }

    // Sanity: this is genuine pg_dump output with the risky constructs we care about.
    assert.match(baselineSql, /set_config\('search_path', '', false\)/, 'baseline resets search_path (the run-all hazard)');
    assert.match(baselineSql, new RegExp(`CREATE SCHEMA ${SCHEMA}`), 'baseline recreates the schema');
    assert.match(baselineSql, /CREATE POLICY/, 'baseline includes the RLS policy');
    assert.match(baselineSql, /GRANT/, 'baseline includes grants');

    fs.writeFileSync(path.join(migrationsDir, BASELINE_FILE), baselineSql);

    // Empty the target: drop the source schema so the baseline genuinely rebuilds it.
    await dropSchema();
    await engine.execute(`DELETE FROM _migrations WHERE name = $1`, [BASELINE_FILE]).catch(() => {});

    const { applied } = await runExternalMigrations({ connectionString: env.dbUrl!, migrationsDir, stage: 'sandbox' });
    assert.ok(applied.includes(BASELINE_FILE), `baseline applied: ${applied.join(', ')}`);

    // The schema was rebuilt end-to-end: table, RLS policy, and grant all present.
    const tbl = await engine.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM pg_tables WHERE schemaname=$1 AND tablename='gadgets'`, [SCHEMA],
    );
    assert.strictEqual(tbl[0].c, 1, 'table rebuilt');
    const pol = await engine.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM pg_policies WHERE schemaname=$1 AND tablename='gadgets'`, [SCHEMA],
    );
    assert.strictEqual(pol[0].c, 1, 'RLS policy rebuilt');
    const grant = await engine.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM information_schema.role_table_grants
       WHERE table_schema=$1 AND table_name='gadgets' AND grantee='authenticated'`, [SCHEMA],
    );
    assert.ok(grant[0].c >= 1, 'grant to authenticated rebuilt');

    // Tracked, and idempotent on re-run.
    const tracked = await engine.query<{ name: string }>(`SELECT name FROM _migrations WHERE name = $1`, [BASELINE_FILE]);
    assert.strictEqual(tracked.length, 1, 'baseline recorded in _migrations');
    const { applied: again } = await runExternalMigrations({ connectionString: env.dbUrl!, migrationsDir, stage: 'sandbox' });
    assert.deepStrictEqual(again, [], 'nothing re-applies');
  });
});
