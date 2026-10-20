// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Node HTTP server for container computes. A thin adapter over the
// transport-neutral dispatcher: the same RawRoute, JSON-RPC, CORS and cookie
// handling the Lambda handler serves, without the Lambda-only parts (API Gateway
// event parsing, base64 bodies, the 28 s timeout guard).

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { registerBuiltinRoutes } from './builtin-routes.js';
import { CLIENT_USER_AGENT_HEADER, FORWARDED_HOST_HEADER, FORWARDED_STAGE_HEADER, isRpcPath } from './constants.js';
import { buildCorsHeaders } from './cors.js';
import { createDispatcher } from './dispatch.js';
import type { Dispatcher, DispatchResponse } from './dispatch.js';
import { lockRouteRegistry } from './raw-route.js';
import { isLoopbackForwardedHost } from './request-context.js';
import { MAX_RPC_BODY_BYTES, payloadTooLargeResponse } from './rpc.js';

/** @internal */
export interface ServeHttpOptions {
  /** Interface to bind. Default `127.0.0.1`; a container entry point passes `0.0.0.0`. */
  host?: string;
  /** Request port. Default: the `PORT` env var, else `8080`. `0` picks a free port. */
  port?: number;
  /** Readiness port, served separately so no route path is reserved. Default `8081`. */
  healthPort?: number;
  /**
   * Build request URLs from the front-door-stamped {@link FORWARDED_HOST_HEADER} /
   * {@link FORWARDED_STAGE_HEADER}. Enable only where every path to the listener
   * goes through a front door that overwrites or strips them (the container
   * compute behind its internal load balancer). Default `false`.
   */
  trustForwardedHeaders?: boolean;
  /** Public origin for request URLs when no front door stamped one. Default: `BLOCKS_PUBLIC_ORIGIN`. */
  publicOrigin?: string;
  /**
   * Largest accepted request body. Default: the JSON-RPC body limit (10 MiB).
   * JSON-RPC bodies stay capped at that limit regardless; a larger value only
   * raises the limit for RawRoutes.
   */
  maxBodyBytes?: number;
  /** How long {@link HttpServerHandle.close} waits for in-flight requests. Default `25000`. */
  drainTimeoutMs?: number;
}

/** @internal */
export interface HttpServerHandle {
  /** Bound interface address (e.g. `127.0.0.1`). */
  readonly address: string;
  /** Bound request port. */
  readonly port: number;
  /** Bound readiness port. */
  readonly healthPort: number;
  /**
   * Stop accepting requests and report not-ready, wait up to `drainTimeoutMs` for
   * in-flight requests (until their handlers settle), then close any remaining
   * connections. Repeated calls return the same promise.
   */
  close(): Promise<void>;
}

const DEFAULT_PORT = 8080;
const DEFAULT_HEALTH_PORT = 8081;
const DEFAULT_DRAIN_TIMEOUT_MS = 25_000;

/**
 * Keep idle connections open longer than the ALB's 60 s idle timeout, so the
 * load balancer — not the server — always closes them. Closing first races a
 * request the ALB is already sending and surfaces as a 502.
 */
const KEEP_ALIVE_TIMEOUT_MS = 65_000;

/**
 * How long to keep reading (and discarding) an oversized body before answering
 * 413. Bounds how long a slow or endless upload can hold the connection.
 */
const OVERSIZED_BODY_LINGER_MS = 5_000;

/** API Gateway stage names: letters, digits, `-` and `_`. */
const STAGE_PATTERN = /^[A-Za-z0-9_-]+$/;

interface RequestEnv {
  dispatch: Dispatcher;
  maxBodyBytes: number;
  publicOrigin: string | undefined;
  trustForwardedHeaders: boolean;
}

/**
 * Serve a backend module (the app's `aws-blocks/index.ts`) over HTTP.
 *
 * Call after config is loaded and the backend is imported. Registers the
 * built-in routes and locks the route registry, as the Lambda handler does on
 * initialization.
 *
 * @internal
 */
