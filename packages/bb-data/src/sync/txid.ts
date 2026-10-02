// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { sql } from '@aws-blocks/data-common';
import type { Transaction } from '@aws-blocks/data-common';

/**
 * Return the id of the current transaction, in the form synced shapes report
 * it. Return this from a write method; the client passes it to
 * `shape.waitForTxid()` to know when its own write has synced back.
 *
 * Call it inside `db.transaction()`, in the same transaction as the write.
 *
 * @example
 * async addTodo(title: string) {
 *   const user = await auth.requireAuth(context);
 *   return db.transaction(async (tx) => {
 *     await tx.execute(sql`INSERT INTO todos (id, owner_id, title) VALUES (${crypto.randomUUID()}, ${user.userId}, ${title})`);
 *     return { txid: await currentTxid(tx) };
 *   });
 * }
 *
 * // Frontend
 * const { txid } = await api.addTodo('Buy milk');
 * await todos.waitForTxid(txid);
 */
export async function currentTxid(tx: Transaction): Promise<string> {
  const row = await tx.queryOne<{ txid: string }>(sql`SELECT pg_current_xact_id()::xid::text AS txid`);
  if (!row) throw new Error('pg_current_xact_id() returned no row');
  return String(row.txid);
}
