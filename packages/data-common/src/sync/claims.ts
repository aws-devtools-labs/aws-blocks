// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side shape definition: validation, signed tokens, and the wire
 * descriptor. Shared by every SQL Building Block that syncs, so all of them
 * issue shapes the same way.
 *
 * A shape token is the whole authorization decision. The API method that
 * returns a shape runs the app's auth check once, then signs the table, row
 * filter, and columns into the token. The shape endpoint only verifies the
 * signature and expiry; it never reads table/where/columns from the client.
 */

import { createHmac } from 'node:crypto';
import { ApiError } from '@aws-blocks/core';
import { constantTimeEquals } from '@aws-blocks/core/bb-utils';
import { unwrapQuery } from '../sql.js';
import type { ShapeDescriptor, ShapeOptions } from './types.js';
import { fieldToColumn } from './mapping.js';
import type { ColumnMapping } from './mapping.js';

/** Error name for an invalid shape request. Each BB exposes it as `XxxErrors.ShapeInvalid`. */
export const SHAPE_INVALID = 'ShapeInvalidException';

/** The part of a BB's `sync` option that shapes depend on. */
export interface SyncTables {
  tables: string[];
}

/** Signed contents of a shape token. Short keys keep the URL small. */
export interface ShapeClaims {
  /** Format version. */
  v: 1;
  /** `fullId` of the database that issued the token. */
  db: string;
  /** Table. */
  t: string;
  /** Row filter with `$1..$n` placeholders. */
  w?: string;
  /** Filter parameters, as strings (their wire format). */
  p?: string[];
  /** Column list. */
  c?: string[];
  /** Primary-key column. */
  k: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
  /** `'c'`: changes-only shape (starts empty; rows load through snapshots). */
  m?: 'c';
  /** Queryable columns for snapshots. Omitted: the shape's columns. */
  q?: string[];
  /** Tables the filter reads besides `t` (subqueries). */
  d?: string[];
  /** Column mapping of rows: `'s'` = snake_case → camelCase. */
  cm?: 's';
}

const DEFAULT_TTL_SECONDS = 3600;
const MAX_TTL_SECONDS = 24 * 3600;

/** Unquoted, optionally schema-qualified Postgres identifier. */
const TABLE_PATTERN = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;
const COLUMN_PATTERN = /^[a-z_][a-z0-9_]*$/;

/**
 * Validate a `sync` option at construction. Throws a plain `Error`
 * (a configuration mistake, caught at synth or dev-server start).
 * `label` names the Building Block class in messages.
 */
export function validateSyncOptions(fullId: string, sync: SyncTables, label = 'Database'): void {
  if (!Array.isArray(sync.tables) || sync.tables.length === 0) {
    throw new Error(`${label} "${fullId}": sync.tables must list at least one table.`);
  }
  for (const table of sync.tables) {
    if (!TABLE_PATTERN.test(table)) {
      throw new Error(
        `${label} "${fullId}": sync table "${table}" is not a valid unquoted identifier. ` +
          `Use lowercase letters, digits, and underscores, optionally schema-qualified ('app.todos').`,
      );
    }
  }
}

function invalidShape(message: string): ApiError {
  return new ApiError(message, 400, { name: SHAPE_INVALID });
}

/** Convert a filter parameter to its string wire form. */
function paramToString(value: unknown, index: number): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  throw invalidShape(
    `Shape filter parameter $${index + 1} has an unsupported type (${value === null ? 'null' : typeof value}). ` +
      `Use a string, number, bigint, boolean, or Date. To match NULL, write "IS NULL" in the filter.`,
  );
}

/**
 * Validate `db.shape()` options against the database's sync config and turn
 * them into claims. Throws `ShapeInvalidException`.
 */
