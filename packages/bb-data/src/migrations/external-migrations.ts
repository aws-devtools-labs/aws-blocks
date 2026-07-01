// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Apply Blocks migration files to an EXTERNAL connection-string Postgres
 * (Supabase / Neon) host-side, as a pre-`cdk deploy` lifecycle step.
 *
 * Reuses the engine-agnostic `runMigrations` + `PgClientEngine`. Runs on the
 * 5432 session port rather than the 6543 transaction pooler: DDL, multi-
 * statement file transactions, and a session-held advisory lock all require a
 * stable session, which the transaction pooler does not guarantee.
 *
 * Not for Aurora (that path applies migrations from an in-VPC Lambda — see
 * infra.ts) and not for Aurora DSQL, which disallows mixing DDL and DML in one
 * transaction, has no advisory locks, and authenticates with IAM tokens rather
 * than a connection-string password.
 */

import { runMigrations, loadMigrationsFromDir } from '@aws-blocks/data-common';
import { PgClientEngine } from '../engines/pg-client-engine.js';
import { externalDbSsl } from '../external-ssl.js';
import { BASELINE_FILE } from './baseline.js';
import { createHash } from 'node:crypto';
import { DatabaseErrors } from '../errors.js';

/** Advisory-lock namespace (first arg of the two-int form). 0x424B = "BK" (Blocks). */
const ADVISORY_LOCK_NAMESPACE = 0x424b;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const LOCK_RETRY_INTERVAL_MS = 1_000;

export interface RunExternalMigrationsOptions {
  /** Connection string (any port). Rewritten to the 5432 session port for DDL. */
  connectionString: string;
  /** Directory of numbered `.sql` migration files. */
  migrationsDir: string;
  /** Stage label, used for the advisory-lock key and logging (e.g. 'production'). */
  stage?: string;
  /** Max time to wait to acquire the advisory lock before failing. @default 30000 */
  lockTimeoutMs?: number;
  /** Connection timeout — fail fast on an unreachable host. @default 10000 */
  connectionTimeoutMs?: number;
}

export interface ExternalMigrationsResult {
  applied: string[];
  durationMs: number;
}

/**
 * Rewrite a runtime connection string (typically the 6543 Supavisor transaction
 * pooler; see D-009 / #861) to the 5432 session port. Uses `new URL()` + explicit `port`
 * rather than a string `.replace()`, which is a no-op when the URL has no
 * explicit `:5432/` (the fragility flagged in the bug-bash, Item #3).
 */
export function toSessionPortUrl(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    const err = new Error(
      `Invalid database connection string — expected a postgres:// URL. ` +
        `Check .env.local (sandbox) / .env.production (deploy).`,
    );
    err.name = DatabaseErrors.ConnectionFailed;
    throw err;
  }
  url.port = '5432';
  // `prepared_statements=false` is a transaction-pooler hint; session mode
  // supports prepared statements, so drop it to avoid confusion.
  url.searchParams.delete('prepared_statements');
  // Strip `sslmode` so an explicitly-configured `ssl` (e.g. a pinned CA via
  // DATABASE_CA_CERT) takes effect: node `pg` ignores a programmatic `ssl.ca`
  // and verifies against the system trust store when `sslmode` is in the URL.
  url.searchParams.delete('sslmode');
  return url.toString();
}

/** Stable 31-bit positive int lock key derived from a name. */
export function advisoryLockKey(name: string): number {
  return createHash('sha256').update(name).digest().readUInt32BE(0) & 0x7fffffff;
}

/**
 * Strip the parts of a SQL script where a literal `CREATE TABLE` (or `GRANT`)
 * must NOT be treated as a statement: dollar-quoted bodies (`$$…$$` / `$tag$…$tag$`,
 * i.e. function bodies), line/block comments, and single-quoted string literals.
 *
 * A `pg_dump` baseline routinely embeds such text — e.g. Supabase's
 * `rls_auto_enable()` event-trigger function contains the literal
 * `'CREATE TABLE AS'` — and a naive scan would otherwise pick up a phantom table
 * (`AS`) and skew the empty/populated/ambiguous baseline decision. Order matters:
 * remove dollar-quoted bodies first (they may themselves contain quotes/comments).
 */
function stripSqlNoise(sql: string): string {
  return sql
    .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, ' ') // dollar-quoted bodies (function bodies)
    .replace(/--[^\n]*/g, ' ') // line comments
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/'(?:[^']|'')*'/g, ' '); // single-quoted string literals
}

