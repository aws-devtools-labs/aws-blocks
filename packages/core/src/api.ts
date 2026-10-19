// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export type BlocksContext = {
  request: {
    headers: Headers;
    body: ReadableStream<Uint8Array> | null;
    json: () => Promise<any>;
    text: () => Promise<string>;
    /**
     * Absolute URL of the incoming request. Built from the request's `host`
     * header plus the path + query string. Useful for RawRoute handlers
     * that need query-string parsing or must echo the request URL back
     * (e.g., building OIDC redirect URIs).
     *
     * In dev: derived from `req.url` and `req.headers.host`.
     * In AWS: derived from `event.path`, `event.queryStringParameters`,
     * and `event.headers.host`. May include a trusted `x-forwarded-proto`
     * to pick http vs https.
     */
    url: URL;
    /**
     * Path parameters extracted from RawRoute patterns.
     * Example: route `/users/{id}` with request `/users/123` → `{ id: '123' }`.
     *
     * Only populated for RawRoute handlers. Always `{}` for RPC API methods.
     */
    params: Record<string, string>;
    /**
     * Abort signal tied to the HTTP deadline guard.
     *
     * Fires when the Lambda is about to return a 504 timeout response.
     * Pass this to `fetch()`, AWS SDK calls, or any cancellable I/O so
     * in-flight work is cancelled rather than continuing to run (and bill)
     * after the client has already received a timeout.
     *
     * `undefined` in local dev or when no deadline is configured.
     */
    signal?: AbortSignal;
  };
  response: {
    headers: Headers;
    status: number;
    send: (body: any) => void;
  };
};

export type ApiHandler<T extends Record<string, (...args: any[]) => any>> = (context: BlocksContext) => T;

// Map all methods to return Promises
type AsyncAPI<T extends Record<string, (...args: any[]) => any>> = {
  [K in keyof T]: T[K] extends (...args: infer Args) => infer R
    ? (...args: Args) => Promise<Awaited<R>>
    : never;
};

/** Marker symbol to identify ApiNamespace instances during discovery. */
export const API_NAMESPACE_MARKER = Symbol.for('blocks:ApiNamespace');

import type { ScopeParent } from './common/index.js';

/**
 * Structural view of a scope that resolves a compute carrying a recordable
 * namespace list. Only the CDK `Scope` satisfies this at runtime (via its
 * `compute` getter); in the mock/runtime bundles the property is absent.
 */
type ComputeResolvingScope = { compute?: { namespaces?: string[] } };

/**
 * Record this namespace on its resolved compute so request routing can later
 * map a namespace to the compute that hosts it.
 *
 * CDK-synth concern only: in the CDK bundle `scope.compute` resolves to the
 * namespace's compute (the stack default today), and we append the name to its
 * `namespaces` list. In the mock/runtime bundles — or a scopeless test — the
 * property is absent, so `scope.compute` is `undefined` and this is a silent
 * no-op. The public `ApiNamespace` signature is unchanged; this is a purely
 * internal side effect.
 *
 * No `try/catch`: `BlocksBackend.create()` initializes the default compute
 * before it imports the backend module that constructs any `ApiNamespace`, so
 * the `compute` getter always resolves at this call site. If it ever threw
 * here it would signal a genuine lifecycle violation (an `ApiNamespace` built
 * before `create()` resolved), which should surface rather than be swallowed.
 */
function recordNamespaceOnCompute(scope: ScopeParent | null | undefined, name: string): void {
  // An API created without a Scope stays unrecorded and routes to the
  // default compute.
  if (!scope || typeof scope !== 'object') return;
  const compute = (scope as ComputeResolvingScope).compute;
  // Guard against duplicates so `namespaces` stays a set of names: a namespace
  // could otherwise be recorded twice (e.g. a re-imported module during synth).
  if (compute && Array.isArray(compute.namespaces) && !compute.namespaces.includes(name)) {
    compute.namespaces.push(name);
  }
}

