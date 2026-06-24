// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// This will be bundled with the customer's backend code
import { AsyncLocalStorage } from 'node:async_hooks';
import { ApiError, isExpectedBlocksError } from './errors.js';
import { BLOCKS_RPC_PREFIX } from './constants.js';
import { matchRoute, lockRouteRegistry } from './raw-route.js';
import { registerBuiltinRoutes } from './builtin-routes.js';
import { loadConfigToProcessEnv } from './common/config.js';
import {
  parseRpcRequest,
  successResponse,
  errorResponse,
  errorResponseFromCatch,
  methodNotFoundResponse,
} from './rpc.js';
import { getCorsPatterns, isOriginAllowed, corsRejection } from './cors.js';

export { parseCorsPatterns, _resetCorsPatterns } from './cors.js';

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
 * Event source mapping identifiers used by AWS when pushing records to Lambda.
 * Building Blocks use these constants with `Scope.registerLambdaEventHandler()`.
 */
export const EventSourceMapping = {
  SQS: 'aws:sqs',
} as const;

// ── CORS helpers (private to handler) ───────────────────────────────────────

function buildCorsHeaders(origin: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (isOriginAllowed(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  } else if (origin) {
    console.warn(
      `[CORS] Origin "${origin}" is not allowed. Set the CORS_ALLOWED_ORIGINS environment variable to allow this origin. Example: CORS_ALLOWED_ORIGINS=https://myapp\\.com,^https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?$`
    );
  }
  return headers;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Decode the Lambda event body and return both the raw string and a ReadableStream.
 *
 * Handles base64-encoded bodies (binary payloads forwarded by API Gateway)
 * and plain-text bodies.
 */
function decodeEventBody(event: any): { bodyText: string; bodyStream: ReadableStream<Uint8Array> | null } {
  if (!event.body) {
    return { bodyText: '', bodyStream: null };
  }

  const bodyText = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;

  const bodyStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(bodyText));
      controller.close();
    },
  });

  return { bodyText, bodyStream };
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
 * Reconstruct the absolute request URL from an API Gateway Lambda event.
 *
 * - Path comes from `event.path` (API Gateway v1) or `event.requestContext.http.path` (v2).
 * - Query string from `event.multiValueQueryStringParameters` when present (preserves duplicates),
 *   falling back to `event.queryStringParameters`, then `event.rawQueryString` (v2).
 * - When a trusted loopback `X-Forwarded-Host` is present (the sandbox dev-server
 *   front door), the URL is rebuilt as the browser-visible origin: that host,
 *   plain `http`, and **no** API Gateway stage prefix. Otherwise host comes from
 *   `Host`/`host`, protocol from `x-forwarded-proto` (default `https`), and the
 *   stage prefix is prepended. See {@link isLoopbackForwardedHost} for the gate.
 *
 * @internal Exported for testing only.
 */
export function buildEventUrl(event: any): URL {
  const path: string = event.path || event.requestContext?.http?.path || '/';
  const forwardedHost: string | undefined =
    event.headers?.['x-forwarded-host'] || event.headers?.['X-Forwarded-Host'];

  let origin: string;
  let fullPath: string;
  if (isLoopbackForwardedHost(forwardedHost)) {
    // Trusted sandbox dev-server front door. The browser reached the backend at
    // `http://localhost:<port><path>` and the proxy forwarded it to execute-api.
    // The browser-visible URL — which is what absolute URLs like the OIDC
    // `redirect_uri` must match — is that localhost origin: plain HTTP and no
    // stage. Rebuilding proto/stage from the execute-api request context would
    // produce e.g. `https://localhost:3000/prod/auth/callback`, which the IdP
    // rejects and the browser can't reach.
    //
    // `http` is hardcoded on purpose: the shipped dev server is HTTP-only, and
    // `x-forwarded-proto` is unusable here — the dev server connects to API
    // Gateway over HTTPS, so API Gateway stamps `x-forwarded-proto: https` on the
    // Lambda integration request, clobbering whatever the dev server forwarded.
    // A user-supplied TLS front door (`https://localhost`) is a known, unsupported
    // limitation; the proper fix is a config-derived front-door origin rather than
    // header inference.
    origin = `http://${forwardedHost}`;
    fullPath = path;
  } else {
    const host = event.headers?.Host || event.headers?.host || 'localhost';
    const proto = event.headers?.['x-forwarded-proto'] || event.headers?.['X-Forwarded-Proto'] || 'https';
    origin = `${proto}://${host}`;
    // API Gateway REST APIs have a stage prefix (e.g. /prod) that's part of the
    // external URL but NOT included in event.path. Include it so ctx.request.url
    // reflects the full external-facing URL — needed for callback URLs, stub IdP
    // issuer URLs, etc.
    const stage = event.requestContext?.stage;
    fullPath = stage ? `/${stage}${path}` : path;
  }

  const url = new URL(fullPath, origin);

  if (event.rawQueryString) {
    url.search = `?${event.rawQueryString}`;
  } else if (event.multiValueQueryStringParameters) {
    const params = new URLSearchParams();
    for (const [k, values] of Object.entries(event.multiValueQueryStringParameters)) {
      for (const v of values as string[]) params.append(k, v);
    }
    url.search = params.toString();
  } else if (event.queryStringParameters) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(event.queryStringParameters)) {
      if (v !== null && v !== undefined) params.append(k, String(v));
    }
    url.search = params.toString();
  }

  return url;
}

