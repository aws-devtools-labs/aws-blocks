// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Forwards a native client's `x-blocks-user-agent` token into the outgoing AWS
 * SDK user agent.
 */

/**
 * Header name carrying the native-client token on the RPC hop. A custom header,
 * not `User-Agent`, because browsers forbid scripts from setting `User-Agent`.
 *
 * @internal Read by the Lambda handler; not public API.
 */
export const CLIENT_USER_AGENT_HEADER = 'x-blocks-user-agent';

/** Defensive cap on header length (characters), applied before parsing. */
const MAX_CLIENT_USER_AGENT_LENGTH = 128;

/**
 * Full-string grammar for the `aws-blocks-<lang>/<version>` token; the fixed
 * shape blocks injection.
 */
const CLIENT_USER_AGENT_PATTERN =
  /^aws-blocks-([a-z][a-z0-9]{0,15})\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;

/**
 * Validates the inbound `x-blocks-user-agent` header and returns the
 * `client/<lang>/<version>` token to append. Malformed input is dropped,
 * not thrown.
 *
 * @param raw - Raw header value; may be `null` (as `Headers.get()` returns) or omitted.
 * @returns The `client/<lang>/<version>` token, or `undefined` if missing or malformed.
 * @internal Used by the Lambda handler; not public API.
 */
export function validateClientUserAgentToken(raw?: string | null): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (raw.length === 0 || raw.length > MAX_CLIENT_USER_AGENT_LENGTH) return undefined;
  const match = CLIENT_USER_AGENT_PATTERN.exec(raw);
  return match ? `client/${match[1]}/${match[2]}` : undefined;
}

declare global {
  var __BLOCKS_REQUEST_CLIENT_USER_AGENT_STORE__:
    | { getStore(): string | undefined }
    | undefined;
}

/**
 * Reads the validated per-request token from the `globalThis` store (not
 * `node:async_hooks`, to stay browser- and mock-safe), or `undefined` if unset.
 *
 * @internal Used by `installClientUserAgent` and tests.
 */
export function getClientUserAgentToken(): string | undefined {
  const store = globalThis.__BLOCKS_REQUEST_CLIENT_USER_AGENT_STORE__;
  if (!store || typeof store.getStore !== 'function') return undefined;
  return store.getStore();
}

function hasHeaders(request: unknown): request is { headers: Record<string, string> } {
  return (
    request !== null &&
    typeof request === 'object' &&
    'headers' in request &&
    typeof (request as any).headers === 'object' &&
    (request as any).headers !== null
  );
}

/**
 * Installs the per-request client-user-agent middleware on an AWS SDK v3 client.
 *
 * @param client - An AWS SDK v3 client (anything with a `middlewareStack`).
 */
export function installClientUserAgent(client: {
  // `add` takes `any`: the SDK v3 `MiddlewareStack.add` is overloaded, so no
  // single structural type fits every client.
  middlewareStack: { add: (middleware: any, options: any) => void };
}): void {
  client.middlewareStack.add(
    (next: (args: { request?: unknown }) => Promise<unknown>) =>
      async (args: { request?: unknown }): Promise<unknown> => {
        const token = getClientUserAgentToken();
        if (token && hasHeaders(args.request)) {
          const headers = args.request.headers;
          const key = 'user-agent' in headers ? 'user-agent' : 'x-amz-user-agent';
          if (headers[key]) headers[key] = `${headers[key]} ${token}`;
        }
        return next(args);
      },
    { step: 'build', priority: 'low', name: 'blocksClientUserAgent' },
  );
}
