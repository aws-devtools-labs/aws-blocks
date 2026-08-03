// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * SQL builder for the CRUD filter DSL.
 *
 * Converts filter objects into parameterized SQL. All identifiers are double-quoted.
 * All values are parameterized ($1, $2, ...). Operators are a fixed enum.
 *
 * @module
 */
import type { BuiltQuery, QueryOpts, WhereClause, TableMetaEntry } from './types.js';

const OPERATORS = new Set(['gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in']);
const OP_MAP: Record<string, string> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
  ilike: 'ILIKE',
};

function quoteId(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

function validateColumn(col: string, meta: TableMetaEntry): void {
  if (!meta.columns.includes(col)) {
    throw new Error(`Unknown column: "${col}" (valid: ${meta.columns.join(', ')})`);
  }
}

/**
 * Build a WHERE clause from a filter object. Returns empty string if no filters.
 *
 * @param startIndex - First placeholder number to use. Defaults to 1. Pass a higher
 * value when the clause follows other parameters in the same statement, as in
 * `UPDATE ... SET a = $1 WHERE ...`.
 * @returns `paramOffset` is the last placeholder number consumed, so the next free
 * placeholder is `paramOffset + 1`.
 */
export function buildWhere<Row>(
  where: WhereClause<Row> | undefined,
  meta: TableMetaEntry,
  startIndex = 1,
): { clause: string; params: unknown[]; paramOffset: number } {
  if (!where || Object.keys(where).length === 0) {
    return { clause: '', params: [], paramOffset: startIndex - 1 };
  }

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = startIndex;

  for (const [key, value] of Object.entries(where)) {
    if (key === 'or') {
      const orClauses = value as WhereClause<Row>[];
      if (!Array.isArray(orClauses) || orClauses.length === 0) continue;
      const orParts: string[] = [];
      for (const orItem of orClauses) {
        const sub = buildWhereConditions(orItem as Record<string, unknown>, meta, idx);
        orParts.push(sub.conditions.join(' AND '));
        params.push(...sub.params);
        idx += sub.params.length;
      }
      conditions.push(`(${orParts.join(' OR ')})`);
      continue;
    }

    validateColumn(key, meta);
    const col = quoteId(key);

    if (value === null) {
      conditions.push(`${col} IS NULL`);
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      // Treat any non-null, non-array object as an operator expression
      const ops = value as Record<string, unknown>;
      for (const [op, opVal] of Object.entries(ops)) {
        if (!OPERATORS.has(op)) throw new Error(`Unknown operator: "${op}"`);
        if (op === 'in') {
          const arr = opVal as unknown[];
          if (!Array.isArray(arr) || arr.length === 0) throw new Error(`"in" requires a non-empty array`);
          const placeholders = arr.map(() => `$${idx++}`);
          conditions.push(`${col} IN (${placeholders.join(', ')})`);
          params.push(...arr);
        } else {
          conditions.push(`${col} ${OP_MAP[op]} $${idx++}`);
          params.push(opVal);
        }
      }
    } else {
      // Direct equality
      conditions.push(`${col} = $${idx++}`);
      params.push(value);
    }
  }

  return {
    clause: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '',
    params,
    paramOffset: idx - 1,
  };
}

function buildWhereConditions(
  obj: Record<string, unknown>,
  meta: TableMetaEntry,
  startIdx: number,
): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = startIdx;

  for (const [key, value] of Object.entries(obj)) {
    validateColumn(key, meta);
    const col = quoteId(key);

    if (value === null) {
      conditions.push(`${col} IS NULL`);
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      const ops = value as Record<string, unknown>;
      for (const [op, opVal] of Object.entries(ops)) {
        if (!OPERATORS.has(op)) throw new Error(`Unknown operator: "${op}"`);
        if (op === 'in') {
          const arr = opVal as unknown[];
          if (!Array.isArray(arr) || arr.length === 0) throw new Error(`"in" requires a non-empty array`);
          const placeholders = arr.map(() => `$${idx++}`);
          conditions.push(`${col} IN (${placeholders.join(', ')})`);
          params.push(...arr);
        } else {
          conditions.push(`${col} ${OP_MAP[op]} $${idx++}`);
          params.push(opVal);
        }
      }
    } else {
      conditions.push(`${col} = $${idx++}`);
      params.push(value);
    }
  }

  return { conditions, params };
}

/** Build a SELECT query. */
export function buildSelect<Row>(
  table: string,
  opts: QueryOpts<Row> | undefined,
  meta: TableMetaEntry,
): BuiltQuery {
  const columns = opts?.select
    ? opts.select.map((c) => { validateColumn(c, meta); return quoteId(c); }).join(', ')
    : '*';

  const { clause: whereClause, params, paramOffset } = buildWhere(opts?.where, meta);
  let idx = paramOffset + 1;

  let orderClause = '';
  if (opts?.orderBy) {
    const entries = Array.isArray(opts.orderBy) ? opts.orderBy : [opts.orderBy];
    const parts = entries.map((entry) => {
      const segments = entry.split(':');
      if (segments.length !== 2) {
        throw new Error(`orderBy must be "column:asc" or "column:desc", got "${entry}"`);
      }
      const [col, dir] = segments;
      validateColumn(col, meta);
      const normalized = dir.toLowerCase();
      if (normalized !== 'asc' && normalized !== 'desc') {
        throw new Error(`Invalid orderBy direction "${dir}", must be "asc" or "desc"`);
      }
      return `${quoteId(col)} ${normalized === 'desc' ? 'DESC' : 'ASC'}`;
    });
    orderClause = ` ORDER BY ${parts.join(', ')}`;
  }

  let limitClause = '';
  if (opts?.limit !== undefined) {
    if (!Number.isInteger(opts.limit) || opts.limit < 0) throw new Error('limit must be a non-negative integer');
    limitClause = ` LIMIT $${idx++}`;
    params.push(opts.limit);
  }

  let offsetClause = '';
  if (opts?.offset !== undefined) {
    if (!Number.isInteger(opts.offset) || opts.offset < 0) throw new Error('offset must be a non-negative integer');
    offsetClause = ` OFFSET $${idx++}`;
    params.push(opts.offset);
  }

  return {
    text: `SELECT ${columns} FROM ${quoteId(table)}${whereClause}${orderClause}${limitClause}${offsetClause}`,
    params,
  };
}

