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
 *
 * ## Frontend hosting: choose the prefix with care
 *
 * When the app also serves a frontend through `Hosting` on the same CloudFront
 * distribution, a route with a path parameter (`/users/{id}`) is fronted by a
 * prefix-wildcard CloudFront behavior (`/users/*`) that captures the **entire**
 * `/users/` subtree and sends it to the API — not just the parameterized route.
 * If the frontend also serves paths under that prefix (an SSR page, a static
 * asset), those requests go to the API instead and break. This is not validated:
 * a frontend has no enumerable route table (it is served through the
 * distribution's default behavior), so a real collision cannot be detected, and a
 * wildcard route is often intentional. Choose a top-level prefix the frontend does
 * not serve (e.g. `/webhooks/{id}`), and prefer exact paths for routes that must
 * not claim a whole subtree.
 */
export class RawRoute extends Scope {
  /** The resolved path this route is registered at. */
  public readonly path: string;

  constructor(scope: ScopeParent, id: string, options: RawRouteOptions) {
    super(id, { parent: scope });
    this.path = resolveRoutePath(scope, id, options);
    // Carry the serving compute's origin so the front door routes this path to it.
    // Resolves to the default compute unless an ancestor scope assigns one.
    const compute = this.compute;
    // Routability guard (mirrors the namespace guard in api-front-door.ts, but at
    // the construction site where the assignment is unambiguous): the default compute
    // always has an endpoint, so a missing one means an ancestor scope assigned this
    // route a compute with no HTTP ingress (a worker-only compute). Fail synth naming
    // the path rather than silently falling back to the default origin, which would
    // answer the route from the wrong compute and mask the misconfiguration.
    if (compute.endpoint === undefined) {
      throw new Error(
        `RawRoute "${this.path}" is assigned to a compute that has no HTTP endpoint, so the front door ` +
          'cannot route to it. Move the route to a scope served by a compute that serves HTTP (the default, ' +
          'or one from `ComputeProvider.provide()`), or remove the assignment.',
      );
    }
    registerRoute({ ...options, path: this.path, endpoint: compute.endpoint });
  }
}
