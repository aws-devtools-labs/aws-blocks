// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local emulator of the Electric HTTP shape protocol, on top of PGlite.
 *
 * PGlite cannot act as a logical-replication source, so the mock captures
 * changes with row triggers into a changelog table instead, and serves the
 * subset of the protocol that `@electric-sql/client` uses for a live shape:
 *
 * - `offset=-1`: the initial rows, `snapshot-end` (the snapshot they were read at), then `up-to-date`
 * - `offset=X&handle=H`: changes after X, then `up-to-date`
 * - `live=true`: hold the request up to {@link LIVE_TIMEOUT_MS} until a change arrives
 * - unknown handle: `409` + `must-refetch`, so the client resyncs from scratch
 *
 * Each distinct shape (table + filter + columns) has one
 * server-side log that every client of that shape reads from. Changes are
 * computed per primary key: after a write, the mock re-runs the shape's
 * filter for the changed keys, so rows that move into or out of the filter
 * become inserts or deletes, as they do on AWS.
 *
 * Positions (`lsn` on changes, `global_last_seen_lsn` on up-to-date) are
 * changelog sequence numbers rather than WAL positions; they order the same way.
 *
 * Differences from AWS (documented in DESIGN.md): updates carry the full row
 * (Electric sends only changed columns), the log is held in memory (a dev
 * server restart makes clients resync), and SSE live mode is not supported.
 */

import { createHash } from 'node:crypto';
import type { DatabaseEngine } from '@aws-blocks/data-common';
import type { ShapeClaims } from './shape-claims.js';
import { compileSnapshotQuery } from '@aws-blocks/data-common/sync';

/** How long a live request waits for a change before returning `up-to-date`. */
export const LIVE_TIMEOUT_MS = 20_000;
const LIVE_POLL_MS = 100;

const CHANGES_TABLE = '_blocks_sync_changes';

type Offset = [number, number];

interface ColumnInfo {
  type: string;
  dims?: number;
  not_null?: boolean;
}

interface LogEntry {
  offset: Offset;
  message: Record<string, unknown>;
}

interface ShapeState {
  handle: string;
  definitionKey: string;
  claims: ShapeClaims;
  columns: string[];
  schema: Record<string, ColumnInfo>;
  /** Keys currently in the shape. */
  keys: Set<string>;
  log: LogEntry[];
  /** Offset of the initial snapshot; the response offset when the log is empty. */
  baseOffset: Offset;
  /** Last changelog `seq` folded into the log. */
  lastSeq: number;
  /** Serializes catch-up so concurrent requests don't double-apply changes. */
  lock: Promise<void>;
}

/** A response for the RawRoute handler to send. */
export interface ShapeResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

const formatOffset = ([major, minor]: Offset): string => `${major}_${minor}`;

