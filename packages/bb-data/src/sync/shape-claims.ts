// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side shape definition: validation, signed tokens, and the endpoint
 * path. Shared by the mock and AWS runtimes so both issue identical shapes.
 *
 * A shape token is the whole authorization decision. The API method that
 * returns a shape runs the app's auth check once, then signs the table, row
 * filter, and columns into the token. The shape endpoint only verifies the
 * signature and expiry; it never reads table/where/columns from the client.
 */

import { createHmac } from 'node:crypto';
import { ApiError } from '@aws-blocks/core';
import { constantTimeEquals } from '@aws-blocks/core/bb-utils';
import { unwrapQuery } from '@aws-blocks/data-common';
import { DatabaseErrors } from '../errors.js';
import type { ShapeDescriptor, ShapeOptions, SyncOptions } from '../types.js';
export { CLIENT_PROTOCOL_PARAMS, ELECTRIC_EXPOSED_HEADERS, TOKEN_PARAM, shapePath } from './shape-constants.js';

/** Signed contents of a shape token. Short keys keep the URL small. */
export interface ShapeClaims {
  /** Format version. */
  v: 1;
  /** `fullId` of the Database that issued the token. */
  db: string;
  /** Table. */
  t: string;
  /** Row filter with `$1..$n` placeholders. */
  w?: string;
  /** Filter parameters, as strings (Electric's wire format). */
  p?: string[];
  /** Column list. */
  c?: string[];
  /** Primary-key column. */
  k: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

const DEFAULT_TTL_SECONDS = 3600;
const MAX_TTL_SECONDS = 24 * 3600;

/** Unquoted, optionally schema-qualified Postgres identifier. */
const TABLE_PATTERN = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;
const COLUMN_PATTERN = /^[a-z_][a-z0-9_]*$/;

/**
 * Validate `Database({ sync })` at construction. Throws a plain `Error`
 * (a configuration mistake, caught at synth or dev-server start).
 */
export function validateSyncOptions(fullId: string, sync: SyncOptions): void {
  if (!Array.isArray(sync.tables) || sync.tables.length === 0) {
    throw new Error(`Database "${fullId}": sync.tables must list at least one table.`);
  }
  for (const table of sync.tables) {
    if (!TABLE_PATTERN.test(table)) {
      throw new Error(
        `Database "${fullId}": sync table "${table}" is not a valid unquoted identifier. ` +
          `Use lowercase letters, digits, and underscores, optionally schema-qualified ('app.todos').`,
      );
    }
  }
}

function invalidShape(message: string): ApiError {
  return new ApiError(message, 400, { name: DatabaseErrors.ShapeInvalid });
}

/** Convert a filter parameter to Electric's string wire form. */
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
 * Validate `db.shape()` options against the Database's sync config and turn
 * them into claims. Throws `DatabaseErrors.ShapeInvalid`.
 */
export function buildClaims<T>(dbFullId: string, sync: SyncOptions | undefined, options: ShapeOptions<T>): ShapeClaims {
  if (!sync) {
    throw invalidShape(`Database "${dbFullId}" does not have sync enabled. Add \`sync: { tables: [...] }\` to its options.`);
  }
  if (!sync.tables.includes(options.table)) {
    throw invalidShape(`Table "${options.table}" is not listed in sync.tables for Database "${dbFullId}".`);
  }
  const key = options.key ?? 'id';
  if (!COLUMN_PATTERN.test(key)) {
    throw invalidShape(`Shape key "${key}" is not a valid unquoted column name.`);
  }
  let columns: string[] | undefined;
  if (options.columns) {
    columns = [...options.columns];
    for (const column of columns) {
      if (!COLUMN_PATTERN.test(column)) {
        throw invalidShape(`Shape column "${column}" is not a valid unquoted column name.`);
      }
    }
    if (!columns.includes(key)) {
      throw invalidShape(`Shape columns must include the key column "${key}".`);
    }
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
  }
  if (columns) claims.c = columns;
  return claims;
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
 * `dbFullId` binds the token to the Database whose endpoint received it.
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
 * Derive the token-signing key from the sync service secret, so one secret
 * serves both purposes without the raw secret ever signing client tokens.
 */
export function deriveTokenKey(secret: string): string {
  return createHmac('sha256', secret).update('aws-blocks/data/shape-token/v1').digest('base64url');
}

/** Build the wire descriptor for a signed shape. `path` is the Database's {@link shapePath}. */
export function toDescriptor(path: string, claims: ShapeClaims, token: string): ShapeDescriptor {
  return { __blocks: 'data/shape', path, token, key: claims.k, expiresAt: claims.exp };
}

/**
 * Electric's query parameters for the claims: table, where, params[n], columns.
 * Used by both the AWS proxy and the mock server (which reads them back), so
 * the two agree on the shape definition.
 */
export function claimsToElectricParams(claims: ShapeClaims): URLSearchParams {
  const params = new URLSearchParams();
  params.set('table', claims.t);
  if (claims.w) params.set('where', claims.w);
  for (const [i, value] of (claims.p ?? []).entries()) params.set(`params[${i + 1}]`, value);
  if (claims.c) params.set('columns', claims.c.join(','));
  return params;
}

/** Map a token rejection to an HTTP status and a client-safe message. */
export function rejectionResponse(reason: TokenRejection): { status: number; body: { error: string; name: string } } {
  const status = reason === 'expired' ? 401 : 403;
  const message =
    reason === 'expired' ? 'The shape token has expired' : 'The shape token is not valid for this endpoint';
  return { status, body: { error: message, name: DatabaseErrors.ShapeInvalid } };
}