/**
 * Define a type-safe API namespace that works seamlessly between frontend and backend.
 * 
 * ## Usage
 * 
 * Define your API in the backend (`aws-blocks/index.ts`):
 * 
 * ```typescript
 * const scope = new Scope('my-app');
 * 
 * export const api = new ApiNamespace(scope, 'api', (context) => ({
 *   async greet(name: string) {
 *     return { message: `Hello, ${name}!` };
 *   },
 *   
 *   async deleteAccount(id: string) {
 *     // Gated: throws 401 if the caller has no valid session.
 *     await auth.requireAuth(context);
 *     return db.users.delete(id);
 *   }
 * }));
 * ```
 * 
 * Import and call from the frontend with full type safety:
 * 
 * ```typescript
 * import { api } from 'aws-blocks';
 * 
 * const result = await api.greet('World'); // Fully typed
 * ```
 * 
 * ## Authentication — every method is a public endpoint
 * 
 * Each method becomes a public, internet-reachable RPC endpoint with **no
 * authentication by default**. Gating is opt-in per method by calling an auth
 * Building Block at the top of the handler:
 * 
 * ```typescript
 * export const api = new ApiNamespace(scope, 'api', (context) => ({
 *   // No requireAuth call → callable by anyone.
 *   async listPublicPosts() {
 *     return db.posts.findPublished();
 *   },
 * 
 *   async createPost(input: NewPost) {
 *     const user = await auth.requireAuth(context);
 *     return db.posts.create({ ...input, authorId: user.userId });
 *   },
 * 
 *   async deletePost(id: string) {
 *     await auth.requireRole(context, 'admins');
 *     return db.posts.delete(id);
 *   },
 * }));
 * ```
 * 
 * The local mock applies no auth either, so an ungated method passes every
 * local check and still ships callable by anyone. See your auth block's README
 * (e.g. `@aws-blocks/bb-auth-cognito`) for `requireAuth` / `requireRole`.
 * 
 * ## Context
 * 
 * The `context` parameter provides access to:
 * - `context.request.headers` - Incoming request headers
 * - `context.request.json()` - Parse request body as JSON
 * - `context.response.headers` - Set response headers (e.g., cookies)
 * - `context.response.status` - Set HTTP status code
 * 
 * ## Local vs Deployed
 * 
 * - **Local**: APIs run in-process. Calls are direct function invocations.
 * - **Deployed**: APIs run in Lambda. Calls go through API Gateway over HTTPS.
 * 
 * The same code works in both environments without changes.
 * 
 * ## Scaling Characteristics (AWS)
 * 
 * - Serverless: Auto-scales from 0 to thousands of concurrent requests
 * - Cold starts: ~100-500ms for first request after idle period
 * - Warm requests: Single-digit millisecond overhead
 * - Cost: Pay per request (free tier: 1M requests/month)
 * 
 * ## Best Practices
 * 
 * - No auth by default — gate methods with `requireAuth`/`requireRole` (see above)
 * - Keep API methods focused and single-purpose
 * - Use async/await for all I/O operations
 * - Return serializable data (JSON-compatible types)
 * - Handle errors explicitly - they'll be sent to the client
 * - Use Building Blocks (KVStore, DistributedTable) for state
 */
export interface ApiNamespaceConstructor {
  new <T extends Record<string, (...args: any[]) => any>>(scope: ScopeParent, name: string, handler: ApiHandler<T>): AsyncAPI<T>;
}

export const ApiNamespace: ApiNamespaceConstructor = class ApiNamespace {
  constructor(scope: ScopeParent, name: string, handler: any) {
    handler[API_NAMESPACE_MARKER] = name;
    // Record the namespace → compute association for per-compute routing.
    // No-op outside CDK synth. Signature and returned handler are unchanged.
    recordNamespaceOnCompute(scope, name);
    return handler;
  }
} as any;

