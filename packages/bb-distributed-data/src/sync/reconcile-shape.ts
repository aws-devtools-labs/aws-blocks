// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `Shape<T>` implementation for `DistributedDatabase`. Runs in the browser
 * (hydrated by the sync client middleware).
 *
 * Sync is reconciliation, not a change log: the shape sends the digest of
 * every bucket it holds, and the server answers with the buckets that differ
 * (see `protocol.ts`). It reconciles:
 *
 * - once on start (the initial load: an empty digest gets every bucket),
 * - when its bell rings (Aurora DSQL CDC saw a change to the table). A bell
 *   usually carries the changed keys (sealed by the server): the shape then
 *   reads only those rows, plus the keys it holds in buckets where a row may
 *   have left, instead of the whole shape,
 * - when the bell socket reconnects (rings may have been missed),
 * - after an API call that wrote to its table, before the call resolves: the
 *   call's response carries the written keys (a sync hint), and Aurora DSQL
 *   reads are strongly consistent, so reading them sees the write. No need to
 *   wait for CDC,
 * - when a bell of a table its filter reads in a subquery rings (full check),
 * - and on a timer, as a safety net (every 5 minutes; every 3 seconds when
 *   there is no bell).
 *
 * A `'changes_only'` shape starts empty and never does a full reconcile: it
 * loads rows with `requestSnapshot()`, takes every keyed change to the shape,
 * and where a full reconcile would run it re-checks the rows it holds and
 * replays its snapshot queries. A schema change (new schema version from the
 * server) drops the local rows and loads them again.
 *
 * The local rows, listeners, and readiness come from the shared `ShapeStore`.
 */

import { ShapeStore, TOKEN_PARAM, fieldToColumn, mapRow } from '@aws-blocks/data-common/sync-shared';
import type { ShapeBell, ShapeTransport, SnapshotQuery, SyncHint } from '@aws-blocks/data-common/sync-shared';
import { subscribeBell } from './bell.js';
import { MAX_REQUEST_KEYS, NDJSON, bucketDigest } from './protocol.js';
import type { ReconcileRequest, ReconcileResponse, RowHash, TextRow } from './protocol.js';

const SAFETY_INTERVAL_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 3_000;
const MAX_ATTEMPTS = 3;
/** Large diffs are applied in slices, yielding between them, so local reads never wait long. */
const APPLY_SLICE = 300;

/**
 * Let other tasks (input, reads, rendering) run. `scheduler.yield()` where the
 * browser has it; otherwise a MessageChannel hop, which, unlike `setTimeout(0)`,
 * is not clamped to 4 ms when nested.
 */
