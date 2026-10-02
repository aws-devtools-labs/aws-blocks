// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Written keys, for read-your-writes. Inside a `DistributedDatabase`
 * transaction, `execute()` of a plain `INSERT INTO` / `UPDATE` / `DELETE FROM`
 * on a synced table runs with `RETURNING <primary key>`, so the transaction
 * knows the keys it wrote. After commit, the database attaches them (sealed:
 * only the server can read them) to the API call's response as a sync hint;
 * the client reads just those rows into its open shapes before the call
 * resolves. Aurora DSQL reads are strongly consistent, so the read sees the
 * write.
 *
 * Writes it can't read precisely (a CTE, an own `RETURNING`, a write through
 * `tx.query()`) mark the hint `full`: open shapes on the database do a full
 * reconcile instead. `execute()` still returns the same `rowCount`.
 */

import { classifyWrite, sql, unwrapQuery } from '@aws-blocks/data-common';
import type { SqlQuery, SyncHint, Transaction } from '@aws-blocks/data-common';
import { MAX_REQUEST_KEYS } from './protocol.js';

/** What a tracked transaction needs from the sync runtime. */
export interface WriteTracking {
  tables: string[];
  primaryKey(table: string): Promise<string | null>;
  seal(keys: string[], table: string): Promise<string | undefined>;
  /** Called once, after commit, with what the transaction wrote. */
  committed(hint: Omit<SyncHint, 'path'>): void;
}

/**
 * `query` with `RETURNING "<pk>"::text AS __blocks_key` appended (a trailing
 * `;` removed), rebuilt through the `sql` tag. The tag numbers placeholders
 * `$1..$n` in order, so splitting on them gives back the template; returns
 * `null` if the text has any other placeholder pattern.
 */
function withReturning(query: SqlQuery, primaryKey: string): SqlQuery | null {
  const { sql: text, params } = unwrapQuery(query);
  const base = `${text.replace(/;\s*$/, '')} RETURNING "${primaryKey.replace(/"/g, '""')}"::text AS __blocks_key`;
  const parts: string[] = [];
  let last = 0;
  let expected = 1;
  for (const match of base.matchAll(/\$(\d+)/g)) {
    if (Number(match[1]) !== expected++) return null;
    parts.push(base.slice(last, match.index));
    last = (match.index ?? 0) + match[0].length;
  }
  parts.push(base.slice(last));
  if (expected - 1 !== params.length) return null;
  const strings = Object.assign([...parts], { raw: [...parts] }) as unknown as TemplateStringsArray;
  return sql(strings, ...params);
}

/** Records what one transaction writes; {@link WriteTracker.commit} reports it. */
export class WriteTracker {
  private readonly written = new Map<string, Set<string>>();
  private readonly untracked = new Set<string>();
  private unknownTable = false;

  constructor(private readonly tracking: WriteTracking) {}

  /** Wrap a transaction so its writes are recorded. */
  wrap(tx: Transaction): Transaction {
    const note = (query: SqlQuery) => this.noteUntracked(unwrapQuery(query).sql);
    return {
      query: <T>(query: SqlQuery) => {
        note(query);
        return tx.query<T>(query);
      },
      queryOne: <T>(query: SqlQuery) => {
        note(query);
        return tx.queryOne<T>(query);
      },
      execute: async (query: SqlQuery) => {
        const write = classifyWrite(unwrapQuery(query).sql, this.tracking.tables);
        if (!write) return tx.execute(query);
        const primaryKey = write.plain && write.table ? await this.tracking.primaryKey(write.table) : null;
        const rewritten = primaryKey ? withReturning(query, primaryKey) : null;
        if (!rewritten) {
          this.noteUntracked(unwrapQuery(query).sql);
          return tx.execute(query);
        }
        const rows = await tx.query<{ __blocks_key: string | null }>(rewritten);
        const keys = this.written.get(write.table) ?? new Set<string>();
        for (const row of rows) if (row.__blocks_key !== null) keys.add(row.__blocks_key);
        this.written.set(write.table, keys);
        return { rowCount: rows.length };
      },
    };
  }

  /** Record a write the tracker can't read keys from (e.g. through `query()` or outside a transaction). */
  noteUntracked(statement: string): void {
    const write = classifyWrite(statement, this.tracking.tables);
    if (!write) return;
    if (write.table) this.untracked.add(write.table);
    else this.unknownTable = true;
  }

  /** After commit: report what was written. Does nothing if no synced table was written. */
  async commit(): Promise<void> {
    if (this.written.size === 0 && this.untracked.size === 0 && !this.unknownTable) return;
    const hint: Omit<SyncHint, 'path'> = {};
    const tables = new Set<string>([...this.written.keys(), ...this.untracked]);
    if (!this.unknownTable) hint.tables = [...tables];
    const keys: string[] = [];
    let full = this.unknownTable || this.untracked.size > 0;
    for (const [table, set] of this.written) {
      if (set.size === 0) continue;
      const sealed = set.size <= MAX_REQUEST_KEYS ? await this.tracking.seal([...set], table) : undefined;
      if (sealed) keys.push(sealed);
      else full = true;
    }
    if (keys.length > 0) hint.keys = keys;
    if (full) hint.full = true;
    this.tracking.committed(hint);
  }
}
