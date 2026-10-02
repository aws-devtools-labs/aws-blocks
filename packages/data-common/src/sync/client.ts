// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * @aws-blocks/data-common/sync-client — client side of `db.shape()`.
 *
 * Hydrates `{ __blocks: 'data/shape' }` descriptors in API responses into live
 * shapes. Each Building Block registers the shape class for its protocol
 * (`registerShapeProtocol`); this module registers one response middleware
 * for all of them. Each hydrated shape remembers the API call that produced
 * it, so when its token expires it calls the same method again: the app's
 * authorization check runs again and issues a fresh token.
 *
 * Browser-safe: no Node imports.
 */

import { ApiNamespaceClient, getApiUrl, registerMiddleware } from '@aws-blocks/core/client';
import type { BlocksRequest } from '@aws-blocks/core/client';
import { liveShapes } from './shape-store.js';
import type { ShapeStore, ShapeTransport } from './shape-store.js';
import { SYNC_HINT } from './types.js';
import type { ShapeDescriptor, SyncHint } from './types.js';

export { ShapeStore, ServerShape } from './shape-store.js';
export type { ShapeTransport } from './shape-store.js';
export { TOKEN_PARAM, shapePath } from './constants.js';
export type { Shape, ShapeBell, ShapeDescriptor, ShapeOptions, SyncHint } from './types.js';

/** Builds the live shape for one protocol. */
export type ShapeFactory = (descriptor: ShapeDescriptor, transport: ShapeTransport) => ShapeStore<unknown>;

type Protocol = NonNullable<ShapeDescriptor['protocol']>;

// One registry per page, even if two copies of this module are bundled.
const REGISTRY_KEY: unique symbol = Symbol.for('aws-blocks.data.shape-protocols') as never;
const MIDDLEWARE_KEY: unique symbol = Symbol.for('aws-blocks.data.shape-middleware') as never;
const globals = globalThis as { [REGISTRY_KEY]?: Map<Protocol, ShapeFactory>; [MIDDLEWARE_KEY]?: boolean };
if (!globals[REGISTRY_KEY]) globals[REGISTRY_KEY] = new Map();
const registry: Map<Protocol, ShapeFactory> = globals[REGISTRY_KEY];

const RPC_SUFFIX = '/aws-blocks/api';

/** Register the shape class for a protocol. Descriptors without `protocol` are `'electric'`. */
export function registerShapeProtocol(protocol: Protocol, factory: ShapeFactory): void {
  registry.set(protocol, factory);
}

export function isShapeDescriptor(data: unknown): data is ShapeDescriptor {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { __blocks?: unknown }).__blocks === 'data/shape' &&
    typeof (data as { path?: unknown }).path === 'string' &&
    typeof (data as { token?: unknown }).token === 'string'
  );
}

/** Resolve a backend-relative path against the API URL the client already uses. */
export async function resolveUrl(path: string): Promise<string> {
  const apiUrl = await getApiUrl();
  const base = apiUrl.endsWith(RPC_SUFFIX) ? apiUrl.slice(0, -RPC_SUFFIX.length) : apiUrl.replace(/\/$/, '');
  const url = `${base}${path}`;
  if (/^https?:\/\//.test(url)) return url;
  if (typeof window !== 'undefined' && window.location) return new URL(url, window.location.origin).href;
  throw new Error(`Cannot resolve the shape endpoint "${url}" without a browser origin. Set BLOCKS_API_URL.`);
}

/** Read the value at the same position in a fresh response. */
function valueAtPath(data: unknown, path: (string | number)[]): unknown {
  let current: unknown = data;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

function isLiveShape(value: unknown): value is { close(): void; toJSON(): ShapeDescriptor } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { close?: unknown }).close === 'function' &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  );
}

function transportFor(request: BlocksRequest | undefined, path: (string | number)[]): ShapeTransport {
  if (!request) return { resolveUrl };
  const { apiNamespace, method, args } = request;
  return {
    resolveUrl,
    async refresh() {
      const client = ApiNamespaceClient<Record<string, (...a: unknown[]) => unknown>>(apiNamespace);
      const fresh = valueAtPath(await client[method](...args), path);
      // The fresh response passes through this middleware too, so the shape
      // arrives hydrated (and not yet started). Take its descriptor.
      if (isLiveShape(fresh)) {
        fresh.close();
        const descriptor = fresh.toJSON();
        if (isShapeDescriptor(descriptor)) return descriptor;
      }
      if (isShapeDescriptor(fresh)) return fresh;
      throw new Error(`${apiNamespace}.${method}() no longer returns a shape here; cannot refresh the shape token.`);
    },
  };
}

/**
 * @internal Exposed for tests. Replace shape descriptors in `data` with live
 * shapes. Descriptors for a protocol with no registered shape class, and all
 * other values, pass through unchanged.
 */
export function hydrate(data: unknown, request?: BlocksRequest, path: (string | number)[] = []): unknown {
  if (isShapeDescriptor(data)) {
    const factory = registry.get(data.protocol ?? 'electric');
    return factory ? factory(data, transportFor(request, path)) : data;
  }
  if (Array.isArray(data)) return data.map((item, i) => hydrate(item, request, [...path, i]));
  if (typeof data === 'object' && data !== null && Object.getPrototypeOf(data) === Object.prototype) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) result[k] = hydrate(v, request, [...path, k]);
    return result;
  }
  return data;
}

function isSyncHint(value: unknown): value is SyncHint {
  return typeof value === 'object' && value !== null && typeof (value as { path?: unknown }).path === 'string';
}

/**
 * @internal Exposed for tests. Bring the writes an API call reports (its
 * `data/sync` response hints) into the open shapes they concern. A hint list
 * dropped for size makes every open shape do a full sync. Never throws: the
 * write itself succeeded, so a failed sync only delays the change.
 */
export async function settle(hints: { values: Record<string, unknown[]>; overflow: string[] }): Promise<void> {
  const list = (hints.values[SYNC_HINT] ?? []).filter(isSyncHint);
  const overflow = hints.overflow.includes(SYNC_HINT);
  if (list.length === 0 && !overflow) return;
  const work: Promise<void>[] = [];
  for (const shape of liveShapes()) {
    if (overflow) {
      const path = shape.toJSON().path;
      work.push(shape.settle({ path, full: true }).catch(() => {}));
      continue;
    }
    for (const hint of list) {
      if (shape.concerns(hint)) work.push(shape.settle(hint).catch(() => {}));
    }
  }
  await Promise.all(work);
}

if (!globals[MIDDLEWARE_KEY]) {
  globals[MIDDLEWARE_KEY] = true;
  registerMiddleware({
    onResponse: (data, request) => hydrate(data, request),
    onSettled: (_data, _request, hints) => settle(hints),
  });
}