export function buildClaims<T>(
  dbFullId: string,
  sync: SyncTables | undefined,
  options: ShapeOptions<T>,
  label = 'Database',
): ShapeClaims {
  if (!sync) {
    throw invalidShape(`${label} "${dbFullId}" does not have sync enabled. Add \`sync: { tables: [...] }\` to its options.`);
  }
  if (!sync.tables.includes(options.table)) {
    throw invalidShape(`Table "${options.table}" is not listed in sync.tables for ${label} "${dbFullId}".`);
  }
  const mapping: ColumnMapping = options.columnMapping === 'snakeCamel' ? 'snakeCamel' : undefined;
  if (options.columnMapping !== undefined && !mapping) {
    throw invalidShape(`Shape columnMapping must be 'snakeCamel'.`);
  }
  const toColumn = (field: string) => fieldToColumn(field, mapping);
  const key = toColumn(options.key ?? 'id');
  if (!COLUMN_PATTERN.test(key)) {
    throw invalidShape(`Shape key "${key}" is not a valid unquoted column name.`);
  }
  let columns: string[] | undefined;
  if (options.columns) {
    columns = options.columns.map(toColumn);
    for (const column of columns) {
      if (!COLUMN_PATTERN.test(column)) {
        throw invalidShape(`Shape column "${column}" is not a valid unquoted column name.`);
      }
    }
    if (!columns.includes(key)) {
      throw invalidShape(`Shape columns must include the key column "${key}".`);
    }
  }
  let queryable: string[] | undefined;
  if (options.queryableColumns) {
    queryable = options.queryableColumns.map(toColumn);
    for (const column of queryable) {
      if (!COLUMN_PATTERN.test(column)) {
        throw invalidShape(`Shape queryable column "${column}" is not a valid unquoted column name.`);
      }
      if (columns && !columns.includes(column)) {
        throw invalidShape(`Shape queryable column "${column}" must be one of the shape's columns.`);
      }
    }
  }
  if (options.mode !== undefined && options.mode !== 'full' && options.mode !== 'changes_only') {
    throw invalidShape(`Shape mode must be 'full' or 'changes_only'.`);
  }
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_TTL_SECONDS) {
    throw invalidShape(`Shape ttlSeconds must be between 1 and ${MAX_TTL_SECONDS}.`);
  }

  const claims: ShapeClaims = { v: 1, db: dbFullId, t: options.table, k: key, exp: Date.now() + ttl * 1000 };
  if (options.where) {
    const { sql, params } = unwrapQuery(options.where);
    claims.w = sql;
    if (params.length > 0) claims.p = params.map(paramToString);
    const dependencies = referencedTables(sql).filter((table) => table !== options.table);
    for (const table of dependencies) {
      if (!sync.tables.includes(table)) {
        throw invalidShape(
          `The filter reads table "${table}", which must also be listed in sync.tables for ${label} "${dbFullId}" ` +
            `so the shape updates when it changes.`,
        );
      }
    }
    if (dependencies.length > 0) claims.d = dependencies;
  }
  if (columns) claims.c = columns;
  // The key is always queryable (the `Database` sync service requires it).
  if (queryable) claims.q = queryable.includes(key) ? queryable : [key, ...queryable];
  if (options.mode === 'changes_only') claims.m = 'c';
  if (mapping) claims.cm = 's';
  return claims;
}

