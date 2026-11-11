// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// This will be bundled with the customer's backend code
import { emitRpcErrorMetric } from './rpc-error-metric.js';
import { CLIENT_USER_AGENT_HEADER, isRpcPath } from './constants.js';
import { lockRouteRegistry } from './raw-route.js';
import { registerBuiltinRoutes } from './builtin-routes.js';
import { apiNamespaceFilterFromEnv } from './api-placement.js';
import { loadConfigToProcessEnv, isConfigResolved } from './common/config.js';
import { errorResponse } from './rpc.js';
import { buildCorsHeaders } from './cors.js';
import { createDispatcher } from './dispatch.js';
import type { DispatchRequest, DispatchRequestBody, DispatchResponse } from './dispatch.js';
import { requestBodyFromBytes } from './http-body.js';
import { PUBLIC_HOST_HEADER } from './constants.js';
import { isLoopbackForwardedHost, trustedPublicHost } from './request-context.js';

export { parseCorsPatterns, _resetCorsPatterns } from './cors.js';
// The request base URL store (see `buildEventBaseUrl`, which the dispatcher puts
// in it) lives with `getRequestBaseUrl()`, shared across copies of `@aws-blocks/core`.
export { requestBaseUrl } from './common/request-base-url.js';

// The request-scoped stores and the forwarded-host gate live in request-context.ts
// so the container HTTP server shares them; re-exported here for existing imports.
export { requestCookies, requestClientUserAgent, isLoopbackForwardedHost } from './request-context.js';
import { requestIdStore } from './request-context.js';

/**
 * Event source mapping identifiers used by AWS when pushing records to Lambda.
 * Building Blocks use these constants with `Scope.registerLambdaEventHandler()`.
 */
export const EventSourceMapping = {
  SQS: 'aws:sqs',
  /**
   * Cognito user pool Lambda triggers (e.g. PreSignUp). The identifier a
   * Building Block registers under is the **user pool id** the trigger event
   * carries (`event.userPoolId`), so each block answers only its own pool.
   */
  COGNITO_USER_POOL: 'aws:cognito-idp',
} as const;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Decode the Lambda event body into the bytes the client sent.
 *
 * A base64-encoded body (API Gateway sends every body that way, since the
 * shared REST API declares `binaryMediaTypes: ['*\/*']`) is decoded to its
 * original bytes, which `ctx.request.body` yields unchanged; a plain-text body
 * is UTF-8.
 */
function decodeEventBody(event: any): DispatchRequestBody {
  if (!event.body) return { text: '', stream: null };
  return requestBodyFromBytes(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf-8'));
}

/** The fields of an API Gateway Lambda event that its origin and stage are read from. */
type EventOriginFields = {
  headers?: Record<string, string | undefined> | null;
  multiValueHeaders?: Record<string, unknown> | null;
  requestContext?: { stage?: string } | null;
};

/**
 * Where a Lambda event arrived: the gateway-side origin and the API Gateway stage
 * prefix of that origin's external URLs (`''` when there is none) — together the
 * base URL the backend itself is reachable at — and the origin the client called,
 * which `ctx.request.url` reports. A loopback forwarded host contributes only its
 * host: its own query, fragment or userinfo (`localhost:3000?a=b`) never rides along.
 *
 * - When a trusted loopback `X-Forwarded-Host` is present (the sandbox dev-server
 *   front door), both origins are the browser-visible one: that host, plain `http`,
 *   and **no** stage prefix. See {@link isLoopbackForwardedHost} for the gate.
 * - Otherwise host comes from `Host`/`host`, protocol from `x-forwarded-proto`
 *   (default `https`), and the prefix is `/{stage}` for a REST API stage. An HTTP
 *   API's `$default` stage has no path, so it gets none.
 * - Behind a Blocks CloudFront front door — which drops the viewer's `Host` and
 *   stamps it as `x-blocks-public-host` instead — the client called
 *   `https://<that host>` (CloudFront adds the stage as the gateway origin's path).
 *   Taken only when the host is one of the backend's own front-door hosts; see
 *   {@link trustedPublicHost}. The base URL stays the gateway's, for code that must
 *   address the gateway directly (an issuer URL the Lambda fetches).
 */
function resolveEventOrigin(event: EventOriginFields): { origin: string; stagePrefix: string; viewerOrigin: string } {
  const forwardedHost: string | undefined =
    event.headers?.['x-forwarded-host'] || event.headers?.['X-Forwarded-Host'];

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
    const origin = new URL(`http://${forwardedHost}`).origin;
    return { origin, stagePrefix: '', viewerOrigin: origin };
  }

  const host = event.headers?.Host || event.headers?.host || 'localhost';
  const proto = event.headers?.['x-forwarded-proto'] || event.headers?.['X-Forwarded-Proto'] || 'https';
  // API Gateway REST APIs have a stage prefix (e.g. /prod) that's part of the
  // gateway's external URL but NOT included in event.path. It belongs to the
  // base URL (callback URLs, stub IdP issuer URLs, etc.), not to the route path.
  const stage = event.requestContext?.stage;
  const origin = `${proto}://${host}`;
  const publicHost = trustedPublicHost(singleEventHeader(event, PUBLIC_HOST_HEADER));
  return {
    origin,
    stagePrefix: stage && stage !== '$default' ? `/${stage}` : '',
    viewerOrigin: publicHost ? `https://${publicHost}` : origin,
  };
}

