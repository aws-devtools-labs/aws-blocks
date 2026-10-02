// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Read-your-writes for `Database` shapes. When a write in an API call touches a
 * synced table, the database reads the transaction's id (`pg_current_xact_id()`)
 * before commit and attaches it to the call's response as a sync hint. The
 * client waits for that txid in the open shapes on the written table before the
 * call resolves: it is seen in a change message's `txids`, or it is visible in
 * a snapshot the shape received.
 *
 * Statements are classified by `classifyWrite`. A write outside a transaction
 * runs in one, so its txid can be read.
 */

import { addResponseHint } from '@aws-blocks/core/bb-utils';
import { SYNC_HINT, classifyWrite, sql, unwrapQuery } from '@aws-blocks/data-common';
import type { SqlQuery, SyncHint, Transaction } from '@aws-blocks/data-common';
import { shapePath } from './shape-constants.js';

/** The part of a database the hints need. */
interface TransactionRunner {
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
}

export class TxidHints {
  private readonly path: string;

  constructor(
    db: { id: string; parent?: unknown },
    private readonly tables: string[],
  ) {
    this.path = shapePath(db);
  }

  /** Whether `query` writes a synced table (or a table we can't tell). */
  writes(query: SqlQuery): boolean {
    return classifyWrite(unwrapQuery(query).sql, this.tables) !== null;
  }

  /** Run `fn` in a transaction on `base`; if it wrote a synced table, attach its txid to the response. */
  async transaction<T>(base: TransactionRunner, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const written = new Set<string>();
    let unknown = false;
    let txid: string | null = null;
    const note = (query: SqlQuery) => {
      const write = classifyWrite(unwrapQuery(query).sql, this.tables);
      if (!write) return;
      if (write.table) written.add(write.table);
      else unknown = true;
    };
    const result = await base.transaction(async (tx) => {
      const tracked: Transaction = {
        query: <R>(query: SqlQuery) => (note(query), tx.query<R>(query)),
        queryOne: <R>(query: SqlQuery) => (note(query), tx.queryOne<R>(query)),
        execute: (query: SqlQuery) => (note(query), tx.execute(query)),
      };
      const value = await fn(tracked);
      if (written.size > 0 || unknown) {
        const row = await tx.queryOne<{ txid: string }>(sql`SELECT pg_current_xact_id()::xid::text AS txid`);
        txid = row ? String(row.txid) : null;
      }
      return value;
    });
    if (txid) {
      const hint: SyncHint = { path: this.path, txids: [txid] };
      if (!unknown) hint.tables = [...written];
      addResponseHint(SYNC_HINT, hint);
    }
    return result;
  }
}
