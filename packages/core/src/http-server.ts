// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Production HTTP server for container compute targets (ECS, EKS).
//
// Wraps the exact same dispatch as the Lambda handler: an incoming Node
// request is translated to an API-Gateway-v1-shaped event, run through
// `createLambdaHandler()`'s returned function, and the result is written back.
// Reusing the Lambda dispatch (rather than re-implementing routing) keeps
// JSON-RPC envelopes, RawRoutes, CORS, cookies, and the 504 timeout guard
// byte-identical between Lambda and container deployments.

import * as http from 'node:http';
import { BLOCKS_NAMESPACE, BLOCKS_RPC_PREFIX } from './constants.js';

/**
 * Health-check path served by the container HTTP server itself (never
 * dispatched to the backend). Load balancer target groups and Kubernetes
 * probes point here: 200 once the backend finished initializing, 503 before.
 */
export const BLOCKS_HEALTH_PATH = `${BLOCKS_NAMESPACE}/health`;

/** The Lambda-shaped handler produced by `createLambdaHandler()`. */
export type BlocksEventHandler = (event: any, context?: any) => Promise<any>;

export interface BlocksHttpServerOptions {
  /** Port to listen on. Default: `PORT` env var, else 8080. */
  port?: number;
  /** Health-check path answered by the server itself. Default: `/aws-blocks/health`. */
  healthPath?: string;
  /**
   * Public origin the backend is reachable at (e.g. the CloudFront URL,
   * `https://d111111abcdef8.cloudfront.net`). Behind CloudFront → internal ALB
   * the request's `Host` header carries the load balancer's hostname, which is
   * not externally reachable — absolute URLs built from it (OIDC redirect
   * URIs, callback URLs) would break. When set, `Host` and `x-forwarded-proto`
   * in the synthesized event are rewritten to this origin.
   * Default: `BLOCKS_PUBLIC_ORIGIN` env var, else no rewrite.
   */
  publicOrigin?: string;
  /**
   * Grace period after SIGTERM/SIGINT before in-flight connections are
   * force-closed. Load balancer deregistration delays and Kubernetes
   * `terminationGracePeriodSeconds` should exceed this. Default: 25_000.
   */
  shutdownGraceMs?: number;
  /**
   * Register SIGTERM/SIGINT handlers that drain and `process.exit(0)`.
   * Default: true (this is a container entrypoint helper).
   */
  handleSignals?: boolean;
}

interface ResolvedOptions {
  port: number;
  healthPath: string;
  publicOrigin?: string;
  shutdownGraceMs: number;
  handleSignals: boolean;
}

function resolveOptions(options?: BlocksHttpServerOptions): ResolvedOptions {
  const envPort = Number(process.env.PORT);
  return {
    port: options?.port ?? (Number.isFinite(envPort) && envPort > 0 ? envPort : 8080),
    healthPath: options?.healthPath ?? BLOCKS_HEALTH_PATH,
    publicOrigin: options?.publicOrigin ?? process.env.BLOCKS_PUBLIC_ORIGIN ?? undefined,
    shutdownGraceMs: options?.shutdownGraceMs ?? 25_000,
    handleSignals: options?.handleSignals ?? true,
  };
}

/**
 * Flatten Node's request headers (string | string[] | undefined values) into
 * the single-valued record shape of an API Gateway v1 event. Node already
 * lower-cases names and joins duplicate `Cookie` headers with `'; '`;
 * remaining duplicates are comma-joined per RFC 9110.
 */