/** Build an INSERT query. Excludes auto-generated columns. */
export function buildInsert(
  table: string,
  data: Record<string, unknown>,
  meta: TableMetaEntry,
): BuiltQuery {
  const autoGen = new Set(meta.autoGenerated);
  const entries = Object.entries(data).filter(([k]) => !autoGen.has(k));

  if (entries.length === 0) throw new Error('No columns to insert (all are auto-generated)');

  for (const [k] of entries) validateColumn(k, meta);

  const columns = entries.map(([k]) => quoteId(k)).join(', ');
  const placeholders = entries.map((_, i) => `$${i + 1}`).join(', ');
  const params = entries.map(([, v]) => v);

  return {
    text: `INSERT INTO ${quoteId(table)} (${columns}) VALUES (${placeholders}) RETURNING *`,
    params,
  };
}

/** Build an UPDATE query. */
export function buildUpdate(
  table: string,
  pkValues: unknown[],
  data: Record<string, unknown>,
  meta: TableMetaEntry,
): BuiltQuery {
  const autoGen = new Set(meta.autoGenerated);
  const entries = Object.entries(data).filter(([k]) => !autoGen.has(k));

  if (entries.length === 0) throw new Error('No columns to update (all are auto-generated or empty)');

  for (const [k] of entries) validateColumn(k, meta);

  const sets = entries.map(([k], i) => `${quoteId(k)} = $${i + 1}`).join(', ');
  const params = [...entries.map(([, v]) => v), ...pkValues];
  const pkCols = Array.isArray(meta.primaryKey) ? meta.primaryKey : [meta.primaryKey];
  const whereClause = pkCols.map((col, i) => `${quoteId(col)} = $${entries.length + i + 1}`).join(' AND ');

  return {
    text: `UPDATE ${quoteId(table)} SET ${sets} WHERE ${whereClause} RETURNING *`,
    params,
  };
}

/** Build a DELETE query. */
export function buildDelete(
  table: string,
  pkValues: unknown[],
  meta: TableMetaEntry,
): BuiltQuery {
  const pkCols = Array.isArray(meta.primaryKey) ? meta.primaryKey : [meta.primaryKey];
  const whereClause = pkCols.map((col, i) => `${quoteId(col)} = $${i + 1}`).join(' AND ');
  return {
    text: `DELETE FROM ${quoteId(table)} WHERE ${whereClause}`,
    params: pkValues,
  };
}

/**
 * Build an UPDATE filtered by an arbitrary WHERE clause, for the fluent client.
 *
 * Distinct from {@link buildUpdate}, which targets a single row by primary key.
 *
 * @throws If `where` is empty. An UPDATE with no filter rewrites every row in the
 * table, which is almost never what the caller meant — so it has to be spelled out
 * rather than being the result of a forgotten filter.
 */
export function buildUpdateWhere<Row>(
  table: string,
  data: Record<string, unknown>,
  where: WhereClause<Row>,
  meta: TableMetaEntry,
): BuiltQuery {
  const autoGen = new Set(meta.autoGenerated);
  const entries = Object.entries(data).filter(([k]) => !autoGen.has(k));
  if (entries.length === 0) throw new Error('No columns to update (all are auto-generated or empty)');
  for (const [k] of entries) validateColumn(k, meta);

  if (!where || Object.keys(where).length === 0) {
    throw new Error('update() requires at least one filter — an unfiltered update would rewrite every row');
  }

  const sets = entries.map(([k], i) => `${quoteId(k)} = $${i + 1}`).join(', ');
  const { clause, params: whereParams } = buildWhere(where, meta, entries.length + 1);

  return {
    text: `UPDATE ${quoteId(table)} SET ${sets}${clause} RETURNING *`,
    params: [...entries.map(([, v]) => v), ...whereParams],
  };
}

/**
 * Build a DELETE filtered by an arbitrary WHERE clause, for the fluent client.
 *
 * Distinct from {@link buildDelete}, which targets a single row by primary key.
 *
 * @throws If `where` is empty, for the same reason as {@link buildUpdateWhere}.
 */
export function buildDeleteWhere<Row>(
  table: string,
  where: WhereClause<Row>,
  meta: TableMetaEntry,
): BuiltQuery {
  if (!where || Object.keys(where).length === 0) {
    throw new Error('delete() requires at least one filter — an unfiltered delete would remove every row');
  }
  const { clause, params } = buildWhere(where, meta);
  return { text: `DELETE FROM ${quoteId(table)}${clause} RETURNING *`, params };
}

/** Build a COUNT query with the same filter semantics as {@link buildSelect}. */
export function buildCount<Row>(
  table: string,
  where: WhereClause<Row> | undefined,
  meta: TableMetaEntry,
): BuiltQuery {
  const { clause, params } = buildWhere(where, meta);
  return { text: `SELECT count(*)::int AS count FROM ${quoteId(table)}${clause}`, params };
}
