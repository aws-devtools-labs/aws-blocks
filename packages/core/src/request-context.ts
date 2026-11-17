// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Per-request context shared by every HTTP transport (the Lambda handler and the
// container HTTP server): the request-scoped AsyncLocalStorage stores and the
// trusted-forwarded-host gate used when building absolute request URLs.

import { AsyncLocalStorage } from 'node:async_hooks';
import { PUBLIC_HOSTS_CONFIG_KEY } from './constants.js';

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
 * Per-invocation store for the id of the request being handled: the Lambda
 * `awsRequestId` while `createLambdaHandler` runs an invocation. Building Blocks
 * read it through {@link currentRequestId} to tag their output (bb-logger adds it
 * to every log line), so everything one request logs can be correlated.
 *
 * Registered on `globalThis.__BLOCKS_REQUEST_ID_STORE__` and read from there, so
 * a Building Block that resolves its own copy of `@aws-blocks/core` still sees
 * the store the handler populated.
 */
const REQUEST_ID_STORE_KEY = '__BLOCKS_REQUEST_ID_STORE__';
const globalStores = globalThis as unknown as Record<string, unknown>;
const isStore = (value: unknown): value is AsyncLocalStorage<string | undefined> =>
  typeof (value as { getStore?: unknown } | undefined)?.getStore === 'function' &&
  typeof (value as { run?: unknown } | undefined)?.run === 'function';
const existingRequestIdStore = globalStores[REQUEST_ID_STORE_KEY];
// Reuse the store another copy of core registered; anything else at the key is replaced.
export const requestIdStore: AsyncLocalStorage<string | undefined> = isStore(existingRequestIdStore)
  ? existingRequestIdStore
  : new AsyncLocalStorage<string | undefined>();
globalStores[REQUEST_ID_STORE_KEY] = requestIdStore;

/**
 * The id of the request being handled, or `undefined` outside one. On AWS
 * Lambda this is the invocation's `awsRequestId` (the id in the function's
 * `START`/`END`/`REPORT` log lines). The local dev server sets none.
 *
 * Exported for Building Block authors from `@aws-blocks/core/bb-utils`.
 */
export function currentRequestId(): string | undefined {
  const id = requestIdStore.getStore();
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

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

/**
 * The parsed {@link PUBLIC_HOSTS_CONFIG_KEY} list, re-parsed only when the variable
 * changes: exact hosts, and the `.example.com` suffix of each wildcard alias
 * (`*.example.com`).
 */
let publicHosts: { raw: string; exact: ReadonlySet<string>; wildcardSuffixes: readonly string[] } | undefined;

/** One DNS label: letters, digits and inner hyphens, at most 63 characters. */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The front-door host a request names in `PUBLIC_HOST_HEADER`, when it is one of
 * the backend's own CloudFront front-door hosts (the `BLOCKS_PUBLIC_HOSTS` config
 * the doors register at synth); otherwise `undefined`.
 *
 * The header itself proves nothing: the door stamps it, overwriting the viewer's
 * copy, but the gateway behind the door is reachable directly. Checking it against
 * the backend's own hosts is what makes it safe to build absolute URLs from — a
 * forged value can only name another of the app's own domains. One host only,
 * compared case-insensitively; a list, a port or anything else is not taken.
 *
 * A wildcard alias (`*.example.com`) covers what CloudFront serves for it: any
 * hostname ending in `.example.com`, at any depth, but not `example.com` itself.
 * Such a host must be a plain DNS name (letters, digits, hyphens and dots).
 *
 * @internal Exported for testing only.
 */
export function trustedPublicHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const raw = process.env[PUBLIC_HOSTS_CONFIG_KEY];
  if (!raw) return undefined;
  if (publicHosts?.raw !== raw) {
    const exact = new Set<string>();
    const wildcardSuffixes: string[] = [];
    for (const entry of raw.split(',')) {
      const host = entry.trim().toLowerCase();
      if (host.startsWith('*.')) wildcardSuffixes.push(host.slice(1));
      else if (host !== '') exact.add(host);
    }
    publicHosts = { raw, exact, wildcardSuffixes };
  }
  const host = value.toLowerCase();
  if (publicHosts.exact.has(host)) return host;
  const covered = publicHosts.wildcardSuffixes.some((suffix) => host.length > suffix.length && host.endsWith(suffix));
  return covered && host.split('.').every((label) => DNS_LABEL.test(label)) ? host : undefined;
}
