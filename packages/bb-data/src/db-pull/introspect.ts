// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema introspection for `db pull`. Queries `information_schema` / `pg_catalog`
 * to build the `IntrospectionResult` the generators consume. The mechanics
 * (which catalogs, how to group columns) are generic Postgres; the *auth model*
 * (which policy functions mean "Supabase-managed auth", which role needs grants,
 * which claims are standard) is sourced from `./supabase.ts`.
 *
 * @module
 */
import pg from 'pg';
import type { ColumnInfo, IntrospectionResult, TableInfo } from './types.js';
import { SUPABASE_AUTH } from './supabase.js';
import { externalDbSsl } from '../external-ssl.js';

/**
 * Decide whether a column's DEFAULT clause indicates the value is server-managed
 * (Postgres auto-generates it or fills it from the session context), so the
 * customer should not supply it in create input.
 *
 * Server-managed defaults:
 * - Auto-generation: gen_random_uuid(), uuid_generate_v4(), now()/CURRENT_TIMESTAMP,
 *   sequences (nextval), identity columns.
 * - RLS-owner columns: auth.jwt()->>'sub', auth.uid(), current_setting('request.jwt.claims'...)
 *   — Postgres fills these from the session JWT at INSERT time.
 *
 * NOT server-managed: boolean/text/numeric literal defaults, expression defaults
 * other than the ones above. Customer should be able to insert a different value
 * AND update the column later.
 */
export function isServerManagedDefault(columnDefault: string | null): boolean {
  if (columnDefault === null) return false;
  const d = columnDefault.toLowerCase();
  return (
    d.includes('gen_random_uuid') ||
    d.includes('uuid_generate_v') ||
    d.includes('now()') ||
    d.includes('current_timestamp') ||
    d.includes('current_date') ||
    d.includes('current_time') ||
    d.startsWith('nextval(') ||
    d === 'identity' ||
    // RLS-owner columns: Postgres fills these from the session JWT at INSERT time.
    // Excluding them from create input avoids breaking WITH CHECK policies that
    // assert the inserted value matches the authenticated user's sub.
    d.includes('auth.jwt()') ||
    d.includes('auth.uid()') ||
    d.includes("current_setting('request.jwt.claims")
  );
}

