// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Forwards a native client's `x-blocks-user-agent` token into the outgoing AWS
 * SDK user agent.
 */

import { HttpRequest } from '@smithy/protocol-http';
import type { BuildMiddleware, MiddlewareStack } from '@smithy/types';

const MIDDLEWARE_NAME = 'blocksClientUserAgent';

/** Bounds what the grammar runs against; the emitted token has its own cap. */
const MAX_CLIENT_USER_AGENT_BYTES = 128;

/** Upper bound on the emitted token, keeping the AWS user agent bounded. */
const MAX_CLIENT_USER_AGENT_TOKEN_LENGTH = 48;

/**
 * Token format: `aws-blocks-<lang>/<version>`. The language is 1-16 lowercase
 * alphanumeric characters starting with a letter; version is numeric X.Y.Z with
 * an optional prerelease. The fixed shape blocks injection.
 *
 * Build metadata is accepted but left out of the capture, so pub's `0.1.4+1` is
 * attributed as `0.1.4` rather than dropped or split into a series per build.
 */
const CLIENT_USER_AGENT_PATTERN =
  /^aws-blocks-([a-z][a-z0-9]{0,15})\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Validates the inbound `x-blocks-user-agent` header and returns the
 * `client/<lang>/<version>` token to append. Malformed input is dropped,
 * not thrown.
 *
 * A token over 128 bytes, or an emitted token over 48 characters, is dropped,
 * so unbounded input cannot reach the AWS user agent.
 *
 * @param raw - Raw header value; may be `null` (as `Headers.get()` returns) or omitted.
 * @returns The `client/<lang>/<version>` token, or `undefined` if missing or malformed.
 * @internal Used by the Lambda handler; not public API.
 */
export function validateClientUserAgentToken(raw?: string | null): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  // Space-separated by design, so appended metadata is ignored, not fatal. The
  // cap applies to the token, so metadata length cannot drop a valid one.
  const first = raw.slice(0, MAX_CLIENT_USER_AGENT_BYTES + 1).split(' ')[0];
  if (Buffer.byteLength(first, 'utf8') > MAX_CLIENT_USER_AGENT_BYTES) return undefined;
  const match = CLIENT_USER_AGENT_PATTERN.exec(first);
  if (!match) return undefined;
  const token = `client/${match[1]}/${match[2]}`;
  return token.length <= MAX_CLIENT_USER_AGENT_TOKEN_LENGTH ? token : undefined;
}

declare global {
  var __BLOCKS_REQUEST_CLIENT_USER_AGENT_STORE__:
    | { getStore(): string | undefined }
    | undefined;
}

/**
 * Reads the validated per-request token from the `globalThis` store, or
 * `undefined` if unset. Reading it there avoids importing the Lambda handler
 * that creates it.
 *
 * @internal Used by `installClientUserAgent` and tests.
 */
export function getClientUserAgentToken(): string | undefined {
  const store = globalThis.__BLOCKS_REQUEST_CLIENT_USER_AGENT_STORE__;
  if (!store || typeof store.getStore !== 'function') return undefined;
  return store.getStore();
}

/**
 * Installs the per-request client-user-agent middleware on an SDK v3 client.
 *
 * This is a no-op when the request carries no validated token.
 *
 * @param client - An AWS SDK v3 client.
 *
 * @example
 * ```typescript
 * // Inside a Building Block constructor, after building the client:
 * const client = new DynamoDBClient({ customUserAgent: this.buildUserAgentChain() });
 * installClientUserAgent(client);
 * ```
 */
export function installClientUserAgent<Input extends object, Output extends object>(client: {
  middlewareStack: Pick<MiddlewareStack<Input, Output>, 'add' | 'addRelativeTo' | 'identify'>;
}): void {
  const middleware: BuildMiddleware<Input, Output> =
    (next) =>
      async (args) => {
        const token = getClientUserAgentToken();
        if (token && HttpRequest.isInstance(args.request)) {
          const headers = args.request.headers;
          // SDK v3 (node) sets both UA headers; append to each that is present.
          for (const key of ['user-agent', 'x-amz-user-agent']) {
            if (headers[key]) headers[key] = `${headers[key]} ${token}`;
          }
        }
        return next(args);
      };

  // Anchor after the SDK's own user-agent middleware so the header it builds is
  // only appended to; both sit at `build`, so step and priority alone tie.
  const anchor = 'getUserAgentMiddleware';
  if (client.middlewareStack.identify().some((entry) => entry.split(' - ')[0] === anchor)) {
    client.middlewareStack.addRelativeTo(middleware, {
      name: MIDDLEWARE_NAME,
      relation: 'after',
      toMiddleware: anchor,
      override: true,
    });
    return;
  }

  // The anchor is resolved on every send, so registering relative to a name the
  // stack does not have would fail each request rather than this call.
  client.middlewareStack.add(middleware, {
    name: MIDDLEWARE_NAME,
    step: 'build',
    priority: 'low',
    override: true,
  });
}
