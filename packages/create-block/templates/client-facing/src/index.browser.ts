// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Client-facing browser entry.
//
// A client-facing Building Block needs browser-side code to handle a protocol
// beyond plain HTTP (WebSockets, an OAuth redirect flow, etc.). The server
// returns a "Transferable" — a value that serializes with `toJSON()` to
// `{ __blocks: 'ns/type', ... }` and re-hydrates here into a live client object
// via a registered client middleware.
//
// The stub below keeps the block importable in isomorphic code and satisfies
// export parity with the server entries. Replace it with your real client
// plugin. **`packages/bb-realtime` is the canonical end-to-end example** — copy
// its client-middleware shape rather than inventing one.

// __BB_CLASS__ itself is server-side; the browser only needs the type + errors.
export class __BB_CLASS__ {
	constructor(...args: any[]) {}
}
export { __BB_CLASS__Errors } from './errors.js';

/**
 * TODO: implement the client middleware that re-hydrates this block's
 * Transferable into a live client object. Register it server-side with
 * `scope.registerClientMiddleware('__BB_PKG_NAME__')`. See `bb-realtime`.
 *
 * @example
 * ```ts
 * // export function createClientMiddleware() {
 * //   return {
 * //     hydrate(transferable) {  hand back a live object  },
 * //   };
 * // }
 * ```
 */
export const CLIENT_MIDDLEWARE_TODO = '__BB_PKG_NAME__' as const;
