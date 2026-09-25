// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope } from './cdk/index.js';
import type { ScopeParent } from './common/index.js';
import { registerRoute, resolveRoutePath, type RawRouteOptions } from './raw-route.js';

export { RawRouteErrors, type RawRouteOptions, type HttpMethod } from './raw-route.js';

/**
 * Raw HTTP route Building Block (CDK).
 *
 * Provides raw HTTP endpoints with full request/response control, beyond the
 * default RPC-only `POST /api` pattern. Routes are dispatched by the Lambda
 * handler and dev server based on HTTP method + path pattern matching.
 *
 * ## Path
 *
 * When `path` is provided, it is used exactly as given. When omitted, the
 * path is derived from the scope-chain IDs (excluding the root BlocksStack):
 *
 * ```typescript
 * // Explicit path — used as-is
 * new RawRoute(scope, 'health', { method: 'GET', path: '/health', handler });
 *
 * // Derived path — scope chain determines the URL
 * new RawRoute(scope, 'health', { method: 'GET', handler });
 * // If scope is the top-level Scope('my-app'), path becomes /health
 * ```
 *
 * **Caution:** Changing the construct tree structure changes derived URLs.
 * Use explicit paths for routes that must remain stable.
 *
 * ## Path syntax (when explicit)
 *
 * - `/health`       — exact match
 * - `/users/{id}`   — named path parameter (captures one segment)
 * - `/v1/*`         — wildcard (captures everything after prefix)
 *
 * ## How it works
 *
 * - At construction time, the route is registered in a global registry.
 * - The Lambda handler and dev server check the registry before falling through to RPC dispatch.
 * - The CDK side only validates the route (duplicate detection). No additional AWS resources
 *   are created — the existing catch-all API Gateway proxy routes all paths to the Lambda.
 */
export class RawRoute extends Scope {
  /** The resolved path this route is registered at. */
  public readonly path: string;

  constructor(scope: ScopeParent, id: string, options: RawRouteOptions) {
    super(id, { parent: scope, frameworkScope: true });
    this.path = resolveRoutePath(scope, id, options);
    registerRoute({ ...options, path: this.path });
  }
}