export async function serveHttp(backend: unknown, options: ServeHttpOptions = {}): Promise<HttpServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? portFromEnv();
  const healthPort = options.healthPort ?? DEFAULT_HEALTH_PORT;
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const publicOrigin = options.publicOrigin ?? process.env.BLOCKS_PUBLIC_ORIGIN;
  if (publicOrigin && !URL.canParse(publicOrigin)) {
    throw new Error(`[Blocks] The public origin must be an absolute URL, got "${publicOrigin}"`);
  }
  const env: RequestEnv = {
    dispatch: createDispatcher(backend),
    maxBodyBytes: options.maxBodyBytes ?? MAX_RPC_BODY_BYTES,
    publicOrigin,
    trustForwardedHeaders: options.trustForwardedHeaders ?? false,
  };
  registerBuiltinRoutes();
  lockRouteRegistry();

  let draining = false;
  let inFlight = 0;
  const idleWaiters: Array<() => void> = [];

  const server = http.createServer((req, res) => {
    inFlight++;
    handleRequest(req, res, env)
      .catch((error: unknown) => {
        // The client went away mid-request (e.g. an aborted upload): nothing to answer.
        if ((error as NodeJS.ErrnoException | undefined)?.code === 'ECONNRESET') return;
        console.error('HTTP server error:', error);
        if (res.destroyed) return;
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      })
      .finally(() => {
        // Counted until the handler settles, not until the client disconnects, so
        // draining never cuts off work still running for a client that went away.
        inFlight--;
        if (inFlight === 0) {
          for (const resolve of idleWaiters.splice(0)) resolve();
        }
      });
  });
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 1_000;

  const health = http.createServer((_req, res) => {
    const status = draining ? 503 : 200;
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ status: draining ? 'draining' : 'ok' }));
  });

  await listen(server, port, host);
  try {
    await listen(health, healthPort, host);
  } catch (error) {
    server.close();
    throw error;
  }

  let closing: Promise<void> | undefined;
  async function drainAndClose(): Promise<void> {
    draining = true;
    server.close();
    // Idle keep-alive sockets would otherwise hold close() open until they time out.
    server.closeIdleConnections();
    if (inFlight > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, drainTimeoutMs);
        timer.unref();
        idleWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => health.close(() => resolve()));
  }

  const bound = server.address() as AddressInfo;
  return {
    address: bound.address,
    port: bound.port,
    healthPort: (health.address() as AddressInfo).port,
    close() {
      closing ??= drainAndClose();
      return closing;
    },
  };
}

/** The `PORT` env var, else {@link DEFAULT_PORT}. A set-but-invalid value fails fast. */
function portFromEnv(): number {
  const raw = process.env.PORT;
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`[Blocks] PORT must be an integer from 1 to 65535, got "${raw}"`);
  }
  return port;
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, env: RequestEnv): Promise<void> {
  const origin = header(req, 'origin') ?? '';
  // Front doors forward the routing path itself (no API Gateway stage).
  const { pathname } = splitTarget(req.url ?? '/');

  // The request signal fires when the client goes away before the response is
  // written, so handlers can stop in-flight fetch / SDK calls.
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });

  const body = await readBody(req, env.maxBodyBytes);
  if (body === undefined) {
    await discardRemainingBody(req);
    // Still uploading after the linger window: answer, then drop the connection.
    if (!req.complete) res.setHeader('Connection', 'close');
    writeResponse(res, payloadTooLarge(pathname, origin));
    return;
  }

  const response = await env.dispatch({
    method: req.method ?? 'GET',
    path: pathname,
    origin,
    cookie: header(req, 'cookie') ?? '',
    clientUserAgent: header(req, CLIENT_USER_AGENT_HEADER),
    headers: () => toHeaders(req),
    url: () => buildRequestUrl(req, env.publicOrigin, env.trustForwardedHeaders),
    body: () => ({ text: body.toString('utf-8'), stream: body.length > 0 ? bytesStream(body) : null }),
    signal: abort.signal,
  });
  writeResponse(res, response);
}

/**
 * The response for a body over the limit: the JSON-RPC 413 envelope on the RPC
 * path (what `parseRpcRequest` answers, so the client surfaces `e.status === 413`
 * and `PayloadTooLarge`), a plain 413 elsewhere.
 */
function payloadTooLarge(pathname: string, origin: string): Omit<DispatchResponse, 'kind'> {
  const cors = buildCorsHeaders(origin);
  if (isRpcPath(pathname)) {
    return {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...cors, 'Cache-Control': 'no-store' },
      cookies: [],
      body: payloadTooLargeResponse(),
    };
  }
  return {
    status: 413,
    headers: { 'Content-Type': 'application/json', ...cors },
    cookies: [],
    body: JSON.stringify({ error: 'Payload Too Large' }),
  };
}

