// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime half of `DistributedDatabase({ sync })`, shared by the mock and the
 * AWS entry points: the bell, the reconcile endpoint, and `db.shape()`.
 * The two entry points differ only in the token key and in what rings the
 * bell (an app write locally, Aurora DSQL CDC on AWS).
 */

import { ApiError, RawRoute } from '@aws-blocks/core';
import type { Scope } from '@aws-blocks/core';
import { Realtime } from '@aws-blocks/bb-realtime';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import type { DatabaseEngine } from '@aws-blocks/data-common';
import {
  TOKEN_PARAM,
  buildClaims,
  routeOf,
  rejectionResponse,
  shapePath,
  signClaims,
  toDescriptor,
  verifyToken,
} from '@aws-blocks/data-common/sync';
import type { ShapeBell, ShapeDescriptor, ShapeOptions } from '@aws-blocks/data-common/sync';
import { DistributedDatabaseErrors } from '../errors.js';
import { SYNC_BELL_ID, bellChannel } from '../constants.js';
import type { DistributedSyncOptions } from '../types.js';
import { MAX_REQUEST_KEYS, NDJSON } from './protocol.js';
import type { BellMessage, ReconcileRequest } from './protocol.js';
import { keysOf, textOf } from './cdc.js';
import { RouteIndex, anyRouteChannel, createRouteTable, routeChannel } from './routes.js';
import type { PendingBell } from './cdc.js';
import { sealKeys } from './bell-keys.js';
import { WriteTracker } from './written-keys.js';
import type { WriteTracking } from './written-keys.js';
import { addResponseHint } from '@aws-blocks/core/bb-utils';
import { SYNC_HINT } from '@aws-blocks/data-common';
import type { SyncHint } from '@aws-blocks/data-common';
import { bellSchema } from './bell-schema.js';
import { ReconcileServer, ShapeDefinitionError } from './reconcile-server.js';

function createBell(db: Scope) {
  return new Realtime(db, SYNC_BELL_ID, { namespaces: { bell: Realtime.namespace(bellSchema) } });
}

export interface SyncRuntimeOptions {
  db: Scope;
  sync: DistributedSyncOptions;
  getEngine: () => Promise<DatabaseEngine>;
  getTokenKey: () => Promise<string>;
  log: ChildLogger;
}

/** Bell, endpoint, and shape issuing for one `DistributedDatabase`. */
export class SyncRuntime {
  readonly bell: ReturnType<typeof createBell>;
  private readonly server: ReconcileServer;
  private readonly routes: RouteIndex;

  constructor(private readonly options: SyncRuntimeOptions) {
    this.bell = createBell(options.db);
    this.routes = new RouteIndex(createRouteTable(options.db), options.getTokenKey);
    this.server = new ReconcileServer(options.getEngine);
    this.registerRoute();
  }

  /**
   * Tell open shapes on `table` to sync. With the changed rows, each bell
   * carries the keys it concerns (sealed, see `bell-keys.ts`) and a shape reads
   * only those rows; without, shapes do a full reconcile.
   *
   * Every change goes to the table's channel (shapes with no route, and shapes
   * that read the table in a subquery). For each routed column (`routes.ts`),
   * it also goes to the channels of the row's new and old values, or to the
   * table's `*` channel when the old value is unknown.
   */
  async ring(table: string, bell: PendingBell = { tsMs: Date.now(), images: null }): Promise<void> {
    const targets = new Map<string, Set<string> | null>();
    const add = (channel: string, key: string | null) => {
      const existing = targets.get(channel);
      if (key === null || existing === null) targets.set(channel, null);
      else if (existing) existing.add(key);
      else targets.set(channel, new Set([key]));
    };
    const images = bell.images && bell.images.length > 0 ? bell.images : null;
    const primaryKey = images ? await this.server.primaryKey(table).catch(() => null) : null;
    const keys = images && primaryKey ? keysOf(images, primaryKey) : null;
    if (keys) for (const key of keys) add(bellChannel(table), key);
    else add(bellChannel(table), null);

    const columns = await this.routes.columns(table).catch(() => [] as string[]);
    for (const column of columns) {
      if (!images || !primaryKey || !keys) {
        add(anyRouteChannel(table), null);
        continue;
      }
      try {
        const writes = images.map((image) => ({
          op: image.op,
          key: textOf(image.row[primaryKey]) as string,
          value: image.op === 'd' ? null : textOf(image.row[column]),
        }));
        const old = await this.routes.lookup(
          table,
          column,
          writes.filter((write) => write.op !== 'c').map((write) => write.key),
        );
        const recorded = new Map<string, string>();
        const deleted: string[] = [];
        for (const write of writes) {
          let hash: string | null = null;
          if (write.value !== null) {
            hash = await this.routes.hash(table, column, write.value);
            add(routeChannel(table, column, hash), write.key);
            recorded.set(write.key, hash);
          }
          const previous = old.get(write.key);
          if (previous !== undefined) {
            if (previous !== hash) add(routeChannel(table, column, previous), write.key); // moved out of that route
          } else if (write.op !== 'c') {
            add(anyRouteChannel(table), write.key); // route before this write unknown
          }
          if (write.op === 'd') deleted.push(write.key);
        }
        await this.routes.record(table, column, recorded, deleted);
      } catch (e: unknown) {
        this.options.log.error('Bell routing failed; ringing every routed shape', { error: String(e) });
        add(anyRouteChannel(table), null);
      }
    }

    const tokenKey = await this.options.getTokenKey();
    await Promise.all(
      [...targets].map(async ([channel, channelKeys]) => {
        const message: BellMessage = { t: bell.tsMs };
        if (channelKeys && channelKeys.size > 0 && channelKeys.size <= MAX_REQUEST_KEYS) {
          const sealed = sealKeys([...channelKeys], tokenKey, table);
          if (sealed) message.k = sealed;
        }
        await this.bell.publish('bell', channel, message);
      }),
    );
  }