/**
 * Default timeout for API Gateway HTTP requests (28s).
 *
 * API Gateway has a 29-second hard timeout for HTTP integrations.
 * We self-terminate at 28s (1s safety margin) to return a proper 504
 * before APIGW cuts the connection and returns its own opaque 504.
 */
const APIGW_TIMEOUT_MS = 28_000;

/**
 * Safety buffer subtracted from `context.getRemainingTimeInMillis()` to
 * ensure the timeout response is sent before Lambda is killed.
 */
const REMAINING_TIME_BUFFER_MS = 1_000;

/**
 * Classified event source type for Lambda invocations.
 *
 * - `'http'`: API Gateway REST (v1) or HTTP (v2) request
 * - `'websocket'`: API Gateway WebSocket (CONNECT/DISCONNECT/MESSAGE)
 * - `'records'`: Event source mapping (SQS, Kinesis, DDB Streams)
 * - `'direct'`: Direct invoke with Blocks-controlled payload (EventBridge Scheduler)
 */
export type EventClass = 'http' | 'websocket' | 'records' | 'direct';

/**
 * Classify a Lambda event into its source type.
 *
 * Used by both the timeout guard (to decide whether to apply the HTTP deadline)
 * and the dispatcher (to route to the correct handler). Single source of truth
 * prevents drift when new async event types are added.
 *
 * Returns `'http'` only when positive HTTP indicators are present (`httpMethod`
 * or `requestContext.http.method`). Events that don't match any classification
 * also fall to `'http'` via the dispatcher, but `isApiGatewayHttpEvent` gates
 * the timeout guard to only fire when `classifyEvent` returns `'http'`.
 *
 * @internal Exported for testing only.
 */
export function classifyEvent(event: any): EventClass {
  if (event.Records?.[0]?.eventSource) return 'records';
  if (event.source?.startsWith('blocks.')) return 'direct';
  if (
    event.requestContext?.eventType &&
    ['CONNECT', 'DISCONNECT', 'MESSAGE'].includes(event.requestContext.eventType)
  ) {
    return 'websocket';
  }
  if (event.httpMethod || event.requestContext?.http?.method) return 'http';
  return 'http';
}

/**
 * Detect whether a Lambda event originates from API Gateway (HTTP).
 *
 * API Gateway v1 (REST): has `httpMethod` at top level.
 * API Gateway v2 (HTTP): has `requestContext.http.method`.
 *
 * Events that are NOT API Gateway HTTP:
 * - SQS/Kinesis/DDB Streams → `event.Records[0].eventSource`
 * - EventBridge Scheduler → `event.source` starts with 'blocks.'
 * - WebSocket → `event.requestContext.eventType` in CONNECT/DISCONNECT/MESSAGE
 *
 * @internal Exported for testing only.
 */
export function isApiGatewayHttpEvent(event: any): boolean {
  return classifyEvent(event) === 'http' && !!(event.httpMethod || event.requestContext?.http?.method);
}

/**
 * Compute the HTTP deadline in milliseconds.
 *
 * Uses the minimum of:
 * - `APIGW_TIMEOUT_MS` (28s fixed guard)
 * - `context.getRemainingTimeInMillis() - REMAINING_TIME_BUFFER_MS` (actual remaining Lambda time)
 *
 * This handles the edge case where a warm Lambda has less than 29s remaining.
 *
 * @internal Exported for testing only.
 */
export function computeHttpDeadlineMs(context?: LambdaContext): number {
  if (!context?.getRemainingTimeInMillis) return APIGW_TIMEOUT_MS;
  const remaining = context.getRemainingTimeInMillis() - REMAINING_TIME_BUFFER_MS;
  return Math.min(APIGW_TIMEOUT_MS, Math.max(remaining, 0));
}

/**
 * Minimal Lambda context interface for the fields we use.
 * @internal Exported for testing only.
 */
