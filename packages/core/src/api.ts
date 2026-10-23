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
 * Symbol under which an `ApiNamespace` exposes a resolver for the compute that
 * hosts it: a function returning that compute, or `undefined` outside CDK synth
 * (the mock/runtime `Scope` has no `compute`).
 *
 * The shared API gateway routes each exported namespace to its compute. It calls
 * the resolver at synth, after the backend module has been imported — not at
 * construction — so routing reflects compute assignments made in any order. The
 * precedence lives here, with the options that define it, so the gateway never
 * needs to know where a namespace's compute comes from: today that is the
 * scope's compute (`scope.compute` — the nearest compute assigned up the scope
 * chain, else the default); a per-namespace compute option, once it exists,
 * takes precedence over it. Routes key on the **export** name (what the client
 * sends and dispatch resolves), not the constructor's `name`.
 *
 * A symbol key, like {@link API_NAMESPACE_MARKER}, so `Object.entries`,
 * `JSON.stringify` and the client/spec generators never see it.
 *
 * @internal
 */
export const API_NAMESPACE_COMPUTE = Symbol.for('blocks:ApiNamespaceCompute');

/** Structural view of a scope that may resolve a compute (only the CDK `Scope` does). */
type ComputeResolvingScope = { compute?: unknown };

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
 * local check and still ships callable by anyone. See the `Auth` README
 * (`@aws-blocks/bb-auth`) for `requireAuth` / `requireRole`.
 *
 * Only the methods the handler's returned object defines (its own properties,
 * including spread-in ones) are callable. Inherited members (`constructor`,
 * `toString`, `__proto__`, …) are never endpoints — calling one returns the
 * same "Method not found" error as an unknown name.
 * 
 * ## Context
 * 
 * The `context` parameter provides access to:
 * - `context.request.headers` - Incoming request headers
 * - `context.request.json()` - Parse request body as JSON
 * - `context.response.headers` - Set response headers (e.g., cookies)
 * - `context.response.status` - Set HTTP status code
 *
 * Every `Set-Cookie` you set or append is delivered, locally and on AWS.
 * If the method then throws, only cookies that are being **deleted**
 * (an integer `Max-Age` of 0 or less, or an `Expires` in the past written as an
 * IMF-fixdate such as `Thu, 01 Jan 1970 00:00:00 GMT`) are delivered with the
 * error — so a method can reject with a 401 *and* clear a session cookie, but a
 * method that signs a user in and then throws (e.g. a post-sign-in policy
 * check) never hands out a live session. Other response headers are not sent
 * with an error.
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
    // How synth-time routing finds this namespace's compute (see
    // API_NAMESPACE_COMPUTE): resolved when called, never here. A scopeless
    // namespace resolves to undefined and routes to the default compute.
    // Signature and returned handler are unchanged.
    handler[API_NAMESPACE_COMPUTE] = () =>
      scope && typeof scope === 'object' ? (scope as ComputeResolvingScope).compute : undefined;
    // biome-ignore lint/correctness/noConstructorReturn: the export IS the tagged handler — dispatch, codegen and routing read it directly.
    return handler;
  }
} as any;

