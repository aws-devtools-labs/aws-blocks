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
     *
     * `url.pathname` is the route path: the same for a request under `npm run dev`
     * and on AWS, and never prefixed with the API Gateway stage (e.g. `/prod`).
     * Every front door adds the stage on its way to the gateway, so it is not part
     * of the path the app routes on. To sub-route under a wildcard, use
     * `params['*']`.
     *
     * Behind a front door (e.g. `Hosting`'s CloudFront distribution), `url.origin`
     * is the API Gateway host the backend received, not the browser's. Build public
     * links from the app's own configured origin, not from this URL.
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
 * hosts it. Outside CDK synth it returns `undefined` for a namespace without its
 * own `compute` (the mock/runtime `Scope` has no `compute`), else that compute's
 * inert backing; nothing reads it there.
 *
 * The shared API gateway routes each exported namespace to its compute. It calls
 * the resolver at synth, after the backend module has been imported — not at
 * construction — so routing reflects compute assignments made in any order. The
 * precedence lives here, with the options that define it, so the gateway never
 * needs to know where a namespace's compute comes from: the namespace's own
 * {@link ApiNamespaceOptions.compute} when given, else the scope's compute
 * (`scope.compute` — the nearest compute assigned up the scope chain, else the
 * default). Routes key on the **export** name (what the client sends and
 * dispatch resolves), not the constructor's `name`.
 *
 * A symbol key, like {@link API_NAMESPACE_MARKER}, so `Object.entries`,
 * `JSON.stringify` and the client/spec generators never see it.
 *
 * @internal
 */
export const API_NAMESPACE_COMPUTE = Symbol.for('blocks:ApiNamespaceCompute');

/**
 * Symbol under which an `ApiNamespace` records `true` when it was given its own
 * {@link ApiNamespaceOptions.compute}. The shared API gateway reads it to warn
 * when that compute belongs to another backend, which it can't route to; a
 * compute inherited from the scope is skipped there silently by design.
 *
 * @internal
 */
export const API_NAMESPACE_EXPLICIT_COMPUTE = Symbol.for('blocks:ApiNamespaceExplicitCompute');

/** Structural view of a scope that may resolve a compute (only the CDK `Scope` does). */
type ComputeResolvingScope = { compute?: unknown };

/**
 * Options for an {@link ApiNamespace}.
 */
export interface ApiNamespaceOptions {
  /**
   * The compute this namespace's methods run on. Omit to run on the app's
   * default compute, like every namespace before.
   *
   * Pass a `Compute` block (from `@aws-blocks/blocks`) to give a namespace its
   * own function — for example more memory (and CPU) than the rest of the API,
   * or its own scaling separate from the other namespaces:
   *
   * ```ts
   * const reportsCompute = new Compute(scope, 'reports', { type: 'serverless', memory: 4096 });
   * export const reports = new ApiNamespace(scope, 'reports', (context) => ({ … }), { compute: reportsCompute });
   * ```
   *
   * The TypeScript, Swift, Kotlin and Dart clients call the namespace exactly as
   * before: the shared API gateway routes `/aws-blocks/api/<export name>` to the
   * namespace's compute, on every `apiFrontDoor` tier and behind `Hosting`. A
   * call to the bare `/aws-blocks/api` endpoint — a raw HTTP call, or one from a
   * native client released before per-namespace paths — still runs on the
   * default compute. API calls stay capped at ~29 seconds by
   * the gateway whatever the compute's `maxTimeoutSeconds`; run longer work in an
   * `AsyncJob`. One compute can host several namespaces (and `AsyncJob`s). Only a
   * `serverless` compute can serve API namespaces today. In local dev every
   * namespace still runs in the one dev server process.
   *
   * Typed structurally — anything whose `resolve()` yields a `serverless`
   * compute, which is what a `Compute` block is — so this entry carries no CDK
   * types.
   */
  compute?: { resolve(): { readonly type: 'serverless' } };
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
 * ## Running a namespace on its own compute
 * 
 * Every namespace runs on the app's default compute unless you pass one. Give a
 * namespace its own (for example, more memory) with the `compute` option — the
 * frontend call doesn't change:
 * 
 * ```typescript
 * const reportsCompute = new Compute(scope, 'reports', { type: 'serverless', memory: 4096 });
 * 
 * export const reports = new ApiNamespace(scope, 'reports', (context) => ({
 *   async build(month: string) {
 *     // …
 *   },
 * }), { compute: reportsCompute });
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
 * The functions on the handler's returned object are callable: its own
 * enumerable properties (including spread-in ones) and, for a class instance,
 * methods on its prototype chain (other than names `Object.prototype` defines,
 * unless set as own properties). Members inherited from `Object.prototype`
 * (`toString`, `hasOwnProperty`, …), `constructor`, `__proto__` and
 * non-enumerable own properties are never endpoints — calling one returns the
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
  new <T extends Record<string, (...args: any[]) => any>>(
    scope: ScopeParent,
    name: string,
    handler: ApiHandler<T>,
    options?: ApiNamespaceOptions,
  ): AsyncAPI<T>;
}

export const ApiNamespace: ApiNamespaceConstructor = class ApiNamespace {
  constructor(scope: ScopeParent, name: string, handler: any, options?: ApiNamespaceOptions) {
    handler[API_NAMESPACE_MARKER] = name;
    // How synth-time routing finds this namespace's compute (see
    // API_NAMESPACE_COMPUTE): resolved when called, never here. The namespace's
    // own `compute` wins; otherwise the scope's (nearest assigned, else the
    // default). A scopeless namespace without one resolves to undefined and
    // routes to the default compute. The returned handler is unchanged.
    const compute = options?.compute;
    handler[API_NAMESPACE_COMPUTE] = () =>
      compute
        ? compute.resolve()
        : scope && typeof scope === 'object'
          ? (scope as ComputeResolvingScope).compute
          : undefined;
    if (compute) handler[API_NAMESPACE_EXPLICIT_COMPUTE] = true;
    // biome-ignore lint/correctness/noConstructorReturn: the export IS the tagged handler — dispatch, codegen and routing read it directly.
    return handler;
  }
} as any;

