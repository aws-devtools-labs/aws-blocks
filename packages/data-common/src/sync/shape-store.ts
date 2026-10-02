// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The engine-agnostic half of a client `Shape<T>`: the local rows, change
 * listeners, and readiness. Each sync protocol subclasses it and only decides
 * how rows reach the store (a shape log for `Database`, digest
 * reconciliation for `DistributedDatabase`).
 *
 * Browser-safe: no Node imports.
 */

import type { Shape, ShapeDescriptor, SnapshotQuery, SyncHint } from './types.js';

// Started, not yet closed shapes, so response hints can reach them. One set per
// page, even if two copies of this module are bundled.
const LIVE_KEY: unique symbol = Symbol.for('aws-blocks.data.live-shapes') as never;
const liveGlobals = globalThis as { [LIVE_KEY]?: Set<ShapeStore<unknown>> };

/** @internal Shapes that are syncing. */
export function liveShapes(): Set<ShapeStore<unknown>> {
  if (!liveGlobals[LIVE_KEY]) liveGlobals[LIVE_KEY] = new Set();
  return liveGlobals[LIVE_KEY];
}

/** How a hydrated shape reaches its endpoint and renews its token. */
export interface ShapeTransport {
  /** Absolute URL of the shape endpoint for `path`. */
  resolveUrl(path: string): Promise<string>;
  /** Re-issue the shape (a fresh token) by calling the originating API method again. */
  refresh?: () => Promise<ShapeDescriptor>;
}

/** Base class of the live `Shape<T>`. Starts syncing on the first `ready`, `subscribe()`, or `waitForTxid()`. */
export abstract class ShapeStore<T> implements Shape<T> {
  protected descriptor: ShapeDescriptor;
  protected readonly transport: ShapeTransport | undefined;
  protected upToDate = false;
  /** Rows by primary key (as a string). Change it only through {@link setRow} / {@link deleteRow} / {@link clearRows}. */
  private readonly byKey = new Map<string, T>();
  /**
   * The published `rows` array. A change makes a new array (rows are replaced,
   * not mutated), but the copy is built lazily and incrementally: updates and
   * inserts patch a copy of the previous array by position, so a change costs
   * one array copy plus O(changed rows), not a rebuild from the map. Only a
   * delete rebuilds. A read never waits on more than that.
   */
  private snapshot: readonly T[] = [];
  /** Position of each key in `snapshot`; built on demand after a rebuild. */
  private positions: Map<string, number> | null = new Map();
  /** Rows set since `snapshot` was built (only while there was no delete). */
  private readonly pending = new Map<string, T>();
  /** A delete or clear happened since `snapshot` was built: rebuild from the map. */
  private rebuild = false;
  private dirty = false;
  private readonly listeners = new Set<(rows: readonly T[]) => void>();
  private started = false;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;

  constructor(descriptor: ShapeDescriptor, transport?: ShapeTransport) {
    this.descriptor = descriptor;
    this.transport = transport;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // `ready` may never be awaited; don't surface its rejection as unhandled.
    this.readyPromise.catch(() => {});
  }

  get rows(): readonly T[] {
    return this.currentSnapshot();
  }

  get isUpToDate(): boolean {
    return this.upToDate;
  }

  get ready(): Promise<void> {
    this.start();
    return this.readyPromise;
  }

  get(key: string | number | bigint): T | undefined {
    return this.byKey.get(String(key));
  }

  // Arrow properties, so `subscribe` / `getSnapshot` can be passed unbound
  // (e.g. `useSyncExternalStore(shape.subscribe, shape.getSnapshot)`).
  subscribe = (listener: (rows: readonly T[]) => void): (() => void) => {
    this.listeners.add(listener);
    this.start();
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): readonly T[] => this.currentSnapshot();

  /**
   * Load rows into a `'changes_only'` shape (see `Shape.requestSnapshot`).
   * Remembers the query, so it is replayed when the shape resyncs.
   */
  requestSnapshot(query: SnapshotQuery<T>): Promise<readonly T[]> {
    if (this.descriptor.mode !== 'changes_only') {
      return Promise.reject(
        new Error("requestSnapshot() needs a 'changes_only' shape: pass `mode: 'changes_only'` to db.shape()."),
      );
    }
    this.start();
    if (!this.transport) return this.ready.then(() => []);
    this.snapshotQueries.push(query as SnapshotQuery<unknown>);
    return this.loadSnapshot(query);
  }

  /** Queries loaded with {@link requestSnapshot}, in order. */
  protected readonly snapshotQueries: SnapshotQuery<unknown>[] = [];

  /** Fetch and apply one snapshot. Rows join the local copy and stay live. */
  protected abstract loadSnapshot(query: SnapshotQuery<T>): Promise<readonly T[]>;

  /** Load every remembered snapshot query again (after a reset). */
  protected async replaySnapshots(): Promise<void> {
    for (const query of [...this.snapshotQueries]) await this.loadSnapshot(query as SnapshotQuery<T>);
  }