/**
 * The externally reachable base URL of a Lambda event: its origin plus the API
 * Gateway stage prefix, without a trailing slash. Exposed to handlers through
 * {@link requestBaseUrl} / `getRequestBaseUrl()`.
 */
function buildEventBaseUrl(event: EventOriginFields): string {
  const { origin, stagePrefix } = resolveEventOrigin(event);
  return `${origin}${stagePrefix}`;
}

/**
 * Reconstruct the absolute request URL from an API Gateway Lambda event.
 *
 * - Path comes from `event.path` (API Gateway v1) or `event.requestContext.http.path` (v2):
 *   the route path, the same one the dev server sees. It never includes the API Gateway
 *   stage — every front door adds the stage on its way to the gateway, so it is not part
 *   of the path the app routes on. Use {@link buildEventBaseUrl} for the stage-bearing base.
 * - Query string from `event.multiValueQueryStringParameters` when present (preserves duplicates),
 *   falling back to `event.queryStringParameters`, then `event.rawQueryString` (v2).
 * - When a trusted loopback `X-Forwarded-Host` is present (the sandbox dev-server
 *   front door), the URL is rebuilt as the browser-visible origin: that host and
 *   plain `http`. Behind a Blocks CloudFront front door it is the URL the viewer
 *   called (`x-blocks-public-host`, when it names one of the backend's front-door
 *   hosts). Otherwise host comes from `Host`/`host` and protocol from
 *   `x-forwarded-proto` (default `https`). See {@link resolveEventOrigin}.
 *
 * @internal Exported for testing only.
 */
