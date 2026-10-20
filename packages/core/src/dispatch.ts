// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Transport-neutral HTTP dispatch: CORS, preflight, RawRoute matching and
// JSON-RPC. The Lambda handler and the container HTTP server are thin adapters
// that translate their native request into a `DispatchRequest` and the
// `DispatchResponse` back, so both transports run identical dispatch logic.
// Transport-only details stay in the adapters: the Lambda handler's 504 timeout
// guard and how its payload format carries `Set-Cookie`, the container's
// body-size limit.

import { CLIENT_USER_AGENT_HEADER, isRpcPath } from './constants.js';
import { buildCorsHeaders, CORS_MAX_AGE, corsRejection, getCorsPatterns, isOriginAllowed } from './cors.js';
import { getLoadedCoreCopies, getRegisteredRoutes, matchRoute } from './raw-route.js';
import type { RegisteredRoute } from './raw-route.js';
import { requestClientUserAgent, requestCookies } from './request-context.js';
import {
  errorResponseFromCatch,
  methodNotFoundResponse,
  parseRpcRequest,
  rawRouteErrorFromCatch,
  successResponse,
} from './rpc.js';
import { resolveApiMethod, resolveApiNamespace } from './rpc-dispatch.js';
import { validateClientUserAgentToken } from './server/client-user-agent.js';
import { errorResponseSetCookies } from './set-cookie.js';

/**
 * An inbound HTTP request, already decoded by its transport adapter.
 *
 * `headers`, `url` and `body` are factories rather than values so each is built
 * (and could fail) exactly where the Lambda handler always built it: only on the
 * RawRoute and RPC paths, never for a CORS rejection, preflight or 404.
 *
 * @internal
 */
export interface DispatchRequest {
  /** HTTP method, upper case. */
  method: string;
  /** Routing path: no API Gateway stage prefix, no query string. */
  path: string;
  /** `Origin` request header, `''` when absent. */
  origin: string;
  /** `Cookie` request header, `''` when absent. */
  cookie: string;
  /** Raw (unvalidated) `x-blocks-user-agent` request header. */
  clientUserAgent: string | undefined;
  /** Builds the request headers handed to handlers as `ctx.request.headers`. */
  headers: () => Headers;
  /** Builds the absolute, externally visible request URL (`ctx.request.url`). */
  url: () => URL;
  /** The decoded body (`text` is `''` and `stream` is `null` when absent). Called at most once. */
  body: () => DispatchRequestBody;
  /** Fires when the transport gives up on the request (timeout, client gone). */
  signal?: AbortSignal;
}

/** @internal */
export interface DispatchRequestBody {
  text: string;
  stream: ReadableStream<Uint8Array> | null;
}

/** @internal */
export interface DispatcherOptions {
  /** Prefix of the log line for an RPC method that throws. Default `'RPC Error:'`. */
  rpcErrorLabel?: string;
}

/**
 * Which dispatch path produced a response. Adapters use it to keep any
 * transport-specific envelope details (e.g. how API Gateway carries `Set-Cookie`).
 * `'rpc-result'` is an RPC method's return value; `'rpc'` is every other RPC
 * envelope (a malformed request, an unknown method, a thrown error).
 *
 * @internal
 */
export type DispatchResponseKind = 'cors-rejected' | 'preflight' | 'not-found' | 'raw-route' | 'rpc-result' | 'rpc';

/**
 * A response ready to be written by the transport adapter.
 *
 * @internal
 */
export interface DispatchResponse {
  kind: DispatchResponseKind;
  status: number;
  /** Response headers, excluding `Set-Cookie`. */
  headers: Record<string, string>;
  /** `Set-Cookie` values, one per cookie. */
  cookies: string[];
  body: string;
}

/** @internal */
export type Dispatcher = (request: DispatchRequest) => Promise<DispatchResponse>;

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0',
} as const;

/**
 * Create the dispatcher for a backend module (the app's `aws-blocks/index.ts`).
 *
 * Handles, in order: cross-origin rejection, `OPTIONS` preflight, RawRoute
 * dispatch for any path outside `/aws-blocks/api`, and JSON-RPC for the
 * `/aws-blocks/api` subtree. Request cookies and the validated client user agent
 * are available to handlers through {@link requestCookies} /
 * {@link requestClientUserAgent} for the duration of the call.
 *
 * @internal
 */
