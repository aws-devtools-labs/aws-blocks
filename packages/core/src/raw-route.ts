// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { BlocksContext } from './api.js';
import type { ScopeParent } from './common/index.js';
import { BLOCKS_NAMESPACE, BLOCKS_RPC_PREFIX } from './constants.js';

// ── Public types ────────────────────────────────────────────────────────────

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export interface RawRouteOptions {
  method: HttpMethod;
  /**
   * URL path pattern. When provided, used exactly as given.
   * When omitted, derived from the scope-chain IDs.
   *
   * - `/health`       — exact match
   * - `/users/{id}`   — named path parameter (captures one segment)
   * - `/v1/*`         — wildcard (captures everything after prefix)
   *
   * **Scope-chain derivation:** If omitted, the path is built by collecting
   * each ancestor scope's `id` (excluding the root BlocksStack) and joining
   * with `/`. For example, `BlocksStack('app') → Scope('v1') → RawRoute('health')`
   * yields `/v1/health`.
   */
  path?: string;
  handler: (context: BlocksContext) => Promise<void>;
}

/**
 * Typed error constants for RawRoute. Use with `isBlocksError()` in catch blocks.
 *
 * @example
 * ```typescript
 * try {
 *   new RawRoute(scope, 'dup', { method: 'GET', path: '/health', handler });
 * } catch (e: unknown) {
 *   if (isBlocksError(e, RawRouteErrors.DuplicateRoute)) {
 *     // same method+path already registered
 *   }
 * }
 * ```
 */
export const RawRouteErrors = {
  DuplicateRoute: 'DuplicateRouteException',
} as const;

// ── Scope-chain path derivation ─────────────────────────────────────────────

/**
 * Derive a URL path from the scope chain.
 *
 * Walks the parent chain from `scope` up to (but NOT including) the root
 * BlocksStack or the top-level user Scope, collects each intermediate scope's
 * `id`, URL-encodes segments, and joins with `/`. The RawRoute's own `id`
 * is appended as the final segment.
 *
 * A scope is "root-level" if its parent has no `parent` property (i.e., it's
 * the BlocksStack or the fallback `{ id: ... }` sentinel). Root-level scopes
 * are excluded from the path — they represent the application boundary, not
 * a URL segment.
 *
 * @example
 * ```
 * Scope('app') → RawRoute('health')                    → /health
 * Scope('app') → Scope('v1') → RawRoute('users')       → /v1/users
 * Scope('app') → Scope('api') → Scope('v2') → RawRoute('items') → /api/v2/items
 * ```
 */
export function derivePathFromScope(scope: ScopeParent, id: string): string {
  const segments: string[] = [];

  let current: ScopeParent | undefined = scope;
  while (current && 'parent' in current && current.parent) {
    const parentNode: ScopeParent = (current as { parent: ScopeParent }).parent;
    const parentIsRoot = !('parent' in parentNode) || !(parentNode as any).parent;
    if (parentIsRoot) break;
    segments.unshift(encodeURIComponent(current.id));
    current = parentNode;
  }

  segments.push(encodeURIComponent(id));
  return '/' + segments.join('/');
}

/**
 * Resolve the effective path for a RawRoute — uses the explicit `path` if
 * provided, otherwise derives it from the scope chain.
 */
export function resolveRoutePath(scope: ScopeParent, id: string, options: RawRouteOptions): string {
  return options.path ?? derivePathFromScope(scope, id);
}

// ── Route registry ──────────────────────────────────────────────────────────

export interface RegisteredRoute {
  method: string;
  /** Normalized path (trailing slashes removed, double slashes collapsed). */
  path: string;
  /** Compiled regex for matching incoming request paths. */
  pattern: RegExp;
  /** Extracted parameter names in capture-group order. */
  paramNames: string[];
  handler: (context: BlocksContext) => Promise<void>;
}

/**
 * Registry state shared by every copy of `@aws-blocks/core` in the process.
 *
 * A bundle can end up carrying more than one physical copy of this package
 * (an unlucky dependency tree, no dedupe). With module-local state each copy
 * would keep its own route table: Building Blocks register into theirs, the
 * dispatcher reads its own, and every route registered through the "wrong"
 * copy answers 404 without a log line. The synth path has the same split —
 * `hosting.ts` builds CloudFront behaviors from `getRegisteredRoutes()`.
 *
 * `locked` travels with `routes` on purpose: splitting them would let one copy
 * lock the shared table while another is still registering, trading a silent
 * loss for a spurious throw.
 */
interface RawRouteRegistryState {
  routes: RegisteredRoute[];
  locked: boolean;
  /** Number of core copies that have joined this registry (1 = healthy). */
  copies: number;
}

