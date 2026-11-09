// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `db.crud()` — runtime CRUD generation for the Database BB.
 *
 * Generates typed list/get/create/update/delete handlers for each table,
 * with filtering, sorting, pagination, and column selection.
 * All queries run through `withRLS()` using the provided auth callback.
 *
 * @module
 */
import type { RLSEnabledDatabase } from '../database.js';
import type { TableSchema, CrudOptions, CrudAuthResult, QueryOpts, TableTypeMeta } from './types.js';
import { buildSelect, buildInsert, buildUpdate, buildDelete } from './sql-builder.js';

/**
 * Create CRUD handlers for the given tables.
 *
 * @param db - The DatabaseBase instance (provides withRLS + raw query)
 * @param schema - Runtime table metadata (from database.meta.ts)
 * @param options - Tables to generate, auth callback, optional exclusions
 * @returns Object with list/get/create/update/delete methods for each table
 */
export function createCrudHandlers<M extends Record<string, TableTypeMeta>>(
  db: RLSEnabledDatabase,
  schema: TableSchema,
  options: CrudOptions<M>,
  /**
   * Awaited at the start of every handler, before the first query. The Database
   * passes `() => this.ensureMigrations()` so CRUD — which otherwise hits
   * `db` directly, bypassing the query methods' own migration gate — waits for
   * (and can re-trigger, after a transient PGlite init trap) migrations. Without
   * it, a CRUD call after a recovered trap would hit tables that were never
   * created and return a misleading "relation does not exist".
   */
  ensureReady?: () => Promise<void>,
): Record<string, Function> {
  const handlers: Record<string, Function> = {};
  const excludeSet = new Set(options.exclude ?? []);

  for (const table of options.tables) {
    const meta = schema[table];
    if (!meta) throw new Error(`Table "${table}" not found in schema`);

    const singular = capitalize(meta.singular);
    const plural = capitalize(meta.plural);
    const pkCols = Array.isArray(meta.primaryKey) ? meta.primaryKey : [meta.primaryKey];

    function resolvePkValues(id: string | Record<string, unknown>): unknown[] {
      if (id != null && typeof id === 'object' && !Array.isArray(id)) {
        return pkCols.map(c => {
          if (!(c in id)) throw new Error(`Missing primary key column "${c}" in id object`);
          return id[c];
        });
      }
      if (pkCols.length > 1) {
        throw new Error(`Composite primary key requires an object with keys: ${pkCols.join(', ')}`);
      }
      return [id];
    }

    // list
    const listName = `list${plural}`;
    if (!excludeSet.has(listName)) {
      handlers[listName] = async (opts?: QueryOpts<any>) => {
        await ensureReady?.();
        const auth = await options.auth();
        const query = buildSelect(table, opts, meta);
        return execQuery(db, auth, query.text, query.params);
      };
    }

    // get
    const getName = `get${singular}`;
    if (!excludeSet.has(getName)) {
      handlers[getName] = async (id: string | Record<string, unknown>) => {
        await ensureReady?.();
        const auth = await options.auth();
        let where: Record<string, unknown>;
        if (id != null && typeof id === 'object' && !Array.isArray(id)) {
          for (const c of pkCols) {
            if (!(c in id)) throw new Error(`Missing primary key column "${c}" in id object`);
          }
          where = id;
        } else {
          if (pkCols.length > 1) {
            throw new Error(`Composite primary key requires an object with keys: ${pkCols.join(', ')}`);
          }
          where = { [pkCols[0]]: id };
        }
        const query = buildSelect(table, { where: where as any }, meta);
        const rows = await execQuery(db, auth, query.text, query.params);
        return rows[0] ?? null;
      };
    }

    // create
    const createName = `create${singular}`;
    if (!excludeSet.has(createName)) {
      handlers[createName] = async (data: Record<string, unknown>) => {
        await ensureReady?.();
        const auth = await options.auth();
        const query = buildInsert(table, data, meta);
        const rows = await execQuery(db, auth, query.text, query.params);
        return rows[0];
      };
    }

    // update
    const updateName = `update${singular}`;
    if (!excludeSet.has(updateName)) {
      handlers[updateName] = async (id: string | Record<string, unknown>, data: Record<string, unknown>) => {
        await ensureReady?.();
        const auth = await options.auth();
        const query = buildUpdate(table, resolvePkValues(id), data, meta);
        const rows = await execQuery(db, auth, query.text, query.params);
        return rows[0] ?? null;
      };
    }

    // delete
    const deleteName = `delete${singular}`;
    if (!excludeSet.has(deleteName)) {
      handlers[deleteName] = async (id: string | Record<string, unknown>) => {
        await ensureReady?.();
        const auth = await options.auth();
        const query = buildDelete(table, resolvePkValues(id), meta);
        const scoped = db.withRLS({ userId: auth.userId, claims: auth.claims });
        const result = await scoped.executeRaw(query.text, query.params);
        return { deleted: result.rowCount > 0 };
      };
    }
  }

  return handlers;
}

/** Execute a query through withRLS and return rows. */
async function execQuery(
  db: RLSEnabledDatabase,
  auth: CrudAuthResult,
  text: string,
  params: unknown[],
): Promise<any[]> {
  const scoped = db.withRLS({ userId: auth.userId, claims: auth.claims });
  return scoped.queryRaw<any>(text, params);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