export interface LambdaContext {
  getRemainingTimeInMillis(): number;
}

/**
 * Create a Lambda handler for the Blocks backend.
 *
 * Uses the lazy factory pattern with a dynamic import:
 * ```ts
 * export const handler = createLambdaHandler(() => import('./index.js'));
 * ```
 *
 * Why: Building Blocks read config from process.env at import time.
 * The factory pattern loads S3 config into process.env BEFORE your
 * backend module is imported.
 *
 * Cold start: First invocation fetches config from S3 (~50-200ms),
 * then imports the backend. Subsequent invocations use cached config.
 *
 * Local dev: No S3 access — config comes from process.env directly.
 *
 * For API Gateway (HTTP) events, a self-termination guard races the handler
 * against a 28s deadline. If the handler wedges, the Lambda returns a 504
 * instead of billing for the full 15-minute timeout while the client already
 * received a 504 from API Gateway. Async event sources (SQS, EventBridge,
 * WebSocket) are not subject to this guard.
 *
 * @param backendFactory - Async function returning the backend module (typically `() => import('./index.js')`)
 */
export function createLambdaHandler(backendFactory: () => Promise<any>) {
  let handler: ((event: any, signal?: AbortSignal) => Promise<any>) | null = null;
  let initPromise: Promise<void> | null = null;

  async function initialize() {
    await loadConfigToProcessEnv();

    // Merge hosting-provided CORS origins into the main env var so the lazy
    // getCorsPatterns() sees a combined value on first access.
    // loadConfigToProcessEnv() won't override CORS_ALLOWED_ORIGINS if it's
    // already set (sandbox env var), but CORS_HOSTING_ORIGINS always loads
    // from S3 since it's never set as a direct env var.
    const hostingOrigins = process.env.CORS_HOSTING_ORIGINS;
    if (hostingOrigins) {
      const existing = process.env.CORS_ALLOWED_ORIGINS;
      process.env.CORS_ALLOWED_ORIGINS = existing
        ? `${existing},${hostingOrigins}`
        : hostingOrigins;
    }

    const mod = await backendFactory();
    handler = createHandler(mod);
    registerBuiltinRoutes();
    lockRouteRegistry();
  }

  return async (event: any, context?: LambdaContext) => {
    if (!handler) {
      if (!initPromise) initPromise = initialize();
      await initPromise;
    }

    // Only apply the HTTP timeout guard to API Gateway requests; async event
    // sources (SQS, EventBridge, WebSocket) have their own retry semantics.
    if (!isApiGatewayHttpEvent(event)) {
      return handler!(event);
    }

    // Race the handler against a timeout so we can return a proper 504 before
    // API Gateway's own 29s hard cutoff fires and returns an opaque 504.
    const deadlineMs = computeHttpDeadlineMs(context);
    const abortController = new AbortController();

    const handlerPromise = handler!(event, abortController.signal);
    // After a timeout we abort in-flight fetches/SDK calls via the signal.
    // Those will reject with AbortError, but we've already returned the 504
    // response — attach a no-op catch to prevent unhandled-rejection crashes.
    handlerPromise.catch(() => {});

    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Signal the handler to stop any in-flight work (fetch, SDK calls).
        abortController.abort();
        reject(new HandlerTimeoutError());
      }, deadlineMs);
      // unref() ensures this timer alone won't keep the Lambda runtime alive
      // if the handler finishes just before the timeout fires.
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    });

    try {
      // Whichever settles first wins: handler success or timeout rejection.
      const result = await Promise.race([handlerPromise, timeoutPromise]);
      clearTimeout(timer!);
      return result;
    } catch (err) {
      clearTimeout(timer!);
      if (err instanceof HandlerTimeoutError) {
        // Timeout won the race — build a 504 response. Format depends on
        // whether the request targeted an RPC endpoint (structured JSON-RPC
        // error envelope) or a plain HTTP path (simple error JSON).
        const origin = event.headers?.origin || event.headers?.Origin || '*';
        const requestPath = getRequestPath(event);
        const isRpcPath = requestPath === BLOCKS_RPC_PREFIX || requestPath.startsWith(BLOCKS_RPC_PREFIX + '/');
        const body = isRpcPath
          ? errorResponse(504, 'Request timed out', null, { name: 'HandlerTimeoutError' })
          : JSON.stringify({ error: 'Request timed out', code: 'HANDLER_TIMEOUT' });
        return {
          statusCode: 504,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Credentials': 'true',
          },
          body,
        };
      }
      // Non-timeout errors (handler threw before deadline) propagate normally.
      throw err;
    }
  };
}