function toEventHeaders(req: http.IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

/**
 * Translate a Node request into an API-Gateway-v1-shaped event.
 *
 * The body is always base64-encoded (`isBase64Encoded: true`): the dispatch's
 * `decodeEventBody` handles base64 for any payload, and encoding
 * unconditionally avoids content-type sniffing. No `requestContext.stage` is
 * set, so URLs built by the backend have no stage prefix — container front
 * doors serve from the origin root.
 *
 * @internal Exported for testing only.
 */
export function toLambdaEvent(
  req: http.IncomingMessage,
  body: Buffer,
  publicOrigin?: string,
): any {
  const headers = toEventHeaders(req);

  if (publicOrigin) {
    const origin = new URL(publicOrigin);
    headers.host = origin.host;
    headers['x-forwarded-proto'] = origin.protocol.replace(':', '');
    // A stale forwarded host (e.g. stamped by the load balancer) must not
    // shadow the canonical public origin in buildEventUrl's loopback gate.
    delete headers['x-forwarded-host'];
  }

  const url = new URL(req.url ?? '/', 'http://localhost');

  const event: any = {
    httpMethod: req.method ?? 'GET',
    path: url.pathname,
    headers,
    body: body.length > 0 ? body.toString('base64') : null,
    isBase64Encoded: body.length > 0,
  };
  if (url.search.length > 1) {
    event.rawQueryString = url.search.slice(1);
  }
  return event;
}

/**
 * Write a Lambda-shaped result ({ statusCode, headers, multiValueHeaders,
 * body, isBase64Encoded }) to the Node response.
 *
 * @internal Exported for testing only.
 */
export function writeLambdaResult(res: http.ServerResponse, result: any): void {
  res.statusCode = result?.statusCode ?? 200;
  for (const [name, value] of Object.entries(result?.headers ?? {})) {
    res.setHeader(name, String(value));
  }
  // The dispatch emits Set-Cookie exclusively via multiValueHeaders (filtered
  // out of `headers`), so setting arrays here never clobbers a single value.
  for (const [name, values] of Object.entries(result?.multiValueHeaders ?? {})) {
    if (Array.isArray(values) && values.length > 0) {
      res.setHeader(name, values.map(String));
    }
  }
  const body = result?.body ?? '';
  res.end(result?.isBase64Encoded ? Buffer.from(body, 'base64') : body);
}

/**
 * Build a Node request listener that serves the health endpoint and forwards
 * everything else through the Blocks event dispatch.
 *
 * @internal Exported for testing; use {@link startBlocksHttpServer} in entrypoints.
 */
export function createNodeRequestListener(
  handler: BlocksEventHandler,
  options?: BlocksHttpServerOptions & { isReady?: () => boolean },
): http.RequestListener {
  const resolved = resolveOptions(options);
  const isReady = options?.isReady ?? (() => true);

  return (req, res) => {
    const path = (req.url ?? '/').split('?')[0];

    // Health is a server concern: answered before dispatch so probes get a
    // deterministic response independent of routes and CORS config.
    if (path === resolved.healthPath) {
      const ready = isReady();
      res.statusCode = ready ? 200 : 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: ready ? 'ok' : 'initializing' }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', (err) => {
      console.error('Request stream error:', err);
      if (!res.headersSent) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'Bad Request' }));
      } else {
        res.destroy();
      }
    });
    req.on('end', () => {
      const event = toLambdaEvent(req, Buffer.concat(chunks), resolved.publicOrigin);
      // No Lambda context is passed: the deadline guard then uses the
      // BLOCKS_HTTP_TIMEOUT_MS-driven cap (see defaultHttpDeadlineCapMs) and
      // still returns a proper 504 through the normal result path.
      handler(event)
        .then((result) => writeLambdaResult(res, result))
        .catch((err) => {
          console.error('Unhandled dispatch error:', err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Internal Server Error' }));
          } else {
            res.destroy();
          }
        });
    });
  };
}

/**
 * Start the production HTTP server for a Blocks backend container.
 *
 * ```ts
 * import { handler } from './index.handler.js';
 * import { startBlocksHttpServer } from '@aws-blocks/core/http-server';
 * await startBlocksHttpServer(handler);
 * ```
 *
 * Startup performs a warmup dispatch (an OPTIONS preflight to the RPC
 * endpoint) so config loading and the backend import complete before the
 * health endpoint reports ready — giving load balancers and Kubernetes
 * readiness probes correct semantics without a separate init protocol.
 * If warmup fails the process exits non-zero so the orchestrator restarts it.
 */
export async function startBlocksHttpServer(
  handler: BlocksEventHandler,
  options?: BlocksHttpServerOptions,
): Promise<http.Server> {
  const resolved = resolveOptions(options);
  let ready = false;

  const server = http.createServer(
    createNodeRequestListener(handler, { ...options, isReady: () => ready }),
  );

  // Behind an ALB, Node's default keepAliveTimeout (5s) is shorter than the
  // load balancer's idle timeout (60s): the server closes a kept-alive socket
  // the ALB still considers usable, and the next proxied request gets a 502.
  // Keep-alive must outlive the ALB idle timeout; headersTimeout must exceed
  // keepAliveTimeout so header parsing on a reused socket isn't cut short.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(resolved.port, () => resolve());
  });

  try {
    await handler({ httpMethod: 'OPTIONS', path: BLOCKS_RPC_PREFIX, headers: {} });
    ready = true;
    const address = server.address();
    const boundPort = address && typeof address === 'object' ? address.port : resolved.port;
    console.log(`Blocks backend listening on :${boundPort} (health: ${resolved.healthPath})`);
  } catch (err) {
    console.error('Backend initialization failed:', err);
    server.close();
    if (resolved.handleSignals) {
      process.exit(1);
    }
    throw err;
  }

  if (resolved.handleSignals) {
    const shutdown = (signal: string) => {
      console.log(`Received ${signal}, draining connections…`);
      ready = false; // fail health checks so the LB stops routing new work
      server.close(() => process.exit(0));
      server.closeIdleConnections();
      const killTimer = setTimeout(() => {
        server.closeAllConnections();
        process.exit(0);
      }, resolved.shutdownGraceMs);
      killTimer.unref();
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  }

  return server;
}