/** Blank out literals and comments so table names are only matched in SQL. */
function stripLiterals(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

const normalizeTable = (name: string): string => {
  const parts = name.replace(/"/g, '').toLowerCase().split('.');
  return parts.length === 2 && parts[0] === 'public' ? parts[1] : parts.join('.');
};

/** Tables a filter reads in subqueries (`FROM t` / `JOIN t`), normalized like `sync.tables` entries. */
export function referencedTables(where: string): string[] {
  const tables = new Set<string>();
  for (const match of stripLiterals(where).matchAll(/\b(?:FROM|JOIN)\s+((?:"?[a-z_][a-z0-9_]*"?\.)?"?[a-z_][a-z0-9_]*"?)/gi)) {
    tables.add(normalizeTable(match[1]));
  }
  return [...tables];
}

/**
 * The equality a shape's filter is routed by: a top-level `column = $n`
 * conjunct (combined with others by AND only). A write then only needs to reach shapes whose value
 * matches. `null` when the filter has no such term.
 */
export function routeOf(claims: ShapeClaims): { column: string; value: string } | null {
  if (!claims.w) return null;
  const text = stripLiterals(claims.w);
  const conjuncts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0) {
      if (/^OR\b/i.test(text.slice(i)) && /[\s)]/.test(text[i - 1] ?? ' ')) return null; // top-level OR: no single route
      if (/^AND\b/i.test(text.slice(i)) && /[\s)]/.test(text[i - 1] ?? ' ')) {
        conjuncts.push(text.slice(start, i));
        start = i + 3;
      }
    }
  }
  conjuncts.push(text.slice(start));
  const candidates: { column: string; value: string }[] = [];
  for (const conjunct of conjuncts) {
    const match = /^\s*"?([a-z_][a-z0-9_]*)"?\s*=\s*\$(\d+)\s*$/i.exec(conjunct);
    if (!match) continue;
    const value = claims.p?.[Number(match[2]) - 1];
    if (value !== undefined) candidates.push({ column: match[1].toLowerCase(), value });
  }
  // Prefer a term that narrows: a boolean splits the table in two at best.
  return candidates.find((c) => c.value !== 'true' && c.value !== 'false') ?? candidates[0] ?? null;
}

/** Sign claims as `{base64url(json)}.{base64url(hmac-sha256)}`. */
export function signClaims(claims: ShapeClaims, key: string): string {
  if (!key) throw new Error('Refusing to sign a shape token with an empty key');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** Why a token was rejected. Mapped to an HTTP status by the endpoint. */
export type TokenRejection = 'malformed' | 'signature' | 'expired' | 'database';

/**
 * Verify a token and return its claims, or the reason it was rejected.
 * `dbFullId` binds the token to the database whose endpoint received it.
 */
export function verifyToken(
  token: string | null,
  key: string,
  dbFullId: string,
): { ok: true; claims: ShapeClaims } | { ok: false; reason: TokenRejection } {
  if (!token || !key) return { ok: false, reason: 'malformed' };
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return { ok: false, reason: 'malformed' };
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', key).update(payload).digest('base64url');
  if (!constantTimeEquals(sig, expected)) return { ok: false, reason: 'signature' };
  let claims: ShapeClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (claims.v !== 1 || typeof claims.t !== 'string' || typeof claims.k !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  if (claims.db !== dbFullId) return { ok: false, reason: 'database' };
  if (typeof claims.exp !== 'number' || claims.exp <= Date.now()) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}

/**
 * Derive the token-signing key from a service secret, so one secret can
 * serve more than one purpose without the raw secret ever signing client tokens.
 */
export function deriveTokenKey(secret: string): string {
  return createHmac('sha256', secret).update('aws-blocks/data/shape-token/v1').digest('base64url');
}

/**
 * Build the wire descriptor for a signed shape. `path` is the database's
 * `shapePath()`; `extra` adds the protocol fields (`protocol`, `bell`).
 */
export function toDescriptor(
  path: string,
  claims: ShapeClaims,
  token: string,
  extra?: Pick<ShapeDescriptor, 'protocol' | 'bell' | 'dependencyBells'>,
): ShapeDescriptor {
  const descriptor: ShapeDescriptor = { __blocks: 'data/shape', path, token, key: claims.k, table: claims.t, expiresAt: claims.exp, ...extra };
  if (claims.m === 'c') descriptor.mode = 'changes_only';
  if (claims.cm === 's') descriptor.columnMapping = 'snakeCamel';
  return descriptor;
}

/** Map a token rejection to an HTTP status and a client-safe message. */
export function rejectionResponse(reason: TokenRejection): { status: number; body: { error: string; name: string } } {
  const status = reason === 'expired' ? 401 : 403;
  const message =
    reason === 'expired' ? 'The shape token has expired' : 'The shape token is not valid for this endpoint';
  return { status, body: { error: message, name: SHAPE_INVALID } };
}