class HandlerTimeoutError extends Error {
  constructor() {
    super('Handler timeout');
    this.name = 'HandlerTimeoutError';
  }
}

/**
 * Extract the request path from a Lambda event, normalizing between
 * API Gateway v1 (REST) and v2 (HTTP API) event shapes.
 *
 * - v1 REST API: path is at `event.path`
 * - v2 HTTP API: path is at `event.requestContext.http.path`
 * - Fallback: `'/'`
 */
function getRequestPath(event: any): string {
  return event.path || event.requestContext?.http?.path || '/';
}

function createHandler(backend: any) {
  return async (event: any, signal?: AbortSignal) => {
    const eventClass = classifyEvent(event);

    // ── WebSocket events (API Gateway WebSocket API) ──
    if (eventClass === 'websocket') {
      const handlers: Map<string, (record: any) => Promise<void>> =
        (globalThis as any).__BLOCKS_LAMBDA_EVENT_HANDLERS__ ?? new Map();
      for (const [key, handler] of handlers) {
        if (key.startsWith('blocks.websocket:')) {
          return handler(event);
        }
      }
      console.error('WebSocket event received but no blocks.websocket handler registered');
      return { statusCode: 500 };
    }

    // ── Batch/Stream events (SQS, Kinesis, DDB Streams) ──
    if (eventClass === 'records') {
      return handleEventSourceRecords(event, backend);
    }

    // ── Direct invoke with Blocks-controlled payload ──
    if (eventClass === 'direct') {
      const handlers: Map<string, (record: any) => Promise<void>> =
        (globalThis as any).__BLOCKS_LAMBDA_EVENT_HANDLERS__ ?? new Map();
      const identifier = event.jobName ?? event.id ?? event.source;
      const key = `${event.source}:${identifier}`;
      const handler = handlers.get(key);
      if (!handler) {
        console.error(`No handler registered for "${key}"`);
        throw new Error(`No handler registered for "${key}"`);
      }
      return handler(event);
    }

    const origin = event.headers?.origin || event.headers?.Origin || '';
    const httpMethod = event.httpMethod || event.requestContext?.http?.method;
    const corsHeaders = buildCorsHeaders(origin);

    // Reject cross-origin requests from disallowed origins
    const patterns = getCorsPatterns();
    if (origin && patterns && !isOriginAllowed(origin)) {
      return corsRejection();
    }

    // Handle OPTIONS preflight
    if (httpMethod === 'OPTIONS') {
      return {
        statusCode: 200,
        headers: {
          ...corsHeaders,
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
        body: '',
      };
    }

    // Extract cookies from the inbound request and store them in
    // AsyncLocalStorage so downstream code (e.g. the Blocks client making
    // server-side API calls during SSR) can forward them automatically.
    // Wraps both RawRoute and RPC handling so any handler that calls Blocks
    // APIs server-side gets forwarded cookies.
    const inboundCookies = event.headers?.cookie || event.headers?.Cookie || '';

    return requestCookies.run(inboundCookies, async () => {
    // RawRoute dispatch — check path-based routes before falling through to RPC
    const requestPath = getRequestPath(event);
    if (requestPath !== BLOCKS_RPC_PREFIX) {
      const matched = matchRoute(httpMethod, requestPath);
      if (matched) {
        return handleRawRoute(event, matched.route, matched.params, corsHeaders, signal);
      }
      // No RawRoute matched and path is not the RPC endpoint — return 404
      if (!requestPath.startsWith(BLOCKS_RPC_PREFIX)) {
        return {
          statusCode: 404,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
          },
          body: JSON.stringify({ error: 'Not Found' }),
        };
      }
    }

    const rpcHeaders = {
      'Content-Type': 'application/json',
      ...corsHeaders,
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    };

    const { bodyText, bodyStream } = decodeEventBody(event);
    const parsed = parseRpcRequest(bodyText);

    if (!parsed.ok) {
      return { statusCode: 200, headers: rpcHeaders, body: parsed.response };
    }

    const { apiNamespace, method, args, id: rpcId } = parsed.request;

    try {
      const headers = new Headers(event.headers || {});

      let responseStatus = 200;
      const responseHeaders = new Headers(rpcHeaders);
      let responseBody: any;

      const context = {
        request: {
          headers,
          body: bodyStream,
          json: async () => JSON.parse(bodyText),
          text: async () => bodyText,
          url: buildEventUrl(event),
          params: {},
          signal,
        },
        response: {
          headers: responseHeaders,
          get status() { return responseStatus; },
          set status(code: number) { responseStatus = code; },
          send: (body: any) => { responseBody = body; },
        },
      };

      // Get the API by export name
      const apiHandler = backend[apiNamespace];
      if (!apiHandler) {
        return { statusCode: 200, headers: rpcHeaders, body: methodNotFoundResponse(`API '${apiNamespace}' not found`, rpcId) };
      }

      // Call the handler to get methods
      const apiMethods = typeof apiHandler === 'function'
        ? apiHandler(context)
        : apiHandler;

      if (!apiMethods[method]) {
        return { statusCode: 200, headers: rpcHeaders, body: methodNotFoundResponse(`'${method}' on API '${apiNamespace}'`, rpcId) };
      }

      const result = await apiMethods[method](...args);

      return {
        statusCode: responseStatus,
        headers: Object.fromEntries(responseHeaders.entries()),
        body: successResponse(responseBody ?? result, rpcId),
      };
    } catch (error: any) {
      // For expected typed Blocks errors, log a concise one-liner — the name
      // + message is sufficient signal. Genuinely unexpected errors keep the
      // full object (with stack) so bugs remain debuggable in CloudWatch.
      if (isExpectedBlocksError(error)) {
        console.error('Lambda Error:', error?.name, '-', error?.message);
      } else {
        console.error('Lambda Error:', error);
      }
      return {
        statusCode: 200,
        headers: rpcHeaders,
        body: errorResponseFromCatch(error, rpcId),
      };
    }
    });
  };
}

