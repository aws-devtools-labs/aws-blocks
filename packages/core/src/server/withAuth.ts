// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from 'node:async_hooks';

import { ApiError } from '../errors.js';

declare global {
  var __BLOCKS_REQUEST_COOKIES_STORE__: AsyncLocalStorage<string> | undefined;
}

function getSsrCookies(): string | undefined {
  const store = globalThis.__BLOCKS_REQUEST_COOKIES_STORE__;
  if (!store || typeof store.getStore !== 'function') return undefined;
  return store.getStore();
}

/**
 * Get or lazily create the request cookie AsyncLocalStorage.
 *
 * In the API Lambda (and the container HTTP server), `request-context.ts` creates
 * the store and registers it on `globalThis.__BLOCKS_REQUEST_COOKIES_STORE__`. In
 * the SSR Lambda (a separate process), the store may not exist yet — this function
 * creates it on demand.
 *
 * This module is server-only (never bundled for the browser), so direct
 * `node:async_hooks` import is safe — no `webpackIgnore` needed.
 */
function getRequestCookieStore(): AsyncLocalStorage<string> {
  const existing = globalThis.__BLOCKS_REQUEST_COOKIES_STORE__;
  if (existing) return existing;

  const store = new AsyncLocalStorage<string>();
  globalThis.__BLOCKS_REQUEST_COOKIES_STORE__ = store;
  return store;
}

// ---------------------------------------------------------------------------
// Cookie Provider Registry
// ---------------------------------------------------------------------------

/**
 * A function that attempts to detect cookies from a specific framework's
 * request context. Returns the cookie string if available, or `undefined`
 * if the framework is not active or no cookies are present.
 */
export type CookieProvider = () => Promise<string | undefined>;

const providers: Array<{ name: string; detect: CookieProvider }> = [];

/**
 * Register a framework-specific cookie provider for `withAuth()`.
 *
 * Providers are tried in registration order when `withAuth()` is called
 * without explicit cookies. The first provider that returns a non-undefined
 * value wins.
 *
 * Two providers are registered by default:
 *
 * - **Next.js** — reads cookies from `next/headers`. Works out of the box.
 * - **Nuxt/Nitro** — reads cookies from the active Nitro request event
 *   (via the `unctx` `'nitro-app'` async context). Requires
 *   `nitro.experimental.asyncContext: true` in `nuxt.config.ts` so Nitro
 *   wraps each request in an `AsyncLocalStorage` context. Without that
 *   flag the provider returns `undefined` and a warning is emitted on
 *   first miss to point at the missing config (see `withAuth` for the
 *   no-cookies error path).
 *
 * Use this to add support for additional frameworks (SvelteKit, Astro, etc.)
 * or custom cookie sources.
 *
 * @param name - Human-readable provider name (for debugging).
 * @param detect - Async function that returns a cookie string or `undefined`.
 *
 * @example
 * ```typescript
 * import { registerCookieProvider } from '@aws-blocks/blocks/server';
 *
 * // SvelteKit provider
 * registerCookieProvider('sveltekit', async () => {
 *   try {
 *     const { getRequestEvent } = await import('$app/server');
 *     const event = getRequestEvent();
 *     return event?.request.headers.get('cookie') ?? undefined;
 *   } catch {
 *     return undefined;
 *   }
 * });
 * ```
 */
export function registerCookieProvider(name: string, detect: CookieProvider): void {
  const existingIdx = providers.findIndex(p => p.name === name);
  if (existingIdx >= 0) {
    providers[existingIdx] = { name, detect };
  } else {
    providers.push({ name, detect });
  }
}

// Built-in Next.js provider — registered by default
registerCookieProvider('nextjs', async () => {
  try {
    const mod = await import('next/headers');
    const store = await mod.cookies();
    const all = store.getAll();
    if (all.length === 0) return undefined;
    return all.map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return undefined;
  }
});

