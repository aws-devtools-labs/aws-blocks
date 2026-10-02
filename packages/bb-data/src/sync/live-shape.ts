// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `Shape<T>` implementation for `Database`. Runs in the browser (hydrated
 * by the sync client middleware) and holds the local copy of a shape's rows.
 *
 * The transport is the Electric HTTP shape protocol, read with
 * `@electric-sql/client`'s `ShapeStream`. That dependency stays behind this
 * class: the public surface is AWS Blocks' own `Shape<T>`, and the local rows,
 * listeners, and readiness come from the shared `ShapeStore` in data-common,
 * which `DistributedDatabase` shapes use too.
 */

import { FetchError, ShapeStream, isChangeMessage, isControlMessage, isVisibleInSnapshot } from '@electric-sql/client';
import type { Message, PostgresSnapshot, Row } from '@electric-sql/client';
import { ShapeStore } from '@aws-blocks/data-common/sync-shared';
import { fieldToColumn, mapRow } from '@aws-blocks/data-common/sync-shared';
import type { ShapeTransport, SnapshotQuery, SyncHint } from '@aws-blocks/data-common/sync-shared';

/**
 * How long a write's API call waits for its transaction to show up in an open
 * shape. A write that changes no row of the shape never shows up there, so the
 * wait is bounded; the call then resolves anyway (the write did commit), and
 * the change, if any, arrives with the stream.
 */
export const SETTLE_TIMEOUT_MS = 1000;

/**
 * Commit LSN of each txid any shape on this page has seen (Electric puts the
 * transaction's commit LSN on its change messages). Shared by all shapes: once
 * one shape has seen a write, every other shape knows how far it must be
 * caught up to have it, or to know it isn't there.
 */
const LSNS_KEY: unique symbol = Symbol.for('aws-blocks.data.txid-lsns') as never;
const lsnGlobals = globalThis as { [LSNS_KEY]?: { lsns: Map<string, bigint>; shapes: Set<LiveShape<unknown>> } };
if (!lsnGlobals[LSNS_KEY]) lsnGlobals[LSNS_KEY] = { lsns: new Map(), shapes: new Set() };
const txidLsns = lsnGlobals[LSNS_KEY];
import { TOKEN_PARAM } from './shape-constants.js';
import { MoveTags } from './move-tags.js';
import type { MovePattern } from './move-tags.js';

export type { ShapeTransport } from '@aws-blocks/data-common/sync-shared';

/** Live `Shape<T>`. Starts syncing on the first `ready` or `subscribe()`. */
export class LiveShape<T> extends ShapeStore<T> {
  /** Evidence for read-your-writes: txids seen, and snapshots received. */
  /** Electric's move tags, for filters with subqueries (rows leave on `move-out` events). */
  private readonly moveTags = new MoveTags();
  private readonly seenTxids = new Set<string>();
  private readonly snapshots: PostgresSnapshot[] = [];
  /** Highest LSN this shape is known to be caught up to (change messages and `up-to-date`). */
  private lastLsn = -1n;
  private readonly settleWaiters = new Set<() => void>();
  private stream: ShapeStream<Row> | null = null;
  private refreshing: Promise<void> | null = null;
  private abort: AbortController | null = null;

  /**
   * @internal Wait until this shape has the transactions an API call made,
   * before the call resolves. A txid counts as synced when this shape saw it
   * in a change message or it is visible in a snapshot this shape received
   * or, once any shape on the page has
   * seen it at commit LSN L, when this shape is caught up to L (a write that
   * isn't in this shape). If needed, the shape refreshes once to learn how far
   * it is. Gives up after {@link SETTLE_TIMEOUT_MS}: no open shape had the write.
   */
  settle(hint: SyncHint): Promise<void> {
    const txids = hint.txids ?? [];
    if (txids.length === 0) return Promise.resolve();
    return Promise.all(txids.map((txid) => this.awaitTxid(txid))).then(() => {});
  }

  private hasTxid(txid: string): boolean {
    if (this.seenTxids.has(txid)) return true;
    if (this.snapshots.some((snapshot) => isVisibleInSnapshot(BigInt(txid), snapshot))) return true;
    const lsn = txidLsns.lsns.get(txid);
    return lsn !== undefined && this.lastLsn >= lsn;
  }