async function handleRawRoute(
  event: any,
  route: import('./raw-route.js').RegisteredRoute,
  params: Record<string, string>,
  corsHeaders: Record<string, string>,
  signal?: AbortSignal,
) {
  const headers = new Headers(event.headers || {});
  const { bodyText, bodyStream } = decodeEventBody(event);

  let responseStatus = 200;
  const responseHeaders = new Headers({
    'Content-Type': 'application/json',
    ...corsHeaders,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  let responseBody: any;

  const context = {
    request: {
      headers,
      body: bodyStream,
      json: async () => JSON.parse(bodyText),
      text: async () => bodyText,
      url: buildEventUrl(event),
      params,
      signal,
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
      statusCode: responseStatus,
      headers: Object.fromEntries(
        [...responseHeaders.entries()].filter(([k]) => k.toLowerCase() !== 'set-cookie')
      ),
      multiValueHeaders: {
        'Set-Cookie': responseHeaders.getSetCookie?.() ?? [],
      },
      body: responseBody !== undefined ? (typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)) : '',
    };
  } catch (error: any) {
    console.error('RawRoute Error:', error);
    const status = error instanceof ApiError ? error.status : 500;
    const body: Record<string, any> = { error: error.message };
    if (error.name && error.name !== 'Error') body.name = error.name;
    return {
      statusCode: status,
      headers: Object.fromEntries(
        [...responseHeaders.entries()].filter(([k]) => k.toLowerCase() !== 'set-cookie')
      ),
      multiValueHeaders: {
        'Set-Cookie': responseHeaders.getSetCookie?.() ?? [],
      },
      body: JSON.stringify(body),
    };
  }
}

async function handleEventSourceRecords(event: any, _backend: any) {
  const handlers: Map<string, (record: any) => Promise<void>> =
    (globalThis as any).__BLOCKS_LAMBDA_EVENT_HANDLERS__ ?? new Map();

  // Process all records in parallel for better throughput
  const results = await Promise.allSettled(
    event.Records.map(async (record: any) => {
      const eventSource: string = record.eventSource;
      const resourceId = record.eventSourceARN?.split(':').pop();
      const key = `${eventSource}:${resourceId}`;
      const handler = handlers.get(key);

      if (!handler) {
        console.error(`No event handler registered for ${key} (ARN: ${record.eventSourceARN})`);
        throw new Error(`No event handler registered for ${key}`);
      }

      await handler(record);
      return { record, success: true };
    })
  );

  // Collect failures for SQS partial batch response
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];
  let nonSqsFailure: Error | null = null;

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      const record = event.Records[index];
      const eventSource: string = record.eventSource;

      if (eventSource === EventSourceMapping.SQS && record.messageId) {
        console.error(`Handler failed for record ${record.messageId}:`, result.reason);
        batchItemFailures.push({ itemIdentifier: record.messageId });
      } else {
        // For non-SQS event sources, we need to throw
        nonSqsFailure = result.reason;
      }
    }
  });

  // For non-SQS event sources (Kinesis, DynamoDB Streams), throw on any failure
  if (nonSqsFailure) {
    throw nonSqsFailure;
  }

  // Return partial batch failure response for SQS
  if (batchItemFailures.length > 0) {
    return { batchItemFailures };
  }

  return {};
}