// Built-in Nuxt/Nitro provider — requires `nitro.experimental.asyncContext: true`
//
// Reads the active request event from Nitro's async context, keyed
// `'nitro-app'` in `unctx`. Nitro's *documented* entry point for this is
// `useEvent()` from `nitropack/runtime` — but we deliberately do NOT use
// it here, and reach into `unctx.getContext('nitro-app')` directly instead.
//
// WHY (do not "fix" this back to `nitropack/runtime`): `@aws-blocks/core`
// is framework-agnostic. `withAuth` is re-exported through
// `@aws-blocks/blocks/server` and gets transitively imported by Next.js
// apps (and any other framework). `nitropack/runtime`'s entrypoint pulls
// in `#nitro-internal-virtual/*` subpath imports that ONLY resolve inside
// a Nitro build — webpack/Next.js can't resolve them and the consumer's
// `next build` fails with "Module not found: Can't resolve
// '#nitro-internal-virtual/error-handler'". `unctx` is a standalone leaf
// utility with no virtual imports, so it bundles cleanly from any
// framework. The documented-vs-internal-key trade-off loses to the
// bundler-safety requirement for a cross-framework package.
//
// Both approaches ride the same experimental async-context machinery and
// both require `experimental.asyncContext: true`. `nitroApp.use()` throws
// when no context instance is bound (the flag-off signature), which we
// distinguish from "not a Nitro app at all" below.
/** Minimal shape of the h3 `H3Event` we read from (Nitro v2 / Nuxt 4). */
type NitroH3Event = { node?: { req?: { headers?: { cookie?: string } } } };

let nuxtAsyncContextWarned = false;
registerCookieProvider('nuxt', async () => {
  let getContext: typeof import('unctx').getContext;
  try {
    ({ getContext } = await import('unctx'));
  } catch {
    return undefined; // unctx not installed → not a Nuxt/Nitro app
  }

  // `getContext('nitro-app')` itself never throws — it lazily creates the
  // context registry. `.use()` is what throws when no instance is bound.
  const nitroAsyncContext = getContext('nitro-app');
  let bound: { event?: NitroH3Event; request?: Request } | undefined;
  try {
    // `.use()` returns the bound NitroApp or throws.
    //
    // TODO(nitro-v3 / nuxt-5): Nitro v3 swaps h3 for srvx, so the bound
    // context shape changes from `{ event }` (h3 `H3Event`, read below via
    // `event.node.req.headers.cookie`) to `{ request }` (a standard Web
    // `Request`, read via `request.headers.get('cookie')`). We read both
    // shapes below so the provider keeps working across the cutover; revisit
    // and drop the h3 branch once Nuxt 5 / Nitro v3 is the floor.
    bound = nitroAsyncContext.use() as typeof bound;
  } catch {
    // In a Nitro runtime but no context bound for this call — almost
    // always `experimental.asyncContext: true` missing from the config.
    // Surface a hint exactly once per process so the developer sees the
    // root cause, not a downstream generic "no cookies" 401. Suppressible
    // via env var for tests / intentional setups.
    if (
      !nuxtAsyncContextWarned &&
      process.env.BLOCKS_SUPPRESS_NUXT_ASYNC_CONTEXT_WARN !== '1'
    ) {
      nuxtAsyncContextWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        '[@aws-blocks/core] withAuth: Nuxt/Nitro detected but the request context is not available. ' +
          "Add `nitro: { experimental: { asyncContext: true } }` to nuxt.config.ts so withAuth() can read cookies from the active request. " +
          'See https://nuxt.com/docs/guide/going-further/experimental-features#asynccontext',
      );
    }
    return undefined;
  }

  // h3 (Nitro v2): cookie lives on the Node request headers.
  // srvx (Nitro v3): cookie lives on the Web `Request` headers. See the
  // TODO above — the `request` branch future-proofs this for Nuxt 5.
  const cookie =
    bound?.event?.node?.req?.headers?.cookie ??
    bound?.request?.headers?.get('cookie') ??
    undefined;
  return typeof cookie === 'string' && cookie.length > 0 ? cookie : undefined;
});

/**
 * Try each registered provider in order; return the first non-undefined result.
 */
async function detectFrameworkCookies(): Promise<string | undefined> {
  for (const provider of providers) {
    const result = await provider.detect();
    if (result) return result;
  }
  return undefined;
}