/**
 * Well-known `globalThis` key holding the shared registry state.
 *
 * A plain string rather than a `Symbol.for()` key, deliberately: duplicate
 * copies are diagnosed by counting strings in the deployed bundle, and a
 * symbol would be invisible to that. It also matches the existing
 * `__BLOCKS_LAMBDA_EVENT_HANDLERS__` precedent. The `_V1_` suffix lets a
 * future incompatible shape claim its own key rather than corrupt this one.
 */
const REGISTRY_KEY = '__AWS_BLOCKS_RAW_ROUTE_REGISTRY_V1__';

type GlobalWithRegistry = typeof globalThis & { [REGISTRY_KEY]?: RawRouteRegistryState };

/** Whether *this* module copy has already counted itself. Intentionally module-local. */
let thisCopyCounted = false;

/**
 * Resolve the shared registry state, creating it on first access.
 *
 * The copy count is incremented here rather than at module load so that it
 * counts the copies actually taking part in routing, not every copy a bundle
 * happens to carry. Bundled code is where duplicate copies occur, and a copy
 * that is imported but never routes is not what the diagnostic is about.
 *
 * Tree-shaking is not the reason. `sideEffects` in package.json lets a bundler
 * drop this module whole when nothing it exports is used, but a module that
 * *is* used keeps its top-level statements — measured with esbuild under
 * `--bundle --minify`, and covered by the bundling test in `raw-route.test.ts`.
 */
function getState(): RawRouteRegistryState {
  const g = globalThis as GlobalWithRegistry;
  let state = g[REGISTRY_KEY];
  if (!state) {
    state = { routes: [], locked: false, copies: 0 };
    g[REGISTRY_KEY] = state;
  }

  if (!thisCopyCounted) {
    thisCopyCounted = true;
    state.copies += 1;
    if (state.copies > 1) {
      console.warn(
        `AWS Blocks: ${state.copies} copies of @aws-blocks/core loaded in this process. ` +
          'They now share one RawRoute registry, but duplicate copies indicate a ' +
          'dependency-tree problem — deduplicate @aws-blocks/core.',
      );
    }
  }

  return state;
}

/**
 * Number of `@aws-blocks/core` copies taking part in the shared route registry.
 *
 * `1` for a healthy install. A higher number means the dependency tree carries
 * duplicates — routes still work (the registry is shared), but it is worth
 * reporting in diagnostics.
 *
 * **Internal.** Not re-exported from the package entry point.
 */
export function getLoadedCoreCopies(): number {
  return getState().copies;
}

const VALID_METHODS = new Set<string>(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

/** Prevent further route registration. Call after initialization is complete. */
export function lockRouteRegistry(): void {
  getState().locked = true;
}

/** Re-allow route registration (useful in tests after lock). */
export function unlockRouteRegistry(): void {
  getState().locked = false;
}

/**
 * Register a raw HTTP route for runtime dispatch.
 *
 * **Internal.** The public API is `new RawRoute(scope, id, options)`.
 * Path must be resolved before calling this function.
 *
 * @throws If registration is locked (after handler creation).
 * @throws If the HTTP method is invalid.
 * @throws If the path is under the reserved namespace (`/aws-blocks` or `/aws-blocks/api/*`).
 * @throws {RawRouteErrors.DuplicateRoute} If the same method+path is registered twice.
 */
export function registerRoute(options: RawRouteOptions & { path: string }): void {
  const state = getState();
  if (state.locked) {
    throw new Error('Routes must be registered during initialization. Cannot register routes after handler creation.');
  }

  if (!VALID_METHODS.has(options.method)) {
    throw new Error(`Invalid HTTP method: ${options.method}. Must be one of: ${Array.from(VALID_METHODS).join(', ')}`);
  }

  const normalizedPath = options.path.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  if (normalizedPath === '/') {
    throw new Error("Cannot register RawRoute at '/' — root path is not supported (API Gateway proxy resource doesn't handle root). Use a sub-path like '/health'.");
  }

  const lowerPath = normalizedPath.toLowerCase();
  if (lowerPath === BLOCKS_NAMESPACE || lowerPath === BLOCKS_RPC_PREFIX || lowerPath.startsWith(`${BLOCKS_RPC_PREFIX}/`)) {
    throw new Error(`Cannot register RawRoute at ${BLOCKS_NAMESPACE} or ${BLOCKS_RPC_PREFIX}/* — these paths are reserved for RPC dispatch`);
  }

  const existing = state.routes.find(
    (r) => r.method === options.method && r.path === normalizedPath,
  );
  if (existing) {
    const err = new Error(
      `${RawRouteErrors.DuplicateRoute}: ${options.method} ${normalizedPath} is already registered`,
    );
    err.name = RawRouteErrors.DuplicateRoute;
    throw err;
  }

  const { pattern, paramNames } = compilePath(normalizedPath);

  state.routes.push({
    method: options.method,
    path: normalizedPath,
    pattern,
    paramNames,
    handler: options.handler,
  });
}

/** Return a read-only snapshot of all registered routes. */
export function getRegisteredRoutes(): readonly RegisteredRoute[] {
  return getState().routes;
}

/**
 * Remove all registered routes and unlock registration (used by tests).
 *
 * Leaves the copy counter alone — it tracks module copies, not routes.
 */
export function clearRouteRegistry(): void {
  const state = getState();
  state.routes.length = 0;
  state.locked = false;
}

/**
 * Match an incoming HTTP request against registered routes.
 *
 * @returns The matched route and extracted path parameters, or `null` if no match.
 */
export function matchRoute(
  method: string,
  path: string,
): { route: RegisteredRoute; params: Record<string, string> } | null {
  // Normalize incoming path: collapse double slashes
  path = path.replace(/\/+/g, '/');

  for (const route of getState().routes) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(path);
    if (match) {
      return { route, params: extractParams(route, match) };
    }
    // Retry without trailing slash for non-root paths (e.g. /health/ → /health)
    if (path.length > 1 && path.endsWith('/')) {
      const trimmed = path.slice(0, -1);
      const retryMatch = route.pattern.exec(trimmed);
      if (retryMatch) {
        return { route, params: extractParams(route, retryMatch) };
      }
    }
  }
  return null;
}