export function createDispatcher(backend: unknown, options: DispatcherOptions = {}): Dispatcher {
  const rpcErrorLabel = options.rpcErrorLabel ?? 'RPC Error:';
  return async (request) => {
    const { origin, method: httpMethod } = request;
    const corsHeaders = buildCorsHeaders(origin);

    // Reject cross-origin requests from disallowed origins
    const patterns = getCorsPatterns();
    if (origin && patterns && !isOriginAllowed(origin)) {
      const rejection = corsRejection();
      return { kind: 'cors-rejected', status: rejection.statusCode, headers: rejection.headers, cookies: [], body: rejection.body };
    }

    // Handle OPTIONS preflight
    if (httpMethod === 'OPTIONS') {
      return {
        kind: 'preflight',
        status: 200,
        headers: {
          ...corsHeaders,
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': `Content-Type, Authorization, ${CLIENT_USER_AGENT_HEADER}`,
          'Access-Control-Max-Age': CORS_MAX_AGE,
        },
        cookies: [],
        body: '',
      };
    }

    // Store the inbound request cookies in AsyncLocalStorage so downstream code
    // (e.g. the Blocks client making server-side API calls during SSR) can forward
    // them automatically. Wraps both RawRoute and RPC handling so any handler that
    // calls Blocks APIs server-side gets forwarded cookies.
    //
    // Validate the attacker-controlled user-agent header before storing, so
    // malformed input never reaches the AWS user agent.
    const clientUserAgent = validateClientUserAgentToken(request.clientUserAgent);

    return requestCookies.run(request.cookie, () =>
      requestClientUserAgent.run(clientUserAgent, async (): Promise<DispatchResponse> => {
    // RawRoute dispatch — check path-based routes before falling through to RPC.
    // The whole `/aws-blocks/api` subtree (the bare path and every per-namespace
    // `/aws-blocks/api/{ns}` path) is RPC: dispatch takes the namespace from the
    // JSON-RPC body, and a per-namespace path must name the same one (see
    // parseRpcRequest), so skip RawRoute matching for it and fall through to RPC
    // handling below.
    const requestPath = request.path;
    if (!isRpcPath(requestPath)) {
      const matched = matchRoute(httpMethod, requestPath);
      if (matched) {
        return dispatchRawRoute(request, matched.route, matched.params, corsHeaders);
      }
      // No RawRoute matched and the path is not under the RPC endpoint — 404.
      // Log it: an unmatched route used to be entirely silent, which is what
      // made a split route registry (duplicate @aws-blocks/core copies)
      // undiagnosable from CloudWatch alone. The path is already in the front
      // door's access logs, so this adds no new category of data.
      const copies = getLoadedCoreCopies();
      const copiesNote = copies > 1 ? ` — ${copies} copies of @aws-blocks/core are loaded` : '';
      console.error(
        `No RawRoute matched ${httpMethod} ${requestPath} (${getRegisteredRoutes().length} routes registered)${copiesNote}`,
      );
      return {
        kind: 'not-found',
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
        },
        cookies: [],
        body: JSON.stringify({ error: 'Not Found' }),
      };
    }

    const rpcHeaders = {
      'Content-Type': 'application/json',
      ...corsHeaders,
      ...NO_STORE_HEADERS,
    };
    const rpcEnvelope = (body: string): DispatchResponse => ({ kind: 'rpc', status: 200, headers: rpcHeaders, cookies: [], body });

    const { text: bodyText, stream: bodyStream } = request.body();
    // The path is validated against the body's namespace (see parseRpcRequest);
    // dispatch always uses the body's `namespace.method`.
    const parsed = parseRpcRequest(bodyText, { pathname: requestPath });

    if (!parsed.ok) {
      return rpcEnvelope(parsed.response);
    }

    const { apiNamespace, method, args, id: rpcId } = parsed.request;

    // Declared outside the try so the error path can still deliver cookies the
    // method set before throwing (e.g. clearing a dead session on a 401).
    let responseHeaders: Headers | undefined;

    try {
      const headers = request.headers();

      let responseStatus = 200;
      responseHeaders = new Headers(rpcHeaders);
      let responseBody: any;

      const context = {
        request: {
          headers,
          body: bodyStream,
          json: async () => JSON.parse(bodyText),
          text: async () => bodyText,
          url: request.url(),
          params: {},
          signal: request.signal,
        },
        response: {
          headers: responseHeaders,
          get status() { return responseStatus; },
          set status(code: number) { responseStatus = code; },
          send: (body: any) => { responseBody = body; },
        },
      };

      // Get the API by export name. resolveApiNamespace refuses exported Building
      // Block instances and `_`-private exports, so only an API surface is callable.
      const apiHandler = resolveApiNamespace(backend, apiNamespace);
      if (!apiHandler) {
        return rpcEnvelope(methodNotFoundResponse(`API '${apiNamespace}' not found`, rpcId));
      }

      // Call the handler to get methods
      const apiMethods = typeof apiHandler === 'function'
        ? apiHandler(context)
        : apiHandler;

      // Own/declared callable methods only — never an inherited Object.prototype member.
      const apiMethod = resolveApiMethod(apiMethods, method);
      if (!apiMethod) {
        return rpcEnvelope(methodNotFoundResponse(`'${method}' on API '${apiNamespace}'`, rpcId));
      }

      const result = await apiMethod(...args);

      return {
        kind: 'rpc-result',
        status: responseStatus,
        headers: withoutSetCookie(responseHeaders),
        cookies: responseHeaders.getSetCookie(),
        body: successResponse(responseBody ?? result, rpcId),
      };
    } catch (error: any) {
      console.error(rpcErrorLabel, error);
      // Only Set-Cookie values that DELETE a cookie survive into the error
      // response, so e.g. `requireAuth` can throw a 401 AND clear a dead
      // session cookie, but a method that signs a user in and then throws can
      // never hand out a live session. The method's other headers are dropped,
      // as before, so the JSON-RPC error envelope keeps its standard headers.
      // The body is unchanged (message/name only — never SDK metadata).
      return { ...rpcEnvelope(errorResponseFromCatch(error, rpcId)), cookies: errorResponseSetCookies(responseHeaders) };
    }
    }));
  };
}