function parseOffset(value: string): Offset | null {
  const match = /^(\d+)_(\d+)$/.exec(value);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

const isAfter = (a: Offset, b: Offset): boolean => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** `app.todos` → `"app"."todos"`; `todos` → `"todos"`. Names are pre-validated. */
const quoteTable = (table: string): string => table.split('.').map(quoteIdent).join('.');

const defaultSchemaTable = (table: string): [string, string] => {
  const parts = table.split('.');
  return parts.length === 2 ? [parts[0], parts[1]] : ['public', parts[0]];
};

/**
 * One emulator per `Database`. `getEngine` resolves once migrations have run.
 */
export class MockShapeServer {
  private readonly shapes = new Map<string, ShapeState>();
  private readonly byHandle = new Map<string, ShapeState>();
  private readonly installedTables = new Map<string, Promise<string>>();
  private capturePrepared: Promise<void> | null = null;

  constructor(private readonly getEngine: () => Promise<DatabaseEngine>) {}

  /** Serve one shape request whose token has already been verified. */
  async serve(claims: ShapeClaims, query: URLSearchParams, signal?: AbortSignal): Promise<ShapeResponse> {
    const engine = await this.getEngine();
    const definitionKey = JSON.stringify([claims.t, claims.w ?? '', claims.p ?? [], claims.c ?? [], claims.k, claims.m ?? '', claims.q ?? []]);
    const offsetParam = query.get('offset') ?? '-1';

    // A snapshot request (changes-only shapes): the rows of the shape that match
    // the client's query, compiled on the server like on AWS.
    if (query.get('subset__where') !== null) {
      const state = await this.getOrCreate(engine, definitionKey, claims);
      return this.serveSubset(engine, state, query);
    }

    if (offsetParam === '-1') {
      const state = await this.getOrCreate(engine, definitionKey, claims);
      await this.catchUp(engine, state);
      // Changes-only shapes start empty for every client, also when the
      // shape already has changes: start each new client at the log's end.
      return this.respond(state, claims.m === 'c' ? this.latestOffset(state) : null, false);
    }

    const handle = query.get('handle');
    const state = handle ? this.byHandle.get(handle) : undefined;
    if (!state || state.definitionKey !== definitionKey) {
      const current = await this.getOrCreate(engine, definitionKey, claims);
      return {
        status: 409,
        headers: { 'electric-handle': current.handle },
        body: [{ headers: { control: 'must-refetch' } }],
      };
    }

    const live = query.get('live') === 'true';
    const after = offsetParam === 'now' ? this.latestOffset(state) : parseOffset(offsetParam);
    if (!after) {
      return { status: 400, headers: {}, body: { error: `Invalid offset "${offsetParam}"` } };
    }

    await this.catchUp(engine, state);
    if (live && !state.log.some((entry) => isAfter(entry.offset, after))) {
      const deadline = Date.now() + LIVE_TIMEOUT_MS;
      while (Date.now() < deadline && !signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, LIVE_POLL_MS));
        await this.catchUp(engine, state);
        if (state.log.some((entry) => isAfter(entry.offset, after))) break;
      }
    }
    return this.respond(state, after, live);
  }

  private respond(state: ShapeState, after: Offset | null, live: boolean): ShapeResponse {
    const entries = after ? state.log.filter((entry) => isAfter(entry.offset, after)) : state.log;
    const offset = entries.length > 0 ? entries[entries.length - 1].offset : (after ?? state.baseOffset);
    const headers: Record<string, string> = {
      'electric-handle': state.handle,
      'electric-offset': formatOffset(offset),
      'electric-up-to-date': '',
    };
    if (live) headers['electric-cursor'] = String(Math.floor(Date.now() / 1000));
    else headers['electric-schema'] = JSON.stringify(state.schema);
    return {
      status: 200,
      headers,
      // up-to-date carries the position the log is caught up to.
      // The mock's positions are changelog sequence numbers.
      body: [
        ...entries.map((entry) => entry.message),
        { headers: { control: 'up-to-date', global_last_seen_lsn: String(state.lastSeq) } },
      ],
    };
  }

  private latestOffset(state: ShapeState): Offset {
    return state.log.length > 0 ? state.log[state.log.length - 1].offset : state.baseOffset;
  }

  private async getOrCreate(engine: DatabaseEngine, definitionKey: string, claims: ShapeClaims): Promise<ShapeState> {
    const existing = this.shapes.get(definitionKey);
    if (existing) return existing;

    const primaryKey = await this.installCapture(engine, claims.t);
    for (const table of claims.d ?? []) await this.installCapture(engine, table);
    if (primaryKey !== claims.k) {
      throw new Error(
        `Shape key "${claims.k}" is not the primary key of "${claims.t}" (found "${primaryKey}"). ` +
          `Pass \`key: '${primaryKey}'\` to db.shape().`,
      );
    }

    const schema = await this.readSchema(engine, claims.t, claims.c);
    const columns = claims.c ?? Object.keys(schema);

    // Read the changelog position before the rows: a write that lands between
    // the two reads is replayed by catch-up as an update, which is harmless.
    const [{ seq }] = await engine.query<{ seq: string | number }>(
      `SELECT COALESCE(MAX(seq), 0) AS seq FROM ${CHANGES_TABLE}`,
    );
    const baseSeq = Number(seq);
    // End the initial rows with the snapshot they were read at,
    // so clients can tell which transactions they include.
    const [{ snapshot }] = await engine.query<{ snapshot: string }>('SELECT pg_current_snapshot()::text AS snapshot');
    const rows = await this.selectRows(engine, claims, columns);

    const handle = `${createHash('sha256').update(definitionKey).digest('hex').slice(0, 12)}-${Date.now()}`;
    const state: ShapeState = {
      handle,
      definitionKey,
      claims,
      columns,
      schema,
      keys: new Set(),
      log: [],
      baseOffset: [baseSeq, 0],
      lastSeq: baseSeq,
      lock: Promise.resolve(),
    };
    rows.forEach((row, i) => {
      const key = String(row[claims.k]);
      state.keys.add(key);
      // Changes-only shapes start empty: rows arrive through snapshots and changes.
      if (claims.m === 'c') return;
      state.log.push({
        offset: [baseSeq, i],
        message: { key: this.messageKey(claims.t, key), value: row, headers: { operation: 'insert' } },
      });
    });
    const [xmin, xmax, xip] = snapshot.split(':');
    if (claims.m !== 'c') state.log.push({
      offset: [baseSeq, rows.length],
      message: {
        headers: { control: 'snapshot-end', xmin, xmax, xip_list: xip ? xip.split(',').filter(Boolean) : [] },
      },
    });
    this.shapes.set(definitionKey, state);
    this.byHandle.set(handle, state);
    return state;
  }

  /**
   * Fold changelog rows newer than `state.lastSeq` into the shape's log. A
   * change to a table the filter reads in a subquery (`claims.d`) can move any
   * row in or out, so it re-checks the whole shape.
   */
  private catchUp(engine: DatabaseEngine, state: ShapeState): Promise<void> {
    const run = state.lock.then(async () => {
      const tables = [state.claims.t, ...(state.claims.d ?? [])];
      const changes = await engine.query<{ seq: string | number; tbl: string; pk: string; txid: string | number }>(
        `SELECT seq, tbl, pk, txid FROM ${CHANGES_TABLE}
          WHERE tbl IN (SELECT jsonb_array_elements_text($1::jsonb)) AND seq > $2 ORDER BY seq`,
        [JSON.stringify(tables), state.lastSeq],
      );
      if (changes.length === 0) return;

      const seq = Number(changes[changes.length - 1].seq);
      const txids = [...new Set(changes.map((change) => Number(change.txid)))];
      const dependencyChanged = changes.some((change) => change.tbl !== state.claims.t);
      const changedKeys = dependencyChanged
        ? null
        : [...new Set(changes.filter((change) => change.tbl === state.claims.t).map((change) => change.pk))];
      const current = await this.selectRows(engine, state.claims, state.columns, changedKeys ?? undefined);
      const currentByKey = new Map(current.map((row) => [String(row[state.claims.k]), row]));
      const candidates = changedKeys ?? [...new Set([...state.keys, ...currentByKey.keys()])];
      const rootKeys = new Set(changes.filter((change) => change.tbl === state.claims.t).map((change) => change.pk));

      let minor = 0;
      for (const key of candidates) {
        const row = currentByKey.get(key);
        let message: Record<string, unknown> | null = null;
        if (row) {
          const wasIn = state.keys.has(key);
          // On a dependency change, rows already in the shape and not written themselves are unchanged.
          if (wasIn && !rootKeys.has(key) && changedKeys === null) continue;
          state.keys.add(key);
          message = {
            key: this.messageKey(state.claims.t, key),
            value: row,
            headers: { operation: wasIn ? 'update' : 'insert', txids, lsn: String(seq) },
          };
        } else if (state.keys.has(key)) {
          state.keys.delete(key);
          message = {
            key: this.messageKey(state.claims.t, key),
            value: { [state.claims.k]: key },
            headers: { operation: 'delete', txids, lsn: String(seq) },
          };
        }
        if (message) state.log.push({ offset: [seq, minor++], message });
      }
      state.lastSeq = seq;
    });
    state.lock = run.catch(() => {});
    return run;
  }

  /** Answer a snapshot request: `{ metadata, data }`, with the snapshot it was read at. */
  private async serveSubset(engine: DatabaseEngine, state: ShapeState, query: URLSearchParams): Promise<ShapeResponse> {
    const { claims } = state;
    let packed: unknown;
    try {
      packed = JSON.parse(query.get('subset__where') ?? '');
    } catch {
      packed = undefined;
    }
    const base = claims.p ?? [];
    const compiled = compileSnapshotQuery(packed, claims.q ?? claims.c ?? state.columns, undefined, base.length + 1, claims.k, quoteTable(claims.t));
    const filters = [claims.w ? `(${claims.w})` : '', compiled.where ?? ''].filter(Boolean);
    const select = state.columns.map((column) => `${quoteIdent(column)}::text AS ${quoteIdent(column)}`).join(', ');
    const sqlText =
      `SELECT ${select} FROM ${quoteTable(claims.t)}` +
      (filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '') +
      (compiled.orderBy ? ` ORDER BY ${compiled.orderBy}` : '') +
      (compiled.limit !== null ? ` LIMIT ${compiled.limit}` : '') +
      (compiled.offset !== null ? ` OFFSET ${compiled.offset}` : '');
    const [{ snapshot }] = await engine.query<{ snapshot: string }>('SELECT pg_current_snapshot()::text AS snapshot');
    const [{ seq }] = await engine.query<{ seq: string | number }>(`SELECT COALESCE(MAX(seq), 0) AS seq FROM ${CHANGES_TABLE}`);
    const rows = await engine.query<Record<string, string | null>>(sqlText, [...base, ...compiled.params]);
    const [xmin, xmax, xip] = snapshot.split(':');
    return {
      status: 200,
      headers: { 'electric-schema': JSON.stringify(state.schema) },
      body: {
        metadata: {
          snapshot_mark: Math.floor(Math.random() * 2 ** 31),
          database_lsn: String(seq),
          xmin,
          xmax,
          xip_list: xip ? xip.split(',').filter(Boolean) : [],
        },
        data: rows.map((row) => ({
          key: this.messageKey(claims.t, String(row[claims.k])),
          value: row,
          headers: { operation: 'insert' },
        })),
      },
    };
  }

  /** Rows of the shape as Postgres text values, optionally limited to `keys`. */
  private async selectRows(
    engine: DatabaseEngine,
    claims: ShapeClaims,
    columns: string[],
    keys?: string[],
  ): Promise<Record<string, string | null>[]> {
    const params: unknown[] = [...(claims.p ?? [])];
    const filters: string[] = [];
    if (claims.w) filters.push(`(${claims.w})`);
    if (keys) {
      params.push(JSON.stringify(keys));
      filters.push(`${quoteIdent(claims.k)}::text IN (SELECT jsonb_array_elements_text($${params.length}::jsonb))`);
    }
    const select = columns.map((column) => `${quoteIdent(column)}::text AS ${quoteIdent(column)}`).join(', ');
    const where = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
    return engine.query<Record<string, string | null>>(
      `SELECT ${select} FROM ${quoteTable(claims.t)}${where}`,
      params,
    );
  }

  private async readSchema(
    engine: DatabaseEngine,
    table: string,
    only: string[] | undefined,
  ): Promise<Record<string, ColumnInfo>> {
    const rows = await engine.query<{ name: string; typname: string; ndims: number; notnull: boolean }>(
      `SELECT a.attname AS name, t.typname, a.attndims AS ndims, a.attnotnull AS notnull
         FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
        WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [quoteTable(table)],
    );
    const schema: Record<string, ColumnInfo> = {};
    for (const row of rows) {
      if (only && !only.includes(row.name)) continue;
      const isArray = row.typname.startsWith('_');
      const info: ColumnInfo = { type: isArray ? row.typname.slice(1) : row.typname };
      if (isArray) info.dims = Math.max(Number(row.ndims), 1);
      if (row.notnull) info.not_null = true;
      schema[row.name] = info;
    }
    for (const column of only ?? []) {
      if (!(column in schema)) throw new Error(`Shape column "${column}" does not exist on "${table}".`);
    }
    return schema;
  }

  /** Install the changelog trigger on `table` once. Resolves to its primary-key column. */
  private installCapture(engine: DatabaseEngine, table: string): Promise<string> {
    let installed = this.installedTables.get(table);
    if (!installed) {
      installed = this.doInstallCapture(engine, table);
      this.installedTables.set(table, installed);
      installed.catch(() => this.installedTables.delete(table));
    }
    return installed;
  }

  private async doInstallCapture(engine: DatabaseEngine, table: string): Promise<string> {
    this.capturePrepared ??= (async () => {
      await engine.execute(
        `CREATE TABLE IF NOT EXISTS ${CHANGES_TABLE} (
           seq bigserial PRIMARY KEY,
           tbl text NOT NULL,
           pk text NOT NULL,
           txid bigint NOT NULL DEFAULT (pg_current_xact_id()::xid::text::bigint)
         )`,
      );
      await engine.execute(
        `CREATE OR REPLACE FUNCTION _blocks_sync_capture() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF TG_OP <> 'INSERT' THEN
             INSERT INTO ${CHANGES_TABLE} (tbl, pk) VALUES (TG_ARGV[0], to_jsonb(OLD) ->> TG_ARGV[1]);
           END IF;
           IF TG_OP <> 'DELETE' THEN
             INSERT INTO ${CHANGES_TABLE} (tbl, pk) VALUES (TG_ARGV[0], to_jsonb(NEW) ->> TG_ARGV[1]);
           END IF;
           RETURN NULL;
         END $$`,
      );
    })();
    try {
      await this.capturePrepared;
    } catch (error) {
      this.capturePrepared = null;
      throw error;
    }

    const keys = await engine.query<{ name: string }>(
      `SELECT a.attname AS name
         FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = to_regclass($1) AND i.indisprimary`,
      [quoteTable(table)],
    );
    if (keys.length !== 1) {
      throw new Error(
        `Table "${table}" must exist and have a single-column primary key to be synced ` +
          `(found ${keys.length} primary-key columns).`,
      );
    }
    const primaryKey = keys[0].name;
    const triggerName = quoteIdent(`_blocks_sync_${table.replace('.', '_')}`);
    // Table and key names are validated identifiers; quote_literal is not needed.
    await engine.execute(
      `CREATE OR REPLACE TRIGGER ${triggerName} AFTER INSERT OR UPDATE OR DELETE ON ${quoteTable(table)}
         FOR EACH ROW EXECUTE FUNCTION _blocks_sync_capture('${table}', '${primaryKey.replace(/'/g, "''")}')`,
    );
    return primaryKey;
  }

  private messageKey(table: string, key: string): string {
    const [schema, name] = defaultSchemaTable(table);
    return `${quoteIdent(schema)}.${quoteIdent(name)}/${quoteIdent(key)}`;
  }
}