  /**
   * @internal Bring the rows a write changed into this shape, before the API
   * call that made the write resolves. Called by the shape middleware with the
   * call's {@link SyncHint}; only for shapes on the written database and table.
   */
  abstract settle(hint: SyncHint): Promise<void>;

  /** @internal Whether a hint concerns this shape (same database, and a written table or unknown tables). */
  concerns(hint: SyncHint): boolean {
    if (hint.path !== this.descriptor.path) return false;
    if (!hint.tables || !this.descriptor.table) return true;
    return hint.tables.includes(this.descriptor.table);
  }

  close(): void {
    liveShapes().delete(this as ShapeStore<unknown>);
    this.stop();
    this.listeners.clear();
  }

  toJSON(): ShapeDescriptor {
    return this.descriptor;
  }

  /** Begin syncing. Called once, on first use, when the shape has a transport. */
  protected abstract run(transport: ShapeTransport): void;

  /** Stop syncing and release network resources. */
  protected abstract stop(): void;

  /** The row with this key, if held. */
  protected getRow(key: string): T | undefined {
    return this.byKey.get(key);
  }

  /** Insert or replace a row. Call {@link publish} when a batch of changes is done. */
  protected setRow(key: string, row: T): void {
    this.byKey.set(key, row);
    if (!this.rebuild) this.pending.set(key, row);
    this.dirty = true;
  }

  /**
   * Insert or replace many rows at once (e.g. a full load). A batch large
   * compared to the published rows skips per-row patch bookkeeping: the next
   * read rebuilds the array instead.
   */
  protected setRows(rows: readonly (readonly [string, T])[]): void {
    if (rows.length === 0) return;
    if (!this.rebuild && rows.length * 4 > this.snapshot.length) {
      this.rebuild = true;
      this.pending.clear();
    }
    for (const [key, row] of rows) {
      this.byKey.set(key, row);
      if (!this.rebuild) this.pending.set(key, row);
    }
    this.dirty = true;
  }

  /** Remove a row. Returns whether it was held. */
  protected deleteRow(key: string): boolean {
    if (!this.byKey.delete(key)) return false;
    this.rebuild = true;
    this.pending.clear();
    this.dirty = true;
    return true;
  }

  /** Remove every row. */
  protected clearRows(): void {
    if (this.byKey.size === 0) return;
    this.byKey.clear();
    this.rebuild = true;
    this.pending.clear();
    this.dirty = true;
  }

  /** Every held key. */
  protected keys(): IterableIterator<string> {
    return this.byKey.keys();
  }

  /** Notify listeners if rows changed since the last call. */
  protected publish(): void {
    if (!this.dirty) return;
    if (this.listeners.size === 0) return; // built lazily on the next read
    const rows = this.currentSnapshot();
    for (const listener of [...this.listeners]) listener(rows);
  }

  private currentSnapshot(): readonly T[] {
    if (!this.dirty) return this.snapshot;
    // A rebuild is also cheaper than patching when the batch is large compared
    // to the rows already published (e.g. the initial load).
    if (this.rebuild || this.pending.size * 4 > this.snapshot.length) {
      this.snapshot = Array.from(this.byKey.values());
      this.positions = null;
    } else {
      const next = this.snapshot.slice();
      // Without deletes, the map's order is the snapshot's order followed by
      // the new keys, so positions can be rebuilt from it.
      if (!this.positions) {
        const positions = new Map<string, number>();
        let i = 0;
        for (const key of this.byKey.keys()) {
          if (i >= this.snapshot.length) break;
          positions.set(key, i++);
        }
        this.positions = positions;
      }
      for (const [key, row] of this.pending) {
        const at = this.positions.get(key);
        if (at === undefined) {
          this.positions.set(key, next.length);
          next.push(row);
        } else {
          next[at] = row;
        }
      }
      this.snapshot = next;
    }
    this.pending.clear();
    this.rebuild = false;
    this.dirty = false;
    return this.snapshot;
  }

  /** Mark the shape up to date and resolve `ready`. */
  protected markUpToDate(): void {
    this.upToDate = true;
    this.resolveReady();
  }

  /** Reject `ready` (no-op once it has resolved). */
  protected fail(error: unknown): void {
    this.rejectReady(error instanceof Error ? error : new Error(String(error)));
  }

  /** Start syncing on first use. */
  protected start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.transport) {
      this.fail(
        new Error(
          'This Shape is a server-side handle. Return it from an ApiNamespace method; ' +
            'the client receives a live copy that syncs.',
        ),
      );
      return;
    }
    liveShapes().add(this as ShapeStore<unknown>);
    this.run(this.transport);
  }
}

/**
 * The server-side `Shape<T>`: what `db.shape()` returns inside an API method.
 * It only serializes; `ready` rejects with a hint to return it to the client.
 */
export class ServerShape<T> extends ShapeStore<T> {
  settle(_hint: SyncHint): Promise<void> {
    return Promise.resolve();
  }

  protected loadSnapshot(): Promise<readonly T[]> {
    return Promise.resolve([]);
  }

  protected run(): void {}

  protected stop(): void {}
}