/**
 * Clear all registered cookie providers, including the built-in Next.js one.
 *
 * Primarily useful for testing. After calling this, you must re-register any
 * providers you need (including Next.js if desired).
 *
 * @example
 * ```typescript
 * import { clearCookieProviders, registerCookieProvider } from '@aws-blocks/blocks/server';
 *
 * // In test setup
 * clearCookieProviders();
 * registerCookieProvider('test', async () => 'session=test');
 * ```
 */
export function clearCookieProviders(): void {
  providers.length = 0;
}

/** @internal Read-only view of registered providers (for testing). */
export function _getProviders(): ReadonlyArray<{ name: string; detect: CookieProvider }> {
  return providers;
}

/**
 * Wraps an async function with authenticated cookie forwarding for SSR.
 *
 * In SSR server components, browser cookies aren't automatically forwarded
 * to API calls. This wrapper reads cookies and makes them available to
 * all Blocks API calls within the callback via `AsyncLocalStorage`.
 *
 * **Resolution order:**
 * 1. Explicit `cookies` parameter (framework-agnostic)
 * 2. Existing request context (Lambda handler already set it up)
 * 3. Registered cookie providers — Next.js and Nuxt are built-in, plus any
 *    you've added via `registerCookieProvider`
 * 4. Throws if no cookies found
 *
 * **Built-in providers:**
 *
 * | Framework | Source | Notes |
 * |-----------|--------|-------|
 * | Next.js | `next/headers` | Works out of the box. |
 * | Nuxt/Nitro | Nitro async context (via `unctx`) | Requires `nitro: { experimental: { asyncContext: true } }` in `nuxt.config.ts`. With the flag off the provider returns `undefined` and emits a one-time warning naming the missing config. |
 *
 * @param fn - Async function containing Blocks API calls that need auth.
 * @param cookies - Optional explicit cookie string. If omitted, auto-detects
 *   from the request context or registered providers. Pass this for frameworks
 *   without a registered provider (or use `registerCookieProvider` to add one).
 * @returns The return value of `fn`.
 *
 * @example
 * ```typescript
 * // Next.js — auto-detects cookies from next/headers (built-in provider)
 * import { withAuth } from '@aws-blocks/blocks/server';
 *
 * const posts = await withAuth(() => api.listMyPosts());
 *
 * // Multiple calls in one scope
 * const data = await withAuth(async () => {
 *   const posts = await api.listMyPosts();
 *   const profile = await api.getProfile();
 *   return { posts, profile };
 * });
 *
 * // Explicit cookies for any framework
 * const posts = await withAuth(
 *   () => api.listMyPosts(),
 *   request.headers.get('cookie'),
 * );
 * ```
 *
 * @example
 * ```typescript
 * // Nuxt — auto-detects cookies via the active Nitro request event
 * // (built-in provider). Requires the experimental.asyncContext flag.
 * //
 * // nuxt.config.ts
 * // export default defineNuxtConfig({
 * //   nitro: { experimental: { asyncContext: true } },
 * // });
 * //
 * // server/api/posts.get.ts
 * import { withAuth } from '@aws-blocks/blocks/server';
 *
 * export default defineEventHandler(async () => {
 *   return withAuth(() => api.listMyPosts());
 * });
 * ```
 *
 * @throws {Error} If no cookies are found and no provider detected them.
 */
export async function withAuth<T>(
  fn: () => Promise<T>,
  cookies?: string | null,
): Promise<T> {
  if (cookies != null && cookies.trim()) {
    const store = getRequestCookieStore();
    return store.run(cookies, fn);
  }

  const existing = getSsrCookies();
  if (existing) {
    return fn();
  }

  const detected = await detectFrameworkCookies();
  if (detected) {
    const store = getRequestCookieStore();
    return store.run(detected, fn);
  }

  const providerNames = providers.map(p => p.name).join(', ');
  throw new ApiError(
    `withAuth: No authentication cookies found. ` +
    `Tried providers: [${providerNames || 'none registered'}]. ` +
    `Ensure the user is logged in and cookies are being forwarded, ` +
    `or pass cookies explicitly as the second argument.`,
    401,
  );
}
