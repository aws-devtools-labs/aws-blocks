// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export type BlocksContext = any;
export type ApiHandler<T extends Record<string, (...args: any[]) => any>> = any;
import { encodeRpcRequest, decodeRpcResponse } from '../rpc.js';

const IS_SSR = typeof window === 'undefined';

// SSR cookie forwarding: reads from a global AsyncLocalStorage that SSR
// frameworks populate with the inbound request's cookies. The store is
// accessed via a well-known global key so the client bundle never imports
// node:async_hooks (which would break browser/webpack builds).
function getSsrCookies(): string | undefined {
  if (!IS_SSR) return undefined;
  if (typeof globalThis === 'undefined') return undefined;
  const store = (globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__;
  if (!store || typeof store.getStore !== 'function') return undefined;
  return store.getStore();
}

type AsyncAPI<T extends Record<string, (...args: any[]) => any>> = {
  [K in keyof T]: T[K] extends (...args: infer Args) => infer R
    ? (...args: Args) => Promise<Awaited<R>>
    : never;
};

let API_URL: string | null = null;
let apiUrlPromise: Promise<string> | null = null;

async function getApiUrl(): Promise<string> {
  if (API_URL) return API_URL;
  if (apiUrlPromise) return apiUrlPromise;
  apiUrlPromise = resolveApiUrl().catch((err) => {
    // Don't cache failures — config.json may not exist yet during startup
    apiUrlPromise = null;
    throw err;
  });
  return apiUrlPromise;
}

async function resolveApiUrl(): Promise<string> {
  if (API_URL) return API_URL;

  function isInvalidUrl(url: string): boolean {
    if (!url || typeof url !== 'string' || !url.trim()) return true;
    if (url === 'undefined' || url.startsWith('undefined')) return true;
    // Relative URLs (e.g. '/aws-blocks/api') are valid for browser fetch
    if (url.startsWith('/')) return false;
    try {
      const parsed = new URL(url);
      return parsed.hostname === 'undefined' ||
             parsed.pathname === '/undefined' ||
             parsed.pathname.startsWith('/undefined/');
    } catch {
      return true;
    }
  }

  function validateAndCache(url: unknown, source: string): string {
    if (!url || typeof url !== 'string' || isInvalidUrl(url)) {
      throw new Error(
        `Blocks API URL is not configured (source: ${source}). Ensure BLOCKS_API_URL environment variable is set ` +
        'or config.json is deployed. Run with --conditions=cdk during CDK synthesis.',
      );
    }
    API_URL = url;
    return url;
  }

  // 1. SSR Lambda: env vars injected by Hosting construct
  if (typeof process !== 'undefined' && process.env?.BLOCKS_API_URL) {
    const url = process.env.BLOCKS_API_URL;

    // CDK tokens (e.g. ${Token[TOKEN.1228]}) are present at build time but
    // only resolve at CloudFormation deploy time.  If we detect them, the
    // build is running inside `cdk synth` and the URL is not usable yet.
    if (/\$\{Token\[/.test(url)) {
      throw new Error(
        'Blocks API URL contains unresolved CDK tokens. This usually means a ' +
        'Server Component is being statically prerendered during `next build` ' +
        'inside `cdk deploy`.\n' +
        'Fix: add `export const dynamic = \'force-dynamic\';` to any page ' +
        'that calls the Blocks API so Next.js skips prerendering it.',
      );
    }

    const validated = validateAndCache(url, 'env BLOCKS_API_URL');
    console.log('[Blocks] Using API (env BLOCKS_API_URL):', validated);
    return validated;
  }

  // 2. SSR Lambda: full config as JSON env var
  if (typeof process !== 'undefined' && process.env?.BLOCKS_CONFIG) {
    try {
      const config = JSON.parse(process.env.BLOCKS_CONFIG);
      const validated = validateAndCache(config.apiUrl, 'env BLOCKS_CONFIG');
      console.log('[Blocks] Using API (env BLOCKS_CONFIG):', validated);
      return validated;
    } catch {
      // Malformed BLOCKS_CONFIG — fall through
    }
  }

  // 3. Node.js: read config file from filesystem
  if (typeof process !== 'undefined' && process.versions?.node) {
    try {
      const fs = await import(/* webpackIgnore: true */ 'node:fs');
      const config = JSON.parse(fs.readFileSync('.blocks-sandbox/config.json', 'utf-8'));
      const validated = validateAndCache(config.apiUrl, 'config.json file');
      console.log('[Blocks] Using API (config.json file):', validated);
      return validated;
    } catch {
      // Config doesn't exist or not in Node.js
    }
  }
  
  // 4. Browser: fetch config.json from hosting origin
  try {
    const response = await fetch('/.blocks-sandbox/config.json');
    if (response.ok) {
      const config = await response.json();
      const validated = validateAndCache(config.apiUrl, 'config.json fetch');
      console.log('[Blocks] Using API (config.json fetch):', validated);
      return validated;
    }
  } catch {
    // Config doesn't exist
  }
  
  // Fallback — no config found
  throw new Error(
    'Blocks API URL not configured. Ensure:\n' +
    '1. You ran `npm run deploy` (deploys config.json)\n' +
    '2. SSR Lambda has BLOCKS_API_URL env var, OR\n' +
    '3. config.json exists at /.blocks-sandbox/config.json'
  );
}

// --- Middleware ---

/**
 * A Blocks request object passed through middleware before being sent.
 * Middleware can inspect or modify any of these properties before the
 * request is dispatched to the server.
 */
export interface BlocksRequest {
  /** The namespace name this call targets (e.g., 'api', 'auth'). Corresponds to the second argument of `new ApiNamespace(scope, name, handler)` in the backend. */
  apiNamespace: string;
  /** The method being called on the namespace (e.g., 'getUser', 'kvSet'). */
  method: string;
  /** The arguments passed to the method call. */
  args: any[];
  /** HTTP headers that will be sent with the request. Middleware can add or modify headers (e.g., inject auth tokens). */
  headers: Record<string, string>;
}

/**
 * Client middleware that can process requests before they are sent
 * and/or responses after they are received. Both hooks are optional.
 *
 * ```typescript
 * // Request middleware — inject auth token
 * registerMiddleware({
 *   onRequest(req) {
 *     req.headers['authorization'] = `Bearer ${getToken()}`;
 *   }
 * });
 *
 * // Response middleware — hydrate transferable descriptors
 * registerMiddleware({
 *   onResponse(data) {
 *     if (isMyDescriptor(data)) return hydrate(data);
 *     return data;
 *   }
 * });
 * ```
 */
export interface BlocksMiddleware {
  /** Transform the request before it's sent. Modify the request in place or return a new one. Can be async. */
  onRequest?: (request: BlocksRequest) => BlocksRequest | void | Promise<BlocksRequest | void>;
  /** Transform the response data after it's received. Used to hydrate __blocks descriptors. */
  onResponse?: (data: unknown) => unknown;
}

const middlewares: BlocksMiddleware[] = [];

/**
 * Register client middleware for request/response processing.
 *
 * Building Block middleware packages call this on import to register
 * hooks that run on every API call. Request hooks can inject headers
 * (e.g., auth tokens). Response hooks hydrate `{ __blocks: '...' }`
 * descriptors into live client-side objects (e.g., WebSocket channels).
 *
 * Client middleware uses a **self-registering** pattern: the middleware
 * module imports this function and calls it as a side effect of being
 * imported. The generated `client.js` simply includes
 * `import 'bb-realtime/mock-middleware'` — no explicit registration
 * code is needed. This is idiomatic for browser/bundler contexts where
 * side-effect imports are standard (similar to CSS imports or polyfills).
 *
 * This differs intentionally from **dev server attachments**, which use
 * an explicit `attach(server)` pattern because they need the HTTP server
 * instance passed to them — something unavailable at import time.
 */
export function registerMiddleware(middleware: BlocksMiddleware): void {
  middlewares.push(middleware);
}

async function processRequest(request: BlocksRequest): Promise<BlocksRequest> {
  for (const mw of middlewares) {
    if (mw.onRequest) {
      const result = await mw.onRequest(request);
      if (result) request = result;
    }
  }
  return request;
}

function processResponse(data: unknown): unknown {
  for (const mw of middlewares) {
    if (mw.onResponse) {
      data = mw.onResponse(data);
    }
  }
  return data;
}

/**
 * Options for `ApiNamespaceClient`.
 */
export interface ApiNamespaceClientOptions {
  /** Explicit API URL. When provided, skips automatic config.json discovery. */
  url?: string;
}

/**
 * Client-side API proxy. Creates a typed proxy that sends method calls
 * to the backend API over HTTP and hydrates Transferable descriptors
 * in responses via registered middleware.
 *
 * This is the browser counterpart of the server-side `ApiNamespace` in
 * `core/api.ts`. The generated `client.js` emits one of these per
 * API namespace exported from the backend.
 *
 * ```typescript
 * // Generated client.js
 * import { ApiNamespaceClient } from '@aws-blocks/core/client';
 * export const api = ApiNamespaceClient('api');
 *
 * // Frontend usage — fully typed via the 'aws-blocks' types export
 * import { api } from 'aws-blocks';
 * const user = await api.getUser('123');
 * ```
 */
export function ApiNamespaceClient<T extends Record<string, (...args: any[]) => any>>(
  name: string,
  options?: ApiNamespaceClientOptions,
): AsyncAPI<T> {
  const urlOverride = options?.url;
  return new Proxy({} as any, {
    get(target, method: string | symbol) {
      if (typeof method === 'symbol') return undefined;
      return async (...args: any[]) => {
        const apiUrl = urlOverride ?? await getApiUrl();
        
        let request: BlocksRequest = {
          apiNamespace: name,
          method,
          args,
          headers: { 'Content-Type': 'application/json' },
        };
        request = await processRequest(request);

        // SSR cookie forwarding: when running server-side, forward the
        // inbound request cookies so auth sessions propagate to API calls.
        // Deduplicates by cookie name — existing cookies (from middleware)
        // take precedence over SSR-forwarded ones.
        const ssrCookies = getSsrCookies();
        if (ssrCookies) {
          const existingKey = 'Cookie' in request.headers ? 'Cookie' : 'cookie' in request.headers ? 'cookie' : null;
          const existing = existingKey ? request.headers[existingKey] : undefined;
          if (existingKey && existingKey !== 'Cookie') {
            delete request.headers[existingKey];
          }
          if (existing) {
            const existingNames = new Set(
              existing.split(';').filter(Boolean).map((c: string) => c.trim().split('=')[0])
            );
            const newCookies = ssrCookies
              .split(';')
              .filter(Boolean)
              .filter((c: string) => !existingNames.has(c.trim().split('=')[0]))
              .join('; ');
            request.headers['Cookie'] = newCookies
              ? `${existing}; ${newCookies}`
              : existing;
          } else {
            request.headers['Cookie'] = ssrCookies;
          }
        }
        
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: request.headers,
          credentials: 'include',
          body: encodeRpcRequest(request.apiNamespace, request.method, request.args),
        });
        
        const rpcBody = await response.json();
        const result = decodeRpcResponse(rpcBody); // throws ApiError on RPC error
        return processResponse(result);
      };
    }
  });
}

export { ApiError, isBlocksError, hasAuthError } from '../errors.js';
export { Scope, type ScopeOptions } from '../common/index.js';
