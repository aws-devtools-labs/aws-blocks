// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generate a schema "baseline" — a runnable `000_baseline.sql` that recreates
 * the current schema in a fresh, empty database — using `pg_dump`.
 *
 * `db pull` describes the schema (TypeScript types + CRUD metadata) but does
 * not produce runnable SQL. Without a baseline, a customer who pulled an
 * existing database cannot stand up a new/empty environment from their
 * migration files alone (the first delta migration alters a table that was
 * never created in a file). The baseline closes that gap.
 *
 * `pg_dump` is the canonical tool — it reproduces tables, constraints, indexes,
 * sequences, RLS policies, and grants faithfully. It is needed only here, at
 * pull time, to generate the file; applying it later uses the normal `pg`
 * client and needs no `pg_dump`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgClientEngine } from '../engines/pg-client-engine.js';
import { externalDbSsl } from '../external-ssl.js';

/** The baseline migration filename. Lexicographically first so it applies before deltas. */
export const BASELINE_FILE = '000_baseline.sql';

/** Parse the major version from `pg_dump --version` output, e.g. "pg_dump (PostgreSQL) 16.1" → 16. */
export function pgDumpMajorFromVersionString(s: string): number | null {
  const m = s.match(/(\d+)(?:\.\d+){0,2}\s*$/m);
  return m ? parseInt(m[1], 10) : null;
}

/** Derive the server major version from `server_version_num` (e.g. 150004 → 15). */
export function serverMajorFromVersionNum(num: string | number): number {
  return Math.floor(Number(num) / 10000);
}

const INSTALL_HINT =
  'Install the PostgreSQL client tools:\n' +
  '  macOS:          brew install libpq   (then add its bin to PATH)\n' +
  '  Debian/Ubuntu:  sudo apt-get install postgresql-client\n' +
  '  Amazon Linux:   sudo yum install postgresql<MAJOR>\n' +
  '  Windows:        install via the EDB installer or `scoop install postgresql`';

/** Resolve the local `pg_dump` major version, or throw an actionable error if missing. */
function getPgDumpMajor(): number {
  let out: string;
  try {
    out = execFileSync('pg_dump', ['--version'], { encoding: 'utf-8' });
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      throw new Error(
        `pg_dump was not found on PATH — it's required to generate the schema baseline.\n${INSTALL_HINT}`,
      );
    }
    throw e;
  }
  const major = pgDumpMajorFromVersionString(out);
  if (major === null) throw new Error(`Could not parse pg_dump version from "${out.trim()}".`);
  return major;
}

export interface GenerateBaselineOptions {
  /** Connection string for the source database (session port, e.g. 5432). */
  connectionString: string;
  /** Directory to write the baseline into (the project's ./migrations). */
  migrationsDir: string;
}

export interface GenerateBaselineResult {
  written: boolean;
  path: string;
  /** Set when generation was skipped/failed but pull should continue. */
  warning?: string;
}

/**
 * Generate `<migrationsDir>/000_baseline.sql` from the source database.
 *
 * Treated as immutable history: if the file already exists it is left
 * unchanged. Never throws for an environmental reason (missing/old `pg_dump`,
 * dump failure) — returns a `warning` so `db pull` can finish (types/CRUD still
 * work for existing environments) and tell the customer how to produce the
 * baseline later.
 */
