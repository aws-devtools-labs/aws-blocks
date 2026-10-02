// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Public types of `db.shape()`, shared by every SQL Building Block that can
 * sync (`Database`, `DistributedDatabase`).
 */
import type { SqlQuery } from '../sql.js';

/**
 * Options for `db.shape()`. A shape is a table, an optional row filter, and an
 * optional column list. The server fixes all three when it issues the shape;
 * the client cannot change them.
 */
export interface ShapeOptions<T> {
  /** The table to stream. Must be listed in `sync.tables`. */
  table: string;
  /**
   * Row filter, written with the `sql` tag. Values become bound parameters, so
   * user input is never concatenated into the filter.
   *
   * @example sql`owner_id = ${user.userId} AND done = ${false}`
   */
  where?: SqlQuery;
  /** Columns to stream. Must include `key`. Defaults to all columns. */
  columns?: (keyof T & string)[];
  /**
   * The table's primary-key column. `Shape.get()` looks rows up by this column.
   * @default 'id'
   */
  key?: keyof T & string;
  /**
   * How long the client may use this shape before it must ask the server for a
   * new one. The client refreshes automatically by calling the same API method
   * again, which re-runs your authorization check.
   * @default 3600
   */
  ttlSeconds?: number;
  /**
   * `'full'` (the default) syncs every row that matches `where`. `'changes_only'`
   * starts empty and syncs only rows you load with {@link Shape.requestSnapshot}
   * (pagination, search, "load more"), plus every change to the shape from then
   * on. Use it when the shape is too large to sync whole.
   * @default 'full'
   */
  mode?: 'full' | 'changes_only';
  /**
   * Columns the client may filter and sort on in {@link Shape.requestSnapshot}.
   * A snapshot query is always combined with `where`, so it can never read
   * rows outside the shape. Defaults to the shape's columns. The key is always
   * queryable.
   */
  queryableColumns?: (keyof T & string)[];
  /**
   * Map column names to field names in rows: `'snakeCamel'` turns `owner_id`
   * into `ownerId`. `columns`, `key`, `queryableColumns`, and snapshot queries
   * then use the field names too. `where` stays SQL, with column names.
   */
  columnMapping?: 'snakeCamel';
}

/**
 * A condition on one field in a {@link SnapshotQuery}: a value (equality) or
 * an operator. Values are bound parameters.
 */
export type FieldCondition<V> =
  | V
  | {
      eq?: V;
      ne?: V;
      lt?: V;
      lte?: V;
      gt?: V;
      gte?: V;
      in?: readonly V[];
      like?: string;
      ilike?: string;
      isNull?: boolean;
    };

/** Conditions on fields, all of which must hold (AND). `or` holds if any of its filters does. */
export type SnapshotFilter<T> = { [K in keyof T]?: FieldCondition<T[K]> } & { or?: readonly SnapshotFilter<T>[] };

/** Sort order of a {@link SnapshotQuery}. */
export interface SnapshotOrder<T> {
  field: keyof T & string;
  direction?: 'asc' | 'desc';
  nulls?: 'first' | 'last';
}

/**
 * Which rows of a `'changes_only'` shape to load. Combined with the shape's own
 * `where`. Fields must be in the shape's `queryableColumns`.
 *
 * @example
 * await shape.requestSnapshot({ where: { done: false, title: { ilike: '%milk%' } }, orderBy: [{ field: 'position', direction: 'desc' }], limit: 50 });
 */
export interface SnapshotQuery<T> {
  where?: SnapshotFilter<T>;
  orderBy?: readonly SnapshotOrder<T>[];
  /** At most 10,000. */
  limit?: number;
  offset?: number;
}

/**
 * Wire form of a {@link Shape}. Produced by `Shape.toJSON()` when an API
 * method returns a shape, and hydrated back into a live `Shape` on the client.
 */
export interface ShapeDescriptor {
  __blocks: 'data/shape';
  /** Path of the shape endpoint, relative to the backend origin. */
  path: string;
  /** Signed, expiring token that fixes the table, filter, and columns. */
  token: string;
  /** Primary-key column name. */
  key: string;
  /** The shape's table, so the client knows which writes concern it. */
  table?: string;
  /** Token expiry, in epoch milliseconds. */
  expiresAt: number;
  /** `'changes_only'` shapes start empty; see `ShapeOptions.mode`. Omitted for `'full'`. */
  mode?: 'changes_only';
  /** Column-to-field mapping of rows; see `ShapeOptions.columnMapping`. */
  columnMapping?: 'snakeCamel';
  /**
   * Bells of tables the filter reads besides `table` (subqueries), so the
   * shape syncs when one of them changes. `'reconcile'` shapes only.
   */
  dependencyBells?: ShapeBell[];
  /**
   * Sync protocol the shape endpoint speaks. Omitted for `Database` shapes
   * (the HTTP shape protocol of its sync service); `'reconcile'` for `DistributedDatabase`
   * shapes.
   */
  protocol?: 'electric' | 'reconcile';
  /**
   * Change notifications for `'reconcile'` shapes: the client reconciles when a
   * message arrives on this channel. Omitted when the backend has no channel;
   * the client then reconciles on a timer.
   */
  bell?: ShapeBell;
}

