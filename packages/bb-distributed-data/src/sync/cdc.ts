// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Aurora DSQL change data capture (CDC) → bell. DSQL writes one JSON record
 * per changed row per committed transaction to a Kinesis data stream; the app
 * Lambda consumes the stream and rings the bell of each synced table that
 * changed.
 *
 * CDC is only a doorbell here. Shapes never apply a record's row image: a rung
 * client reconciles against the current state of the table. So the delivery
 * properties of CDC need no special handling:
 *
 * - **At least once:** a duplicate record rings a bell that has already rung.
 *   The extra reconcile finds no difference.
 * - **Unordered:** a reconcile reads the latest committed state, which already
 *   includes any record still in flight.
 * - **Oversized records:** a `chunked` main record still carries `source`, so it
 *   rings its table; `fragment` records carry no table and are skipped. Row
 *   images are never reassembled.
 *
 * Records from one Lambda invocation fold into at most one bell per table.
 */

/**
 * A changed row from a CDC record: the operation (`c` insert, `u` update, `d`
 * delete) and its image, `after` for inserts and updates, `before` (key
 * columns only) for deletes.
 */
export interface CdcImage {
  op: 'c' | 'u' | 'd';
  row: Record<string, unknown>;
}

/** What a CDC record means for sync. `image` is `null` when the record carries none inline (`chunked`). */
export type CdcEvent =
  | { kind: 'change'; schema: string; table: string; tsMs: number; image: CdcImage | null }
  | { kind: 'skip'; reason: 'fragment' | 'no-source' | 'malformed' };

/** What one bell carries: the latest commit time, and the changed rows, or `null` if unknown. */
export interface PendingBell {
  tsMs: number;
  images: CdcImage[] | null;
}

/** Parse the `Data` of one Kinesis record (base64 JSON, as Lambda delivers it). */
export function parseCdcRecord(base64Data: string): CdcEvent {
  let record: unknown;
  try {
    record = JSON.parse(Buffer.from(base64Data, 'base64').toString('utf8'));
  } catch {
    return { kind: 'skip', reason: 'malformed' };
  }
  if (typeof record !== 'object' || record === null) return { kind: 'skip', reason: 'malformed' };
  const { type, source, op, before, after } = record as {
    type?: unknown;
    source?: unknown;
    op?: unknown;
    before?: unknown;
    after?: unknown;
  };
  if (type === 'fragment') return { kind: 'skip', reason: 'fragment' };
  // `full`, `chunked`, and any future record type that carries `source`: newer
  // minor versions of the envelope only add fields, so read what we know.
  if (typeof source !== 'object' || source === null) return { kind: 'skip', reason: 'no-source' };
  const { schema, table, ts_ms: tsMs } = source as { schema?: unknown; table?: unknown; ts_ms?: unknown };
  if (typeof schema !== 'string' || typeof table !== 'string') return { kind: 'skip', reason: 'no-source' };
  const raw = op === 'd' ? before : after;
  const image =
    type !== 'chunked' && (op === 'c' || op === 'u' || op === 'd') && typeof raw === 'object' && raw !== null
      ? { op: op as CdcImage['op'], row: raw as Record<string, unknown> }
      : null;
  return { kind: 'change', schema, table, tsMs: typeof tsMs === 'number' ? tsMs : Date.now(), image };
}

/**
 * Folds CDC records into bells: synced table → latest commit time and the
 * changed rows' images. `tables` is the `sync.tables` list; unqualified names
 * are in the `public` schema. Duplicate records fold into one key.
 */
export class BellFolder {
  private readonly byQualifiedName = new Map<string, string>();
  private readonly pending = new Map<string, PendingBell>();

  constructor(tables: string[]) {
    for (const table of tables) {
      this.byQualifiedName.set(table.includes('.') ? table : `public.${table}`, table);
    }
  }

  /** Add one record. Returns the synced table it rings, or `null`. */
  add(event: CdcEvent): string | null {
    if (event.kind !== 'change') return null;
    const table = this.byQualifiedName.get(`${event.schema}.${event.table}`);
    if (!table) return null;
    const bell = this.pending.get(table) ?? { tsMs: 0, images: [] };
    bell.tsMs = Math.max(bell.tsMs, event.tsMs);
    if (event.image && bell.images) bell.images.push(event.image);
    else bell.images = null;
    this.pending.set(table, bell);
    return table;
  }

  /** Take the folded bells and reset. */
  drain(): Map<string, PendingBell> {
    const bells = new Map(this.pending);
    this.pending.clear();
    return bells;
  }
}

/**
 * Batches per-record handler calls from one Lambda invocation. The core
 * dispatcher calls a handler per record, all in the same tick; each call adds
 * its record and awaits the same flush, so a batch of N records publishes one
 * bell per changed table instead of N.
 */
export class BellBatcher {
  private flushing: Promise<void> | null = null;

  constructor(
    private readonly folder: BellFolder,
    private readonly ring: (table: string, bell: PendingBell) => Promise<void>,
  ) {}

  /** Handle one Kinesis record (`record.kinesis.data`). Resolves once its bell is published. */
  handle(base64Data: string): Promise<void> {
    this.folder.add(parseCdcRecord(base64Data));
    this.flushing ??= new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
      this.flushing = null;
      const bells = this.folder.drain();
      return Promise.all([...bells].map(([table, bell]) => this.ring(table, bell))).then(() => {});
    });
    return this.flushing;
  }
}

/**
 * The text form of each image's primary key, deduplicated, or `null` when one
 * can't be read exactly (a missing key, or a number JSON can't hold exactly).
 */
export function keysOf(images: CdcImage[], primaryKey: string): string[] | null {
  const keys = new Set<string>();
  for (const image of images) {
    const value = textOf(image.row[primaryKey]);
    if (value === null) return null;
    keys.add(value);
  }
  return [...keys];
}

/** The text form of a CDC value (as `col::text` would give), or `null` if JSON can't hold it exactly. */
export function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}