/**
 * Read and discard the rest of an oversized body, for at most
 * {@link OVERSIZED_BODY_LINGER_MS}. Answering first would let Node close a socket
 * that still holds unread data, which resets the connection and can discard the
 * 413 before the client reads it.
 */
function discardRemainingBody(req: http.IncomingMessage): Promise<void> {
  if (req.complete) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, OVERSIZED_BODY_LINGER_MS);
    timer.unref();
    function done() {
      clearTimeout(timer);
      resolve();
    }
    req.once('end', done);
    req.once('close', done);
    req.once('error', done);
    req.resume();
  });
}

function writeResponse(res: http.ServerResponse, response: Omit<DispatchResponse, 'kind'>): void {
  res.statusCode = response.status;
  for (const [name, value] of Object.entries(response.headers)) {
    res.setHeader(name, value);
  }
  if (response.cookies.length > 0) {
    res.setHeader('Set-Cookie', response.cookies);
  }
  res.end(response.body);
}

/**
 * Read the whole request body, or `undefined` once it exceeds `limit` bytes.
 * The rest of an oversized body is discarded, not buffered.
 */
function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      resolve(undefined);
      return;
    }
    let chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks = [];
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      const body = Buffer.concat(chunks, size);
      chunks = [];
      resolve(body);
    });
    req.on('error', reject);
  });
}

/**
 * The externally visible URL of a request — origin, path and query values as the
 * Lambda handler reports them in `ctx.request.url` for the same request:
 *
 * 1. A trusted loopback `X-Forwarded-Host` (the sandbox dev-server front door):
 *    `http://<that host><path>`, no stage.
 * 2. With `trustForwardedHeaders`, a front-door-stamped {@link FORWARDED_HOST_HEADER}
 *    (+ optional {@link FORWARDED_STAGE_HEADER}): `https://<host>/<stage><path>`.
 * 3. The configured public origin (`BLOCKS_PUBLIC_ORIGIN`).
 * 4. The request's own `Host`, over plain HTTP (local `docker run`).
 *
 * The request target only ever supplies the path and query: a `//host/...` or
 * absolute-form target can never move the URL to another host.
 *
 * @internal Exported for testing only.
 */
export function buildRequestUrl(req: http.IncomingMessage, publicOrigin?: string, trustForwardedHeaders = false): URL {
  const { pathname, search } = splitTarget(req.url ?? '/');
  const forwardedHost = header(req, 'x-forwarded-host');
  const stampedHost = trustForwardedHeaders ? header(req, FORWARDED_HOST_HEADER) : undefined;
  let url: URL;
  let stage = '';
  if (isLoopbackForwardedHost(forwardedHost)) {
    url = new URL(`http://${forwardedHost}`);
  } else if (stampedHost) {
    url = new URL(`https://${stampedHost}`);
    const stamped = header(req, FORWARDED_STAGE_HEADER);
    if (stamped && STAGE_PATTERN.test(stamped)) stage = `/${stamped}`;
  } else if (publicOrigin) {
    url = new URL(publicOrigin);
  } else {
    url = new URL(`http://${header(req, 'host') || 'localhost'}`);
  }
  // Assign the path rather than resolving the target against the origin.
  url.pathname = `${stage}${pathname}`;
  // Re-serialize the query the way the Lambda handler does (it rebuilds it from
  // API Gateway's parsed parameters), so `href` matches across transports.
  url.search = new URLSearchParams(search).toString();
  return url;
}

/**
 * Split a request target into its path and query without resolving it as a URL:
 * `//host/x` stays a path (not a protocol-relative reference to `host`), and an
 * absolute-form target (`http://host/x`, as sent to a proxy) contributes only its
 * path and query, never its host.
 */
function splitTarget(target: string): { pathname: string; search: string } {
  if (!target.startsWith('/')) {
    try {
      const { pathname, search } = new URL(target);
      return { pathname, search };
    } catch {
      return { pathname: '/', search: '' };
    }
  }
  const query = target.indexOf('?');
  return query === -1
    ? { pathname: target, search: '' }
    : { pathname: target.slice(0, query), search: target.slice(query) };
}

/** A single request header value (Node lower-cases names; repeats are joined). */
function header(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(', ') : value;
}

function toHeaders(req: http.IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  return headers;
}

/** The raw body bytes as a stream, copied only when a handler reads it. */
function bytesStream(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
}