export async function introspect(connectionString: string): Promise<IntrospectionResult> {
  // Validate the URL is parseable before handing to pg.
  try {
    new URL(connectionString);
  } catch {
    throw new Error(
      `Could not parse connection string.\n` +
      `  Special characters must be URL-encoded:\n` +
      `    #  →  %23\n` +
      `    ?  →  %3F\n` +
      `    @  →  %40\n` +
      `  Example: postgresql://postgres.ref:pass%23word@host:5432/postgres`
    );
  }

  // Strip sslmode from the connection string so our explicit ssl config takes
  // effect: node `pg` treats `sslmode=require` (and stricter) as verify-full
  // against the system trust store and ignores a programmatic `ssl.ca`. Supabase's pooler/direct
  // endpoints present a cert signed by Supabase's private CA ("prod-ca-2021"),
  // which is not in the system store — so verification needs that CA pinned
  // (via DATABASE_CA_CERT); externalDbSsl() handles that, falling back to an
  // unverified connection for this ephemeral, operator-driven introspection.
  const connStr = connectionString.replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '');
  const pool = new pg.Pool({ connectionString: connStr, ssl: externalDbSsl() });

  try {
    // Get columns
    const { rows: columns } = await pool.query<ColumnInfo>(`
      SELECT table_name, column_name, data_type, is_nullable, column_default, ordinal_position
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name NOT LIKE '\\_%'
      ORDER BY table_name, ordinal_position
    `);

    // Get primary keys
    const { rows: pks } = await pool.query<{ table_name: string; column_name: string }>(`
      SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = 'public'
      ORDER BY tc.table_name, kcu.ordinal_position
    `);
    const pkMap = new Map<string, string[]>();
    for (const r of pks) {
      if (!pkMap.has(r.table_name)) pkMap.set(r.table_name, []);
      pkMap.get(r.table_name)!.push(r.column_name);
    }

    // Get RLS status
    const { rows: rlsRows } = await pool.query<{ tablename: string; rowsecurity: boolean }>(`
      SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public'
    `);
    const rlsMap = new Map(rlsRows.map(r => [r.tablename, r.rowsecurity]));

    // Check which tables have RLS policies referencing Supabase auth functions.
    // auth.uid(), auth.email(), auth.role() depend on Supabase's internal user store
    // and won't work post-migration. auth.jwt() is OIDC-compatible — it just reads
    // the JWT payload, which withRLS() sets via current_setting('request.jwt.claims').
    const { rows: policyRows } = await pool.query<{ tablename: string; qual: string | null; with_check: string | null }>(`
      SELECT tablename, qual, with_check FROM pg_policies WHERE schemaname = 'public'
    `);
    const tablesUsingSupabaseAuth = new Set<string>();
    for (const row of policyRows) {
      const policyText = (row.qual ?? '') + ' ' + (row.with_check ?? '');
      if (SUPABASE_AUTH.authFnPattern.test(policyText)) {
        tablesUsingSupabaseAuth.add(row.tablename);
      }
    }

    // Detect non-standard claims (anything beyond sub/role) referenced in RLS policies
    const nonStandardClaims = new Map<string, string[]>();
    const standardClaims = new Set<string>(SUPABASE_AUTH.standardClaims);
    for (const row of policyRows) {
      const policyText = (row.qual ?? '') + ' ' + (row.with_check ?? '');
      const claims = new Set<string>();
      for (const match of policyText.matchAll(/->>'([^']+)'/g)) {
        if (!standardClaims.has(match[1])) claims.add(match[1]);
      }
      if (claims.size > 0) {
        const existing = nonStandardClaims.get(row.tablename) ?? [];
        nonStandardClaims.set(row.tablename, [...new Set([...existing, ...claims])]);
      }
    }

    // Check which tables have the required grants for the `authenticated` role.
    // Tables created via SQL editor (not Dashboard) may be missing these.
    // The role is passed as a bound parameter (not interpolated) so this stays
    // injection-safe even once the role name comes from a provider object.
    const { rows: grantRows } = await pool.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND grantee = $1`,
      [SUPABASE_AUTH.authenticatedRole],
    );
    const grantsByTable = new Map<string, Set<string>>();
    for (const row of grantRows) {
      if (!grantsByTable.has(row.table_name)) grantsByTable.set(row.table_name, new Set());
      grantsByTable.get(row.table_name)!.add(row.privilege_type);
    }
    const requiredGrants = SUPABASE_AUTH.requiredGrants;

    // Group by table
    const tableMap = new Map<string, ColumnInfo[]>();
    for (const col of columns) {
      if (!tableMap.has(col.table_name)) tableMap.set(col.table_name, []);
      tableMap.get(col.table_name)!.push(col);
    }

    const tables: TableInfo[] = [];
    for (const [name, cols] of tableMap) {
      // Server-managed columns: Postgres mints the value (UUIDs, sequences,
      // timestamps) OR fills it from the session context (auth.jwt(), auth.uid(),
      // request.jwt.claims). Not columns with a value-typed DEFAULT (boolean,
      // text, integer constants) — customers need to be able to update those.
      const autoGenerated = cols
        .filter(c => isServerManagedDefault(c.column_default))
        .map(c => c.column_name);

      tables.push({
        name,
        columns: cols,
        primaryKey: pkMap.has(name)
          ? (pkMap.get(name)!.length === 1 ? pkMap.get(name)![0] : pkMap.get(name)!)
          : [],
        autoGenerated,
        hasRls: rlsMap.get(name) ?? false,
        missingGrants: !requiredGrants.every(g => grantsByTable.get(name)?.has(g)),
      });
    }

    return { tables, tablesUsingSupabaseAuth, nonStandardClaims };
  } finally {
    await pool.end();
  }
}