async function dispatchRawRoute(
  request: DispatchRequest,
  route: RegisteredRoute,
  params: Record<string, string>,
  corsHeaders: Record<string, string>,
): Promise<DispatchResponse> {
  const headers = request.headers();
  const { text: bodyText, stream: bodyStream } = request.body();

  let responseStatus = 200;
  const responseHeaders = new Headers({
    'Content-Type': 'application/json',
    ...corsHeaders,
    ...NO_STORE_HEADERS,
  });
  let responseBody: any;

  const context = {
    request: {
      headers,
      body: bodyStream,
      json: async () => JSON.parse(bodyText),
      text: async () => bodyText,
      url: request.url(),
      params,
      signal: request.signal,
    },
    response: {
      headers: responseHeaders,
      get status() { return responseStatus; },
      set status(code: number) { responseStatus = code; },
      send: (body: any) => { responseBody = body; },
    },
  };

  try {
    await route.handler(context);

    return {
      kind: 'raw-route',
      status: responseStatus,
      headers: withoutSetCookie(responseHeaders),
      cookies: responseHeaders.getSetCookie(),
      body: responseBody !== undefined ? (typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)) : '',
    };
  } catch (error: unknown) {
    console.error('RawRoute Error:', error);
    const { status, body } = rawRouteErrorFromCatch(error);
    return {
      kind: 'raw-route',
      status,
      headers: withoutSetCookie(responseHeaders),
      cookies: responseHeaders.getSetCookie(),
      body,
    };
  }
}

/** Response headers as a plain record, with `Set-Cookie` left to `cookies`. */
function withoutSetCookie(headers: Headers): Record<string, string> {
  return Object.fromEntries([...headers.entries()].filter(([k]) => k.toLowerCase() !== 'set-cookie'));
}
