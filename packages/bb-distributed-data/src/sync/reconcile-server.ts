// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Server side of the reconcile protocol. Used unchanged by the mock (PGlite)
 * and the AWS runtime (Aurora DSQL): both read the shape with one `SELECT`
 * and compare bucket digests. No per-shape state is kept between requests.
 */

import { createHash } from 'node:crypto';
import type { DatabaseEngine } from '@aws-blocks/data-common';
import { compileSnapshotQuery } from '@aws-blocks/data-common/sync';
import type { ShapeClaims } from '@aws-blocks/data-common/sync';
import { BUCKETS, MAX_REQUEST_KEYS, MAX_RESPONSE_BYTES, bucketDigest } from './protocol.js';
import { openKeys } from './bell-keys.js';
import type { BucketDigest, ReconcileRequest, ReconcileResponse, RowHash, TextRow } from './protocol.js';

interface TableInfo {
  /** Column name → `udt_name`, in table order. */
  types: Map<string, string>;
  primaryKey: string[];
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** `app.todos` → `['app', 'todos']`; `todos` → `['public', 'todos']`. Names are pre-validated. */
export function splitTable(table: string): [string, string] {
  const parts = table.split('.');
  return parts.length === 2 ? [parts[0], parts[1]] : ['public', parts[0]];
}

/** FNV-1a, 32-bit. Assigns a key to a bucket. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function bucketOf(key: string): number {
  return fnv1a(key) % BUCKETS;
}

/** Hash of a row's text values, in column order. NUL separates values; SOH marks SQL NULL. */
export function rowHash(columns: string[], row: TextRow): RowHash {
  const hash = createHash('sha256');
  for (const column of columns) {
    const value = row[column];
    hash.update(value === null ? '\u0001' : value);
    hash.update('\u0000');
  }
  return hash.digest('hex').slice(0, 16);
}

const TABLE_INFO_TTL_MS = 60_000;

/** Keys per `IN (...)` list, to keep statements small. */
const KEYS_PER_QUERY = 1000;

/** Thrown for a shape that cannot be served (missing table, wrong key, unknown column). */
export class ShapeDefinitionError extends Error {}

/**
 * One reconcile server per `DistributedDatabase`. `getEngine` resolves the
 * engine once migrations have run. Table metadata is cached for the life of
 * the process.
 */
export class ReconcileServer {
  private readonly tables = new Map<string, { at: number; info: Promise<TableInfo> }>();

  constructor(
    private readonly getEngine: () => Promise<DatabaseEngine>,
    /** Page size of full-reconcile answers. Tests lower it. */
    private readonly maxResponseBytes = MAX_RESPONSE_BYTES,
  ) {}

  /** The single-column primary key of `table`, or `null` if it has none or several. */
  async primaryKey(table: string): Promise<string | null> {
    const info = await this.tableInfo(await this.getEngine(), table);
    return info.primaryKey.length === 1 ? info.primaryKey[0] : null;
  }

