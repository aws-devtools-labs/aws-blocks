// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The per-call `fetch` store contract between the generated client
 * (`ApiNamespaceClient`, this package's browser-safe client entry) and the
 * Node-only test helpers in `@aws-blocks/blocks/utils` (`createTestClient`).
 *
 * A Node.js process may set, on `globalThis` under {@link CLIENT_FETCH_STORE},
 * an `AsyncLocalStorage`-like object `{ getStore(): typeof fetch | undefined }`.
 * A client call made while the store holds a `fetch` sends its request with
 * that `fetch` instead of the global one; every other call is unchanged. The
 * client only looks the store up in Node.js, so browser bundles keep the plain
 * `fetch` path. Defined here, once, and imported by both sides (the setter
 * through `@aws-blocks/core/bb-utils`). A `Symbol.for` key, so a second copy of
 * this package in one process still agrees on it.
 *
 * @internal
 * @module
 */

/**
 * The `globalThis` key of the per-call `fetch` store. See the module doc.
 *
 * @internal
 */
export const CLIENT_FETCH_STORE: unique symbol = Symbol.for('blocks:ClientFetch');

/** The `fetch` the {@link CLIENT_FETCH_STORE} holds for the current call, if any (Node.js only). */
export function contextFetch(): typeof fetch | undefined {
  if (typeof process === 'undefined' || !process.versions?.node) return undefined;
  const store: unknown = Reflect.get(globalThis, CLIENT_FETCH_STORE);
  if (typeof store !== 'object' || store === null || !('getStore' in store)) return undefined;
  const { getStore } = store;
  if (typeof getStore !== 'function') return undefined;
  const scoped: unknown = getStore.call(store);
  return typeof scoped === 'function' ? (scoped as typeof fetch) : undefined;
}
