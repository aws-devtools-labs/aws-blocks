// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `Shape<T>` implementation. Runs in the browser (hydrated by the sync
 * client middleware) and holds the local copy of a shape's rows.
 *
 * The transport is the Electric HTTP shape protocol, read with
 * `@electric-sql/client`'s `ShapeStream`. That dependency stays behind this
 * class: the public surface is AWS Blocks' own `Shape<T>`, so a different sync
 * engine can implement the same interface later without app changes.
 */

import { FetchError, ShapeStream, isChangeMessage, isControlMessage } from '@electric-sql/client';
import type { Message, Row } from '@electric-sql/client';
import type { Shape, ShapeDescriptor } from '../types.js';
import { TOKEN_PARAM } from './shape-constants.js';

/** How a hydrated shape reaches its endpoint and renews its token. */
export interface ShapeTransport {
  /** Absolute URL of the shape endpoint for `path`. */
  resolveUrl(path: string): Promise<string>;
  /** Re-issue the shape (a fresh token) by calling the originating API method again. */
  refresh?: () => Promise<ShapeDescriptor>;
}

/** Live `Shape<T>`. Starts syncing on the first `ready`, `subscribe()`, or `waitForTxid()`. */
export class LiveShape<T> implements Shape<T> {
  private descriptor: ShapeDescriptor;
  private readonly transport: ShapeTransport | undefined;
  private readonly byKey = new Map<string, T>();
  private snapshot: readonly T[] = [];
  private readonly listeners = new Set<(rows: readonly T[]) => void>();
  private readonly seenTxids = new Set<string>();
  private readonly txidWaiters = new Map<string, Array<() => void>>();
  private abort: AbortController | null = null;
  private started = false;
  private upToDate = false;
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
    return this.snapshot;
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

  getSnapshot = (): readonly T[] => this.snapshot;

  waitForTxid(txid: string): Promise<void> {
    this.start();
    if (this.seenTxids.has(txid)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this.txidWaiters.get(txid) ?? [];
      waiters.push(resolve);
      this.txidWaiters.set(txid, waiters);
    });
  }

  close(): void {
    this.abort?.abort();
    this.abort = null;
    this.listeners.clear();
  }

  toJSON(): ShapeDescriptor {
    return this.descriptor;
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.transport) {
      this.rejectReady(
        new Error(
          'This Shape is a server-side handle. Return it from an ApiNamespace method; ' +
            'the client receives a live copy that syncs.',
        ),
      );
      return;
    }
    const transport = this.transport;
    const abort = new AbortController();
    this.abort = abort;
    transport
      .resolveUrl(this.descriptor.path)
      .then((url) => {
        if (abort.signal.aborted) return;
        const stream = new ShapeStream<Row>({
          url,
          signal: abort.signal,
          params: { [TOKEN_PARAM]: () => this.descriptor.token },
          onError: (error) => this.onStreamError(error),
        });
        stream.subscribe(
          (messages) => this.apply(messages),
          (error) => this.rejectReady(error),
        );
      })
      .catch((error: unknown) => this.rejectReady(error instanceof Error ? error : new Error(String(error))));
  }

  /** On 401/403 re-issue the shape once per failure, then retry with the new token. */
  private async onStreamError(error: Error): Promise<Record<string, never> | undefined> {
    const refresh = this.transport?.refresh;
    if (error instanceof FetchError && (error.status === 401 || error.status === 403) && refresh) {
      try {
        this.descriptor = await refresh();
        return {};
      } catch (refreshError) {
        this.rejectReady(refreshError instanceof Error ? refreshError : new Error(String(refreshError)));
        return undefined;
      }
    }
    this.rejectReady(error);
    return undefined;
  }

  private apply(messages: Message<Row>[]): void {
    let changed = false;
    const keyColumn = this.descriptor.key;
    for (const message of messages) {
      if (isChangeMessage(message)) {
        const rowKey = String(message.value[keyColumn]);
        const operation = message.headers.operation;
        if (operation === 'delete') {
          changed = this.byKey.delete(rowKey) || changed;
        } else if (operation === 'update') {
          const previous = this.byKey.get(rowKey);
          // Electric sends only changed columns (plus the key) on update.
          this.byKey.set(rowKey, { ...(previous ?? {}), ...message.value } as T);
          changed = true;
        } else {
          this.byKey.set(rowKey, message.value as T);
          changed = true;
        }
        for (const txid of message.headers.txids ?? []) this.markTxid(String(txid));
      } else if (isControlMessage(message)) {
        if (message.headers.control === 'must-refetch') {
          this.byKey.clear();
          this.upToDate = false;
          changed = true;
        } else if (message.headers.control === 'up-to-date') {
          this.upToDate = true;
          this.resolveReady();
        }
      }
    }
    if (changed) {
      this.snapshot = [...this.byKey.values()];
      for (const listener of [...this.listeners]) listener(this.snapshot);
    }
  }

  private markTxid(txid: string): void {
    this.seenTxids.add(txid);
    const waiters = this.txidWaiters.get(txid);
    if (waiters) {
      this.txidWaiters.delete(txid);
      for (const resolve of waiters) resolve();
    }
  }
}
