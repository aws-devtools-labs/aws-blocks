// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared RPC dispatch guards for the Lambda handler and the local dev server.
 *
 * Both dispatchers resolve `backend[apiNamespace][method]` from the request. Without
 * these guards that lookup reaches anything on the backend module:
 *
 * - an exported **Building Block instance** (`export const todos = new DistributedTable(...)`)
 *   — its whole data plane (`put`/`delete`/`query`) becomes an unauthenticated RPC
 *   surface that bypasses every `requireAuth` in the `ApiNamespace` layer;
 * - a member **inherited from `Object.prototype`** (`toString`, `constructor`,
 *   `hasOwnProperty`, …), which passes a plain truthiness "method exists" check.
 *
 * The rules mirror what `generate-client` already emits a client proxy for: it skips
 * `_`-prefixed exports and `Scope` instances, so no generated client can call them and
 * rejecting them at dispatch breaks no legitimate caller.
 *
 * @internal
 */

/**
 * True for a `Scope` subclass instance — every Building Block. Structural (same
 * check `generate-client` uses) so it holds across duplicate `@aws-blocks/core`
 * copies, where an `instanceof Scope` would not.
 */
function isScopeInstance(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { id?: unknown; fullId?: unknown };
  return typeof v.id === 'string' && typeof v.fullId === 'string';
}

/**
 * Whether a backend-module export may be dispatched to as an API namespace.
 *
 * Rejects `_`-private exports, non-function/non-object values, and Building Block
 * (`Scope`) instances. `ApiNamespace` values — and, for backward compatibility, plain
 * exported functions/objects that `generate-client` also proxies — are allowed.
 */
export function isDispatchableExport(name: string, value: unknown): boolean {
  if (name.startsWith('_')) return false;
  if (typeof value !== 'function' && (typeof value !== 'object' || value === null)) return false;
  return !isScopeInstance(value);
}

/**
 * Resolve the export named `apiNamespace` on the backend module, or `undefined` when
 * it is absent or not dispatchable. Uses an own-property lookup, so nothing on the
 * module's (or a plain object's) prototype chain can be selected as a namespace.
 */
export function resolveApiNamespace(backend: unknown, apiNamespace: string): unknown {
  if (typeof backend !== 'object' || backend === null) return undefined;
  if (!Object.hasOwn(backend, apiNamespace)) return undefined;
  const value = (backend as Record<string, unknown>)[apiNamespace];
  return isDispatchableExport(apiNamespace, value) ? value : undefined;
}

/**
 * Resolve `method` on a namespace's method map, or `undefined` when it is not a
 * callable API method. The method must be a function and must not come from
 * `Object.prototype` — so `toString`, `constructor`, `hasOwnProperty`, `__proto__`
 * and friends can never be invoked over RPC. Methods a class instance defines on its
 * own prototype stay reachable, preserving the existing plain-object/class shape.
 */
export function resolveApiMethod(
  apiMethods: unknown,
  method: string,
): ((...args: unknown[]) => unknown) | undefined {
  if (typeof apiMethods !== 'object' || apiMethods === null) return undefined;
  if (method in Object.prototype && !Object.hasOwn(apiMethods, method)) return undefined;
  if (method === '__proto__' || method === 'constructor') return undefined;
  const fn = (apiMethods as Record<string, unknown>)[method];
  if (typeof fn !== 'function') return undefined;
  return fn.bind(apiMethods) as (...args: unknown[]) => unknown;
}