  /**
   * Answer one reconcile request whose token has already been verified.
   * `tokenKey` opens the sealed key lists of `changed` requests.
   */
  async serve(claims: ShapeClaims, request: ReconcileRequest, tokenKey: string): Promise<ReconcileResponse | { ndjson: string }> {
    const engine = await this.getEngine();
    const info = await this.tableInfo(engine, claims.t);
    if (info.primaryKey.length !== 1 || info.primaryKey[0] !== claims.k) {
      throw new ShapeDefinitionError(
        info.primaryKey.length === 1
          ? `Shape key "${claims.k}" is not the primary key of "${claims.t}" (found "${info.primaryKey[0]}"). ` +
              `Pass \`key: '${info.primaryKey[0]}'\` to db.shape().`
          : `Table "${claims.t}" must have a single-column primary key to be synced ` +
              `(found ${info.primaryKey.length} primary-key columns).`,
      );
    }
    const columns = claims.c ?? [...info.types.keys()];
    const schema: Record<string, string> = {};
    for (const column of columns) {
      const type = info.types.get(column);
      if (!type) throw new ShapeDefinitionError(`Shape column "${column}" does not exist on "${claims.t}".`);
      schema[column] = type;
    }

    const v = createHash('sha256').update(JSON.stringify(schema)).digest('hex').slice(0, 12);

    if (request.snapshot !== undefined) {
      const base = claims.p ?? [];
      const compiled = compileSnapshotQuery(request.snapshot, claims.q ?? columns, undefined, base.length + 1, claims.k, claims.t.split('.').map(quoteIdent).join('.'));
      const sqlText =
        this.selectSql(claims, columns, compiled.where ?? undefined) +
        (compiled.orderBy ? ` ORDER BY ${compiled.orderBy}` : '') +
        (compiled.limit !== null ? ` LIMIT ${compiled.limit}` : '') +
        (compiled.offset !== null ? ` OFFSET ${compiled.offset}` : '');
      const rows = await engine.query<TextRow>(sqlText, [...base, ...compiled.params]);
      return { schema, v, rows: rows.map((row) => this.entry(claims, columns, row)) };
    }

    if (Array.isArray(request.changed) || Array.isArray(request.written)) {
      const keys = new Set<string>();
      for (const sealed of request.changed ?? []) {
        const opened = typeof sealed === 'string' ? openKeys(sealed, tokenKey, claims.t) : null;
        // Not ours (e.g. sealed before a key rotation): the client must do a full reconcile.
        if (!opened) return { schema, v, full: true };
        for (const key of opened) keys.add(key);
      }
      // A transaction's written keys: lists sealed for other tables don't concern this shape.
      for (const sealed of request.written ?? []) {
        const opened = typeof sealed === 'string' ? openKeys(sealed, tokenKey, claims.t) : null;
        for (const key of opened ?? []) keys.add(key);
      }
      if (keys.size > MAX_REQUEST_KEYS) return { schema, v, full: true };
      const rows = await this.selectKeys(engine, claims, columns, [...keys]);
      const found = new Set(rows.map((row) => String(row[claims.k])));
      const recheck = new Set<number>();
      for (const key of keys) if (!found.has(key)) recheck.add(bucketOf(key));
      return { schema, v, rows: rows.map((row) => this.entry(claims, columns, row)), recheck: [...recheck] };
    }

    if (Array.isArray(request.held)) {
      const held = request.held.filter((key): key is string => typeof key === 'string');
      if (held.length > MAX_REQUEST_KEYS) throw new ShapeDefinitionError(`A shape request may name at most ${MAX_REQUEST_KEYS} keys.`);
      const rows = await this.selectKeys(engine, claims, columns, held);
      return { schema, v, rows: rows.map((row) => this.entry(claims, columns, row)) };
    }

    const rows = await engine.query<TextRow>(this.selectSql(claims, columns), claims.p ?? []);
    const server = new Map<number, [RowHash, TextRow][]>();
    for (const row of rows) {
      const bucket = bucketOf(String(row[claims.k]));
      let entries = server.get(bucket);
      if (!entries) {
        entries = [];
        server.set(bucket, entries);
      }
      entries.push([rowHash(columns, row), row]);
    }

    const client = request.digest ?? {};
    const lines = [JSON.stringify({ schema, v })];
    let bytes = lines[0].length;
    const candidates = new Set<number>([...server.keys(), ...Object.keys(client).map(Number)]);
    for (const bucket of [...candidates].sort((a, b) => a - b)) {
      if (!Number.isInteger(bucket) || bucket < 0 || bucket >= BUCKETS) continue;
      const entries = server.get(bucket) ?? [];
      const digest: BucketDigest = bucketDigest(entries.map(([hash]) => hash));
      const theirs = client[String(bucket)] ?? bucketDigest([]);
      if (digest === theirs) continue;
      const line = JSON.stringify([bucket, entries]);
      if (lines.length > 1 && bytes + line.length > this.maxResponseBytes) {
        lines.push(JSON.stringify({ more: true }));
        break;
      }
      lines.push(line);
      bytes += line.length + 1;
    }
    return { ndjson: lines.join('\n') };
  }

  private entry(claims: ShapeClaims, columns: string[], row: TextRow): [number, RowHash, TextRow] {
    return [bucketOf(String(row[claims.k])), rowHash(columns, row), row];
  }

  private selectSql(claims: ShapeClaims, columns: string[], extra?: string): string {
    const select = columns.map((column) => `${quoteIdent(column)}::text AS ${quoteIdent(column)}`).join(', ');
    const filters = [claims.w ? `(${claims.w})` : '', extra ?? ''].filter(Boolean);
    const where = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
    return `SELECT ${select} FROM ${claims.t.split('.').map(quoteIdent).join('.')}${where}`;
  }

  /** The shape's rows among `keys`. Compares the key column to untyped parameters, so its index is used. */
  private async selectKeys(engine: DatabaseEngine, claims: ShapeClaims, columns: string[], keys: string[]): Promise<TextRow[]> {
    const base = claims.p ?? [];
    const rows: TextRow[] = [];
    for (let i = 0; i < keys.length; i += KEYS_PER_QUERY) {
      const chunk = keys.slice(i, i + KEYS_PER_QUERY);
      const list = chunk.map((_, j) => `$${base.length + j + 1}`).join(', ');
      rows.push(...(await engine.query<TextRow>(this.selectSql(claims, columns, `${quoteIdent(claims.k)} IN (${list})`), [...base, ...chunk])));
    }
    return rows;
  }

  /** Table metadata, re-read every minute so a migration shows up without a restart. */
  private tableInfo(engine: DatabaseEngine, table: string): Promise<TableInfo> {
    const cached = this.tables.get(table);
    if (cached && Date.now() - cached.at < TABLE_INFO_TTL_MS) return cached.info;
    const info = this.loadTableInfo(engine, table);
    this.tables.set(table, { at: Date.now(), info });
    info.catch(() => this.tables.delete(table));
    return info;
  }

  private async loadTableInfo(engine: DatabaseEngine, table: string): Promise<TableInfo> {
    const [schemaName, tableName] = splitTable(table);
    const columns = await engine.query<{ column_name: string; udt_name: string }>(
      `SELECT column_name, udt_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
      [schemaName, tableName],
    );
    if (columns.length === 0) throw new ShapeDefinitionError(`Table "${table}" does not exist.`);
    const keys = await engine.query<{ column_name: string }>(
      `SELECT k.column_name
         FROM information_schema.table_constraints c
         JOIN information_schema.key_column_usage k
           ON k.constraint_name = c.constraint_name AND k.table_schema = c.table_schema AND k.table_name = c.table_name
        WHERE c.constraint_type = 'PRIMARY KEY' AND c.table_schema = $1 AND c.table_name = $2`,
      [schemaName, tableName],
    );
    return {
      types: new Map(columns.map((column) => [column.column_name, column.udt_name])),
      primaryKey: keys.map((key) => key.column_name),
    };
  }
}