function yieldToMainThread(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === 'function') return scheduler.yield();
  if (typeof MessageChannel !== 'undefined') {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Parse a Postgres array literal of a one-dimensional array: `{a,"b c",NULL}`. */
function parseArray(text: string, element: (value: string) => unknown): unknown[] | string {
  if (!text.startsWith('{') || !text.endsWith('}')) return text;
  const body = text.slice(1, -1);
  const items: unknown[] = [];
  if (body.length === 0) return items;
  let i = 0;
  while (i <= body.length) {
    if (body[i] === '"') {
      let value = '';
      i++;
      while (i < body.length && body[i] !== '"') {
        if (body[i] === '\\') i++;
        value += body[i++];
      }
      items.push(element(value));
      i += 2; // closing quote and comma
    } else {
      const end = body.indexOf(',', i);
      const raw = end === -1 ? body.slice(i) : body.slice(i, end);
      if (raw.startsWith('{')) return text; // multi-dimensional: leave as text
      items.push(raw === 'NULL' ? null : element(raw));
      i = end === -1 ? body.length + 1 : end + 1;
    }
  }
  return items;
}

/** Parse one Postgres text value by type, the same way `Database` shapes do. */
export function parseValue(text: string | null, type: string): unknown {
  if (text === null) return null;
  if (type.startsWith('_')) {
    const elementType = type.slice(1);
    return parseArray(text, (value) => parseValue(value, elementType));
  }
  switch (type) {
    case 'int2':
    case 'int4':
    case 'float4':
    case 'float8':
      return Number(text);
    case 'int8':
      return BigInt(text);
    case 'bool':
      return text === 't' || text === 'true';
    case 'json':
    case 'jsonb':
      return JSON.parse(text);
    default:
      return text;
  }
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** One queued sync: a full check, the sealed keys of a bell (`changed`), or of a write (`written`). */
interface QueuedSync {
  changed?: string;
  written?: string[];
  resolve: () => void;
  reject: (error: Error) => void;
}

/** Live `Shape<T>` for `DistributedDatabase`. Starts syncing on the first `ready` or `subscribe()`. */
export class ReconcileShape<T> extends ShapeStore<T> {
  /** bucket → key → row hash, for the rows held locally. */
  private readonly buckets = new Map<number, Map<string, RowHash>>();
  /**
   * Digest of every non-empty bucket, kept up to date for the buckets that
   * change, so a request costs O(changed buckets), not O(rows): the main thread
   * (and so a local read) never waits on a full rehash.
   */
  private readonly digests = new Map<number, string>();
  private url: string | null = null;
  private stopped = false;
  private running: Promise<void> | null = null;
  private readonly queued: QueuedSync[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly unsubscribeBells = new Map<string, () => void>();
  /** Set once the first full load (or, changes-only, the first check) has completed. */
  private loaded = false;
  /** Schema version of the rows held; a different one from the server resets the shape. */
  private version: string | null = null;

  private get changesOnly(): boolean {
    return this.descriptor.mode === 'changes_only';
  }

  /**
   * @internal Read an API call's own writes into this shape before the call
   * resolves. Aurora DSQL reads are strongly consistent, so reading the written
   * keys now sees the write; untracked writes get a full check.
   */
  settle(hint: SyncHint): Promise<void> {
    if (!this.transport) return Promise.resolve();
    if (hint.full || !hint.keys || hint.keys.length === 0) return this.sync();
    return this.sync({ written: hint.keys });
  }

  protected run(): void {
    // Subscribe first and load once the bells are confirmed: a write between
    // the load and the subscription would otherwise ring unheard.
    this.watch()
      .then(() => this.sync())
      .then(
        () => this.markUpToDate(),
        (error: unknown) => this.fail(error),
      );
  }

  protected stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    for (const unsubscribe of this.unsubscribeBells.values()) unsubscribe();
    this.unsubscribeBells.clear();
    for (const waiter of this.queued.splice(0)) waiter.resolve();
  }

  /**
   * Load a snapshot: the shape's rows that match `query` (compiled on the
   * server, combined with the shape's filter). The rows join the local copy.
   */
  protected async loadSnapshot(query: SnapshotQuery<T>): Promise<readonly T[]> {
    await this.ready;
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
    const snapshot = {
      ...query,
      where: query.where === undefined ? undefined : toColumns(query.where),
      orderBy: query.orderBy?.map((order) => ({ ...order, field: fieldToColumn(order.field, mapping) })),
    };
    const answer = await this.request({ snapshot }, false);
    if (this.checkVersion(answer.v)) return this.loadSnapshot(query);
    this.applyRows(answer);
    this.publish();
    return (answer.rows ?? []).map(([, , row]) => this.parseRow(row, answer.schema) as T);
  }

  /** (Re)subscribe to the bells of the current descriptor, and set the safety timer. Resolves when new bells are confirmed. */
  private watch(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const confirmations: Promise<void>[] = [];
    const bells = [this.descriptor.bell, ...(this.descriptor.dependencyBells ?? [])].filter(
      (bell): bell is ShapeBell => bell !== undefined,
    );
    const wanted = new Set(bells.map((bell) => `${bell.channel}\u0000${bell.token}`));
    for (const [id, unsubscribe] of this.unsubscribeBells) {
      if (!wanted.has(id)) {
        unsubscribe();
        this.unsubscribeBells.delete(id);
      }
    }
    for (const bell of bells) {
      const id = `${bell.channel}\u0000${bell.token}`;
      if (this.unsubscribeBells.has(id)) continue;
      const subscription = subscribeBell(bell, {
        // Keys sealed for another table (a subquery's table) can't be read for
        // this shape: the server answers `full`, and the shape re-checks.
        onRing: (message) => {
          const sealed = (message as { k?: unknown } | null)?.k;
          this.background(typeof sealed === 'string' ? { changed: sealed } : {});
        },
        onReconnect: () => this.background({}),
        onReject: () => {
          // The channel token expired or was refused: fall back to polling
          // until a refreshed shape brings new bell tokens.
          this.unsubscribeBells.get(id)?.();
          this.unsubscribeBells.delete(id);
          this.setTimer(POLL_INTERVAL_MS);
        },
      });
      if (subscription) {
        this.unsubscribeBells.set(id, subscription.unsubscribe);
        confirmations.push(subscription.confirmed);
      }
    }
    this.setTimer(this.unsubscribeBells.size > 0 ? SAFETY_INTERVAL_MS : POLL_INTERVAL_MS);
    return Promise.all(confirmations).then(() => {});
  }

  private setTimer(interval: number): void {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.background({}), interval);
    // Don't keep a Node process (tests, SSR) alive for the safety net.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private background(what: Pick<QueuedSync, 'changed' | 'written'>): void {
    this.sync(what).catch(() => {
      // A failed background pass leaves the local rows as they were; the next
      // ring or timer tick tries again.
    });
  }

  /**
   * Run a sync that starts after this call: of sealed keys (from a bell or a
   * write), or a full check when none are given. Concurrent calls share the
   * next pass; a full check in a pass covers every key in it.
   */
  private sync(what: Pick<QueuedSync, 'changed' | 'written'> = {}): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.queued.push({ ...what, resolve, reject });
      this.running ??= this.drive();
    });
  }

  private async drive(): Promise<void> {
    while (this.queued.length > 0 && !this.stopped) {
      const batch = this.queued.splice(0);
      const full = batch.some((entry) => entry.changed === undefined && entry.written === undefined);
      const changed = batch.flatMap((entry) => (entry.changed === undefined ? [] : [entry.changed]));
      const written = batch.flatMap((entry) => entry.written ?? []);
      try {
        // Key-level syncs patch a loaded copy; until the first load, do that.
        if (full || !this.loaded) await this.checkAll();
        else await this.syncKeys(changed, written);
        for (const waiter of batch) waiter.resolve();
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        for (const waiter of batch) waiter.reject(failure);
      }
    }
    this.running = null;
  }

  /** A full check: a full reconcile, or, for a changes-only shape, a re-check of its rows and snapshots. */
  private async checkAll(): Promise<void> {
    if (this.changesOnly) {
      if (this.loaded) {
        await this.recheckHeld();
        await this.replaySnapshots();
      }
      this.loaded = true;
      return;
    }
    await this.reconcileAll();
  }

  /**
   * Full reconcile: send every bucket digest; replace the buckets that differ.
   * Reads the whole shape on the server. The answer is NDJSON, parsed one
   * bucket at a time, and may come in pages (`more`).
   */
  private async reconcileAll(): Promise<void> {
    for (;;) {
      const digest: NonNullable<ReconcileRequest['digest']> = {};
      for (const [bucket, value] of this.digests) digest[String(bucket)] = value;
      const text = await this.request({ digest }, true);
      const more = await this.applyBuckets(text);
      if (more === 'reset') continue;
      if (!more) {
        this.loaded = true;
        return;
      }
    }
  }

  /** Re-check every held row (changes-only shapes): updates, deletes, and moves out. */
  private async recheckHeld(): Promise<void> {
    const keys = [...this.keys()];
    for (let i = 0; i < keys.length; i += MAX_REQUEST_KEYS) {
      const held = keys.slice(i, i + MAX_REQUEST_KEYS);
      const current = await this.request({ held }, false);
      if (this.checkVersion(current.v)) return;
      let dirty = this.applyRows(current);
      const present = new Set((current.rows ?? []).map(([, , row]) => this.keyOf(row, current.schema)));
      for (const key of held) if (!present.has(key)) dirty = this.removeRow(key) || dirty;
      if (dirty) this.publish();
    }
  }

  /** Key-level sync for bells and writes: read only those keys, then recheck the buckets where a row may have left. */
  private async syncKeys(sealedChanged: string[], sealedWritten: string[]): Promise<void> {
    const body: ReconcileRequest = {};
    if (sealedChanged.length > 0) body.changed = sealedChanged;
    if (sealedWritten.length > 0) body.written = sealedWritten;
    const changed = await this.request(body, false);
    if (this.checkVersion(changed.v)) return this.checkAll();
    if (changed.full) return this.checkAll();
    let dirty = this.applyRows(changed);
    const held: string[] = [];
    for (const bucket of changed.recheck ?? []) {
      for (const key of this.buckets.get(bucket)?.keys() ?? []) held.push(key);
    }
    if (held.length > 0) {
      const current = await this.request({ held }, false);
      dirty = this.applyRows(current) || dirty;
      const present = new Set((current.rows ?? []).map(([, , row]) => this.keyOf(row, current.schema)));
      for (const key of held) if (!present.has(key)) dirty = this.removeRow(key) || dirty;
    }
    if (dirty) this.publish();
  }

  /**
   * A schema version different from the rows held (a migration changed the
   * table): drop every row, so the next load brings rows in the new form.
   * Returns whether it reset.
   */
  private checkVersion(v: string | undefined): boolean {
    if (!v || this.version === v) return false;
    const reset = this.version !== null;
    this.version = v;
    if (!reset) return false;
    this.buckets.clear();
    this.digests.clear();
    this.clearRows();
    this.publish();
    if (this.changesOnly) void this.replaySnapshots().catch(() => {});
    return true;
  }

  private request(body: ReconcileRequest, lines: true): Promise<string>;
  private request(body: ReconcileRequest, lines: false): Promise<ReconcileResponse>;
  private async request(body: ReconcileRequest, lines: boolean): Promise<ReconcileResponse | string> {
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.post(body, lines);
      } catch (error) {
        const refresh = this.transport?.refresh;
        if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
          if (!refresh || refreshed) throw error;
          refreshed = true;
          this.descriptor = await refresh();
          void this.watch();
          continue;
        }
        if (error instanceof HttpError && error.status < 500) throw error;
        if (attempt >= MAX_ATTEMPTS || this.stopped) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
      }
    }
  }

  private async post(body: ReconcileRequest, lines: boolean): Promise<ReconcileResponse | string> {
    const transport = this.transport as ShapeTransport;
    this.url ??= await transport.resolveUrl(this.descriptor.path);
    const url = new URL(this.url);
    url.searchParams.set(TOKEN_PARAM, this.descriptor.token);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      let message = `Shape request failed with status ${response.status}`;
      try {
        const error = (await response.json()) as { error?: string };
        if (error.error) message = error.error;
      } catch {}
      throw new HttpError(message, response.status);
    }
    if (lines) {
      if (!(response.headers.get('content-type') ?? '').includes(NDJSON)) throw new HttpError('Expected an NDJSON shape response', 502);
      return response.text();
    }
    return (await response.json()) as ReconcileResponse;
  }

  /** The key of a text row, in the same form as `get()` uses (`String` of the parsed value). */
  private keyOf(row: TextRow, schema: ReconcileResponse['schema']): string {
    const column = this.descriptor.key;
    return String(parseValue(row[column], schema[column] ?? 'text'));
  }

  /**
   * Replace whole buckets from an NDJSON full-reconcile answer. Parses one
   * bucket line at a time and only the rows whose hash changed, yielding to the
   * main thread between slices; then applies everything in one synchronous
   * step, so `rows` and `get()` never show a partly applied answer. Returns whether the
   * answer was cut (`more`), or `'reset'` after a schema change.
   */
  private async applyBuckets(text: string): Promise<boolean | 'reset'> {
    let schema: ReconcileResponse['schema'] = {};
    let more = false;
    const upserts: [string, T][] = [];
    const deletes: string[] = [];
    const buckets: [number, Map<string, RowHash>, string][] = [];
    let sinceYield = 0;
    let start = 0;
    while (start < text.length) {
      if (this.stopped) return false;
      let end = text.indexOf('\n', start);
      if (end === -1) end = text.length;
      const line = text.slice(start, end);
      start = end + 1;
      if (!line) continue;
      const parsed: unknown = JSON.parse(line);
      if (!Array.isArray(parsed)) {
        const meta = parsed as { schema?: ReconcileResponse['schema']; more?: boolean; v?: string };
        if (meta.schema) schema = meta.schema;
        if (meta.more) more = true;
        if (this.checkVersion(meta.v)) return 'reset';
        continue;
      }
      const [bucket, entries] = parsed as [number, [RowHash, TextRow][]];
      const previous = this.buckets.get(bucket) ?? new Map<string, RowHash>();
      const next = new Map<string, RowHash>();
      for (const [hash, row] of entries) {
        const key = this.keyOf(row, schema);
        next.set(key, hash);
        if (previous.get(key) !== hash) upserts.push([key, this.parseRow(row, schema) as T]);
      }
      for (const key of previous.keys()) if (!next.has(key)) deletes.push(key);
      buckets.push([bucket, next, bucketDigest(next.values())]);
      sinceYield += entries.length;
      if (sinceYield >= APPLY_SLICE) {
        sinceYield = 0;
        await yieldToMainThread();
      }
    }
    if (this.stopped) return false;
    // Commit in one step.
    for (const [bucket, rows, digest] of buckets) {
      if (rows.size > 0) {
        this.buckets.set(bucket, rows);
        this.digests.set(bucket, digest);
      } else {
        this.buckets.delete(bucket);
        this.digests.delete(bucket);
      }
    }
    this.setRows(upserts);
    let dirty = upserts.length > 0;
    for (const key of deletes) dirty = this.deleteRow(key) || dirty;
    if (dirty) this.publish();
    return more;
  }

  /** Upsert key-level rows. Returns whether anything changed; the caller publishes. */
  private applyRows(diff: ReconcileResponse): boolean {
    let dirty = false;
    for (const [bucket, hash, row] of diff.rows ?? []) {
      const key = this.keyOf(row, diff.schema);
      const rows = this.buckets.get(bucket) ?? new Map<string, RowHash>();
      if (rows.get(key) === hash) continue;
      rows.set(key, hash);
      this.setBucket(bucket, rows);
      this.setRow(key, this.parseRow(row, diff.schema) as T);
      dirty = true;
    }
    return dirty;
  }

  private removeRow(key: string): boolean {
    for (const [bucket, rows] of this.buckets) {
      if (rows.delete(key)) {
        this.setBucket(bucket, rows);
        return this.deleteRow(key);
      }
    }
    return false;
  }

  private setBucket(bucket: number, rows: Map<string, RowHash>): void {
    if (rows.size > 0) {
      this.buckets.set(bucket, rows);
      this.digests.set(bucket, bucketDigest(rows.values()));
    } else {
      this.buckets.delete(bucket);
      this.digests.delete(bucket);
    }
  }

  /** Parse a text row by type and map its column names to field names. */
  private parseRow(row: TextRow, schema: ReconcileResponse['schema']): Record<string, unknown> {
    const parsed: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(row)) parsed[column] = parseValue(value, schema[column] ?? 'text');
    return mapRow(parsed, this.descriptor.columnMapping);
  }
}