/**
 * Table names a baseline SQL file creates (used to detect an already-populated DB).
 * Scans only real DDL — `stripSqlNoise` removes function bodies, comments, and
 * string literals first, so a `CREATE TABLE` mentioned inside them is not counted.
 */
export function extractCreatedTableNames(sql: string): string[] {
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?([a-zA-Z_]\w*)"?/gi;
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripSqlNoise(sql))) !== null) names.add(m[1]);
  return [...names];
}

export type BaselineDecision = 'run-all' | 'mark-baseline-applied' | 'ambiguous';

/**
 * Decide how to treat the baseline on a database that has no `_migrations` table yet:
 * - none of the baseline's tables present  → empty DB → run the baseline (build schema)
 * - all present                            → existing DB → mark baseline applied, don't run
 * - some present                           → ambiguous → caller errors
 */
export function decideBaseline(baselineTables: string[], existingPublicTables: string[]): BaselineDecision {
  if (baselineTables.length === 0) return 'run-all';
  // Compare case-insensitively: `pg_tables` folds unquoted identifiers to lowercase,
  // while a hand-edited baseline could contain an unquoted mixed-case `CREATE TABLE Foo`.
  const existing = new Set(existingPublicTables.map(t => t.toLowerCase()));
  const present = baselineTables.filter(t => existing.has(t.toLowerCase()));
  if (present.length === 0) return 'run-all';
  if (present.length === baselineTables.length) return 'mark-baseline-applied';
  return 'ambiguous';
}

/**
 * Warn when a migration file creates a table without granting access to the
 * `authenticated` role. Since the May-2026 Supabase change, a new table has no
 * implicit grant, so PostgREST clients hit "permission denied" while Blocks' own
 * `db.crud()` (connects as the table owner) is unaffected and cannot see the
 * breakage. Advisory only — does not block.
 */
export function warnUngrantedCreateTable(migrations: Record<string, string>): void {
  for (const [file, sql] of Object.entries(migrations)) {
    // Scan real DDL only — ignore CREATE TABLE / GRANT inside function bodies,
    // comments, or string literals (same hazard as extractCreatedTableNames).
    const scannable = stripSqlNoise(sql);
    const created = extractCreatedTableNames(sql); // qualifier-aware, noise-stripped
    if (created.length === 0) continue;

    // A blanket `GRANT ... ON ALL TABLES IN SCHEMA ...` covers every table in the file.
    const grantsAllInSchema = /grant\s+[\s\S]*?\bon\s+all\s+tables\s+in\s+schema\b/i.test(scannable);
    // Otherwise pair each created table with whether THAT specific table is granted
    // (qualifier-aware), so granting one table doesn't suppress the warning for a
    // sibling left ungranted in the same file.
    const granted = new Set<string>();
    if (!grantsAllInSchema) {
      const grantOn = /grant\s+[\s\S]*?\bon\s+(?:table\s+)?(?:"?public"?\.)?"?([a-zA-Z_]\w*)"?/gi;
      let g: RegExpExecArray | null;
      while ((g = grantOn.exec(scannable)) !== null) granted.add(g[1].toLowerCase());
    }

    for (const table of created) {
      if (grantsAllInSchema || granted.has(table.toLowerCase())) continue;
      console.warn(
        `[external-migrations] ⚠️  ${file}: CREATE TABLE "${table}" has no GRANT in the same file. ` +
          `PostgREST/supabase-js clients may get "permission denied" until you GRANT to the ` +
          `'authenticated' role (Supabase May-2026 behavior). Blocks' own db.crud() is unaffected.`,
      );
    }
  }
}

async function acquireAdvisoryLock(
  engine: PgClientEngine,
  ns: number,
  key: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await engine.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [ns, key],
    );
    if (rows[0]?.locked) return;
    if (Date.now() >= deadline) {
      const err = new Error(
        `Timed out after ${timeoutMs}ms waiting for the migration advisory lock. ` +
          `Another deploy may be applying migrations to this database, or a previous ` +
          `deploy crashed while holding the lock (the lock releases when its session ends).`,
      );
      err.name = DatabaseErrors.ConnectionFailed;
      throw err;
    }
    await new Promise(r => setTimeout(r, LOCK_RETRY_INTERVAL_MS));
  }
}

/**
 * Handle the baseline on a database's first migration run.
 *
 * If there's a baseline file and `_migrations` doesn't exist yet, inspect the
 * database: if it already contains the baseline's tables (an existing/pulled
 * DB), record the baseline as applied WITHOUT running it; if it's empty, do
 * nothing and let `runMigrations` execute the baseline normally; if it's
 * partially populated, fail clearly rather than guess.
 */