function extractParams(route: RegisteredRoute, match: RegExpExecArray): Record<string, string> {
  const params: Record<string, string> = Object.create(null);
  route.paramNames.forEach((name, i) => {
    const raw = match[i + 1];

    if (name === '*') {
      // Wildcards capture raw paths — no decoding (prevents path traversal)
      params[name] = raw;
      return;
    }

    // Named params get decoded
    try {
      params[name] = decodeURIComponent(raw);
    } catch {
      // Invalid percent encoding — use raw value
      params[name] = raw;
    }
  });
  return params;
}

// ── Path compilation ────────────────────────────────────────────────────────

const REGEX_SPECIAL = new Set(['.', '+', '?', '^', '$', '|', '(', ')', '[', ']', '\\']);
const BLOCKED_PARAM_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Compile a path pattern into a RegExp and extract parameter names.
 *
 * Supported syntax:
 * - `/health`        → exact match
 * - `/users/{id}`    → captures one path segment as `id`
 * - `/v1/*`          → captures everything after `/v1/` as `*`
 * - `/a/{x}/b/{y}`   → multiple named parameters
 */
export function compilePath(path: string): { pattern: RegExp; paramNames: string[] } {
  if (!path.startsWith('/')) {
    throw new Error('Path must start with /');
  }

  // Normalize: collapse double slashes
  path = path.replace(/\/+/g, '/');

  // Remove trailing slash (except root '/')
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  const paramNames: string[] = [];
  let regexStr = '';
  let i = 0;
  let wildcardCount = 0;

  while (i < path.length) {
    if (path[i] === '{') {
      const end = path.indexOf('}', i);
      if (end === -1) {
        throw new Error(`Unclosed '{' in path pattern: ${path}`);
      }
      const name = path.substring(i + 1, end);
      if (!name || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        throw new Error(
          `Invalid parameter name '${name}' in path '${path}'. Parameter names must be valid JavaScript identifiers (start with letter or underscore, contain only letters, digits, underscores).`,
        );
      }
      if (BLOCKED_PARAM_NAMES.has(name)) {
        throw new Error(`Parameter name '${name}' is reserved and cannot be used in path '${path}'.`);
      }
      paramNames.push(name);
      regexStr += '([^/]+)';
      i = end + 1;
    } else if (path[i] === '}') {
      throw new Error(`Unexpected '}' without matching '{' in path pattern: ${path}`);
    } else if (path[i] === '*') {
      wildcardCount++;
      if (wildcardCount > 1) {
        throw new Error(
          `Path '${path}' contains multiple wildcards. Only one wildcard (*) is allowed per route, and it must be the last segment.`,
        );
      }
      if (i !== path.length - 1) {
        throw new Error(
          `Path '${path}' contains multiple wildcards. Only one wildcard (*) is allowed per route, and it must be the last segment.`,
        );
      }
      paramNames.push('*');
      regexStr += '(.*)';
      i++;
    } else if (REGEX_SPECIAL.has(path[i])) {
      regexStr += '\\' + path[i];
      i++;
    } else {
      regexStr += path[i];
      i++;
    }
  }

  const fullPattern = '^' + regexStr + '$';
  return { pattern: new RegExp(fullPattern), paramNames };
}
