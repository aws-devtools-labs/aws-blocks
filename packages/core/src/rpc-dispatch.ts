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
 * `_`-prefixed exports, `Scope` instances, and `secret()`/`config()` managed values, so
 * no generated client can call them and rejecting them at dispatch breaks no legitimate
 * caller. `generate-client` imports `isApiNamespace` and `isScopeLike` from here, so the
 * two cannot drift.
 *
 * Anything rejected resolves to `undefined`, and callers answer exactly as they do for
 * an unknown name — the response never says why a name was rejected.
 *
 * @internal
 */

import { API_NAMESPACE_HTTP_ERROR_STATUS, API_NAMESPACE_MARKER } from './api.js';
import { sanitizeCaughtError } from './rpc.js';

/** Whether `value` was produced by `new ApiNamespace(...)`. */
export function isApiNamespace(value: unknown): boolean {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false;
  return typeof Reflect.get(value, API_NAMESPACE_MARKER) === 'string';
}

/**
 * True for a `Scope` subclass instance — every Building Block. Structural (same
 * check `generate-client` uses) so it holds across duplicate `@aws-blocks/core`
 * copies, where an `instanceof Scope` would not.
 */
export function isScopeLike(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { id?: unknown; fullId?: unknown };
  return typeof v.id === 'string' && typeof v.fullId === 'string';
}

/**
 * Brand on `secret()` / `config()` managed values (`MANAGED_BRAND` in
 * `@aws-blocks/hosting`). Re-derived from the same global-registry key rather than
 * imported, so the Lambda runtime path doesn't pull `@aws-blocks/hosting` into every
 * customer bundle; `rpc-dispatch.test.ts` pins it to hosting's real brand.
 */
const MANAGED_VALUE_BRAND = Symbol.for('@aws-blocks/hosting.ManagedValue');

/** True for a `secret()` / `config()` marker — inert deferred data, never an API. */
function isManagedValue(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[MANAGED_VALUE_BRAND] === true;
}

/**
 * Whether a backend-module export may be dispatched to as an API namespace.
 *
 * Rejects `_`-private exports, non-function/non-object values, Building Block
 * (`Scope`) instances, and `secret()`/`config()` managed values. `ApiNamespace`
 * values — and, for backward compatibility, plain exported functions/objects that
 * `generate-client` also proxies — are allowed. An `ApiNamespace` is allowed even if
 * it happens to look like a `Scope`, the same order `generate-client` checks in.
 */
export function isDispatchableExport(name: string, value: unknown): boolean {
  if (name.startsWith('_')) return false;
  if (isApiNamespace(value)) return true;
  if (typeof value !== 'function' && (typeof value !== 'object' || value === null)) return false;
  return !isScopeLike(value) && !isManagedValue(value);
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
 * A handler that returns a Building Block (`Scope`) instance exposes none of its
 * methods: those are server-side APIs, never RPC methods.
 */
export function resolveApiMethod(
  apiMethods: unknown,
  method: string,
): ((...args: unknown[]) => unknown) | undefined {
  if (typeof apiMethods !== 'object' || apiMethods === null) return undefined;
  if (isScopeLike(apiMethods)) return undefined;
  if (method in Object.prototype && !Object.hasOwn(apiMethods, method)) return undefined;
  if (method === '__proto__' || method === 'constructor') return undefined;
  // A non-enumerable own property is hidden on purpose (`Object.defineProperty`), not an API method.
  const own = Object.getOwnPropertyDescriptor(apiMethods, method);
  if (own && !own.enumerable) return undefined;
  const fn = (apiMethods as Record<string, unknown>)[method];
  if (typeof fn !== 'function') return undefined;
  return fn.bind(apiMethods) as (...args: unknown[]) => unknown;
}

/**
 * The HTTP status to answer a failed call on `apiHandler` with.
 *
 * `200` — the JSON-RPC default, the error travelling in the body — unless the
 * namespace was created with `httpErrorStatus: true` and the error is wire-safe
 * with a `4xx` status (an `ApiError` such as `requireAuth()`'s `401`), in which
 * case that status. Reads the status the same way the response body does
 * ({@link sanitizeCaughtError}), so the HTTP status and the body's `error.code`
 * always agree. Shared by the Lambda handler and the local dev server.
 */
export function rpcErrorHttpStatus(apiHandler: unknown, error: unknown): number {
  if ((typeof apiHandler !== 'object' || apiHandler === null) && typeof apiHandler !== 'function') return 200;
  if (Reflect.get(apiHandler, API_NAMESPACE_HTTP_ERROR_STATUS) !== true) return 200;
  const { status } = sanitizeCaughtError(error);
  return Number.isInteger(status) && status >= 400 && status <= 499 ? status : 200;
}

/**
 * Symbol under which a backend owner (`BlocksStack` / `BlocksBackend`) records
 * the export names of its `httpErrorStatus` namespaces, at synth, once the
 * backend module is imported. `Hosting` reads it off the backend it fronts
 * (`props.api`) to warn when its CloudFront error pages would replace those
 * namespaces' 4xx responses.
 *
 * @internal
 */
export const HTTP_ERROR_STATUS_EXPORTS = Symbol.for('blocks:httpErrorStatusExports');

/** The dispatchable exports of `backendModule` created with `httpErrorStatus: true`. @internal */
export function httpErrorStatusExports(backendModule: object): string[] {
  return Object.entries(backendModule)
    .filter(([name, value]) => isDispatchableExport(name, value) && Reflect.get(value as object, API_NAMESPACE_HTTP_ERROR_STATUS) === true)
    .map(([name]) => name);
}