/**
 * A subscribe-only WebSocket channel that tells a `'reconcile'` shape that its
 * table changed. Carries no row data.
 */
export interface ShapeBell {
  /** WebSocket endpoint. */
  wsUrl: string;
  /** Token presented when the socket connects. */
  connectToken: string;
  /** Channel name. */
  channel: string;
  /** Token that authorizes the subscription to `channel`. */
  token: string;
}

/**
 * A live, local copy of the rows that match a shape.
 *
 * Return a shape from an `ApiNamespace` method; the client receives a hydrated
 * `Shape` that syncs in the background. Reads (`rows`, `get()`) are local and
 * synchronous: they never wait on the network.
 *
 * Your own writes are in the shape when the API call that made them returns:
 * after `await api.addTodo('Buy milk')`, `todos.rows` contains the new row. The
 * client syncs the written rows into open shapes before the call resolves
 * (for `Database`, it waits up to a second for the sync service).
 *
 * Row values arrive in their Postgres text form and are parsed for common
 * types: `int2`/`int4`/`float4`/`float8` → `number`, `int8` → `bigint`,
 * `bool` → `boolean`, `json`/`jsonb` → parsed JSON. Other types (`numeric`,
 * `timestamptz`, `uuid`, …) arrive as `string`. Declare `T` to match.
 *
 * @example
 * // Backend
 * async todos() {
 *   const user = await auth.requireAuth(context);
 *   return db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${user.userId}` });
 * }
 *
 * // Frontend
 * const todos = await api.todos();
 * await todos.ready;
 * todos.subscribe((rows) => render(rows));
 * const one = todos.get('todo-1'); // local lookup, no network
 * await api.addTodo('Buy milk');    // resolves once `todos.rows` has the row
 */
export interface Shape<T> {
  /** Current rows. Replaced (not mutated) on every change. */
  readonly rows: readonly T[];
  /** Look up a row by primary key. Local and synchronous. */
  get(key: string | number | bigint): T | undefined;
  /** Resolves once the initial rows have arrived. Starts syncing if needed. */
  readonly ready: Promise<void>;
  /** `true` once the local copy has caught up with the server. */
  readonly isUpToDate: boolean;
  /**
   * Call `listener` after every change. Starts syncing if needed. Returns an
   * unsubscribe function. Compatible with React's `useSyncExternalStore`
   * together with {@link Shape.getSnapshot}.
   */
  subscribe(listener: (rows: readonly T[]) => void): () => void;
  /** The current `rows` array. Stable between changes. */
  getSnapshot(): readonly T[];
  /**
   * Load rows into a `'changes_only'` shape: the rows of the shape that match
   * `query`, sorted and limited as asked. They join the local copy and stay
   * live. Resolves with the loaded rows, in order. Throws in `'full'` mode
   * (the shape already has every row). Loaded queries are replayed when the
   * shape has to resync (for example after a schema change).
   */
  requestSnapshot(query: SnapshotQuery<T>): Promise<readonly T[]>;
  /** Stop syncing and release the connection. */
  close(): void;
  /** Transferable serialization. Called automatically by `JSON.stringify`. */
  toJSON(): ShapeDescriptor;
}

/** Name of the RPC response hint that carries {@link SyncHint}s. */
export const SYNC_HINT = 'data/sync';

/**
 * @internal What an API call wrote, sent with its response (an RPC response
 * hint) so the client can sync open shapes before the call resolves: after
 * `await api.addTodo(...)`, `shape.rows` already has the new row.
 */
export interface SyncHint {
  /** Shape endpoint path of the database that wrote (`shapePath()`). */
  path: string;
  /** Tables written. Omitted when unknown: every shape of the database is concerned. */
  tables?: string[];
  /** `Database`: ids of the transactions that wrote. */
  txids?: string[];
  /** `DistributedDatabase`: sealed key lists of the written rows, one per table. */
  keys?: string[];
  /** `DistributedDatabase`: some writes could not be tracked; do a full reconcile. */
  full?: true;
}