  private awaitTxid(txid: string): Promise<void> {
    if (this.hasTxid(txid)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const check = () => {
        if (this.hasTxid(txid)) return finish();
        // Another shape has seen the write, so its LSN is known: refresh once
        // to learn whether this shape is caught up past it.
        if (txidLsns.lsns.has(txid)) this.refresh();
      };
      const finish = () => {
        clearTimeout(timer);
        this.settleWaiters.delete(check);
        resolve();
      };
      const timer = setTimeout(finish, SETTLE_TIMEOUT_MS);
      this.settleWaiters.add(check);
      check();
    });
  }

  /**
   * Load a snapshot through the stream's own snapshot path, so its snapshot
   * tracker drops live changes the snapshot already includes. The query goes
   * to our shape endpoint as JSON (field names mapped to columns); the
   * endpoint compiles it to SQL: the client never sends SQL.
   */
  protected async loadSnapshot(query: SnapshotQuery<T>): Promise<readonly T[]> {
    await this.untilStream();
    const stream = this.stream;
    if (!stream) return [];
    const mapping = this.descriptor.columnMapping;
    const toColumns = (filter: unknown): unknown => {
      if (Array.isArray(filter)) return filter.map(toColumns);
      if (typeof filter !== 'object' || filter === null) return filter;
      const out: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(filter)) {
        out[field === 'or' ? field : fieldToColumn(field, mapping)] = field === 'or' ? toColumns(value) : value;
      }
      return out;
    };
    const packed = {
      ...query,
      where: query.where === undefined ? undefined : toColumns(query.where),
      orderBy: query.orderBy?.map((order) => ({ ...order, field: fieldToColumn(order.field, mapping) })),
    };
    const { data } = await stream.requestSnapshot({ where: JSON.stringify(packed) });
    return data.map((message) => mapRow(message.value as Record<string, unknown>, mapping) as T);
  }

  private streamReady: Array<() => void> = [];

  private untilStream(): Promise<void> {
    if (this.stream) return Promise.resolve();
    return new Promise((resolve) => this.streamReady.push(resolve));
  }

  /** One non-live request: Electric answers with `up-to-date` at its current LSN. */
  private refresh(): void {
    if (this.refreshing || !this.stream) return;
    this.refreshing = this.stream
      .forceDisconnectAndRefresh()
      .catch(() => {})
      .finally(() => {
        this.refreshing = null;
      });
  }

  /** Re-check every pending settle on every shape (new evidence arrived). */
  private static wake(): void {
    for (const shape of txidLsns.shapes) for (const check of [...shape.settleWaiters]) check();
  }

  protected stop(): void {
    txidLsns.shapes.delete(this as LiveShape<unknown>);
    this.abort?.abort();
    this.abort = null;
    this.stream = null;
  }

  protected run(transport: ShapeTransport): void {
    const abort = new AbortController();
    this.abort = abort;
    transport
      .resolveUrl(this.descriptor.path)
      .then((url) => {
        if (abort.signal.aborted) return;
        txidLsns.shapes.add(this as LiveShape<unknown>);
        const stream = new ShapeStream<Row>({
          url,
          signal: abort.signal,
          // Changes-only shapes start empty; rows load through requestSnapshot().
          log: this.descriptor.mode === 'changes_only' ? 'changes_only' : 'full',
          params: { [TOKEN_PARAM]: () => this.descriptor.token },
          onError: (error) => this.onStreamError(error),
        });
        this.stream = stream;
        for (const resolve of this.streamReady.splice(0)) resolve();
        stream.subscribe(
          (messages) => this.apply(messages),
          (error) => this.fail(error),
        );
      })
      .catch((error: unknown) => this.fail(error));
  }

  /** On 401/403 re-issue the shape once per failure, then retry with the new token. */
  private async onStreamError(error: Error): Promise<Record<string, never> | undefined> {
    const refresh = this.transport?.refresh;
    if (error instanceof FetchError && (error.status === 401 || error.status === 403) && refresh) {
      try {
        this.descriptor = await refresh();
        return {};
      } catch (refreshError) {
        this.fail(refreshError);
        return undefined;
      }
    }
    this.fail(error);
    return undefined;
  }

  private apply(messages: Message<Row>[]): void {
    let changed = false;
    let refetched = false;
    const keyColumn = this.descriptor.key;
    const mapping = this.descriptor.columnMapping;
    for (const message of messages) {
      if (isChangeMessage(message)) {
        const rowKey = String(message.value[keyColumn]);
        const operation = message.headers.operation;
        const value = mapRow(message.value as Record<string, unknown>, mapping);
        const headers = message.headers as { tags?: string[]; removed_tags?: string[]; active_conditions?: boolean[] };
        if (operation === 'delete') this.moveTags.forget(rowKey);
        else this.moveTags.change(rowKey, headers.tags, headers.removed_tags, headers.active_conditions);
        if (operation === 'delete') {
          changed = this.deleteRow(rowKey) || changed;
        } else if (operation === 'update') {
          const previous = this.getRow(rowKey);
          // Electric sends only changed columns (plus the key) on update.
          this.setRow(rowKey, { ...(previous ?? {}), ...value } as T);
          changed = true;
        } else {
          this.setRow(rowKey, value as T);
          changed = true;
        }
        const lsn = (message.headers as { lsn?: string }).lsn;
        if (lsn) this.seeLsn(BigInt(lsn));
        for (const txid of message.headers.txids ?? []) {
          this.seenTxids.add(String(txid));
          if (lsn) txidLsns.lsns.set(String(txid), BigInt(lsn));
        }
      } else if ('event' in message.headers) {
        // A subquery's result changed: rows whose tags no longer hold leave.
        const { event, patterns } = message.headers as { event: string; patterns?: MovePattern[] };
        if (event === 'move-out') {
          for (const key of this.moveTags.moveOut(patterns ?? [])) changed = this.deleteRow(key) || changed;
        } else if (event === 'move-in') {
          this.moveTags.moveIn(patterns ?? []);
        }
      } else if (isControlMessage(message)) {
        if (message.headers.control === 'must-refetch') {
          // The shape resyncs from scratch (e.g. after a schema change).
          this.moveTags.clear();
          this.clearRows();
          this.upToDate = false;
          changed = true;
          refetched = true;
        } else if (message.headers.control === 'up-to-date') {
          const lsn = (message.headers as { global_last_seen_lsn?: string }).global_last_seen_lsn;
          if (lsn) this.seeLsn(BigInt(lsn));
          this.markUpToDate();
        } else if (message.headers.control === 'snapshot-end') {
          const { xmin, xmax, xip_list } = message.headers;
          this.snapshots.push({ xmin, xmax, xip_list });
        }
      }
    }
    if (changed) this.publish();
    LiveShape.wake();
    // A changes-only shape loads its rows again after a resync.
    if (refetched && this.snapshotQueries.length > 0) void this.replaySnapshots().catch(() => {});
  }

  private seeLsn(lsn: bigint): void {
    if (lsn > this.lastLsn) this.lastLsn = lsn;
  }
}
