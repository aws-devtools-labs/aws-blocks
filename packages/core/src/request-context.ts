// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Per-request context shared by every HTTP transport (the Lambda handler and the
// container HTTP server): the request-scoped AsyncLocalStorage stores and the
// trusted-forwarded-host gate used when building absolute request URLs.

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * AsyncLocalStorage that carries the inbound HTTP request cookies through
 * the call stack. SSR frameworks (Next.js Server Components) can read this
 * via `requestCookies.getStore()` to forward auth cookies when calling the
 * Blocks API server-side.
 *
 * Also registered on `globalThis.__BLOCKS_REQUEST_COOKIES_STORE__` so the
 * client bundle can access it without importing node:async_hooks.
 */
export const requestCookies = new AsyncLocalStorage<string>();
(globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__ = requestCookies;

/**
 * Per-request store for the validated native-client token. Also registered on
 * `globalThis.__BLOCKS_REQUEST_CLIENT_USER_AGENT_STORE__` so the middleware can
 * read it without importing `node:async_hooks`.
 */
export const requestClientUserAgent = new AsyncLocalStorage<string | undefined>();
(globalThis as any).__BLOCKS_REQUEST_CLIENT_USER_AGENT_STORE__ = requestClientUserAgent;

/**
 * Hostnames that count as loopback for the trusted-forwarded-host gate.
 *
 * `URL.hostname` keeps the brackets on IPv6 literals (`http://[::1]:3000` →
 * `[::1]`), so the set is keyed on the bracketed form.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether an `X-Forwarded-Host` value points at the local loopback interface.
 *
 * The gate matters because the deployed Lambda sits directly behind API Gateway
 * with no trusted proxy to strip this attacker-controllable header — in sandbox
 * *and* production. Honoring it unconditionally would let any client spoof the
 * host the backend builds absolute URLs from (e.g. an OIDC `redirect_uri`). Only
 * loopback is trusted: it's the one case the sandbox dev-server needs, and a
 * forged non-loopback value is ignored.
 *
 * @internal Exported for testing only.
 */
export function isLoopbackForwardedHost(forwardedHost: string | undefined): boolean {
  if (!forwardedHost) return false;
  // Parse via URL so a `host:port` (or bracketed IPv6) value yields a clean
  // hostname with the port stripped. A bare hostname parses fine too.
  let hostname: string;
  try {
    hostname = new URL(`http://${forwardedHost}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return LOOPBACK_HOSTNAMES.has(hostname);
}