export function buildEventUrl(event: any): URL {
  const path: string = event.path || event.requestContext?.http?.path || '/';
  const { viewerOrigin } = resolveEventOrigin(event);

  // Assign the path rather than resolving it against the origin: `new URL(path, origin)`
  // reads a path starting with `//` as a protocol-relative reference and swaps the host.
  const url = new URL(viewerOrigin);
  url.pathname = path;

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
 * The value of the event header `name` (lower-case), matched case-insensitively,
 * when the request carried exactly one header of that name; `undefined` when it
 * carried none or several — a client copy under another letter case, or a repeat
 * that a REST event keeps only the last of in `headers` (every copy is in
 * `multiValueHeaders`). The container refuses the same requests' value.
 */
function singleEventHeader(
  event: { headers?: Record<string, unknown> | null; multiValueHeaders?: Record<string, unknown> | null },
  name: string,
): string | undefined {
  for (const [key, values] of Object.entries(event.multiValueHeaders ?? {})) {
    if (key.toLowerCase() === name && Array.isArray(values) && values.length > 1) return undefined;
  }
  let found: string | undefined;
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (key.toLowerCase() !== name) continue;
    if (found !== undefined || typeof value !== 'string') return undefined;
    found = value;
  }
  return found;
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
 * - `'cognito-trigger'`: A Cognito user pool Lambda trigger (`triggerSource` + `userPoolId`)
 */
export type EventClass = 'http' | 'websocket' | 'records' | 'direct' | 'cognito-trigger';

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
  if (typeof event.triggerSource === 'string' && typeof event.userPoolId === 'string') return 'cognito-trigger';
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
 * - Cognito user pool triggers → `event.triggerSource` + `event.userPoolId`
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
  /** The invocation's request id; Building Blocks read it with `currentRequestId()` from `@aws-blocks/core/bb-utils`. */
  awsRequestId?: string;
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

    // If the app has config coordinates (BLOCKS_CONFIG_BUCKET/KEY set) but the
    // load didn't actually resolve the config, we're in the transient post-deploy
    // S3 window where blocks-config.json isn't readable yet. loadConfigFromS3()
    // deliberately does NOT cache that empty result, so throw a typed transient
    // error here — BEFORE importing the backend — so the createLambdaHandler()
    // catch resets initPromise and the next request re-runs initialize(), which
    // re-fetches from S3 and picks up the now-present config. Without this throw,
    // initialize() would succeed with empty config, `handler` would be assigned,
    // and the `if (!handler)` guard below would never fire again, poisoning the
    // container for its whole life (it would import the backend against empty
    // process.env and serve "not configured" 500s forever).
    //
    // A genuinely config-less app does NOT throw: the no-bucket local-dev path
    // and a real empty `{}` config both cache their result, so isConfigResolved()
    // is true and the retry never spins. Once the blob is readable the successful
    // load caches, so there is no unbounded per-request S3 re-fetch either.
    if (process.env.BLOCKS_CONFIG_BUCKET && process.env.BLOCKS_CONFIG_KEY && !isConfigResolved()) {
      throw new TransientConfigError();
    }

    // CORS origins are read directly by getCorsPatterns(), which now compiles
    // CORS_ALLOWED_ORIGINS (user-supplied regex channel) and CORS_HOSTING_ORIGINS
    // (framework-injected literal origins, escaped at runtime) via separate paths.
    // No pre-merge here: folding the resolved CloudFront domain into the regex
    // channel would regex-compile its dots into wildcards, so the two stay split.

    const mod = await backendFactory();
    handler = createHandler(mod);
    registerBuiltinRoutes();
    lockRouteRegistry();
  }

  // Each invocation runs with its request id in scope, so Building Blocks can
  // tag their output with it (`currentRequestId()` in request-context.ts).
  return (event: any, context?: LambdaContext) => requestIdStore.run(context?.awsRequestId, () => invoke(event, context));

  async function invoke(event: any, context?: LambdaContext) {
    if (!handler) {
      // Retry init on failure instead of caching the rejection. If initialize() throws (most often
      // because loadConfigToProcessEnv() couldn't read blocks-config.json during the brief
      // post-deploy window before it's readable), a memoized rejected promise would poison this
      // container for its whole lifetime — every later request re-awaits the same rejection and 500s.
      // Resetting initPromise lets the next invocation re-run initialize() (config.ts re-fetches,
      // since it doesn't cache failures), so the handler self-heals once config is available.
      if (!initPromise) {
        // Run init outside this invocation's request-id scope: the backend import and the
        // Building Block constructors create long-lived state (timers, pool listeners) that
        // must not keep the first request's id for the life of the container.
        initPromise = requestIdStore.exit(() => initialize()).catch((err) => {
          initPromise = null;
          throw err;
        });
      }
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
        const origin = event.headers?.origin || event.headers?.Origin || '';
        const requestPath = getRequestPath(event);
        const body = isRpcPath(requestPath)
          ? errorResponse(504, 'Request timed out', null, { name: 'HandlerTimeoutError' })
          : JSON.stringify({ error: 'Request timed out', code: 'HANDLER_TIMEOUT' });
        if (isRpcPath(requestPath)) emitRpcErrorMetric({ status: 504 });
        return {
          statusCode: 504,
          headers: {
            'Content-Type': 'application/json',
            ...buildCorsHeaders(origin),
          },
          body,
        };
      }
      // Non-timeout errors (handler threw before deadline) propagate normally.
      throw err;
    }
  }
}

class HandlerTimeoutError extends Error {
  constructor() {
    super('Handler timeout');
    this.name = 'HandlerTimeoutError';
  }
}

/**
 * Thrown by `initialize()` when the app has config coordinates
 * (BLOCKS_CONFIG_BUCKET/KEY) but the S3 config load resolved empty because
 * blocks-config.json wasn't readable yet — the transient window right after a
 * deploy, before the BucketDeployment settles.
 *
 * It flows through the `createLambdaHandler()` init catch, which resets
 * `initPromise` so the NEXT request re-runs `initialize()` and picks up the
 * now-present config (config.ts does not cache a not-found result, so the retry
 * re-fetches). A distinct type keeps the recovery path greppable and testable
 * and separates it from real init failures, which surface with their own error.
 *
 * @internal Exported for testing only.
 */
export class TransientConfigError extends Error {
  constructor() {
    super('[Blocks] Config not readable yet (transient post-deploy S3 window); will retry on next request');
    this.name = 'TransientConfigError';
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
  // Each failed RPC call writes the `RpcErrors` metric: the response is an HTTP
  // 200 JSON-RPC error envelope, so Lambda's own `Errors` metric never counts it.
  // With `defaults.strictNamespacePlacement`, serve only the API namespaces placed on
  // this compute (the placement map is in the function's environment). A missing or
  // malformed map throws here, so initialization fails and is retried.
  const dispatch = createDispatcher(backend, {
    rpcErrorLabel: 'Lambda Error:',
    onRpcError: emitRpcErrorMetric,
    servesNamespace: apiNamespaceFilterFromEnv(),
  });
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

    // ── Cognito user pool triggers (e.g. PreSignUp) ──
    // Routed by the pool id the event carries. The handler validates and
    // throws to reject; the event is returned unchanged, so a trigger never
    // flips `response.autoConfirmUser` / `autoVerify*` on its own. With no
    // handler for the pool the invocation fails, and Cognito rejects the
    // operation — a misrouted trigger fails closed, never open.
    if (eventClass === 'cognito-trigger') {
      return handleCognitoTrigger(event);
    }

    // ── HTTP (API Gateway REST / HTTP API) ──
    return toApiGatewayResult(event, await dispatch(toDispatchRequest(event, signal)));
  };
}