async function maybeMarkBaselineApplied(
  engine: PgClientEngine,
  migrations: Record<string, string>,
): Promise<void> {
  const baselineSql = migrations[BASELINE_FILE];
  if (!baselineSql) return;

  const reg = await engine.query<{ t: string | null }>(`SELECT to_regclass('public._migrations') AS t`);
  if (reg[0]?.t != null) return; // already initialized — normal pending application

  const expected = extractCreatedTableNames(baselineSql);
  const actualRows = await engine.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '\\_%'`,
  );
  const decision = decideBaseline(expected, actualRows.map(r => r.tablename));

  if (decision === 'ambiguous') {
    const err = new Error(
      `Cannot apply the baseline: this database is partially populated — some tables from ` +
        `${BASELINE_FILE} exist and some don't. Apply migrations to an empty database, or to one ` +
        `that already has the full baseline schema.`,
    );
    err.name = DatabaseErrors.QueryFailed;
    throw err;
  }

  if (decision === 'mark-baseline-applied') {
    await engine.execute(
      `CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`,
    );
    await engine.execute(`INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [BASELINE_FILE]);
    console.log(
      `[external-migrations] existing schema detected — ${BASELINE_FILE} marked as applied (not run).`,
    );
  }
  // 'run-all' → leave it; runMigrations will execute the baseline on the empty DB.
}

/**
 * Apply pending migrations from `migrationsDir` to the external DB.
 *
 * - Rewrites the URL to the 5432 session port.
 * - Fails fast on an unreachable host with an actionable error.
 * - Serializes concurrent deploys with a non-blocking session advisory lock
 *   (retried up to `lockTimeoutMs`), keyed by stage + migrations dir so distinct
 *   apps sharing a DB don't serialize against each other.
 * - Idempotent via the `_migrations` table (handled by `runMigrations`).
 * - On partial failure the schema is left at the last applied file (no auto
 *   down-migration). The lock + pool are always released.
 */
export async function runExternalMigrations(
  opts: RunExternalMigrationsOptions,
): Promise<ExternalMigrationsResult> {
  const start = Date.now();

  const migrations = await loadMigrationsFromDir(opts.migrationsDir);
  if (Object.keys(migrations).length === 0) {
    return { applied: [], durationMs: Date.now() - start };
  }

  const engine = new PgClientEngine({
    connectionString: toSessionPortUrl(opts.connectionString),
    ssl: externalDbSsl(),
    // poolSize 1 is load-bearing: a SESSION-level advisory lock lives on one
    // backend connection, so every query must reuse that single connection.
    poolSize: 1,
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
  });

  const ns = ADVISORY_LOCK_NAMESPACE;
  const key = advisoryLockKey(`${opts.stage ?? ''}:${opts.migrationsDir}`);

  try {
    try {
      await acquireAdvisoryLock(engine, ns, key, opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
    } catch (e: any) {
      // A connection failure here almost always means the host is unreachable.
      if (
        e?.name === DatabaseErrors.ConnectionFailed ||
        /timeout|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(e?.message ?? '')
      ) {
        const err = new Error(
          `Cannot reach the database on port 5432 to apply migrations. ` +
            `Common causes: IPv6-only direct host, Supabase Network Restrictions blocking your ` +
            `deploy/CI host IP, or a corporate firewall. Original: ${e?.message ?? e}`,
        );
        err.name = DatabaseErrors.ConnectionFailed;
        throw err;
      }
      throw e;
    }

    try {
      await maybeMarkBaselineApplied(engine, migrations);
      // Advisory only for the files we're about to apply — so an already-applied
      // CREATE TABLE doesn't re-warn on every deploy. `_migrations` may not exist
      // on a first run (query throws → treat everything as pending).
      const appliedRows = await engine
        .query<{ name: string }>('SELECT name FROM _migrations')
        .catch(() => [] as { name: string }[]);
      const appliedNames = new Set(appliedRows.map(r => r.name));
      const pending = Object.fromEntries(
        Object.entries(migrations).filter(([file]) => !appliedNames.has(file)),
      );
      warnUngrantedCreateTable(pending);
      const applied = await runMigrations(engine, migrations);
      const durationMs = Date.now() - start;
      console.log(
        `[external-migrations] stage=${opts.stage ?? 'unknown'} applied=${applied.length} ` +
          `(${durationMs}ms)` +
          (applied.length ? `: ${applied.join(', ')}` : ' — nothing pending'),
      );
      return { applied, durationMs };
    } finally {
      await engine.query('SELECT pg_advisory_unlock($1, $2)', [ns, key]).catch(() => {});
    }
  } finally {
    await engine.destroy();
  }
}