export async function generateBaseline(opts: GenerateBaselineOptions): Promise<GenerateBaselineResult> {
  const outPath = join(opts.migrationsDir, BASELINE_FILE);
  if (existsSync(outPath)) {
    return { written: false, path: outPath };
  }

  let pgDumpMajor: number;
  try {
    pgDumpMajor = getPgDumpMajor();
  } catch (e: any) {
    return { written: false, path: outPath, warning: e.message };
  }

  // Version-check pg_dump against the server (pg_dump must be >= server major).
  const engine = new PgClientEngine({
    connectionString: opts.connectionString,
    ssl: externalDbSsl(),
    poolSize: 1,
  });
  let serverMajor: number;
  try {
    const rows = await engine.query<{ server_version_num: string }>('SHOW server_version_num');
    serverMajor = serverMajorFromVersionNum(rows[0]?.server_version_num ?? 0);
  } finally {
    await engine.destroy();
  }
  if (serverMajor > 0 && pgDumpMajor < serverMajor) {
    return {
      written: false,
      path: outPath,
      warning:
        `Your pg_dump is version ${pgDumpMajor} but the database is PostgreSQL ${serverMajor}. ` +
        `pg_dump must be >= the server's major version.\n${INSTALL_HINT}`,
    };
  }

  // Pass credentials via PG* env vars rather than in argv (avoids exposing the
  // password in the process list). Arg-array exec (no shell) — no injection.
  const u = new URL(opts.connectionString);
  const env = {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.replace(/^\//, '') || 'postgres',
    PGSSLMODE: 'require',
  };

  let dump: string;
  try {
    dump = execFileSync(
      'pg_dump',
      // Keep privileges (GRANTs) — they are load-bearing for the `authenticated`
      // role that withRLS() switches to. Exclude the migration-tracking table.
      ['--schema-only', '--schema=public', '--no-owner', '--exclude-table=public._migrations'],
      { encoding: 'utf-8', env, maxBuffer: 128 * 1024 * 1024 },
    );
  } catch (e: any) {
    return {
      written: false,
      path: outPath,
      warning: `pg_dump failed while generating the baseline: ${(e?.stderr || e?.message || e).toString().trim()}`,
    };
  }

  mkdirSync(opts.migrationsDir, { recursive: true });

  // Post-process the pg_dump output to make it replay-safe on a fresh Supabase
  // project. Raw pg_dump includes platform internals that a non-superuser
  // connection cannot replay (see supabase.com/docs/guides/self-hosting/restore-from-platform).
  dump = sanitizeBaselineForReplay(dump);

  const header =
    `-- Schema baseline generated by \`bb-data pull\` via pg_dump.\n` +
    `-- Recreates the existing schema in a fresh/empty database so new\n` +
    `-- environments can be built from the migration files alone.\n` +
    `-- Generated once; treat as immutable history (do not hand-edit).\n\n`;
  writeFileSync(outPath, header + dump);
  return { written: true, path: outPath };
}

/**
 * Strip platform-specific statements from pg_dump output so the baseline can
 * be replayed onto a fresh Supabase project without superuser privileges.
 *
 * Addresses:
 * - `CREATE SCHEMA public;` → already exists on every Supabase project (42P06)
 * - `COMMENT ON SCHEMA public` → fails if user doesn't own the schema
 * - `ALTER DEFAULT PRIVILEGES FOR ROLE <platform_role> ...;` → permission denied (42501)
 *   (these can span multiple lines until the terminating `;`)
 * - `CREATE FUNCTION` → `CREATE OR REPLACE FUNCTION` for idempotency
 */
export function sanitizeBaselineForReplay(dump: string): string {
  const lines = dump.split('\n');
  const out: string[] = [];
  let inAlterDefaultPrivileges = false;

  for (const line of lines) {
    const trimmed = line.trimStart().toLowerCase();

    // Skip CREATE SCHEMA public (exact — not public_something)
    if (/^create schema public\s*;/.test(trimmed)) continue;

    // Skip COMMENT ON SCHEMA public
    if (/^comment on schema public\b/.test(trimmed)) continue;

    // ALTER DEFAULT PRIVILEGES can span multiple lines until `;`
    if (trimmed.startsWith('alter default privileges')) {
      inAlterDefaultPrivileges = true;
    }
    if (inAlterDefaultPrivileges) {
      if (trimmed.includes(';')) inAlterDefaultPrivileges = false;
      continue;
    }

    out.push(line);
  }

  return out.join('\n').replace(/CREATE FUNCTION/gi, 'CREATE OR REPLACE FUNCTION');
}