/**
 * Translate an API Gateway proxy event, REST (payload v1) or HTTP API /
 * Function URL (payload v2), into a transport-neutral {@link DispatchRequest}.
 * `requestId` is left unset: Lambda log lines already carry the invocation
 * request ID.
 */
function toDispatchRequest(event: any, signal?: AbortSignal): DispatchRequest {
  return {
    method: event.httpMethod || event.requestContext?.http?.method,
    path: getRequestPath(event),
    origin: event.headers?.origin || event.headers?.Origin || '',
    // Extract cookies from the inbound request (both header casings occur).
    cookie: event.headers?.cookie || event.headers?.Cookie || '',
    clientUserAgent: event.headers?.[CLIENT_USER_AGENT_HEADER] || event.headers?.['X-Blocks-User-Agent'],
    headers: () => new Headers(event.headers || {}),
    url: () => buildEventUrl(event),
    baseUrl: () => buildEventBaseUrl(event),
    body: () => decodeEventBody(event),
    signal,
  };
}

/**
 * The response field(s) that carry `Set-Cookie` values for the event's Lambda
 * proxy payload format.
 *
 * - v1 (API Gateway REST proxy — what `bb-lambda-compute` provisions): the
 *   `headers` map carries one value per name, so cookies go in
 *   `multiValueHeaders['Set-Cookie']`.
 * - v2 (`event.version === '2.0'` — HTTP API / Function URL): v2 has no
 *   `multiValueHeaders`; cookies go in the top-level `cookies` array.
 */
function cookieResponseFields(
  event: any,
  cookies: string[],
): { multiValueHeaders: { 'Set-Cookie': string[] } } | { cookies: string[] } {
  if (event?.version === '2.0') return { cookies };
  return { multiValueHeaders: { 'Set-Cookie': cookies } };
}

/**
 * Translate a {@link DispatchResponse} into a Lambda proxy result for the
 * event's payload format.
 *
 * `Set-Cookie` is the one header that must not be comma-joined, so every cookie
 * goes into the format's cookie field (see {@link cookieResponseFields}) and is
 * kept out of `headers` (API Gateway merges the two). Without this, a response
 * setting several cookies keeps only one on AWS. RawRoute responses and RPC
 * method results always carry the cookie field; other responses only when there
 * is a cookie to deliver (an RPC error clearing a session).
 *
 * A byte body (a RawRoute that `send()`s a `Buffer`, `Uint8Array` or
 * `ArrayBuffer`) goes out base64-encoded with `isBase64Encoded: true`; API
 * Gateway decodes it back to the raw bytes, which the shared REST API's
 * `binaryMediaTypes: ['*\/*']` allows.
 */
function toApiGatewayResult(event: any, response: DispatchResponse) {
  const { kind, status: statusCode, headers, cookies } = response;
  const body = typeof response.body === 'string'
    ? { body: response.body }
    : { body: response.body.toString('base64'), isBase64Encoded: true };
  if (kind === 'raw-route' || kind === 'rpc-result' || cookies.length > 0) {
    return { statusCode, headers, ...cookieResponseFields(event, cookies), ...body };
  }
  return { statusCode, headers, ...body };
}

/**
 * Dispatch a Cognito user pool trigger to the handler registered under
 * `${EventSourceMapping.COGNITO_USER_POOL}:${event.userPoolId}`.
 *
 * Returns the event as received: a handler accepts by resolving and rejects by
 * throwing (Cognito then answers the caller with `UserLambdaValidationException`
 * and the thrown message). An unrouted event throws a generic message — the
 * caller of Cognito sees it, so it names no resource.
 */
async function handleCognitoTrigger(event: any): Promise<unknown> {
  const handlers: Map<string, (record: any) => Promise<void>> =
    (globalThis as any).__BLOCKS_LAMBDA_EVENT_HANDLERS__ ?? new Map();
  const key = `${EventSourceMapping.COGNITO_USER_POOL}:${event.userPoolId}`;
  const handler = handlers.get(key);
  if (!handler) {
    console.error(`No Cognito trigger handler registered for "${key}" (triggerSource: ${event.triggerSource})`);
    throw new Error('This user pool trigger is not configured.');
  }
  await handler(event);
  return event;
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
