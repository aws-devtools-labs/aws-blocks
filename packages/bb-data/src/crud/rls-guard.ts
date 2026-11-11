// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Row-level security guard for `db.crud()`.
 *
 * Generated CRUD scopes rows to the calling user only through Postgres
 * row-level security (RLS): every handler runs inside `withRLS()` as the
 * `authenticated` role, and Postgres filters nothing on a table without RLS.
 * On such a table every signed-in user can read and write every row.
 *
 * Before a handler touches a table, this guard decides whether RLS is
 * required and, if so, verifies it on the live table:
 *
 * - The table is listed in `dangerouslyAllowWithoutRowLevelSecurity` → no check.
 * - The table's meta says `rowLevelSecurity: false` → refused.
 * - `rlsPolicy: 'enforce'` is set, or the meta says `rowLevelSecurity: true` →
 *   the live table must have RLS in effect for the `authenticated` role, or
 *   the call is refused.
 * - Otherwise (meta without the field, no `rlsPolicy`) → the live table is
 *   checked and a warning is logged when RLS is not in effect, but the call
 *   still runs (unchanged behavior for existing metadata).
 *
 * The live check reads `pg_class` and caches only an `enforced` answer, once
 * per table per database connection. A refused table is read again on the
 * next call, so enabling RLS takes effect right away; a table that was
 * enforced keeps being served on a warm connection until it is recycled, even
 * if RLS is disabled on it in the meantime. On the compatibility path the
 * other answers are cached too, since they only drive a once-per-table
 * warning.
 *
 * @module
 */
import { blocksError } from '@aws-blocks/core';
import type { RLSEnabledDatabase } from '../database.js';
import { DatabaseErrors } from '../errors.js';
import type { TableMetaEntry } from './types.js';

/** Database-level settings the guard reads (from `DatabaseOptions`). */
export interface CrudRlsConfig {
  rlsPolicy?: 'enforce';
}

/**
 * How RLS applies to a table for the `authenticated` role that CRUD runs as:
 * - `enforced`: RLS is on and nothing exempts the role.
 * - `disabled`: RLS is off for the table.
 * - `exempt`: RLS is on, but the role skips it (it owns the table, directly
 *   or through role membership, without `FORCE ROW LEVEL SECURITY`, or it is
 *   a superuser / has `BYPASSRLS`).
 * - `missing`: the table could not be found.
 */
type RlsState = 'enforced' | 'disabled' | 'exempt' | 'missing';

/** The role `withRLS()` defaults to, and the one CRUD always runs as. */
const CRUD_ROLE = 'authenticated';

const RLS_STATE_SQL =
  'SELECT c.relrowsecurity AS "rls", c.relforcerowsecurity AS "forced", ' +
  // Postgres exempts the owner and every role that inherits the owner's
  // privileges; `pg_has_role(..., 'USAGE')` follows INHERIT the same way. The
  // `r.oid` guard keeps it from erroring when the role doesn't exist.
  '(r.oid IS NOT NULL AND pg_has_role(r.oid, c.relowner, \'USAGE\')) AS "owned", ' +
  'COALESCE(r.rolsuper OR r.rolbypassrls, false) AS "bypass" ' +
  'FROM pg_class c ' +
  `LEFT JOIN pg_roles r ON r.rolname = '${CRUD_ROLE}' ` +
  'WHERE c.oid = to_regclass($1)';

interface RlsRow {
  rls: boolean;
  forced: boolean;
  owned: boolean;
  bypass: boolean;
}

/** Per-connection cache: database → table → state. Weak so a dropped connection frees it. */
const stateCache = new WeakMap<RLSEnabledDatabase, Map<string, Promise<RlsState>>>();

/** Tables already warned about, per connection, so the warning is logged once. */
const warned = new WeakMap<RLSEnabledDatabase, Set<string>>();

