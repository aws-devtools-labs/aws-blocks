// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Equality routing for bells: a shape whose filter has a top-level `column = $n` term
 * listens on a channel for that column and value only, so a write wakes just
 * the shapes it can affect, however many shapes are open on the table.
 *
 * A write reaches the channel of its row's new value (from the CDC image) and
 * of its old value: CDC has no before-image for updates, and only the key for
 * deletes, so a small index (a `DistributedTable`) remembers each row's route
 * value. When the old value is unknown (a row written before the column was
 * routed), the write goes to the table's `*` channel, which every routed shape
 * also listens on: correct, just not narrowed.
 *
 * Channel names carry an HMAC of the value, never the value itself.
 */

import { createHmac } from 'node:crypto';
import { DistributedTable } from '@aws-blocks/bb-distributed-table';
import type { ScopeParent } from '@aws-blocks/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { SYNC_ROUTES_ID, bellChannel } from '../constants.js';

/** One index entry: `C#<table>` / `<column>` (a routed column), or `K#<table>#<column>` / `<key>` (a row's value hash). */
export interface RouteItem {
  pk: string;
  sk: string;
  v?: string;
}

// Issues name the failing field: DistributedTable's CDK layer probes each key
// field with a number and makes it a string key only if that field is flagged.
const routeSchema: StandardSchemaV1<RouteItem> = {
  '~standard': {
    version: 1,
    vendor: 'aws-blocks',
    validate: (value) => {
      const item = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
      const issues: { message: string; path: string[] }[] = [];
      for (const field of ['pk', 'sk']) {
        if (typeof item[field] !== 'string') issues.push({ message: `Expected "${field}" to be a string`, path: [field] });
      }
      if (item.v !== undefined && typeof item.v !== 'string') issues.push({ message: 'Expected "v" to be a string', path: ['v'] });
      return issues.length > 0 ? { issues } : { value: item as unknown as RouteItem };
    },
  },
};

/** The route index table. Same child id in every layer. */
export function createRouteTable(scope: ScopeParent) {
  return new DistributedTable(scope, SYNC_ROUTES_ID, { schema: routeSchema, key: { partitionKey: 'pk', sortKey: 'sk' } });
}

export type RouteTable = ReturnType<typeof createRouteTable>;

/** Channel of shapes routed on `column` = the value with hash `valueHash`. */
export const routeChannel = (table: string, column: string, valueHash: string): string =>
  `${bellChannel(table)}.${column}.${valueHash}`;

/** Channel every routed shape on `table` also listens on, for writes whose route is unknown. */
export const anyRouteChannel = (table: string): string => `${bellChannel(table)}.*`;

const COLUMNS_TTL_MS = 30_000;
const BATCH = 100;

export class RouteIndex {
  private readonly columnsCache = new Map<string, { at: number; columns: Promise<string[]> }>();
  private readonly registered = new Set<string>();

  constructor(
    private readonly routes: RouteTable,
    private readonly getTokenKey: () => Promise<string>,
  ) {}

  /** HMAC of a route value: what channel names and the index store. */
  async hash(table: string, column: string, value: string): Promise<string> {
    return createHmac('sha256', await this.getTokenKey())
      .update(`${table}\u0000${column}\u0000${value}`)
      .digest('base64url')
      .slice(0, 22);
  }

  /** Record that shapes route `table` on `column` (once per container). */
  async register(table: string, column: string): Promise<void> {
    const id = `${table}\u0000${column}`;
    if (this.registered.has(id)) return;
    await this.routes.put({ pk: `C#${table}`, sk: column });
    this.registered.add(id);
    this.columnsCache.delete(table);
  }

  /** Columns shapes route `table` on (cached briefly). */
  columns(table: string): Promise<string[]> {
    const cached = this.columnsCache.get(table);
    if (cached && Date.now() - cached.at < COLUMNS_TTL_MS) return cached.columns;
    const columns = (async () => {
      const found: string[] = [];
      for await (const item of this.routes.query({ where: { pk: { equals: `C#${table}` } } })) found.push(item.sk);
      return found;
    })();
    this.columnsCache.set(table, { at: Date.now(), columns });
    columns.catch(() => this.columnsCache.delete(table));
    return columns;
  }

  /** The recorded value hash of each key for `column`, if any. */
  async lookup(table: string, column: string, keys: string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    for (let i = 0; i < keys.length; i += BATCH) {
      const chunk = keys.slice(i, i + BATCH);
      const items = await this.routes.getBatch(chunk.map((key) => ({ pk: `K#${table}#${column}`, sk: key })));
      items.forEach((item, j) => {
        if (item?.v) found.set(chunk[j], item.v);
      });
    }
    return found;
  }

  /** Store new value hashes; forget deleted keys. */
  async record(table: string, column: string, values: Map<string, string>, deleted: string[]): Promise<void> {
    const puts = [...values].map(([key, v]) => ({ pk: `K#${table}#${column}`, sk: key, v }));
    for (let i = 0; i < puts.length; i += BATCH) await this.routes.putBatch(puts.slice(i, i + BATCH));
    const deletes = deleted.map((key) => ({ pk: `K#${table}#${column}`, sk: key }));
    for (let i = 0; i < deletes.length; i += BATCH) await this.routes.deleteBatch(deletes.slice(i, i + BATCH));
  }
}