  /**
   * Write tracking for `db.transaction()`: after commit, the written keys go
   * to the API call's response as a sync hint (read-your-writes).
   */
  get tracking(): WriteTracking {
    return {
      tables: this.options.sync.tables,
      primaryKey: (table) => this.server.primaryKey(table).catch(() => null),
      seal: async (keys, table) => sealKeys(keys, await this.options.getTokenKey(), table),
      committed: (hint) => {
        addResponseHint(SYNC_HINT, { path: shapePath(this.options.db), ...hint } satisfies SyncHint);
      },
    };
  }

  /** Report a write made outside a tracked transaction (e.g. through `db.query()`): open shapes do a full sync. */
  untrackedWrite(statement: string): Promise<void> {
    const tracker = new WriteTracker(this.tracking);
    tracker.noteUntracked(statement);
    return tracker.commit();
  }

  /** The synced tables. */
  get tables(): string[] {
    return this.options.sync.tables;
  }

  /** The single-column primary key of a synced table, or `null`. */
  primaryKey(table: string): Promise<string | null> {
    return this.server.primaryKey(table);
  }

  /** Ring every synced table, without keys. */
  async ringAll(): Promise<void> {
    await Promise.all(this.options.sync.tables.map((table) => this.ring(table)));
  }

  /** Build the descriptor of a new shape. Throws `ShapeInvalidException`. */
  async issue<T>(options: ShapeOptions<T>): Promise<ShapeDescriptor> {
    const { db, sync } = this.options;
    const claims = buildClaims(db.fullId, sync, options, 'DistributedDatabase');
    const token = signClaims(claims, await this.options.getTokenKey());
    // A filter with `column = $n` listens on that value's channel (and the
    // table's `*` channel); otherwise on the whole table's channel. Tables read
    // in subqueries add their channels: a change there makes the shape re-check.
    const route = routeOf(claims);
    const others: string[] = (claims.d ?? []).map(bellChannel);
    let root = bellChannel(claims.t);
    if (route) {
      try {
        await this.routes.register(claims.t, route.column);
        root = routeChannel(claims.t, route.column, await this.routes.hash(claims.t, route.column, route.value));
        others.push(anyRouteChannel(claims.t));
      } catch (e: unknown) {
        this.options.log.error('Could not register a bell route; using the table channel', { error: String(e) });
      }
    }
    const bell = await this.bellFor(root);
    const dependencyBells = (await Promise.all(others.map((channel) => this.bellFor(channel)))).filter(
      (b): b is ShapeBell => b !== undefined,
    );
    return toDescriptor(shapePath(db), claims, token, {
      protocol: 'reconcile',
      bell,
      ...(dependencyBells.length > 0 ? { dependencyBells } : {}),
    });
  }

  private async bellFor(name: string): Promise<ShapeBell | undefined> {
    const channel = (await this.bell.getChannel('bell', name)).toJSON() as {
      channel?: string;
      wsUrl?: string;
      connectToken?: string;
      token?: string;
    };
    // No WebSocket endpoint (e.g. tests without the dev server): the client polls.
    if (!channel.wsUrl || !channel.channel || !channel.connectToken || !channel.token) return undefined;
    return { wsUrl: channel.wsUrl, channel: channel.channel, connectToken: channel.connectToken, token: channel.token };
  }

  /** The reconcile endpoint: verify the token, then diff the client's digest against DSQL. */
  private registerRoute(): void {
    const { db, log } = this.options;
    new RawRoute(db, 'sync-shape', {
      method: 'POST',
      path: shapePath(db),
      handler: async (context) => {
        const key = await this.options.getTokenKey();
        const verdict = verifyToken(context.request.url.searchParams.get(TOKEN_PARAM), key, db.fullId);
        if (!verdict.ok) {
          const rejection = rejectionResponse(verdict.reason);
          context.response.status = rejection.status;
          context.response.send(rejection.body);
          return;
        }
        let request: ReconcileRequest;
        try {
          request = await context.request.json();
        } catch {
          request = { digest: {} };
        }
        if (typeof request !== 'object' || request === null) request = { digest: {} };
        if (
          !Array.isArray(request.changed) &&
          !Array.isArray(request.written) &&
          !Array.isArray(request.held) &&
          request.snapshot === undefined &&
          (typeof request.digest !== 'object' || request.digest === null)
        ) {
          request = { digest: {} };
        }
        try {
          context.response.headers.set('cache-control', 'no-store');
          const result = await this.server.serve(verdict.claims, request, key);
          if ('ndjson' in result) {
            context.response.headers.set('content-type', NDJSON);
            context.response.send(result.ndjson);
          } else {
            context.response.send(result);
          }
        } catch (e: unknown) {
          if (e instanceof ShapeDefinitionError || e instanceof ApiError) {
            context.response.status = 400;
            context.response.send({ error: e.message, name: DistributedDatabaseErrors.ShapeInvalid });
            return;
          }
          // Database errors can carry SQL text and identifiers; keep them server-side.
          log.error('Shape reconcile failed', { error: e instanceof Error ? e.message : String(e) });
          context.response.status = 500;
          context.response.send({ error: 'The shape could not be read', name: DistributedDatabaseErrors.QueryFailed });
        }
      },
    });
  }
}
