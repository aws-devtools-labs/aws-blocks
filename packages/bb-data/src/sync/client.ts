// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Client middleware for `db.shape()`. Imported by the generated client when a
 * backend has a `Database` with `sync` enabled.
 *
 * Hydrates `{ __blocks: 'data/shape' }` descriptors in API responses into live
 * {@link LiveShape} objects. Each hydrated shape remembers the API call that
 * produced it, so when its token expires it calls the same method again: the
 * app's authorization check runs again and issues a fresh token.
 */

import { ApiNamespaceClient, getApiUrl, registerMiddleware } from '@aws-blocks/core/client';
import type { BlocksRequest } from '@aws-blocks/core/client';
import type { ShapeDescriptor } from '../types.js';
import { LiveShape } from './live-shape.js';
import type { ShapeTransport } from './live-shape.js';

const RPC_SUFFIX = '/aws-blocks/api';

function isShapeDescriptor(data: unknown): data is ShapeDescriptor {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { __blocks?: unknown }).__blocks === 'data/shape' &&
    typeof (data as { path?: unknown }).path === 'string' &&
    typeof (data as { token?: unknown }).token === 'string'
  );
}

/** Resolve a backend-relative path against the API URL the client already uses. */
async function resolveUrl(path: string): Promise<string> {
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
      if (fresh instanceof LiveShape) {
        fresh.close();
        return fresh.toJSON();
      }
      if (isShapeDescriptor(fresh)) return fresh;
      throw new Error(`${apiNamespace}.${method}() no longer returns a shape here; cannot refresh the shape token.`);
    },
  };
}

/**
 * @internal Exposed for tests. Replace shape descriptors in `data` with live
 * shapes. Other values pass through unchanged.
 */
export function hydrate(data: unknown, request?: BlocksRequest, path: (string | number)[] = []): unknown {
  if (isShapeDescriptor(data)) return new LiveShape(data, transportFor(request, path));
  if (Array.isArray(data)) return data.map((item, i) => hydrate(item, request, [...path, i]));
  if (typeof data === 'object' && data !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) result[k] = hydrate(v, request, [...path, k]);
    return result;
  }
  return data;
}

registerMiddleware({ onResponse: (data, request) => hydrate(data, request) });
