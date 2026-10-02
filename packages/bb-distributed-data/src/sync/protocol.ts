// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wire format of the reconcile protocol that `DistributedDatabase` shapes
 * speak. Shared by the server and the browser client: no Node imports.
 *
 * A shape keeps no state on the server. The client holds the rows, grouped
 * into {@link BUCKETS} buckets by key, and sends one digest per non-empty
 * bucket. The server reads the shape from Aurora DSQL (a consistent snapshot),
 * computes the same digests, and returns the full contents of every bucket
 * whose digest differs. The client replaces those buckets. Inserts, updates,
 * deletes, and rows that move into or out of the filter all fall out of the
 * comparison; nothing depends on the order changes happened in.
 */

/** Number of buckets a shape's rows are hashed into. */
export const BUCKETS = 256;

/** A bucket digest: XOR of its row hashes (16 hex digits) and its row count, as `{xor}.{count}`. */
export type BucketDigest = string;

/** Row hash: 16 hex digits, computed by the server over the row's text values. */
export type RowHash = string;

/** A row in Postgres text form, as the server reads it (`col::text`). */
export type TextRow = Record<string, string | null>;

/**
 * Request body. Exactly one mode:
 *
 * - `digest`: full reconcile. The digest of every non-empty bucket the client
 *   holds; the server answers with `buckets`. Reads the whole shape.
 * - `changed`: the encrypted key lists from bells (`BellMessage.k`). The server
 *   answers with `rows` for those keys that are in the shape, and `recheck`:
 *   the buckets of keys that are not (a row there may have left the shape).
 *   Reads only those keys.
 * - `held`: keys the client holds (in the `recheck` buckets). The server answers
 *   with `rows` for those still in the shape; the client drops the rest.
 */
export interface ReconcileRequest {
  digest?: Record<string, BucketDigest>;
  changed?: string[];
  held?: string[];
  /**
   * Sealed key lists of an API call's own writes (its sync hint). Like
   * `changed`, but lists sealed for other tables are ignored (the write did
   * not touch this shape's table).
   */
  written?: string[];
  /**
   * A `SnapshotQuery` (changes-only shapes), with field names mapped to
   * columns. Compiled on the server; answered with `rows`, in query order.
   */
  snapshot?: unknown;
}

/**
 * A full reconcile (`digest` mode) answers in NDJSON, so the client can parse it
 * one bucket at a time without blocking the main thread on one large
 * `JSON.parse`:
 *
 * ```
 * {"schema":{...},"v":"..."}          first line (v: schema version)
 * [bucket, [[hash, row], ...]]        one line per bucket that differs
 * {"more":true}                       last line, if the response was cut at
 *                                     MAX_RESPONSE_BYTES: ask again for the rest
 * ```
 */
export const NDJSON = 'application/x-ndjson';

/** A full-reconcile response stops adding buckets past this size (the Lambda response limit is 6 MB). */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Response body of the `changed` and `held` modes (JSON). */
export interface ReconcileResponse {
  /** Column name → Postgres type name (`udt_name`, e.g. `int4`, `_text`), in shape column order. */
  schema: Record<string, string>;
  /** `changed` / `held` modes: current rows, as `[bucket, hash, row]`. */
  rows?: [number, RowHash, TextRow][];
  /** `changed` mode: buckets to recheck with `held`. */
  recheck?: number[];
  /** `changed` mode: the keys could not be used; do a full (`digest`) reconcile instead. */
  full?: true;
  /**
   * Schema version of the shape's columns. When it changes (a migration
   * changed the table), the client drops its rows and loads them again.
   */
  v?: string;
}

/** Most keys a reconcile request may name (`changed` after decryption, or `held`). */
export const MAX_REQUEST_KEYS = 5000;

/** Bell message published when a synced table changes. */
export interface BellMessage {
  /** Latest commit time seen for the table, epoch milliseconds. */
  t: number;
  /**
   * The changed primary keys, encrypted with the server's key (only the server
   * can read them, so a bell on a shared table does not reveal other users'
   * keys). Omitted when the keys are unknown or too many: the client then does
   * a full reconcile.
   */
  k?: string;
}

/** Digest of a bucket from its row hashes. */
export function bucketDigest(hashes: Iterable<RowHash>): BucketDigest {
  let hi = 0;
  let lo = 0;
  let count = 0;
  for (const hash of hashes) {
    hi = (hi ^ Number.parseInt(hash.slice(0, 8), 16)) >>> 0;
    lo = (lo ^ Number.parseInt(hash.slice(8, 16), 16)) >>> 0;
    count++;
  }
  return `${hi.toString(16).padStart(8, '0')}${lo.toString(16).padStart(8, '0')}.${count}`;
}
