// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Compiles a client's `SnapshotQuery` (structured, untrusted) into SQL with
 * bound parameters. Only fields in the shape's queryable columns, a fixed set
 * of operators, and parameter values are accepted: the client never sends SQL.
 * The result is always combined with the shape's own signed `where` by the
 * caller, so a snapshot can only narrow the shape.
 */

import { ApiError } from '@aws-blocks/core';
import { SHAPE_INVALID } from './claims.js';
import { fieldToColumn } from './mapping.js';
import type { ColumnMapping } from './mapping.js';

export const MAX_SNAPSHOT_LIMIT = 10_000;
const MAX_OFFSET = 1_000_000;
const MAX_CONDITIONS = 64;
const MAX_DEPTH = 4;
const MAX_IN = 1000;

export interface CompiledSnapshot {
  /** SQL condition with `$n` placeholders starting at `firstParam`, or `null` for no condition. */
  where: string | null;
  params: string[];
  /** `ORDER BY` list without the keywords, or `null`. */
  orderBy: string | null;
  limit: number | null;
  offset: number | null;
}

function invalid(message: string): ApiError {
  return new ApiError(message, 400, { name: SHAPE_INVALID });
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

function toParam(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  throw invalid(`Snapshot filter value for "${field}" must be a string, number, bigint, or boolean.`);
}

const COMPARISONS: Record<string, string> = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=', like: 'LIKE', ilike: 'ILIKE' };

const COLUMN_PATTERN = /^[a-z_][a-z0-9_]*$/;

/**
 * Compile `query`. `allowed` lists the queryable column names (`null`: any
 * valid column name, checked by the database); `mapping` turns the query's
 * field names into column names; a `limit` without `orderBy` sorts by
 * `keyColumn`, so pages are stable. Throws `ShapeInvalidException`.
 */
export function compileSnapshotQuery(
  query: unknown,
  allowed: readonly string[] | null,
  mapping: ColumnMapping,
  firstParam: number,
  keyColumn: string,
  /**
   * The table, as quoted SQL (`"app"."todos"`), to qualify sort columns with.
   * Needed when the select list casts columns (`col::text AS col`): an
   * unqualified `ORDER BY col` would sort by the text alias.
   */
  qualifier?: string,
): CompiledSnapshot {
  if (typeof query !== 'object' || query === null) throw invalid('A snapshot query must be an object.');
  const { where, orderBy, limit, offset } = query as Record<string, unknown>;
  const params: string[] = [];
  let conditions = 0;

  const column = (field: string): string => {
    const name = fieldToColumn(field, mapping);
    if (allowed ? !allowed.includes(name) : !COLUMN_PATTERN.test(name)) {
      throw invalid(`"${field}" is not a queryable column of this shape.`);
    }
    return quoteIdent(name);
  };
  const bind = (value: unknown, field: string): string => {
    params.push(toParam(value, field));
    return `$${firstParam + params.length - 1}`;
  };

  const compileFilter = (filter: unknown, depth: number): string | null => {
    if (depth > MAX_DEPTH) throw invalid('Snapshot filters may nest at most 4 levels.');
    if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) throw invalid('A snapshot filter must be an object.');
    const parts: string[] = [];
    for (const [field, condition] of Object.entries(filter as Record<string, unknown>)) {
      if (condition === undefined) continue;
      if (++conditions > MAX_CONDITIONS) throw invalid(`A snapshot filter may have at most ${MAX_CONDITIONS} conditions.`);
      if (field === 'or') {
        if (!Array.isArray(condition) || condition.length === 0) throw invalid('"or" must be a non-empty array of filters.');
        const alternatives = condition.map((alt) => compileFilter(alt, depth + 1) ?? 'TRUE');
        parts.push(`(${alternatives.join(' OR ')})`);
        continue;
      }
      const col = column(field);
      if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) {
        if (condition === null) throw invalid(`Use { isNull: true } to match NULL in "${field}".`);
        parts.push(`${col} = ${bind(condition, field)}`);
        continue;
      }
      for (const [op, value] of Object.entries(condition as Record<string, unknown>)) {
        if (value === undefined) continue;
        if (op === 'isNull') {
          parts.push(`${col} IS ${value ? '' : 'NOT '}NULL`);
        } else if (op === 'in') {
          if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IN) {
            throw invalid(`"in" for "${field}" must list 1 to ${MAX_IN} values.`);
          }
          parts.push(`${col} IN (${value.map((v) => bind(v, field)).join(', ')})`);
        } else if (op in COMPARISONS) {
          if ((op === 'like' || op === 'ilike') && typeof value !== 'string') throw invalid(`"${op}" for "${field}" takes a string.`);
          parts.push(`${col} ${COMPARISONS[op]} ${bind(value, field)}`);
        } else {
          throw invalid(`Unknown snapshot operator "${op}" for "${field}".`);
        }
      }
    }
    return parts.length > 0 ? `(${parts.join(' AND ')})` : null;
  };

  const compiledWhere = where === undefined ? null : compileFilter(where, 1);

  let compiledOrder: string | null = null;
  if (orderBy !== undefined) {
    if (!Array.isArray(orderBy) || orderBy.length > 8) throw invalid('"orderBy" must be an array of at most 8 entries.');
    compiledOrder =
      orderBy
        .map((entry) => {
          const { field, direction, nulls } = (entry ?? {}) as Record<string, unknown>;
          if (typeof field !== 'string') throw invalid('Each "orderBy" entry needs a "field".');
          if (direction !== undefined && direction !== 'asc' && direction !== 'desc') throw invalid('"direction" must be "asc" or "desc".');
          if (nulls !== undefined && nulls !== 'first' && nulls !== 'last') throw invalid('"nulls" must be "first" or "last".');
          return `${qualifier ? `${qualifier}.` : ''}${column(field)} ${direction === 'desc' ? 'DESC' : 'ASC'}${nulls ? ` NULLS ${nulls === 'first' ? 'FIRST' : 'LAST'}` : ''}`;
        })
        .join(', ') || null;
  }

  const integer = (value: unknown, name: string, max: number, min: number): number | null => {
    if (value === undefined) return null;
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
      throw invalid(`"${name}" must be an integer from ${min} to ${max}.`);
    }
    return value as number;
  };

  const compiledLimit = integer(limit, 'limit', MAX_SNAPSHOT_LIMIT, 1);
  const compiledOffset = integer(offset, 'offset', MAX_OFFSET, 0);
  if ((compiledLimit !== null || compiledOffset !== null) && !compiledOrder) {
    compiledOrder = `${qualifier ? `${qualifier}.` : ''}${quoteIdent(keyColumn)} ASC`;
  }
  return { where: compiledWhere, params, orderBy: compiledOrder, limit: compiledLimit, offset: compiledOffset };
}
