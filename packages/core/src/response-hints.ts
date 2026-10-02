// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Server side of RPC response hints (see `response-hints-codec.ts`). The RPC
 * dispatcher runs each API method in a hint scope; Building Blocks call
 * `addResponseHint()` from anywhere inside it (e.g. after a database commit),
 * and the dispatcher sends the collected hints in a response header.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { encodeResponseHints } from './response-hints-codec.js';

// One store per process, even with duplicate copies of @aws-blocks/core.
const STORE_KEY = Symbol.for('aws-blocks.response-hints');
const globals = globalThis as { [STORE_KEY]?: AsyncLocalStorage<Map<string, unknown[]>> };
if (!globals[STORE_KEY]) globals[STORE_KEY] = new AsyncLocalStorage();
const storage: AsyncLocalStorage<Map<string, unknown[]>> = globals[STORE_KEY];

/**
 * Attach a hint to the response of the API call in progress. Returns `false`
 * (and does nothing) outside an API call, e.g. in a job handler or a RawRoute.
 * Values must be JSON-serializable and small.
 */
export function addResponseHint(name: string, value: unknown): boolean {
  const store = storage.getStore();
  if (!store) return false;
  const list = store.get(name) ?? [];
  list.push(value);
  store.set(name, list);
  return true;
}

/** @internal Run an API method in a hint scope; returns its result and the encoded header value (or `null`). */
export async function runWithResponseHints<T>(fn: () => Promise<T>): Promise<{ result: T; header: string | null }> {
  const store = new Map<string, unknown[]>();
  const result = await storage.run(store, fn);
  return { result, header: encodeResponseHints(store) };
}