function quoteId(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

async function queryRlsState(db: RLSEnabledDatabase, table: string): Promise<RlsState> {
  const rows = await db.queryRaw<RlsRow>(RLS_STATE_SQL, [quoteId(table)]);
  const row = rows[0];
  if (!row) return 'missing';
  if (row.rls !== true) return 'disabled';
  if (row.bypass === true || (row.owned === true && row.forced !== true)) return 'exempt';
  return 'enforced';
}

/**
 * Read the table's RLS state, caching it per connection. `enforced` is always
 * cached; the other states only when `cacheUnscoped` is set (the compatibility
 * path). A missing table or a failed read is never cached.
 */
function rlsState(db: RLSEnabledDatabase, table: string, cacheUnscoped: boolean): Promise<RlsState> {
  let tables = stateCache.get(db);
  if (!tables) {
    tables = new Map();
    stateCache.set(db, tables);
  }
  const cached = tables.get(table);
  if (cached) return cached;
  const pending = queryRlsState(db, table);
  tables.set(table, pending);
  pending.then(
    state => {
      if (state === 'missing' || (state !== 'enforced' && !cacheUnscoped)) tables.delete(table);
    },
    () => tables.delete(table),
  );
  return pending;
}

function describe(state: RlsState): string {
  switch (state) {
    case 'disabled':
      return 'row-level security is not enabled on it';
    case 'exempt':
      return `row-level security is enabled but the '${CRUD_ROLE}' role is exempt from it (it owns the table, directly or through role membership, without FORCE ROW LEVEL SECURITY, or has BYPASSRLS)`;
    case 'missing':
      return 'the table could not be found, so its row-level security could not be verified';
    default:
      return 'row-level security is in effect';
  }
}

function fixHint(table: string): string {
  return (
    `Enable it in a migration: ALTER TABLE ${quoteId(table)} ENABLE ROW LEVEL SECURITY; and add policies. ` +
    `To serve the table to every signed-in user on purpose, list it in ` +
    `crud({ dangerouslyAllowWithoutRowLevelSecurity: ['${table}'] }).`
  );
}

function refuse(table: string, reason: string): never {
  console.error(`[Database] crud() refused table "${table}": ${reason}. ${fixHint(table)}`);
  throw blocksError(
    DatabaseErrors.RowLevelSecurityRequired,
    'CRUD is refused for this table because row-level security is not in effect',
  );
}

/**
 * Throw `DatabaseErrors.RowLevelSecurityRequired` unless CRUD on `table` will
 * be scoped by row-level security (see the module doc for the rules). Called
 * by every CRUD handler after auth and before its first query.
 */
export async function assertCrudRowLevelSecurity(
  db: RLSEnabledDatabase,
  table: string,
  meta: TableMetaEntry,
  config: CrudRlsConfig,
  acknowledged: ReadonlySet<string>,
): Promise<void> {
  if (acknowledged.has(table)) return;
  if (meta.rowLevelSecurity === false) {
    refuse(table, 'its schema metadata records rowLevelSecurity: false');
  }

  const required = config.rlsPolicy === 'enforce' || meta.rowLevelSecurity === true;
  if (required) {
    const state = await rlsState(db, table, false);
    if (state !== 'enforced') refuse(table, describe(state));
    return;
  }

  // Compatibility path: metadata written before `rowLevelSecurity` existed and
  // no `rlsPolicy`. Keep serving, but say loudly when the table is unscoped.
  let state: RlsState;
  try {
    state = await rlsState(db, table, true);
  } catch {
    return;
  }
  // A missing table isn't warned about here: the guard defers to the query
  // itself, which fails with the database's "relation does not exist" error.
  // (Under enforce the same state is refused, because RLS can't be verified.)
  if (state === 'enforced' || state === 'missing') return;
  let seen = warned.get(db);
  if (!seen) {
    seen = new Set();
    warned.set(db, seen);
  }
  if (seen.has(table)) return;
  seen.add(table);
  console.warn(
    `[Database] crud() is serving table "${table}" without row-level security scoping: ${describe(state)}, ` +
      `so every signed-in user can read and write every row. ${fixHint(table)} ` +
      `Set rlsPolicy: 'enforce' on the Database, or rowLevelSecurity: true in the table's metadata, to refuse such tables.`,
  );
}
